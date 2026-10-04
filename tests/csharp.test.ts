import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { analyze, capabilities } from "../src/backends/csharp.ts";
import { createPlan } from "../src/core/plan.ts";

let root = "";
let solution = "";
let libraryFile = "";
let consumerFile = "";

const librarySource = `namespace Sample;

public class Calculator
{
    public int Add(int left, int right) => left + right;
}
`;

const consumerSource = `using Sample;

namespace Consumer;

public static class Program
{
    public static int Run()
    {
        // Calculator stays in comments.
        var text = "Calculator stays in strings.";
        return new Calculator().Add(text.Length, 1);
    }
}
`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "refactor-ai-csharp-test-"));
  const libraryDirectory = join(root, "Library");
  const consumerDirectory = join(root, "Consumer");
  await mkdir(libraryDirectory);
  await mkdir(consumerDirectory);

  await Bun.write(join(libraryDirectory, "Library.csproj"), projectFile());
  await Bun.write(join(consumerDirectory, "Consumer.csproj"), projectFile(
    "../Library/Library.csproj",
  ));
  libraryFile = join(libraryDirectory, "Calculator.cs");
  consumerFile = join(consumerDirectory, "Program.cs");
  await Bun.write(libraryFile, librarySource);
  await Bun.write(consumerFile, consumerSource);

  run(["dotnet", "new", "sln", "--name", "Fixture"], root);
  solution = join(root, "Fixture.sln");
  run([
    "dotnet", "sln", solution, "add",
    join(libraryDirectory, "Library.csproj"),
    join(consumerDirectory, "Consumer.csproj"),
  ], root);
  run(["dotnet", "restore", solution, "--disable-parallel", "--nologo"], root);
  run([
    "dotnet", "build", join(import.meta.dir, "..", "dotnet", "RefactorHelper", "RefactorHelper.csproj"),
    "-c", "Release", "--nologo",
  ], root);
}, 120_000);

