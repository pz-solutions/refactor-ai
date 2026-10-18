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

  test("--only splits moved declarations and preserves comments, type imports and explicit aliases", async () => {
    const w = await workspace({
      "tsconfig.json": config(),
      "src/component.ts": '"use client";\nimport { /* selected */ a as value, b } from "./old";\nimport type { Options } from "./old";\nexport { a as publicValue, b as keep } from "./old";\nexport const component = (o: Options) => value + b + o.count;\n',
      "src/old.ts": 'export const a = 1, b = 2; export interface Options { count: number }',
      "src/new.ts": 'export const a = 3; export interface Options { count: number }',
    });
    const plan = await createRefactorApi({ loadBackend }).plan({ ...request(w), map: { "./old": "./new" }, only: ["a", "Options"] });
    const text = changed(plan, w.path("src/ui/component.ts"))!;
    expect(text).toContain('"use client"');
    expect(text).toContain('/* selected */ a as value');
    expect(text).toContain('from "../new"');
    expect(text).toContain('b } from "../old"');
    expect(text).toContain('a as publicValue');
    expect(text).toContain('import type { Options }');
    expect(plan.validation.status).toBe("passed");
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

  test("workspace equivalents map declared alternatives, allow overrides and give partial-selection hints", async () => {
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
    await expect(analyze(packageRequest(w, { only: ["useTranslations"] }))).rejects.toThrow("destination declares use-intl; map next-intl=use-intl");
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
