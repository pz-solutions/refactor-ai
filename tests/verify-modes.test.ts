import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createRefactorApi, type PlanOptions } from "../src/api";
import { loadBackend } from "../src/backends/load";
import { assertPlanShape, planId, type Plan } from "../src/core/plan";
import { main } from "../src/cli";
import type { RefactorRequest } from "../src/types";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const options = { strict: true, module: "esnext", moduleResolution: "bundler", target: "es2022", noEmit: true, skipLibCheck: true };

async function workspace(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-verify-")));
  roots.push(root);
  const all: Record<string, string> = { "tsconfig.json": JSON.stringify({ compilerOptions: options, include: ["src"] }), ...files };
  for (const [file, contents] of Object.entries(all)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), contents);
  }
  const api = createRefactorApi({ loadBackend });
  const path = (file: string) => join(root, file);
  const move = (extra: Partial<PlanOptions> = {}) => api.plan({ operation: "move-file", project: path("tsconfig.json"), root,
    file: path("src/component.ts"), target: path("src/ui/component.ts"), ...extra });
  return { root, api, path, move };
}

const base = {
  "src/component.ts": 'import { a } from "./old";\nexport const component = (): number => a;\n',
  "src/use.ts": 'import { component } from "./component";\nexport const value = component();\n',
  "src/old.ts": "export const a = 1;\n",
};

