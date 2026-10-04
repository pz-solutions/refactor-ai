import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { analyze, capabilities } from "../src/backends/csharp.ts";
import { applyPlan } from "../src/core/apply.ts";
import { createPlan } from "../src/core/plan.ts";
import type { BackendResult, FileChange } from "../src/types.ts";

const roots: string[] = [];

beforeAll(() => {
  run([
    "dotnet", "build", join(import.meta.dir, "..", "dotnet", "RefactorHelper", "RefactorHelper.csproj"),
    "-c", "Release", "--nologo",
  ], import.meta.dir);
}, 300_000);

afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  root: string;
  solution: string;
  path: (relative: string) => string;
  sources: Map<string, string>;
}

/** Creates SDK-style projects (Name -> references), writes sources and restores a solution. */
async function fixture(
  projects: Record<string, { references?: string[]; extra?: string }>,
  files: Record<string, string>,
): Promise<Fixture> {
  // Canonical root: core plans canonicalize paths, and mixing /var with /private/var aliases confuses MSBuild.
  const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-csharp-fileops-")));
  roots.push(root);
  const path = (relative: string) => join(root, relative);
  for (const [name, options] of Object.entries(projects)) {
    await mkdir(path(name), { recursive: true });
    await Bun.write(path(`${name}/${name}.csproj`), projectFile(options.references ?? [], options.extra ?? ""));
  }
  const sources = new Map<string, string>();
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(dirname(path(relative)), { recursive: true });
    await Bun.write(path(relative), content);
    sources.set(path(relative), content);
  }
  for (const name of Object.keys(projects)) {
    sources.set(path(`${name}/${name}.csproj`), await readFile(path(`${name}/${name}.csproj`), "utf8"));
  }
  run(["dotnet", "new", "sln", "--name", "Fixture"], root);
  const solution = path("Fixture.sln");
  run(["dotnet", "sln", solution, "add", ...Object.keys(projects).map(name => path(`${name}/${name}.csproj`))], root);
  run(["dotnet", "restore", solution, "--nologo"], root);
  return { root, solution, path, sources };
}

async function expectUntouched(f: Fixture): Promise<void> {
  for (const [file, content] of f.sources) {
    expect(await readFile(file, "utf8")).toBe(content);
  }
}

function change(result: BackendResult, path: string): FileChange {
  const found = result.changes.find(item => item.path === path);
  if (!found) throw new Error(`no change for ${path}; got ${result.changes.map(item => item.path).join(", ")}`);
  return found;
}

