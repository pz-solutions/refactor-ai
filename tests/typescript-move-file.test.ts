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
    expect(plan.schemaVersion).toBe(2);
    expect(plan.validation.status).toBe("passed");
    expect(preview(plan)).toContain("README.md");
    expect(changed(plan, w.path("src/ui/components/nested/component.ts"))).toContain('"../../../helper"');
    const saved = w.path(".refactor-ai/move.json");
    await mkdir(dirname(saved)); await writeFile(saved, JSON.stringify(plan));
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

  test("unmoved aliases unavailable in the target report NEW_DIAGNOSTICS with the alias hint", async () => {
    const w = await packages({
      "apps/web/tsconfig.json": config({ compilerOptions: { ...options, paths: { "@/*": ["./src/*"] } } }),
      "apps/web/src/component.ts": 'import { helper } from "@/helper";\nexport const component = () => helper;\n',
      "apps/web/src/helper.ts": 'export const helper = 42;\n',
    });
    await expect(analyze(packageRequest(w))).rejects.toThrow(/NEW_DIAGNOSTICS:.*@\/helper.*unresolved source-project alias imports: @\/helper/s);
  });

  test("fails with MISSING_DEPENDENCY", async () => {
    const w = await packages({ "apps/web/package.json": '{"name":"@scope/web"}' });
    await expect(analyze(packageRequest(w))).rejects.toThrow("MISSING_DEPENDENCY");
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
