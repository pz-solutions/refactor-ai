<img src="assets/icon.svg" width="64" height="64" alt="RAI — refactor-ai">

# refactor-ai

Deterministic refactorings exposed through skills and a CLI written in TypeScript, built with Bun into JavaScript that runs on Node.js. TypeScript Language Service or Roslyn computes the changes; the model selects the operation and its parameters.

| Operation | TypeScript / JavaScript | C# / .NET |
| --- | --- | --- |
| Rename a symbol and its references | Yes | Yes, including across projects in a `.sln` |
| Remove unused imports / using directives | Yes, explicit mode | Yes, Roslyn `CS8019` diagnostics |
| Sort imports | Yes, without removing unused imports | Not yet |
| Format a file | TypeScript formatter | Roslyn Formatter |
| Extract function | Yes, engine-provided action | Not yet |
| Extract variable / constant | Yes, engine-provided action | Not yet |
| Move a type between directories / projects | Yes, TypeScript's “Move to file” action | Yes, Roslyn with planned `.csproj` edits |
| Match a filename to its declared type | Yes, including import updates | Yes, including explicit `Compile` entries |
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

The default root is the project configuration's directory. Supply `--root` for a wider scope; use a `.sln` for C# rename operations with callers in several projects. Plans default to `<root>/.refactor-ai/`; `--out` may point outside the project or into that directory. `node dist/cli.js` lists these commands. When relocating the CLI, set `REFACTOR_AI_HOME` to this package's directory so it can locate the C# helper.

Type refactoring examples (replace paths and type names with your own):

```sh
node dist/cli.js plan rename-file --project ./tsconfig.json --file ./Wrong.ts --type Widget
node dist/cli.js plan sync-namespace --project ./App.csproj --file ./Models/Widget.cs
node dist/cli.js plan move-type --project ./Workspace.sln --root . \
  --file ./Source/Widget.cs --type Widget --to ./Destination/Models/Widget.cs \
  --target-project ./Destination/Destination.csproj
```

`--to` specifies the destination file, including one in a directory that does not exist yet. For cross-project moves, `--target-project` identifies the destination `.csproj` or TS/JS configuration; `--root` must cover all changes. Plans that create or delete files use schemaVersion 2; legacy version 1 edit plans remain supported. `preview` also shows created and deleted files, and apply records a journal and rolls back its own changes on failure.

C# moves update namespaces that follow the project's folder convention. Custom namespaces are preserved unless you supply `--root-namespace`. Namespace synchronization affects the selected file and its references, leaving other files in their existing namespace. Moving a C# type between projects changes its assembly; dependencies on reflection and assembly-qualified names need separate verification.

## npm CLI packages

Build nine independently publishable packages: the complete `@refactor-ai/refactor-ai` CLI and one `@refactor-ai/refactor-ai-<operation>` package for each of the eight refactorings. Each declares a single executable in npm's `bin` field. The author checkout remains private.

```sh
bun run package:npm
bun run package:npm --help
```

Generated packages are in `dist/npm/`. They include the built Node runner, a pinned TypeScript dependency and, where supported, Roslyn helper sources with a NuGet lockfile. Consumers need Node.js 22+ and npm; C# also requires .NET SDK. Bun is unnecessary at runtime. There are no install lifecycle scripts; the helper builds on first C# use.

After publishing under names you own:

```sh
npx @refactor-ai/refactor-ai --help
npx @refactor-ai/refactor-ai-rename --help
npx @refactor-ai/refactor-ai-rename plan --project ./tsconfig.json --file ./src.ts --at 1:14 --name newName
npx @refactor-ai/refactor-ai-rename preview --plan ./path/to/plan.json
npx @refactor-ai/refactor-ai-rename validate --plan ./path/to/plan.json
npx @refactor-ai/refactor-ai-rename apply --plan ./path/to/plan.json
```

The default scope is `@refactor-ai`. Override it with `bun run package:npm --scope another-org` when needed. Local tarballs work before publishing:

```sh
npm pack ./dist/npm/refactor-ai-rename --pack-destination /tmp
npx --yes file:/tmp/refactor-ai-refactor-ai-rename-0.1.0.tgz --help
```

See [npm packaging and publishing](docs/npm-packages.md) for package names, local installation, publication and versioning. `bun run test:npm` tests actual packed archives through npx, including complete TS, JS and C# workflows.

