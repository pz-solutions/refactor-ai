// scripts/skill-launcher.ts
import { existsSync as existsSync2, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname as dirname2, join as join2, resolve as resolve2 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// src/languages.ts
var languageOperations = {
  typescript: ["rename", "imports", "format", "extract-function", "extract-variable", "rename-file", "move-type"],
  csharp: ["rename", "imports", "format", "rename-file", "sync-namespace", "move-type"]
};

// src/help.ts
var operationHelp = {
  rename: {
    description: "Rename a symbol and its semantic references.",
    support: "TypeScript, JavaScript and C#",
    required: "--at <line:column> --name <identifier>",
    details: "Comments and string literals are excluded. Use a .sln and a common --root for C# callers across projects. External consumers and dynamic references are outside the loaded scope.",
    examples: [
      "plan rename --project examples/typescript/tsconfig.json --file examples/typescript/math.ts --at 1:17 --name sum",
      "plan rename --project examples/javascript/jsconfig.json --file examples/javascript/math.js --at 2:17 --name sum",
      "plan rename --project examples/csharp/Caller.csproj --file examples/csharp/Utility.cs --at 7:23 --name Sum"
    ]
  },
  imports: {
    description: "Sort imports or explicitly remove unused imports / using directives.",
    support: "TS/JS: sort and remove-unused; C#: remove-unused only",
    required: "[--mode <sort|remove-unused>]",
    details: "Default mode: sort. C# requires --mode remove-unused. TS sort retains unused imports. Sorting can change module initialization order; removing an unused value import can remove initialization. Bare side-effect imports are retained.",
    examples: [
      "plan imports --project examples/typescript/tsconfig.json --file examples/typescript/caller.ts --mode sort",
      "plan imports --project examples/javascript/jsconfig.json --file examples/javascript/caller.js --mode remove-unused",
      "plan imports --project examples/csharp/Caller.csproj --file examples/csharp/Utility.cs --mode remove-unused"
    ]
  },
  format: {
    description: "Format a file using the TypeScript or Roslyn formatter.",
    support: "TypeScript, JavaScript and C#",
    required: "No additional required options.",
    details: "TS/JS uses the runner's fixed formatting settings; C# uses Roslyn document options. An already formatted file produces a plan with no changes.",
    examples: [
      "plan format --project examples/typescript/tsconfig.json --file examples/typescript/math.ts",
      "plan format --project examples/csharp/Caller.csproj --file examples/csharp/Utility.cs"
    ]
  },
  "extract-function": {
    description: "Extract selected statements or an expression into a named function.",
    support: "TypeScript and JavaScript; C# extraction is unavailable",
    required: "--at <line:column> --end <line:column> --name <identifier>",
    details: "The end position is exclusive. The TypeScript engine chooses the scope, parameters and returned values; semantic rename assigns the requested name. Invalid ranges and name conflicts are rejected.",
    examples: [
      "plan extract-function --project examples/typescript/tsconfig.json --file examples/typescript/math.ts --at 2:3 --end 2:23 --name sumParts"
    ]
  },
  "extract-variable": {
    description: "Extract an expression into a named constant.",
    support: "TypeScript and JavaScript; C# extraction is unavailable",
    required: "--at <line:column> --end <line:column> --name <identifier>",
    details: "The end position is exclusive. Scope and edits come from the TypeScript refactoring action, followed by semantic rename. Unsupported expressions and name conflicts are rejected.",
    examples: [
      "plan extract-variable --project examples/typescript/tsconfig.json --file examples/typescript/math.ts --at 2:10 --end 2:22 --name total"
    ]
  },
  "rename-file": {
    description: "Rename a source file to match a selected declared type.",
    support: "TypeScript, JavaScript and C#",
    required: "[--type <identifier> | --at <line:column>]",
    details: "The only top-level type is selected automatically. Select explicitly when several types are declared. The extension is retained and the whole file is renamed; other declarations remain in it. TS/JS import paths and supported project file lists are updated. C# explicit Compile entries are updated. Existing targets and unsupported case-only renames are rejected.",
    examples: [
      "plan rename-file --project ./tsconfig.json --file ./src/Wrong.ts --type Widget",
      "plan rename-file --project ./App.csproj --file ./Models/Wrong.cs --type Widget"
    ]
  },
  "sync-namespace": {
    description: "Align a C# file's namespace with RootNamespace and its project-relative folders.",
    support: "C# only; ES modules have no namespace-to-folder convention",
    required: "[--root-namespace <dotted-name>]",
    details: "Updates the selected file's types and semantic references while retaining other files in their original namespace. Use a .sln for callers across projects. Multiple/nested namespaces, conditional compilation and partial declarations spread across files are rejected.",
    examples: [
      "plan sync-namespace --project ./App.csproj --file ./Models/Widget.cs",
      "plan sync-namespace --project ./Workspace.sln --root . --file ./App/Models/Widget.cs --root-namespace Company.App"
    ]
  },
  "move-type": {
    description: "Move a selected top-level type into another file or project.",
    support: "TypeScript, JavaScript and C#",
    required: "--to <destination-file> [--type <identifier> | --at <line:column>] [--target-project <config>] [--root-namespace <dotted-name>]",
    details: "The only top-level type is selected automatically. Other declarations stay in the source; an empty source may be deleted. Missing destination directories are created during apply. Use a --root covering source, destination and callers. Cross-project moves use --target-project; C# requires a loaded target project (normally through a .sln) and a new destination file. TS/JS source must use ES modules, even when compiled to CommonJS. TS projects need compatible module resolution settings; composite projects require valid references. TS/JS runtime declarations with effectful static initializers, static blocks, decorators, computed members, evaluated base-class expressions or nonconstant enum initializers are rejected (INITIALIZATION_EFFECTS_UNSUPPORTED). Simple identifier base classes are supported when the move introduces no module cycle. Compiler checks do not prove whole-program behavior equivalence; run application tests. C# keeps global using directives in the source project, plans unconditional required ProjectReference edits and follows the destination namespace convention when the source follows its convention, otherwise retaining the custom namespace unless overridden. A cross-project C# move changes assembly identity. Cycles, inaccessible dependencies, unsupported project rules and new compiler errors are rejected.",
    examples: [
      "plan move-type --project ./tsconfig.json --file ./src/types.ts --type Widget --to ./src/models/Widget.ts",
      "plan move-type --project ./Source/tsconfig.json --root . --file ./Source/types.ts --type Widget --to ./Target/Models/Widget.ts --target-project ./Target/tsconfig.json",
      "plan move-type --project ./Workspace.sln --root . --file ./Source/Types.cs --type Widget --to ./Target/Models/Widget.cs --target-project ./Target/Target.csproj"
    ]
  }
};
var languageDetails = {
  typescript: {
    rename: { details: "Comments and string literals are excluded. References are resolved within the configured project; external consumers and dynamic references are outside the loaded scope." },
    imports: { description: "Sort imports or explicitly remove unused imports.", details: "Default mode: sort. Sorting retains unused imports and can change module initialization order. Removing an unused value import can remove initialization; bare side-effect imports are retained." },
    format: { description: "Format a file with the TypeScript formatter.", details: "Uses the runner's fixed formatting settings. An already formatted file produces a plan with no changes." },
    "rename-file": { details: "The only top-level type is selected automatically; select explicitly when several exist. Renames the whole file and keeps its extension and other declarations. Compiler-resolved imports and supported project file lists are updated. Existing targets and unsupported case-only renames are rejected." },
    "move-type": { details: "Select a top-level type explicitly when several exist. Other declarations stay in the source; an empty source may be deleted. Missing destination directories are created during apply. Use a --root covering source, destination and callers, and --target-project for a cross-project move. Sources must use ES modules; compatible module resolution and valid composite project references are required. Effectful static initializers, static blocks, decorators, computed members, evaluated bases and nonconstant enum initializers are rejected (INITIALIZATION_EFFECTS_UNSUPPORTED). Simple identifier bases are supported if no new module cycle is introduced. Compiler checks do not prove whole-program behavior equivalence; run application tests." }
  },
  csharp: {
    imports: { description: "Remove unused C# using directives identified by Roslyn.", required: "[--mode remove-unused]", details: "The C# package defaults to remove-unused; sorting is unsupported. Uses Roslyn's built-in compiler diagnostics." },
    format: { description: "Format a C# file with the Roslyn Formatter API.", details: "Uses Roslyn document options. An already formatted file produces a plan with no changes." },
    "rename-file": { details: "The only top-level type is selected automatically; select explicitly when several exist. Renames the whole file and keeps its extension and other declarations. Explicit Compile entries are updated. Existing targets and unsupported case-only renames are rejected." },
    "move-type": { details: "Select a top-level type explicitly when several exist. Other declarations stay in the source; an empty source may be deleted. Missing destination directories are created during apply. Use a --root covering source, destination and callers. Cross-project moves require a loaded target project, normally through a .sln, --target-project and a new destination file. Global using directives stay in the source project. Required ProjectReference edits are unconditional. The destination namespace convention is followed when the source follows its convention; custom namespaces are otherwise retained unless overridden. Moving between projects changes assembly identity. Cycles, inaccessible dependencies, unsupported project rules and new compiler errors are rejected. Run application tests after applying." }
  }
};
function operationHelpFor(operation, language) {
  const item = operationHelp[operation];
  if (!language)
    return item;
  return {
    ...item,
    ...languageDetails[language][operation],
    support: language === "typescript" ? "TypeScript and JavaScript" : "C#",
    examples: item.examples.filter((example) => language === "csharp" ? /--project \S+\.(csproj|sln)(?: |$)/.test(example) : /--project \S+\.json(?: |$)/.test(example))
  };
}
function optionsText(language) {
  const project = language === "typescript" ? "tsconfig.json or jsconfig.json" : language === "csharp" ? ".csproj or .sln" : "tsconfig.json, jsconfig.json, .csproj or .sln";
  return `  --project <config>       Required for capabilities and plan; ${project}.
${language !== "csharp" ? `                           Named TS configurations are supported by file/type operations.
` : ""}  --file <source>          Required for plan; file included by the selected project.
  --root <directory>       Boundary for source, configs and callers; defaults to
                           the project configuration's directory.
  --at <line:column>       Symbol/type position or extraction start, 1-based UTF-16.
  --end <line:column>      Extraction end, exclusive, 1-based UTF-16.
  --name <identifier>      Required new name for rename and extraction.
  --mode <mode>            imports: ${language === "csharp" ? "remove-unused (default); sorting is unsupported" : "sort (default) or remove-unused"}.
  --type <identifier>      Declared type for rename-file or move-type; select when
                           several types exist, or use --at.
  --to <file>              Required destination for move-type; relative to cwd.
  --target-project <config> Destination project config; move-type only.
${language !== "typescript" ? `  --root-namespace <name>  C# namespace convention override for sync-namespace
                           or move-type.
` : ""}  --out <plan.json>        Plan output; defaults to <root>/.refactor-ai/<id>.json.
                           Within root, store plans only in .refactor-ai;
                           an output path outside root is also allowed.
  --plan <plan.json>       Required for preview, validate and apply.
  --help, -h              Show general, command or operation help; no project needed.
`;
}
function contextText(language) {
  return `Paths are relative to the current working directory unless absolute. Quote paths
with spaces. Source/config paths must exist; a move destination may be new.
Positions count UTF-16 code units: an emoji occupies two columns. CRLF is supported.
${language !== "csharp" ? `TS/JS rename, imports, format and extract reject project references; file/type
operations validate supported project graphs and affected named configurations.
` : ""}`;
}
var requirements = `Requirements:
  Node.js 22+. Installed skill commands use npm to set up pinned TypeScript 5.9.3
  on first execution; initial setup needs network access and a writable skill
  directory. Help does not install dependencies or load a project.
  C#: .NET 8 SDK (dotnet in PATH), the project's required SDK/workloads and restored
  project dependencies. A skill builds its bundled Roslyn helper on first C# use;
  initial NuGet restore needs network access. Bun is for development builds only.
  Checkout setup: bun install --frozen-lockfile; bun run build:csharp; bun run build.
  Relocated C# runner: set REFACTOR_AI_HOME to the package directory containing
  dotnet/RefactorHelper. Installed skill launchers set this path automatically.
`;
function examples(invocation, commands) {
  return commands.map((command) => `  ${invocation} ${command}`).join(`
`);
}
function workflow(invocation) {
  return `Plan workflow:
  Planning computes edits and compiler diagnostics in memory; source files are
  untouched. Read the JSON response's plan path, then use that exact plan:
${examples(invocation, ["preview --plan ./path/to/plan.json", "validate --plan ./path/to/plan.json", "apply --plan ./path/to/plan.json"])}
  Validation checks snapshot freshness and stored compiler analysis; it does not
  run your project's tests. Apply requires passed validation and a fresh snapshot.
  Changed sources/configs require replanning. Multi-file writes use a journal and
  attempt rollback on failure; they are not a filesystem-wide atomic transaction.

Output and exit status:
  Status and capabilities: JSON on stdout. Help and preview: text on stdout.
  Errors: JSON on stderr. Exit 0: success (including no-op); exit 1: error or failed
  validation. Plans creating/deleting files use schemaVersion 2; edit-only and
  legacy plans use version 1. After interrupted apply inspect .refactor-ai/apply.lock
  and the .journal.json journal before recovery; preserve subsequent external edits.
`;
}
function operationText(operation, invocation, language) {
  const item = operationHelpFor(operation, language);
  return `${operation}: ${item.description}
  Languages: ${item.support}
  Operation options: ${item.required}
  ${item.details}
Examples (replace custom paths/type names with your project's values):
${examples(invocation, item.examples)}
`;
}
function helpRequested(args) {
  return args.length === 0 || args[0] === "help" || args.includes("--help") || args.includes("-h");
}
function renderHelp(args, invocation = "node dist/cli.js", runtimeRequirements = requirements, language) {
  const topics = args[0] === "help" ? args.slice(1) : args;
  const command = topics[0]?.startsWith("-") ? undefined : topics[0];
  const operation = topics[1]?.startsWith("-") ? undefined : topics[1];
  const known = ["capabilities", "plan", "preview", "validate", "apply"];
  if (command && !known.includes(command))
    throw new Error(`INVALID_ARGUMENT: unknown help command ${command}`);
  if (operation && (command !== "plan" || !Object.hasOwn(operationHelp, operation))) {
    throw new Error(`UNSUPPORTED: help topic ${command} ${operation}`);
  }
  if (operation && language && !languageOperations[language].includes(operation))
    throw new Error(`UNSUPPORTED: ${operation} is unavailable for ${language}`);
  const title = `refactor-ai — deterministic ${language === "typescript" ? "TypeScript/JavaScript" : language === "csharp" ? "C#" : "TypeScript/JavaScript and C#"} refactorings
`;
  const options = optionsText(language);
  const context = contextText(language);
  if (["preview", "validate", "apply"].includes(command ?? "")) {
    const descriptions = {
      preview: "Print the stored unified diff, including file creation/deletion. Does not write sources or check snapshot freshness; use validate before apply.",
      validate: "Check the plan's integrity, current snapshot and stored compiler analysis. Does not re-run compilation or project tests. A failed validation returns exit 1.",
      apply: "Apply the exact validated plan to an unchanged snapshot. Uses a lock and journal; on failure attempts to roll back its own writes. Replan after changes."
    };
    return `${title}
${command}: ${descriptions[command]}

Usage:
  ${invocation} ${command} --plan <plan.json>

Options:
  --plan <plan.json>  Required saved plan path.
  --help, -h         Show this help.

Examples:
${examples(invocation, [`${command} --plan ./.refactor-ai/saved-plan.json`, `${command} --plan "/path with spaces/plan.json"`])}

${workflow(invocation)}`;
  }
  if (command === "capabilities") {
    return `${title}
capabilities: List implemented operations and modes as JSON for the selected backend.

Usage:
  ${invocation} capabilities --project <config>

Options:
  --project <config>  Required ${language === "typescript" ? "tsconfig.json or jsconfig.json" : language === "csharp" ? ".csproj or .sln" : "tsconfig.json, jsconfig.json, .csproj or .sln"}.
  --help, -h          Show this help.

Examples:
${examples(invocation, ["capabilities --project examples/typescript/tsconfig.json", "capabilities --project examples/javascript/jsconfig.json", "capabilities --project examples/csharp/Caller.csproj"].filter((example) => !language || (language === "csharp" ? example.includes("csharp/") : !example.includes("csharp/"))))}

The configuration must exist. This command reports implemented backend capabilities,
not whether a particular source selection can be refactored. It does not load or
change source files.

${runtimeRequirements}`;
  }
  if (operation) {
    return `${title}
Usage:
  ${invocation} plan ${operation} --project <config> --file <source> [operation options]

${operationText(operation, invocation, language)}
Options and defaults:
${options}
${context}
${workflow(invocation)}
${runtimeRequirements}`;
  }
  const commands = command === "plan" ? `Usage:
  ${invocation} plan <operation> --project <config> --file <source> [options]
` : `Commands:
  capabilities --project <config>       List backend operations and modes (JSON).
  plan <operation> --project <config> --file <source> [options]
                                       Compute a plan without writing sources.
  preview --plan <plan.json>            Print a stored unified diff.
  validate --plan <plan.json>           Check freshness and stored validation.
  apply --plan <plan.json>              Apply the exact plan and journal writes.
  help [command] [operation]            Show help, also available via --help/-h.
`;
  return `${title}
${commands}
Help examples:
${examples(invocation, ["--help", "plan move-type --help", "help plan rename", "apply --help"])}

Options and defaults:
${options}
${context}
Operations:
${(language ? languageOperations[language] : Object.keys(operationHelp)).map((key) => operationText(key, invocation, language)).join(`
`)}
${workflow(invocation)}
${runtimeRequirements}`;
}

// src/runtime/npm.ts
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
function npmCli() {
  const executableDirectory = dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ...(process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, process.platform === "win32" ? "npm.cmd" : "npm"))
  ];
  for (const candidate of candidates) {
    if (!candidate)
      continue;
    try {
      let path = realpathSync(candidate);
      if (path.endsWith(".cmd"))
        path = join(dirname(path), "node_modules", "npm", "bin", "npm-cli.js");
      if (path.endsWith("npm-cli.js") && existsSync(path))
        return path;
    } catch {}
  }
  throw new Error("NPM_NOT_FOUND: npm is required; install Node.js with npm");
}

