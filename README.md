<img src="assets/icon.svg" width="64" height="64" alt="RAI — refactor-ai">

# refactor-ai

Deterministic refactorings exposed through skills and a CLI written in TypeScript, built with Bun into JavaScript that runs on Node.js. TypeScript Language Service or Roslyn computes the changes; the model selects the operation and its parameters.

| Operation | TypeScript / JavaScript | C# / .NET |
| --- | --- | --- |
| Rename a symbol and its references | Yes | Yes, including across projects in a `.sln` |
| Remove unused imports / using directives | Yes, explicit mode | Yes, Roslyn `CS8019` diagnostics |
| Retarget imports / re-exports (`retarget-import`) | Yes, partial selection, export mapping and compiler validation | Not yet |
| Sort imports | Yes, without removing unused imports | Not yet |
| Format a file | TypeScript formatter | Roslyn Formatter |
| Extract function | Yes, engine-provided action | Not yet |
| Extract variable / constant | Yes, engine-provided action | Not yet |
| Move a type between directories / projects | Yes, TypeScript's “Move to file” action | Yes, Roslyn with planned `.csproj` edits |
| Move whole modules or directories between workspace packages | Yes, including package exports and import updates | Not yet |
| Match a filename to its declared type | Yes, including import updates | Yes, including explicit `Compile` entries |
| Inline shim re-exports into their callers | Yes, with package entry preservation | Not yet |
| Match a namespace to the project structure | Not applicable to ES modules | Yes, including semantic reference updates |

## Getting started

Runtime requirements: Node.js 22 or newer and this package's runtime dependencies. C# also requires the .NET 8 SDK (`dotnet` in `PATH`) and restored dependencies in the target project; that project may require an additional SDK version. Bun is needed for development builds and tests; the built CLI runs without it. Initial npm/NuGet package downloads require network access.

```sh
bun install --frozen-lockfile
bun run build:csharp
bun run build
node dist/demo.js
```

The demo uses fresh copies of the TS, JS and C# examples. It displays diffs, applies prepared plans and compares program output before and after each set of changes. It also covers moving a type into a new directory, matching a filename to its type and synchronizing a C# namespace. Templates in `examples/` remain available for reuse. `node dist/demo.js --keep` retains the copies and plans for inspection. The demo always runs the built CLI through Node and compiles TypeScript examples to JS with the pinned TypeScript compiler.

Bun builds with `--target node` produce `dist/cli.js` and `dist/demo.js` as ESM modules in plain JavaScript. Runtime code uses Node APIs. The `typescript` package and its standard libraries remain an external, pinned dependency: the JS file alone is not a complete distribution. Include `dist/`, `package.json` (with `type: module`) and the runtime dependencies when relocating the CLI; dependencies can also be installed at the destination with `npm install --omit=dev`. For C#, include the complete `dotnet/RefactorHelper/bin/Release/net8.0/` directory with the .NET helper's dependencies. The demo additionally needs `examples/`.

## CLI

Every CLI provides English `--help` with requirements, options and examples. The refactoring runner also supports command and operation help:

```sh
node dist/cli.js --help
node dist/cli.js plan move-type --help
node dist/cli.js apply --help
node dist/demo.js --help
bun run package:skills --help
dotnet dotnet/RefactorHelper/bin/Release/net8.0/RefactorHelper.dll --help
```

Installed launchers expose the same help through `node "<skill-root>/scripts/refactor.mjs" --help`. Help does not install dependencies, load projects or change files; it works before a skill's first setup. Each `SKILL.md` points to its operation's help as the source for CLI usage.

```sh
node dist/cli.js capabilities --project examples/typescript/tsconfig.json
node dist/cli.js plan rename \
  --project examples/typescript/tsconfig.json \
  --file examples/typescript/math.ts \
  --at 1:17 --name sum
```

`plan` returns the path to a JSON file containing edits, diagnostics and a snapshot hash. Use that path in subsequent commands:

```sh
node dist/cli.js preview --plan /absolute/path/to/plan.json
node dist/cli.js validate --plan /absolute/path/to/plan.json
node dist/cli.js apply --plan /absolute/path/to/plan.json
```

`--at` and `--end` use 1-based `line:column` positions measured in UTF-16; the extraction end is exclusive. Examples of other operations:

```sh
node dist/cli.js plan imports --project examples/typescript/tsconfig.json \
  --file examples/typescript/caller.ts --mode sort
node dist/cli.js plan imports --project examples/csharp/Caller.csproj \
  --file examples/csharp/Utility.cs --mode remove-unused
node dist/cli.js plan format --project examples/csharp/Caller.csproj \
  --file examples/csharp/Utility.cs
node dist/cli.js plan extract-variable --project examples/typescript/tsconfig.json \
  --file examples/typescript/math.ts --at 2:10 --end 2:22 --name total
```

Retarget API-compatible TS/JS modules across the loaded project, or narrow to a file/directory with `--file`:

```sh
node dist/cli.js plan retarget-import --project apps/web/tsconfig.json --root . \
  --from next-intl --to use-intl --map NextIntlClientProvider=IntlProvider
```

`--map` renames unaliased local bindings and semantic references (including JSX); explicit aliases stay unchanged. `--only Name,Name` selects pre-map names and splits declarations. Compatible destination named imports merge; quotes, type-only modifiers, comments and directives are retained. Default/namespace imports require `--only` absent and pass compiler validation. Exact specifiers only; missing target modules fail `TARGET_UNRESOLVED`, missing exports fail `NEW_DIAGNOSTICS`. No matches produce a successful no-op. `--mocks report` (default) lists tests that mock the source module while transitively importing retargeted files. `--mocks add` adds parallel destination mocks with the same factory text, skipping files already mocking the destination. Only standalone mock statements can be added; callers must be in the loaded project. Runtime compatibility still needs application tests.

The default root is the project configuration's directory. Supply `--root` for a wider scope; use a `.sln` for C# rename operations with callers in several projects. Plans default to `<root>/.refactor-ai/`; `--out` may point outside the project or into that directory. `node dist/cli.js` lists these commands. When relocating the CLI, set `REFACTOR_AI_HOME` to this package's directory so it can locate the C# helper.

Type refactoring examples (replace paths and type names with your own):

```sh
node dist/cli.js plan rename-file --project ./tsconfig.json --file ./Wrong.ts --type Widget
node dist/cli.js plan sync-namespace --project ./App.csproj --file ./Models/Widget.cs
node dist/cli.js plan move-type --project ./Workspace.sln --root . \
  --file ./Source/Widget.cs --type Widget --to ./Destination/Models/Widget.cs \
  --target-project ./Destination/Destination.csproj
```

`move-file` moves a whole file or directory, including non-source text files, with `--to` and optional `--target-project`. Cross-package callers use declared package exports; missing exact entries are planned in package.json. Importer packages must already declare the target dependency. Source-project aliases between moved files become relative imports; unresolved aliases fail with a diagnostic hint. Moved files replace destination-package self-imports with relative specifiers in that package’s style. Matching ESLint bulk-suppression entries follow moved files, merging rule counts; a new ledger requires a destination package ESLint config, otherwise dropped entries are noted for review. Directory moves preserve relative layout and file modes. Symlinks and non-UTF-8 assets are rejected.

`--to` specifies the destination file, including one in a directory that does not exist yet. For cross-project moves, `--target-project` identifies the destination `.csproj` or TS/JS configuration; `--root` must cover all changes. Plans that create or delete files use schemaVersion 2; legacy version 1 edit plans remain supported. `preview` also shows created and deleted files, and apply records a journal and rolls back its own changes on failure.

C# moves update namespaces that follow the project's folder convention. Custom namespaces are preserved unless you supply `--root-namespace`. Namespace synchronization affects the selected file and its references, leaving other files in their existing namespace. Moving a C# type between projects changes its assembly; dependencies on reflection and assembly-qualified names need separate verification.

## Custom automation scripts

npm packages also export `createRefactor` with TypeScript declarations. Installed skills include the same interface at `<skill-root>/scripts/api.mjs`. Importing a module does not execute the CLI. The returned object plans, previews, validates and applies compiler-generated changes without parsing CLI output.

```js
import { createRefactor } from "@refactor-ai/ts-rename";
const rename = await createRefactor();
const plan = await rename.plan({ project: "./tsconfig.json", file: "./src/math.ts", at: "1:17", name: "sum" });
if ((await rename.validate(plan)).status !== "validated") throw new Error("Rename failed validation");
await rename.apply(plan);
```