All nine npm packages share the version in the author `package.json`. After building, use `bun run version:packages patch --dry-run` to preview a bump, or `bun run version:packages --help` for minor/major and beta/RC examples. Release tags must match `v<version>`; stable releases use `latest` and prereleases use `next`. The publisher checks registry versions and refuses to move those channels backwards. See the [release procedure](docs/github-actions.md#release-a-version).

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

For authors: `bun run package:skills` rebuilds the CLI and refreshes the resources for all eight skills. Include the generated `scripts/` and `assets/` directories in each distributed skill, excluding local caches such as `node_modules`, `bin`, `obj` and `.setup.lock`. `SKILL.md` alone cannot execute a refactoring. `bun run build` also refreshes these resources.

## MVP guarantees and limitations

- Planning transforms code in memory and compares compiler errors before and after the change. `validate` checks snapshot freshness and the stored analysis result; it does not automatically run an arbitrary project's tests. The demo and regression tests separately verify example behavior.
- Apply executes the exact stored plan and rejects changed snapshots and new errors. The snapshot covers regular files under the root, excluding `.git`, `node_modules`, `bin`, `obj`, `dist` and `.refactor-ai`. Dependencies are represented by manifests and lockfiles; changes to libraries outside the root are not fully fingerprinted.
- Rename uses symbols and references. Comments and strings remain unchanged; API consumers outside the loaded project, reflection and dynamic JS references are not automatically updated.
- TS `rename-file` and `move-type` validate the source and destination configurations and the loaded project-reference graph, with declarations built in memory. Other TS operations still reject project references. C# analyzes the loaded MSBuild configuration rather than every possible compilation condition; select a `.sln` to include dependent projects.
- Additional TS/JS configurations beside a participating project, such as `tsconfig.build.json`, are updated and validated when they cover the affected file. Discovered callers importing that file also join the analysis. Other configurations covering it cause rejection rather than leaving unchecked changes.
- TS/JS moves support declarations in ES modules; CommonJS source code, merged declarations and types inside namespaces are rejected. Compiling ES modules to CommonJS is supported. Projects in the shared analysis must have compatible module-resolution options.
- C# type moves and namespace changes reject, among other cases, partial declarations spread across files, conditional compilation, and multiple or nested namespaces. `.csproj` edits support standard SDK globbing or explicit, unconditional `Compile` entries; unknown MSBuild rules, dependency cycles and new compiler errors cause plan rejection.
- C# type moves retain source-project global using directives, including when the moved type was the file's only declaration. Required new project references are inserted unconditionally. Helper discovery uses the selected toolkit directory; it never executes a helper found in the analyzed project's working directory.
- TS/JS type moves reject effectful static initializers, static blocks, decorators, computed members, evaluated base-class expressions, nonconstant enum initializers and new module cycles for runtime classes. Simple identifier base classes and primitive constant initializers are supported. Compiler checks do not prove whole-program behavior equivalence; run application tests after a move.
- Plans record source permission modes. Edits and pure file renames preserve them independently of umask; split source files inherit the selected source's permissions. Other newly created files default to private access. Permission changes after planning make a plan stale. Journals include before/after modes for recovery; older plans without mode metadata remain readable. POSIX modes do not represent Windows ACLs or other extended metadata.
- Import sorting can change JS module initialization order. Removing an unused value import can remove module initialization. Choose these operations deliberately and check application tests; preserving bare side-effect imports does not prove whole-program equivalence.
- Plans preserve the original input text as a precondition. Unsupported encodings or inconsistent content produce errors rather than overwrites. Symlinks within the snapshot are rejected.
- Individual file writes are atomic; multi-file writes use the runner's lock and a recovery journal. On failure, the runner attempts to roll back its own writes. Content is checked again after preparing a write, immediately before replacement. This is not an atomic transaction or a filesystem-wide compare-and-swap: other editors do not respect the lock, so avoid editing the same files during apply.
- After an interrupted apply, inspect `.refactor-ai/apply.lock` and the `.journal.json` journal. The journal contains original text and hashes of the new versions; the MVP does not yet provide an automatic recovery command. Preserve files subsequently changed by another process when recovering.

## Verification and research

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
