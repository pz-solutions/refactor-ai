import ts from "typescript";
import { mapMoveImports } from "../src/backends/typescript-retarget-import";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { analyze, capabilities } from "../src/backends/typescript";
import { createPlan, loadPlan, preview } from "../src/core/plan";
import { applyPlan } from "../src/core/apply";
import { createRefactorApi } from "../src/api";
import { loadBackend } from "../src/backends/load";
import type { RefactorRequest } from "../src/types";

const roots: string[] = [];
const options = { strict: true, module: "esnext", moduleResolution: "bundler", target: "es2022", noEmit: true, skipLibCheck: true };
const config = (extra: object = {}) => JSON.stringify({ compilerOptions: options, include: ["src"], ...extra }, null, 2);

async function workspace(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-move-file-")));
  roots.push(root);
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), contents);
  }
  return { root, path: (file: string) => join(root, file) };
}

async function packages(extra: Record<string, string> = {}) {
  const w = await workspace({
    "package.json": '{"private":true,"workspaces":["apps/*","packages/*"]}',
    "apps/web/package.json": '{"name":"@scope/web","dependencies":{"@scope/feature":"workspace:*"}}',
    "packages/feature/package.json": '{\n  "name": "@scope/feature",\n  "exports": {\n    "./existing": "./src/existing.ts"\n  }\n}\n',
    "apps/web/tsconfig.json": config(),
    "packages/feature/tsconfig.json": config(),
    "apps/web/src/component.ts": 'export const component = () => 42;\n',
    "apps/web/src/use.ts": 'import { component } from "./component";\nexport const value = component();\n',
    "packages/feature/src/existing.ts": 'export const existing = 1;\n',
    ...extra,
  });
  await mkdir(w.path("node_modules/@scope"), { recursive: true });
  await symlink("../../packages/feature", w.path("node_modules/@scope/feature"), "dir");
  return w;
}

