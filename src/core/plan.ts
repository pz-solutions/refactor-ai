import { assertReadSetFresh, assertReadSetShape, type ReadSetEntry } from "./read-set";
import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { BackendResult, CheckerIdentity, Diagnostic, FileChange, RefactorRequest } from "../types.ts";
import { assertRegularPath, canonicalMissing, inside, sha256, snapshot, snapshotChanges, type Snapshot } from "./snapshot.ts";

/**
 * Schema 1: edits and file creations (`after` is always a string).
 * Schema 2: adds deletions (`after: null`) and creations below parent
 * directories that do not exist yet. New plans use 2 only when a change
 * creates or deletes a file. Schema 3 adds recorded compiler reads (including
 * negative probes and matching directory queries) for scoped freshness. Backends
 * without read tracking and legacy schema 1/2 plans retain whole-root freshness.
 */
export type PlanSchemaVersion = 1 | 2 | 3;

export interface Plan {
  /** Schema 3: exact filesystem reads used for analysis, instead of whole-root freshness. */
  readSet?: ReadSetEntry[];
  checker?: CheckerIdentity;
  schemaVersion: PlanSchemaVersion;
  id: string;
  request: RefactorRequest;
  backend: string;
  backendVersion: string;
  snapshot: Snapshot;
  changes: BackendResult["changes"];
  validation: { status: "passed" | "failed"; newDiagnostics: Diagnostic[] };
  diagnosticsBefore: Diagnostic[];
  diagnosticsAfter: Diagnostic[];
  notes: string[];
  /** Optional for legacy plans; source moves inherit source permissions. */
  fileModes?: Record<string, { before: number | null; after: number | null }>;
}

export function newDiagnostics(before: Diagnostic[], after: Diagnostic[]): Diagnostic[] {
  const key = (d: Diagnostic) => JSON.stringify([d.file, d.code, d.message]);
  const counts = new Map<string, number>();
  for (const item of before) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return after.filter(item => {
    const count = counts.get(key(item)) ?? 0;
    if (!count) return true;
    counts.set(key(item), count - 1);
    return false;
  });
}

export function planId(plan: Omit<Plan, "id"> | Plan): string {
  const { id: _id, ...body } = plan as Plan;
  return sha256(JSON.stringify(body));
}

export type ChangeKind = "create" | "edit" | "delete";

