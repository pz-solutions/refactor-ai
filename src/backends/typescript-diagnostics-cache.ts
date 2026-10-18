import ts from "typescript";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Diagnostic } from "../types";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
type Method = "readFile" | "fileExists" | "directoryExists" | "getDirectories" | "readDirectory" | "realpath";
const methods = ["readFile", "fileExists", "directoryExists", "getDirectories", "readDirectory", "realpath"] as const;
interface Input { method: Method; args: any[]; digest: string; }
interface Entry { version: 1; key: string; inputs: Input[]; diagnostics: Diagnostic[]; checksum: string; }

/** Observe compiler filesystem inputs, including negative resolution probes and directory membership. */
export class CompilerInputs {
  private readonly inputs = new Map<string, Input>();
  private consistent = true;
  readonly sys: ts.System;

  constructor(readonly enabled = process.env.REFACTOR_AI_CACHE === "on") {
    this.sys = { ...ts.sys };
    if (!enabled) return;
    for (const method of methods) {
      const original = ts.sys[method];
      if (!original) continue;
      (this.sys as any)[method] = (...args: any[]) => {
        const value = (original as Function)(...args);
        const key = JSON.stringify([method, args]), digest = hash(value);
        if (this.inputs.has(key) && this.inputs.get(key)!.digest !== digest) this.consistent = false;
        this.inputs.set(key, { method, args, digest });
        return value;
      };
    }
  }

  snapshot(): Input[] { return [...this.inputs.values()]; }
  unchanged(): boolean {
    try { return this.consistent && this.snapshot().every(current); } catch { return false; }
  }
}

function current(input: Input): boolean {
  if (!input || !methods.includes(input.method) || !Array.isArray(input.args) || typeof input.digest !== "string") return false;
  const method = ts.sys[input.method];
  return !!method && hash((method as Function)(...input.args)) === input.digest;
}

/** Avoid following a cache directory or entry symlink, including an overridden location. */
function regularDirectory(path: string, create: boolean): boolean {
  const parent = dirname(path);
  if (parent !== path && !regularDirectory(parent, create)) return false;
  try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) return false;
    mkdirSync(path, { mode: 0o700 });
    return true;
  }
}

/**
 * Baseline only. The planned program is always checked. The key includes every
 * compiler source (including libraries outside root), options, root names and
 * per-source module format. A hit additionally replays ALL observed filesystem
 * queries: content, negative lookups, directory listings and symlink targets.
 * Thus a new dependency, config file, ambient type or package export invalidates
 * the entry even when the user file's text did not change.
 */
export function baselineDiagnostics(
  root: string, config: string, program: ts.Program, only: Set<string> | undefined,
  inputs: CompilerInputs, compute: () => Diagnostic[],
): Diagnostic[] {
  if (process.env.REFACTOR_AI_CACHE !== "on" || !inputs.enabled) return compute();
  const options = { ...program.getCompilerOptions(), configFile: undefined };
  const key = hash([1, ts.version, ts.sys.useCaseSensitiveFileNames, config, options,
    program.getRootFileNames(), only ? [...only].sort() : null,
    program.getSourceFiles().map(source => [source.fileName, hash(source.text), source.impliedNodeFormat])]);
  const directory = resolve(process.env.REFACTOR_AI_CACHE_DIR ?? resolve(root, ".refactor-ai/cache"));
  const path = resolve(directory, `${key}.json`);
  try {
    if (regularDirectory(directory, false) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) {
      const entry = JSON.parse(readFileSync(path, "utf8")) as Entry;
      const { checksum, ...body } = entry;
      if (entry.version === 1 && entry.key === key && checksum === hash(body)
        && Array.isArray(entry.inputs) && entry.inputs.every(current)
        && Array.isArray(entry.diagnostics) && entry.diagnostics.every(item => typeof item.file === "string" && typeof item.code === "string" && typeof item.message === "string")) {
        return entry.diagnostics;
      }
    }
  } catch { /* Missing, stale or malformed cache is a miss. */ }
  const diagnostics = compute();
  try {
    const observed = inputs.snapshot();
    // Do not persist a result when an external compiler input changed while it was checked.
    if (inputs.unchanged() && regularDirectory(directory, true)) {
      if (!process.env.REFACTOR_AI_CACHE_DIR) {
        try { writeFileSync(resolve(root, ".refactor-ai/.gitignore"), "*\n", { flag: "wx", mode: 0o600 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const body = { version: 1 as const, key, inputs: observed, diagnostics };
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ ...body, checksum: hash(body) }), { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    }
  } catch { /* Cache availability never changes plan validity. */ }
  return diagnostics;
}
