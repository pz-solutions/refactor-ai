# Programmatic refactoring

Use the importable interface to compose deterministic refactorings in a custom Node.js ESM script. npm packages export `createRefactor` from their package root and include TypeScript declarations. Installed skills export the same function from `<skill-root>/scripts/api.mjs`, beside their CLI launcher. Node.js 22+ is required.

```js
import { createRefactor } from "@refactor-ai/ts-rename";

const rename = await createRefactor();
const plan = await rename.plan({
  project: "./tsconfig.json",
  file: "./src/math.ts",
  at: "1:17",
  name: "sum",
});

console.log(rename.preview(plan));
const validation = await rename.validate(plan);
if (validation.status !== "validated") throw new Error("Rename adds compiler errors");
await rename.apply(plan);
```

The aggregate `@refactor-ai/cli` API requires `operation` in plan options. An operation package selects its own operation and rejects other operations. `ts-*` supports TypeScript and JavaScript; `csharp-*` supports C#. Language restrictions also apply to loaded plans, previews, validation and application. Saved plans of other operations in the same language can be inspected and applied, just as with the CLI.

## Installed skills

Resolve the installed skill directory from its `SKILL.md`, then import the adjacent module. The importing script can live outside the target project and skill directory.

```js
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const skillRoot = process.argv[2];
const { createRefactor } = await import(
  pathToFileURL(resolve(skillRoot, "scripts/api.mjs")).href
);
const rename = await createRefactor();
```

Importing the module leaves arguments, environment, exit status and sources unchanged, with no dependency installation or output. Calling `createRefactor()` on an installed skill prepares its locked TypeScript dependency if needed, using npm with lifecycle scripts disabled. Initial setup needs npm, network access and a writable skill directory. Setup errors reject the promise; simultaneous setup of one skill reports `SKILL_SETUP_BUSY`. Create one instance and reuse it.

npm installs package dependencies at installation time. C# requires .NET 8 SDK, the target project's SDK/workloads and restored dependencies. The first C# analysis builds the bundled, locked Roslyn helper if needed; this requires NuGet access and a writable package/skill directory. Helper lookup belongs to each instance and does not change `REFACTOR_AI_HOME` or depend on the importing script's working directory.

## Interface

`await createRefactor()` returns a `RefactorApi` object:

| Method | Result and behavior |
| --- | --- |
| `await plan(options)` | Returns a `Plan` with changes, diagnostics, snapshot and validation. Writes no sources or plan files. A compiler diagnostic failure is represented by `plan.validation.status === "failed"`. Unsupported operations and analysis failures throw. |
| `preview(plan)` | Returns a diff string after checking plan integrity and language. A no-op plan returns an empty string. |
| `await validate(plan)` | Returns `{ status: "validated" \| "failed", validation, id }`. Rejects malformed, modified or stale plans. Checks stored compiler diagnostics; does not rerun project tests. |
| `await apply(plan)` | Applies that exact plan and returns `{ status: "applied", files, journal }`. Rejects stale or failed plans. Uses the CLI's integrity checks, lock, rollback and journal. |
| `await loadPlan(path)` | Reads a CLI-compatible JSON plan and checks its shape, integrity and language. Freshness is checked by validate/apply. |
| `await capabilities(project)` | Returns supported operations and modes for the project and this distribution. Does not build the C# helper. |

All failures are ordinary rejected promises or, for synchronous `preview`, thrown `Error` objects with the existing error code prefix in `message`. Methods do not print results or change `process.exitCode`, `process.argv`, the environment or the working directory. Custom scripts decide how to report results and handle errors.

### Plan options

Paths resolve against the custom script process's current working directory. Returned plan paths are canonical and absolute.

