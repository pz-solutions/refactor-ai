import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRefactorApi } from "../src/api.ts";
import { loadBackend } from "../src/backends/load.ts";
import { createPlan } from "../src/core/plan.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-api-")));
  roots.push(root);
  const project = join(root, "tsconfig.json"), file = join(root, "math.ts"), caller = join(root, "caller.ts");
  await writeFile(project, '{"compilerOptions":{"strict":true,"target":"es2022"},"include":["*.ts"]}\n');
  await writeFile(file, "export function add(a: number, b: number) { return a + b; }\n");
  await writeFile(caller, 'import { add } from "./math";\nexport const result = add(2, 3);\n');
  return { root, project, file, caller };
}

test("custom automation applies semantic rename and a freshly planned format without CLI output", async () => {
  const { project, file, caller } = await workspace();
  const rename = createRefactorApi({ loadBackend, language: "typescript", operation: "rename" });
  const format = createRefactorApi({ loadBackend, language: "typescript", operation: "format" });
  const before = await readFile(file, "utf8");
  const first = await rename.plan({ project, file, at: "1:17", name: "sum" });
  expect(first.validation.status).toBe("passed");
  expect(await readFile(file, "utf8")).toBe(before);
  expect(rename.preview(first)).toContain("sum(2, 3)");
  expect((await rename.validate(first)).status).toBe("validated");
  expect((await rename.apply(first)).status).toBe("applied");
  expect(await readFile(caller, "utf8")).toContain("sum(2, 3)");
  const second = await format.plan({ project, file });
  expect(second.request.operation).toBe("format");
  expect((await format.validate(second)).status).toBe("validated");
  await format.apply(second);
  expect(await readFile(file, "utf8")).toContain("function sum");
}, 30_000);

test("API rejects modified and stale plans and reads unchanged CLI-compatible JSON", async () => {
  const { root, project, file } = await workspace();
  const api = createRefactorApi({ loadBackend, language: "typescript", operation: "rename" });
  const plan = await api.plan({ project, file, at: 16, name: "sum" });
  const saved = join(tmpdir(), `api-plan-${plan.id}.json`);
  try {
    await writeFile(saved, JSON.stringify(plan));
    expect((await api.loadPlan(saved)).id).toBe(plan.id);
  } finally { await rm(saved, { force: true }); }
  const modified = structuredClone(plan);
  modified.changes[0].after += "\n// manual edit";
  expect(() => api.preview(modified)).toThrow("INVALID_PLAN");
  await expect(api.apply(modified)).rejects.toThrow("INVALID_PLAN");
  await writeFile(join(root, "new.ts"), "export const extra = 1;\n");
  await expect(api.validate(plan)).rejects.toThrow("STALE_PROJECT_INPUTS");
  await expect(api.apply(plan)).rejects.toThrow("STALE_PROJECT_INPUTS");
  expect(await readFile(file, "utf8")).toContain("function add");
});

test("language and operation restrictions reject requests before a backend is loaded", async () => {
  let loaded = false;
  const api = createRefactorApi({ language: "typescript", operation: "rename", loadBackend: async () => {
    loaded = true; throw new Error("backend must not load");
  } });
  await expect(api.capabilities("/missing/App.csproj")).rejects.toThrow("UNSUPPORTED_LANGUAGE");
  await expect(api.plan({ project: "/missing/App.csproj", file: "/missing.cs" })).rejects.toThrow("UNSUPPORTED_LANGUAGE");
  await expect(api.plan({ project: "/missing/tsconfig.json", file: "/missing.ts", operation: "format" })).rejects.toThrow("only supports rename");
  await expect(api.plan({ project: "/missing/tsconfig.json", file: "/missing.ts", targetProject: "/missing/App.csproj" })).rejects.toThrow("UNSUPPORTED_LANGUAGE");
  await expect(api.plan({ project: "/missing/tsconfig.json", file: "/missing.ts", checker: "unknown" as "ts7" })).rejects.toThrow("INVALID_ARGUMENT: checker");
  expect(loaded).toBe(false);
});

test("foreign compiler plans are rejected by every plan-consuming language API method", async () => {
  const { root, project, file } = await workspace();
  const foreignProject = join(root, "App.csproj");
  await writeFile(foreignProject, '<Project Sdk="Microsoft.NET.Sdk"/>\n');
  const foreign = await createPlan({ project: foreignProject, root, file, operation: "format" }, async () => ({
    backend: "roslyn", version: "4.12.0", changes: [], diagnosticsBefore: [], diagnosticsAfter: [], notes: [],
  }));
  const api = createRefactorApi({ loadBackend, language: "typescript" });
  expect(() => api.preview(foreign)).toThrow("UNSUPPORTED_LANGUAGE");
  await expect(api.validate(foreign)).rejects.toThrow("UNSUPPORTED_LANGUAGE");
  await expect(api.apply(foreign)).rejects.toThrow("UNSUPPORTED_LANGUAGE");
  const saved = join(tmpdir(), `api-foreign-${foreign.id}.json`);
  try {
    await writeFile(saved, JSON.stringify(foreign));
    await expect(api.loadPlan(saved)).rejects.toThrow("UNSUPPORTED_LANGUAGE");
  } finally { await rm(saved, { force: true }); }
});

test("API checks UTF-16 coordinates and requires an operation for the aggregate interface", async () => {
  const { project, file } = await workspace();
  const api = createRefactorApi({ loadBackend });
  await expect(api.plan({ project, file })).rejects.toThrow("UNSUPPORTED");
  for (const at of [-1, 99999, 1.5, "0:1", "1:999"]) {
    await expect(api.plan({ project, file, operation: "rename", at, name: "sum" })).rejects.toThrow("INVALID_POSITION");
  }
});

test("failed compiler validation stays inspectable and apply rejects it without altering sources or exit status", async () => {
  const { project, file } = await workspace();
  const before = await readFile(file, "utf8"), exitCode = process.exitCode;
  const api = createRefactorApi({ loadBackend: async () => ({ capabilities: [], analyze: async () => ({
    backend: "typescript", version: "5.9.3", changes: [{ path: file, before, after: before + "invalid;\n" }],
    diagnosticsBefore: [], diagnosticsAfter: [{ file, code: "TS2304", message: "Cannot find name 'invalid'." }], notes: [],
  }) }) });
  const plan = await api.plan({ project, file, operation: "format" });
  expect(plan.validation.status).toBe("failed");
  expect((await api.validate(plan)).status).toBe("failed");
  expect(api.preview(plan)).toContain("invalid");
  await expect(api.apply(plan)).rejects.toThrow("VALIDATION_FAILED");
  expect(await readFile(file, "utf8")).toBe(before);
  expect(process.exitCode).toBe(exitCode);
});
