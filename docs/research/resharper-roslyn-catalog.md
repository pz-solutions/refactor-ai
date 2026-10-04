# Catalog of deterministic ReSharper/Roslyn refactorings

Research date: 2026-10-04  
Scope: a TypeScript scripting tool run with Bun, supporting TS/JS and C#/.NET.  
Constraint: this note does not implement refactorings and does not assume manual code rewriting by an LLM.

## Executive summary

The first wave should pick operations from existing engines, with explicit limitations: rename with references, formatting, imports/usings, and extract as offered by the backend. The output is a change plan plus diagnostics, not a "confidence" score from the model. Determinism does not prove semantic equivalence: JS imports can change initialization, and inline and move require separate tests. Writing multiple files requires a journal and error handling; it is not a single atomic filesystem operation.

ReSharper describes refactorings as solution-wide transformations, including rename, move, safe delete, introduce/inline and many further changes.[^rs-refactor] For C#, Roslyn officially provides APIs for syntax and semantic analysis and for building analyzers, code fixes and code refactorings.[^roslyn-sdk] This is a good foundation for a C# backend, but it does not prove the existence of a public, headless API that reproduces the full set of Visual Studio/ReSharper commands.

TypeScript has an officially documented compiler API, `Program` and language service; TypeScript VFS shows the language service being used for the same kinds of calls an editor needs.[^ts-vfs] At the time of this research, however, this checkout had neither the `typescript` nor the `ts-morph` package installed; the TS backend should be treated as a dependency to be added deliberately, not as a capability already available.

## Important distinction: IDE versus headless

A listing in IDE documentation means a user can invoke the action in ReSharper or Visual Studio. It does not automatically mean that a stable public CLI/API exists to run it without the IDE. ReSharper separately documents code cleanup run from the command line,[^rs-cleanup] and .NET has `dotnet format` with the `whitespace`, `style` and `analyzers` subcommands, diagnostic filtering and `--verify-no-changes`.[^dotnet-format] For refactorings, a specific public interface of an existing engine must be confirmed — e.g. Roslyn Renamer or the TypeScript Language Service — or an LSP capability. IDE command documentation is not a headless contract; a custom semantic analyzer is neither required nor recommended.

## Conceptual model

* **Refactoring** changes program structure while preserving intended behavior; it usually requires symbols, references and semantic validation.
* **Code fix** repairs a specific diagnostic/anomaly. In Roslyn, a typical analyzer and its associated code fix are packaged together; a code fix can generate a change based on a diagnostic.[^roslyn-sdk]
* **Cleanup** is a repeatable, configurable pass over formatting, style, imports/usings and safe redundancies within a selected scope. ReSharper distinguishes cleanup profiles and does not include automatic renaming in batch cleanup, because it can cause conflicts.[^rs-cleanup]

## Operation inventory (18 items)

Ratings: **usefulness** 1–5 for the first product; **risk** 1–5, where 5 means risk of changing meaning; **TS**: `W` ports well to TS/JS, `C` partially/conditionally, `N` not a natural target. The TS ratings are a design recommendation, not a statement of library capability.

