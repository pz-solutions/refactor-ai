import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { BackendLoader, Operation, RefactorRequest } from "./types.ts";
import { applyPlan } from "./core/apply.ts";
import { assertFresh, createPlan, loadPlan, preview } from "./core/plan.ts";

import { helpRequested, renderHelp } from "./help.ts";
import { languageForProject, type Language } from "./languages.ts";

function parse(args: string[]): { command: string; operation?: string; flags: Record<string, string> } {
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

export function offset(text: string, point: string): number {
  const match = /^(\d+):(\d+)$/.exec(point);
  if (!match) throw new Error(`INVALID_POSITION: ${point}`);
  const line = Number(match[1]), column = Number(match[2]);
  const lines = text.split("\n");
  if (line < 1 || line > lines.length || column < 1 || column > lines[line - 1].replace(/\r$/, "").length + 1) {
    throw new Error(`INVALID_POSITION: ${point}`);
  }
  return lines.slice(0, line - 1).reduce((total, item) => total + item.length + 1, 0) + column - 1;
}

export interface CliContext {
  invocation?: string;
  operation?: Operation;
  language?: Language;
  loadBackend: BackendLoader;
}

function assertLanguage(project: string, language?: Language, backend?: string): void {
  if (language && (languageForProject(project) !== language ||
      (backend !== undefined && backend !== (language === "typescript" ? "typescript" : "roslyn")))) {
    throw new Error(`UNSUPPORTED_LANGUAGE: this tool only supports ${language === "typescript" ? "TypeScript/JavaScript" : "C#"}`);
  }
}

export async function runCli(args: string[], context: CliContext): Promise<void> {
  if (helpRequested(args)) { process.stdout.write(renderHelp(args, context.invocation, undefined, context.language)); return; }
  const { command, operation, flags } = parse([...args]);
  if (["preview", "validate", "apply"].includes(command)) {
    const plan = await loadPlan(resolve(required(flags, "plan")));
    assertLanguage(plan.request.project, context.language, plan.backend);
    if (command === "preview") { process.stdout.write(preview(plan) || "No changes.\n"); return; }
    if (command === "apply") { console.log(JSON.stringify(await applyPlan(plan), null, 2)); return; }
    await assertFresh(plan);
    console.log(JSON.stringify({ status: plan.validation.status === "passed" ? "validated" : "failed", validation: plan.validation, id: plan.id }, null, 2));
    if (plan.validation.status !== "passed") process.exitCode = 1;
    return;
  }
  assertLanguage(required(flags, "project"), context.language);
  if (flags["target-project"]) assertLanguage(flags["target-project"], context.language);
  const project = await realpath(resolve(required(flags, "project")));
  const engine = await context.loadBackend(project);
  if (command === "capabilities") {
    console.log(JSON.stringify(context.operation ? engine.capabilities.filter(item => item.operation === context.operation) : engine.capabilities, null, 2));
    return;
  }
  if (command !== "plan") throw new Error(`INVALID_ARGUMENT: unknown command ${command}`);
  const operations: Operation[] = ["rename", "imports", "format", "extract-function", "extract-variable", "rename-file", "sync-namespace", "move-type"];
  if (!operations.includes(operation as Operation)) throw new Error(`UNSUPPORTED: ${operation}`);
  if (context.operation && operation !== context.operation) throw new Error(`UNSUPPORTED: this tool only supports ${context.operation}`);
  const file = await realpath(resolve(required(flags, "file")));
  const root = await realpath(resolve(flags.root ?? dirname(project)));
  const text = await readFile(file, "utf8");
  if (flags.mode && !["sort", "remove-unused"].includes(flags.mode)) throw new Error("INVALID_ARGUMENT: --mode sort|remove-unused");
  if (operation === "move-type") required(flags, "to");
  if ((flags.to || flags["target-project"]) && operation !== "move-type") {
    throw new Error("INVALID_ARGUMENT: --to and --target-project require move-type");
  }
  const request: RefactorRequest = {
    project, root, file, operation: operation as Operation,
    ...(flags.at ? { position: offset(text, flags.at) } : {}),
    ...(flags.end ? { end: offset(text, flags.end) } : {}),
    ...(flags.name ? { newName: flags.name } : {}),
    ...(operation === "imports" ? { mode: (flags.mode ?? (context.language === "csharp" ? "remove-unused" : "sort")) as "sort" | "remove-unused" } : {}),
    ...(flags.to ? { target: resolve(flags.to) } : {}),
    ...(flags["target-project"] ? { targetProject: await realpath(resolve(flags["target-project"])) } : {}),
    ...(flags.type ? { typeName: flags.type } : {}),
    ...(flags["root-namespace"] ? { rootNamespace: flags["root-namespace"] } : {}),
  };
  const plan = await createPlan(request, engine.analyze);
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
  console.log(JSON.stringify({ status: "planned", plan: output, id: plan.id, backend: plan.backend,
    files: plan.changes.map(c => c.path), validation: plan.validation, notes: plan.notes }, null, 2));
  if (plan.validation.status !== "passed") process.exitCode = 1;
}
