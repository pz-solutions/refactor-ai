# Deterministic TS/JS refactoring engine — analysis

Probe date: 2026-10-04. At the time, the repository contained only `README.md`; this file is purely a research note. No dependencies or production code were added to the repository.

## Conclusion

A minimal deterministic stack for TS/JS should build directly on the public `typescript.LanguageService`, with a project host that respects `tsconfig`/module resolution and a layer that applies `FileTextChanges` as small, verifiable text edits. This is the closest public equivalent to part of the ReSharper/Roslyn feature set: a semantic program, references, rename, refactorings, imports, and file rename.

`ts-morph` is a useful optional wrapper, but it does not add its own semantic analyzer; it delegates to TypeScript and maintains its own write model. `typescript-language-server` is an LSP/tsserver adapter useful for editors, but it is not required for a batch Bun engine. `ast-grep` is worth keeping as a later structural fallback for multi-language syntactic rules, not as a source of semantic rename/imports. `jscodeshift`/`recast` are good codemod and formatting-preservation tools, but they use a different AST model than the TypeScript Language Service; in a minimal semantic engine they increase the number of sources of truth.

For C#/.NET, the analogous engine should be the public Roslyn APIs: `Workspace`/`Solution`/`Project`/`Document`, `CodeRefactoringProvider`, code fixes, and the rename/references services. A shared, homegrown semantic analyzer for TS and C# should not be built; only the layer for the change-plan protocol, validation, dry-run/diff, and committing should be shared.

## Source scope and claim status

- **Tested** means the result of a local probe on the pinned packages and commands listed below.
- **Documented** means a public declaration/API or documentation from the package owner.
- **Hypothesis/limitation** is explicitly marked; do not treat it as a compatibility guarantee.

Primary sources:

