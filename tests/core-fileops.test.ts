import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { applyPlan } from "../src/core/apply.ts";
import { createPlan, loadPlan, planId, preview, type Plan } from "../src/core/plan.ts";
import type { BackendResult, RefactorRequest } from "../src/types.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-fileops-")));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), contents);
  }
  return root;
}

function request(root: string, extra: Partial<RefactorRequest> = {}): RefactorRequest {
  return { root, project: join(root, "tsconfig.json"), file: join(root, "src", "widget.ts"), operation: "move-type", ...extra };
}

function result(changes: BackendResult["changes"]): BackendResult {
  return { backend: "stub", version: "1", changes, diagnosticsBefore: [], diagnosticsAfter: [], notes: [] };
}

const exists = (path: string) => lstat(path).then(() => true, () => false);

async function caseInsensitive(root: string): Promise<boolean> {
  await writeFile(join(root, "case-probe"), "");
  try { return await exists(join(root, "CASE-PROBE")); }
  finally { await rm(join(root, "case-probe")); }
}

/** Re-sign a hand-edited plan so only structural validation can reject it. */
function resign(plan: Plan, edit: (body: Plan) => void): Plan {
  const copy = structuredClone(plan);
  edit(copy);
  return { ...copy, id: planId(copy) };
}

const source = "﻿export class Widget {}\r\n";
const moved = "﻿export class Widget {}\r\n// moved\r\n";