| # | Operation | Class | Usefulness | Risk | TS | Rationale and determinism condition |
|---:|---|---|---:|---:|:---:|---|
| 1 | Rename symbol + references | refactoring | 5 | 2 | W | Updates symbol usages across the solution/project; ReSharper also describes file/type and hierarchy rename.[^rs-rename] Requires distinguishing identifiers from text, comments and strings. |
| 2 | Extract variable / introduce variable | refactoring | 5 | 2 | W | A clean replacement of an expression with a declaration, but evaluation order, mutability and scope must be considered. ReSharper lists Introduce Variable, and VS describes extract/inline as separate refactorings.[^rs-main][^vs-extract] |
| 3 | Inline variable | refactoring | 5 | 2 | W | Safe only for side-effect-free expressions or when the exact number of evaluations is preserved; do not treat as a plain text replace. |
| 4 | Organize imports / usings | cleanup/code fix | 5 | 1 | W | Removes unused and orders imports/usings based on the semantic model; Roslyn/.NET confirm automated style/analyzers, ReSharper has cleanup of redundancies.[^rs-cleanup][^dotnet-format] |
| 5 | Whitespace formatting | cleanup | 5 | 1 | W | Deterministic, local; in .NET available as `dotnet format whitespace`.[^dotnet-format] In TS requires a parser/printer instead of regexes. |
| 6 | Remove redundant code / simplify expression | code fix/cleanup | 5 | 2 | W | High value, but only for a closed catalog of rules with equivalence tests. ReSharper singles out redundancies and most can be fixed in batch.[^rs-inspections][^rs-cleanup] |
| 7 | Extract method/function | refactoring | 5 | 3 | W | ReSharper computes parameters and a possible return from the selected statements.[^rs-extract] For JS/TS, closure capture, `this`, hoisting and async come into play. |
| 8 | Move type to file / matching file | refactoring | 4 | 2 | C | ReSharper moves the type and imports and cleans up the old ones;[^rs-move-file] in TS/JS the equivalent depends on exports, modules and the bundler. |
| 9 | Move type/namespace/module | refactoring | 4 | 3 | C | Requires updating paths, namespace/module and references; in JS, dynamic imports, aliases and runtime conventions limit certainty. |
| 10 | Safe delete symbol/reference | refactoring | 4 | 3 | C | ReSharper checks usages, hierarchies and conflicts before deletion.[^rs-safe-delete] For JS/TS, reflection, string-based imports, DI and public API cannot be assumed nonexistent without configuration. |
| 11 | Inline method/function | refactoring | 3 | 4 | C | VS and ReSharper support inlining a method, optionally removing the declaration.[^vs-extract][^rs-inline] Risk: side effects, `this`, ordering, recursion, debug semantics. |
| 12 | Change signature | refactoring | 4 | 4 | C | Updates parameters and call sites; VS documents removing, reordering and adding parameters.[^vs-class-member] Risk is highest with overloads, reflection, public API, dynamic JS calls. |
| 13 | Introduce field/property / encapsulate field | refactoring | 3 | 3 | C | In C# covers the field/property and access; in TS usually requires decisions about `private`, JS emit and decorators. |
| 14 | Make member static / convert local function | code fix/refactoring | 3 | 3 | C | VS describes make static and local function→method conversion.[^vs-class-member] Requires capture/context analysis, so it is not a simple syntactic fix. |
| 15 | Extract interface / base class | refactoring | 3 | 4 | N | VS and ReSharper offer extract interface/base class.[^vs-extract][^rs-main] This changes the API and hierarchy; no direct equivalent in JS/TS other than a compile-time interface, which does not exist at runtime. |
| 16 | Pull members up / push members down | refactoring | 2 | 5 | C | Reorganizes the hierarchy and contracts. ReSharper lists Pull Members Up and Push Members Down,[^rs-main] but it requires a full model of inheritance, overrides, accessibility and tests. |
| 17 | Convert property↔method / auto-property↔backing field | refactoring | 3 | 4 | N | ReSharper lists these conversions in its main set.[^rs-main] In C#, getter/setter differences, binding and side effects make this a semantic change, not a cleanup. |
| 18 | File layout / order members / naming cleanup | cleanup | 3 | 1–3 | C | ReSharper cleanup has file layout, and code style covers naming, formatting and layout.[^rs-cleanup][^rs-style] Member ordering is low-risk; automatic renaming should not be part of batch cleanup. |

## First wave (recommended)

### Wave A: infrastructure and observability

1. A shared result format: `Operation`, list of files, UTF-16 ranges/offsets, old/new fragments, diagnostics, required validators and confidence level.
2. A snapshot of input files and atomic application of non-conflicting edits; a range conflict must abort the operation without a partial write.
3. Parser + printer for TS/JS and Roslyn `SyntaxTree`/`SemanticModel` for C#. This is deliberate reuse of AST/LSP, not text generation by a language model. The Roslyn SDK explicitly describes syntactic and semantic analysis as the shared basis for analyzers, code fixes and refactorings.[^roslyn-sdk]
4. After the change: parse, diagnostics/compile, and for symbolic operations also a check that the number and identity of references match the plan.

