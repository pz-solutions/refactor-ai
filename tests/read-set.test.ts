import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRefactorApi } from "../src/api";
import { loadBackend } from "../src/backends/load";
import { analyze } from "../src/backends/typescript";
import { createPlan, loadPlan } from "../src/core/plan";
import { applyPlan } from "../src/core/apply";
import { CompilerInputs } from "../src/backends/typescript-diagnostics-cache";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-read-set-"))); roots.push(root);
  const path = (file: string) => join(root, file);
  const write = async (file: string, text: string) => { await mkdir(dirname(path(file)), { recursive: true }); await writeFile(path(file), text); };
  await write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: "es2022", module: "esnext", moduleResolution: "bundler" }, include: ["src"] }));
  await write("src/leaf.ts", 'export const value = 1;\n');
  await write("src/middle.ts", 'export { value } from "./leaf";\n');
  await write("src/caller.ts", 'import { value } from "./middle"; export const n: number = value;\n');
  await write("e2e/unrelated.test.ts", 'export const x = 1;\n');
  const api = createRefactorApi({ loadBackend });
  const request = { root, project: path("tsconfig.json"), file: path("src/leaf.ts"), operation: "move-file" as const, target: path("src/moved/leaf.ts") };
  return { root, path, write, api, request };
}

test("serialized plans tolerate unrelated edits, additions and deletions, including during planning", async () => {
  const f = await fixture();
  const plan = await createPlan(f.request, async req => {
    const result = await analyze(req);
    await f.write("e2e/unrelated.test.ts", "external change\n");
    return result;
  });
  expect(plan.schemaVersion).toBe(3);
  expect(plan.readSet!.some(input => input.method === "readFile" && input.args[0] === f.path("src/caller.ts"))).toBe(true);
  expect(plan.readSet!.some(input => input.args[0] === f.path("e2e/unrelated.test.ts"))).toBe(false);
  await f.write("e2e/new.test.ts", "export {};\n");
  await rm(f.path("e2e/unrelated.test.ts"));
  await f.write(".refactor-ai/plan.json", JSON.stringify(plan));
  await applyPlan(await loadPlan(f.path(".refactor-ai/plan.json")));
  expect(await readFile(f.path("src/middle.ts"), "utf8")).toContain('./moved/leaf');
});

for (const [name, changed, text] of [
  ["transitive importer", "src/caller.ts", 'import { value } from "./middle"; export const n: string = value;'],
  ["config", "tsconfig.json", '{}'],
  ["new importer", "src/new.ts", 'export { value } from "./leaf";'],
  ["global generator", "src/routeTree.gen.ts", 'export {}; declare global { interface Generated { value: string } }'],
] as const) test(`a changed ${name} invalidates validation without writing`, async () => {
  const f = await fixture();
  const plan = await f.api.plan(f.request);
  await f.write(changed, text);
  await expect(f.api.apply(plan)).rejects.toThrow("STALE_PROJECT_INPUTS");
  expect(await readFile(f.path("src/leaf.ts"), "utf8")).toBe('export const value = 1;\n');
});

test("ignored declaration dependencies and negative probes remain stale guards", async () => {
  const f = await fixture();
  await f.write("node_modules/dependency/package.json", '{"types":"index.d.ts"}');
  await f.write("node_modules/dependency/index.d.ts", 'export const n: number;');
  await f.write("src/leaf.ts", 'export { n as value } from "dependency";\n');
  const plan = await f.api.plan(f.request);
  await f.write("node_modules/dependency/index.d.ts", 'export const n: string;');
  await expect(f.api.apply(plan)).rejects.toThrow("STALE_PROJECT_INPUTS");
  const inputs = new CompilerInputs(true);
  inputs.sys.fileExists(f.path("src/missing.ts"));
  const guarded = await createPlan(f.request, async () => ({ backend: "test", version: "1", readSet: inputs.snapshot(), changes: [{path:f.path("src/leaf.ts"),before:await readFile(f.path("src/leaf.ts"),"utf8"),after:'export const value = 2;\n'}],diagnosticsBefore:[],diagnosticsAfter:[],notes:[] }));
  await f.write("src/missing.ts", 'export {};');
  await expect(applyPlan(guarded)).rejects.toThrow("STALE_PROJECT_INPUTS");
});

test("an empty TS plan ignores later config/source changes and source deletion", async () => {
  const f = await fixture();
  const plan = await f.api.plan({ ...f.request, operation: "retarget-import", target: undefined, from: "absent", to: "another" });
  expect(plan.changes).toHaveLength(0);
  await f.write("tsconfig.json", "broken config"); await rm(f.path("src/leaf.ts"));
  expect(await f.api.apply(plan)).toEqual({ status: "applied", files: [], journal: null });
});

test("a compiler input changed between analysis and plan creation is rejected", async () => {
  const f = await fixture();
  await expect(createPlan(f.request, async req => {
    const result = await analyze(req);
    await f.write("src/caller.ts", 'import { value } from "./middle"; export const n: string = value;');
    return result;
  })).rejects.toThrow("STALE_PROJECT_INPUTS");
});

test("late case collisions and symlink replacements cannot bypass scoped freshness", async () => {
  const f = await fixture();
  const plan = await f.api.plan(f.request);
  await f.write("src/moved/LEAF.ts", "export {}; ");
  await expect(f.api.apply(plan)).rejects.toThrow(/STALE_PROJECT_INPUTS|STALE_SNAPSHOT/);
  await rm(f.path("src/moved/LEAF.ts"));
  await rm(f.path("src/middle.ts"));
  await symlink(f.path("src/caller.ts"), f.path("src/middle.ts"));
  await expect(f.api.apply(plan)).rejects.toThrow("SYMLINK_UNSUPPORTED");
});

test("unread content does not enter the snapshot or deterministic plan identity", async () => {
  const f = await fixture();
  const first = await f.api.plan(f.request);
  await f.write("e2e/unrelated.test.ts", "unrelated change");
  const second = await f.api.plan(f.request);
  expect(second).toEqual(first);
  expect(Object.keys(first.snapshot.files)).not.toContain("e2e/unrelated.test.ts");
});
