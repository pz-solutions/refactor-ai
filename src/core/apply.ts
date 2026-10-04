import { lstat, mkdir, open, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertFresh, assertPlanShape, changeKind, newDiagnostics, type ChangeKind, type Plan } from "./plan.ts";
import { assertRegularPath, missingDirectories, sha256 } from "./snapshot.ts";

interface Journal {
  schemaVersion: 2;
  planId: string;
  status: "writing" | "applied" | "rolled-back" | "recovery-needed";
  /** `before` keeps deleted/edited content recoverable; a null afterHash marks a deletion. */
  changes: { path: string; kind: ChangeKind; before: string | null; afterHash: string | null; beforeMode?: number | null; afterMode?: number | null }[];
  /** Directories this apply created (outermost first); rollback removes them only when empty. */
  createdDirectories: string[];
}

type Change = Plan["changes"][number];
interface Step { change: Change; kind: ChangeKind; mode?: number }

async function readOrNull(path: string): Promise<Buffer | null> {
  return readFile(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
}

const sameContent = (current: Buffer | null, expected: string | null) =>
  expected === null ? current === null : current !== null && sha256(current) === sha256(expected);

async function atomicWrite(path: string, content: string, mode?: number, expectedContent?: string | null): Promise<void> {
  const temporary = resolve(dirname(path), `.refactor-write-${randomUUID()}`);
  try {
    // Stage privately, then restore the exact requested mode independently of umask.
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      if (mode !== undefined) await handle.chmod(mode & 0o777);
      await handle.sync();
    }
    finally { await handle.close(); }
    // Recheck after staging, immediately before replacement. External editors
    // do not share our lock, so filesystem-level compare-and-swap is not promised.
    if (expectedContent !== undefined && !sameContent(await readOrNull(path), expectedContent)) {
      throw new Error(`STALE_SNAPSHOT: ${path} changed while staging the write`);
    }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Create missing parents one level at a time, recording only directories this run made. */
async function ensureDirectories(root: string, file: string, created: string[]): Promise<void> {
  for (const directory of await missingDirectories(root, file)) {
    try { await mkdir(directory); created.push(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await lstat(directory);
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(`NOT_A_DIRECTORY: ${directory}`);
    }
  }
}

const fileId = (s: { dev: number; ino: number }) => `${s.dev}:${s.ino}`;

/**
 * Write order keeps an interrupted run recoverable without losing content:
 * new files first, then edits, then deletions. Creations that are case aliases
 * of a deleted file (case-only rename) must run after that deletion.
 */
async function order(plan: Plan): Promise<Step[]> {
  const steps = plan.changes.map(change => ({ change, kind: changeKind(change) }));
  const deleted = new Set<string>();
  for (const step of steps) if (step.kind === "delete") deleted.add(fileId(await lstat(step.change.path)));
  const aliases = new Set<Change>();
  for (const step of steps) {
    if (step.kind !== "create") continue;
    const existing = await lstat(step.change.path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!existing) continue;
    if (!deleted.has(fileId(existing))) throw new Error(`STALE_SNAPSHOT: ${step.change.path} already exists`);
    aliases.add(step.change);
  }
  const rank = (step: Step) =>
    step.kind === "create" ? (aliases.has(step.change) ? 3 : 0) : step.kind === "edit" ? 1 : 2;
  return steps.toSorted((a, b) => rank(a) - rank(b));
}

export async function applyPlan(plan: Plan): Promise<{ status: "applied"; files: string[]; journal: string | null }> {
  assertPlanShape(plan);
  if (plan.validation.status !== "passed" || newDiagnostics(plan.diagnosticsBefore, plan.diagnosticsAfter).length) {
    throw new Error("VALIDATION_FAILED: plan adds compiler errors");
  }
  const root = plan.request.root;
  const stateDirectory = resolve(root, ".refactor-ai");
  await mkdir(stateDirectory, { recursive: true });
  // Reserved state directory may not be redirected outside the project.
  if ((await lstat(stateDirectory)).isSymbolicLink()) throw new Error("SYMLINK_UNSUPPORTED: state directory");
  const lock = resolve(stateDirectory, "apply.lock");
  try { await mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("APPLY_LOCKED: another apply or interrupted transaction; inspect .refactor-ai/apply.lock");
    throw error;
  }
  const journalPath = resolve(stateDirectory, `${plan.id}.journal.json`);
  const written: Step[] = [];
  const createdDirectories: string[] = [];
  const journal: Journal = {
    schemaVersion: 2, planId: plan.id, status: "writing",
    changes: plan.changes.map(c => ({
      path: c.path, kind: changeKind(c), before: c.before, afterHash: c.after === null ? null : sha256(c.after),
      ...(plan.fileModes?.[c.path] ? { beforeMode: plan.fileModes[c.path].before, afterMode: plan.fileModes[c.path].after } : {}),
    })),
    createdDirectories,
  };
  const saveJournal = () => atomicWrite(journalPath, JSON.stringify(journal, null, 2) + "\n");
  try {
    await assertFresh(plan);
    if (!plan.changes.length) return { status: "applied", files: [], journal: null };
    const steps = await order(plan);
    // Populate recovery metadata for older plans too, before any source writes.
    const sourceMode = (await stat(plan.request.file)).mode & 0o777;
    for (const step of steps) {
      const record = journal.changes.find(item => item.path === step.change.path)!;
      record.beforeMode = step.kind === "create" ? null : (await stat(step.change.path)).mode & 0o777;
      record.afterMode = step.kind === "delete" ? null : plan.fileModes?.[step.change.path]?.after ?? record.beforeMode
        ?? (["move-type", "rename-file"].includes(plan.request.operation) ? sourceMode : 0o600);
    }
    await saveJournal();
    for (const step of steps) {
      const { change, kind } = step;
      if (kind === "create") {
        const before = createdDirectories.length;
        await ensureDirectories(root, change.path, createdDirectories);
        if (createdDirectories.length !== before) await saveJournal();
      }
      await assertRegularPath(root, change.path, kind === "create");
      const current = await readOrNull(change.path);
      if (!sameContent(current, change.before)) throw new Error(`STALE_SNAPSHOT: ${change.path} changed during apply`);
      const mode = current === null ? undefined : (await stat(change.path)).mode & 0o777;
      const record = journal.changes.find(item => item.path === change.path)!;
      if (mode !== undefined && mode !== record.beforeMode) throw new Error(`STALE_SNAPSHOT: permissions changed during apply: ${change.path}`);
      if (kind === "delete") await unlink(change.path);
      else await atomicWrite(change.path, change.after!, record.afterMode ?? undefined, change.before);
      written.push({ ...step, mode });
    }
    journal.status = "applied";
    await saveJournal();
    return { status: "applied", files: written.map(s => s.change.path), journal: journalPath };
  } catch (error) {
    let recoveryNeeded = false;
    for (const { change, kind, mode } of written.toReversed()) {
      try {
        await assertRegularPath(root, change.path, true);
        const current = await readOrNull(change.path);
        // Never overwrite or remove content that is no longer exactly ours.
        if (kind === "delete") {
          if (current === null) await atomicWrite(change.path, change.before!, mode, null);
          else if (!sameContent(current, change.before)) recoveryNeeded = true;
        } else if (!sameContent(current, change.after)) {
          if (!(kind === "create" && current === null)) recoveryNeeded = true;
        } else if (kind === "create") await unlink(change.path);
        else await atomicWrite(change.path, change.before!, mode, change.after);
      } catch { recoveryNeeded = true; }
    }
    for (const directory of createdDirectories.toReversed()) {
      // rmdir only succeeds on empty directories, so external files are kept.
      await rmdir(directory).catch(() => {});
    }
    if (written.length || createdDirectories.length) {
      journal.status = recoveryNeeded ? "recovery-needed" : "rolled-back";
      await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n").catch(() => {});
    }
    if (recoveryNeeded) throw new Error(`RECOVERY_NEEDED: inspect ${journalPath}; ${String(error)}`);
    throw error;
  } finally { await rm(lock, { recursive: true, force: true }); }
}
