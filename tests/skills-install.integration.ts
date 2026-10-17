import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let workspace: string;
const names = ["refactor-rename", "refactor-imports", "refactor-format", "refactor-extract-function", "refactor-extract-variable", "refactor-rename-file", "refactor-sync-namespace", "refactor-move-type", "refactor-retarget-import"];

function run(command: string, args: string[], cwd = workspace): string {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", timeout: 240_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, DISABLE_TELEMETRY: "1", DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout;
}

function launcher(name: string): string {
  return join(workspace, ".agents", "skills", name, "scripts", "refactor.mjs");
}

function point(text: string, offset: number): string {
  const prefix = text.slice(0, offset);
  return `${prefix.split("\n").length}:${offset - prefix.lastIndexOf("\n")}`;
}

beforeAll(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-installed-skills-")));
  run("npx", ["--yes", "skills@1.7.0", "add", repo, "--skill", "*", "--agent", "codex", "--copy", "--yes"]);
  for (const kind of ["typescript", "javascript", "csharp"]) {
    await cp(join(repo, "examples", kind), join(workspace, kind), { recursive: true });
  }
}, 240_000);

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

test("npx skills copies all independent skills and each launcher sets up a locked Node runtime", async () => {
  for (const name of names) {
    const skill = join(workspace, ".agents", "skills", name);
    const instructions = await readFile(join(skill, "SKILL.md"), "utf8");
    expect(instructions).toContain("scripts/refactor.mjs");
    const project = name === "refactor-sync-namespace"
      ? join(workspace, "csharp", "Caller.csproj")
      : join(workspace, "typescript", "tsconfig.json");
    const supported = JSON.parse(run("node", [launcher(name), "capabilities", "--project", project]));
    expect(supported.map((item: { operation: string }) => item.operation)).toContain(name.replace("refactor-", ""));
    const installed = JSON.parse(await readFile(join(skill, "assets", "runtime", "node_modules", "typescript", "package.json"), "utf8"));
    expect(installed.version).toBe("5.9.3");
  }
}, 240_000);

test("custom scripts import relocated skill APIs without CLI output and prepare their own runtime on demand", async () => {
  const copied = join(workspace, "renamed-skill-directory");
  await cp(join(workspace, ".agents", "skills", "refactor-rename"), copied, {
    recursive: true, filter: path => !/[\\/](node_modules|bin|obj)([\\/]|$)/.test(path),
  });
  const root = join(workspace, "api-project");
  await cp(join(repo, "examples", "typescript"), root, { recursive: true });
  const script = join(workspace, "custom-api.mjs");
  const project = join(root, "tsconfig.json"), file = join(root, "math.ts");
  await writeFile(script, `
    import assert from 'node:assert/strict';
    import { access, readFile } from 'node:fs/promises';
    import { pathToFileURL } from 'node:url';
    const home = process.env.REFACTOR_AI_HOME, args = [...process.argv];
    const { createRefactor } = await import(pathToFileURL(${JSON.stringify(join(copied, "scripts", "api.mjs"))}).href);
    await assert.rejects(access(${JSON.stringify(join(copied, "assets", "runtime", "node_modules"))}));
    assert.deepEqual(process.argv, args);
    const api = await createRefactor();
    const project = ${JSON.stringify(project)}, file = ${JSON.stringify(file)};
    const before = await readFile(file, 'utf8');
    const plan = await api.plan({ project, file, at: before.indexOf('add'), name: 'sum' });
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal((await api.validate(plan)).status, 'validated');
    await api.apply(plan);
    assert.ok((await readFile(file, 'utf8')).includes('function sum'));
    assert.equal(process.env.REFACTOR_AI_HOME, home);
    console.log('skill API passed');
  `);
  expect(run("node", [script]).trim()).toBe("skill API passed");
  expect(await readFile(join(copied, "scripts", "API.md"), "utf8")).toContain("Sequential automation");
  expect(await readFile(join(copied, "scripts", "api.d.mts"), "utf8")).toContain("createRefactor");
}, 240_000);

for (const kind of ["typescript", "javascript", "csharp"]) {
  test(`the copied rename skill plans, previews, validates and applies ${kind} without the original tool checkout`, async () => {
    const root = join(workspace, kind);
    const csharp = kind === "csharp";
    const config = join(root, csharp ? "Caller.csproj" : kind === "typescript" ? "tsconfig.json" : "jsconfig.json");
    const file = join(root, csharp ? "Utility.cs" : kind === "typescript" ? "math.ts" : "math.js");
    const caller = join(root, csharp ? "Caller.cs" : kind === "typescript" ? "caller.ts" : "caller.js");
    const source = await readFile(file, "utf8");
    const oldName = csharp ? "Add" : "add", newName = csharp ? "Sum" : "sum";
    if (csharp) run("dotnet", ["restore", config, "--nologo"]);
    const plan = join(root, ".refactor-ai", "installed-rename.json");
    const runner = launcher("refactor-rename");
    const response = JSON.parse(run("node", [runner, "plan", "rename", "--project", config, "--file", file,
      "--at", point(source, source.indexOf(oldName)), "--name", newName, "--out", plan]));
    expect(response.validation.status).toBe("passed");
    expect(await readFile(file, "utf8")).toBe(source);
    expect(run("node", [runner, "preview", "--plan", plan])).toContain(newName);
    expect(JSON.parse(run("node", [runner, "validate", "--plan", plan])).status).toBe("validated");
    expect(JSON.parse(run("node", [runner, "apply", "--plan", plan])).status).toBe("applied");
    expect(await readFile(caller, "utf8")).toContain(`${newName}(2, 3)`);
    if (csharp) expect(run("dotnet", ["run", "--project", config, "--no-restore", "--nologo"]).trim()).toBe("5");
  }, 240_000);
}

