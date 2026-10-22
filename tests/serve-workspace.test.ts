import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRefactorApi, type PlanOptions } from "../src/api";
import { loadBackend } from "../src/backends/load";
import { setWarmMode } from "../src/backends/typescript";
import type { Plan } from "../src/core/plan";

const roots: string[] = [];
afterEach(async () => {
  setWarmMode(false);
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const options = { strict: true, module: "esnext", moduleResolution: "bundler", target: "es2022", noEmit: true, skipLibCheck: true };

async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-serve-ws-")));
  roots.push(root);
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ compilerOptions: options, include: ["src"] }),
    "src/component.ts": "export const component = (): number => 42;\n",
    "src/use.ts": 'import { component } from "./component";\nexport const value = component();\n',
    "src/other.ts": "export const other = 1;\n",
    "apps/extra/tsconfig.json": JSON.stringify({ compilerOptions: options, include: ["src"] }),
    "apps/extra/src/x.ts": "export const x = 1;\n",
  };
  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), text);
  }
  const path = (file: string) => join(root, file);
  const api = createRefactorApi({ loadBackend });
  const plan = (extra: Partial<PlanOptions> = {}) => api.plan({ operation: "move-file", project: path("tsconfig.json"), root,
    file: path("src/component.ts"), target: path("src/ui/component.ts"), ...extra });
  return { root, path, api, plan };
}

const cli = join(import.meta.dir, "..", "dist/cli.js");

/** The same request planned by a fresh CLI process; warm reuse in this process must not change the plan. */
function coldId(w: { root: string; path: (file: string) => string }, verify: string): string {
  const result = spawnSync("node", [cli, "plan", "move-file", "--project", w.path("tsconfig.json"), "--root", w.root, "--file", w.path("src/component.ts"),
    "--to", w.path("src/ui/component.ts"), "--verify", verify, "--out", join(w.root, ".refactor-ai", "cold.json")], { encoding: "utf8", timeout: 60_000, env: { ...process.env, REFACTOR_AI_CACHE: "off" } });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout).id;
}

for (const verify of ["bindings", "full"] as const) {
  test(`warm workspace plans (${verify}) see changed importers, configs and texts and equal cold plans`, async () => {
    const w = await workspace();
    const plan = () => w.plan({ verify });
    setWarmMode(true);
    const after = (result: Plan, file: string) => result.changes.find(change => change.path === w.path(file))?.after;
    const first = await plan();
    expect(after(first, "src/use.ts")).toContain('"./ui/component"');
    expect(await plan()).toEqual(first);

    // A new importer appears: discovery and edits must observe it.
    await writeFile(w.path("src/other.ts"), 'import { component } from "./component";\nexport const other = component();\n');
    const second = await plan();
    expect(after(second, "src/other.ts")).toContain('"./ui/component"');
    expect(second.id).toBe(coldId(w, verify));

    // An importer in another config: discovery must include that project.
    await writeFile(w.path("apps/extra/src/x.ts"), 'import { component } from "../../../src/component";\nexport const x = component();\n');
    const third = await plan();
    expect(after(third, "apps/extra/src/x.ts")).toContain('"../../../src/ui/component"');
    expect(third.notes.join("\n")).toContain("Included apps/extra/tsconfig.json");
    expect(third.id).toBe(coldId(w, verify));

    // Same-length text change: a cached parse of the old text would still see the import.
    const original = await readFile(w.path("src/use.ts"), "utf8");
    const disabled = original.replace("import", "//port").replace("component();", "1+1+1+1+1+1;");
    expect(disabled.length).toBe(original.length);
    await writeFile(w.path("src/use.ts"), disabled);
    const fourth = await plan();
    expect(after(fourth, "src/use.ts")).toBeUndefined();
    expect(fourth.id).toBe(coldId(w, verify));

    // Config membership change.
    await writeFile(w.path("tsconfig.json"), JSON.stringify({ compilerOptions: options, include: ["src"], exclude: ["src/other.ts"] }));
    const fifth = await plan();
    expect(after(fifth, "src/other.ts")).toBeUndefined();
    expect(fifth.id).toBe(coldId(w, verify));
  }, 60_000);
}

test("serve plans workspace operations with plan IDs identical to cold CLI plans", async () => {
  const w = await workspace();
  await writeFile(w.path("src/other.ts"), 'import { component } from "./component";\nexport const other = component();\n');
  const args = (name: string, file: string, verify: string) => ["plan", "move-file", "--project", "tsconfig.json", "--file", `src/${file}.ts`, "--to", `src/moved/${file}.ts`, "--verify", verify, "--out", join(w.root, ".refactor-ai", `${name}.json`)];
  const requests = [args("a", "component", "bindings"), args("b", "other", "bindings"), args("c", "component", "full"), args("d", "use", "bindings")];
  const result = spawnSync("node", [cli, "serve", "--root", w.root], {
    input: requests.map((request, id) => JSON.stringify({ id, args: request })).join("\n") + "\n", encoding: "utf8", timeout: 60_000, cwd: w.root,
    env: { ...process.env, REFACTOR_AI_CACHE: "off" },
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  const responses = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  expect(responses.map(response => response.status)).toEqual(["ok", "ok", "ok", "ok"]);
  expect(responses.map(response => response.output.verify)).toEqual(["bindings", "bindings", "full", "bindings"]);
  for (const [index, request] of requests.entries()) {
    const coldResult = spawnSync("node", [cli, ...request.slice(0, -1), join(w.root, ".refactor-ai", `cold-${index}.json`), "--root", w.root], { encoding: "utf8", cwd: w.root, timeout: 60_000 });
    expect(coldResult.status).toBe(0);
    expect(JSON.parse(coldResult.stdout).id).toBe(responses[index].output.id);
  }
  expect(await readFile(w.path("src/component.ts"), "utf8")).toBe("export const component = (): number => 42;\n");
}, 120_000);