describe("file create/delete plans", () => {
  test.skipIf(process.platform === "win32")("preserves private and executable file modes through rename and edit under umask 022", async () => {
    const root = await fixture({ "src/widget.ts": source, "tsconfig.json": "{}\n" });
    const file = join(root, "src", "widget.ts"), target = join(root, "src", "Widget.ts");
    const previous = process.umask(0o022);
    try {
      for (const mode of [0o600, 0o770]) {
        await chmod(file, mode);
        const edit = await createPlan(request(root), async () => result([{ path: file, before: source, after: moved }]));
        await applyPlan(edit);
        expect((await stat(file)).mode & 0o777).toBe(mode);
        await writeFile(file, source);
        const rename = await createPlan(request(root, { operation: "rename-file" }), async () => result([
          { path: file, before: source, after: null }, { path: target, before: null, after: source },
        ]));
        await applyPlan(rename);
        expect((await stat(target)).mode & 0o777).toBe(mode);
        const journal = JSON.parse(await readFile(join(root, ".refactor-ai", `${rename.id}.journal.json`), "utf8"));
        expect(journal.changes.find((c: { kind: string }) => c.kind === "delete").beforeMode).toBe(mode);
        await rm(target);
        await writeFile(file, source);
      }
    } finally { process.umask(previous); }
  });

  test("plans a move into missing directories deterministically without touching disk", async () => {
    const root = await fixture({ "src/widget.ts": source, "tsconfig.json": "{}\n" });
    const target = join(root, "src", "ui", "controls", "Widget.ts");
    const analyze = async () => result([
      { path: join(root, "src", "widget.ts"), before: source, after: null },
      { path: target, before: null, after: moved },
    ]);
    const first = await createPlan(request(root, { target }), analyze);
    const second = await createPlan(request(root, { target }), analyze);

    expect(second).toEqual(first);
    expect(first.schemaVersion).toBe(2);
    expect(first.request.target).toBe(target);
    expect(first.changes.map(c => c.path)).toEqual([target, join(root, "src", "widget.ts")]);
    expect(await exists(join(root, "src", "ui"))).toBe(false);
    expect(await readFile(join(root, "src", "widget.ts"), "utf8")).toBe(source);

    const diff = preview(first);
    expect(diff).toContain("--- /dev/null\t\n+++ b/src/ui/controls/Widget.ts");
    expect(diff).toContain("--- a/src/widget.ts\t\n+++ /dev/null");
  });

  test("applies a move preserving BOM and CRLF and journals the deletion", async () => {
    const root = await fixture({ "src/widget.ts": source, "tsconfig.json": "{}\n" });
    const target = join(root, "src", "ui", "Widget.ts");
    const plan = await createPlan(request(root, { target }), async () => result([
      { path: join(root, "src", "widget.ts"), before: source, after: null },
      { path: target, before: null, after: moved },
    ]));
    const file = join(await fixture({}), "plan.json");
    await writeFile(file, JSON.stringify(plan));
    const applied = await applyPlan(await loadPlan(file));

    expect(applied.files.toSorted()).toEqual([target, join(root, "src", "widget.ts")].toSorted());
    expect(await exists(join(root, "src", "widget.ts"))).toBe(false);
    expect(await readFile(target)).toEqual(Buffer.from(moved, "utf8"));
    const journal = JSON.parse(await readFile(applied.journal!, "utf8"));
    expect(journal.status).toBe("applied");
    expect(journal.createdDirectories).toEqual([join(root, "src", "ui")]);
    const deletion = journal.changes.find((c: { kind: string }) => c.kind === "delete");
    expect(deletion).toMatchObject({ afterHash: null, before: source });
    await expect(applyPlan(plan)).rejects.toThrow("STALE_SNAPSHOT");
  });

  test("keeps edit-only plans at schema 1 and still loads legacy schema 1 plans", async () => {
    const root = await fixture({ "src/widget.ts": "a\n", "tsconfig.json": "{}\n" });
    const plan = await createPlan(request(root, { operation: "rename" }), async () => result([
      { path: join(root, "src", "widget.ts"), before: "a\n", after: "b\n" },
    ]));
    expect(plan.schemaVersion).toBe(1);
    // Older schema 1 plans have no permission metadata.
    delete plan.fileModes;
    plan.id = planId(plan);
    const file = join(await fixture({}), "plan.json");
    await writeFile(file, JSON.stringify(plan));
    await applyPlan(await loadPlan(file));
    expect(await readFile(join(root, "src", "widget.ts"), "utf8")).toBe("b\n");
  });

  test.skipIf(process.platform === "win32")("detects chmod-only changes before applying and rejects forged mode metadata", async () => {
    const root = await fixture({ "src/widget.ts": source, "tsconfig.json": "{}\n" });
    const file = join(root, "src", "widget.ts");
    await chmod(file, 0o600);
    const plan = await createPlan(request(root), async () => result([{ path: file, before: source, after: moved }]));
    await chmod(file, 0o640);
    await expect(applyPlan(plan)).rejects.toThrow("STALE_SNAPSHOT: file permissions changed");
    expect(await readFile(file, "utf8")).toBe(source);
    await expect(applyPlan(resign(plan, p => { p.fileModes![file].after = 0o777; }))).rejects.toThrow("INVALID_PLAN: invalid file modes");
  });

  test("supports a case-only rename on case-insensitive volumes", async () => {
    const root = await fixture({ "src/widget.ts": source, "tsconfig.json": "{}\n" });
    if (!await caseInsensitive(root)) return;
    const target = join(root, "src", "Widget.ts");
    const plan = await createPlan(request(root, { operation: "rename-file", target }), async () => result([
      { path: join(root, "src", "widget.ts"), before: source, after: null },
      { path: target, before: null, after: source },
    ]));
    await applyPlan(plan);
    expect(await readdir(join(root, "src"))).toEqual(["Widget.ts"]);
    expect(await readFile(target, "utf8")).toBe(source);
  });

  test("rolls back creations, deletions and created directories after a failure", async () => {
    const root = await fixture({
      "a.ts": "first\r\n", "src/widget.ts": source, "z-blocked/b.ts": "second\n", "tsconfig.json": "{}\n",
    });
    await mkdir(join(root, "pkg"));
    await chmod(join(root, "a.ts"), 0o770);
    await chmod(join(root, "src", "widget.ts"), 0o664);
    const target = join(root, "pkg", "new", "deep", "Widget.ts");
    const plan = await createPlan(request(root, { target }), async () => result([
      { path: join(root, "a.ts"), before: "first\r\n", after: null },
      { path: join(root, "src", "widget.ts"), before: source, after: "edited\n" },
      { path: target, before: null, after: moved },
      { path: join(root, "z-blocked", "b.ts"), before: "second\n", after: null },
    ]));
    await chmod(join(root, "z-blocked"), 0o500);
    try {
      await expect(applyPlan(plan)).rejects.toThrow();
    } finally { await chmod(join(root, "z-blocked"), 0o700); }

    expect(await readFile(join(root, "a.ts"), "utf8")).toBe("first\r\n");
    expect((await stat(join(root, "a.ts"))).mode & 0o777).toBe(0o770);
    expect((await stat(join(root, "src", "widget.ts"))).mode & 0o777).toBe(0o664);
    expect(await readFile(join(root, "src", "widget.ts"), "utf8")).toBe(source);
    expect(await readFile(join(root, "z-blocked", "b.ts"), "utf8")).toBe("second\n");
    expect(await exists(join(root, "pkg", "new"))).toBe(false);
    expect(await exists(join(root, "pkg"))).toBe(true); // pre-existing empty directory is kept
    const journal = JSON.parse(await readFile(join(root, ".refactor-ai", `${plan.id}.journal.json`), "utf8"));
    expect(journal.status).toBe("rolled-back");
    expect(await exists(join(root, ".refactor-ai", "apply.lock"))).toBe(false);
  });

  test("rejects stale sources and destinations that appear after planning", async () => {
    const root = await fixture({ "src/widget.ts": source, "tsconfig.json": "{}\n" });
    const target = join(root, "lib", "Widget.ts");
    const make = () => createPlan(request(root, { target }), async () => result([
      { path: join(root, "src", "widget.ts"), before: source, after: null },
      { path: target, before: null, after: moved },
    ]));

    const edited = await make();
    await writeFile(join(root, "src", "widget.ts"), "external\n");
    await expect(applyPlan(edited)).rejects.toThrow("STALE_SNAPSHOT");
    expect(await readFile(join(root, "src", "widget.ts"), "utf8")).toBe("external\n");
    expect(await exists(join(root, "lib"))).toBe(false);

    await writeFile(join(root, "src", "widget.ts"), source);
    const collided = await make();
    await mkdir(join(root, "lib"));
    await writeFile(target, "someone else\n");
    await expect(applyPlan(collided)).rejects.toThrow("STALE_SNAPSHOT");
    expect(await readFile(target, "utf8")).toBe("someone else\n");
    expect(await readFile(join(root, "src", "widget.ts"), "utf8")).toBe(source);
  });

  test("rejects collisions, case conflicts and malformed changes while planning", async () => {
    const root = await fixture({ "src/widget.ts": source, "models/Bar.ts": "bar\n", "tsconfig.json": "{}\n" });
    const plan = (changes: BackendResult["changes"]) => createPlan(request(root), async () => result(changes));

    await expect(plan([{ path: join(root, "models", "Bar.ts"), before: null, after: "x\n" }])).rejects.toThrow("TARGET_EXISTS");
    if (await caseInsensitive(root)) {
      // The existing directory's on-disk spelling wins during canonicalization.
      const canonical = await plan([{ path: join(root, "Models", "Foo.ts"), before: null, after: "x\n" }]);
      expect(canonical.changes[0].path).toBe(join(root, "models", "Foo.ts"));
    } else {
      await expect(plan([{ path: join(root, "Models", "Foo.ts"), before: null, after: "x\n" }])).rejects.toThrow("CASE_CONFLICT");
    }
    await expect(plan([
      { path: join(root, "new", "a.ts"), before: null, after: "x\n" },
      { path: join(root, "new", "A.ts"), before: null, after: "y\n" },
    ])).rejects.toThrow("CASE_CONFLICT");
    await expect(plan([{ path: join(root, "src", "widget.ts"), before: null, after: null }])).rejects.toThrow("INVALID_CHANGE");
    await expect(plan([{ path: join(root, "src", "widget.ts"), before: "stale\n", after: null }])).rejects.toThrow("BEFORE_MISMATCH");
    await expect(plan([{ path: join(root, "src"), before: null, after: "x\n" }])).rejects.toThrow("NOT_A_FILE");
    await expect(plan([{ path: join(root, "src", "widget.ts", "x.ts"), before: null, after: "x\n" }])).rejects.toThrow("NOT_A_DIRECTORY");
    expect(await readdir(root)).toEqual(expect.arrayContaining(["models", "src", "tsconfig.json"]));
  });

  test("refuses paths outside the root, in excluded directories or through symlinks", async () => {
    const root = await fixture({ "src/widget.ts": source, "tsconfig.json": "{}\n" });
    const outside = await fixture({});
    const plan = (changes: BackendResult["changes"], extra: Partial<RefactorRequest> = {}) =>
      createPlan(request(root, extra), async () => result(changes));

    await expect(plan([{ path: join(root, "..", "escape", "x.ts"), before: null, after: "x\n" }])).rejects.toThrow("OUTSIDE_ROOT");
    await expect(plan([{ path: join(root, "node_modules", "x.ts"), before: null, after: "x\n" }])).rejects.toThrow("EXCLUDED_PATH");
    await expect(plan([], { target: join(outside, "x.ts") })).rejects.toThrow("OUTSIDE_ROOT");
    await expect(plan([], { targetProject: join(outside, "missing.json") })).rejects.toThrow();

    const target = join(root, "lib", "Widget.ts");
    const pending = await plan([{ path: target, before: null, after: moved }]);
    await symlink(outside, join(root, "lib"));
    // The new link makes the plan stale; a plan made with the link present refuses to write through it.
    await expect(applyPlan(pending)).rejects.toThrow("STALE_SNAPSHOT");
    await expect(plan([{ path: target, before: null, after: moved }])).rejects.toThrow(/SYMLINK_UNSUPPORTED|OUTSIDE_ROOT/);
    expect(await readdir(outside)).toEqual([]);
  });

  test("rejects tampered or schema-inconsistent plans even when re-signed", async () => {
    const root = await fixture({ "src/widget.ts": source, "tsconfig.json": "{}\n" });
    const target = join(root, "lib", "Widget.ts");
    const plan = await createPlan(request(root, { target }), async () => result([
      { path: join(root, "src", "widget.ts"), before: source, after: null },
      { path: target, before: null, after: moved },
    ]));
    const file = join(await fixture({}), "plan.json");
    const load = async (value: unknown) => { await writeFile(file, JSON.stringify(value)); return loadPlan(file); };

    await expect(load({ ...plan, changes: [plan.changes[0]] })).rejects.toThrow("integrity check failed");
    await expect(load(resign(plan, p => { p.schemaVersion = 1; }))).rejects.toThrow("schema 2");
    await expect(load(resign(plan, p => { p.changes[1].before = null; }))).rejects.toThrow("invalid change");
    await expect(load(resign(plan, p => { p.changes[1].before = "other\n"; }))).rejects.toThrow("does not match snapshot");
    await expect(load(resign(plan, p => { p.changes.reverse(); }))).rejects.toThrow("unsorted");
    await expect(load(resign(plan, p => { p.changes[0].path = `${root}/lib/../lib/Widget.ts`; }))).rejects.toThrow("noncanonical");
    await expect(applyPlan(resign(plan, p => { (p as { schemaVersion: number }).schemaVersion = 3; }))).rejects.toThrow("INVALID_PLAN");
    expect(await readFile(join(root, "src", "widget.ts"), "utf8")).toBe(source);
  });
});
