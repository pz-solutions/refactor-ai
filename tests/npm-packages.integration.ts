import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repo = resolve(import.meta.dir, "..");
let workspace: string;
const tarballs = new Map<string, string>();
const tsOperations = ["rename", "imports", "format", "extract-function", "extract-variable", "rename-file", "move-type", "inline-reexports"];
const csharpOperations = ["rename", "imports", "format", "rename-file", "sync-namespace", "move-type"];
const distributions = [
  { name: "cli", language: "all" },
  ...tsOperations.map(operation => ({ name: `ts-${operation}`, language: "typescript", operation })),
  ...csharpOperations.map(operation => ({ name: `csharp-${operation}`, language: "csharp", operation })),
];

function run(command: string, args: string[], cwd = workspace) {
  return spawnSync(command, args, {
    cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, npm_config_cache: join(workspace, "npm-cache"), npm_config_ignore_scripts: "true",
      DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1", REFACTOR_AI_HOME: "/missing-original-checkout" },
  });
}
function success(command: string, args: string[], cwd = workspace): string {
  const result = run(command, args, cwd);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
function npx(name: string, args: string[], cwd = workspace): string {
  return success("npx", ["--yes", `file:${tarballs.get(name)!}`, ...args], cwd);
}

beforeAll(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-npm-test-")));
  success("bun", ["run", "package:npm"], repo);
  const version = JSON.parse(await readFile(join(repo, "package.json"), "utf8")).version;
  for (const { name, language } of distributions) {
    const packed = JSON.parse(success("npm", ["pack", join(repo, "dist", "npm", name), "--json", "--pack-destination", workspace]))[0];
    tarballs.set(name, join(workspace, packed.filename));
    const manifest = JSON.parse(await readFile(join(repo, "dist", "npm", name, "package.json"), "utf8"));
    expect(manifest.name).toBe(`@refactor-ai/${name}`);
    expect(manifest.version).toBe(version);
    expect(packed.version).toBe(version);
    expect(manifest.publishConfig.tag).toBe(version.includes("-") ? "next" : "latest");
    expect(manifest.private).not.toBe(true);
    expect(Object.keys(manifest.bin)).toHaveLength(1);
    expect(manifest.scripts).toBeUndefined();
    expect(manifest.exports["."]).toEqual({ types: "./lib/api.d.mts", import: "./lib/api.mjs" });
    expect(packed.files.some((file: { path: string }) => file.path === "lib/api.mjs")).toBe(true);
    expect(packed.files.some((file: { path: string }) => file.path === "lib/api.d.mts")).toBe(true);
    const apiModule = await readFile(join(repo, "dist", "npm", name, "lib", "api.mjs"), "utf8");
    if (language === "typescript") expect(apiModule).not.toContain("CSHARP_HELPER_FAILED");
    if (language === "csharp") expect(apiModule).not.toMatch(/from ["']typescript["']/);
    expect(manifest.dependencies).toEqual(language === "csharp" ? {} : { typescript: "5.9.3" });
    expect(packed.files.some((file: { path: string }) => file.path.startsWith("dotnet/"))).toBe(language !== "typescript");
    const runner = await readFile(join(repo, "dist", "npm", name, "lib", "runner.mjs"), "utf8");
    if (language === "typescript") expect(runner).not.toContain("CSHARP_HELPER_FAILED");
    if (language === "csharp") expect(runner).not.toMatch(/from ["']typescript["']/);

    expect(packed.files.some((file: { path: string }) => file.path === "bin/cli.mjs")).toBe(true);
    expect(packed.files.every((file: { path: string }) => !/(^|\/)(node_modules|obj|bin\/Release|entry\.ts)(\/|$)/.test(file.path))).toBe(true);
  }
}, 120_000);

afterAll(async () => { if (workspace) await rm(workspace, { recursive: true, force: true }); });

test("all installed npm APIs import without CLI effects and their declarations work in a NodeNext consumer", async () => {
  const consumer = join(workspace, "api-consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), '{"type":"module","private":true}\n');
  success("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs.values()], consumer);
  const script = join(consumer, "imports.mjs");
  await writeFile(script, `
    import assert from 'node:assert/strict';
    import { readdir } from 'node:fs/promises';
    const argv = [...process.argv], home = process.env.REFACTOR_AI_HOME, exitCode = process.exitCode;
    for (const name of ${JSON.stringify(distributions.map(entry => entry.name))}) {
      const { createRefactor } = await import('@refactor-ai/' + name);
      const api = await createRefactor();
      assert.equal(typeof api.plan, 'function');
      assert.equal(typeof api.preview, 'function');
      assert.equal(typeof api.apply, 'function');
      assert.equal(process.env.REFACTOR_AI_HOME, home);
      assert.equal(process.exitCode, exitCode);
      assert.deepEqual(process.argv, argv);
    }
    assert.deepEqual((await readdir('.')).sort(), ['imports.mjs', 'node_modules', 'package-lock.json', 'package.json']);
    console.log('imports passed');
  `);
  const imported = run("node", [script], consumer);
  expect(imported.status).toBe(0);
  expect(imported.stdout.trim()).toBe("imports passed");
  expect(imported.stderr).toBe("");
  await writeFile(join(consumer, "consumer.mts"), `
    import { createRefactor, type PlanOptions, type Plan, type RefactorApi } from '@refactor-ai/ts-rename';
    import { createRefactor as createCsharp } from '@refactor-ai/csharp-rename';
    const options: PlanOptions = { project: './tsconfig.json', file: './math.ts', at: '1:17', name: 'sum' };
    const api: RefactorApi = await createRefactor();
    const plan: Plan = await api.plan(options);
    api.preview(plan);
    await api.validate(plan);
    await api.apply(plan);
    await createCsharp();
    // @ts-expect-error Invalid coordinates should be rejected by declarations.
    options.at = true;
    // @ts-expect-error Unsupported operations should be rejected by declarations.
    options.operation = 'arbitrary-rewrite';
  `);
  success("node", [join(consumer, "node_modules", "typescript", "bin", "tsc"), "consumer.mts", "--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2023"], consumer);
}, 120_000);

for (const language of ["typescript", "javascript", "csharp"]) {
  test(`an external custom script imports npm APIs and sequentially renames and formats ${language}`, async () => {
    const consumer = join(workspace, "api-consumer");
    const root = join(workspace, `api-${language}`);
    await cp(join(repo, "examples", language), root, { recursive: true });
    const csharp = language === "csharp", prefix = csharp ? "csharp" : "ts";
    const project = join(root, csharp ? "Caller.csproj" : language === "typescript" ? "tsconfig.json" : "jsconfig.json");
    const file = join(root, csharp ? "Utility.cs" : language === "typescript" ? "math.ts" : "math.js");
    if (csharp) success("dotnet", ["restore", project, "--nologo"], root);
    const script = join(consumer, `${language}.mjs`);
    await writeFile(script, `
      import assert from 'node:assert/strict';
      import { readFile } from 'node:fs/promises';
      import { createRefactor as createRename } from '@refactor-ai/${prefix}-rename';
      import { createRefactor as createFormat } from '@refactor-ai/${prefix}-format';
      import { createRefactor as createForeign } from '@refactor-ai/${csharp ? "ts" : "csharp"}-rename';
      const rename = await createRename(), format = await createFormat(), foreign = await createForeign();
      const project = ${JSON.stringify(project)}, file = ${JSON.stringify(file)};
      const before = await readFile(file, 'utf8');
      const first = await rename.plan({ project, file, at: before.indexOf(${JSON.stringify(csharp ? "Add" : "add")}), name: 'Sum' });
      assert.equal(await readFile(file, 'utf8'), before);
      assert.equal(first.validation.status, 'passed');
      assert.ok(rename.preview(first).includes('Sum'));
      assert.throws(() => foreign.preview(first), /UNSUPPORTED_LANGUAGE/);
      await assert.rejects(foreign.apply(first), /UNSUPPORTED_LANGUAGE/);
      await assert.rejects(rename.plan({ project, file, operation: 'format' }), /only supports rename/);
      assert.equal((await rename.validate(first)).status, 'validated');
      await rename.apply(first);
      await assert.rejects(rename.validate(first), /STALE_SNAPSHOT/);
      const second = await format.plan({ project, file });
      assert.equal((await format.validate(second)).status, 'validated');
      await format.apply(second);
      assert.ok((await readFile(file, 'utf8')).includes('Sum'));
      console.log('sequence passed');
    `);
    expect(success("node", [script], consumer).trim()).toBe("sequence passed");
    if (csharp) expect(success("dotnet", ["run", "--project", project, "--no-restore", "--nologo"], root).trim()).toBe("5");
  }, 120_000);
}

test("all generated tarballs expose language-specific help through npx", () => {
  for (const { name, language } of distributions) {
    const help = npx(name, ["--help"]);
    expect(help).toContain(`npx @refactor-ai/${name}`);
    expect(help).toContain("Examples");
    expect(help).not.toContain("node dist/cli.js");
    if (language === "typescript") {
      expect(help).not.toContain(".csproj");
      expect(help).not.toContain("Roslyn");
      expect(help).not.toContain("dotnet");
    }
    if (language === "csharp") {
      expect(help).not.toContain("tsconfig.json");
      expect(help).not.toContain("typescript/");
      expect(help).not.toContain("TypeScript");
    }

    expect(npx(name, ["apply", "--help"])).toContain("--plan");
  }
}, 120_000);

test("all generated prerelease packages inherit the beta version and default to next", async () => {
  const checkout = join(workspace, "beta-author");
  await mkdir(join(checkout, "scripts"), { recursive: true });
  await cp(join(repo, "docs"), join(checkout, "docs"), { recursive: true });
  await cp(join(repo, "src"), join(checkout, "src"), { recursive: true });
  for (const name of ["package-npm.ts", "release-version.ts", "api-declarations.ts"]) await cp(join(repo, "scripts", name), join(checkout, "scripts", name));
  const helper = join(checkout, "dotnet", "RefactorHelper");
  await mkdir(helper, { recursive: true });
  for (const name of await readdir(join(repo, "dotnet", "RefactorHelper"))) {
    if (name.endsWith(".cs") || name === "RefactorHelper.csproj" || name === "packages.lock.json") await cp(join(repo, "dotnet", "RefactorHelper", name), join(helper, name));
  }
  await symlink(join(repo, "node_modules"), join(checkout, "node_modules"), "junction");
  const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  await writeFile(join(checkout, "package.json"), JSON.stringify({ ...manifest, version: "0.2.0-beta.10" }));
  success("bun", [join(checkout, "scripts", "package-npm.ts")], checkout);
  for (const { name, language } of distributions) {
    const generated = JSON.parse(await readFile(join(checkout, "dist", "npm", name, "package.json"), "utf8"));
    expect(generated.version).toBe("0.2.0-beta.10");
    expect(generated.publishConfig).toEqual({ access: "public", tag: "next" });
  }
  const packed = JSON.parse(success("npm", ["pack", join(checkout, "dist", "npm", "cli"), "--json", "--pack-destination", checkout]))[0];
  expect(packed.version).toBe("0.2.0-beta.10");
}, 120_000);

test("language bins report their own capability and reject foreign projects", async () => {
  const directory = join(workspace, "capabilities");
  await mkdir(directory);
  const tsProject = join(directory, "tsconfig.json"), csharpProject = join(directory, "App.csproj");
  await writeFile(tsProject, '{"include":["*.ts"]}\n');
  await writeFile(join(directory, "src.ts"), "export const value = 1;\n");
  await writeFile(csharpProject, '<Project Sdk="Microsoft.NET.Sdk"/>\n');
  expect(JSON.parse(npx("cli", ["capabilities", "--project", tsProject])).length).toBe(tsOperations.length);
  expect(JSON.parse(npx("cli", ["capabilities", "--project", csharpProject])).length).toBe(csharpOperations.length);
  for (const entry of distributions) {
    if (!("operation" in entry)) continue;
    const project = entry.language === "csharp" ? csharpProject : tsProject;
    const foreign = entry.language === "csharp" ? tsProject : csharpProject;
    expect(JSON.parse(npx(entry.name, ["capabilities", "--project", project])).map((item: { operation: string }) => item.operation)).toEqual([entry.operation]);
    for (const args of [["capabilities", "--project", foreign], ["plan", "--project", foreign, "--file", "/missing-source"]]) {
      const rejected = run("npx", ["--yes", `file:${tarballs.get(entry.name)!}`, ...args]);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain("UNSUPPORTED_LANGUAGE");
    }
  }
  const rejected = run("npx", ["--yes", `file:${tarballs.get("ts-rename")!}`, "plan", "format", "--project", "/missing.json"]);
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain("only supports rename");
}, 120_000);

for (const language of ["typescript", "javascript", "csharp"]) {
  test(`language-specific rename bin plans, previews, validates and applies ${language} without the checkout`, async () => {
    const root = join(workspace, language);
    await cp(join(repo, "examples", language), root, { recursive: true });
    const csharp = language === "csharp";
    const packageName = csharp ? "csharp-rename" : "ts-rename";
    const config = join(root, csharp ? "Caller.csproj" : language === "typescript" ? "tsconfig.json" : "jsconfig.json");
    const file = join(root, csharp ? "Utility.cs" : language === "typescript" ? "math.ts" : "math.js");
    const source = await readFile(file, "utf8");
    const oldName = csharp ? "Add" : "add";
    const index = source.indexOf(oldName), prefix = source.slice(0, index);
    const at = `${prefix.split("\n").length}:${index - prefix.lastIndexOf("\n")}`;
    if (csharp) {
      success("dotnet", ["restore", config, "--nologo"], root);
      // A fresh installed tool must build its own helper rather than execute this cwd decoy.
      const foreign = join(root, "dotnet", "RefactorHelper", "bin", "Release", "net8.0");
      await mkdir(foreign, { recursive: true });
      await writeFile(join(foreign, "RefactorHelper.dll"), "foreign helper must never execute");
    }
    const result = JSON.parse(npx(packageName, ["plan", "--project", config, "--file", file, "--at", at, "--name", "Sum"], root));
    expect(result.validation.status).toBe("passed");
    expect(await readFile(file, "utf8")).toBe(source);
    for (const command of ["preview", "validate", "apply"]) {
      const wrongPackage = csharp ? "ts-rename" : "csharp-rename";
      const rejected = run("npx", ["--yes", `file:${tarballs.get(wrongPackage)!}`, command, "--plan", result.plan], root);
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain("UNSUPPORTED_LANGUAGE");
      expect(await readFile(file, "utf8")).toBe(source);
    }

    expect(npx(packageName, ["preview", "--plan", result.plan], root)).toContain("Sum");
    expect(JSON.parse(npx(packageName, ["validate", "--plan", result.plan], root)).status).toBe("validated");
    expect(JSON.parse(npx(packageName, ["apply", "--plan", result.plan], root)).status).toBe("applied");
    expect(await readFile(file, "utf8")).toContain("Sum");
    if (csharp) {
      expect(success("dotnet", ["run", "--project", config, "--no-restore", "--nologo"], root).trim()).toBe("5");
      const imports = JSON.parse(npx("csharp-imports", ["plan", "--project", config, "--file", file], root));
      const stored = JSON.parse(await readFile(imports.plan, "utf8"));
      expect(stored.request.mode).toBe("remove-unused");
      expect(imports.validation.status).toBe("passed");
    }
  }, 120_000);
}

test("scoped packages have inferred npx bins and packager help has no side effects", async () => {
  const target = join(workspace, "scoped");
  success("bun", [join(repo, "scripts", "package-npm.ts"), "--out", target, "--scope", "@refactor-test"]);
  const packageRoot = join(target, "ts-extract-variable");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  expect(manifest.name).toBe("@refactor-test/ts-extract-variable");
  const packed = JSON.parse(success("npm", ["pack", packageRoot, "--json", "--pack-destination", target]))[0];
  expect(success("npx", ["--yes", `file:${join(target, packed.filename)}`, "plan", "--help"])).toContain("npx @refactor-test/ts-extract-variable plan");
  const absent = join(workspace, "help-must-not-create");
  expect(success("bun", [join(repo, "scripts", "package-npm.ts"), "--out", absent, "--help"])).toContain("Examples");
  expect((await readdir(workspace)).includes("help-must-not-create")).toBe(false);
  const unsafe = run("bun", [join(repo, "scripts", "package-npm.ts"), "--out", resolve(repo, "..")]);
  expect(unsafe.status).not.toBe(0);
  expect(unsafe.stderr).toContain("must not replace the checkout");
}, 120_000);