- TypeScript 5.9.3 declarations: [`typescript.d.ts` on the npm CDN](https://unpkg.com/typescript@5.9.3/lib/typescript.d.ts), package metadata on [npm](https://www.npmjs.com/package/typescript/v/5.9.3);
- the TypeScript Language Service is used by VS Code's built-in language features; description of the architecture and mapping to LSP: [VS Code Programmatic Language Features](https://code.visualstudio.com/api/language-extensions/programmatic-language-features) and [Language Extensions Overview](https://code.visualstudio.com/api/language-extensions/overview);
- LSP: [official portal/specification](https://microsoft.github.io/language-server-protocol/) and [workspace/executeCommand](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#workspace_executeCommand);
- wrappers/declarations: [ts-morph npm](https://www.npmjs.com/package/ts-morph), [typescript-language-server npm](https://www.npmjs.com/package/typescript-language-server), [jscodeshift npm](https://www.npmjs.com/package/jscodeshift), [recast npm](https://www.npmjs.com/package/recast);
- ast-grep: [introduction](https://ast-grep.github.io/guide/introduction), [rewrite](https://ast-grep.github.io/guide/rewrite-code), [CLI reference](https://ast-grep.github.io/reference/cli);
- Roslyn: [SDK](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/index), [`CodeRefactoringProvider`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.coderefactorings), [`CodeFixProvider`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.codefixes.codefixprovider), [`Project`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.project), [`Workspace`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.workspace), [`Solution`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.solution).

## Pinned versions and reproduction

Environment:

```text
Bun 1.4.2
Node v22.22.3 (auxiliary only)
.NET SDK 8.0.131
typescript 5.9.3
ts-morph 28.0.0
typescript-language-server 6.0.1
jscodeshift 17.4.0
recast 0.24.0
```

Commands run outside the repository, in a temporary directory:

```sh
tmpdir=$(mktemp -d /tmp/refactor-ai-probe.XXXXXX)
cd "$tmpdir"
bun init -y
bun add --exact typescript@5.9.3 ts-morph@28.0.0 \
  typescript-language-server@6.0.1 jscodeshift@17.4.0 recast@0.24.0
bun run probe.ts
```

The probe built a `LanguageServiceHost` for `src/a.ts`, `src/b.ts`, `src/c.ts`, `src/depA.ts`, `src/unused.ts`, and `src/a.js`, with `allowJs: true`, `checkJs: true`, `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2022`. API declarations were read from `node_modules/typescript/lib/typescript.d.ts` and from the ts-morph declarations. Neither the probe nor the packages were saved to the repository.

Additional test: `typescript@7.0.2` (the `latest` tag at probe time) had a different package/entrypoint structure; the same script failed with a `TypeError` on `ts.sys.fileExists`. This does not prove that TS 7 lacks an equivalent API, but it does show that the minimal stack must pin and test a TypeScript version instead of blindly using `latest`.

## Direct Language Service results

### Refactorings

**Tested.** For a position on `renameMe`, the call:

```ts
const list = ls.getApplicableRefactors(
  fileName,
  { pos, length: 8 },
  {},
  "invoked",
);
```

returned the following names and action IDs:

```text
Convert export
  refactor.rewrite.export.default
Convert parameters to destructured object
  refactor.rewrite.parameters.toDestructured
Infer function return type
  refactor.rewrite.function.returnType
```

Then `getEditsForRefactor(file, {}, range, refactorName, actionName, "invoked")` returned a `RefactorEditInfo` with `edits: FileTextChanges[]`; for `refactor.rewrite.export.default` the change was a minimal insertion of ` default`. The API and signatures are publicly declared in `typescript.d.ts`; the list of refactorings depends on the position, range, preferences, and TS version.

### Symbol rename, prefix/suffix, and JS

**Tested.**

- `getRenameInfo(file, pos)` returned `canRename: true`, `kind: "function"`, `displayName: "renameMe"`, and a `triggerSpan` of length 8.
- `findRenameLocations(file, pos, false, false, true)` returned the definition and the call in `a.ts`, with `textSpan`; the definition also had a `contextSpan`.
- The declaration has the variant `findRenameLocations(..., providePrefixAndSuffixTextForRename?: boolean)` as well as `RenameLocation.prefixText?: string` and `suffixText?: string`. In this particular simple case the prefix/suffix values were not needed, so the result did not include them. Passing `true` itself is tested; do not claim that every shorthand/property/JS form will always return these fields.
- In `a.js` with JSDoc (`allowJs` + `checkJs`), `getRenameInfo` for `count` returned `canRename: true`, `kind: "const"`. This confirms basic JS rename, not full correctness for dynamic properties, reflection, strings, or `module.exports`.

**Limitation.** `findRenameLocations` has `findInStrings` and `findInComments` options, but enabling them provides no semantic guarantee for dynamic JS. The engine should explicitly display the scope and the reason for refusal/uncertainty rather than perform a textual global replace.

### File rename and imports

**Tested.** `getEditsForFileRename(oldFilePath, newFilePath, {}, {})` for `a.ts -> c.ts` returned `FileTextChanges` in `c.ts` changing the import `./a` to `./c.js`. This follows from `NodeNext` and its requirement for the emitted extension; do not hard-code a plain basename replacement. The API can return changes across many files if the host has a complete project graph.

**Limitation.** The probe was small and had its own file host; it does not prove completeness for multiple `tsconfig.json` files, project references, path aliases, symlinks, package exports/conditional exports, or monorepos. A production host must load the correct project/configuration and must not pretend that a single `LanguageService` represents all projects.

### Organizing, sorting, and removing imports

**Tested.** `organizeImports({type: "file", fileName}, {}, {})` returned several changes:

- it kept a separate `import './b';`, i.e. it preserved the side-effect import;
- it removed the unused named import `side` from the `./b` import;
- it removed the entire unused import from `./unused`;
- it returned ranges and `newText`, not a finished file.

**Documented.** `typescript-language-server@6.0.1` exposes distinct code-action kinds: `source.removeUnusedImports.ts`, `source.sortImports.ts`, `source.organizeImports.ts`; its documentation also describes the `_typescript.organizeImports` command with the modes `All`, `SortAndCombine` (without destructive removal), and `RemoveUnused`. This matters: "organize" should not be equated with sorting alone or with unconditional removal.

**Implementation conclusion.** The Bun layer should keep `FileTextChanges` as a plan, allow choosing the mode, and check before writing that the change does not remove a side-effect import. Do not implement a custom import sorter before making use of the official APIs.

## Comparison of TS/JS candidates

| Tool | What it actually provides | Project semantics | Role in the minimal stack |
|---|---|---:|---|
| `typescript.LanguageService` | rename, rename locations, file rename edits, code fixes, organize imports, refactor discovery and edits | Yes, via the TS program/host | **Core** |
| `ts-morph` | wrapper, navigation and wrapper mutations; the declarations show delegation to, among others, `languageService.findRenameLocations`, `organizeImports`, `getEditsForRefactor` | Yes, if the underlying TS is configured correctly | Optional ergonomics; not the source-of-truth layer |
| `typescript-language-server` | LSP over tsserver/TypeScript; code actions and workspace commands | Yes, inherited from TS | Editor adapter, not required in a batch CLI |
| `ast-grep` | tree-sitter structural search/rewrite, YAML `fix`/`rewriters`, many languages | Not a TS type checker | Later syntax-only/polyglot codemod |
| `jscodeshift` + `recast` | ESTree collections and transformations; recast preserves the formatting of modified fragments | Not a Language Service/TS symbol graph | Separate codemod pipeline, not the semantic core |

The sources describe ast-grep as structural search/rewrite with pattern/fix, jscodeshift as a runner/wrapper over recast, and recast as a parser/printer that preserves original fragments. An architectural recommendation follows from these descriptions, but a semantic rename guarantee does not — which is why this is a conclusion, not a probe result.

## C#/.NET: the Roslyn equivalent

**Documented.** Microsoft describes Roslyn as providing access to the compiler's syntactic and semantic model, used by, among others, IntelliSense, refactorings, intelligent rename, and find-all-references. The SDK provides analyzers, code fixes, and code refactorings; `CodeRefactoringProvider` is the public extension point for refactorings, and `CodeFixProvider` is the extension point for code fixes.

`Project` has documents, project references, compilation options, and a `Solution`; `Solution` has the project dependency graph and maps documents by path. `Workspace.TryApplyChanges(Solution)` is the mechanism for applying changes to a workspace and may reject unsupported kinds of changes. This fits a deterministic change plan with validation before commit well.

**Cross-language recommendation.** Implement separate backends:

1. TS/JS: TypeScript Language Service;
2. C#/VB: Roslyn Workspace/Solution and the public refactoring/code-fix APIs;
3. shared: change-plan format, rule identifiers, preconditions, diff, dry-run, atomic application, and validation via compilation/diagnostics.

Do not move ASTs between languages and do not write a shared symbol analyzer. The shared contract should carry the result (`file`, range, expected hash/precondition, replacement), not the method of analysis.

## Unresolved probes / next safe steps

- build a fixture with two `tsconfig.json` files, project references, path aliases, and package `exports`, then check whether the host selects the correct program;
- separately test prefix/suffix on shorthand properties, JSX/TSX, import aliases, and re-exports;
- test JS with dynamic properties and `module.exports`, documenting the exact refusal cases;
- compare `organizeImports` in the `All`, `SortAndCombine`, and `RemoveUnused` modes via the LSP adapter;
- for C#, pin specific Roslyn packages and run an analogous AdhocWorkspace/MSBuildWorkspace probe, without adding them to this repo.

These items are a plan for further verification, not implementation assumptions.
