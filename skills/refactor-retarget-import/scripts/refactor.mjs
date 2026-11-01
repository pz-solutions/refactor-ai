// src/run-log.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat as lstat2, mkdir, open, readFile as readFile2, realpath as realpath2 } from "node:fs/promises";
import { dirname as dirname2, resolve as resolve2 } from "node:path";
// package.json
var package_default = {
  name: "refactor-ai",
  version: "0.1.4",
  private: true,
  repository: {
    type: "git",
    url: "git+https://github.com/pz-solutions/refactor-ai.git"
  },
  type: "module",
  scripts: {
    refactor: "node dist/cli.js",
    bench: "bun scripts/bench.ts",
    "bench:warm": "bun scripts/bench-warm.ts",
    "bench:checkers": "bun scripts/bench-checkers.ts",
    build: "bun build src/cli.ts --target node --format esm --outfile dist/cli.js --external typescript --external typescript7 && bun build src/api-entry.ts --target node --format esm --outfile dist/api.mjs --external typescript --external typescript7 && bun build scripts/demo.ts --target node --format esm --outfile dist/demo.js --external typescript --external typescript7 && bun build scripts/npm-release.ts --target node --format esm --outfile dist/npm-release.mjs && bun build scripts/version.ts --target node --format esm --outfile dist/version.mjs && bun scripts/package-skills.ts",
    "package:skills": "bun scripts/package-skills.ts --build",
    "package:npm": "bun scripts/package-npm.ts",
    "release:npm": "node dist/npm-release.mjs",
    "test:npm": "bun test ./tests/npm-packages.integration.ts",
    "build:csharp": "dotnet build dotnet/RefactorHelper/RefactorHelper.csproj -c Release --nologo -p:RestoreLockedMode=true",
    typecheck: "tsc --noEmit",
    test: "bun test",
    "test:skills": "bun run build && bun test ./tests/skills-install.integration.ts",
    demo: "node dist/demo.js",
    "version:packages": "node dist/version.mjs"
  },
  engines: {
    node: ">=22"
  },
  dependencies: {
    diff: "8.0.2",
    typescript: "5.9.3"
  },
  devDependencies: {
    "@types/bun": "1.3.0",
    "@types/semver": "7.8.0",
    semver: "7.8.5",
    typescript7: "npm:typescript@7.0.2"
  },
  peerDependencies: {
    typescript7: "npm:typescript@7.0.2"
  },
  peerDependenciesMeta: {
    typescript7: {
      optional: true
    }
  }
};

