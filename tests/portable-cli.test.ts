import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { npmCli } from "../src/runtime/npm.ts";
import { portablePath } from "../src/backends/typescript-paths.ts";

const repo = resolve(import.meta.dir, "..");
const node = process.platform === "win32" ? "node.exe" : "node";
let root: string;

function run(command: string, args: string[], cwd = root): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 180_000,
    env: { ...process.env, npm_config_cache: join(root, "npm-cache"), npm_config_ignore_scripts: "true" } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
const npm = (args: string[]) => run(node, [npmCli(), ...args]);

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-portable-")));
}, 180_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test("Windows drive and UNC module paths use forward slashes", () => {
  expect(portablePath("C:\\repo\\src\\Widget.ts", "\\")).toBe("C:/repo/src/Widget.ts");
  expect(portablePath("\\\\server\\share\\Widget.ts", "\\")).toBe("//server/share/Widget.ts");
});

for (const language of ["ts", "js"]) {
  test(`built Node CLI completes every supported ${language} plan workflow on native paths`, async () => {
    const cli = join(repo, "dist", "cli.js");
    for (const operation of ["rename", "imports", "format", "extract-function", "extract-variable", "rename-file", "move-type"]) {
      const project = join(root, `${language} ${operation}`), file = join(project, `Wrong.${language}`);
      await mkdir(project);
      const source = `export class Widget { id = 1; }\nexport function oldName(value${language === "ts" ? ": number" : ""}) {\n  const total = value + 1;\n  return total;\n}\nconsole.log(oldName(2), new Widget().id);\n`;
      await writeFile(file, source);
      const config = join(project, language === "ts" ? "tsconfig.json" : "jsconfig.json");
      await writeFile(config, JSON.stringify({ compilerOptions: { strict: language === "ts", allowJs: language === "js", checkJs: false, noEmit: true, target: "ES2022", module: "ESNext" }, files: [`Wrong.${language}`] }));
      const options: string[] = operation === "rename" ? ["--at", "2:17", "--name", "sum"]
        : operation === "extract-function" ? ["--at", "3:3", "--end", "4:16", "--name", "calculate"]
        : operation === "extract-variable" ? ["--at", "3:17", "--end", "3:26", "--name", "result"]
        : ["rename-file", "move-type"].includes(operation) ? ["--type", "Widget"] : [];
      if (operation === "move-type") options.push("--to", join(project, "nested", `Widget.${language}`));
      const response = JSON.parse(run(node, [cli, "plan", operation, "--project", config, "--file", file, ...options], project));
      expect(response.validation.status).toBe("passed");
      const plan = JSON.parse(await readFile(response.plan, "utf8"));
      expect(await readFile(file, "utf8")).toBe(source);
      run(node, [cli, "preview", "--plan", response.plan], project);
      expect(JSON.parse(run(node, [cli, "validate", "--plan", response.plan], project)).status).toBe("validated");
      expect(JSON.parse(run(node, [cli, "apply", "--plan", response.plan], project)).status).toBe("applied");
      if (operation === "move-type") {
        expect(await readFile(join(project, "nested", `Widget.${language}`), "utf8")).toContain("class Widget");
        expect(await readFile(file, "utf8")).toMatch(/from ["']\.\/nested\/Widget(?:\.js)?["']/);
        expect(await readFile(config, "utf8")).toContain(`nested/Widget.${language}`);
      }
      expect(plan.backend).toBe("typescript");
    }
  }, 180_000);
}

test("cross-project globs and split re-exports produce portable imports", async () => {
  const project = join(root, "cross-project");
  for (const name of ["A", "B"]) {
    await mkdir(join(project, name, "src"), { recursive: true });
    await writeFile(join(project, name, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", noEmit: true }, include: ["src/**/*.ts"], exclude: ["src/ignored"] }));
  }
  await writeFile(join(project, "A", "src", "Pair.ts"), "export class Widget {}\nexport class Other {}\n");
  await writeFile(join(project, "A", "src", "index.ts"), 'export { Widget, Other } from "./Pair";\n');
  await writeFile(join(project, "B", "src", "Anchor.ts"), "export class Anchor {}\n");
  const cli = join(repo, "dist", "cli.js");
  const response = JSON.parse(run(node, [cli, "plan", "move-type", "--root", project,
    "--project", join(project, "A", "tsconfig.json"), "--target-project", join(project, "B", "tsconfig.json"),
    "--file", join(project, "A", "src", "Pair.ts"), "--type", "Widget", "--to", join(project, "B", "src", "nested", "Widget.ts")]));
  run(node, [cli, "apply", "--plan", response.plan]);
  expect(await readFile(join(project, "A", "src", "index.ts"), "utf8")).toMatch(/from ["']\.\.\/\.\.\/B\/src\/nested\/Widget["']/);
});

test("a copied standalone skill runs through Node without the source checkout", async () => {
  const copied = join(root, "skill"), project = join(root, "skill project");
  await mkdir(project);
  await cp(join(repo, "skills", "refactor-rename-file"), copied, { recursive: true,
    filter: path => !/[\\/](node_modules|bin|obj)([\\/]|$)/.test(path) });
  const file = join(project, "Wrong.ts"), config = join(project, "tsconfig.json");
  await writeFile(file, "export class Widget {}\n");
  await writeFile(config, '{"files":["Wrong.ts"]}\n');
  const launcher = join(copied, "scripts", "refactor.mjs");
  const response = JSON.parse(run(node, [launcher, "plan", "rename-file", "--project", config, "--file", file], project));
  expect(response.validation.status).toBe("passed");
  run(node, [launcher, "apply", "--plan", response.plan], project);
  expect(await readFile(join(project, "Widget.ts"), "utf8")).toContain("class Widget");
}, 180_000);

test("a packed npm bin runs through npm exec on native paths", async () => {
  run("bun", ["run", "package:npm"], repo);
  const packed = JSON.parse(npm(["pack", join(repo, "dist", "npm", "move-type"), "--json", "--pack-destination", root]))[0];
  const project = join(root, "npm project"), file = join(project, "Pair.ts"), config = join(project, "tsconfig.json");
  await mkdir(project);
  await writeFile(file, "export class Widget {}\nexport class Other {}\n");
  await writeFile(config, '{"files":["Pair.ts"],"compilerOptions":{"noEmit":true}}\n');
  const exec = (args: string[]) => npm(["exec", "--yes", `--package=file:${join(root, packed.filename)}`, "--", "refactor-move-type", ...args]);
  const response = JSON.parse(exec(["plan", "--project", config, "--file", file, "--type", "Widget", "--to", join(project, "nested", "Widget.ts")]));
  expect(response.validation.status).toBe("passed");
  expect(JSON.parse(exec(["validate", "--plan", response.plan])).status).toBe("validated");
  exec(["apply", "--plan", response.plan]);
  expect(await readFile(join(project, "nested", "Widget.ts"), "utf8")).toContain("class Widget");
}, 180_000);