Read the [programmatic interface](docs/api.md) for installed-skill imports, all methods and options, requirements, errors and sequential automation. Apply each step before planning the next because plans are tied to project snapshots. Package builds include this interface; publishing a new version is required to distribute it through npm.

## npm CLI packages

Build independently publishable packages: the complete `@refactor-ai/cli`, `@refactor-ai/ts-<operation>` tools for TypeScript/JavaScript, and six `@refactor-ai/csharp-<operation>` tools for C#. Each declares a single executable in npm's `bin` field. The author checkout remains private.

```sh
bun run package:npm
bun run package:npm --help
```

Language tools include only their compiler adapter: TS/JS tools contain no Roslyn helper, and C# tools have no TypeScript npm dependency. The aggregate `cli` supports both. Generated packages are in `dist/npm/`. They include the built Node runner and the selected backend’s dependencies: pinned TypeScript for TS/JS, or Roslyn helper sources with a NuGet lockfile for C#. Consumers need Node.js 22+ and npm; C# also requires .NET SDK. Bun is unnecessary at runtime. There are no install lifecycle scripts; the helper builds on first C# use.

After publishing under names you own:

```sh
npx @refactor-ai/cli --help
npx @refactor-ai/ts-rename --help
npx @refactor-ai/ts-rename plan --project ./tsconfig.json --file ./src.ts --at 1:14 --name newName
npx @refactor-ai/ts-rename preview --plan ./path/to/plan.json
npx @refactor-ai/ts-rename validate --plan ./path/to/plan.json
npx @refactor-ai/ts-rename apply --plan ./path/to/plan.json
```

The default scope is `@refactor-ai`. Override it with `bun run package:npm --scope another-org` when needed. Local tarballs work before publishing:

```sh
npm pack ./dist/npm/ts-rename --pack-destination /tmp
npx --yes file:/tmp/refactor-ai-ts-rename-0.1.3.tgz --help
```

See [npm packaging and publishing](docs/npm-packages.md) for package names, local installation, publication and versioning. `bun run test:npm` tests actual packed archives through npx, including complete TS, JS and C# workflows.