// src/core/snapshot.ts
import { execFile } from "node:child_process";
import { lstat, readdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
var excluded = new Set([".git", "node_modules", "bin", "obj", "dist", ".refactor-ai"]);
var run = promisify(execFile);
var stateIgnoreText = `*
!config.json
!equivalents.json
!port-route.json
!port-route/
!port-route/**
!.gitignore
`;
var legacyIgnoreTexts = [`*
`, `*
!equivalents.json
!.gitignore
`, `*
!equivalents.json
!port-route.json
!port-route/
!port-route/**
!.gitignore
`];
async function ignoreStateDirectory(stateDirectory) {
  const path = resolve(stateDirectory, ".gitignore");
  const stat = await lstat(path).catch((error) => {
    if (error.code === "ENOENT")
      return;
    throw error;
  });
  if (stat?.isSymbolicLink())
    throw new Error("SYMLINK_UNSUPPORTED: state .gitignore");
  if (stat?.isFile()) {
    if (legacyIgnoreTexts.includes(await readFile(path, "utf8")))
      await writeFile(path, stateIgnoreText);
    return;
  }
  try {
    await writeFile(path, stateIgnoreText, { flag: "wx", mode: 420 });
  } catch (error) {
    if (error.code !== "EEXIST")
      throw error;
  }
}

// src/run-log.ts
var storageKey = Symbol.for("refactor-ai.run-log.v1");
var runtime = globalThis;
var active = runtime[storageKey] ??= new AsyncLocalStorage;
function flag(args, name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}
var identity;
async function append(run) {
  const root = await realpath2(run.root);
  const directory = resolve2(root, ".refactor-ai");
  await mkdir(directory, { recursive: true, mode: 448 });
  if ((await lstat2(directory)).isSymbolicLink())
    return;
  await ignoreStateDirectory(directory);
  identity ??= readFile2(new URL(import.meta.url)).then((bytes) => ({ version: package_default.version, sha256: createHash("sha256").update(bytes).digest("hex") }), () => ({ version: package_default.version, sha256: null }));
  run.cli = await identity;
  run.root = root;
  const handle = await open(resolve2(directory, "runs.jsonl"), constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 384);
  try {
    await handle.writeFile(JSON.stringify(run) + `
`);
  } finally {
    await handle.close();
  }
}
async function logRun(args, execute) {
  if (process.env.REFACTOR_AI_RUN_LOG === "off")
    return execute();
  const start = performance.now(), cwd = process.cwd();
  const project = flag(args, "project");
  const command = !args.length || ["help", "--help", "-h"].includes(args[0]) ? "help" : args[0];
  const run = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    command,
    op: command === "plan" ? args[1] ?? "plan" : command,
    argv: [...args],
    cwd,
    root: resolve2(flag(args, "root") ?? (project ? dirname2(resolve2(project)) : cwd)),
    wallMs: 0,
    phases: [],
    status: "ok",
    exitCode: 0,
    errorCode: null,
    planId: null,
    cli: { version: package_default.version, sha256: null },
    checker: null
  };
  return active.run(run, async () => {
    try {
      return await execute();
    } catch (error) {
      run.status = "failed";
      run.exitCode = 1;
      run.errorCode = /^(?:Error: )?([A-Z][A-Z0-9_]+):/.exec(String(error))?.[1] ?? "UNKNOWN_ERROR";
      throw error;
    } finally {
      run.wallMs = Math.round(performance.now() - start);
      await append(run).catch(() => {});
    }
  });
}