// scripts/skill-launcher.ts
var skillRoot = resolve2(dirname2(fileURLToPath(import.meta.url)), "..");
var runtime = join2(skillRoot, "assets", "runtime");
function runtimeReady() {
  try {
    const manifest = JSON.parse(readFileSync(join2(runtime, "node_modules", "typescript", "package.json"), "utf8"));
    return manifest.version === "5.9.3" && existsSync2(join2(runtime, "node_modules", "typescript", "lib", "typescript.js"));
  } catch {
    return false;
  }
}
async function ensureRuntime() {
  if (runtimeReady())
    return;
  const lock = join2(runtime, ".setup.lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`SKILL_SETUP_BUSY: another setup is running; after an interrupted setup inspect ${lock}`);
    }
    throw error;
  }
  try {
    if (runtimeReady())
      return;
    process.stderr.write(`Installing the skill's locked TypeScript runtime dependency...
`);
    const installed = spawnSync(process.execPath, [npmCli(), "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: runtime,
      stdio: ["ignore", process.stderr, process.stderr],
      timeout: 180000
    });
    if (installed.error)
      throw new Error(`SKILL_SETUP_FAILED: ${installed.error.message}`);
    if (installed.status !== 0 || !runtimeReady())
      throw new Error("SKILL_SETUP_FAILED: npm ci did not install the locked runtime dependency");
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
try {
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("UNSUPPORTED_RUNTIME: Node.js 22+ is required");
  if (helpRequested(process.argv.slice(2))) {
    process.stdout.write(renderHelp(process.argv.slice(2), 'node "<skill-root>/scripts/refactor.mjs"'));
    process.exit(0);
  }
  await ensureRuntime();
  process.env.REFACTOR_AI_HOME = join2(skillRoot, "assets");
  const { main } = await import(pathToFileURL(join2(runtime, "cli.mjs")).href);
  await main(process.argv.slice(2));
} catch (error) {
  console.error(JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
