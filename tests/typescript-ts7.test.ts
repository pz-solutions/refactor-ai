import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { Workspace } from "../src/backends/typescript-workspace";
import { assertCheckerParity } from "../src/backends/typescript-ts7";
import { createPlan } from "../src/core/plan";

const runner = resolve(import.meta.dir, "../dist/test-ts7.mjs");
const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, "helpers/ts7-runner.ts")], target: "node", external: ["typescript", "typescript7"] });
if (!built.success) throw new Error(built.logs.join("\n"));
await Bun.write(runner, built.outputs[0]);
function native(input: unknown) {
  const result = spawnSync("node", [runner, JSON.stringify(input)], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "Native runner failed");
  return JSON.parse(result.stdout);
}

const roots: string[] = [];
const options = { strict: true, target: "es2022", module: "esnext", moduleResolution: "bundler", skipLibCheck: true };
const config = (extra: object = {}) => JSON.stringify({ compilerOptions: { ...options, ...extra }, include: ["src"] });
async function fixture(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-ts7-")));
  roots.push(root);
  for (const [name, text] of Object.entries({ "tsconfig.json": config(), ...files })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text);
  }
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const corpus: { name: string; files: Record<string, string>; changes: Record<string, string | null>; errors: [string, string][] }[] = [
  { name: "two-hop re-export break", files: { "src/a.ts": "export const value = 1;", "src/b.ts": 'export { value } from "./a";', "src/c.ts": 'import { value } from "./b"; export const n: number = value;' },
    changes: { "src/a.ts": 'export const value = "bad";' }, errors: [["src/c.ts", "TS2322"]] },
  { name: "deleted and created files in a new directory", files: { "src/a.ts": "export const value = 1;", "src/b.ts": 'export { value } from "./a";' },
    changes: { "src/a.ts": null, "src/new/a.ts": 'export const value = "bad";', "src/b.ts": 'import { value } from "./new/a"; export const n: number = value;' }, errors: [["src/b.ts", "TS2322"]] },
  { name: "deleted root remains unresolved", files: { "src/a.ts": "export const value = 1;", "src/b.ts": 'export { value } from "./a";' },
    changes: { "src/a.ts": null }, errors: [["src/b.ts", "TS2307"]] },
  { name: "package exports switch", files: { "package.json": '{"name":"self","type":"module","exports":{"./value":"./src/a.ts"}}', "src/a.ts": "export const value = 1;", "src/other.ts": 'export const value = "bad";', "src/use.ts": 'import { value } from "self/value"; export const n: number = value;' },
    changes: { "package.json": '{"name":"self","type":"module","exports":{"./value":"./src/other.ts"}}' }, errors: [["src/use.ts", "TS2322"]] },
  { name: "path aliases", files: { "tsconfig.json": config({ paths: { "@/*": ["./src/*"] } }), "src/a.ts": "export const value = 1;", "src/use.ts": 'import { value } from "@/a"; export const n: number = value;' },
    changes: { "src/a.ts": 'export const value = "bad";' }, errors: [["src/use.ts", "TS2322"]] },
  { name: "JSX props", files: { "tsconfig.json": config({ jsx: "preserve" }), "src/a.tsx": 'declare global { namespace JSX { interface IntrinsicElements { item: { count: number } } } }\nexport const view = <item count={1} />;' },
    changes: { "src/a.tsx": 'declare global { namespace JSX { interface IntrinsicElements { item: { count: number } } } }\nexport const view = <item count="bad" />;' }, errors: [["src/a.tsx", "TS2322"]] },
  { name: "declaration merging", files: { "src/a.ts": "interface Model { value: number } interface Model { label: string } export const model: Model = { value: 1, label: 'ok' };" },
    changes: { "src/a.ts": "interface Model { value: number } interface Model { label: string } export const model: Model = { value: 1 };" }, errors: [["src/a.ts", "TS2741"]] },
  { name: "satisfies", files: { "src/a.ts": "export const model = { value: 1 } satisfies { value: number };" },
    changes: { "src/a.ts": 'export const model = { value: "bad" } satisfies { value: number };' }, errors: [["src/a.ts", "TS2322"]] },
  { name: "generic inference", files: { "src/a.ts": "function choose<T>(a: T, b: T): T { return a; } export const value = choose(1, 2);" },
    changes: { "src/a.ts": 'function choose<T>(a: T, b: T): T { return a; } export const value = choose(1, "bad");' }, errors: [["src/a.ts", "TS2345"]] },
  { name: "ambient augmentation outside importer closure", files: { "src/a.ts": "export {}; declare global { interface Model { value: number } }", "src/use.ts": "export const model: Model = { value: 1 };" },
    changes: { "src/a.ts": "export {}; declare global { interface Model { value: string } }" }, errors: [["src/use.ts", "TS2322"]] },
];
for (const item of corpus) test(`TS7 differential corpus: ${item.name}`, async () => {
  const root = await fixture(item.files);
  const result = native({ root, changes: item.changes });
  expect(result.after.map((item: {file: string; code: string}) => [item.file, item.code])).toEqual(item.errors.map(([path, code]) => [join(root, path), code]));
  expect(result.compared).toBe(2);
  const nativeOnly = native({ root, changes: item.changes, checker: "ts7" });
  expect(nativeOnly.after.map((item: {file: string; code: string}) => [item.file, item.code])).toEqual(item.errors.map(([path, code]) => [join(root, path), code]));
});