afterAll(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("C# Roslyn backend", () => {
  test("helper help bypasses stdin JSON parsing and project loading", () => {
    const helper = join(import.meta.dir, "..", "dotnet", "RefactorHelper", "bin", "Release", "net8.0", "RefactorHelper.dll");
    for (const flag of ["--help", "-h", "help"]) {
      const result = spawnSync("dotnet", [helper, flag], { encoding: "utf8", input: "invalid JSON" });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Examples");
      expect(result.stdout).toContain("zero-based UTF-16");
    }
  });

  test("advertises only implemented operations", () => {
    expect(capabilities.map((capability) => capability.operation).sort()).toEqual(([
      "rename",
      "format",
      "imports",
      "rename-file",
      "sync-namespace",
      "move-type",
    ] as const).toSorted());
    expect(capabilities.find(capability => capability.operation === "imports")?.modes).toEqual(["remove-unused"]);
  });

  test("renames a symbol across projects without changing source files", async () => {
    const result = await analyze({
      project: solution,
      root,
      file: libraryFile,
      operation: "rename",
      position: librarySource.indexOf("Calculator"),
      newName: "Arithmetic",
    });

    expect(result.backend).toBe("roslyn");
    expect(result.version).toBe("4.12.0");
    expect(result.diagnosticsBefore).toEqual([]);
    expect(result.diagnosticsAfter).toEqual([]);
    expect(result.changes.map((change) => change.path)).toEqual([
      consumerFile,
      libraryFile,
    ].sort());
    expect(result.changes.find((change) => change.path === libraryFile)?.after)
      .toContain("class Arithmetic");
    const consumerAfter = result.changes.find((change) => change.path === consumerFile)?.after ?? "";
    expect(consumerAfter).toContain("new Arithmetic()");
    expect(consumerAfter).toContain("// Calculator stays in comments.");
    expect(consumerAfter).toContain('"Calculator stays in strings."');
    expect(await readFile(libraryFile, "utf8")).toBe(librarySource);
    expect(await readFile(consumerFile, "utf8")).toBe(consumerSource);
  }, 120_000);

  test("rejects a rename collision", async () => {
    const collisionSource = `namespace Sample;
public class One { public void First() { } public void Second() { } }
`;
    const collisionFile = join(root, "Library", "Collision.cs");
    await Bun.write(collisionFile, collisionSource);

    await expect(analyze({
      project: solution,
      root,
      file: collisionFile,
      operation: "rename",
      position: collisionSource.indexOf("First"),
      newName: "Second",
    })).rejects.toThrow("RENAME_CONFLICT");
    expect(await readFile(collisionFile, "utf8")).toBe(collisionSource);
  }, 120_000);

  test("preserves semantics when a rename would shadow a field", async () => {
    const source = `namespace Sample;
public class Shadow
{
    private int value = 1;
    public int Read(int input) => input + value;
}
`;
    const file = join(root, "Library", "Shadow.cs");
    await Bun.write(file, source);

    const result = await analyze({
      project: solution,
      root,
      file,
      operation: "rename",
      position: source.indexOf("input"),
      newName: "value",
    });

    const after = result.changes.find((change) => change.path === file)?.after ?? "";
    expect(result.diagnosticsAfter).toEqual([]);
    expect(after).toContain("Read(int value) => value + this.value");
    expect(await readFile(file, "utf8")).toBe(source);
  }, 120_000);

  test("formats a document through Roslyn", async () => {
    const source = "namespace Sample;\npublic class Messy{public int Value=>1;}\n";
    const file = join(root, "Library", "Messy.cs");
    await Bun.write(file, source);
    const result = await analyze({
      project: join(root, "Library", "Library.csproj"),
      root,
      file,
      operation: "format",
    });

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.after).toContain("class Messy { public int Value => 1; }");
    expect(await readFile(file, "utf8")).toBe(source);
  }, 120_000);

  test("removes imports identified by Roslyn while preserving comments", async () => {
    const source = `using System;
// This comment must survive removal of the following import.
using System.Collections.Generic;

namespace Sample;
public class Imports { public DateTime Now => DateTime.Now; }
`;
    const file = join(root, "Library", "Imports.cs");
    await Bun.write(file, source);
    const result = await analyze({
      project: solution,
      root,
      file,
      operation: "imports",
      mode: "remove-unused",
    });

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.after).toContain("using System;");
    expect(result.changes[0]?.after).not.toContain("Collections.Generic");
    expect(result.changes[0]?.after).toContain("// This comment must survive removal");
    expect(await readFile(file, "utf8")).toBe(source);
  }, 120_000);

  test("preserves a UTF-8 BOM in before and after text accepted by core planning", async () => {
    const source = "\uFEFFnamespace Sample;\npublic class Bom{public int Value=>1;}\n";
    const file = join(root, "Library", "Bom.cs");
    await Bun.write(file, source);

    const plan = await createPlan({
      project: join(root, "Library", "Library.csproj"),
      root,
      file,
      operation: "format",
    }, analyze);

    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]?.before?.startsWith("\uFEFF")).toBe(true);
    expect(plan.changes[0]?.after?.startsWith("\uFEFF")).toBe(true);
    expect(await readFile(file, "utf8")).toBe(source);
  }, 120_000);

  test("rejects non-UTF-8 source without changing it", async () => {
    const file = join(root, "Library", "Utf16.cs");
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("namespace Sample;\npublic class Utf16{ }\n", "utf16le"),
    ]);
    await Bun.write(file, bytes);

    await expect(analyze({
      project: join(root, "Library", "Library.csproj"),
      root,
      file,
      operation: "format",
    })).rejects.toThrow("UNSUPPORTED_ENCODING");
    expect(await readFile(file)).toEqual(bytes);
  }, 120_000);

  test("maps UTF-16 rename positions from UTF-8 BOM source correctly", async () => {
    const source = "\uFEFFnamespace Sample;\npublic class B { public B Create() => new B(); }\n";
    const file = join(root, "Library", "BomRename.cs");
    await Bun.write(file, source);
    const plan = await createPlan({
      project: join(root, "Library", "Library.csproj"), root, file,
      operation: "rename", position: source.indexOf("class B") + "class ".length,
      newName: "RenamedBom",
    }, analyze);
    expect(plan.changes[0]?.before).toBe(source);
    expect(plan.changes[0]?.after).toBe("\uFEFFnamespace Sample;\npublic class RenamedBom { public RenamedBom Create() => new RenamedBom(); }\n");
    expect(plan.validation.status).toBe("passed");
    expect(await readFile(file, "utf8")).toBe(source);
  }, 120_000);

  test("rejects loaded project references outside the snapshot root", async () => {
    const scopedRoot = await mkdtemp(join(tmpdir(), "refactor-ai-csharp-scope-"));
    const externalRoot = await mkdtemp(join(tmpdir(), "refactor-ai-csharp-external-"));
    try {
      const externalProject = join(externalRoot, "External.csproj");
      await Bun.write(externalProject, projectFile());
      await Bun.write(join(externalRoot, "External.cs"), "public class External { }\n");
      const scopedProject = join(scopedRoot, "Scoped.csproj");
      const scopedFile = join(scopedRoot, "Scoped.cs");
      await Bun.write(scopedProject, projectFile(externalProject));
      await Bun.write(scopedFile, "public class Scoped { }\n");
      run(["dotnet", "restore", scopedProject, "--disable-parallel", "--nologo"], scopedRoot);

      await expect(analyze({
        project: scopedProject,
        root: scopedRoot,
        file: scopedFile,
        operation: "format",
      })).rejects.toThrow("OUTSIDE_ROOT");
    } finally {
      await rm(scopedRoot, { recursive: true, force: true });
      await rm(externalRoot, { recursive: true, force: true });
    }
  }, 120_000);

  test("rejects a changed source path linked into multiple projects", async () => {
    const linkedRoot = await mkdtemp(join(tmpdir(), "refactor-ai-csharp-linked-"));
    try {
      const firstDirectory = join(linkedRoot, "First");
      const secondDirectory = join(linkedRoot, "Second");
      await mkdir(firstDirectory);
      await mkdir(secondDirectory);
      const sharedFile = join(linkedRoot, "Shared.cs");
      const declarationFile = join(firstDirectory, "Target.cs");
      const declarationSource = "public class Target { }\n";
      await Bun.write(sharedFile, "public class SharedUse { public Target Create() => new Target(); }\n");
      await Bun.write(declarationFile, declarationSource);
      await Bun.write(join(firstDirectory, "First.csproj"), linkedProject("../Shared.cs"));
      await Bun.write(
        join(secondDirectory, "Second.csproj"),
        linkedProject("../Shared.cs", "../First/First.csproj"),
      );
      run(["dotnet", "new", "sln", "--name", "Linked"], linkedRoot);
      const linkedSolution = join(linkedRoot, "Linked.sln");
      run([
        "dotnet", "sln", linkedSolution, "add",
        join(firstDirectory, "First.csproj"),
        join(secondDirectory, "Second.csproj"),
      ], linkedRoot);
      run(["dotnet", "restore", linkedSolution, "--disable-parallel", "--nologo"], linkedRoot);

      await expect(analyze({
        project: linkedSolution,
        root: linkedRoot,
        file: declarationFile,
        operation: "rename",
        position: declarationSource.indexOf("Target"),
        newName: "RenamedTarget",
      })).rejects.toThrow("AMBIGUOUS_CHANGE");
    } finally {
      await rm(linkedRoot, { recursive: true, force: true });
    }
  }, 120_000);

  test("rejects a successful-looking response from a nonzero helper exit", async () => {
    const fakeBin = await mkdtemp(join(tmpdir(), "refactor-ai-csharp-fake-dotnet-"));
    const fakeDotnet = join(fakeBin, "dotnet");
    const originalPath = process.env.PATH;
    try {
      await Bun.write(fakeDotnet, `#!/bin/sh
printf '%s' '{"result":{"backend":"roslyn","version":"4.12.0","changes":[],"diagnosticsBefore":[],"diagnosticsAfter":[],"notes":[]}}'
printf '%s' 'synthetic helper failure' >&2
exit 7
`);
      await chmod(fakeDotnet, 0o755);
      process.env.PATH = fakeBin;

      await expect(analyze({
        project: solution,
        root,
        file: libraryFile,
        operation: "format",
      })).rejects.toThrow("CSHARP_HELPER_FAILED: synthetic helper failure");
    } finally {
      process.env.PATH = originalPath;
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  test("rejects unsupported operations before launching the helper", async () => {
    await expect(analyze({
      project: solution,
      root,
      file: libraryFile,
      operation: "imports",
      mode: "sort",
    })).rejects.toThrow("UNSUPPORTED_OPERATION");
    await expect(analyze({
      project: solution,
      root,
      file: libraryFile,
      operation: "extract-function",
    })).rejects.toThrow("UNSUPPORTED_OPERATION");
  });
});

function projectFile(reference?: string): string {
  const projectReference = reference
    ? `\n  <ItemGroup>\n    <ProjectReference Include="${reference}" />\n  </ItemGroup>`
    : "";
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>disable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>${projectReference}
</Project>
`;
}

function linkedProject(linkedSource: string, reference?: string): string {
  const projectReference = reference
    ? `\n    <ProjectReference Include="${reference}" />`
    : "";
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>disable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="${linkedSource}" Link="Shared.cs" />${projectReference}
  </ItemGroup>
</Project>
`;
}

function run(command: string[], cwd: string): void {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr) || new TextDecoder().decode(result.stdout));
  }
}
