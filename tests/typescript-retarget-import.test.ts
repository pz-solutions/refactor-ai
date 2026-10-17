import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRefactorApi, type PlanOptions } from "../src/api";
import { loadBackend } from "../src/backends/load";

const roots: string[] = [];
const exports = 'export declare const x: number, y: number; export interface Options { value: number } export default x;\n';
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "refactor-ai-retarget-"));
  roots.push(root);
  const all = {
    "node_modules/old-lib/package.json": '{"name":"old-lib","types":"index.d.ts"}',
    "node_modules/new-lib/package.json": '{"name":"new-lib","types":"index.d.ts"}',
    "node_modules/old-lib/index.d.ts": exports + 'export declare function OldProvider(props: {}): any; export declare const missing: number;\n',
    "node_modules/new-lib/index.d.ts": exports + 'export declare function NewProvider(props: {}): any;\n',
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "preserve" }, include: ["src/**/*"] }),
    ...files,
  };
  for (const [name, text] of Object.entries(all)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), text);
  }
  const api = createRefactorApi({ loadBackend });
  return { root, api, plan: (options: Partial<PlanOptions> = {}) => api.plan({ operation: "retarget-import", project: join(root, "tsconfig.json"), from: "old-lib", to: "new-lib", ...options }), path: (name: string) => join(root, name) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("retargets named, aliased and type-only imports across the project without writing", async () => {
  const source = '"use client";\n// leading\nimport { x, y as local, type Options } from \'old-lib\'; // trailing\nexport const value: Options = { value: x + local };\n';
  const p = await fixture({ "src/a.ts": source, "src/b.ts": 'import type { Options } from "old-lib"; export type B = Options;\n' });
  const plan = await p.plan();
  expect(plan.validation.status).toBe("passed");
  expect(plan.changes).toHaveLength(2);
  expect(plan.changes[0]!.after).toBe(source.replace("'old-lib'", "'new-lib'"));
  expect(plan.changes[1]!.after).toContain('import type { Options } from "new-lib"');
  expect(await readFile(p.path("src/a.ts"), "utf8")).toBe(source);
  expect(await p.plan()).toEqual(plan);
});

test("maps unaliased JSX bindings semantically and preserves explicit aliases and unrelated identifiers", async () => {
  const p = await fixture({ "src/a.tsx": `import { OldProvider } from 'old-lib';
import { OldProvider as Custom } from 'old-lib';
const text = "OldProvider"; // OldProvider
function other(OldProvider: number) { return OldProvider; }
export const a = <OldProvider></OldProvider>;
export const b = <Custom />;
export const obj = { OldProvider };
` });
  const plan = await p.plan({ map: { OldProvider: "NewProvider" } });
  expect(plan.validation.status).toBe("passed");
  const after = plan.changes[0]!.after!;
  expect(after).toContain("import { NewProvider } from 'new-lib'");
  expect(after).toContain("import { NewProvider as Custom } from 'new-lib'");
  expect(after).toContain("<NewProvider></NewProvider>");
  expect(after).toContain("<Custom />");
  expect(after).toContain('const text = "OldProvider"; // OldProvider');
  expect(after).toContain("function other(OldProvider: number) { return OldProvider; }");
  expect(after).toContain("{ OldProvider: NewProvider }");
});

test("splits --only selections using pre-map names and preserves comments and type modifiers", async () => {
  const p = await fixture({ "src/a.ts": `// before
import { /* keep */ x, /* move */ OldProvider, type Options } from 'old-lib'; // after
export const a = { x, OldProvider };
` });
  const plan = await p.plan({ only: ["OldProvider", "Options"], map: { OldProvider: "NewProvider" } });
  const after = plan.changes[0]!.after!;
  expect(after).toContain("import { /* keep */ x } from 'old-lib';");
  expect(after).toContain("import { /* move */ NewProvider, type Options } from 'new-lib'; // after");
  expect(after).toStartWith("// before\n");
  expect(plan.validation.status).toBe("passed");
});

test("merges compatible destination imports and deduplicates identical bindings", async () => {
  const p = await fixture({ "src/a.ts": `"use client";
// source
import { x, y } from 'old-lib'; // keep comment
// destination
import { x } from "new-lib";
export const a = x + y;
` });
  const plan = await p.plan();
  const after = plan.changes[0]!.after!;
  expect(after).toContain('import { x, y } from "new-lib";');
  expect(after).not.toContain("old-lib");
  expect(after.match(/import /g)).toHaveLength(1);
  expect(after).toStartWith('"use client";\n// source');
  expect(after).toContain("// keep comment");
  expect(after).toContain("// destination");
  expect(plan.validation.status).toBe("passed");
});

test("retargets re-exports, preserving aliases, type-only and partial selection", async () => {
  const p = await fixture({ "src/a.ts": `export { x, y as other } from "old-lib";
export type { Options } from 'old-lib';
export { OldProvider as Public } from 'old-lib';
` });
  const plan = await p.plan({ only: ["x", "OldProvider", "Options"], map: { OldProvider: "NewProvider" } });
  const after = plan.changes[0]!.after!;
  expect(after).toContain('export { y as other } from "old-lib";');
  expect(after).toContain('export { x } from "new-lib";');
  expect(after).toContain("export type { Options } from 'new-lib';");
  expect(after).toContain("export { NewProvider as Public } from 'new-lib';");
  expect(plan.validation.status).toBe("passed");
});

test("preserves explicit aliases matching the mapped name and unaliased mapped re-export names", async () => {
  const p = await fixture({ "src/a.ts": `import { OldProvider as NewProvider } from 'old-lib';
export { OldProvider } from 'old-lib';
export const a = NewProvider;
` });
  const plan = await p.plan({ map: { OldProvider: "NewProvider" } });
  expect(plan.changes[0]!.after).toContain("import { NewProvider as NewProvider } from 'new-lib';");
  expect(plan.changes[0]!.after).toContain("export { NewProvider } from 'new-lib';");
  expect(plan.validation.status).toBe("passed");
});

test("splits and merges type-only imports independently of value imports", async () => {
  const p = await fixture({ "src/a.ts": `import type { Options } from 'old-lib';
import type { Options } from "new-lib";
import { x } from 'old-lib';
import { y } from "new-lib";
export const a: Options = { value: x + y };
` });
  const plan = await p.plan();
  expect(plan.changes[0]!.after).toContain('import type { Options } from "new-lib";');
  expect(plan.changes[0]!.after).toContain('import { y, x } from "new-lib";');
  expect(plan.changes[0]!.after!.match(/import type/g)).toHaveLength(1);
  expect(plan.validation.status).toBe("passed");
});

test("deduplicates commented destination members while retaining CRLF and line comments", async () => {
  const p = await fixture({ "src/a.ts": "import { /* moved */ x, y // trailing member\r\n } from 'old-lib';\r\nimport { x } from 'new-lib';\r\nexport const a = x + y;\r\n" });
  const plan = await p.plan();
  const after = plan.changes[0]!.after!;
  expect(after).toContain("/* moved */ x");
  expect(after).toContain("y // trailing member");
  expect(after.match(/import /g)).toHaveLength(1);
  expect(after).toContain("\r\nexport const a");
  expect(plan.validation.status).toBe("passed");
});

test("preserves importer public aliases when renaming a mapped type binding", async () => {
  const p = await fixture({ "src/a.ts": `import type { OldOptions } from 'old-lib';
export type { OldOptions };
export type Public = OldOptions;
`, "src/b.ts": `import type { OldOptions } from './a'; export const a: OldOptions = { value: 1 };` });
  await writeFile(p.path("node_modules/old-lib/index.d.ts"), exports + "export interface OldOptions { value: number }");
  await writeFile(p.path("node_modules/new-lib/index.d.ts"), exports + "export interface NewOptions { value: number }");
  const plan = await p.plan({ map: { OldOptions: "NewOptions" } });
  expect(plan.changes[0]!.after).toContain("import type { NewOptions } from 'new-lib';");
  expect(plan.changes[0]!.after).toContain("NewOptions as OldOptions");
  expect(plan.validation.status).toBe("passed");
});

test("merges named bindings into a default destination import without losing declaration comments", async () => {
  const p = await fixture({ "src/a.ts": `import /* source module */ { x } /* import note */ from 'old-lib';
import value from "new-lib";
export const a = x + value;
` });
  const plan = await p.plan();
  const after = plan.changes[0]!.after!;
  expect(after).toContain('import value, { x } from "new-lib";');
  expect(after).toContain("/* source module */");
  expect(after).toContain("/* import note */");
  expect(plan.validation.status).toBe("passed");
});

test("rejects missing destination exports with a diagnostic naming the binding", async () => {
  const p = await fixture({ "src/a.ts": 'import { missing } from "old-lib"; export const a = missing;\n' });
  await expect(p.plan()).rejects.toThrow(/NEW_DIAGNOSTICS:.*missing/);
});

test("fails early when target does not resolve from every affected file", async () => {
  const p = await fixture({ "src/a.ts": 'export { x } from "old-lib";', "src/b.ts": 'export { y } from "old-lib";' });
  await expect(p.plan({ to: "absent-lib" })).rejects.toThrow(/TARGET_UNRESOLVED:.*a.ts.*b.ts/);
});

test("limits directory and file scope to loaded project files", async () => {
  const p = await fixture({ "src/feature/a.ts": 'export { x } from "old-lib";', "src/feature/deep/b.ts": 'export { y } from "old-lib";', "src/elsewhere.ts": 'export { x } from "old-lib";' });
  const plan = await p.plan({ file: p.path("src/feature") });
  expect(plan.changes.map(change => change.path)).toEqual([p.path("src/feature/a.ts"), p.path("src/feature/deep/b.ts")]);
  expect((await p.plan({ file: p.path("src/elsewhere.ts") })).changes).toHaveLength(1);
});

test("retargets default, namespace, star and side-effect declarations without --only", async () => {
  const p = await fixture({ "src/a.ts": `import value, { x } from 'old-lib';
import * as library from 'old-lib';
import 'old-lib';
export * from 'old-lib';
export const a = value + library.y + x;
` });
  const plan = await p.plan();
  expect(plan.validation.status).toBe("passed");
  expect(plan.changes[0]!.after).not.toContain("old-lib");
  await expect(p.plan({ only: ["x"] })).rejects.toThrow("UNSUPPORTED_SELECTION");
});

test("rejects missing namespace members and mapped local name capture", async () => {
  const p = await fixture({ "src/a.ts": `import * as library from 'old-lib'; export const a = library.missing;` });
  await expect(p.plan()).rejects.toThrow(/NEW_DIAGNOSTICS:.*missing/);
  await writeFile(p.path("src/a.ts"), `import { OldProvider } from 'old-lib'; const NewProvider = 1; export const a = OldProvider;`);
  await expect(p.plan({ map: { OldProvider: "NewProvider" } })).rejects.toThrow(/RENAME_CONFLICT|NEW_DIAGNOSTICS/);
});

test("no matches succeed with a note; wildcard and invalid maps fail clearly", async () => {
  const p = await fixture({ "src/a.ts": "export const x = 1;" });
  const plan = await p.plan({ to: "absent-lib" });
  expect(plan.changes).toEqual([]);
  expect(plan.notes.join(" ")).toContain("No matching");
  await expect(p.plan({ from: "old-lib/*", to: "new-lib/*" })).rejects.toThrow("UNSUPPORTED_SPECIFIER");
  await expect(p.plan({ map: { x: "bad-name" } })).rejects.toThrow("INVALID_NAME");
  expect((await p.api.capabilities(p.path("tsconfig.json"))).map(item => item.operation)).toContain("retarget-import");
});

test("CLI accepts repeated mappings, optional file scope, preview and duplicate-map refusal", async () => {
  const p = await fixture({ "src/a.ts": 'import { OldProvider, x } from "old-lib"; export const a = { OldProvider, x };' });
  const cli = join(import.meta.dir, "../src/cli.ts");
  const out = p.path(".refactor-ai/retarget.json");
  const args = [cli, "plan", "retarget-import", "--project", p.path("tsconfig.json"), "--from", "old-lib", "--to", "new-lib", "--map", "OldProvider=NewProvider", "--map", "x=y", "--out", out];
  const result = spawnSync("bun", args, { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const plan = await p.api.loadPlan(out);
  expect(plan.request.map).toEqual({ OldProvider: "NewProvider", x: "y" });
  expect(p.api.preview(plan)).toContain("NewProvider");
  expect((await p.api.validate(plan)).status).toBe("validated");
  const duplicate = spawnSync("bun", [...args, "--map", "x=y"], { encoding: "utf8" });
  expect(duplicate.status).toBe(1);
  expect(duplicate.stderr).toContain("INVALID_ARGUMENT");
}, 15000);

const mockApi = 'declare const vi: { mock(path: string, factory?: () => unknown): void; doMock(path: string, factory?: () => unknown): void; unmock(path: string): void }; declare const jest: typeof vi; declare const vitest: typeof vi;\n';

test("default mock reporting follows transitive callers outside selection without changing test files", async () => {
  const p = await fixture({
    "src/feature.ts": 'export { x } from "old-lib";',
    "src/bridge.ts": 'export { x } from "./feature";',
    "src/feature.test.ts": mockApi + 'vi.doMock("old-lib", () => ({ x: 0 })); import { x } from "./bridge"; export const seen = x;',
    "src/unrelated.test.ts": mockApi + 'vi.mock("old-lib"); export const seen = 0;',
    "src/not-mocked.test.ts": mockApi + 'vi.unmock("old-lib"); import { x } from "./bridge"; export const seen = x;',
  });
  const plan = await p.plan({ file: p.path("src/feature.ts") });
  expect(plan.validation.status).toBe("passed");
  expect(plan.changes.map(change => change.path)).toEqual([p.path("src/feature.ts")]);
  expect(plan.notes.join(" ")).toContain(p.path("src/feature.test.ts"));
  expect(plan.notes.join(" ")).not.toContain(p.path("src/unrelated.test.ts"));
  expect(plan.notes.join(" ")).not.toContain(p.path("src/not-mocked.test.ts"));
  const explicit = await p.plan({ file: p.path("src/feature.ts"), mocks: "report" });
  expect(explicit.notes).toEqual(plan.notes);
});

for (const runner of ["vi", "vitest", "jest"]) test(`--mocks add clones every ${runner} registration with its factory and callee`, async () => {
  const testFile = mockApi + `import { x } from "./feature";\r\n${runner}.mock('old-lib', () => ({ x: 0 })); // retain comment\r\nfunction test() {\r\n  ${runner}.doMock("old-lib", factory)\r\n}\r\nconst factory = () => ({ x: 1 });\r\nexport const seen = x;\r\n`;
  const p = await fixture({ "src/feature.ts": 'export { x } from "old-lib";', "src/feature.test.ts": testFile });
  const plan = await p.plan({ file: p.path("src/feature.ts"), mocks: "add" });
  expect(plan.validation.status).toBe("passed");
  const after = plan.changes.find(change => change.path === p.path("src/feature.test.ts"))!.after!;
  expect(after).toContain(`${runner}.mock('old-lib', () => ({ x: 0 })); // retain comment\r\n${runner}.mock('new-lib', () => ({ x: 0 }));`);
  expect(after).toContain(`  ${runner}.doMock("old-lib", factory)\r\n  ${runner}.doMock("new-lib", factory);`);
  expect(plan.notes.join(" ")).toContain("Added parallel mocks");
  expect(await readFile(p.path("src/feature.test.ts"), "utf8")).toBe(testFile);
});

test("mock addition handles no factory and skips a whole file that already mocks the destination", async () => {
  const p = await fixture({
    "src/feature.ts": 'export { x } from "old-lib";',
    "src/covered.test.ts": mockApi + 'vi.mock("old-lib"); jest.doMock("new-lib"); import { x } from "./feature"; export const seen = x;',
    "src/uncovered.test.ts": mockApi + 'vi.mock("old-lib"); import { x } from "./feature"; export const seen = x;',
    "src/actual.test.ts": mockApi + 'vi.mock("old-lib"); vi.unmock("new-lib"); import { x } from "./feature"; export const seen = x;',
  });
  const plan = await p.plan({ file: p.path("src/feature.ts"), mocks: "add" });
  expect(plan.validation.status).toBe("passed");
  expect(plan.changes.some(change => change.path === p.path("src/covered.test.ts"))).toBe(false);
  for (const name of ["uncovered", "actual"]) expect(plan.changes.find(change => change.path === p.path(`src/${name}.test.ts`))!.after).toContain('vi.mock("old-lib");\nvi.mock("new-lib");');
});

test("mock callers include dynamic imports and cycles but exclude unselected and mock-only edges", async () => {
  const p = await fixture({
    "src/feature.ts": 'export { x } from "old-lib"; export { other } from "./bridge";',
    "src/bridge.ts": 'import { x } from "./feature"; export const other = () => x;',
    "src/dynamic.test.ts": mockApi + 'vi.mock("old-lib"); export const load = () => import("./bridge");',
    "src/mocks-only.test.ts": mockApi + 'vi.mock("old-lib"); vi.mock("./feature"); export {};',
    "src/unselected.ts": 'export { x } from "old-lib";',
    "src/unselected.test.ts": mockApi + 'vi.mock("old-lib"); import { x } from "./unselected"; export const seen = x;',
  });
  const plan = await p.plan({ file: p.path("src/feature.ts") });
  expect(plan.notes.join(" ")).toContain(p.path("src/dynamic.test.ts"));
  expect(plan.notes.join(" ")).not.toContain(p.path("src/mocks-only.test.ts"));
  expect(plan.notes.join(" ")).not.toContain(p.path("src/unselected.test.ts"));
});

test("mock addition stays compiler validated and rejects expression-valued calls", async () => {
  const p = await fixture({
    "src/feature.ts": 'export { x } from "old-lib";',
    "src/feature.test.ts": 'declare const vi: { mock(path: "old-lib", factory: () => unknown): void };\nvi.mock("old-lib", () => ({})); import { x } from "./feature"; export const seen = x;',
  });
  await expect(p.plan({ mocks: "add" })).rejects.toThrow("NEW_DIAGNOSTICS");
  await writeFile(p.path("src/feature.test.ts"), mockApi + 'const call = vi.mock("old-lib"); import { x } from "./feature"; export const seen = x;');
  await expect(p.plan({ mocks: "add" })).rejects.toThrow("UNSUPPORTED_MOCK_CALL");
  expect((await p.plan()).notes.join(" ")).toContain("Tests mocking");
});

test("test-runner module-loading calls count as imports without treating registrations as imports", async () => {
  const p = await fixture({
    "src/feature.ts": 'export { x } from "old-lib";',
    "src/actual.test.ts": 'declare const vi: { mock(path: string): void; importActual(path: string): Promise<unknown> };\nvi.mock("old-lib"); export const load = () => vi.importActual("./feature");',
  });
  const plan = await p.plan({ file: p.path("src/feature.ts"), mocks: "add" });
  expect(plan.validation.status).toBe("passed");
  expect(plan.changes.find(change => change.path === p.path("src/actual.test.ts"))!.after).toContain('vi.mock("new-lib");');
});

test("--mocks validates values and operation scope through API and CLI", async () => {
  const p = await fixture({ "src/a.ts": 'export { x } from "old-lib";' });
  await expect(p.plan({ mocks: "invalid" as "add" })).rejects.toThrow("INVALID_ARGUMENT");
  await expect(p.plan({ operation: "format", file: p.path("src/a.ts"), from: undefined, to: undefined, mocks: "add" })).rejects.toThrow("mocks require retarget-import");
  const cli = join(import.meta.dir, "../src/cli.ts");
  const args = [cli, "plan", "retarget-import", "--project", p.path("tsconfig.json"), "--from", "old-lib", "--to", "new-lib", "--mocks", "add"];
  const result = spawnSync("bun", args, { encoding: "utf8" });
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect((await p.api.loadPlan(output.plan)).request.mocks).toBe("add");
  const invalid = spawnSync("bun", [...args.slice(0, -1), "invalid"], { encoding: "utf8" });
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toContain("mocks report|add");
});
