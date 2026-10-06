import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Operation } from "./types.ts";
import { createRefactorApi } from "./api.ts";
import { type RefactorContext } from "./refactor-context.ts";
export { offset } from "./api.ts";

import { helpRequested, renderHelp } from "./help.ts";

function parse(args: string[]): { command: string; operation?: string; flags: Record<string, string>; } {
  const command = args.shift() ?? "help";
  const operation = args[0] && !args[0].startsWith("--") ? args.shift() : undefined;
  const flags: Record<string, string> = {};
  const allowed = new Set(["project", "file", "root", "at", "end", "name", "mode", "out", "plan", "to", "target-project", "type", "root-namespace"]);
  while (args.length) {
    const key = args.shift()!;
    const value = args.shift();
    if (!key.startsWith("--") || !allowed.has(key.slice(2)) || !value || value.startsWith("--") || flags[key.slice(2)] !== undefined) {
      throw new Error(`INVALID_ARGUMENT: ${key}`);
    }
    flags[key.slice(2)] = value;
  }
  return { command, operation, flags };
}

function required(flags: Record<string, string>, key: string): string {
  if (!flags[key]) throw new Error(`INVALID_ARGUMENT: --${key} required`);
  return flags[key];
}

async function canonicalDirectory(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolve(await canonicalDirectory(dirname(path)), basename(path));
  }
}

export interface CliContext extends RefactorContext {
  invocation?: string;
}

export async function runCli(args: string[], context: CliContext): Promise<void> {
  if (helpRequested(args)) { process.stdout.write(renderHelp(args, context.invocation, undefined, context.language)); return; }
  const { command, operation, flags } = parse([...args]);
  const api = createRefactorApi(context);
  if (["preview", "validate", "apply"].includes(command)) {
    const plan = await api.loadPlan(required(flags, "plan"));
    if (command === "preview") { process.stdout.write(api.preview(plan) || "No changes.\n"); return; }
    if (command === "apply") { console.log(JSON.stringify(await api.apply(plan), null, 2)); return; }
    console.log(JSON.stringify(await api.validate(plan), null, 2));
    if (plan.validation.status !== "passed") process.exitCode = 1;
    return;
  }
  if (command === "capabilities") {
    console.log(JSON.stringify(await api.capabilities(required(flags, "project")), null, 2));
    return;
  }
  if (command !== "plan") throw new Error(`INVALID_ARGUMENT: unknown command ${command}`);
  const plan = await api.plan({
    project: required(flags, "project"), file: required(flags, "file"), operation: operation as Operation,
    root: flags.root, at: flags.at, end: flags.end, name: flags.name,
    mode: flags.mode as "sort" | "remove-unused" | undefined, target: flags.to,
    targetProject: flags["target-project"], typeName: flags.type, rootNamespace: flags["root-namespace"],
  });
  const root = plan.request.root;
  let output = resolve(flags.out ?? resolve(root, ".refactor-ai", `${plan.id}.json`));
  const stateDirectory = resolve(root, ".refactor-ai");
  const stateStat = await lstat(stateDirectory).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (stateStat?.isSymbolicLink()) throw new Error("SYMLINK_UNSUPPORTED: state directory");
  output = resolve(await canonicalDirectory(dirname(output)), basename(output));
  const within = (directory: string, path: string) => {
    const difference = relative(directory, path);
    return difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
  };
  if (within(root, output) && !within(stateDirectory, output)) {
    throw new Error("INVALID_ARGUMENT: store plan outside the project or in <root>/.refactor-ai to keep snapshot fresh");
  }
  await mkdir(dirname(output), { recursive: true });
  if ((await realpath(dirname(output))) !== dirname(output)) throw new Error("SYMLINK_UNSUPPORTED: plan output directory changed");
  const outputStat = await lstat(output).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (outputStat?.isSymbolicLink()) throw new Error("SYMLINK_UNSUPPORTED: plan output file");
  await writeFile(output, JSON.stringify(plan, null, 2) + "\n");
  console.log(JSON.stringify({
    status: "planned", plan: output, id: plan.id, backend: plan.backend,
    files: plan.changes.map(c => c.path), validation: plan.validation, notes: plan.notes
  }, null, 2));
  if (plan.validation.status !== "passed") process.exitCode = 1;
}