function planApply(skill: string, config: string, source: string, operation: string, options: string[], plan: string): void {
  const runner = launcher(skill);
  const response = JSON.parse(run("node", [runner, "plan", operation, "--project", config, "--file", source, ...options, "--out", plan]));
  expect(response.validation.status).toBe("passed");
  run("node", [runner, "preview", "--plan", plan]);
  expect(JSON.parse(run("node", [runner, "validate", "--plan", plan])).status).toBe("validated");
  expect(JSON.parse(run("node", [runner, "apply", "--plan", plan])).status).toBe("applied");
}

test("installed move-type and rename-file skills update TS imports and preserve execution", async () => {
  const root = join(workspace, "installed-fileops-ts");
  await mkdir(root);
  const project = join(root, "tsconfig.json"), source = join(root, "types.ts"), target = join(root, "models", "deep", "Widget.ts");
  await writeFile(project, JSON.stringify({ compilerOptions: { strict: true, module: "commonjs", target: "es2022" }, include: ["**/*.ts"], exclude: ["dist"] }));
  await writeFile(join(root, "package.json"), '{"type":"commonjs"}\n');
  const original = "export class Widget { static value = 5; }\nexport class Other { static value = 2; }\n";
  await writeFile(source, original);
  await writeFile(join(root, "caller.ts"), 'import { Widget, Other } from "./types";\nconsole.log(Widget.value + Other.value);\n');
  const runner = launcher("refactor-move-type"), plan = join(root, ".refactor-ai", "move.json");
  const response = JSON.parse(run("node", [runner, "plan", "move-type", "--project", project, "--file", source, "--type", "Widget", "--to", target, "--out", plan]));
  expect(response.validation.status).toBe("passed");
  expect(await readFile(source, "utf8")).toBe(original);
  await expect(access(target)).rejects.toThrow();
  expect(JSON.parse(run("node", [runner, "apply", "--plan", plan])).status).toBe("applied");
  expect(await readFile(target, "utf8")).toContain("class Widget");
  expect(await readFile(source, "utf8")).toContain("class Other");
  expect(await readFile(source, "utf8")).not.toContain("class Widget");
  planApply("refactor-rename-file", project, source, "rename-file", ["--type", "Other"], join(root, ".refactor-ai", "rename-file.json"));
  await expect(access(source)).rejects.toThrow();
  expect(await readFile(join(root, "Other.ts"), "utf8")).toContain("class Other");
  const tsc = join(workspace, ".agents", "skills", "refactor-move-type", "assets", "runtime", "node_modules", "typescript", "bin", "tsc");
  run("node", [tsc, "--project", project, "--outDir", join(root, "dist")]);
  expect(run("node", [join(root, "dist", "caller.js")]).trim()).toBe("7");
}, 240_000);