### Wave B: low risk, high frequency

* whitespace formatting;
* organize imports/usings;
* removal of unused imports/usings;
* a closed set of redundancies (e.g. obvious local simplifications);
* symbol rename with references and optional file rename;
* extract/inline variable, initially without side effects and without scope changes;
* move type to file only when the provider can resolve all imports and exports.

### Wave C: controlled refactorings

* extract method/function for simple blocks without tricky capture;
* make static for members that do not use the instance;
* safe delete only with a complete reference graph and explicit configuration of public API boundaries;
* cleanup run on a file/directory/project, with a report and a verify-only mode. ReSharper documents scopes from a selection up to the solution, and `dotnet format` has analogous filters and reporting.[^rs-cleanup][^dotnet-format]

## Defer

* **Change signature** — defer until there is a model of overloads, named arguments, optional/default parameters, reflection/dynamic calls, public API and updating all call sites. The fact that Visual Studio updates call sites is an IDE capability, not proof that a custom script can safely cover all cases.[^vs-class-member]
* **Safe delete** — defer the full version; in the first wave allow only private/local symbols with a complete graph. ReSharper shows conflicts and the hierarchy, which indicates the minimum scope of required analysis.[^rs-safe-delete]
* **Inline method/function** — defer beyond trivial pure functions. Official descriptions confirm the operation but give no safety guarantees for side effects or JS `this` semantics.[^rs-inline][^vs-extract]
* **Pull members up / push members down** — defer without a full model of inheritance and contracts; the API risk outweighs the first-wave value.[^rs-main]
* **Extract interface/base class and property/method conversions** — defer, especially for TS/JS, where some abstractions are compile-time only or have different runtime meaning.[^vs-extract][^rs-main]

## TS/JS vs C#/.NET: proposed backend split

| Layer | TS/JS | C#/.NET |
|---|---|---|
| Syntax | TypeScript compiler AST/printer; for JS, parser mode and comments must be preserved. Official TypeScript materials show `Program`, the AST and the language service.[^ts-vfs] | Roslyn `SyntaxTree`, `Compilation`, `SemanticModel`; the official SDK describes these APIs as the foundation of analyzers/fixes/refactorings.[^roslyn-sdk] |
| References | Language service + project configuration; be careful with dynamic import, `eval`, string paths, barrel exports and runtime reflection-like patterns. | SemanticModel + compilation/project graph; additionally MSBuild/solution and analyzers. |
| Edits | Range edits/printer; preserving comments and quote/style as a separate invariant. | `SyntaxEditor`/workspace-style edits in the implementation, followed by format/diagnostics; the public headless contract has to be defined ourselves. |
| Cleanup | Parser-aware organize imports, formatter, selected pure simplifications. | `dotnet format` can be an adapter for whitespace/style/analyzers, but it does not replace our own refactorings.[^dotnet-format] |
| Trust boundary | By default no automatic change with dynamic/incomplete references. | By default no change with unresolved symbols, conditional compilation, generated code and public API without configuration. |

## Documented vs tested vs conjecture

### Tested locally

* At the start, the repository contained only `README.md` and `assets/icon.svg`.
* Bun `1.4.2`, Node `v22.22.3` and .NET SDK `8.0.131` on `osx-arm64` were available.
* `require.resolve` did not find `typescript`, `ts-morph` or `@typescript-eslint/typescript-estree` locally.
* The SDK installation contains `Microsoft.CodeAnalysis.*` libraries and analyzers/code-style assemblies; they were not run as a ready-made refactoring engine.
* No transformation was tested on a production file; no project, fixture or test harness existed yet.

### Documented by primary sources