describe("--verify bindings", () => {
  test("plans the same edits as full verification, records the mode and reminds after apply", async () => {
    const w = await workspace(base);
    const full = await w.move();
    const bindings = await w.move({ verify: "bindings" });
    expect(bindings.changes).toEqual(full.changes);
    expect(full.request.verify).toBeUndefined();
    expect(full.checker).toEqual(expect.objectContaining({ name: "ts5" }));
    expect(bindings.request.verify).toBe("bindings");
    expect(bindings.checker).toBeUndefined();
    expect(bindings.validation).toEqual({ status: "passed", newDiagnostics: [] });
    expect([bindings.diagnosticsBefore, bindings.diagnosticsAfter]).toEqual([[], []]);
    expect(bindings.notes.join("\n")).toContain("program diagnostics were not computed");
    expect(bindings.id).not.toBe(full.id);
    expect((await w.api.validate(bindings)).verify).toBe("bindings");
    expect((await w.api.validate(full)).verify).toBe("full");
    const applied = await w.api.apply(bindings);
    expect(applied.verify).toBe("bindings");
    expect(applied.next).toContain("typecheck");
    expect(await readFile(w.path("src/use.ts"), "utf8")).toContain('"./ui/component"');
  }, 30_000);

  test("catches a named import that no longer binds to an export", async () => {
    const w = await workspace({ ...base, "src/new.ts": "export const b = 2;\n" });
    await expect(w.move({ map: { "./old": "./new" } })).rejects.toThrow(/^NEW_DIAGNOSTICS: TS2305 /);
    await expect(w.move({ map: { "./old": "./new" }, verify: "bindings" })).rejects.toThrow(/^BINDINGS_NOT_PRESERVED: .*component\.ts: '\.\.\/new' .*has no export 'a'/);
  }, 30_000);

  test("catches imports that no longer resolve, but accepts ambient modules and unprovable CommonJS exports", async () => {
    const w = await workspace({
      ...base,
      "src/component.ts": 'import { a } from "./old";\nimport { b } from "./cjs";\nimport icon from "virtual:icon";\nexport const component = (): number => a + b + icon;\n',
      "src/cjs.js": "module.exports.b = 1;\n",
      "src/env.d.ts": 'declare module "virtual:*" { const value: number; export default value; }\n',
      "tsconfig.json": JSON.stringify({ compilerOptions: { ...options, allowJs: true }, include: ["src"] }),
    });
    expect((await w.move({ verify: "bindings" })).changes.length).toBeGreaterThan(0);
    await expect(w.move({ map: { "./old": "./missing" }, verify: "bindings" })).rejects.toThrow(/^BINDINGS_NOT_PRESERVED: .*ui\/component\.ts: '\.\/missing' does not resolve/);
  }, 30_000);

  test("follows export * chains and keeps pre-existing broken bindings out of the plan's responsibility", async () => {
    const w = await workspace({
      ...base,
      "src/use.ts": 'import { component, missing } from "./component";\nexport const value = component() + missing;\n',
      "src/new.ts": 'export * from "./deep";\n',
      "src/deep.ts": "export const a = 3;\n",
    });
    // use.ts already imports a missing export: full verification and bindings both ignore the unchanged error.
    const plan = await w.move({ map: { "./old": "./new" }, verify: "bindings" });
    expect(plan.changes.find(change => change.path === w.path("src/ui/component.ts"))?.after).toContain('from "../new"');
    expect(plan.changes.find(change => change.path === w.path("src/use.ts"))?.after).toContain('"./ui/component"');
  }, 30_000);

  test("attributes imports copied by --only to the source file's original bindings", async () => {
    const w = await workspace({
      ...base,
      "src/types.ts": 'import { gone } from "./old";\nexport type Kept = number;\nexport interface Moved { value: typeof gone }\n',
    });
    const plan = await w.move({ file: w.path("src/types.ts"), target: w.path("src/model.ts"), only: ["Moved"], verify: "bindings" });
    expect(plan.changes.find(change => change.path === w.path("src/model.ts"))?.after).toContain("gone");
  }, 30_000);

  test("deliberately does not report type errors, which full verification rejects", async () => {
    const w = await workspace({ ...base, "src/new.ts": 'export const a = "text";\n' });
    await expect(w.move({ map: { "./old": "./new" } })).rejects.toThrow(/^NEW_DIAGNOSTICS: TS2322 /);
    const plan = await w.move({ map: { "./old": "./new" }, verify: "bindings" });
    expect(plan.validation.status).toBe("passed");
  }, 30_000);

  test("single-project operations check retargeted bindings and keep rename binding preservation", async () => {
    const w = await workspace({
      "src/use.ts": 'import { a } from "./old";\nexport const value: number = a;\n',
      "src/old.ts": "export const a = 1;\n",
      "src/typed.ts": 'export const a = "text";\n',
      "src/empty.ts": "export const b = 1;\n",
      "src/shadow.ts": "export function run(value: number) { const total = 1; return value + total; }\n",
    });
    const retarget = (to: string, verify?: "bindings") => w.api.plan({ operation: "retarget-import", project: w.path("tsconfig.json"), from: "./old", to, verify });
    await expect(retarget("./empty")).rejects.toThrow(/^NEW_DIAGNOSTICS: TS2305 /);
    await expect(retarget("./empty", "bindings")).rejects.toThrow(/^BINDINGS_NOT_PRESERVED: .*has no export 'a'/);
    await expect(retarget("./typed")).rejects.toThrow(/^NEW_DIAGNOSTICS: TS2322 /);
    expect((await retarget("./typed", "bindings")).request.verify).toBe("bindings");
    await expect(w.api.plan({ operation: "rename", project: w.path("tsconfig.json"), file: w.path("src/shadow.ts"), at: "1:21", name: "total", verify: "bindings" }))
      .rejects.toThrow(/^RENAME_CONFLICT/);
  }, 30_000);

  test("rejects checker selection, C# projects and project references", async () => {
    const w = await workspace(base);
    await expect(w.move({ verify: "bindings", checker: "ts7" })).rejects.toThrow("INVALID_ARGUMENT: checker selects program diagnostics");
    await expect(w.move({ verify: "none" as "full" })).rejects.toThrow("INVALID_ARGUMENT: verify full|bindings");
    await expect(w.api.plan({ operation: "rename", project: w.path("App.csproj"), file: w.path("A.cs"), verify: "bindings" })).rejects.toThrow("verify bindings requires TypeScript");
    const references = await workspace({
      "packages/core/tsconfig.json": JSON.stringify({ compilerOptions: { ...options, noEmit: false, composite: true, rootDir: "src", outDir: "dist" }, include: ["src"] }),
      "packages/core/src/money.ts": "export class Money {}\n",
      "packages/app/tsconfig.json": JSON.stringify({ compilerOptions: options, include: ["src"], references: [{ path: "../core" }] }),
      "packages/app/src/main.ts": 'import { Money } from "../../core/src/money";\nexport const m = new Money();\n',
    });
    await expect(references.api.plan({ operation: "move-file", project: references.path("packages/core/tsconfig.json"), root: references.root, verify: "bindings",
      file: references.path("packages/core/src/money.ts"), target: references.path("packages/core/src/model/money.ts") })).rejects.toThrow(/^VERIFY_UNSUPPORTED: /);
  }, 30_000);

  test("plan shape rejects unknown modes and bindings plans carrying diagnostics", async () => {
    const w = await workspace(base);
    const plan = await w.move({ verify: "bindings" });
    const tamper = (change: (copy: Plan) => void) => {
      const copy = JSON.parse(JSON.stringify(plan)) as Plan;
      change(copy);
      copy.id = planId(copy);
      return () => assertPlanShape(copy);
    };
    expect(tamper(copy => { copy.request.verify = "none" as "bindings"; })).toThrow("INVALID_PLAN: invalid verification mode");
    expect(tamper(copy => { copy.diagnosticsBefore = copy.diagnosticsAfter = [{ file: "x", code: "TS1", message: "m" }]; })).toThrow("INVALID_PLAN: invalid verification mode");
  }, 30_000);
});