test("installed C# filename and namespace skills leave unrelated types in their original namespace", async () => {
  const root = join(workspace, "installed-fileops-csharp");
  await mkdir(join(root, "Models"), { recursive: true });
  const project = join(root, "Example.csproj"), source = join(root, "Models", "Wrong.cs"), renamed = join(root, "Models", "Widget.cs");
  await writeFile(project, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><OutputType>Exe</OutputType><RootNamespace>Example</RootNamespace></PropertyGroup></Project>\n');
  await writeFile(source, '\uFEFFnamespace Legacy;\npublic class Widget { public static int Value => 5; }\n');
  await writeFile(join(root, "Other.cs"), 'namespace Legacy;\npublic class Other { public static int Value => 2; }\n');
  await writeFile(join(root, "Caller.cs"), 'using System;\nusing Legacy;\npublic static class Caller { public static void Main() { Console.WriteLine(Widget.Value + Other.Value); } }\n');
  run("dotnet", ["restore", project, "--nologo"]);
  planApply("refactor-rename-file", project, source, "rename-file", [], join(root, ".refactor-ai", "rename-file.json"));
  await expect(access(source)).rejects.toThrow();
  expect(await readFile(renamed, "utf8")).toStartWith("\uFEFF");
  planApply("refactor-sync-namespace", project, renamed, "sync-namespace", [], join(root, ".refactor-ai", "namespace.json"));
  expect(await readFile(renamed, "utf8")).toContain("namespace Example.Models");
  expect(await readFile(join(root, "Other.cs"), "utf8")).toContain("namespace Legacy;");
  expect(run("dotnet", ["run", "--project", project, "--no-restore", "--nologo"]).trim()).toBe("7");
}, 240_000);

test("installed move-type crosses TS project boundaries and both configurations still compile", async () => {
  const root = join(workspace, "installed-cross-project-ts"), sourceRoot = join(root, "Source"), targetRoot = join(root, "Target");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(targetRoot);
  const project = join(sourceRoot, "tsconfig.json"), targetProject = join(targetRoot, "tsconfig.json");
  const options = { strict: true, module: "commonjs", target: "es2022", rootDir: ".." };
  await writeFile(project, JSON.stringify({ compilerOptions: { ...options, outDir: "../dist/source" }, include: ["**/*.ts"] }));
  await writeFile(targetProject, JSON.stringify({ compilerOptions: { ...options, outDir: "../dist/target" }, include: ["**/*.ts"] }));
  await writeFile(join(root, "package.json"), '{"type":"commonjs"}\n');
  const source = join(sourceRoot, "types.ts"), target = join(targetRoot, "Models", "Widget.ts");
  await writeFile(source, "export class Widget { static value = 5; }\nexport class Other { static value = 2; }\n");
  await writeFile(join(sourceRoot, "caller.ts"), 'import { Widget, Other } from "./types";\nconsole.log(Widget.value + Other.value);\n');
  await writeFile(join(targetRoot, "placeholder.ts"), "export const placeholder = true;\n");
  planApply("refactor-move-type", project, source, "move-type", ["--root", root, "--type", "Widget", "--to", target, "--target-project", targetProject], join(root, ".refactor-ai", "cross-project.json"));
  expect(await readFile(source, "utf8")).toContain("class Other");
  expect(await readFile(source, "utf8")).not.toContain("class Widget");
  expect(await readFile(target, "utf8")).toContain("class Widget");
  const tsc = join(workspace, ".agents", "skills", "refactor-move-type", "assets", "runtime", "node_modules", "typescript", "bin", "tsc");
  run("node", [tsc, "--project", project]);
  run("node", [tsc, "--project", targetProject]);
  expect(run("node", [join(root, "dist", "source", "Source", "caller.js")]).trim()).toBe("7");
}, 240_000);

test("installed move-type moves a selected C# type between projects and plans dependency updates", async () => {
  const root = join(workspace, "installed-cross-project-csharp"), sourceRoot = join(root, "Source"), targetRoot = join(root, "Target");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(targetRoot);
  const sourceProject = join(sourceRoot, "Source.csproj"), targetProject = join(targetRoot, "Target.csproj");
  await writeFile(sourceProject, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><OutputType>Exe</OutputType><RootNamespace>Origin</RootNamespace></PropertyGroup></Project>\n');
  await writeFile(targetProject, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><RootNamespace>Destination</RootNamespace></PropertyGroup></Project>\n');
  const source = join(sourceRoot, "Types.cs"), target = join(targetRoot, "Models", "Widget.cs");
  await writeFile(source, 'namespace Origin;\npublic class Widget { public static int Value => 5; }\npublic class Other { public static int Value => 2; }\n');
  await writeFile(join(sourceRoot, "Caller.cs"), 'using System;\nusing Origin;\npublic static class Caller { public static void Main() { Console.WriteLine(Widget.Value + Other.Value); } }\n');
  const solution = join(root, "Workspace.sln");
  const template = 'Microsoft Visual Studio Solution File, Format Version 12.00\n# Visual Studio Version 17\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Source", "Source/Source.csproj", "{11111111-1111-1111-1111-111111111111}"\nEndProject\nProject("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Target", "Target/Target.csproj", "{22222222-2222-2222-2222-222222222222}"\nEndProject\nGlobal\nEndGlobal\n';
  await writeFile(solution, template);
  run("dotnet", ["restore", sourceProject, "--nologo"]);
  run("dotnet", ["restore", targetProject, "--nologo"]);
  planApply("refactor-move-type", solution, source, "move-type", ["--root", root, "--type", "Widget", "--to", target, "--target-project", targetProject], join(root, ".refactor-ai", "cross-project.json"));
  expect(await readFile(source, "utf8")).toContain("class Other");
  expect(await readFile(source, "utf8")).not.toContain("class Widget");
  expect(await readFile(target, "utf8")).toContain("class Widget");
  expect(await readFile(sourceProject, "utf8")).toContain("ProjectReference");
  run("dotnet", ["restore", sourceProject, "--nologo"]);
  expect(run("dotnet", ["run", "--project", sourceProject, "--no-restore", "--nologo"]).trim()).toBe("7");
}, 240_000);