* ReSharper has separate catalogs of refactorings, inspections and cleanup, and documents operations such as rename, extract, inline, move, safe delete, pull/push up/down.[^rs-refactor][^rs-inspections][^rs-main]
* The Roslyn SDK supports building analyzers, code fixes and code refactorings on top of syntactic-semantic analysis.[^roslyn-sdk]
* TypeScript officially presents the compiler API and language service as tooling mechanisms.[^ts-vfs]
* Visual Studio documents extract/inline, change signature and member reorganization as Quick Actions/Refactorings.[^vs-extract][^vs-class-member]
* ReSharper cleanup and `dotnet format` have batch scope, profiles/filters, and a verification mode or command line.[^rs-cleanup][^dotnet-format]

### Conjecture / to verify in the next stage

* Exact semantic equivalence of each TS/JS and C# operation requires fixtures, compilation and negative tests; it does not follow from the mere presence of an API.
* It is possible to build a single Bun orchestrator that delegates to the TS language service and to a separate process/.NET Roslyn adapter; this is an architectural hypothesis, not a capability confirmed in this checkout.
* LSP could be the transport layer for code actions/workspace edits; Microsoft's `CodeAction.Edit` model describes a workspace edit performed by a code action.[^lsp-code-action] This does not automatically provide a complete symbol graph or a safe implementation of a specific refactoring. The chosen server and the scope of supported requests must be confirmed before use.
* ReSharper-like solution-wide rename/safe-delete for JS/TS requires an explicit model of implicit usages; a parser and a static language service do not guarantee detection of runtime strings, reflection-like code or all bundler aliases.

## Sources (official, primary only)

[^rs-refactor]: JetBrains, [Refactorings](https://www.jetbrains.com/help/resharper/Refactorings__Index.html).
[^rs-main]: JetBrains, [Main set of refactorings](https://www.jetbrains.com/help/resharper/Main_Set_of_Refactorings.html).
[^rs-rename]: JetBrains, [Rename refactoring](https://www.jetbrains.com/help/resharper/Refactorings__Rename.html).
[^rs-extract]: JetBrains, [Extract Method refactoring](https://www.jetbrains.com/help/resharper/Refactorings__Extract_Method.html).
[^rs-inline]: JetBrains, [Inline Method refactoring](https://www.jetbrains.com/help/resharper/Refactorings__Inline_Method.html).
[^rs-move-file]: JetBrains, [Move Type to Another File refactoring](https://www.jetbrains.com/help/resharper/Refactorings__Move__Type_to_Another_File.html).
[^rs-safe-delete]: JetBrains, [Safe Delete refactoring](https://www.jetbrains.com/help/resharper/Refactorings__Safe_Delete.html).
[^rs-inspections]: JetBrains, [Code inspections](https://www.jetbrains.com/help/resharper/Code_Analysis__Code_Inspections.html).
[^rs-cleanup]: JetBrains, [Code cleanup](https://www.jetbrains.com/help/resharper/Code_Cleanup__Index.html).
[^rs-style]: JetBrains, [Code style and cleanup](https://www.jetbrains.com/help/resharper/Code_Style_Assistance.html).
[^roslyn-sdk]: Microsoft Learn, [The .NET Compiler Platform SDK (Roslyn APIs)](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/index).
[^ts-vfs]: TypeScript, [TypeScript VFS — Easy access to the compiler API](https://www.typescriptlang.org/dev/typescript-vfs/).
[^dotnet-format]: Microsoft Learn, [`dotnet format` command](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-format).
[^vs-extract]: Microsoft Learn, [Extract and inline refactorings](https://learn.microsoft.com/en-us/visualstudio/ide/reference/refactoring-extract-inline?view=visualstudio).
[^vs-class-member]: Microsoft Learn, [Class and member refactorings](https://learn.microsoft.com/en-us/visualstudio/ide/reference/refactoring-class-member?view=visualstudio).
[^lsp-code-action]: Microsoft Learn, [CodeAction.Edit Property](https://learn.microsoft.com/en-us/dotnet/api/microsoft.visualstudio.languageserver.protocol.codeaction.edit?view=visualstudiosdk-2022).