| Option | Meaning |
| --- | --- |
| `project`, `file` | Required project configuration and source file (a directory for move-file; optional for retarget-import, which accepts a file or directory). TS/JS uses tsconfig/jsconfig JSON; C# uses `.csproj` or `.sln`. |
| `root` | Directory covering the project and all changed files; defaults to the project configuration's directory. Set a shared root for cross-project changes. |
| `checker` | TS/JS only: `"ts5"` (default), `"ts7"` (native diagnostics only) or `"both"` (TS5+TS7 audit, rejects any file+code/multiplicity disagreement). TS7/both require Node.js 22+ and the separately installed optional alias `typescript7@npm:typescript@7.0.2`; project-reference declaration builds are unsupported. Edits always use TS5. Returned `plan.checker` records the checker/version and audit reference when used. No runtime downloads. |
| `operation` | Required for aggregate APIs; optional for operation APIs. |
| `at` | A 1-based `"line:column"` string or zero-based character offset, both measured in UTF-16 code units. Required for rename and extraction. |
| `end` | Exclusive extraction end, with the same coordinate formats as `at`. |
| `name` | New symbol, function or variable name, as required by the operation. |
| `mode` | Imports mode: `"sort"` or `"remove-unused"`. TS/JS defaults to sort; C# operation APIs default to remove-unused. The aggregate API retains the CLI convention: request remove-unused explicitly for C#. |
| `target` | Destination file/directory path for move-type or move-file, including a new parent directory if needed. |
| `targetProject` | Destination project configuration for a cross-project move. Valid for move-type or move-file. |
| `typeName` | Select a declared type when a file has several declarations. |
| `keep` | Boolean, valid only for `inline-reexports`; retain the shim after retargeting its callers. Defaults to false. |
| `from`, `to` | Exact source and destination module specifiers; required for retarget-import. Wildcard prefixes are rejected. |
| `map` | retarget-import export mapping object, e.g. `{ NextIntlClientProvider: "IntlProvider" }`. Unaliased bindings and semantic usages rename; explicit local aliases remain unchanged. |
| `only` | retarget-import array of pre-map export names. Other bindings stay on the source module; declarations split as needed. Default/namespace imports require this option absent. |
| `mocks` | retarget-import: `"report"` (default) lists affected test mocks; `"add"` inserts parallel destination mocks with the same factory text. |
| `rootNamespace` | Override the C# project's namespace convention. |

Example: `await refactor.plan({ operation: "move-file", project: "./apps/web/tsconfig.json", root: ".", file: "./apps/web/src/components", target: "./packages/feature/src/components", targetProject: "./packages/feature/tsconfig.json" })`. The `@refactor-ai/ts-move-file` package and `refactor-move-file` skill select this operation automatically. Directory moves include non-source UTF-8 files. Cross-package importers use package exports (missing exact entries become planned manifest edits) and must declare the destination dependency. Unresolved source-project aliases fail with `NEW_DIAGNOSTICS` and an alias hint. Moved files use relative imports for their destination package’s own bare specifiers, following that package’s extension style. Matching entries in the nearest ancestor `eslint-suppressions.json` transfer to the destination’s nearest ledger, merging rule counts. A missing destination ledger is created only for a package with `eslint.config.*`; otherwise source entries are removed with a review note. Ledger edits use two-space JSON and a trailing newline, retaining existing key order (sorted ledgers remain sorted).

Read the operation's CLI `--help` for engine-specific support and limitations. TypeScript consumers can import `RefactorApi`, `PlanOptions`, `Plan`, `ValidationResult`, `ApplyResult`, `Capability`, `Diagnostic`, `FileChange` and `Operation` as types from the same entry point.

## Retarget imports

```js
const plan = await refactor.plan({
  operation: "retarget-import", // omit in @refactor-ai/ts-retarget-import
  project: "./apps/web/tsconfig.json",
  root: ".",
  from: "next-intl",
  to: "use-intl",
  map: { NextIntlClientProvider: "IntlProvider" },
  // file: "./apps/web/src/features", // optional file or directory scope
  // only: ["useTranslations", "NextIntlClientProvider"],
  // mocks: "add", // default: "report"
});
```

