import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { operationHelp } from "../src/help.ts";

const repo = resolve(import.meta.dir, "..");
let workspace: string;
const tarballs = new Map<string, string>();
const operations = Object.keys(operationHelp);

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
  for (const name of ["refactor-ai", ...operations.map(operation => `refactor-ai-${operation}`)]) {
    const packed = JSON.parse(success("npm", ["pack", join(repo, "dist", "npm", name), "--json", "--pack-destination", workspace]))[0];
    tarballs.set(name, join(workspace, packed.filename));
    const manifest = JSON.parse(await readFile(join(repo, "dist", "npm", name, "package.json"), "utf8"));
    expect(manifest.name).toBe(`@pz-solutions/${name}`);
    expect(manifest.version).toBe(version);
    expect(packed.version).toBe(version);
    expect(manifest.publishConfig.tag).toBe(version.includes("-") ? "next" : "latest");
    expect(manifest.private).not.toBe(true);
    expect(Object.keys(manifest.bin)).toHaveLength(1);
    expect(manifest.scripts).toBeUndefined();
    expect(packed.files.some((file: { path: string }) => file.path === "bin/cli.mjs")).toBe(true);
    expect(packed.files.every((file: { path: string }) => !/(^|\/)(node_modules|obj|bin\/Release|entry\.ts)(\/|$)/.test(file.path))).toBe(true);
  }
}, 120_000);

afterAll(async () => { if (workspace) await rm(workspace, { recursive: true, force: true }); });

test("all nine tarballs execute through npx with their own help and bin", () => {
  for (const [name] of tarballs) {
    const help = npx(name, ["--help"]);
    expect(help).toContain(`npx @pz-solutions/${name}`);
    expect(help).toContain("Examples");
    expect(help).not.toContain("node dist/cli.js");
    expect(npx(name, ["apply", "--help"])).toContain("--plan");
  }
}, 120_000);

test("all nine prerelease packages inherit the beta version and default to next", async () => {
  const checkout = join(workspace, "beta-author");
  await mkdir(join(checkout, "scripts"), { recursive: true });
  await cp(join(repo, "src"), join(checkout, "src"), { recursive: true });
  for (const name of ["package-npm.ts", "release-version.ts"]) await cp(join(repo, "scripts", name), join(checkout, "scripts", name));
  const helper = join(checkout, "dotnet", "RefactorHelper");
  await mkdir(helper, { recursive: true });
  for (const name of await readdir(join(repo, "dotnet", "RefactorHelper"))) {
    if (name.endsWith(".cs") || name === "RefactorHelper.csproj" || name === "packages.lock.json") await cp(join(repo, "dotnet", "RefactorHelper", name), join(helper, name));
  }
  await symlink(join(repo, "node_modules"), join(checkout, "node_modules"), "junction");
  const manifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  await writeFile(join(checkout, "package.json"), JSON.stringify({ ...manifest, version: "0.2.0-beta.10" }));
  success("bun", [join(checkout, "scripts", "package-npm.ts")], checkout);
  for (const name of ["refactor-ai", ...operations.map(operation => `refactor-ai-${operation}`)]) {
    const generated = JSON.parse(await readFile(join(checkout, "dist", "npm", name, "package.json"), "utf8"));
    expect(generated.version).toBe("0.2.0-beta.10");
    expect(generated.publishConfig).toEqual({ access: "public", tag: "next" });
  }
  const packed = JSON.parse(success("npm", ["pack", join(checkout, "dist", "npm", "refactor-ai"), "--json", "--pack-destination", checkout]))[0];
  expect(packed.version).toBe("0.2.0-beta.10");
}, 120_000);

test("operation bins report their own capability and reject other operations", async () => {
  const project = join(workspace, "capabilities", "tsconfig.json");
  await mkdir(join(workspace, "capabilities"));
  await writeFile(project, '{"include":["*.ts"]}\n');
  await writeFile(join(workspace, "capabilities", "src.ts"), "export const value = 1;\n");
  expect(JSON.parse(npx("refactor-ai", ["capabilities", "--project", project])).length).toBeGreaterThan(1);
  for (const operation of operations.filter(operation => operation !== "sync-namespace")) {
    expect(JSON.parse(npx(`refactor-ai-${operation}`, ["capabilities", "--project", project])).map((item: { operation: string }) => item.operation)).toEqual([operation]);
  }
  const csharpProject = join(workspace, "capabilities", "App.csproj");
  await writeFile(csharpProject, '<Project Sdk="Microsoft.NET.Sdk"/>\n');
  expect(JSON.parse(npx("refactor-ai-sync-namespace", ["capabilities", "--project", csharpProject])).map((item: { operation: string }) => item.operation)).toEqual(["sync-namespace"]);
  const rejected = run("npx", ["--yes", `file:${tarballs.get("refactor-ai-rename")!}`, "plan", "format", "--project", "/missing.json"]);
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain("only supports rename");
}, 60_000);

for (const language of ["typescript", "javascript", "csharp"]) {
  test(`packed rename bin plans, previews, validates and applies ${language} without the checkout`, async () => {
    const root = join(workspace, language);
    await cp(join(repo, "examples", language), root, { recursive: true });
    const csharp = language === "csharp";
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
    const result = JSON.parse(npx("refactor-ai-rename", ["plan", "--project", config, "--file", file, "--at", at, "--name", "Sum"], root));
    expect(result.validation.status).toBe("passed");
    expect(await readFile(file, "utf8")).toBe(source);
    expect(npx("refactor-ai-rename", ["preview", "--plan", result.plan], root)).toContain("Sum");
    expect(JSON.parse(npx("refactor-ai-rename", ["validate", "--plan", result.plan], root)).status).toBe("validated");
    expect(JSON.parse(npx("refactor-ai-rename", ["apply", "--plan", result.plan], root)).status).toBe("applied");
    expect(await readFile(file, "utf8")).toContain("Sum");
    if (csharp) expect(success("dotnet", ["run", "--project", config, "--no-restore", "--nologo"], root).trim()).toBe("5");
  }, 120_000);
}

test("scoped packages have inferred npx bins and packager help has no side effects", async () => {
  const target = join(workspace, "scoped");
  success("bun", [join(repo, "scripts", "package-npm.ts"), "--out", target, "--scope", "@refactor-test"]);
  const packageRoot = join(target, "refactor-ai-extract-variable");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  expect(manifest.name).toBe("@refactor-test/refactor-ai-extract-variable");
  const packed = JSON.parse(success("npm", ["pack", packageRoot, "--json", "--pack-destination", target]))[0];
  expect(success("npx", ["--yes", `file:${join(target, packed.filename)}`, "plan", "--help"])).toContain("npx @refactor-test/refactor-ai-extract-variable plan");
  const absent = join(workspace, "help-must-not-create");
  expect(success("bun", [join(repo, "scripts", "package-npm.ts"), "--out", absent, "--help"])).toContain("Examples");
  expect((await readdir(workspace)).includes("help-must-not-create")).toBe(false);
  const unsafe = run("bun", [join(repo, "scripts", "package-npm.ts"), "--out", resolve(repo, "..")]);
  expect(unsafe.status).not.toBe(0);
  expect(unsafe.stderr).toContain("must not replace the checkout");
}, 120_000);
