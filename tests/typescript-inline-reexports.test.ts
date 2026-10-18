import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyze } from "../src/backends/typescript";
import { createRefactorApi } from "../src/api";
import { loadBackend } from "../src/backends/load";
import { main } from "../src/cli";
import { createPlan } from "../src/core/plan";
import type { BackendResult, RefactorRequest } from "../src/types";

const roots: string[] = [];
const config = JSON.stringify({ compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler", target: "es2022" }, include: ["src"] });
async function workspace(files: Record<string, string>, extra: Partial<RefactorRequest> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-inline-")));
  roots.push(root);
  for (const [name, contents] of Object.entries({ "tsconfig.json": config, ...files })) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), contents);
  }
  const request: RefactorRequest = { project: join(root, "tsconfig.json"), root, file: join(root, "src/shim.ts"), operation: "inline-reexports", ...extra };
  return { root, request, path: (path: string) => join(root, path), run: () => analyze(request) };
}
function after(result: Pick<BackendResult, "changes">, path: string) { return result.changes.find((change) => change.path === path)?.after; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("inline-reexports", () => {
  test("deletes pure star shims, preserves named/type aliases, updates config lists and records schema 3 reads without writes", async () => {
    const w = await workspace({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler" }, files: ["src/shim.ts", "src/origin.ts", "src/use.ts"] }),
      "src/shim.ts": '"use client";\n// public shim\nexport * from "./origin";\n',
      "src/origin.ts": 'export const a = 1; export interface Shape { id: number }\n',
      "src/use.ts": "import { a as value, type Shape } from './shim';\nimport type { Shape as S } from './shim';\nexport const result: Shape = { id: value }; export type T = S;\n",
    });
    const plan = await createPlan(w.request, analyze);
    expect(plan.schemaVersion).toBe(3);
    expect(plan.validation.status).toBe("passed");
    expect(after(plan, w.path("src/shim.ts"))).toBeNull();
    expect(after(plan, w.path("src/use.ts"))).toBe("import { a as value, type Shape } from './origin';\nimport type { Shape as S } from './origin';\nexport const result: Shape = { id: value }; export type T = S;\n");
    expect(JSON.parse(after(plan, w.path("tsconfig.json"))!).files).toEqual(["src/origin.ts", "src/use.ts"]);
    expect(await readFile(w.path("src/shim.ts"), "utf8")).toContain("export *");
  });

  test("resolves named re-export aliases for imports and re-exports", async () => {
    const w = await workspace({
      "src/shim.ts": 'export { a as b, type Shape as Form } from "./origin.js";\n',
      "src/origin.ts": 'export const a = 1; export interface Shape { id: number }\n',
      "src/use.ts": 'import { b as value } from "./shim";\nexport { b as publicValue } from "./shim";\nexport type { Form as PublicForm } from "./shim";\nexport { type Form } from "./shim";\nexport const result = value;\n',
    });
    const result = await w.run();
    expect(after(result, w.path("src/use.ts"))).toBe('import { a as value } from "./origin.js";\nexport { a as publicValue } from "./origin.js";\nexport type { Shape as PublicForm } from "./origin.js";\nexport { type Shape as Form } from "./origin.js";\nexport const result = value;\n');
  });

  test("splits mixed-module imports and retains its re-exports", async () => {
    const shim = 'export { a as b } from "./origin";\nexport const own = 2;\n';
    const w = await workspace({ "src/shim.ts": shim, "src/origin.ts": 'export const a = 1;\n',
      "src/use.ts": "import { own, b as value } from './shim';\nexport const result = own + value;\n" });
    const result = await w.run();
    expect(after(result, w.path("src/shim.ts"))).toBeUndefined();
    expect(after(result, w.path("src/use.ts"))).toBe("import { own } from './shim';\nimport { a as value } from './origin';\nexport const result = own + value;\n");
  });

  test("preserves bare workspace package entries instead of reaching into their implementation", async () => {
    const w = await workspace({
      "src/shim.ts": 'export * from "@scope/feature";\n',
      "src/use.ts": "import { a, type Shape } from './shim';\nexport const value: Shape = { id: a };\n",
      "packages/feature/package.json": JSON.stringify({ name: "@scope/feature", type: "module", exports: { ".": "./index.ts" } }),
      "packages/feature/index.ts": 'export { a, type Shape } from "./internal";\n',
      "packages/feature/internal.ts": 'export const a = 1; export interface Shape { id: number }\n',
    });
    await mkdir(w.path("node_modules/@scope"), { recursive: true });
    await symlink("../../packages/feature", w.path("node_modules/@scope/feature"));
    const result = await w.run();
    expect(after(result, w.path("src/use.ts"))).toContain("from '@scope/feature'");
    expect(after(result, w.path("src/shim.ts"))).toBeNull();
    expect(result.diagnosticsAfter).toEqual([]);
  });

  test("follows relative star/alias chains and recomputes paths in different directories", async () => {
    const w = await workspace({ "src/shim.ts": 'export * from "./barrel.js";\n',
      "src/barrel.ts": 'export { original as a } from "./lib/origin.js";\n',
      "src/lib/origin.ts": 'export const original = 1;\n',
      "src/use.ts": "import { a } from './shim';\nexport const result = a;\n",
      "src/deep/use.ts": 'import { a as value } from "../shim";\nexport const result = value;\n' });
    const result = await w.run();
    expect(after(result, w.path("src/use.ts"))).toContain("import { original as a } from './lib/origin.js';");
    expect(after(result, w.path("src/deep/use.ts"))).toContain('import { original as value } from "../lib/origin.js";');
  });

  test("handles default imports, named default aliases and default re-exports", async () => {
    const w = await workspace({ "src/shim.ts": 'export { original as default, default as Named } from "./origin";\n',
      "src/origin.ts": 'export const original = 1; export default 2;\n',
      "src/use.ts": 'import Value, { Named as Other } from "./shim";\nexport { default as Public } from "./shim";\nexport const result = Value + Other;\n' });
    const result = await w.run();
    expect(after(result, w.path("src/use.ts"))).toContain('import { original as Value, default as Other } from "./origin";');
    expect(after(result, w.path("src/use.ts"))).toContain('export { original as Public } from "./origin";');
  });

  test("keeps default-import syntax when the origin exports default", async () => {
    const w = await workspace({ "src/shim.ts": 'export { default } from "./origin";\n', "src/origin.ts": 'export default 1;\n',
      "src/use.ts": 'import Value from "./shim";\nexport const result = Value;\n' });
    expect(after(await w.run(), w.path("src/use.ts"))).toContain('import Value from "./origin";');
  });

  test("splits star re-exports of mixed/multiple origins without losing local exports", async () => {
    const w = await workspace({ "src/shim.ts": 'export * from "./origin"; export { c } from "./other"; export const own = 2;\n',
      "src/origin.ts": 'export const a = 1; export interface Shape { id: number }\n', "src/other.ts": 'export const c = 3;\n',
      "src/use.ts": 'export * from "./shim";\n', "src/types.ts": 'export type * from "./shim";\n' });
    const result = await w.run();
    expect(after(result, w.path("src/use.ts"))).toContain('export { a, type Shape } from "./origin";');
    expect(after(result, w.path("src/use.ts"))).toContain('export { c } from "./other";');
    expect(after(result, w.path("src/use.ts"))).toContain('export { own } from "./shim";');
    expect(result.diagnosticsAfter).toEqual([]);
  });

  test("rejects namespace imports from mixed shims", async () => {
    const w = await workspace({ "src/shim.ts": 'export * from "./origin"; export const own = 2;\n', "src/origin.ts": 'export const a = 1;\n',
      "src/use.ts": 'import * as ns from "./shim"; export const result = ns.a;\n' });
    await expect(w.run()).rejects.toThrow("NAMESPACE_IMPORT_UNSUPPORTED");
  });

  test("retargets namespace imports and namespace re-exports from a pure single-origin star shim", async () => {
    const w = await workspace({ "src/shim.ts": '"use client"; export * from "./origin";\n', "src/origin.ts": 'export const a = 1;\n',
      "src/use.ts": 'import * as ns from "./shim"; export * as publicNs from "./shim"; export const result = ns.a;\n' });
    const result = await w.run();
    expect(after(result, w.path("src/use.ts"))).toBe('import * as ns from "./origin"; export * as publicNs from "./origin"; export const result = ns.a;\n');
    expect(after(result, w.path("src/shim.ts"))).toBeNull();
  });

  test("rejects namespace retargeting that would expose an origin's default", async () => {
    const w = await workspace({ "src/shim.ts": 'export * from "./origin";\n', "src/origin.ts": 'export const a = 1; export default 2;\n',
      "src/use.ts": 'import * as ns from "./shim"; export const result = ns.a;\n' });
    await expect(w.run()).rejects.toThrow("NAMESPACE_IMPORT_UNSUPPORTED");
  });

  test("--keep retains pure shims", async () => {
    const w = await workspace({ "src/shim.ts": 'export * from "./origin";\n', "src/origin.ts": 'export const a = 1;\n',
      "src/use.ts": 'import { a } from "./shim"; export const result = a;\n' }, { keep: true });
    const result = await w.run();
    expect(after(result, w.path("src/shim.ts"))).toBeUndefined();
    expect(after(result, w.path("src/use.ts"))).toContain('from "./origin"');
    expect(result.notes.join("\n")).toContain("--keep");
  });

  test("retains side-effect imports with a note and keeps shims with dynamic/import-type references", async () => {
    const w = await workspace({ "src/shim.ts": 'export * from "./origin";\n', "src/origin.ts": 'export const a = 1;\n',
      "src/use.ts": 'import "./shim";\nimport { a } from "./shim";\nexport const load = () => import("./shim");\nexport type M = typeof import("./shim");\nexport const result = a;\n' });
    const result = await w.run();
    expect(after(result, w.path("src/shim.ts"))).toBeUndefined();
    expect(after(result, w.path("src/use.ts"))).toContain('import "./shim";');
    expect(after(result, w.path("src/use.ts"))).toContain('import("./shim")');
    expect(result.notes.join("\n")).toContain("side-effect import");
  });

  test("preserves CRLF, comments outside declarations, and extensionless directory imports", async () => {
    const w = await workspace({ "src/shim.ts": 'export * from "./origin";\n', "src/origin/index.ts": 'export const a = 1;\n',
      "src/deep/use.ts": "// caller\r\nimport { a } from '../shim'\r\nexport const result = a\r\n" });
    expect(after(await w.run(), w.path("src/deep/use.ts"))).toBe("// caller\r\nimport { a } from '../origin/index'\r\nexport const result = a\r\n");
  });

  test("discovers and validates disconnected callers", async () => {
    const w = await workspace({ "tsconfig.json": JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler" }, include: ["src"] }),
      "src/shim.ts": 'export * from "./origin";\n', "src/origin.ts": 'export const a = 1;\n',
      "caller/tsconfig.json": JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler" }, files: ["use.ts"] }),
      "caller/use.ts": 'import { a } from "../src/shim"; export const result = a;\n' });
    const result = await w.run();
    expect(after(result, w.path("caller/use.ts"))).toContain('from "../src/origin"');
    expect(result.notes.join("\n")).toContain("without a project reference");
  });
});


test("relative references to another package's public entry stop at that entry", async () => {
  const w = await workspace({ "src/shim.ts": 'export * from "../packages/feature/index";\n',
    "src/use.ts": 'import { a } from "./shim"; export const value = a;\n',
    "packages/feature/package.json": JSON.stringify({ name: "@scope/feature", exports: "./index.ts" }),
    "packages/feature/index.ts": 'export { a } from "./internal";\n', "packages/feature/internal.ts": 'export const a = 1;\n' });
  expect(after(await w.run(), w.path("src/use.ts"))).toContain('from "../packages/feature/index"');
});

test("resolves imported bindings exported via a local export list", async () => {
  const w = await workspace({ "src/shim.ts": 'import { a as local } from "./origin"; export { local as b };\n',
    "src/origin.ts": 'export const a = 1;\n', "src/use.ts": 'import { b } from "./shim"; export const value = b;\n' });
  const result = await w.run();
  expect(after(result, w.path("src/use.ts"))).toContain('import { a as b } from "./origin"');
  expect(after(result, w.path("src/shim.ts"))).toBeUndefined();
});

test("splits a type-only default plus named import into legal declarations", async () => {
  const w = await workspace({ "src/shim.ts": 'export type { default, Shape } from "./origin";\n',
    "src/origin.ts": 'export default class Value {} export interface Shape {}\n',
    "src/use.ts": 'import Value, { type Shape } from "./shim"; export type Result = [Value, Shape];\n' });
  const result = await w.run();
  expect(after(result, w.path("src/use.ts"))).toContain('import type Value from "./origin";\nimport { type Shape } from "./origin";');
});

test("compiler diagnostics reject unsafe star expansion conflicts without disk writes", async () => {
  const w = await workspace({ "src/shim.ts": 'export * from "./origin";\n', "src/origin.ts": 'export const a = 1;\n',
    "src/use.ts": 'export * from "./shim"; export { a } from "./origin";\n' });
  await expect(w.run()).rejects.toThrow("NEW_DIAGNOSTICS");
  expect(await readFile(w.path("src/shim.ts"), "utf8")).toContain("export *");
});

test("API/CLI keep option plans, validates, applies, and rejects unrelated options", async () => {
  const w = await workspace({ "src/shim.ts": 'export * from "./origin";\n', "src/origin.ts": 'export const a = 1;\n',
    "src/use.ts": 'import { a } from "./shim"; export const result = a;\n' });
  const api = createRefactorApi({ loadBackend, language: "typescript", operation: "inline-reexports" });
  const saved = w.path(".refactor-ai/inline.json");
  await main(["plan", "inline-reexports", "--keep", "--project", w.request.project, "--file", w.request.file, "--out", saved]);
  const plan = await api.loadPlan(saved);
  expect(plan.request.keep).toBe(true);
  expect((await api.validate(plan)).status).toBe("validated");
  expect(api.preview(plan)).toContain('from "./origin"');
  await api.apply(plan);
  expect(await readFile(w.path("src/use.ts"), "utf8")).toContain('from "./origin"');
  expect(await readFile(w.request.file, "utf8")).toContain("export *");
  await expect(main(["plan", "format", "--keep", "--project", w.request.project, "--file", w.request.file])).rejects.toThrow("keep requires inline-reexports");
  await expect(main(["plan", "inline-reexports", "--keep", "--keep", "--project", w.request.project, "--file", w.request.file])).rejects.toThrow("INVALID_ARGUMENT");
});


test("preserves inline type-only imports and keeps default type bindings separate from values", async () => {
  const w = await workspace({ "src/shim.ts": 'export type { default, Shape } from "./origin"; export { a } from "./origin";\n',
    "src/origin.ts": 'export default class Value {} export interface Shape {} export const a = 1;\n',
    "src/use.ts": 'import Value, { a, type Shape } from "./shim"; export type Result = [Value, Shape]; export const result = a;\n',
    "src/types.ts": 'import { type Shape } from "./shim"; export type T = Shape;\n' });
  const result = await w.run();
  expect(after(result, w.path("src/use.ts"))).toContain('import type Value from "./origin";\nimport { a, type Shape } from "./origin";');
  expect(after(result, w.path("src/types.ts"))).toContain('import { type Shape } from "./origin";');
});


test("recomputes relative declaration-module specifiers without a spurious .d suffix", async () => {
  const w = await workspace({ "src/shim.ts": 'export type { Shape } from "./origin";\n',
    "src/origin.d.ts": 'export interface Shape {}\n',
    "src/deep/use.ts": 'import type { Shape } from "../shim"; export type Result = Shape;\n' });
  expect(after(await w.run(), w.path("src/deep/use.ts"))).toContain('from "../origin"');
});

test("rejects dependency files even when explicitly included in the selected project", async () => {
  const w = await workspace({ "tsconfig.json": JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler" }, files: ["node_modules/feature/shim.ts"] }),
    "node_modules/feature/shim.ts": 'export * from "./origin";\n', "node_modules/feature/origin.ts": 'export const a = 1;\n' });
  w.request.file = w.path("node_modules/feature/shim.ts");
  await expect(w.run()).rejects.toThrow("OUTSIDE_PROJECT");
});