describe(".refactor-ai/config.json", () => {
  test("supplies committable defaults that explicit options override", async () => {
    const w = await workspace({ ...base, ".refactor-ai/config.json": '{"verify":"bindings","checker":"ts7"}\n' });
    const defaulted = await w.move();
    expect(defaulted.request.verify).toBe("bindings");
    expect(defaulted.request.checker).toBeUndefined();
    const explicit = await w.move({ verify: "full", checker: "ts5" });
    expect(explicit.request.verify).toBeUndefined();
    expect(explicit.request.checker).toBe("ts5");
    // The configured checker applies to full verification (captured without running TS7 under Bun).
    let captured: RefactorRequest | undefined;
    const capture = createRefactorApi({ loadBackend: async () => ({ capabilities: [], analyze: async request => {
      captured = request;
      return { backend: "typescript", version: "test", changes: [], diagnosticsBefore: [], diagnosticsAfter: [], notes: [] };
    } }) });
    await capture.plan({ operation: "move-file", project: w.path("tsconfig.json"), file: w.path("src/component.ts"), target: w.path("src/ui/component.ts"), verify: "full" });
    expect(captured).toEqual(expect.objectContaining({ checker: "ts7" }));
    expect(captured!.verify).toBeUndefined();

    const out = w.path(".refactor-ai/cli.json");
    let output = "";
    await main(["plan", "move-file", "--project", w.path("tsconfig.json"), "--file", w.path("src/component.ts"), "--to", w.path("src/ui/component.ts"), "--out", out], { write: text => { output += text; } });
    expect(JSON.parse(output).verify).toBe("bindings");
    expect(await readFile(w.path(".refactor-ai/.gitignore"), "utf8")).toContain("!config.json");
  }, 60_000);

  test("rejects malformed configuration before planning", async () => {
    for (const text of ['{"verify":"fast"}', '{"checker":"tsc"}', '{"verfy":"bindings"}', "[]", "{"]) {
      const w = await workspace({ ...base, ".refactor-ai/config.json": text });
      await expect(w.move()).rejects.toThrow(/^INVALID_REPO_CONFIG: /);
    }
  }, 30_000);
});