export function changeKind(change: FileChange): ChangeKind {
  if (change.before === null && change.after === null) throw new Error(`INVALID_CHANGE: ${change.path} has neither before nor after content`);
  return change.before === null ? "create" : change.after === null ? "delete" : "edit";
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Reject plans whose resulting tree would hold two paths differing only by
 * case or Unicode normalization, which collide on default macOS/Windows
 * filesystems. Applied regardless of the local filesystem for determinism.
 */
function caseConflict(root: string, files: Snapshot["files"], changes: FileChange[]): string | undefined {
  const removed = new Set(changes.filter(c => c.after === null).map(c => relative(root, c.path)));
  const created = changes.filter(c => c.before === null).map(c => relative(root, c.path));
  const spellings = new Map<string, Set<string>>();
  const record = (file: string) => {
    const parts = file.split(sep);
    for (let i = 1; i <= parts.length; i++) {
      const exact = parts.slice(0, i).join(sep);
      const key = exact.normalize("NFC").toLowerCase();
      const set = spellings.get(key) ?? new Set<string>();
      set.add(exact);
      spellings.set(key, set);
    }
  };
  for (const file of Object.keys(files)) if (!removed.has(file)) record(file);
  for (const file of created) record(file);
  for (const file of created) {
    const parts = file.split(sep);
    for (let i = 1; i <= parts.length; i++) {
      if ((spellings.get(parts.slice(0, i).join(sep).normalize("NFC").toLowerCase())?.size ?? 0) > 1) return resolve(root, file);
    }
  }
  return undefined;
}

/** Structural and integrity validation shared by loadPlan and applyPlan. */
export function assertPlanShape(plan: Plan): void {
  if ((plan?.schemaVersion !== 1 && plan?.schemaVersion !== 2 && plan?.schemaVersion !== 3) || !plan.request || typeof plan.request.root !== "string" ||
      !Array.isArray(plan.changes) || !plan.snapshot || !plan.validation ||
      !Array.isArray(plan.diagnosticsBefore) || !Array.isArray(plan.diagnosticsAfter)) {
    throw new Error("INVALID_PLAN: unsupported or malformed plan");
  }
  if (plan.id !== planId(plan)) throw new Error("INVALID_PLAN: plan integrity check failed");
  if (plan.snapshot.hash !== sha256(JSON.stringify(plan.snapshot.files))) throw new Error("INVALID_PLAN: invalid snapshot");
  if (plan.schemaVersion === 3) assertReadSetShape(plan.readSet!);
  else if (plan.readSet !== undefined) throw new Error("INVALID_PLAN: read set requires schema 3");
  const added = newDiagnostics(plan.diagnosticsBefore, plan.diagnosticsAfter);
  if (JSON.stringify(added) !== JSON.stringify(plan.validation.newDiagnostics) ||
      plan.validation.status !== (added.length ? "failed" : "passed")) {
    throw new Error("INVALID_PLAN: inconsistent validation");
  }
  const seen = new Set<string>();
  let previous = "";
  for (const change of plan.changes) {
    if (!change || typeof change.path !== "string" ||
        (change.before !== null && typeof change.before !== "string") ||
        (change.after !== null && typeof change.after !== "string") ||
        (change.before === null && change.after === null) || change.before === change.after) {
      throw new Error("INVALID_PLAN: invalid change");
    }
    if (change.after === null && plan.schemaVersion < 2) throw new Error("INVALID_PLAN: deletions require plan schema 2");
    const path = inside(plan.request.root, change.path);
    if (path !== change.path || seen.has(path) || path < previous) throw new Error("INVALID_PLAN: duplicate, unsorted or noncanonical path");
    seen.add(path);
    previous = path;
    const expected = plan.snapshot.files[relative(plan.request.root, path)];
    if (change.before === null ? expected !== undefined : sha256(Buffer.from(change.before)) !== expected) {
      throw new Error(`INVALID_PLAN: before content does not match snapshot: ${path}`);
    }
  }
  const conflict = caseConflict(plan.request.root, plan.snapshot.files, plan.changes);
  if (conflict) throw new Error(`INVALID_PLAN: case-insensitive path collision: ${conflict}`);
  if (plan.fileModes !== undefined) {
    if (!plan.fileModes || Object.keys(plan.fileModes).length !== plan.changes.length) throw new Error("INVALID_PLAN: invalid file modes");
    const validMode = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0o777;
    for (const change of plan.changes) {
      const modes = plan.fileModes[change.path];
      if (!modes || (change.before === null ? modes.before !== null : !validMode(modes.before)) ||
          (change.after === null ? modes.after !== null : !validMode(modes.after)) ||
          (change.before !== null && change.after !== null && modes.before !== modes.after)) {
        throw new Error(`INVALID_PLAN: invalid file modes: ${change.path}`);
      }
    }
  }
}

async function canonicalRequest(request: RefactorRequest): Promise<RefactorRequest> {
  const root = await realpath(request.root);
  const result: RefactorRequest = { ...request, root, project: await realpath(request.project), file: await realpath(request.file) };
  await assertRegularPath(root, result.project);
  const directory = (request.operation === "move-file" && (await lstat(result.file)).isDirectory()) || request.operation === "retarget-import";
  await assertRegularPath(root, result.file, false, directory);
  if (request.targetProject !== undefined) {
    result.targetProject = await realpath(request.targetProject);
    await assertRegularPath(root, result.targetProject);
  }
  if (request.target !== undefined) {
    result.target = inside(root, await canonicalMissing(request.target));
    await assertRegularPath(root, result.target, true, directory);
  }
  return result;
}

const fileId = (stat: { dev: number; ino: number }) => `${stat.dev}:${stat.ino}`;

export async function createPlan(
  request: RefactorRequest,
  analyze: (request: RefactorRequest) => Promise<BackendResult>,
  compilerBase?: string,
): Promise<Plan> {
  request = await canonicalRequest(request);
  const root = request.root;
  const before = await snapshot(root);
  const result = await analyze(request);
  const after = result.readSet || !result.changes.length ? before : await snapshot(root);
  if (result.changes.length && result.readSet) await assertReadSetFresh(result.readSet, compilerBase);
  if (result.changes.length && !result.readSet && after.hash !== before.hash) throw new Error(`STALE_SNAPSHOT: project changed during analysis: ${snapshotChanges(before, after)}; retry after writers settle (including dev-server generators)`);
  const seen = new Set<string>();
  const changes: Plan["changes"] = [];
  for (const change of result.changes) {
    const kind = changeKind(change);
    // Never realpath a creation target itself: on a case-insensitive volume it
    // would resolve to an existing file that differs only by case.
    const path = inside(root, kind === "create" ? await canonicalMissing(change.path) : await realpath(change.path));
    if (seen.has(path)) throw new Error(`DUPLICATE_CHANGE: ${path}`);
    seen.add(path);
    if (kind === "create") {
      if (before.files[relative(root, path)] !== undefined) throw new Error(`TARGET_EXISTS: ${path}`);
    } else {
      await assertRegularPath(root, path);
      if (sha256(Buffer.from(change.before!)) !== before.files[relative(root, path)]) throw new Error(`BEFORE_MISMATCH: ${path}`);
    }
    if (change.before !== change.after) changes.push({ path, before: change.before, after: change.after });
  }
  // A creation target may already exist on disk only as a case alias of a file
  // this plan deletes (case-only rename on a case-insensitive volume).
  const deleted = new Set<string>();
  for (const change of changes) if (change.after === null) deleted.add(fileId(await lstat(change.path)));
  for (const change of changes) {
    if (change.before !== null) continue;
    await assertRegularPath(root, change.path, true);
    const existing = await lstat(change.path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (existing && !deleted.has(fileId(existing))) throw new Error(`TARGET_EXISTS: ${change.path}`);
  }
  changes.sort(byPath);
  const fileModes: NonNullable<Plan["fileModes"]> = {};
  const createdMode = ["move-type", "rename-file"].includes(request.operation) ? (await lstat(request.file)).mode & 0o777 : 0o600;
  const creationMode = async (path: string): Promise<number> => {
    if (request.operation !== "move-file" || !request.target) return createdMode;
    const directory = (await lstat(request.file)).isDirectory();
    if (!directory && path !== request.target) return createdMode;
    const source = directory
      ? resolve(request.file, relative(request.target, path)) : request.file;
    if (!changes.some(change => change.path === source && change.after === null)) return 0o600;
    return (await lstat(source)).mode & 0o777;
  };
  for (const change of changes) {
    const beforeMode = change.before === null ? null : (await lstat(change.path)).mode & 0o777;
    fileModes[change.path] = { before: beforeMode, after: change.after === null ? null : beforeMode ?? await creationMode(change.path) };
  }
  const conflict = caseConflict(root, before.files, changes);
  if (conflict) throw new Error(`CASE_CONFLICT: ${conflict} differs only by case from another path`);
  const added = newDiagnostics(result.diagnosticsBefore, result.diagnosticsAfter);
  // Schema 3 keeps only edit preconditions in snapshot; compiler reads have
  // their own observations. Unrelated root content cannot affect the plan ID.
  const files = Object.fromEntries(changes.filter(change => change.before !== null)
    .map(change => [relative(root, change.path), before.files[relative(root, change.path)]!]));
  const plannedSnapshot = result.readSet ? { files, hash: sha256(JSON.stringify(files)) } : before;
  const body: Omit<Plan, "id"> = {
    ...(result.readSet ? { readSet: JSON.parse(JSON.stringify(result.readSet)) as ReadSetEntry[] } : {}),
    schemaVersion: result.readSet ? 3 : changes.some(c => c.before === null || c.after === null) ? 2 : 1, request, backend: result.backend, backendVersion: result.version,
    snapshot: plannedSnapshot, changes, fileModes,
    ...(result.checker ? { checker: { ...result.checker } } : {}),
    validation: { status: added.length ? "failed" : "passed", newDiagnostics: added },
    diagnosticsBefore: result.diagnosticsBefore,
    diagnosticsAfter: result.diagnosticsAfter,
    notes: result.notes,
  };
  return { ...body, id: planId(body) };
}

export async function loadPlan(path: string): Promise<Plan> {
  let plan: Plan;
  try { plan = JSON.parse(await readFile(path, "utf8")) as Plan; }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("INVALID_PLAN: plan is not valid JSON");
    throw error;
  }
  assertPlanShape(plan);
  return plan;
}

export async function assertFresh(plan: Plan, compilerBase?: string): Promise<void> {
  if (plan.id !== planId(plan)) throw new Error("INVALID_PLAN: plan integrity check failed");
  if ((await realpath(plan.request.root)) !== plan.request.root) throw new Error("INVALID_PLAN: noncanonical root");
  if (!plan.changes.length) return;
  if (plan.readSet) {
    for (const change of plan.changes) {
      await assertRegularPath(plan.request.root, change.path, change.before === null).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`STALE_SNAPSHOT: removed ${change.path}`);
        throw error;
      });
      const text = await readFile(change.path).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (text === null ? change.before !== null : change.before === null || sha256(text) !== sha256(change.before)) throw new Error(`STALE_SNAPSHOT: changed ${change.path}`);
    }
  }
  if (plan.readSet) await assertReadSetFresh(plan.readSet, compilerBase);
  if (plan.readSet && plan.changes.some(change => change.before === null)) {
    const conflict = caseConflict(plan.request.root, (await snapshot(plan.request.root)).files, plan.changes);
    if (conflict) throw new Error(`STALE_SNAPSHOT: case-insensitive path collision: ${conflict}`);
  }
  const current = plan.readSet ? plan.snapshot : await snapshot(plan.request.root);
  if (current.hash !== plan.snapshot.hash) throw new Error(`STALE_SNAPSHOT: project changed: ${snapshotChanges(plan.snapshot, current)}; create a new plan after writers settle`);
  for (const [path, modes] of Object.entries(plan.fileModes ?? {})) {
    if (modes.before !== null && ((await lstat(path)).mode & 0o777) !== modes.before) {
      throw new Error(`STALE_SNAPSHOT: file permissions changed; create a new plan: ${path}`);
    }
  }
}

export function preview(plan: Plan): string {
  return plan.changes.map(change => {
    const name = relative(plan.request.root, change.path);
    return createTwoFilesPatch(change.before === null ? "/dev/null" : `a/${name}`, change.after === null ? "/dev/null" : `b/${name}`,
      change.before ?? "", change.after ?? "", "", "", { context: 3 });
  }).join("\n");
}