All generated npm packages share the version in the author `package.json`. After building, use `bun run version:packages patch --dry-run` to preview a bump, or `bun run version:packages --help` for minor/major and beta/RC examples. Release tags must match `v<version>`; stable releases use `latest` and prereleases use `next`. The publisher checks registry versions and refuses to move those channels backwards. See the [release procedure](docs/github-actions.md#release-a-version).

## Skills

Ready-to-use runner instructions are included in the repository:

- [refactor-rename](skills/refactor-rename/SKILL.md)
- [refactor-imports](skills/refactor-imports/SKILL.md)
- [refactor-format](skills/refactor-format/SKILL.md)
- [refactor-extract-function](skills/refactor-extract-function/SKILL.md)
- [refactor-extract-variable](skills/refactor-extract-variable/SKILL.md)
- [refactor-rename-file](skills/refactor-rename-file/SKILL.md)
- [refactor-sync-namespace](skills/refactor-sync-namespace/SKILL.md)
- [refactor-move-type](skills/refactor-move-type/SKILL.md)
- [refactor-move-file](skills/refactor-move-file/SKILL.md)
- [refactor-inline-reexports](skills/refactor-inline-reexports/SKILL.md)
- [refactor-retarget-import](skills/refactor-retarget-import/SKILL.md)

Each skill is a self-contained directory with `SKILL.md`, a Node launcher in `scripts/refactor.mjs`, and the built CLI and npm lockfile in `assets/runtime/`. Skills supporting C# also include Roslyn helper sources in `assets/dotnet/`. They depend on files within their own directory and can run independently of the original checkout.

### Installing with npx skills

Run this in the project where you want to use the skills:

```sh
npx skills add /absolute/path/to/refactor-ai --skill '*' --agent codex --yes
```

From this repository's directory, use `npx skills add . --skill '*' --agent codex --yes`. Select a single skill with `--skill refactor-rename`; `--global` installs globally, while `--copy` chooses independent copies instead of links for agents that support both modes. You can select an agent other than `codex`. Installation was verified with `skills@1.7.0` in a temporary project without changing global skills.

The installer copies the skill's prepared resources and does not build them. On first use, the launcher runs `npm ci --omit=dev --ignore-scripts` through Node and npm using the bundled lockfile, installing TypeScript 5.9.3 into that skill's directory. This requires internet access and a writable skill directory; later invocations reuse the local dependency. The first C# operation also builds the bundled helper through the .NET SDK, restoring pinned NuGet packages. Users of installed skills do not need Bun.

You can also invoke an installed skill directly:

```sh
node .agents/skills/refactor-rename/scripts/refactor.mjs capabilities --project ./tsconfig.json
```

For authors: `bun run package:skills` rebuilds the CLI and refreshes the resources for all skills. Include the generated `scripts/` and `assets/` directories in each distributed skill, excluding local caches such as `node_modules`, `bin`, `obj` and `.setup.lock`. `SKILL.md` alone cannot execute a refactoring. `bun run build` also refreshes these resources.

## Recipe: extracting framework-free code into a workspace package

Field-tested on a Next.js → TanStack Start migration of a ~900-file Bun monorepo ([dogfood log](docs/dogfood/2026-10-17-tanstack-start-migration.md)). Each step is one plan; run them in this order so every plan validates cleanly:

1. **Retarget framework imports** in the files you will move: `retarget-import --from next-intl --to use-intl --map NextIntlClientProvider=IntlProvider --file <dir> --mocks add`, and app aliases that re-export shared code (`--from @/lib/formatters --to @scope/shared/formatters`).
2. **Inline shims** that only re-export the target package: `inline-reexports --file <shim>`. Dynamic `import()` of a shim keeps it alive; retarget those by hand.
3. **Move** the module or directory: `move-file --file <dir> --to packages/<pkg>/src/<dir> --target-project packages/<pkg>/tsconfig.json`. Importers get the package's `exports` subpath (entries are added, index modules publish the directory), `vi.mock` paths follow, same-package imports become relative, ESLint bulk-suppression entries move with their files.
4. If the move fails with `NEW_DIAGNOSTICS`, read the first errors: an unresolved `@/…` alias means a dependency still lives in the app (retarget or move it first); `Cannot find module 'x'` means the destination package must declare `x` (add it with the app's version and install).

Always pass the workspace root as `--root`, run the project's formatter and linter on changed files after `apply` (the engine uses the TypeScript formatter), and run the application tests. Lint rules that depend on per-package configuration (for example shadcn's `components.json`) do not move with the code; compare the destination package's lint setup.

## MVP guarantees and limitations

- Planning transforms code in memory and compares compiler errors before and after the change. `validate` checks snapshot freshness and the stored analysis result; it does not automatically run an arbitrary project's tests. The demo and regression tests separately verify example behavior.
- Apply executes the exact stored plan and rejects changed snapshots and new errors. The snapshot covers regular files under the root, excluding `.git`, `node_modules`, `bin`, `obj`, `dist` and `.refactor-ai`. Dependencies are represented by manifests and lockfiles; changes to libraries outside the root are not fully fingerprinted.
- Rename uses symbols and references. Comments and strings remain unchanged; API consumers outside the loaded project, reflection and dynamic JS references are not automatically updated.
- TS `rename-file`, `move-type`, `move-file` and `inline-reexports` validate the source and destination configurations and the loaded project-reference graph, with declarations built in memory. Other TS operations still reject project references. C# analyzes the loaded MSBuild configuration rather than every possible compilation condition; select a `.sln` to include dependent projects.
- TS file operations check changed files and their transitive importers in each participant's original and planned module graphs. Resolution changes (including package `exports` edits) also seed the closure, even for unchanged importers. Scripts, declaration-file edits, global/ambient declarations, configuration edits, non-`exports` package edits and project-reference declaration builds retain full checks. Compiler option/global diagnostics and output-layout checks always run; unrelated existing file diagnostics may be omitted from plans using the closure. Imported declarations can still require checking dependencies, so cost does not scale only with the closure's size.
- Additional TS/JS configurations beside a participating project, such as `tsconfig.build.json`, are updated and validated when they cover the affected file. Discovered callers importing that file also join the analysis. Other configurations covering it cause rejection rather than leaving unchecked changes.
- TS/JS type moves support declarations in ES modules; CommonJS source code, merged declarations and types inside namespaces are rejected. Compiling ES modules to CommonJS is supported. Projects may use different `paths`, `baseUrl`, `rootDirs`, `customConditions`, `moduleSuffixes`, `resolvePackageJsonExports`, `resolvePackageJsonImports` and `allowImportingTsExtensions`; each participant validates its own resolution, and moved type imports must retain their original targets. Shared editing still requires identical `module`, `moduleResolution`, `moduleDetection`, `allowJs`, `jsx`, `jsxImportSource`, `esModuleInterop`, `allowSyntheticDefaultImports`, `resolveJsonModule`, `rewriteRelativeImportExtensions`, `allowArbitraryExtensions`, `verbatimModuleSyntax`, `preserveSymlinks`, `experimentalDecorators` and `typeRoots`.
- C# type moves and namespace changes reject, among other cases, partial declarations spread across files, conditional compilation, and multiple or nested namespaces. `.csproj` edits support standard SDK globbing or explicit, unconditional `Compile` entries; unknown MSBuild rules, dependency cycles and new compiler errors cause plan rejection.
- C# type moves retain source-project global using directives, including when the moved type was the file's only declaration. Required new project references are inserted unconditionally. Helper discovery uses the selected toolkit directory; it never executes a helper found in the analyzed project's working directory.
- TS/JS type moves reject effectful static initializers, static blocks, decorators, computed members, evaluated base-class expressions, nonconstant enum initializers and new module cycles for runtime classes. Simple identifier base classes and primitive constant initializers are supported. Compiler checks do not prove whole-program behavior equivalence; run application tests after a move.
- Plans record source permission modes. Edits and pure file renames preserve them independently of umask; split source files inherit the selected source's permissions. Other newly created files default to private access. Permission changes after planning make a plan stale. Journals include before/after modes for recovery; older plans without mode metadata remain readable. POSIX modes do not represent Windows ACLs or other extended metadata.
- Import sorting can change JS module initialization order. Removing an unused value import can remove module initialization. Choose these operations deliberately and check application tests; preserving bare side-effect imports does not prove whole-program equivalence.
- Plans preserve the original input text as a precondition. Unsupported encodings or inconsistent content produce errors rather than overwrites. Symlinks within the snapshot are rejected.
- Individual file writes are atomic; multi-file writes use the runner's lock and a recovery journal. On failure, the runner attempts to roll back its own writes. Content is checked again after preparing a write, immediately before replacement. This is not an atomic transaction or a filesystem-wide compare-and-swap: other editors do not respect the lock, so avoid editing the same files during apply.
- After an interrupted apply, inspect `.refactor-ai/apply.lock` and the `.journal.json` journal. The journal contains original text and hashes of the new versions; the MVP does not yet provide an automatic recovery command. Preserve files subsequently changed by another process when recovering.

## Verification and research

Measure cold plan latency against the dogfood monorepo (fresh Node processes;
filesystem caches are retained). All benchmark plans stay outside that repository:

```sh
bun run bench -- --root /path/to/uber-platform --runs 3 --json /tmp/cold.json
bun run bench:warm -- --root /path/to/uber-platform --runs 5 --json /tmp/warm.json
```

The author CLI supports `node dist/cli.js serve --root <repo>`: send one NDJSON
request per stdin line, for example
`{"id":1,"args":["plan","rename","--project","tsconfig.json","--file","src.ts","--at","1:14","--name","next","--out","/tmp/plan.json"]}`.
Responses carry `id`, `status`, and `output` or `error`. Requests run sequentially;
EOF closes the server. Up to four single-project TypeScript LanguageServices stay
warm. Content hashes, compiler filesystem queries and directory membership are
rechecked before reuse. Workspace file operations still load fresh workspaces.

Validation checks the planned affected set first. When it has no errors, the
original error baseline is unnecessary and `diagnosticsBefore` is empty; notes
record that shortcut. Otherwise the original multiset is checked before accepting
existing errors. Project-reference declaration builds retain full before/after
checks. Workspace editing uses one LanguageService and DocumentRegistry; validation
shares parsed sources and releases project checkers sequentially to limit memory.

For repeated plans in projects with existing errors, `REFACTOR_AI_CACHE=on` enables
an optional persistent **original-baseline-only** diagnostics cache at
`<root>/.refactor-ai/cache`. `REFACTOR_AI_CACHE_DIR=/tmp/rai-cache` selects an
external location. The default is off: clean plans need no baseline, and hashing
every compiler input has a cost. Planned diagnostics are always checked. Cache
keys include compiler version/options, all source/dependency contents and the
selected files; a hit also rechecks filesystem reads, negative resolution probes,
directory listings and symlink targets. Malformed or unavailable caches fall back
to checking. Remove the cache directory to reclaim space.

`bun run bench:checkers -- --root <repo> --tsgo <binary> --rust <binary>` compares
optional native diagnostic executables without installing dependencies or changing
the target. `node scripts/probe-native-checkers.mjs <unpacked-package-directory>`
probes in-memory overlays. See the [native checker investigation](docs/research/2026-10-18-native-checkers.md)
for versions, API differences and correctness limits.

`plan ... --checker ts7` (API: `checker: "ts7"`) opts into Microsoft Go 7.0.2
diagnostics over the in-memory planned filesystem. Install its optional peer
explicitly alongside the CLI/API package: `npm install --save-dev typescript7@npm:typescript@7.0.2`.
For an installed skill, install the alias in `<skill-root>/assets/runtime`.
The author checkout includes it as a development dependency. Planning never
downloads TS7. Run the built CLI/API with Node.js 22+; TS7's sync
IPC API does not support Bun.

`--checker ts7` uses only TS7 for diagnostics; edits and dependency graphs remain
on 5.9.3. `--checker both` (API: `checker: "both"`) audits every selected pass
against 5.9.3 by file and error code, including duplicate counts. Disagreement in
audit mode rejects the plan with `CHECKER_MISMATCH`. Both modes verify user-file
membership, failing with `CHECKER_SOURCE_MISMATCH` on disagreement; missing/wrong
versions fail explicitly. Options,
configuration, global, syntax, semantic and declaration diagnostics are included.
Project-reference declaration builds are unsupported in TS7 mode and fail
explicitly; use the default checker for them. Audit mode keeps TS5 diagnostic
wording; TS7 mode stores native diagnostics. `plan.checker` records the selected
checker, exact version and audit reference. The differential test corpus covers
re-exports, moves, package exports, aliases, JSX, merging, satisfies, generics and
ambient changes; it cannot guarantee agreement for arbitrary code. Native-only mode checks every user source in each participant with batched API
calls; a TS5 dependency closure does not establish TS7 dependency semantics.
The default remains TS5.9.3. Run the project's own typecheck after applying any plan.

GitHub Actions are configured in [CI](.github/workflows/ci.yml) and [npm publication](.github/workflows/publish.yml). CI builds and tests the Node CLI, Roslyn helper, installed skills and packed npm tools, runs the demo, and uploads npm archives plus self-contained skills. A matching `vX.Y.Z` tag publishes the verified `@refactor-ai` archives using npm OIDC. [GitHub Actions setup and releases](docs/github-actions.md) describes the first publication, Trusted Publisher settings and retries.

```sh
bun run typecheck
bun test
bun run build:csharp
bun run build
node dist/demo.js
bun run test:skills  # separate installation test; requires network access, npm/npx and the .NET SDK
```

See the [recorded demonstration with diffs](docs/mvp-demo.txt), [architecture and development sequence](docs/refactoring-toolkit-plan.md), and research on [ReSharper/Roslyn](docs/research/resharper-roslyn-catalog.md), [TypeScript](docs/research/typescript-engine.md) and [C#](docs/research/csharp-engine.md). Research documents describe findings from before implementation; the table above and `capabilities` show the current feature set.

`plan inline-reexports --project ./tsconfig.json --file ./src/shim.ts` rewrites
workspace imports and re-exports to the shim's symbol origins, splitting declarations
by origin. Relative chains resolve through the checker; bare/package specifiers
retain the public entry used by the shim. Quotes, aliases, type modifiers and
relative extension conventions are preserved. Pure, unreferenced re-export shims
are deleted (schemaVersion 2), with literal config file lists updated; `--keep`
retains them. Mixed modules retain all original re-exports. Side-effect imports
stay unchanged with a note; dynamic/import-type references also prevent deletion.
Namespace imports require a pure single-origin `export *` shim whose origin has
no default export. Import/export attributes are unsupported. Compiler validation
does not verify module initialization effects, directives such as `"use client"`,
or consumers outside the loaded workspace; verify application behavior.