// scripts/skill-launcher.ts
import { join as join3, resolve as resolve4, dirname as dirname4 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// src/languages.ts
var languageOperations = {
  typescript: ["rename", "imports", "format", "extract-function", "extract-variable", "rename-file", "move-type", "move-file", "inline-reexports", "retarget-import", "port-route"],
  csharp: ["rename", "imports", "format", "rename-file", "sync-namespace", "move-type"]
};

// src/help.ts
var operationHelp = {
  "port-route": {
    description: "Port a Next App Router route to TanStack Start in one plan: move its client view, generate the Next adapter and the Start route.",
    support: "TypeScript and JavaScript (Next App Router to TanStack Start, React)",
    required: "--route <next route directory> --to <feature directory> --target-project <config> [--start-routes <directory>] [--config <port-route.json>] [--map <from=to> ...] [--exclude <glob> ...]",
    details: "Reads <root>/.refactor-ai/port-route.json (or --config): Next app directory, exclusions, preload functions, Start project/routes, route-tree generator, module maps, expression translations, ports and templates; project APIs are never built in (see examples/port-route/uber-platform). Client files of the route directory move to --to as one move-file batch with the configured maps; page.tsx, layout/loading/error files, **/_hooks/**, *adapter*, files importing server-only modules and nested route directories stay in Next. The page's default export is analyzed on the original program: const x = await hook(args), await Promise.all([...]) destructuring and direct configured preload calls are traced through hook modules to the Convex function reference and arguments. Arguments translate through configured equivalents (e.g. await searchParams), route parameters of the Start route, package imports, moved modules and the page's own const declarations; anything else (Next-only modules, let/try values, page parameters, functions) becomes a typechecking TODO(port-route) placeholder plus a plan note, never a guess. The page must render exactly one component imported from a moved file; each preloaded prop used as `const { data } = usePreloaded(prop)` or `usePreloaded(prop).data` becomes a data prop (data.prop pattern) typed by the hook's type argument or data.type. The generated Next adapter exports the page's view name, keeps the preloaded props and calls the configured data snippet; page.tsx imports the adapter instead of the view. The Start route file is named from the route's segments (dynamic [x] -> $x, groups dropped, .index when nested routes exist) and renders the view with loader prefetches, loader data and configured ports/params. View props that no page attribute, port or parameter provides become TODO placeholders when required. With start.routeTree the project's TanStack router generator regenerates the ignored route tree in a scratch mirror for validation only; regenerate it after apply. All participating projects, including the Start project, are validated; new diagnostics reject the plan with hints. Catch-all, parallel and private segments, spread or children props, memo/forwardRef views and views using a preloaded prop more than once are rejected. Review TODO notes, server-only logic (auth, redirects, notFound, metadata) and route ownership lists; run application tests and E2E.",
    examples: [
      "plan port-route --project apps/web/tsconfig.json --target-project packages/app-features/tsconfig.json --root . --route 'apps/web/src/app/[locale]/dashboard/properties/[code]/units' --to packages/app-features/src/properties/units --checker ts7 --out /tmp/units.json",
      "plan port-route --project apps/web/tsconfig.json --target-project packages/feature/tsconfig.json --root . --route apps/web/src/app/dashboard/reports --to packages/feature/src/reports --start-routes apps/start/src/routes --config .refactor-ai/port-route.json"
    ]
  },
  "move-file": {
    description: "Move modules atomically, selected declarations, or a directory with exclusions.",
    support: "TypeScript and JavaScript",
    required: "--to <destination> OR repeated --file <source=destination> [--exclude <glob> ...] [--target-project <config>] [--root <directory>]",
    details: "--file accepts a file or directory with --to, or repeated source=destination pairs without --to. A batch loads the workspace once and validates the final graph; mutually importing batch files may move together in any argument order. Directory moves preserve relative layout. Repeat --exclude with tsconfig-style globs relative to each source directory to keep server files/adapters; e.g. page.tsx and **/_hooks/**. File moves retain their extension. Destinations must not collide; target project include/files rules must cover moved sources. Use a --root covering source, destination and callers. TypeScript updates imports; cross-package importers use the destination package's exports and must declare its dependency. Exact exports are appended when needed; packages without exports are rejected. Repeat --map source=destination to retarget moved files’ own imports/re-exports and literal dynamic imports and vi.mock/doMock/importActual calls. Add --map source#Old=destination#New for named exports, preserving local/public names with aliases. Mock factory text stays unchanged: review runtime compatibility. External consumer mocks are reported; --mocks add clones standalone registrations for the mapped module. --only selects exported declarations from one source file and moves only their required imports; unselected declarations stay in the source. Types, functions and safe classes/enums are supported; variable initialization, merged declarations and re-exports require preparation. The r3 mapping-only --only behavior is now available through retarget-import --only before moving. Module maps are simultaneous and scoped to moved files. Root .refactor-ai/equivalents.json supplies default module maps only when the destination declares the alternative; explicit maps win. Compiler checks do not prove runtime compatibility. Aliases between moved files become relative imports; unresolved source-project aliases fail MOVE_IMPORT_UNRESOLVED before program loading; missing destination packages fail MISSING_DEPENDENCY with source versions and install hints. Project membership, references, cycles and new compiler errors are checked. Non-UTF-8 files and symlinks are rejected. Run application tests after moving runtime modules.",
    examples: [
      "plan move-file --project ./tsconfig.json --file ./src/components/button.tsx --to ./src/ui/button.tsx",
      "plan move-file --project ./tsconfig.json --file ./src/a.ts=./src/ui/a.ts --file ./src/b.ts=./src/ui/b.ts",
      "plan move-file --project ./tsconfig.json --file ./src/route --to ./src/ui/route --exclude page.tsx --exclude **/_hooks/**",
      "plan move-file --project ./apps/web/tsconfig.json --root . --file ./apps/web/src/components --to ./packages/feature/src/components --target-project ./packages/feature/tsconfig.json --map @/lib/hooks=@scope/feature/hooks --map next-intl=use-intl --checker ts7"
    ]
  },
  "retarget-import": {
    description: "Retarget imports and re-exports to an API-compatible module.",
    support: "TypeScript and JavaScript",
    required: "--from <specifier> --to <specifier> [--map Old=New ...] [--only Name,Name] [--mocks report|add] [--file <file|directory>]",
    details: "Exact specifiers only; wildcards are rejected. Omit --file for the loaded project. --only selects pre-map export names and splits declarations. Unaliased mapped imports rename local references semantically, including JSX; explicit aliases stay unchanged. Re-export mappings rename the imported export. Compatible named destination imports merge and identical bindings dedupe; type-only modifiers, quotes, directives and comments are retained. Default, namespace, star exports, literal dynamic imports and side-effect imports retarget only without --only; compiler diagnostics validate their compatibility. Targets must resolve from every affected file (TARGET_UNRESOLVED). Missing exports fail NEW_DIAGNOSTICS. No matches succeed with a note. --mocks report (default) lists loaded test files mocking the source while transitively importing retargeted files, including callers outside --file. --mocks add copies each standalone vi/vitest/jest mock/doMock registration for the destination with the same factory text, unless that file already mocks the destination. Expression-valued calls fail UNSUPPORTED_MOCK_CALL in add mode. Project references are unsupported. Verify runtime behavior separately.",
    examples: [
      "plan retarget-import --project apps/web/tsconfig.json --root . --from next-intl --to use-intl --map NextIntlClientProvider=IntlProvider",
      "plan retarget-import --project ./tsconfig.json --from old-lib --to new-lib --only Widget,Options --file ./src/features"
    ]
  },
  rename: {
    description: "Rename a symbol and its semantic references.",
    support: "TypeScript, JavaScript and C#",
    required: "--at <line:column> --name <identifier> (TS/JS: --symbol <name> instead of --at; optional --public)",
    details: "TS/JS --symbol selects one top-level declaration (missing or ambiguous names fail); --public propagates unaliased public names through loaded consumers instead of keeping the old export name. Comments and string literals are excluded. Use a .sln and a common --root for C# callers across projects. External consumers and dynamic references are outside the loaded scope.",
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
  "inline-reexports": {
    description: "Import re-exported bindings directly from their origin modules.",
    support: "TypeScript and JavaScript",
    required: "[--file <shim> ...] [--keep]",
    details: "Follows compiler-resolved aliases and relative export * chains, stopping at bare/package entries. Splits mixed imports by origin, retaining type modifiers, aliases, quotes and extension conventions. Mixed modules retain all re-exports. Unreferenced pure shims are deleted and config file lists updated unless --keep is supplied. Side-effect imports stay with a note. Namespace imports require a pure single-origin export * shim with no default export at the origin. Literal dynamic imports also retarget pure single-origin star shims with no default export; other dynamic references and import types prevent deletion. Repeat --file to inline several shims with shared callers in one plan. New compiler errors are rejected; run application tests for initialization behavior and external consumers.",
    examples: [
      "plan inline-reexports --project ./tsconfig.json --file ./src/shim.ts",
      "plan inline-reexports --project ./apps/web/tsconfig.json --root . --file ./apps/web/src/shim.ts --keep"
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
    rename: { required: "--at <line:column> --name <identifier>", details: "Comments and string literals are excluded. Use a .sln and a common --root for callers across projects. External consumers and dynamic references are outside the loaded scope." },
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
` : ""}  --file <source>          Required for plan except retarget-import; a file, or a directory for move-file/retarget-import.
                           move-file accepts repeated --file source=destination pairs; inline-reexports accepts repeated files.
  --keep                   Retain the shim for inline-reexports.
${language !== "csharp" ? `  --checker <ts5|ts7|both> TS5 default; ts7 uses installed Go 7.0.2 diagnostics.
                           both audits TS5+TS7, rejecting any disagreement.
  --verify <full|bindings> full (default) checks program diagnostics; bindings checks
                           edits, references and import bindings only (typecheck after
                           apply). Defaults: <root>/.refactor-ai/config.json.
` : ""}  --root <directory>       Boundary for source, configs and callers; defaults to
                           the project configuration's directory.
  --at <line:column>       Symbol/type position or extraction start, 1-based UTF-16.
${language !== "csharp" ? `  --symbol <name>          TS/JS rename: top-level declaration instead of --at.
  --public                 TS/JS rename: propagate unaliased public export names.
` : ""}  --end <line:column>      Extraction end, exclusive, 1-based UTF-16.
  --name <identifier>      Required new name for rename and extraction.
  --mode <mode>            imports: ${language === "csharp" ? "remove-unused (default); sorting is unsupported" : "sort (default) or remove-unused"}.
  --type <identifier>      Declared type for rename-file or move-type; select when
                           several types exist, or use --at.
  --to <path|specifier>    Destination for move-type/move-file (path) or retarget-import (specifier).
  --from <specifier>       Source module specifier for retarget-import.
  --map <from=to>          Repeatable export mapping (retarget-import), module or module#Export mapping (move-file).
  --only <Name,Name>       retarget-import: pre-map export names; move-file: declarations to move.
  --exclude <glob>         Repeatable directory move exclusions, relative to each source directory.
  --mocks <report|add>     Report affected test mocks (default), or add parallel mocks.
  --target-project <config> Destination project config; move-type, move-file or port-route.
${language !== "csharp" ? `  --route <directory>      port-route: Next App Router route directory (instead of --file).
  --start-routes <dir>     port-route: TanStack Start routes directory override.
  --config <json>          port-route: configuration, default <root>/.refactor-ai/port-route.json.
` : ""}${language !== "typescript" ? `  --root-namespace <name>  C# namespace convention override for sync-namespace
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
  dotnet/RefactorHelper. Installed skills locate their bundled helper automatically.
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
  run your project's tests. Apply requires passed validation and unchanged recorded inputs. Empty plans apply regardless of unrelated changes.
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
  const known = ["capabilities", "plan", "preview", "validate", "apply", "serve", "gc"];
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
      validate: "Check the plan's integrity, recorded read set and stored compiler analysis. Does not re-run compilation or project tests. A failed validation returns exit 1.",
      apply: "Apply the exact validated plan to unchanged recorded inputs. Empty plans need no freshness check. Uses a lock and journal; on failure attempts to roll back its own writes. Replan after changes."
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
  if (command === "gc")
    return `${title}
gc: Remove completed apply journals; retain failed and interrupted transactions.

Usage:
  ${invocation} gc [--root <repo>]

Examples:
  ${invocation} gc --root .
`;
  if (command === "serve") {
    return `${title}
serve (author CLI): Keep TypeScript single-project programs warm between sequential plan requests.

Usage:
  ${invocation} serve --root <repo>

Send one JSON object per stdin line: {"id":1,"args":["plan",<normal plan arguments>]}.
One response per stdout line: {id,status,output} or {id,status,error}. Requests may
only plan within the server root. EOF releases programs and exits. External content,
configuration, resolution probes and directory membership are rechecked before reuse.
Workspace file operations still use fresh workspaces.

Examples:
  ${invocation} serve --root .

REFACTOR_AI_CACHE=on enables the optional persistent baseline cache. Its location defaults to
<root>/.refactor-ai/cache; REFACTOR_AI_CACHE_DIR selects an external directory.
`;
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
  ${invocation} plan ${operation} --project <config> ${operation === "retarget-import" ? "[--file <file|directory>]" : operation === "port-route" ? "--route <directory>" : "--file <source>"} [operation options]

${operationText(operation, invocation, language)}
Options and defaults:
${options}
${context}
${workflow(invocation)}
${runtimeRequirements}`;
  }
  if (!command)
    return `${title}
Commands: capabilities, plan, preview, validate, apply, serve, gc, help.

Operations:
${(language ? languageOperations[language] : Object.keys(operationHelp)).map((key) => `  ${key}`).join(`
`)}

Examples:
  ${invocation} plan <operation> --help
  ${invocation} <command> --help
`;
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

// src/runtime/skill.ts
import { existsSync as existsSync2, readFileSync } from "node:fs";
import { mkdir as mkdir2, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join as join2 } from "node:path";

// src/runtime/npm.ts
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname as dirname3, join, resolve as resolve3 } from "node:path";
function npmCli() {
  const executableDirectory = dirname3(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    resolve3(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ...(process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, process.platform === "win32" ? "npm.cmd" : "npm"))
  ];
  for (const candidate of candidates) {
    if (!candidate)
      continue;
    try {
      let path = realpathSync(candidate);
      if (path.endsWith(".cmd"))
        path = join(dirname3(path), "node_modules", "npm", "bin", "npm-cli.js");
      if (path.endsWith("npm-cli.js") && existsSync(path))
        return path;
    } catch {}
  }
  throw new Error("NPM_NOT_FOUND: npm is required; install Node.js with npm");
}

// src/runtime/skill.ts
async function ensureSkillRuntime(skillRoot, quiet = false) {
  const runtime = join2(skillRoot, "assets", "runtime");
  const ready = () => {
    try {
      const manifest = JSON.parse(readFileSync(join2(runtime, "node_modules", "typescript", "package.json"), "utf8"));
      return manifest.version === "5.9.3" && existsSync2(join2(runtime, "node_modules", "typescript", "lib", "typescript.js"));
    } catch {
      return false;
    }
  };
  if (ready())
    return;
  const lock = join2(runtime, ".setup.lock");
  try {
    await mkdir2(lock);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`SKILL_SETUP_BUSY: another setup is running; after an interrupted setup inspect ${lock}`);
    throw error;
  }
  try {
    if (ready())
      return;
    if (!quiet)
      process.stderr.write(`Installing the skill's locked TypeScript runtime dependency...
`);
    const result = spawnSync(process.execPath, [npmCli(), "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: runtime,
      stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", process.stderr, process.stderr],
      timeout: 180000,
      encoding: "utf8"
    });
    if (result.error)
      throw new Error(`SKILL_SETUP_FAILED: ${result.error.message}`);
    if (result.status !== 0 || !ready())
      throw new Error(`SKILL_SETUP_FAILED: npm ci did not install the locked runtime dependency${quiet ? `
${result.stderr || result.stdout}` : ""}`);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

// scripts/skill-launcher.ts
var skillRoot = resolve4(dirname4(fileURLToPath(import.meta.url)), "..");
var runtime2 = join3(skillRoot, "assets", "runtime");
try {
  await logRun(process.argv.slice(2), async () => {
    if (Number(process.versions.node.split(".")[0]) < 22)
      throw new Error("UNSUPPORTED_RUNTIME: Node.js 22+ is required");
    if (helpRequested(process.argv.slice(2))) {
      process.stdout.write(renderHelp(process.argv.slice(2), 'node "<skill-root>/scripts/refactor.mjs"'));
      return;
    }
    await ensureSkillRuntime(skillRoot);
    const { main } = await import(pathToFileURL(join3(runtime2, "cli.mjs")).href);
    await main(process.argv.slice(2), { runLog: false, toolkitRoot: join3(skillRoot, "assets") });
  });
} catch (error) {
  console.error(JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
