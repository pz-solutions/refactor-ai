import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import manifest from "../package.json";
import { ignoreStateDirectory } from "./core/snapshot";
import type { CheckerIdentity } from "./types";

interface Run {
  schemaVersion: 1;
  startedAt: string;
  command: string;
  op: string;
  argv: string[];
  cwd: string;
  root: string;
  wallMs: number;
  phases: { phase: string; ms: number }[];
  status: string;
  exitCode: number;
  errorCode: string | null;
  planId: string | null;
  cli: { version: string; sha256: string | null };
  checker: CheckerIdentity | null;
}

// Launchers and their lazily imported runner are separate bundles in one process.
const storageKey = Symbol.for("refactor-ai.run-log.v1");
const runtime = globalThis as typeof globalThis & { [storageKey]?: AsyncLocalStorage<Run> };
const active = runtime[storageKey] ??= new AsyncLocalStorage<Run>();
export function updateRun(values: Partial<Pick<Run, "op" | "root" | "status" | "exitCode" | "errorCode" | "planId" | "checker">>): void {
  const run = active.getStore();
  if (run) Object.assign(run, values);
}
export function recordPhase(phase: string, ms: number): void { active.getStore()?.phases.push({ phase, ms }); }

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

let identity: Promise<Run["cli"]> | undefined;
async function append(run: Run): Promise<void> {
  const root = await realpath(run.root);
  const directory = resolve(root, ".refactor-ai");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) return;
  await ignoreStateDirectory(directory);
  identity ??= readFile(new URL(import.meta.url)).then(bytes => ({ version: manifest.version, sha256: createHash("sha256").update(bytes).digest("hex") }),
    () => ({ version: manifest.version, sha256: null }));
  run.cli = await identity;
  run.root = root;
  const handle = await open(resolve(directory, "runs.jsonl"), constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(run) + "\n"); }
  finally { await handle.close(); }
}

/** Local best-effort history. Logging cannot change a command's result. */
export async function logRun<T>(args: string[], execute: () => Promise<T>): Promise<T> {
  if (process.env.REFACTOR_AI_RUN_LOG === "off") return execute();
  const start = performance.now(), cwd = process.cwd();
  const project = flag(args, "project");
  const command = !args.length || ["help", "--help", "-h"].includes(args[0]!) ? "help" : args[0]!;
  const run: Run = {
    schemaVersion: 1, startedAt: new Date().toISOString(), command,
    op: command === "plan" ? args[1] ?? "plan" : command, argv: [...args], cwd,
    root: resolve(flag(args, "root") ?? (project ? dirname(resolve(project)) : cwd)),
    wallMs: 0, phases: [], status: "ok", exitCode: 0, errorCode: null, planId: null,
    cli: { version: manifest.version, sha256: null }, checker: null,
  };
  return active.run(run, async () => {
    try { return await execute(); }
    catch (error) {
      run.status = "failed"; run.exitCode = 1;
      run.errorCode = /^(?:Error: )?([A-Z][A-Z0-9_]+):/.exec(String(error))?.[1] ?? "UNKNOWN_ERROR";
      throw error;
    } finally {
      run.wallMs = Math.round(performance.now() - start);
      await append(run).catch(() => {});
    }
  });
}