describe("C# file operations", () => {
  for (const crossProject of [false, true]) {
    test(`move-type preserves source global usings (${crossProject ? "cross-project" : "same-project"})`, async () => {
      const f = await fixture(
        { App: { extra: "<PropertyGroup><OutputType>Exe</OutputType></PropertyGroup>" }, ...(crossProject ? { Target: {} } : {}) },
        {
          "App/Payload.cs": "global using static N.Tools;\nglobal using Alias = N.Tools;\nnamespace App;\npublic class Payload {}\n",
          "App/Consumer.cs": "global using static N.OtherTools;\nnamespace App;\nclass Program { static void Main() { System.Console.WriteLine(Pick(1) + Alias.Pick(1)); } }\n",
          "App/Tools.cs": "namespace N { public static class Tools { public static int Pick(int x) => 1; } public static class OtherTools { public static int Pick(object x) => 2; } }\n",
        },
      );
      expect(output(["dotnet", "run", "--project", f.path("App/App.csproj")], f.root).trim()).toBe("2");
      const plan = await createPlan({
        project: f.solution, root: f.root, file: f.path("App/Payload.cs"), operation: "move-type",
        target: f.path(crossProject ? "Target/Moved.cs" : "App/Moved.cs"),
      }, analyze);
      expect(plan.validation.status).toBe("passed");
      await applyPlan(plan);
      expect(await readFile(f.path("App/Payload.cs"), "utf8")).toContain("global using static N.Tools;");
      expect(await readFile(f.path("App/Payload.cs"), "utf8")).toContain("global using Alias = N.Tools;");
      expect(output(["dotnet", "run", "--project", f.path("App/App.csproj")], f.root).trim()).toBe("2");
      if (crossProject) expect(await readFile(f.path("Target/Moved.cs"), "utf8")).not.toContain("global using");
    }, 180_000);
  }

  for (const existingTarget of [false, true]) {
    test(`move-type persists required references outside inactive groups (${existingTarget ? "existing target" : "different target"})`, async () => {
      const f = await fixture(
        { A: { extra: `<ItemGroup Condition="'$(Configuration)' == 'Release'"><ProjectReference Include="../${existingTarget ? "B" : "C"}/${existingTarget ? "B" : "C"}.csproj" /></ItemGroup>` }, B: {}, C: {} },
        {
          "A/Payload.cs": "namespace A; public class Payload {}\n",
          "A/Consumer.cs": "namespace A; public class Consumer { public Payload Create() => new Payload(); }\n",
          "B/Other.cs": "namespace B; public class Other {}\n",
          "C/Extra.cs": "namespace C; public class Extra {}\n",
        },
      );
      const plan = await createPlan({
        project: f.solution, root: f.root, file: f.path("A/Payload.cs"), operation: "move-type", target: f.path("B/Payload.cs"),
      }, analyze);
      expect(plan.validation.status).toBe("passed");
      await applyPlan(plan);
      for (const configuration of ["Debug", "Release"]) run(["dotnet", "build", f.solution, "--nologo", "-c", configuration], f.root);
    }, 180_000);
  }

  test("advertises the file operations", () => {
    expect(capabilities.map(capability => capability.operation)).toEqual([
      "rename", "format", "imports", "rename-file", "sync-namespace", "move-type",
    ]);
  });

  test("rename-file renames to the declared type, keeps the BOM and text, and serializes null sides", async () => {
    const source = "﻿namespace Library;\n\n/// <summary>Circle.</summary>\npublic sealed record Circle(double Radius);\n";
    const f = await fixture({ Library: {} }, { "Library/Shapes.cs": source });
    const result = await analyze({
      project: f.solution, root: f.root, file: f.path("Library/Shapes.cs"), operation: "rename-file",
    });

    expect(result.changes).toEqual([
      { path: f.path("Library/Circle.cs"), before: null, after: source },
      { path: f.path("Library/Shapes.cs"), before: source, after: null },
    ]);
    expect(result.diagnosticsAfter).toEqual([]);
    await expectUntouched(f);
  }, 180_000);

  test("rename-file requires a selection for several types and updates explicit Compile items", async () => {
    const source = "namespace Library;\npublic class First { }\npublic class Second { }\n";
    const f = await fixture(
      { Library: { extra: `
  <PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>
  <ItemGroup>
    <Compile Include="Both.cs" />
    <Compile Include="Other.cs" />
  </ItemGroup>` } },
      { "Library/Both.cs": source, "Library/Other.cs": "namespace Library;\npublic class Other { }\n" },
    );
    const request = { project: f.solution, root: f.root, file: f.path("Library/Both.cs"), operation: "rename-file" as const };

    await expect(analyze(request)).rejects.toThrow("AMBIGUOUS_TYPE");
    const result = await analyze({ ...request, typeName: "Second" });
    const csproj = change(result, f.path("Library/Library.csproj"));
    expect(csproj.after).toContain('<Compile Include="Second.cs" />');
    expect(csproj.after).toContain('<Compile Include="Other.cs" />');
    expect(csproj.after).not.toContain("Both.cs");
    expect(change(result, f.path("Library/Second.cs")).after).toBe(source);
    expect(change(result, f.path("Library/Both.cs")).after).toBeNull();

    const byPosition = await analyze({ ...request, position: source.indexOf("First") });
    expect(byPosition.changes.map(item => item.path)).toContain(f.path("Library/First.cs"));
    await expect(analyze({ ...request, typeName: "Other" })).rejects.toThrow("TYPE_NOT_FOUND");
    await expectUntouched(f);
  }, 180_000);

  test("rename-file refuses to overwrite an existing file", async () => {
    const f = await fixture({ Library: {} }, {
      "Library/Shapes.cs": "namespace Library;\npublic class Square { }\n",
      "Library/Square.cs": "namespace Library;\npublic class Unrelated { }\n",
    });
    await expect(analyze({
      project: f.solution, root: f.root, file: f.path("Library/Shapes.cs"), operation: "rename-file",
    })).rejects.toThrow("TARGET_EXISTS");
    await expectUntouched(f);
  }, 180_000);

  test("sync-namespace updates only the selected file and repairs references across projects", async () => {
    const widget = `using System;

namespace Library.Wrong;

/// <summary>Uses <see cref="Helper"/>.</summary>
public class Widget
{
    public Helper Create() => new Helper();
    public string Describe() => this.Shout();
}
`;
    const helper = `namespace Library.Wrong;

public class Helper { }

public static class WidgetExtensions
{
    public static string Shout(this Widget widget) => "!";
}
`;
    const program = `using Library.Wrong;

namespace Consumer;

public static class Program
{
    // Widget in comments stays.
    public static object Run() => new Widget().Create();
    public static Library.Wrong.Widget Qualified() => new global::Library.Wrong.Widget();
}
`;
    const f = await fixture(
      { Library: {}, Consumer: { references: ["../Library/Library.csproj"] } },
      { "Library/Models/Widget.cs": widget, "Library/Helper.cs": helper, "Consumer/Program.cs": program },
    );
    const result = await analyze({
      project: f.solution, root: f.root, file: f.path("Library/Models/Widget.cs"), operation: "sync-namespace",
    });

    expect(result.diagnosticsBefore).toEqual([]);
    expect(result.diagnosticsAfter).toEqual([]);
    expect(result.changes.map(item => item.path).sort()).toEqual([
      f.path("Consumer/Program.cs"), f.path("Library/Helper.cs"), f.path("Library/Models/Widget.cs"),
    ].sort());
    expect(change(result, f.path("Library/Models/Widget.cs")).after).toBe(`using System;
using Library.Wrong;

namespace Library.Models;

/// <summary>Uses <see cref="Helper"/>.</summary>
public class Widget
{
    public Helper Create() => new Helper();
    public string Describe() => this.Shout();
}
`);
    // Helper keeps its namespace; only an import for the moved type is added.
    expect(change(result, f.path("Library/Helper.cs")).after).toBe(`using Library.Models;

namespace Library.Wrong;

public class Helper { }

public static class WidgetExtensions
{
    public static string Shout(this Widget widget) => "!";
}
`);
    expect(change(result, f.path("Consumer/Program.cs")).after).toBe(`using Library.Models;
using Library.Wrong;

namespace Consumer;

public static class Program
{
    // Widget in comments stays.
    public static object Run() => new Widget().Create();
    public static Library.Models.Widget Qualified() => new global::Library.Models.Widget();
}
`);
    await expectUntouched(f);
  }, 180_000);

  test("sync-namespace replaces an import of a namespace that no longer exists", async () => {
    const f = await fixture(
      { Library: {}, Consumer: { references: ["../Library/Library.csproj"] } },
      {
        "Library/Models/Gadget.cs": "namespace Library.Gone\n{\n    public class Gadget { }\n}\n",
        "Consumer/Program.cs": "using System;\nusing Library.Gone;\n\nnamespace Consumer;\n\npublic static class Program { public static Gadget Make() => new(); }\n",
      },
    );
    const result = await analyze({
      project: f.solution, root: f.root, file: f.path("Library/Models/Gadget.cs"), operation: "sync-namespace",
    });
    expect(result.diagnosticsAfter).toEqual([]);
    expect(change(result, f.path("Library/Models/Gadget.cs")).after)
      .toBe("namespace Library.Models\n{\n    public class Gadget { }\n}\n");
    expect(change(result, f.path("Consumer/Program.cs")).after)
      .toBe("using System;\nusing Library.Models;\n\nnamespace Consumer;\n\npublic static class Program { public static Gadget Make() => new(); }\n");
  }, 180_000);

  test("sync-namespace adds a namespace to a global-namespace file and honours rootNamespace", async () => {
    const f = await fixture({ Library: {} }, {
      "Library/Data/Thing.cs": "// Header comment.\n\n/// <summary>Thing.</summary>\npublic class Thing { }\n",
      "Library/User.cs": "namespace Library;\npublic class User { public Thing? Value; }\n",
    });
    const result = await analyze({
      project: f.solution, root: f.root, file: f.path("Library/Data/Thing.cs"), operation: "sync-namespace",
      rootNamespace: "Company.Product",
    });
    expect(result.diagnosticsAfter).toEqual([]);
    expect(change(result, f.path("Library/Data/Thing.cs")).after)
      .toBe("// Header comment.\n\nnamespace Company.Product.Data;\n\n/// <summary>Thing.</summary>\npublic class Thing { }\n");
    expect(change(result, f.path("Library/User.cs")).after)
      .toBe("using Company.Product.Data;\n\nnamespace Library;\npublic class User { public Thing? Value; }\n");
  }, 180_000);

  test("sync-namespace rejects unsafe files and conflicts deterministically", async () => {
    const f = await fixture({ Library: {} }, {
      "Library/Parts/Split.cs": "namespace Library.Wrong;\npublic partial class Split { }\n",
      "Library/Split.Other.cs": "namespace Library.Wrong;\npublic partial class Split { }\n",
      "Library/Cond/Conditional.cs": "namespace Library.Wrong;\n#if DEBUG\npublic class Conditional { }\n#endif\n",
      "Library/Dup/Duplicate.cs": "namespace Library.Wrong;\npublic class Duplicate { }\n",
      "Library/Existing.cs": "namespace Library.Dup;\npublic class Duplicate { }\n",
    });
    const request = (file: string) => ({
      project: f.solution, root: f.root, file: f.path(file), operation: "sync-namespace" as const,
    });
    await expect(analyze(request("Library/Parts/Split.cs"))).rejects.toThrow("PARTIAL_TYPE_UNSUPPORTED");
    await expect(analyze(request("Library/Cond/Conditional.cs"))).rejects.toThrow("UNSUPPORTED_DIRECTIVES");
    await expect(analyze(request("Library/Dup/Duplicate.cs"))).rejects.toThrow("SYNC_NAMESPACE_CONFLICT");
    await expectUntouched(f);
  }, 180_000);

  test("sync-namespace rejects a silent rebinding in another file", async () => {
    const f = await fixture({ Library: {} }, {
      "Library/Models/Item.cs": "namespace Library.Wrong;\npublic class Item { }\n",
      "Library/Other/Item.cs": "namespace Library.Other;\npublic class Item { public int Marker; }\n",
      // Inside Library.Models, a type of the enclosing namespace beats the imported Library.Other.Item.
      "Library/Models/Use.cs": "using Library.Other;\n\nnamespace Library.Models;\npublic class Use { public int Read(Item item) => item.Marker; }\n",
    });
    await expect(analyze({
      project: f.solution, root: f.root, file: f.path("Library/Models/Item.cs"), operation: "sync-namespace",
    })).rejects.toThrow(/BINDING_CONFLICT|SYNC_NAMESPACE_CONFLICT/);
    await expectUntouched(f);
  }, 180_000);

  test("move-type splits a type into another folder of the same project", async () => {
    const shapes = `using System;
using System.Text;

namespace Library;

public class Alpha
{
    public Beta Partner => new Beta();
}

// Beta's comment moves with it.
public class Beta
{
    public DateTime Created { get; } = DateTime.Now;
}

public class Gamma { }
`;
    const f = await fixture(
      { Library: {}, Consumer: { references: ["../Library/Library.csproj"] } },
      {
        "Library/Shapes.cs": shapes,
        "Library/Sub/Keep.cs": "namespace Library.Sub;\npublic class Keep { }\n",
        "Consumer/Program.cs": "using Library;\n\nnamespace Consumer;\n\npublic static class Program { public static Beta Run() => new Alpha().Partner; }\n",
      },
    );
    const result = await analyze({
      project: f.solution, root: f.root, file: f.path("Library/Shapes.cs"), operation: "move-type",
      target: f.path("Library/Sub/Beta.cs"), position: shapes.indexOf("class Beta") + 6,
    });

    expect(result.diagnosticsAfter).toEqual([]);
    expect(change(result, f.path("Library/Sub/Beta.cs"))).toEqual({
      path: f.path("Library/Sub/Beta.cs"),
      before: null,
      after: `using System;

namespace Library.Sub;

// Beta's comment moves with it.
public class Beta
{
    public DateTime Created { get; } = DateTime.Now;
}
`,
    });
    expect(change(result, f.path("Library/Shapes.cs")).after).toBe(`using System;
using System.Text;
using Library.Sub;

namespace Library;

public class Alpha
{
    public Beta Partner => new Beta();
}

public class Gamma { }
`);
    expect(change(result, f.path("Consumer/Program.cs")).after)
      .toBe("using Library;\nusing Library.Sub;\n\nnamespace Consumer;\n\npublic static class Program { public static Beta Run() => new Alpha().Partner; }\n");
    expect(result.changes.some(item => item.path.endsWith(".csproj"))).toBe(false);
    await expectUntouched(f);
  }, 180_000);

  test("move-type moves a type into another project and plans project references", async () => {
    const calculator = "namespace Library;\n\npublic class Calculator\n{\n    public int Add(int a, int b) => a + b;\n}\n";
    const f = await fixture(
      {
        Core: {},
        Library: {},
        Consumer: { references: ["../Library/Library.csproj"] },
      },
      {
        "Library/Calculator.cs": calculator,
        "Library/Service.cs": "namespace Library;\n\npublic class Service { public int Sum() => new Calculator().Add(1, 2); }\n",
        "Core/Marker.cs": "namespace Core;\npublic class Marker { }\n",
        "Consumer/Program.cs": "using Library;\n\nnamespace Consumer;\n\npublic static class Program { public static int Run() => new Calculator().Add(new Service().Sum(), 1); }\n",
      },
    );
    const result = await analyze({
      project: f.solution, root: f.root, file: f.path("Library/Calculator.cs"), operation: "move-type",
      target: f.path("Core/Calculator.cs"), targetProject: f.path("Core/Core.csproj"),
    });

    expect(result.diagnosticsAfter).toEqual([]);
    expect(result.changes.map(item => item.path).sort()).toEqual([
      f.path("Consumer/Consumer.csproj"), f.path("Consumer/Program.cs"), f.path("Core/Calculator.cs"),
      f.path("Library/Calculator.cs"), f.path("Library/Library.csproj"), f.path("Library/Service.cs"),
    ].sort());
    expect(change(result, f.path("Core/Calculator.cs")).after)
      .toBe("namespace Core;\n\npublic class Calculator\n{\n    public int Add(int a, int b) => a + b;\n}\n");
    expect(change(result, f.path("Library/Calculator.cs")).after).toBeNull();
    expect(change(result, f.path("Library/Service.cs")).after)
      .toBe("using Core;\n\nnamespace Library;\n\npublic class Service { public int Sum() => new Calculator().Add(1, 2); }\n");
    expect(change(result, f.path("Library/Library.csproj")).after)
      .toContain('<ProjectReference Include="..\\Core\\Core.csproj" />');
    const consumerProject = change(result, f.path("Consumer/Consumer.csproj")).after ?? "";
    expect(consumerProject).toContain('<ProjectReference Include="../Library/Library.csproj" />');
    expect(consumerProject).toContain('<ProjectReference Include="../Core/Core.csproj" />');
    expect(change(result, f.path("Consumer/Program.cs")).after).toContain("using Core;\nusing Library;\n");
    await expectUntouched(f);
  }, 180_000);

  test("move-type rejects cycles, inaccessible results and existing targets across projects", async () => {
    const f = await fixture(
      { Core: {}, Library: {} },
      {
        "Library/Engine.cs": "namespace Library;\npublic class Engine { public Part Part = new(); }\n",
        "Library/Part.cs": "namespace Library;\npublic class Part { public Engine? Owner; }\n",
        "Library/Secret.cs": "namespace Library;\ninternal class Secret { }\npublic class UsesSecret { internal Secret Value = new(); }\n",
        "Core/Taken.cs": "namespace Core;\npublic class Taken { }\n",
      },
    );
    const request = (file: string, target: string, typeName?: string) => ({
      project: f.solution, root: f.root, file: f.path(file), operation: "move-type" as const,
      target: f.path(target), targetProject: f.path("Core/Core.csproj"), typeName,
    });
    await expect(analyze(request("Library/Engine.cs", "Core/Engine.cs"))).rejects.toThrow("REFERENCE_CYCLE");
    await expect(analyze(request("Library/Secret.cs", "Core/Secret.cs", "Secret"))).rejects.toThrow(/BINDING_CONFLICT|MOVE_TYPE_CONFLICT/);
    await expect(analyze(request("Library/Part.cs", "Core/Taken.cs"))).rejects.toThrow("TARGET_EXISTS");
    await writeFile(f.path("Core/Blocked"), "not a directory\n");
    await expect(analyze(request("Library/Part.cs", "Core/Blocked/Nested/Part.cs"))).rejects.toThrow("TARGET_PARENT_NOT_DIRECTORY");
    await expectUntouched(f);
  }, 180_000);

  test("move-type plans into missing nested directories without disk writes, then applies, builds and runs", async () => {
    const f = await fixture(
      {
        Source: {},
        Target: {},
        App: { references: ["../Source/Source.csproj"], extra: "\n  <PropertyGroup><OutputType>Exe</OutputType></PropertyGroup>" },
      },
      {
        "Source/Types.cs": "namespace Source;\n\npublic class Widget\n{\n    public string Name => \"widget\";\n}\n\npublic class Gadget { }\n",
        "App/Program.cs": "using Source;\n\nSystem.Console.WriteLine(new Widget().Name + \":\" + new Gadget().GetType().Name);\n",
      },
    );
    const plan = await createPlan({
      project: f.solution, root: f.root, file: f.path("Source/Types.cs"), operation: "move-type",
      target: f.path("Target/Models/Deep/Widget.cs"), targetProject: f.path("Target/Target.csproj"), typeName: "Widget",
    }, analyze);

    expect(plan.validation).toEqual({ status: "passed", newDiagnostics: [] });
    await expectUntouched(f);
    await expect(stat(f.path("Target/Models"))).rejects.toThrow();
    const created = plan.changes.find(item => item.path === f.path("Target/Models/Deep/Widget.cs"));
    expect(created?.before).toBeNull();
    expect(created?.after).toBe("namespace Target.Models.Deep;\n\npublic class Widget\n{\n    public string Name => \"widget\";\n}\n");
    expect(plan.changes.find(item => item.path === f.path("App/App.csproj"))?.after)
      .toContain("Target.csproj");

    await applyPlan(plan);
    expect(await readFile(f.path("Target/Models/Deep/Widget.cs"), "utf8")).toBe(created!.after!);
    expect(await readFile(f.path("Source/Types.cs"), "utf8")).toBe("namespace Source;\n\npublic class Gadget { }\n");
    expect(await readFile(f.path("App/Program.cs"), "utf8")).toContain("using Target.Models.Deep;");
    run(["dotnet", "build", f.solution, "--nologo", "-warnaserror"], f.root);
    expect(output(["dotnet", "run", "--no-build", "--project", f.path("App/App.csproj")], f.root).trim()).toBe("widget:Gadget");
  }, 300_000);

  test("move-type keeps explicit Compile items in sync", async () => {
    const f = await fixture(
      { Library: { extra: `
  <PropertyGroup>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Pair.cs" />
  </ItemGroup>` } },
      { "Library/Pair.cs": "namespace Library;\n\npublic class Left { }\n\npublic class Right { public Left? Other; }\n" },
    );
    const result = await analyze({
      project: f.solution, root: f.root, file: f.path("Library/Pair.cs"), operation: "move-type",
      target: f.path("Library/Right.cs"), typeName: "Right",
    });
    expect(result.diagnosticsAfter).toEqual([]);
    expect(change(result, f.path("Library/Pair.cs")).after).toBe("namespace Library;\n\npublic class Left { }\n");
    expect(change(result, f.path("Library/Right.cs")).after).toBe("namespace Library;\n\npublic class Right { public Left? Other; }\n");
    expect(change(result, f.path("Library/Library.csproj")).after)
      .toContain('    <Compile Include="Pair.cs" />\n    <Compile Include="Right.cs" />\n');
    await expectUntouched(f);
  }, 180_000);

  test("move-type adds a reference from the target to the source project for the moved type's dependencies", async () => {
    const f = await fixture(
      { Library: {}, Plugins: {} },
      {
        "Library/Contract.cs": "namespace Library;\npublic interface IContract { int Value { get; } }\n",
        "Library/Impl.cs": "namespace Library;\npublic sealed class Impl : IContract { public int Value => 42; }\n",
      },
    );
    const result = await analyze({
      project: f.solution, root: f.root, file: f.path("Library/Impl.cs"), operation: "move-type",
      target: f.path("Plugins/Impl.cs"),
    });
    expect(result.diagnosticsAfter).toEqual([]);
    expect(change(result, f.path("Plugins/Impl.cs")).after)
      .toBe("using Library;\n\nnamespace Plugins;\n\npublic sealed class Impl : IContract { public int Value => 42; }\n");
    expect(change(result, f.path("Plugins/Plugins.csproj")).after)
      .toContain('<ProjectReference Include="..\\Library\\Library.csproj" />');
    expect(result.changes.some(item => item.path === f.path("Library/Library.csproj"))).toBe(false);
    await expectUntouched(f);
  }, 180_000);

  test("rejects unrecognised item logic, nested types and unsupported layouts", async () => {
    const f = await fixture(
      { Library: { extra: `
  <ItemGroup>
    <Compile Remove="Excluded/**" />
  </ItemGroup>` } },
      {
        "Library/Shapes.cs": "namespace Library;\npublic class Outer { public class Inner { } }\n",
        "Library/Two.cs": "namespace Library.A { public class A1 { } }\nnamespace Library.B { public class B1 { } }\n",
        "Library/Excluded/Ignored.cs": "this is not compiled",
        "Library/Local.cs": "namespace Library;\nfile class Hidden { }\npublic class Visible { }\n",
      },
    );
    const base = { project: f.solution, root: f.root };
    await expect(analyze({ ...base, file: f.path("Library/Shapes.cs"), operation: "rename-file" }))
      .rejects.toThrow("UNSUPPORTED_PROJECT_ITEMS");
    await expect(analyze({
      ...base, file: f.path("Library/Shapes.cs"), operation: "move-type", target: f.path("Library/Inner.cs"),
      position: "namespace Library;\npublic class Outer { public class In".length,
    })).rejects.toThrow("NESTED_TYPE_UNSUPPORTED");
    await expect(analyze({
      ...base, file: f.path("Library/Local.cs"), operation: "move-type", target: f.path("Library/Hidden.cs"), typeName: "Hidden",
    })).rejects.toThrow("FILE_LOCAL_TYPE_UNSUPPORTED");
    await expect(analyze({ ...base, file: f.path("Library/Two.cs"), operation: "sync-namespace" }))
      .rejects.toThrow("UNSUPPORTED_NAMESPACE_LAYOUT");
    await expectUntouched(f);
  }, 180_000);

  test("validates move-type requests before launching the helper", async () => {
    const base = { project: "/tmp/x/A.sln", root: "/tmp/x", file: "/tmp/x/A.cs" };
    await expect(analyze({ ...base, operation: "move-type" })).rejects.toThrow("INVALID_REQUEST");
    await expect(analyze({ ...base, operation: "move-type", target: "/elsewhere/B.cs" })).rejects.toThrow("OUTSIDE_ROOT");
    await expect(analyze({ ...base, operation: "rename-file", target: "/tmp/x/B.cs" })).rejects.toThrow("INVALID_REQUEST");
  });
});

function projectFile(references: string[], extra: string): string {
  const items = references.length
    ? `\n  <ItemGroup>\n${references.map(reference => `    <ProjectReference Include="${reference}" />`).join("\n")}\n  </ItemGroup>`
    : "";
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>disable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>${items}${extra}
</Project>
`;
}

function run(command: string[], cwd: string): void {
  output(command, cwd);
}

function output(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr) || new TextDecoder().decode(result.stdout));
  }
  return new TextDecoder().decode(result.stdout);
}