test("a checker mismatch rejects plan creation, including missing and duplicate errors", async () => {
  const root = await fixture({ "src/a.ts": "export const value = 1;" });
  const diagnostic = { file: join(root, "src/a.ts"), code: "TS2322", message: "bad" };
  expect(() => assertCheckerParity([diagnostic], [])).toThrow("CHECKER_MISMATCH");
  expect(() => assertCheckerParity([diagnostic], [diagnostic, diagnostic])).toThrow("CHECKER_MISMATCH");
  await expect(createPlan({ root, project: join(root, "tsconfig.json"), file: join(root, "src/a.ts"), operation: "rename", checker: "ts7" }, async () => {
    const ws = new Workspace(root, join(root, "tsconfig.json"), join(root, "tsconfig.json"), [], input => { assertCheckerParity(input.expected, [diagnostic]); return input.expected; });
    try { ws.prepareValidation()(); throw new Error("unreachable"); } finally { ws.dispose(); }
  })).rejects.toThrow("CHECKER_MISMATCH");
});

for (const checker of ["ts7", "both"] as const) for (const operation of ["rename", "move-file", "inline-reexports", "retarget-import"] as const) test(`${checker} validates actual ${operation} plans and records its identity without disk edits`, async () => {
  const root = await fixture({ "src/a.ts": "export const value = 1;", "src/shim.ts": 'export { value } from "./a";', "src/use.ts": 'import { value } from "./shim"; export const n: number = value;' });
  const plan = native({ root, project: join(root, "tsconfig.json"), file: join(root, operation === "inline-reexports" ? "src/shim.ts" : operation === "retarget-import" ? "src/use.ts" : "src/a.ts"), operation, checker,
    ...(operation === "rename" ? { at: "1:14", name: "renamed" } : {}),
    ...(operation === "move-file" ? { target: join(root, "src/new/a.ts") } : {}),
    ...(operation === "retarget-import" ? { from: "./shim", to: "./a" } : {}),
  });
  expect(plan.validation.status).toBe("passed");
  expect(plan.checker).toEqual({ name: checker, version: "7.0.2", ...(checker === "both" ? { comparedWith: "typescript@5.9.3" } : {}) });
  expect(plan.changes.length).toBeGreaterThan(0);
  expect(await readFile(join(root, "src/a.ts"), "utf8")).toBe("export const value = 1;");
});

for (const checker of ["ts7", "both"] as const) test(`${checker} identity cannot be mutated through an earlier returned plan`, async () => {
  const root = await fixture({ "src/a.ts": "export const value = 1;" });
  const plan = native({ root, project: join(root, "tsconfig.json"), file: join(root, "src/a.ts"), operation: "rename", at: "1:14", name: "renamed", checker, mutateChecker: true });
  expect(plan.checker.version).toBe("7.0.2");
});

test("an actual TS7 config incompatibility rejects the plan with a parity error", async () => {
  const root = await fixture({ "tsconfig.json": config({ target: "es5" }), "src/a.ts": "export const value = 1;" });
  expect(() => native({ root, project: join(root, "tsconfig.json"), file: join(root, "src/a.ts"), operation: "rename", at: "1:14", name: "renamed", checker: "both" })).toThrow("CHECKER_MISMATCH");
});

for (const checker of ["ts7", "both"] as const) test(`${checker} validates cross-package creates/deletes and new exports through workspace symlinks`, async () => {
  const root = await fixture({
    "tsconfig.json": JSON.stringify({ files: [] }),
    "source/tsconfig.json": config(), "target/tsconfig.json": config(), "consumer/tsconfig.json": config(),
    "source/package.json": JSON.stringify({ name: "@test/source", version: "1.0.0", type: "module", exports: { "./a": "./src/a.ts" } }),
    "target/package.json": JSON.stringify({ name: "@test/target", version: "1.0.0", type: "module", exports: { "./keep": "./src/keep.ts" } }),
    "consumer/package.json": JSON.stringify({ name: "@test/consumer", dependencies: { "@test/source": "*", "@test/target": "*" } }),
    "source/src/a.ts": "export const value = 1;", "source/src/keep.ts": "export const keep = 1;",
    "target/src/keep.ts": "export const keep = 1;",
    "consumer/src/use.ts": 'import { value } from "@test/source/a"; export const n: number = value;',
  });
  await mkdir(join(root, "node_modules/@test"), { recursive: true });
  await symlink(join(root, "source"), join(root, "node_modules/@test/source"), "dir");
  await symlink(join(root, "target"), join(root, "node_modules/@test/target"), "dir");
  const plan = native({ root, checker, operation: "move-file", project: join(root, "source/tsconfig.json"), targetProject: join(root, "target/tsconfig.json"), file: join(root, "source/src/a.ts"), target: join(root, "target/src/a.ts") });
  expect(plan.validation.status).toBe("passed");
  expect(plan.changes.find((change: {path: string}) => change.path === join(root, "consumer/src/use.ts")).after).toContain("@test/target/a");
  const manifest = plan.changes.find((change: {path: string}) => change.path === join(root, "target/package.json"));
  expect(JSON.parse(manifest.after).exports["./a"]).toBe("./src/a.ts");
  expect(await readFile(join(root, "source/src/a.ts"), "utf8")).toContain("value");
}, 30_000);
