import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
  process.stdout.write(`refactor-ai demo — verify refactorings on temporary TS, JS and C# projects

Usage:
  node dist/demo.js [--keep]
  bun run demo [--keep]

Options:
  --keep       Keep temporary projects, plans, build outputs and journals;
               the final message prints their directory. Default: remove them.
  --help, -h   Show this help without creating projects or running refactorings.

The demo prints unified diffs, plans/previews/validates/applies each change, checks
compiler diagnostics and compares program output before/after. It covers symbol
rename, import sorting/removal, formatting, TS extraction, TS/JS type moves and
file renames, and C# type moves, file renames and namespace synchronization.
Templates in examples/ are copied and preserved. Failures return a nonzero exit.

Requirements:
  Node.js 22+, installed runtime dependencies, built dist/cli.js and dist/demo.js,
  the examples/ directory, and .NET 8 SDK with dotnet in PATH. Initial package
  restores require network access. Bun is needed only for development builds.

Examples (from the repository root):
  bun install --frozen-lockfile
  bun run build:csharp
  bun run build
  node dist/demo.js
  node dist/demo.js --keep
  bun run demo --keep
`);
  process.exit(0);
}
if (args.some(arg => arg !== "--keep") || args.length > 1) {
  process.stderr.write("INVALID_ARGUMENT: demo accepts --keep or --help; run node dist/demo.js --help\n");
  process.exit(1);
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-demo-")));
const keep = args.includes("--keep");
const cli = "dist/cli.js";

try {
  for (const kind of ["typescript", "javascript", "csharp"]) {
    await cp(join(repo, "examples", kind), join(workspace, kind), { recursive: true });
  }
  await demoScript("typescript", "tsconfig.json", "math.ts", "caller.ts", "add", "sum");
  await demoScript("javascript", "jsconfig.json", "math.js", "caller.js", "add", "sum");
  await demoCSharp();
  await demoTypeFiles("typescript");
  await demoTypeFiles("javascript");
  console.log(keep ? `Demo passed; files and plans: ${workspace}` : "Demo passed; temporary copies removed.");
} finally {
  if (!keep) await rm(workspace, { recursive: true, force: true });
}

async function demoScript(
  kind: string,
  configName: string,
  sourceName: string,
  callerName: string,
  oldName: string,
  newName: string,
): Promise<void> {
  const root = join(workspace, kind);
  const config = join(root, configName);
  const source = join(root, sourceName);
  const caller = join(root, callerName);
  const before = await executeScript(root, caller);
  const text = await readFile(source, "utf8");
  await planApply(root, config, source, point(text, text.indexOf(oldName)), ["rename", "--name", newName], `${kind}-rename`);
  await planApply(root, config, caller, undefined, ["imports", "--mode", "sort"], `${kind}-sort-imports`);
  await planApply(root, config, caller, undefined, ["imports", "--mode", "remove-unused"], `${kind}-remove-unused`);
  await planApply(root, config, source, undefined, ["format"], `${kind}-format`);
  if (kind === "typescript") {
    await extractFunction(root, config, source);
    const extracted = await readFile(source, "utf8");
    const start = extracted.indexOf("left + right");
    await planApply(root, config, source, point(extracted, start), ["extract-variable", "--end", point(extracted, start + "left + right".length), "--name", "subtotal"], "typescript-extract-variable");
    await planApply(root, config, source, undefined, ["format"], "typescript-format-after-extraction");
  }
  const after = await executeScript(root, caller);
  if (before !== after) throw new Error(`${kind}: runtime output changed: ${before} -> ${after}`);
  await planApply(root, config, source, undefined, ["format"], `${kind}-idempotent`, true);
  console.log(`${kind}: ${JSON.stringify(after.trim())}; fresh-plan cleanup passed`);
}

async function executeScript(root: string, caller: string): Promise<string> {
  if (caller.endsWith(".js")) return run([process.execPath, caller], root).stdout;
  const output = join(root, "dist", "demo-runtime");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "package.json"), '{"type":"commonjs"}\n');
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options, noEmit: false, outDir: output, types: [],
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  });
  const errors = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].filter(d => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
  if (program.emit().emitSkipped) throw new Error("Demo compiler skipped emit");
  return run([process.execPath, join(output, basename(caller).replace(/\.ts$/, ".js"))], root).stdout;
}

async function extractFunction(root: string, config: string, source: string): Promise<void> {
  const text = await readFile(source, "utf8");
  const start = text.indexOf("return left + right;");
  const end = start + "return left + right;".length;
  await planApply(root, config, source, point(text, start), ["extract-function", "--end", point(text, end), "--name", "sumParts"], "typescript-extract-function");
}

