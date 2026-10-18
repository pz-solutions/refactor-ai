import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyPlan } from "../src/core/apply.ts";
import { assertFresh, createPlan, loadPlan, newDiagnostics, preview } from "../src/core/plan.ts";
import type { BackendResult, RefactorRequest } from "../src/types.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-core-")));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) await writeFile(join(root, name), contents);
  return { root, file: join(root, "src.ts"), project: join(root, "tsconfig.json") };
}

function request(p: Awaited<ReturnType<typeof fixture>>): RefactorRequest {
  return { root: p.root, project: p.project, file: p.file, operation: "rename", position: 0, newName: "newName" };
}

function result(changes: BackendResult["changes"], diagnosticsBefore: BackendResult["diagnosticsBefore"] = [], diagnosticsAfter = diagnosticsBefore): BackendResult {
  return { backend: "stub", version: "1", changes, diagnosticsBefore, diagnosticsAfter, notes: [] };
}

describe("deterministic plan and apply core", () => {
  test("creates deterministic plans without mutating source files", async () => {
    const p = await fixture({ "src.ts": "const oldName = 1;\r\n", "tsconfig.json": "{}\n" });
    const before = await readFile(p.file, "utf8");
    const analyze = async () => result([{ path: p.file, before, after: "const newName = 1;\r\n" }]);

    const first = await createPlan(request(p), analyze);
    const second = await createPlan(request(p), analyze);

    expect(second).toEqual(first);
    expect(await readFile(p.file, "utf8")).toBe(before);
    expect(preview(first)).toContain("-const oldName = 1;");
  });

  test("detects a stale snapshot when an untouched project config changes", async () => {
    const p = await fixture({ "src.ts": "const oldName = 1;\n", "tsconfig.json": "{\"compilerOptions\":{}}\n" });
    const plan = await createPlan(request(p), async () => result([{ path: p.file, before: "const oldName = 1;\n", after: "const newName = 1;\n" }]));
    await writeFile(p.project, "{\"compilerOptions\":{\"strict\":true}}\n");

    await expect(assertFresh(plan)).rejects.toThrow(/STALE_SNAPSHOT:.*changed tsconfig.json/);
  });

  test("names generated inputs changed during analysis without ignoring them", async () => {
    const p = await fixture({ "src.ts": "one\n", "next-env.d.ts": "// before\n", "tsconfig.json": "{}\n" });
    await expect(createPlan(request(p), async () => {
      await writeFile(join(p.root, "next-env.d.ts"), "// dev server output\n");
      return result([{ path: p.file, before: "one\n", after: "two\n" }]);
    })).rejects.toThrow(/STALE_SNAPSHOT:.*changed next-env\.d\.ts \[generated candidate\].*dev-server generators/);
  });

  test("rejects duplicate and outside-root changes while planning", async () => {
    const p = await fixture({ "src.ts": "one\n", "tsconfig.json": "{}\n" });
    const duplicate = async () => result([
      { path: p.file, before: "one\n", after: "two\n" },
      { path: p.file, before: "one\n", after: "three\n" },
    ]);
    await expect(createPlan(request(p), duplicate)).rejects.toThrow("DUPLICATE_CHANGE");

    await expect(createPlan(request(p), async () => result([
      { path: join(p.root, "..", "outside.ts"), before: null, after: "outside\n" },
    ]))).rejects.toThrow("OUTSIDE_ROOT");
  });

  test("preserves diagnostic multiplicity and blocks apply for new diagnostics", async () => {
    const diagnostic = { file: "/fixture.ts", code: "E1", message: "same" };
    expect(newDiagnostics([diagnostic, diagnostic], [diagnostic, diagnostic, diagnostic])).toEqual([diagnostic]);

    const p = await fixture({ "src.ts": "const oldName = 1;\n", "tsconfig.json": "{}\n" });
    const plan = await createPlan(request(p), async () => result(
      [{ path: p.file, before: "const oldName = 1;\n", after: "const newName = 1;\n" }],
      [],
      [diagnostic],
    ));
    expect(plan.validation.status).toBe("failed");
    await expect(applyPlan(plan)).rejects.toThrow("VALIDATION_FAILED");
    expect(await readFile(p.file, "utf8")).toBe("const oldName = 1;\n");
  });

  test("rejects a tampered plan before it can be loaded or applied", async () => {
    const p = await fixture({ "src.ts": "const oldName = 1;\n", "tsconfig.json": "{}\n" });
    const plan = await createPlan(request(p), async () => result([
      { path: p.file, before: "const oldName = 1;\n", after: "const newName = 1;\n" },
    ]));
    const path = join(p.root, "plan.json");
    await writeFile(path, JSON.stringify({ ...plan, changes: [{ ...plan.changes[0], after: "tampered\n" }] }));
    await expect(loadPlan(path)).rejects.toThrow("integrity check failed");
  });

  test("applies a multi-file plan and keeps CRLF/UTF-16 content intact", async () => {
    const p = await fixture({ "src.ts": "const 😀 = 1;\r\n", "other.ts": "export const oldName = 1;\r\n", "tsconfig.json": "{}\n" });
    const oldSource = await readFile(p.file, "utf8");
    const plan = await createPlan(request(p), async () => result([
      { path: p.file, before: oldSource, after: "const 😀 = 2;\r\n" },
      { path: join(p.root, "other.ts"), before: "export const oldName = 1;\r\n", after: "export const newName = 1;\r\n" },
    ]));

    const applied = await applyPlan(plan);
    expect(applied.status).toBe("applied");
    expect(applied.files).toHaveLength(2);
    expect(await readFile(p.file, "utf8")).toBe("const 😀 = 2;\r\n");
    expect(await readFile(join(p.root, "other.ts"), "utf8")).toBe("export const newName = 1;\r\n");
    await expect(applyPlan(plan)).rejects.toThrow("STALE_SNAPSHOT");
  });

  test("empty plans apply despite unrelated edits, additions and deletions", async () => {
    const p = await fixture({ "src.ts": "one\n", "other.ts": "old\n", "tsconfig.json": "{}\n" });
    const plan = await createPlan(request(p), async () => result([]));
    await writeFile(join(p.root, "other.ts"), "changed\n");
    await writeFile(join(p.root, "new.ts"), "new\n");
    await rm(p.file);
    expect(await applyPlan(plan)).toEqual({ status: "applied", files: [], journal: null });
  });

  test("rejects stale apply without writing any source", async () => {
    const p = await fixture({ "src.ts": "one\n", "other.ts": "unchanged\n", "tsconfig.json": "{}\n" });
    const plan = await createPlan(request(p), async () => result([{ path: p.file, before: "one\n", after: "two\n" }]));
    await writeFile(join(p.root, "other.ts"), "external edit\n");
    await expect(applyPlan(plan)).rejects.toThrow("STALE_SNAPSHOT");
    expect(await readFile(p.file, "utf8")).toBe("one\n");
    expect(await readFile(join(p.root, "other.ts"), "utf8")).toBe("external edit\n");
  });

  test("rolls back earlier source writes when a later file cannot be written", async () => {
    const p = await fixture({ "src.ts": "one\n", "tsconfig.json": "{}\n" });
    const blockedDirectory = join(p.root, "z-blocked");
    const blockedFile = join(blockedDirectory, "second.ts");
    await mkdir(blockedDirectory);
    await writeFile(blockedFile, "old\n");
    const plan = await createPlan(request(p), async () => result([
      { path: p.file, before: "one\n", after: "two\n" },
      { path: blockedFile, before: "old\n", after: "new\n" },
    ]));
    await chmod(blockedDirectory, 0o500);
    try {
      await expect(applyPlan(plan)).rejects.toThrow();
      expect(await readFile(p.file, "utf8")).toBe("one\n");
      expect(await readFile(blockedFile, "utf8")).toBe("old\n");
      const journal = JSON.parse(await readFile(join(p.root, ".refactor-ai", `${plan.id}.journal.json`), "utf8"));
      expect(journal.status).toBe("rolled-back");
    } finally {
      await chmod(blockedDirectory, 0o700);
    }
  });
});