Scope defaults to every user source in the loaded TS/JS project. Compatible named destination imports merge and identical bindings dedupe, preserving quote style, type-only modifiers, directives and comments. Explicit re-export aliases stay unchanged; an unaliased re-export takes its mapped name. Default/namespace imports, star re-exports and side-effect imports move only without `only`; compiler diagnostics check member compatibility. Unresolvable destination modules throw `TARGET_UNRESOLVED` listing affected files; missing exports throw `NEW_DIAGNOSTICS` naming the binding. No matches succeed with a note. Project references and wildcard module matching are unsupported. Compiler checks do not establish runtime API compatibility.

`mocks: "report"` adds a note listing loaded files with `vi`, `vitest` or `jest` `mock`/`doMock` calls for `from` that import a retargeted file directly or transitively. Callers outside `file` scope are included; mocks alone do not establish an import edge. `mocks: "add"` inserts a parallel registration immediately after each such statement, retaining the original callee, factory expression text, quotes and newline style. Files already registering a mock for `to` are skipped. Calls must be standalone expression statements in a source file or block; expression-valued calls fail `UNSUPPORTED_MOCK_CALL` in add mode and can still be reported. Destination resolution and compiler validation cover added mocks. Computed specifiers and callers outside the loaded project are outside this analysis; run application tests to verify factory behavior, especially after export mapping.

## Sequential automation

Plan, validate and apply each step before planning the next. Applying one step changes the project's snapshot and may move files or shift positions, making older plans or coordinates stale. Parallel planning followed by applying all plans is unsupported. A sequence is not one transaction: if a later step fails, earlier successful steps remain applied and have their own journals.

```js
import { createRefactor as createRename } from "@refactor-ai/ts-rename";
import { createRefactor as createImports } from "@refactor-ai/ts-imports";

const rename = await createRename();
const imports = await createImports();
const project = "./tsconfig.json";
const file = "./src/math.ts";

const first = await rename.plan({ project, file, at: "1:17", name: "sum" });
if ((await rename.validate(first)).status !== "validated") throw new Error("Rename failed validation");
await rename.apply(first);

const second = await imports.plan({ project, file, mode: "remove-unused" });
if ((await imports.validate(second)).status !== "validated") throw new Error("Imports failed validation");
await imports.apply(second);
```

Source changes come from the compiler engine. Custom scripts select operations and parameters rather than modifying `plan.changes`. Modifying a plan invalidates its integrity hash. Pin installed npm versions with a lockfile for repeatable automation.

## Saved plans

The returned plan is the same JSON schema the CLI uses. To persist a plan, write it under `<root>/.refactor-ai/` or outside the project root; another location inside the project changes its snapshot. Keep the plan unchanged and validate it before applying.

```js
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = join(plan.request.root, ".refactor-ai");
await mkdir(directory, { recursive: true });
const saved = join(directory, `${plan.id}.json`);
await writeFile(saved, JSON.stringify(plan, null, 2) + "\n");
const samePlan = await rename.loadPlan(saved);
```

The core treats `.refactor-ai` as reserved state and rejects redirected state directories when applying. Use the CLI's `--out` workflow when you need its additional plan-output path checks.

## Inline re-exports (TypeScript/JavaScript)

```js
import { createRefactor } from "@refactor-ai/ts-inline-reexports";
const inline = await createRefactor();
const plan = await inline.plan({ project: "./tsconfig.json", root: ".", file: "./src/shim.ts", keep: false });
console.log(inline.preview(plan));
```

The aggregate API uses `operation: "inline-reexports"`. Named/default imports and
re-exports split by compiler-resolved origin. Relative chains are followed; bare
module specifiers preserve the shim's public package entry. Mixed modules retain
all re-exports. Pure shims are deleted only without remaining loaded references,
unless `keep: true`; deletions use schemaVersion 2 and update config file lists.
Side-effect imports stay with a note. Dynamic imports and import types stay and
prevent deletion. Namespace imports require a pure single-origin `export *` shim
with no default at its origin (`NAMESPACE_IMPORT_UNSUPPORTED` otherwise).
Import/export attributes are unsupported. Resolution changes and new compiler
errors throw; application initialization behavior, directives and external
consumers require separate verification.
