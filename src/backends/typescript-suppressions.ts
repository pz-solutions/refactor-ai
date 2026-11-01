import { readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { packageFor } from "./typescript-package-specifiers";
import { portablePath } from "./typescript-paths";
import { fail, isInside } from "./typescript-vfs";
import type { Workspace } from "./typescript-workspace";

type Rules = Record<string, { count: number }>;
interface Ledger { entries: Record<string, Rules>; sorted: boolean; }

function nearestLedger(ws: Workspace, file: string): string | undefined {
  for (let directory = dirname(file); isInside(ws.root, directory); directory = dirname(directory)) {
    const path = resolve(directory, "eslint-suppressions.json");
    if (ws.vfs.fileExists(path)) return path;
    if (ws.vfs.samePath(directory, ws.root)) break;
  }
  return undefined;
}

function newLedger(ws: Workspace, file: string): string | undefined {
  const directory = packageFor(ws, file)?.directory ?? dirname(ws.targetConfig);
  let names: string[];
  try { names = readdirSync(directory); } catch { return undefined; }
  return names.some(name => /^eslint\.config\.[cm]?[jt]s$/.test(name) && ws.vfs.fileExists(resolve(directory, name)))
    ? resolve(directory, "eslint-suppressions.json") : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readLedger(ws: Workspace, path: string): Ledger {
  const text = ws.vfs.readFile(path);
  let entries: unknown = {};
  try { if (text !== undefined) entries = JSON.parse(text); } catch { fail("INVALID_SUPPRESSIONS", path); }
  if (!record(entries) || Object.values(entries).some(rules => !record(rules)
    || Object.values(rules).some(rule => !record(rule) || !Number.isSafeInteger(rule.count) || (rule.count as number) < 0))) {
    fail("INVALID_SUPPRESSIONS", `${path}: expected file entries containing rule counts`);
  }
  const keys = Object.keys(entries);
  const sorted = [...keys].sort();
  return { entries: entries as Record<string, Rules>, sorted: keys.every((key, index) => key === sorted[index]) };
}

/** Transfer the original entries as a batch, so directory moves and shared source/destination ledgers merge safely. */
export function moveSuppressions(ws: Workspace, renames: [string, string][], notes: string[]): void {
  const ledgers = new Map<string, Ledger>();
  const ledger = (path: string) => {
    if (!ledgers.has(path)) ledgers.set(path, readLedger(ws, path));
    return ledgers.get(path)!;
  };
  const transfers = renames.flatMap(([from, to]) => {
    const source = nearestLedger(ws, from);
    if (!source) return [];
    const key = portablePath(relative(dirname(source), from));
    const entries = ledger(source).entries;
    if (!Object.hasOwn(entries, key)) return [];
    const destination = nearestLedger(ws, to) ?? newLedger(ws, to);
    if (destination) ledger(destination);
    return [{ source, key, rules: entries[key]!, destination, to }];
  });
  for (const { source, key } of transfers) delete ledger(source).entries[key];
  for (const { source, key, rules, destination, to } of transfers) {
    const label = `${portablePath(relative(ws.root, source))}:${key}`;
    if (!destination) {
      notes.push(`Dropped ESLint suppressions for ${label}; ${portablePath(relative(ws.root, to))} has no destination ledger or package eslint.config.*; review suppressions.`);
      continue;
    }
    const targetKey = portablePath(relative(dirname(destination), to));
    const entries = ledger(destination).entries;
    if (!Object.hasOwn(entries, targetKey)) Object.defineProperty(entries, targetKey, { value: {}, enumerable: true, configurable: true, writable: true });
    const target = entries[targetKey]!;
    for (const [rule, value] of Object.entries(rules)) {
      const count = (Object.hasOwn(target, rule) ? target[rule]!.count : 0) + value.count;
      if (!Number.isSafeInteger(count)) fail("INVALID_SUPPRESSIONS", `${destination}: count overflow for ${rule}`);
      Object.defineProperty(target, rule, { value: { ...value, count }, enumerable: true, configurable: true, writable: true });
    }
    notes.push(`Moved ESLint suppressions ${label} -> ${portablePath(relative(ws.root, destination))}:${targetKey}.`);
  }
  const changed = new Set(transfers.flatMap(item => [item.source, ...(item.destination ? [item.destination] : [])]));
  for (const path of changed) {
    const { entries, sorted } = ledger(path);
    const ordered = sorted ? Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entries;
    ws.vfs.write(path, JSON.stringify(ordered, null, 2) + "\n");
  }
}