async function demoCSharp(): Promise<void> {
  const root = join(workspace, "csharp");
  const config = join(root, "Caller.csproj");
  const source = join(root, "Utility.cs");
  const restored = run(["dotnet", "restore", config, "--nologo"], root);
  if (restored.code !== 0) throw new Error(`csharp restore failed: ${restored.stderr || restored.stdout}`);
  const before = run(["dotnet", "run", "--project", config, "--no-restore", "--nologo"], root).stdout;
  const text = await readFile(source, "utf8");
  await planApply(root, config, source, point(text, text.indexOf("Add")), ["rename", "--name", "Sum"], "csharp-rename");
  await planApply(root, config, source, undefined, ["imports", "--mode", "remove-unused"], "csharp-imports");
  await planApply(root, config, source, undefined, ["format"], "csharp-format");
  const after = run(["dotnet", "run", "--project", config, "--no-restore", "--nologo"], root).stdout;
  if (before !== after) throw new Error(`csharp: runtime output changed: ${before} -> ${after}`);
  await planApply(root, config, source, undefined, ["format"], "csharp-idempotent", true);
  const moved = join(root, "Services", "Wrong.cs"), renamed = join(root, "Services", "Utility.cs");
  await planApply(root, config, source, undefined, ["move-type", "--type", "Utility", "--to", moved], "csharp-move-type");
  await planApply(root, config, moved, undefined, ["rename-file"], "csharp-rename-file");
  await planApply(root, config, renamed, undefined, ["sync-namespace"], "csharp-sync-namespace");
  const fileOpsAfter = run(["dotnet", "run", "--project", config, "--no-restore", "--nologo"], root).stdout;
  if (before !== fileOpsAfter) throw new Error("csharp: type/file refactoring changed runtime output");
  console.log(`csharp: ${JSON.stringify(after.trim())}; fresh-plan cleanup passed`);
}

async function demoTypeFiles(kind: "typescript" | "javascript"): Promise<void> {
  const root = join(workspace, `${kind}-types`), extension = kind === "typescript" ? "ts" : "js";
  await mkdir(root);
  const config = join(root, kind === "typescript" ? "tsconfig.json" : "jsconfig.json");
  await writeFile(config, JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, ...(kind === "javascript" ? { allowJs: true, checkJs: true } : {}) },
    include: [`**/*.${extension}`], exclude: ["dist"],
  }));
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  const source = join(root, `types.${extension}`), caller = join(root, `caller.${extension}`);
  await writeFile(source, "export class Widget { static value = 5; }\nexport class Other { static value = 2; }\n");
  await writeFile(caller, `import { Widget, Other } from "./types.js";\nconsole.log(Widget.value + Other.value);\n`);
  const before = await executeScript(root, caller), moved = join(root, "models", "deep", `Wrong.${extension}`);
  await planApply(root, config, source, undefined, ["move-type", "--type", "Widget", "--to", moved], `${kind}-move-type`);
  await planApply(root, config, moved, undefined, ["rename-file"], `${kind}-rename-file`);
  const after = await executeScript(root, caller);
  if (before !== after) throw new Error(`${kind}: type/file refactoring changed runtime output`);
  console.log(`${kind} type/file refactorings: ${JSON.stringify(after.trim())}; execution preserved`);
}

async function planApply(root: string, config: string, file: string, at: string | undefined, operation: string[], label: string, expectNoChanges = false): Promise<void> {
  const plan = join(root, ".refactor-ai", `${label}.json`);
  const args = [cli, "plan", operation[0]!, "--project", config, "--file", file, ...(at ? ["--at", at] : []), ...operation.slice(1), "--out", plan];
  const planned = run([process.execPath, ...args], repo);
  if (planned.code !== 0) throw new Error(`${label} plan failed: ${planned.stderr || planned.stdout}`);
  const details = JSON.parse(await readFile(plan, "utf8"));
  if (expectNoChanges && details.changes.length) throw new Error(`${label}: cleanup was not idempotent`);
  console.log(`\n[${label}] ${details.changes.length} changed file(s), compiler validation: ${details.validation.status}`);
  const preview = run([process.execPath, cli, "preview", "--plan", plan], repo);
  if (preview.code !== 0) throw new Error(`${label} preview failed: ${preview.stderr || preview.stdout}`);
  process.stdout.write(preview.stdout);
  const validated = run([process.execPath, cli, "validate", "--plan", plan], repo);
  if (validated.code !== 0) throw new Error(`${label} validate failed: ${validated.stderr || validated.stdout}`);
  const applied = run([process.execPath, cli, "apply", "--plan", plan], repo);
  if (applied.code !== 0) throw new Error(`${label} apply failed: ${applied.stderr || applied.stdout}`);
}

function point(text: string, offset: number): string {
  if (offset < 0) throw new Error("demo anchor not found");
  const prefix = text.slice(0, offset);
  const line = (prefix.match(/\n/g) ?? []).length + 1;
  const lastBreak = prefix.lastIndexOf("\n");
  return `${line}:${offset - lastBreak}`;
}

function run(command: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const child = spawnSync(command[0]!, command.slice(1), {
    cwd,
    encoding: "utf8",
    env: { ...process.env, DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1", REFACTOR_AI_HOME: repo },
  });
  if (child.error) throw child.error;
  const result = {
    code: child.status ?? -1,
    stdout: child.stdout,
    stderr: child.stderr,
  };
  if (result.code !== 0) throw new Error(`${command.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}
