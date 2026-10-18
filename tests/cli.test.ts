import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { main, offset } from "../src/cli.ts";
import { operationHelp } from "../src/help.ts";

const roots: string[] = [];

beforeAll(() => {
  const built = spawnSync("bun", ["run", "build"], { cwd: join(import.meta.dir, ".."), encoding: "utf8" });
  if (built.error) throw built.error;
  if (built.status !== 0) throw new Error(built.stderr || built.stdout);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CLI", () => {
  test("shows command and operation help before reading any project or plan", () => {
    const cli = join(import.meta.dir, "..", "dist", "cli.js");
    const cases = [[], ["--help"], ["-h"], ["help"],
      ...["capabilities", "plan", "preview", "validate", "apply", "serve"].map(command => [command, "--help"]),
      ...Object.keys(operationHelp).map(operation => ["plan", operation, "--help"]),
      ["help", "plan", "rename"], ["plan", "rename", "--project", "/missing/tsconfig.json", "-h"]];
    for (const args of cases) {
      const result = spawnSync("node", [cli, ...args], { encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Examples");
    }
    const unknown = spawnSync("node", [cli, "plan", "unknown", "--help"], { encoding: "utf8" });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("UNSUPPORTED");
  }, 30_000); // Multiple Node startups can exceed Bun's 5-second default on CI.

  test("all relocated launchers show help with no assets or setup tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "refactor-ai-help-offline-"));
    roots.push(root);
    const node = Bun.which("node")!;
    for (const operation of Object.keys(operationHelp)) {
      const skill = join(root, `refactor-${operation}`);
      await mkdir(join(skill, "scripts"), { recursive: true });
      const launcher = join(skill, "scripts", "refactor.mjs");
      await cp(join(import.meta.dir, "..", "skills", `refactor-${operation}`, "scripts", "refactor.mjs"), launcher);
      for (const args of [["--help"], ["plan", operation, "--help"]]) {
        const result = spawnSync(node, [launcher, ...args], {
          cwd: skill, encoding: "utf8", env: { ...process.env, PATH: "", TMPDIR: root },
        });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("Examples");
        expect(await readdir(skill)).toEqual(["scripts"]);
        expect(await readdir(join(skill, "scripts"))).toEqual(["refactor.mjs"]);
      }
    }
  });

  test("demo and packager help do not execute work or create artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "refactor-ai-tools-help-"));
    roots.push(root);
    const demo = spawnSync(Bun.which("node")!, [join(import.meta.dir, "..", "dist", "demo.js"), "--help"], {
      cwd: root, encoding: "utf8", env: { ...process.env, PATH: "", TMPDIR: root },
    });
    expect(demo.status).toBe(0);
    expect(demo.stderr).toBe("");
    expect(await readdir(root)).toEqual([]);

    await mkdir(join(root, "scripts"));
    await cp(join(import.meta.dir, "..", "scripts", "package-skills.ts"), join(root, "scripts", "package-skills.ts"));
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { "package:skills": "bun scripts/package-skills.ts --build" } }));
    for (const args of [["scripts/package-skills.ts", "--help"], ["run", "package:skills", "--help"]]) {
      const result = spawnSync(Bun.which("bun")!, args, { cwd: root, encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Examples");
      expect((await readdir(root)).sort()).toEqual(["package.json", "scripts"]);
      expect(await readdir(join(root, "scripts"))).toEqual(["package-skills.ts"]);
    }
  });

  test("help examples for bundled TS/JS templates produce validated plans", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-help-examples-")));
    roots.push(root);
    const cli = join(import.meta.dir, "..", "dist", "cli.js");
    let index = 0;
    for (const item of Object.values(operationHelp)) {
      for (const example of item.examples.filter(example => /--project examples\/(typescript|javascript)\//.test(example))) {
        const workspace = join(root, String(index++));
        await mkdir(join(workspace, "examples"), { recursive: true });
        for (const language of ["typescript", "javascript"]) {
          await cp(join(import.meta.dir, "..", "examples", language), join(workspace, "examples", language), { recursive: true });
        }
        const planned = spawnSync("node", [cli, ...example.split(" ")], { cwd: workspace, encoding: "utf8" });
        if (planned.status !== 0) throw new Error(`${example}\n${planned.stderr}\n${planned.stdout}`);
        const response = JSON.parse(planned.stdout);
        expect(response.validation.status).toBe("passed");
        const validated = spawnSync("node", [cli, "validate", "--plan", response.plan], { cwd: workspace, encoding: "utf8" });
        expect(validated.status).toBe(0);
      }
    }
    expect(index).toBeGreaterThan(0);
  }, 60_000);

  test("maps 1-based positions to UTF-16 offsets and handles CRLF", () => {
    const text = "😀 oldName\r\nnext";
    expect(offset(text, "1:3")).toBe(2);
    expect(offset(text, "1:10")).toBe(9);
    expect(offset(text, "2:1")).toBe(12);
    expect(() => offset(text, "1:12")).toThrow("INVALID_POSITION");
  });

  test("stdio server accepts sequential plans, recovers after errors and exits on EOF", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-serve-")));
    roots.push(root);
    await writeFile(join(root, "src.ts"), "export const value = 1;\n");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, files: ["src.ts"] }));
    const plan = (name: string) => ["plan", "rename", "--project", "tsconfig.json", "--file", "src.ts", "--at", "1:14", "--name", name, "--out", join(root, ".refactor-ai", `${name}.json`)];
    const requests = [{ id: 0, args: ["apply"] }, { id: 1, args: plan("one") },
      { id: 2, args: [...plan("two"), "--root", dirname(root)] }, { id: 3, args: plan("one") }];
    const result = spawnSync("node", [join(import.meta.dir, "..", "dist/cli.js"), "serve", "--root", root], {
      input: requests.map(request => JSON.stringify(request)).join("\n") + "\n", encoding: "utf8", timeout: 20_000,
      env: { ...process.env, REFACTOR_AI_CACHE: "off" },
    });
    expect(result.status).toBe(0); expect(result.stderr).toBe("");
    const responses = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(responses.map(response => response.status)).toEqual(["failed", "ok", "failed", "ok"]);
    expect(responses[2].error).toContain("OUTSIDE_ROOT");
    expect(responses[1].output.id).toBe(responses[3].output.id);
    expect(await readFile(join(root, "src.ts"), "utf8")).toBe("export const value = 1;\n");
  }, 30_000);

  test("rejects invalid arguments and supports a no-op plan", async () => {
    await expect(main(["plan", "rename", "--bad", "value"])).rejects.toThrow("INVALID_ARGUMENT: --bad");

    const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-cli-")));
    roots.push(root);
    const file = join(root, "src.ts");
    const project = join(root, "tsconfig.json");
    await writeFile(file, "export const value = 1;\n");
    await writeFile(project, JSON.stringify({ compilerOptions: {}, include: ["src.ts"] }));
    const plan = join(root, ".refactor-ai", "plan.json");
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await main(["plan", "imports", "--project", project, "--file", file, "--mode", "sort", "--out", plan]);
    } finally {
      console.log = originalLog;
    }
    expect(await readFile(file, "utf8")).toBe("export const value = 1;\n");
    expect(JSON.parse(await readFile(plan, "utf8")).changes).toEqual([]);
    expect(logs.join("\n")).toContain('"status": "planned"');
  }, 30_000);

  test("runs built JS plan, preview, validate, and apply under Node on a temp TS project", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-cli-integration-")));
    roots.push(root);
    const file = join(root, "src.ts");
    const project = join(root, "tsconfig.json");
    const plan = join(root, ".refactor-ai", "plan.json");
    await writeFile(file, "export const oldName = 1;\r\nconsole.log(oldName);\r\n");
    await writeFile(project, JSON.stringify({ compilerOptions: { strict: true }, include: ["src.ts"] }));
    const run = (args: string[]) => spawnSync("node", [join(import.meta.dir, "..", "dist", "cli.js"), ...args], {
      cwd: root, encoding: "utf8",
    });

    const planned = run(["plan", "rename", "--project", project, "--file", file, "--at", "1:14", "--name", "newName", "--out", plan]);
    expect(planned.status).toBe(0);
    expect(planned.stdout).toContain('"status": "planned"');
    const preview = run(["preview", "--plan", plan]);
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("-export const oldName = 1;");
    expect(run(["validate", "--plan", plan]).status).toBe(0);
    expect(run(["apply", "--plan", plan]).status).toBe(0);
    expect(await readFile(file, "utf8")).toBe("export const newName = 1;\r\nconsole.log(newName);\r\n");
  }, 60_000);

  test("rejects in-project plan output before creating its parent directory", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-cli-output-")));
    roots.push(root);
    const file = join(root, "src.ts"), project = join(root, "tsconfig.json");
    await writeFile(file, "export const value = 1;\n");
    await writeFile(project, JSON.stringify({ include: ["src.ts"] }));
    const directory = join(root, "invalid-plan-dir");
    await expect(main(["plan", "format", "--project", project, "--file", file,
      "--out", join(directory, "plan.json")])).rejects.toThrow("INVALID_ARGUMENT: store plan outside");
    await expect(access(directory)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("export const value = 1;\n");
  });

  test("runs a relocated bundle with only JS and its runtime dependency", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-portable-")));
    roots.push(root);
    const toolkit = join(root, "toolkit"), projectRoot = join(root, "project");
    await mkdir(join(toolkit, "dist"), { recursive: true });
    await mkdir(join(toolkit, "node_modules"));
    await mkdir(projectRoot);
    await cp(join(import.meta.dir, "..", "dist", "cli.js"), join(toolkit, "dist", "cli.js"));
    await cp(join(import.meta.dir, "..", "node_modules", "typescript"), join(toolkit, "node_modules", "typescript"), { recursive: true });
    await writeFile(join(toolkit, "package.json"), '{"type":"module"}\n');
    const file = join(projectRoot, "source.ts"), project = join(projectRoot, "tsconfig.json");
    await writeFile(file, "export const oldName = 1;\nconsole.log(oldName);\n");
    await writeFile(project, JSON.stringify({ compilerOptions: { strict: true }, include: ["source.ts"] }));
    const cli = join(toolkit, "dist", "cli.js"), plan = join(projectRoot, ".refactor-ai", "plan.json");
    const run = (args: string[]) => spawnSync("node", [cli, ...args], { cwd: projectRoot, encoding: "utf8" });
    const planned = run(["plan", "rename", "--project", project, "--file", file, "--at", "1:14", "--name", "newName", "--out", plan]);
    expect(planned.stderr).toBe("");
    expect(planned.status).toBe(0);
    expect(await readFile(file, "utf8")).toContain("oldName");
    const native = run(["plan", "rename", "--project", project, "--file", file, "--at", "1:14", "--name", "newName", "--checker", "ts7", "--out", plan]);
    expect(native.status).toBe(1);
    expect(native.stderr).toContain("CHECKER_UNAVAILABLE");
    expect(await readFile(file, "utf8")).toContain("oldName");
    expect(run(["apply", "--plan", plan]).status).toBe(0);
    expect(await readFile(file, "utf8")).toBe("export const newName = 1;\nconsole.log(newName);\n");
  }, 30_000);
});