function request(w: { root: string; path: (file: string) => string }, extra: Partial<RefactorRequest> = {}): RefactorRequest {
  return { root: w.root, project: w.path("tsconfig.json"), file: w.path("src/component.ts"), target: w.path("src/ui/component.ts"), operation: "move-file", ...extra };
}
function packageRequest(w: Parameters<typeof request>[0], extra: Partial<RefactorRequest> = {}): RefactorRequest {
  return request(w, { project: w.path("apps/web/tsconfig.json"), targetProject: w.path("packages/feature/tsconfig.json"), file: w.path("apps/web/src/component.ts"), target: w.path("packages/feature/src/ui/component.ts"), ...extra });
}
const changed = (result: { changes: Awaited<ReturnType<typeof analyze>>["changes"] }, file: string) => result.changes.find(change => change.path === file)?.after;

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("move-file", () => {
  test("retro: a mapped dynamic import passes cross-package dependency checks", async () => {
    const w = await packages({
      "apps/web/package.json": '{"name":"@scope/web","dependencies":{"@scope/feature":"workspace:*","old-lib":"1.0.0"}}',
      "packages/feature/package.json": '{"name":"@scope/feature","dependencies":{"new-lib":"1.0.0"},"exports":{"./existing":"./src/existing.ts"}}',
      "node_modules/old-lib/package.json": '{"name":"old-lib","types":"index.d.ts"}',
      "node_modules/old-lib/index.d.ts": 'export declare const value: number;',
      "node_modules/new-lib/package.json": '{"name":"new-lib","types":"index.d.ts"}',
      "node_modules/new-lib/index.d.ts": 'export declare const value: number;',
      "apps/web/src/component.ts": 'export const component = async () => (await import("old-lib")).value;',
    });
    const plan = await createPlan(packageRequest(w, { map: { "old-lib": "new-lib" } }), analyze);
    expect(plan.validation.status).toBe("passed");
    expect(changed(plan, w.path("packages/feature/src/ui/component.ts"))).toContain('import("new-lib")');
  });

  test("retro: mapped mock dedupe retains different factories, scopes and intervening code", () => {
    const text = 'vi.doMock("old", () => 1); vi.doMock("new", () => 2); function test() { vi.doMock("new", () => 1); } vi.doMock("new", () => 1); run(); vi.doMock("new", () => 1);';
    const mapped = mapMoveImports(ts.createSourceFile("test.ts", text, ts.ScriptTarget.Latest, true), { old: "new" });
    expect(mapped.match(/vi.doMock/g)).toHaveLength(5);
    expect(mapped).not.toContain('"old"');
    const evaluated = 'vi.doMock("old", makeFactory()); vi.doMock("new", makeFactory());';
    expect(mapMoveImports(ts.createSourceFile("test.ts", evaluated, ts.ScriptTarget.Latest, true), { old: "new" }).match(/vi.doMock/g)).toHaveLength(2);
    const reset = 'vi.doMock("old", () => 1); vi.doMock("new", () => 2); vi.doMock("new", () => 1);';
    expect(mapMoveImports(ts.createSourceFile("test.ts", reset, ts.ScriptTarget.Latest, true), { old: "new" }).match(/vi.doMock/g)).toHaveLength(3);

  });

  test("retro: maps dynamic imports and deduplicates mapped mocks in the same block", () => {
    const source = ts.createSourceFile("test.ts", 'vi.doMock("next-intl", () => ({ value: 1 })); vi.doMock("use-intl", () => ({ value: 1 })); export const load = () => import("next-intl");', ts.ScriptTarget.Latest, true);
    const mapped = mapMoveImports(source, { "next-intl": "use-intl" });
    expect(mapped).not.toContain('"next-intl"');
    expect(mapped.match(/vi.doMock/g)).toHaveLength(1);
    expect(mapped).toContain('import("use-intl")');
  });

  test("retro: mock registrations alone do not require a destination dependency", async () => {
    const w = await packages({
      "apps/web/package.json": '{"name":"@scope/web","dependencies":{"@scope/feature":"workspace:*","sonner":"1.0.0"}}',
      "apps/web/src/component.ts": 'declare const vi: any; vi.doMock("sonner"); export const component = () => 42;',
    });
    const plan = await createPlan(packageRequest(w), analyze);
    expect(plan.validation.status).toBe("passed");
  });

  test("retro: mixed file/directory batches honor exclusions, report asset URLs and summarize every pair", async () => {
    const w = await workspace({
      "tsconfig.json": config(), "src/component.ts": 'export const component = 1;',
      "src/lib/value.ts": 'export const value = 1;', "src/lib/keep.ts": 'export const keep = 1;',
      "src/lib/__fixtures__/key.pem": 'fixture',
      "src/use.test.ts": 'export const fixture = new URL("./lib/__fixtures__/key.pem", import.meta.url);',
    });
    const api = createRefactorApi({ loadBackend });
    const plan = await api.plan({ project: w.path("tsconfig.json"), root: w.root, operation: "move-file", moves: [
      { file: w.path("src/component.ts"), target: w.path("src/ui/component.ts") },
      { file: w.path("src/lib"), target: w.path("src/ui/lib") },
    ], exclude: ["keep.ts"] });
    expect(plan.validation.status).toBe("passed");
    expect(plan.changes.some(change => change.path === w.path("src/lib/keep.ts"))).toBe(false);
    expect(plan.notes.join("\n")).toContain("import.meta.url");
    expect(plan.notes.join("\n")).toContain("src/component.ts -> src/ui/component.ts");
    expect(plan.notes.join("\n")).toContain("src/lib -> src/ui/lib");
    await api.apply(plan);
    expect(existsSync(w.path("src/lib/__fixtures__"))).toBe(false);
    expect(existsSync(w.path("src/lib/keep.ts"))).toBe(true);
  });

  test("batch moves are order independent, preserve interdependent imports and modes", async () => {
    const w = await packages({
      "apps/web/src/helper.ts": 'export const helper = () => 42;',
      "apps/web/src/component.ts": 'import { helper } from "./helper"; export const component = helper;',
    });
    await chmod(w.path("apps/web/src/helper.ts"), 0o755);
    const api = createRefactorApi({ loadBackend });
    const moves = [
      { file: w.path("apps/web/src/helper.ts"), target: w.path("packages/feature/src/helper.ts") },
      { file: w.path("apps/web/src/component.ts"), target: w.path("packages/feature/src/ui/component.ts") },
    ];
    const opts = { operation: "move-file" as const, project: w.path("apps/web/tsconfig.json"), targetProject: w.path("packages/feature/tsconfig.json"), root: w.root, moves };
    const plan = await api.plan(opts);
    expect(await api.plan({ ...opts, moves: [...moves].reverse() })).toEqual(plan);
    expect(changed(plan, moves[1]!.target)).toContain('"../helper"');
    expect(changed(plan, w.path("apps/web/src/use.ts"))).toContain('@scope/feature/ui/component');
    expect(plan.validation.status).toBe("passed");
    await api.apply(plan);
    expect((await stat(moves[0]!.target)).mode & 0o777).toBe(0o755);
  });


  test("selected declarations ignore imports used only by the retained preload function", async () => {
    const w = await packages({
      "apps/web/tsconfig.json": config({ compilerOptions: { ...options, baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
      "apps/web/src/component.ts": 'import { preload } from "@/server";\nimport type { Existing } from "@scope/feature/existing";\n/** filters */\nexport type Filters = Existing;\nexport type Page = { page: Filters[] };\nexport type Event = Page["page"][number];\nexport function component(filters: Filters) { return preload(filters); }\n',
      "apps/web/src/server.ts": 'export const preload = (x: unknown) => x;',
      "packages/feature/src/existing.ts": 'export interface Existing { id: string }',
      "apps/web/src/use.ts": 'import { component, type Event } from "./component"; export const value = (e: Event) => component(e);',
    });
    const plan = await createRefactorApi({ loadBackend }).plan({ ...packageRequest(w), only: ["Event", "Filters", "Page"] });
    const moved = changed(plan, w.path("packages/feature/src/ui/component.ts"))!;
    expect(moved).toContain("export type Event");
    expect(moved).toContain("/** filters */");
    expect(moved).not.toContain("preload");
    expect(changed(plan, w.path("apps/web/src/component.ts"))).toContain('from "@/server"');
    expect(changed(plan, w.path("apps/web/src/component.ts"))).toContain("export function component");
    expect(changed(plan, w.path("apps/web/src/use.ts"))).toContain("@scope/feature/ui/component");
    expect(plan.validation.status).toBe("passed");
    await applyPlan(plan);
  });

  test("pre-existing unresolved destination references are admitted after they resolve", async () => {
    const w = await packages({
      "apps/web/src/adapter.ts": 'export { component } from "@scope/feature/ui/component";',
    });
    const plan = await createPlan(packageRequest(w), analyze);
    expect(plan.validation.status).toBe("passed");
    expect(changed(plan, w.path("apps/web/src/adapter.ts"))).toBeUndefined();
    expect(plan.diagnosticsAfter).toEqual([]);
  });

  test("publishes a future destination whose only external caller was unresolved", async () => {
    const w = await packages({
      "apps/web/src/use.ts": 'export { component } from "@scope/feature/ui/component";',
    });
    const plan = await createPlan(packageRequest(w), analyze);
    expect(changed(plan, w.path("packages/feature/package.json"))).toContain('"./ui/component"');
    expect(plan.diagnosticsAfter).toEqual([]);
  });

  test("move mappings retarget mock, doMock and importActual literals simultaneously", async () => {
    const w = await packages({
      "apps/web/src/component.ts": 'import { existing } from "@scope/feature/existing"; declare const vi: any; vi.mock("@scope/feature/existing", () => ({ existing: 2 })); vi.doMock("@scope/feature/existing"); vi.importActual("@scope/feature/existing"); export const component = () => existing;',
      "packages/feature/src/alternative.ts": 'export const existing = 1;',
      "packages/feature/package.json": '{"name":"@scope/feature","exports":{"./*":"./src/*.ts"}}',
    });
    const plan = await createPlan(packageRequest(w, { map: { "@scope/feature/existing": "@scope/feature/alternative" } }), analyze);
    const moved = changed(plan, w.path("packages/feature/src/ui/component.ts"))!;
    expect(moved).toContain('vi.mock("../alternative", () => ({ existing: 2 }))');
    expect(moved).toContain('vi.doMock("../alternative")');
    expect(moved).toContain('vi.importActual("../alternative")');
  });


  test("directory exclusions keep framework adapters and server files in the source", async () => {
    const w = await packages({
      "apps/web/src/route/view.ts": 'export const view = 1;',
      "apps/web/src/route/page.ts": 'import { view } from "./view"; export const page = view;',
      "apps/web/src/route/_hooks/preload.ts": 'export const preload = 1;',
      "apps/web/src/route/next-adapter.ts": 'export { view } from "./view";',
    });
    const plan = await createRefactorApi({ loadBackend }).plan({ ...packageRequest(w), file: w.path("apps/web/src/route"), target: w.path("packages/feature/src/route"), exclude: ["**/_hooks/**", "page.ts", "*adapter*"] });
    expect(changed(plan, w.path("packages/feature/src/route/view.ts"))).toContain("view = 1");
    expect(changed(plan, w.path("apps/web/src/route/page.ts"))).toContain("@scope/feature/route/view");
    expect(changed(plan, w.path("apps/web/src/route/_hooks/preload.ts"))).toBeUndefined();
    expect(plan.changes.some(change => change.path.endsWith("route/page.ts") && change.after === null)).toBe(false);
    await applyPlan(plan);
  });

  test("batch preserves triple-slash references and nonmoving JSON resources", async () => {
    const w = await workspace({
      "tsconfig.json": config({ compilerOptions: { ...options, resolveJsonModule: true } }),
      "src/component.ts": '/// <reference path="./types.d.ts" />\nimport data from "./data.json"; export const component: Extra = data.n;',
      "src/types.d.ts": 'type Extra = number;',
      "src/data.json": '{"n":42}',
      "src/use.ts": '/// <reference path="./types.d.ts" />\nimport { component } from "./component"; export { component };',
    });
    const plan = await createRefactorApi({ loadBackend }).plan({ operation: "move-file", project: w.path("tsconfig.json"), root: w.root,
      moves: [{ file: w.path("src/component.ts"), target: w.path("src/ui/component.ts") }, { file: w.path("src/types.d.ts"), target: w.path("src/ui/types.d.ts") }] });
    expect(changed(plan, w.path("src/use.ts"))).toContain('path="./ui/types.d.ts"');
    expect(changed(plan, w.path("src/ui/component.ts"))).toContain('path="./types.d.ts"');
    expect(changed(plan, w.path("src/ui/component.ts"))).toContain('"../data.json"');
  });

  test("selected moves reject silent alias rebinding and support nonadjacent declarations", async () => {
    const w = await packages({
      "apps/web/tsconfig.json": config({ compilerOptions: { ...options, baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
      "packages/feature/tsconfig.json": config({ compilerOptions: { ...options, baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
      "apps/web/src/component.ts": 'import type { Model } from "@/model"; export interface A { model: Model } export function component() { return 1; } export type B = A;',
      "apps/web/src/model.ts": 'export interface Model { id: string }',
      "packages/feature/src/model.ts": 'export interface Model { id: string }',
    });
    await expect(createPlan(packageRequest(w, { only: ["A", "B"] }), analyze)).rejects.toThrow(/REFERENCES_NOT_PRESERVED|PROJECT_DEPENDENCY_CYCLE/);
    await writeFile(w.path("apps/web/src/component.ts"), 'export interface A { id: string } export function component() { return 1; } export type B = A;');
    const plan = await createPlan(packageRequest(w, { only: ["B", "A"] }), analyze);
    expect(changed(plan, w.path("packages/feature/src/ui/component.ts"))).toContain("export type B");
    expect(changed(plan, w.path("apps/web/src/component.ts"))).toContain("function component");
    expect(plan.validation.status).toBe("passed");
  });

  test("named module maps preserve local JSX bindings and public export names", async () => {
    const w = await workspace({
      "tsconfig.json": config({ compilerOptions: { ...options, jsx: "preserve" } }),
      "src/component.tsx": 'import { OldProvider, other } from "./old"; export { OldProvider } from "./old"; export const view = <OldProvider n={other} />;',
      "src/old.ts": 'export function OldProvider(props: { n: number }) { return null; } export const other = 1;',
      "src/new.ts": 'export function Provider(props: { n: number }) { return null; } export const other = 1;',
    });
    const plan = await createPlan(request(w, { file: w.path("src/component.tsx"), target: w.path("src/ui/component.tsx"), map: { "./old": "./new", "./old#OldProvider": "./new#Provider" } }), analyze);
    const moved = changed(plan, w.path("src/ui/component.tsx"))!;
    expect(moved).toContain("Provider as OldProvider");
    expect(moved).toContain("<OldProvider n={other}");
    expect(moved).not.toContain('"../old"');
    expect(plan.validation.status).toBe("passed");
  });

  test("--mocks add keeps source mocks and adds mapped registrations in unmoved consumers", async () => {
    const w = await workspace({
      "tsconfig.json": config(),
      "src/component.ts": 'import { n } from "./old"; export const component = n;',
      "src/old.ts": 'export const n = 1;',
      "src/new.ts": 'export const n = 2;',
      "src/use.test.ts": 'declare const vi: any; vi.mock("./old", () => ({ n: 3 })); import { component } from "./component"; export { component };',
    });
    const plan = await createRefactorApi({ loadBackend }).plan({ ...request(w), map: { "./old": "./new" }, mocks: "add" });
    const text = changed(plan, w.path("src/use.test.ts"))!;
    expect(text).toContain('vi.mock("./old", () => ({ n: 3 }))');
    expect(text).toContain('vi.mock("./new", () => ({ n: 3 }))');
    expect(plan.validation.status).toBe("passed");
  });

  test("batch rejects duplicate sources and destinations", async () => {
    const w = await packages();
    const pair = { file: w.path("apps/web/src/component.ts"), target: w.path("packages/feature/src/component.ts") };
    await expect(createRefactorApi({ loadBackend }).plan({ operation: "move-file", project: w.path("apps/web/tsconfig.json"), root: w.root,
      targetProject: w.path("packages/feature/tsconfig.json"), moves: [pair, pair] })).rejects.toThrow("unique");
  });

  test("advertises the operation and moves functions with imports, BOM and CRLF without writing", async () => {
    const w = await workspace({
      "tsconfig.json": config(),
      "src/component.ts": '\uFEFFimport { helper } from "./helper";\r\nexport const component = () => helper();\r\n',
      "src/helper.ts": 'export const helper = () => 42;\n',
      "src/use.ts": 'import { component } from "./component.js";\nexport const value = component();\n',
    });
    expect(capabilities.map(item => item.operation)).toContain("move-file");
    const result = await analyze(request(w));
    expect(changed(result, w.path("src/ui/component.ts"))).toContain('from "../helper";\r\n');
    expect(changed(result, w.path("src/ui/component.ts"))?.startsWith("\uFEFF")).toBe(true);
    expect(changed(result, w.path("src/use.ts"))).toContain('"./ui/component.js"');
    expect(changed(result, w.path("src/component.ts"))).toBeNull();
    expect(existsSync(w.path("src/ui"))).toBe(false);
  });

  test("maps moved imports in the same plan with caller rewrites", async () => {
    const w = await packages({
      "apps/web/tsconfig.json": config({ compilerOptions: { ...options, baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
      "apps/web/src/component.ts": 'import { existing, local } from "@/helpers"; export const component = () => existing + local;\n',
      "apps/web/src/helpers.ts": 'export const existing = 1; export const local = 2;',
      "packages/feature/src/existing.ts": 'export const existing = 1; export const local = 2;',
    });
    const api = createRefactorApi({ loadBackend });
    const plan = await api.plan({ ...packageRequest(w), map: { "@/helpers": "@scope/feature/existing" } });
    expect(plan.validation.status).toBe("passed");
    expect(changed(plan, w.path("packages/feature/src/ui/component.ts"))).toContain('../existing');
    expect(changed(plan, w.path("apps/web/src/helpers.ts"))).toBeUndefined();
    expect(changed(plan, w.path("apps/web/src/use.ts"))).toContain('@scope/feature/ui/component');
  });

  test("module-map selection helper preserves comments, type imports and explicit aliases", async () => {
    const w = await workspace({
      "tsconfig.json": config(),
      "src/component.ts": '"use client";\nimport { /* selected */ a as value, b } from "./old";\nimport type { Options } from "./old";\nexport { a as publicValue, b as keep } from "./old";\nexport const component = (o: Options) => value + b + o.count;\n',
      "src/old.ts": 'export const a = 1, b = 2; export interface Options { count: number }',
      "src/new.ts": 'export const a = 3; export interface Options { count: number }',
    });
    const text = mapMoveImports(ts.createSourceFile(w.path("src/component.ts"), await readFile(w.path("src/component.ts"), "utf8"), ts.ScriptTarget.Latest, true), { "./old": "./new" }, ["a", "Options"]);
    expect(text).toContain('"use client"');
    expect(text).toContain('/* selected */ a as value');
    expect(text).toContain('from "./new"');
    expect(text).toContain('b } from "./old"');
    expect(text).toContain('a as publicValue');
    expect(text).toContain('import type { Options }');
  });

  test("directory module maps are simultaneous, repeatable, scoped to moved files and reject wildcard/default selection", async () => {
    const w = await workspace({
      "tsconfig.json": config(),
      "src/components/component.ts": 'import { x } from "../a"; import { y } from "../b"; export const component = x + y;',
      "src/outside.ts": 'import { x } from "./a"; export { x };',
      "src/a.ts": 'export const x = 1, y = 2; export default x;',
      "src/b.ts": 'export const x = 3, y = 4;',
    });
    const req = request(w, { file: w.path("src/components"), target: w.path("src/ui/components"), map: { "../a": "../b", "../b": "../a" } });
    const first = await createPlan(req, analyze), second = await createPlan(req, analyze);
    expect(second).toEqual(first);
    expect(changed(first, w.path("src/ui/components/component.ts"))).toContain('"../../b"');
    expect(changed(first, w.path("src/ui/components/component.ts"))).toContain('"../../a"');
    expect(changed(first, w.path("src/outside.ts"))).toBeUndefined();
    await expect(analyze({ ...req, map: { "../*": "../b" } })).rejects.toThrow("UNSUPPORTED_SPECIFIER");
    await writeFile(w.path("src/components/component.ts"), 'import value from "../a"; export const component = value;');
    await expect(analyze({ ...req, map: { "../a": "../b" }, only: ["x"] })).rejects.toThrow("UNSUPPORTED_SELECTION");
  });

  test("workspace equivalents map declared alternatives and allow overrides", async () => {
    const w = await packages({
      ".refactor-ai/equivalents.json": '{"next-intl":"use-intl"}',
      "apps/web/package.json": '{"name":"@scope/web","dependencies":{"@scope/feature":"workspace:*","next-intl":"^4"}}',
      "packages/feature/package.json": '{"name":"@scope/feature","exports":{"./existing":"./src/existing.ts"},"dependencies":{"use-intl":"^4"}}',
      "apps/web/src/component.ts": 'import { useTranslations, frameworkOnly } from "next-intl"; export const component = useTranslations() + frameworkOnly;',
      "apps/web/node_modules/next-intl/package.json": '{"name":"next-intl","types":"index.d.ts"}',
      "apps/web/node_modules/next-intl/index.d.ts": 'export function useTranslations(): number; export const frameworkOnly: number;',
      "packages/feature/node_modules/use-intl/package.json": '{"name":"use-intl","types":"index.d.ts"}',
      "packages/feature/node_modules/use-intl/index.d.ts": 'export function useTranslations(): number; export const frameworkOnly: number;',
    });
    const plan = await createPlan(packageRequest(w), analyze);
    expect(changed(plan, w.path("packages/feature/src/ui/component.ts"))).toContain('from "use-intl"');
    expect(plan.readSet!.some(input => input.args[0] === w.path(".refactor-ai/equivalents.json"))).toBe(true);
    await expect(analyze(packageRequest(w, { only: ["useTranslations"] }))).rejects.toThrow("UNSUPPORTED_SELECTION");
    await expect(analyze(packageRequest(w, { map: { "next-intl": "@scope/feature/existing" } }))).rejects.toThrow("NEW_DIAGNOSTICS");
    await writeFile(w.path("packages/feature/package.json"), '{"name":"@scope/feature","exports":{"./existing":"./src/existing.ts"}}');
    await expect(analyze(packageRequest(w))).rejects.toThrow("add next-intl@^4");
    await writeFile(w.path(".refactor-ai/equivalents.json"), '{"next-intl":null}');
    await expect(analyze(packageRequest(w))).rejects.toThrow("INVALID_EQUIVALENTS");
  });

  test("directory API plans preserve nested layout and assets, apply once, and retain individual file modes", async () => {
    const w = await workspace({
      "tsconfig.json": config(),
      "src/components/index.ts": 'export { component } from "./nested/component";\n',
      "src/components/nested/component.ts": 'import { helper } from "../../helper";\nexport const component = helper;\n',
      "src/components/README.md": '# Components\n',
      "src/helper.ts": 'export const helper = 42;\n',
      "src/use.ts": 'export { component } from "./components";\n',
    });
    await chmod(w.path("src/components/README.md"), 0o640);
    await chmod(w.path("src/components/nested/component.ts"), 0o750);
    const api = createRefactorApi({ loadBackend });
    const plan = await api.plan({ ...request(w, { file: w.path("src/components"), target: w.path("src/ui/components") }) });
    expect(plan.schemaVersion).toBe(3);
    expect(plan.validation.status).toBe("passed");
    expect(preview(plan)).toContain("README.md");
    expect(changed(plan, w.path("src/ui/components/nested/component.ts"))).toContain('"../../../helper"');
    const saved = w.path(".refactor-ai/move.json");
    await mkdir(dirname(saved), { recursive: true }); await writeFile(saved, JSON.stringify(plan));
    await applyPlan(await loadPlan(saved));
    expect(await readFile(w.path("src/ui/components/README.md"), "utf8")).toBe("# Components\n");
    expect(existsSync(w.path("src/components/index.ts"))).toBe(false);
    if (process.platform !== "win32") {
      expect((await stat(w.path("src/ui/components/README.md"))).mode & 0o777).toBe(0o640);
      expect((await stat(w.path("src/ui/components/nested/component.ts"))).mode & 0o777).toBe(0o750);
    }
    await expect(applyPlan(plan)).rejects.toThrow("STALE_SNAPSHOT");
  });

  test("directory moves retain JSON module extensions", async () => {
    const w = await workspace({
      "tsconfig.json": config({ compilerOptions: { ...options, resolveJsonModule: true } }),
      "src/components/data.json": '{"value":42}',
      "src/components/a.ts": 'import { value } from "./data.json"; export { value };',
      "src/use.ts": 'export { value } from "./components/a";',
    });
    const result = await analyze(request(w, { file: w.path("src/components"), target: w.path("src/ui/components") }));
    expect(changed(result, w.path("src/ui/components/a.ts"))).toContain('"./data.json"');
    expect(changed(result, w.path("src/ui/components/data.json"))).toBe('{"value":42}');
  });

  test("cross-package imports use a newly planned exact export through a workspace symlink", async () => {
    const w = await packages();
    const plan = await createPlan(packageRequest(w), analyze);
    expect(plan.validation.status).toBe("passed");
    expect(plan.changes.find(change => change.path === w.path("apps/web/src/use.ts"))?.after).toContain('"@scope/feature/ui/component"');
    expect(plan.changes.find(change => change.path === w.path("packages/feature/package.json"))?.after).toBe('{\n  "name": "@scope/feature",\n  "exports": {\n    "./existing": "./src/existing.ts",\n    "./ui/component": "./src/ui/component.ts"\n  }\n}\n');
    expect(await readFile(w.path("packages/feature/package.json"), "utf8")).not.toContain("ui/component");
    await applyPlan(plan);
    expect(existsSync(w.path("apps/web/src/component.ts"))).toBe(false);
    expect(await readFile(w.path("packages/feature/src/ui/component.ts"), "utf8")).toContain("component");
  });

  test("rewrites test-runner module mocks that name a moved module", async () => {
    const w = await packages({
      "apps/web/src/use.test.ts": 'declare const vi: { mock(path: string, factory?: () => unknown): void; doMock(path: string): void };\nvi.mock("./component", () => ({ component: () => 0 }));\nvi.doMock("./component");\nimport { value } from "./use";\nexport const seen = value;\n',
    });
    const result = await analyze(packageRequest(w));
    const test = changed(result, w.path("apps/web/src/use.test.ts"));
    expect(test).toContain('vi.mock("@scope/feature/ui/component", () => ({ component: () => 0 }));');
    expect(test).toContain('vi.doMock("@scope/feature/ui/component");');
  });

  test("publishes a moved directory's index module under the directory key", async () => {
    const w = await packages({
      "apps/web/src/hooks/index.ts": 'export { hook } from "./hook";\n',
      "apps/web/src/hooks/hook.ts": "export const hook = () => 1;\n",
      "apps/web/src/use.ts": 'import { hook } from "./hooks";\nexport const value = hook();\n',
    });
    const result = await analyze(packageRequest(w, { file: w.path("apps/web/src/hooks"), target: w.path("packages/feature/src/ui") }));
    expect(changed(result, w.path("packages/feature/package.json"))).toContain('"./ui": "./src/ui/index.ts"');
    expect(changed(result, w.path("apps/web/src/use.ts"))).toContain('"@scope/feature/ui"');
  });

  test("adds .tsx export targets for whole component modules", async () => {
    const w = await packages({
      "apps/web/tsconfig.json": config({ compilerOptions: { ...options, jsx: "preserve", allowImportingTsExtensions: true } }),
      "packages/feature/tsconfig.json": config({ compilerOptions: { ...options, jsx: "preserve", allowImportingTsExtensions: true } }),
      "apps/web/src/component.ts": "export const original = 1;",
      "apps/web/src/use.ts": 'import { component } from "./view"; export const value = component();',
      "apps/web/src/view.tsx": "export const component = () => null;",
    });
    const result = await analyze(packageRequest(w, { file: w.path("apps/web/src/view.tsx"), target: w.path("packages/feature/src/ui/view.tsx") }));
    expect(changed(result, w.path("packages/feature/package.json"))).toContain('"./ui/view": "./src/ui/view.tsx"');
    expect(changed(result, w.path("apps/web/src/use.ts"))).toContain('"@scope/feature/ui/view"');
  });

  for (const exports of [
    { "./widget": "./src/ui/component.ts" },
    { "./ui/*": "./src/ui/*.ts" },
    { "./*": { types: "./src/*.ts", default: "./src/*.ts" } },
  ]) test(`reuses exact or wildcard exports ${JSON.stringify(exports)}`, async () => {
    const w = await packages({ "packages/feature/package.json": JSON.stringify({ name: "@scope/feature", exports }) });
    const result = await analyze(packageRequest(w));
    expect(changed(result, w.path("packages/feature/package.json"))).toBeUndefined();
    expect(changed(result, w.path("apps/web/src/use.ts"))).toContain(`"@scope/feature/${"./widget" in exports ? "widget" : "ui/component"}"`);
  });

  test("selects an export whose active compiler conditions resolve to the moved file", async () => {
    const w = await packages({ "packages/feature/package.json": JSON.stringify({ name: "@scope/feature", exports: {
      "./a": { browser: "./src/ui/component.ts", default: "./src/existing.ts" },
      "./valid": "./src/ui/component.ts",
    } }) });
    const result = await analyze(packageRequest(w));
    expect(changed(result, w.path("apps/web/src/use.ts"))).toContain('"@scope/feature/valid"');
    expect(changed(result, w.path("packages/feature/package.json"))).toBeUndefined();
  });

  test("alias importers and aliases between moved files become package and relative specifiers", async () => {
    const w = await packages({
      "apps/web/tsconfig.json": config({ compilerOptions: { ...options, paths: { "@/*": ["./src/*"] } } }),
      "apps/web/src/component.ts": 'export const unused = 1;\n',
      "apps/web/src/use.ts": 'import { component } from "@/components/component";\nexport const lazy = () => import("@/components/component");\nexport { component };\n',
      "apps/web/src/components/component.ts": 'import { helper } from "@/components/nested/helper";\nexport const component = helper;\n',
      "apps/web/src/components/nested/helper.ts": 'export const helper = 42;\n',
      "apps/web/src/components/README.md": '# Moving\n',
    });
    const result = await analyze(packageRequest(w, { file: w.path("apps/web/src/components"), target: w.path("packages/feature/src/components") }));
    expect(changed(result, w.path("packages/feature/src/components/component.ts"))).toContain('"./nested/helper"');
    expect(changed(result, w.path("apps/web/src/use.ts"))).toContain('"@scope/feature/components/component"');
    expect(changed(result, w.path("apps/web/src/use.ts"))?.match(/@scope\/feature\/components\/component/g)).toHaveLength(2);
  });

  test("unmoved aliases fail before program construction with an actionable hint", async () => {
    const w = await packages({
      "apps/web/tsconfig.json": config({ compilerOptions: { ...options, paths: { "@/*": ["./src/*"] } } }),
      "apps/web/src/component.ts": 'import { helper } from "@/helper";\nexport const component = () => helper;\n',
      "apps/web/src/helper.ts": 'export const helper = 42;\n',
    });
    await expect(analyze(packageRequest(w))).rejects.toThrow(/MOVE_IMPORT_UNRESOLVED:.*@\/helper.*retarget the alias/s);
  });

  test("fails with MISSING_DEPENDENCY", async () => {
    const w = await packages({ "apps/web/package.json": '{"name":"@scope/web"}' });
    await expect(analyze(packageRequest(w))).rejects.toThrow("MISSING_DEPENDENCY");
  });

  test("prechecks third-party dependencies with the source version and install hint", async () => {
    const w = await packages({
      "apps/web/package.json": '{"name":"@scope/web","dependencies":{"@scope/feature":"workspace:*","external":"^2.3.0"}}',
      "apps/web/src/component.ts": 'import { value } from "external"; export const component = value;\n',
      "apps/web/node_modules/external/package.json": '{"types":"index.d.ts"}',
      "apps/web/node_modules/external/index.d.ts": 'export const value: number;\n',
    });
    await expect(analyze(packageRequest(w))).rejects.toThrow(/MISSING_DEPENDENCY:.*external.*\^2.3.0.*node_modules is missing/s);
  });

  test("prechecks an installed source dependency missing from the destination installation", async () => {
    const w = await packages({
      "apps/web/package.json": '{"name":"@scope/web","dependencies":{"@scope/feature":"workspace:*","external":"1"}}',
      "packages/feature/package.json": '{"name":"@scope/feature","dependencies":{"external":"1"},"exports":{"./existing":"./src/existing.ts"}}',
      "apps/web/src/component.ts": 'import { value } from "external"; export const component = value;\n',
      "apps/web/node_modules/external/package.json": '{"types":"index.d.ts"}',
      "apps/web/node_modules/external/index.d.ts": 'export const value: number;\n',
    });
    await expect(analyze(packageRequest(w))).rejects.toThrow(/MOVE_IMPORT_UNRESOLVED:.*external.*install.*node_modules is missing/s);
  });

  test("prechecks a declared source dependency even before either package is installed", async () => {
    const w = await packages({
      "apps/web/package.json": '{"name":"@scope/web","dependencies":{"fuse.js":"^7.1.0"}}',
      "apps/web/src/component.ts": 'import Fuse from "fuse.js"; export const component = new Fuse([]);\n',
    });
    await expect(analyze(packageRequest(w))).rejects.toThrow(/MISSING_DEPENDENCY:.*add fuse\.js@\^7\.1\.0 to .*packages\/feature\/package.json.*node_modules is missing/s);
  });

  test("allowImportingTsExtensions may differ when the planned imports do not need it", async () => {
    const w = await packages({
      "apps/web/tsconfig.json": config({ compilerOptions: { ...options, allowImportingTsExtensions: true } }),
    });
    const result = await analyze(packageRequest(w));
    expect(result.diagnosticsAfter).toEqual([]);
    expect(changed(result, w.path("packages/feature/src/ui/component.ts"))).toContain("component");
  });

  test("participant validation still rejects a newly invalid .ts extension", async () => {
    const w = await packages({
      "apps/web/tsconfig.json": config({ compilerOptions: { ...options, allowImportingTsExtensions: true } }),
      "apps/web/src/component.ts": 'import { existing } from "@scope/feature/existing"; export const component = existing;\n',
      "packages/feature/src/style.ts": 'export { existing } from "./existing.ts";\n',
    });
    await expect(analyze(packageRequest(w))).rejects.toThrow(/NEW_DIAGNOSTICS:.*TS5097/s);
  });

  test("requires an exports field", async () => {
    const w = await packages({ "packages/feature/package.json": '{"name":"@scope/feature"}' });
    await expect(analyze(packageRequest(w))).rejects.toThrow("PACKAGE_EXPORTS_REQUIRED");
  });

  for (const directory of [false, true]) test(`rejects ${directory ? "directory" : "file"} destination collisions`, async () => {
    const w = await workspace({ "tsconfig.json": config(), "src/component.ts": 'export const component = 1;', "src/ui/component.ts": 'export const keep = 2;', "destination/component.ts": "keep" });
    await expect(analyze(request(w, directory ? { file: w.path("src/ui"), target: w.path("destination") } : {}))).rejects.toThrow("TARGET_EXISTS");
  });

  test("directory moves update adjacent entries in explicit source and target files lists", async () => {
    const w = await packages({
      "apps/web/tsconfig.json": config({ files: ["src/components/a.ts", "src/components/b.ts", "src/use.ts"], include: [] }),
      "apps/web/src/use.ts": "export const keep = 1;",
      "apps/web/src/components/a.ts": "export const a = 1;",
      "apps/web/src/components/b.ts": "export const b = 2;",
      "packages/feature/tsconfig.json": config({ files: ["src/existing.ts"], include: [] }),
    });
    const result = await analyze(packageRequest(w, { file: w.path("apps/web/src/components"), target: w.path("packages/feature/src/components") }));
    expect(JSON.parse(changed(result, w.path("apps/web/tsconfig.json"))!).files).toEqual(["src/use.ts"]);
    expect(JSON.parse(changed(result, w.path("packages/feature/tsconfig.json"))!).files).toEqual(["src/existing.ts", "src/components/a.ts", "src/components/b.ts"]);
  });

  test("directory moves retarget literal include directories", async () => {
    const w = await workspace({ "tsconfig.json": config({ include: ["src/components"] }), "src/components/a.ts": "export const a = 1;" });
    const result = await analyze(request(w, { file: w.path("src/components"), target: w.path("lib/components") }));
    expect(JSON.parse(changed(result, w.path("tsconfig.json"))!).include).toEqual(["lib/components"]);
  });

  test("existing destination directories retain unrelated files", async () => {
    const w = await workspace({ "tsconfig.json": config(), "src/old/a.ts": "export const a = 1;", "src/new/keep.ts": "export const keep = 2;" });
    const result = await analyze(request(w, { file: w.path("src/old"), target: w.path("src/new") }));
    expect(changed(result, w.path("src/new/a.ts"))).toBe("export const a = 1;");
    expect(changed(result, w.path("src/new/keep.ts"))).toBeUndefined();
  });

  test("same-package imports follow the destination package's .js extension style", async () => {
    const w = await packages({
      "apps/web/src/use.ts": "export const keep = 1;",
      "apps/web/src/components/a.ts": 'export { b } from "./b";',
      "apps/web/src/components/b.ts": 'export const b = 1;',
      "packages/feature/src/existing.ts": 'export { keep } from "./keep.js";',
      "packages/feature/src/keep.ts": 'export const keep = 1;',
    });
    const result = await analyze(packageRequest(w, { file: w.path("apps/web/src/components"), target: w.path("packages/feature/src/components") }));
    expect(changed(result, w.path("packages/feature/src/components/a.ts"))).toContain('"./b.js"');
    expect(changed(result, w.path("packages/feature/package.json"))).toBeUndefined();
  });

  for (const samePackage of [false, true]) test(`moved files replace destination package self-imports (${samePackage ? "within" : "across"} packages)`, async () => {
    const w = await packages({
      "apps/web/src/component.ts": 'import { existing } from "@scope/feature/existing"; export const component = () => existing;',
      "packages/feature/src/component.ts": 'import { existing } from "@scope/feature/existing"; export const component = () => existing;',
      "packages/feature/src/unrelated.ts": 'export { existing } from "@scope/feature/existing";',
      "packages/feature/src/existing.ts": 'export { keep as existing } from "./keep.js";',
      "packages/feature/src/keep.ts": 'export const keep = 1;',
    });
    const result = await analyze(packageRequest(w, samePackage ? {
      project: w.path("packages/feature/tsconfig.json"), file: w.path("packages/feature/src/component.ts"),
    } : {}));
    expect(changed(result, w.path("packages/feature/src/ui/component.ts"))).toContain('"../existing.js"');
    expect(changed(result, w.path("packages/feature/src/unrelated.ts"))).toBeUndefined();
  });

  test("directory moves carry nearest suppression entries and retain sorted JSON keys", async () => {
    const entry = { complexity: { count: 2 } };
    const w = await workspace({
      "tsconfig.json": config(), "src/old/a.ts": "export const a = 1;", "src/old/b.ts": "export const b = 2;",
      "eslint-suppressions.json": JSON.stringify({ "src/old/a.ts": entry, "src/old/b.ts": entry, "src/z.ts": entry }),
      "src/eslint-suppressions.json": JSON.stringify({ "old/a.ts": entry, "old/b.ts": entry, "z.ts": entry }),
    });
    const plan = await createPlan(request(w, { file: w.path("src/old"), target: w.path("src/new") }), analyze);
    expect(changed(plan, w.path("src/eslint-suppressions.json"))).toBe(JSON.stringify({ "new/a.ts": entry, "new/b.ts": entry, "z.ts": entry }, null, 2) + "\n");
    expect(changed(plan, w.path("eslint-suppressions.json"))).toBeUndefined();
    expect(plan.notes.join(" ")).toContain("old/a.ts -> src/eslint-suppressions.json:new/a.ts");
    expect(plan.notes.join(" ")).toContain("old/b.ts -> src/eslint-suppressions.json:new/b.ts");
    await applyPlan(plan);
    expect(JSON.parse(await readFile(w.path("src/eslint-suppressions.json"), "utf8"))["new/a.ts"]).toEqual(entry);
  });

  for (const merge of [false, true]) test(`cross-package suppression transfers ${merge ? "merge counts" : "append keys"} in unsorted ledgers`, async () => {
    const w = await packages({
      "apps/web/eslint-suppressions.json": JSON.stringify({ "src/component.ts": { complexity: { count: 2 }, "no-console": { count: 1 } } }),
      "packages/feature/eslint-suppressions.json": JSON.stringify({
        "src/z.ts": {}, "src/a.ts": {}, ...(merge ? { "src/ui/component.ts": { complexity: { count: 3 } } } : {}),
      }),
      "apps/web/src/other.ts": "export const other = 1;",
    });
    const result = await analyze(packageRequest(w));
    expect(changed(result, w.path("apps/web/eslint-suppressions.json"))).toBe("{}\n");
    const after = changed(result, w.path("packages/feature/eslint-suppressions.json"))!;
    expect(Object.keys(JSON.parse(after))).toEqual(["src/z.ts", "src/a.ts", "src/ui/component.ts"]);
    expect(JSON.parse(after)["src/ui/component.ts"]).toEqual({ complexity: { count: merge ? 5 : 2 }, "no-console": { count: 1 } });
  });

  for (const eslint of [false, true]) test(`cross-package suppressions ${eslint ? "create a configured package ledger" : "drop with a review note without ESLint"}`, async () => {
    const entry = { complexity: { count: 2 } };
    const w = await packages({
      "apps/web/eslint-suppressions.json": JSON.stringify({ "src/component.ts": entry }),
      ...(eslint ? { "packages/feature/eslint.config.mjs": "export default [];" } : {}),
    });
    await chmod(w.path("apps/web/src/component.ts"), 0o750);
    const result = await createPlan(packageRequest(w), analyze);
    expect(changed(result, w.path("apps/web/eslint-suppressions.json"))).toBe("{}\n");
    expect(changed(result, w.path("packages/feature/eslint-suppressions.json"))).toBe(eslint ? JSON.stringify({ "src/ui/component.ts": entry }, null, 2) + "\n" : undefined);
    expect(result.notes.join(" ")).toContain(eslint ? "Moved ESLint suppressions" : "Dropped ESLint suppressions");
    if (!eslint) expect(result.notes.join(" ")).toContain("review suppressions");
    expect(existsSync(w.path("packages/feature/eslint-suppressions.json"))).toBe(false);
    await applyPlan(result);
    if (eslint) {
      expect(JSON.parse(await readFile(w.path("packages/feature/eslint-suppressions.json"), "utf8"))).toEqual({ "src/ui/component.ts": entry });
      if (process.platform !== "win32") expect((await stat(w.path("packages/feature/eslint-suppressions.json"))).mode & 0o777).toBe(0o600);
    }
  });

  test("rejects malformed suppression ledgers", async () => {
    const w = await packages({ "apps/web/eslint-suppressions.json": '{"src/component.ts":{"complexity":{"count":-1}}}' });
    await expect(analyze(packageRequest(w))).rejects.toThrow("INVALID_SUPPRESSIONS");
  });

  test("rejects a changed alias binding even when the target project compiles", async () => {
    const w = await packages({
      "apps/web/tsconfig.json": config({ compilerOptions: { ...options, paths: { "@/*": ["./src/*"] } } }),
      "packages/feature/tsconfig.json": config({ compilerOptions: { ...options, paths: { "@/*": ["./src/*"] } } }),
      "apps/web/src/component.ts": 'export { value as component } from "@/helper";',
      "apps/web/src/use.ts": 'export const keep = 1;',
      "apps/web/src/helper.ts": 'export const value = 1;',
      "packages/feature/src/helper.ts": 'export const value = 2;',
    });
    await expect(analyze(packageRequest(w))).rejects.toThrow("REFERENCES_NOT_PRESERVED");
  });

  test("rejects extension changes", async () => {
    const w = await workspace({ "tsconfig.json": config(), "src/component.ts": "export const component = 1;" });
    await expect(analyze(request(w, { target: w.path("src/component.tsx") }))).rejects.toThrow("UNSUPPORTED_TARGET");
  });

  test("validates composite project references using in-memory declaration builds", async () => {
    const w = await workspace({
      "app/tsconfig.json": config({ compilerOptions: { ...options, composite: true, noEmit: false, declaration: true, rootDir: "src", outDir: "dist" }, references: [{ path: "../lib" }] }),
      "lib/tsconfig.json": config({ compilerOptions: { ...options, composite: true, noEmit: false, declaration: true, rootDir: "src", outDir: "dist" } }),
      "app/src/component.ts": "export const component = 1;",
      "app/src/use.ts": 'export { component } from "./component";',
      "lib/src/keep.ts": "export const keep = 1;",
    });
    const result = await analyze(request(w, { project: w.path("app/tsconfig.json"), targetProject: w.path("lib/tsconfig.json"), file: w.path("app/src/component.ts"), target: w.path("lib/src/component.ts") }));
    expect(result.diagnosticsAfter).toEqual([]);
    expect(changed(result, w.path("app/src/use.ts"))).toContain('"../../lib/src/component"');
    expect(existsSync(w.path("lib/dist"))).toBe(false);
  });

  test("rejects new project cycles", async () => {
    const w = await workspace({
      "app/tsconfig.json": config(), "lib/tsconfig.json": config(),
      "app/src/component.ts": 'export { helper as component } from "./helper";',
      "app/src/helper.ts": "export const helper = 1;",
      "app/src/use.ts": 'export { component } from "./component";',
      "lib/src/keep.ts": "export const keep = 1;",
    });
    await expect(analyze(request(w, { project: w.path("app/tsconfig.json"), targetProject: w.path("lib/tsconfig.json"), file: w.path("app/src/component.ts"), target: w.path("lib/src/component.ts") }))).rejects.toThrow("PROJECT_DEPENDENCY_CYCLE");
  });

  test("fails closed on binary directory assets", async () => {
    const w = await workspace({ "tsconfig.json": config(), "src/components/a.ts": "export const a = 1;" });
    await writeFile(w.path("src/components/icon.png"), Buffer.from([137, 80, 78, 71]));
    await expect(analyze(request(w, { file: w.path("src/components"), target: w.path("src/ui") }))).rejects.toThrow("UNSUPPORTED_ENCODING");
  });

  test("rejects a target outside include patterns", async () => {
    const w = await workspace({ "tsconfig.json": config(), "src/component.ts": 'export const component = 1;', "src/use.ts": 'export const keep = 1;' });
    await expect(analyze(request(w, { target: w.path("outside/component.ts") }))).rejects.toThrow("TARGET_NOT_IN_PROJECT");
  });
});
