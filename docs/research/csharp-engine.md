# C#/.NET backend for a deterministic refactoring tool

Investigation date: 2026-10-04. At the time, the repository contained only `README.md` and `assets/icon.svg`. This note is an analysis, not an implementation.

## Executive conclusion

The smallest sensible C# backend should be a small .NET helper launched by Bun/TypeScript over stdin/stdout (preferably JSON-lines), with the public Roslyn API as its semantic engine. LSP can be added as an optional adapter to an existing server, but it should not be the only contract for mutations: standard LSP does not guarantee a specific refactoring catalog or stable `workspace/executeCommand` semantics.

Roslyn publicly provides enough building blocks for an MVP: loading `.sln`/`.csproj` via `MSBuildWorkspace`, the semantic model and syntax trees, `Renamer.RenameSymbolAsync`, `DocumentEditor`/`SyntaxEditor`, and `SyntaxGenerator`. Generating interface implementations is publicly confirmed; I did not find a public, stable "Extract Method" API. Therefore Extract Method should be a separate, later capability gate, not an MVP promise.

## Evidence status

- **Verified locally:** `bun 1.4.2`, `.NET SDK 8.0.131` on macOS arm64; `omnisharp`, `csharp-ls`, and `roslyn` were not found on PATH. A temporary `net8.0` project with Roslyn 4.12.0 packages compiled reflection over the public methods described below.
- **Documented by the API owner:** signatures and behavior of public Roslyn types, `dotnet format` limitations, public NuGet packages, the OmniSharp description, and Microsoft's LSP documentation.
- **Conclusion/proposal:** the helper architecture, capability gates, and the chosen feature ordering. This is not a claim about an existing product feature.

## Public Roslyn API

### Project loading and semantics

`MSBuildWorkspace` is a public type from the `Microsoft.CodeAnalysis.Workspaces.MSBuild` package. The package documentation names Microsoft/RoslynTeam as owner and the MIT license ([NuGet: Workspaces.MSBuild](https://www.nuget.org/packages/Microsoft.CodeAnalysis.Workspaces.MSBuild/)). The API exposes `Create(...)`, `OpenSolutionAsync(...)`, and `OpenProjectAsync(...)`; local reflection on Roslyn 4.12.0 confirmed all of these methods and overloads.

This gives the backend the `Solution`/`Project`/`Document` model, syntax trees, compilation, and `SemanticModel`, without writing a custom parser or symbol resolver. However, `MSBuildWorkspace` runs a project-loading/design-time build process and may require restore, SDKs, workloads, the correct targets, and all imports. Loading should be treated as a project-dependent capability, `WorkspaceFailed`/diagnostics should be reported, and it should not be assumed that every `.csproj` can be opened in an isolated environment.

Roslyn describes `Workspace.CurrentSolution` as an immutable model of projects and documents, with access to text, syntax trees, and semantics ([Workspace API](https://learn.microsoft.com/dotnet/api/microsoft.codeanalysis.workspace)). In practice, the helper can compute a new `Solution`, output a deterministic set of text changes, and only write files after validation.

### Rename

`Microsoft.CodeAnalysis.Rename.Renamer.RenameSymbolAsync` is a public API in `Microsoft.CodeAnalysis.Workspaces.dll`, package `Microsoft.CodeAnalysis.Workspaces.Common`; the current documentation shows an overload with `SymbolRenameOptions` returning `Task<Solution>` ([Renamer.RenameSymbolAsync](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.rename.renamer.renamesymbolasync?view=roslyn-dotnet-5.0.0)). Source.dot.net shows the implementation as well as the conflict and document-change options ([Renamer.cs](https://source.dot.net/Microsoft.CodeAnalysis.Workspaces/Rename/Renamer.cs.html)).

A local test on Roslyn 4.12.0 packages confirmed two public signatures, including:

```text
Task<Solution> RenameSymbolAsync(Solution, ISymbol, SymbolRenameOptions, string, CancellationToken)
```

This is the right basis for deterministic symbol rename, not textual replacement. The `DocumentId` → path mapping should be preserved and changes emitted after comparing old/new `SourceText`; the result may span multiple documents and require compilation validation.

### Syntax editing and interface implementations

`DocumentEditor` and `SyntaxEditor` are public tree-change editors; the documentation describes node tracking via annotations and the order in which changes are applied ([DocumentEditor](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.editing.documenteditor), [Editing namespace](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.editing?view=roslyn-dotnet-5.0.0)). `SyntaxGenerator` is a language-agnostic node generator.

The `SyntaxGenerator` documentation lists the public `AsPublicInterfaceImplementation(...)` and `AsPrivateInterfaceImplementation(...)`, as well as `InterfaceDeclaration(...)`, `AddInterfaceType(...)`, and `GetGenerator(...)` ([SyntaxGenerator](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.editing.syntaxgenerator?view=roslyn-dotnet-5.0.0)). Local reflection on 4.12.0 confirmed both `AsPublicInterfaceImplementation` overloads and the `GetGenerator` overloads for `Workspace`, `Document`, and `Project`.

Conclusion: "implement interface" can be part of the MVP as generation of missing declarations after analyzing the `INamedTypeSymbol`/interface members. `SyntaxGenerator` alone, however, is not a complete refactoring tool: member selection, name collisions, accessibility, nullable/generic constraints, duplicate removal, and formatting all need to be designed.

### Extract Method and IDE refactorings

Searching the public Learn/source.dot.net APIs and Roslyn metadata did not turn up a public, general-purpose `ExtractMethodAsync` analogous to `Renamer`. The public `CodeAction` is an abstraction for an action produced by a `CodeFixProvider`/`CodeRefactoringProvider` ([CodeAction](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.codeactions.codeaction?view=roslyn-dotnet-5.3.0)); this does not mean that the existing internal IDE refactoring implementations are a public contract that can be called from the helper.

The MVP should not rely on reflection/internal assemblies, nor assume that Visual Studio providers are publicly callable. Capability `extract-method` = `unsupported` until there is a separate, tested implementation based on public trees/semantics, or an explicitly chosen adapter to a server that documents such an action.

## LSP versus a small Roslyn helper

### OmniSharp

The official OmniSharp site describes the tool as a server with IntelliSense, Add Reference, Format Document, and other features ([omnisharp.net](https://www.omnisharp.net/)). This investigation does not use project documentation hosted on GitHub, so the details of OmniSharp's transport and requests remain a capability probe rather than a contract assumption.

NuGet publishes OmniSharp/Roslyn packages under MIT, including `OmniSharp.Roslyn.CSharp`, `OmniSharp.Host`, and `OmniSharp.MSBuild` ([OmniSharp profile](https://www.nuget.org/profiles/OmniSharp), [OmniSharp.Roslyn.CSharp](https://www.nuget.org/packages/OmniSharp.Roslyn.CSharp/)). This makes OmniSharp potentially useful as an external LSP/legacy-API process, but versions and feature scope need to be pinned, and the handshake and specific requests verified. It is not installed locally.

### csharp-ls

In this investigation I did not find permitted, non-GitHub owner documentation describing a stable public `csharp-ls` contract for refactorings. It is also not on the local PATH. The conclusion is not "csharp-ls does not work"; it is: **insufficient evidence within the accepted source scope**, so it cannot be the default MVP backend. An adapter can be added after a separate probe: version, initialize capabilities, `textDocument/rename`, `textDocument/codeAction`, how workspace edits are written, and the distribution license.

### Roslyn language server / the server used by the C# extension

Microsoft describes C# Dev Kit as working together with the C# extension, whose LSP host is open source and is meant to integrate C# experiences in VS Code ([C# Dev Kit](https://learn.microsoft.com/visualstudio/subscriptions/vs-c-sharp-dev-kit)). This proves that a usable LSP channel exists, not that there is a public API for all internal Roslyn refactorings.

The Visual Studio documentation states explicitly that an LSP extension is intended for adding languages/services from outside Visual Studio and "is not intended to extend existing language services (such as C#)" ([Adding an LSP extension](https://learn.microsoft.com/visualstudio/extensibility/adding-an-lsp-extension?view=visualstudio)). For our process this means: it is fine to consume the server via standard LSP, but we must not assume access to the internal Visual Studio/Roslyn provider or its private command IDs.

### Recommendation

By default: a Roslyn helper as the source of truth for mutating operations. Optionally: an LSP adapter to reuse an existing process for `hover`, `definition`, `references`, `rename`, or code actions, when the server declares the capability and passes a probe. Every operation must carry a capability + backend version + validation result; a missing capability ends in an explicit `unsupported`, not a heuristic textual rewrite.

## `dotnet format` and analyzers

`dotnet format` accepts a project/solution and can restore, compile, and run analyzers ([dotnet format](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-format)). The documentation distinguishes:

- `dotnet format style` — code-style formatting;
- `dotnet format analyzers` — fixes for analyzer diagnostics, excluding code-style rules;
- the main `dotnet format` — formatting/cleanup across these categories.

This is a useful final formatter/verifier, but not a full ReSharper/Roslyn refactoring catalog. `dotnet format analyzers` requires a diagnostic rule and an available code fix; it is not an arbitrary API for invoking "Extract Method" or "Implement Interface". Given the "no custom analyzer" requirement, coverage of these operations by `dotnet format` cannot be promised.

The built-in .NET analyzers are part of the SDK for .NET 5+ targets and may have code fixes in the IDE environment ([.NET code analysis](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/overview?tabs=net-8)). This could support a separate "apply known diagnostic fix" path, but it should be treated as a limited adapter, not as a public interface to all IDE refactorings.

## Runtime, distribution, and licenses

- Local runtime: .NET SDK `8.0.131`, Bun `1.4.2`; the test was run on `net8.0` with Roslyn `4.12.0` packages.
- The Microsoft.CodeAnalysis.Workspaces.MSBuild and CSharp.Workspaces packages are published by Microsoft/RoslynTeam; NuGet metadata declares MIT ([Workspaces.MSBuild](https://www.nuget.org/packages/Microsoft.CodeAnalysis.Workspaces.MSBuild/), [CSharp.Workspaces](https://www.nuget.org/packages/Microsoft.CodeAnalysis.CSharp.Workspaces)).
- OmniSharp's NuGet package declares MIT, but distributing a prebuilt server and SDK version compatibility must be pinned/tested ([OmniSharp.Roslyn](https://www.nuget.org/packages/OmniSharp.Roslyn/)).
- MSBuildWorkspace can load project code and perform design-time operations; the helper should not run untrusted projects without an explicit security policy. The `dotnet format` documentation itself warns that the tool may restore/compile/run analyzers and should only be used on trusted code.
- No basis was found for distributing Visual Studio binaries or private providers. What should be distributed is our own helper and permitted NuGet packages, preserving their notices/licenses.

## Proposed MVP with capability gates

1. **`workspace.load` — gate `msbuild-workspace`:** accept `.sln`/`.csproj`, build an `MSBuildWorkspace`, return projects, documents, target framework, and load diagnostics. Do not write changes if the project did not load unambiguously.
2. **`symbol.rename` — gate `roslyn-renamer`:** resolve the symbol from a document/position via `SemanticModel`, call `Renamer.RenameSymbolAsync`, return a workspace edit as paths + ranges/new text; optional renaming in comments/strings only when explicitly set in options.
3. **`interface.implement` — gate `syntax-generator-interface`:** detect missing members semantically, generate declarations via `SyntaxGenerator`, apply via `DocumentEditor`, simplify/format, and run a check compilation. Initially reject explicit-interface edge cases, partial/generator/source-generated documents, and collisions instead of guessing.
4. **`format.verify` — gate `dotnet-format` (optional):** run only as a separate step after a change; `--verify-no-changes`/diagnostics are for checking, not for replacing refactorings.
5. **`lsp.probe` — gate per server/version:** `initialize` → record capabilities → test on a fixture → only then activate a specific operation. Distinguish `rename` from `codeAction`; write an LSP workspace edit result only after validating the document version.
6. **`extract.method`:** explicitly `unsupported` in the MVP; later a separate project/specification and semantic tests. Do not use internal Roslyn/Visual Studio APIs or a manual LLM rewrite.

## Minimal Bun ↔ helper contract

TypeScript should be the orchestrator: it detects the backend, sends a JSON-lines request, receives `capabilities`, `diagnostics`, `workspaceEdits`, and `unsupported(reason)`, and then atomically applies the accepted changes. The helper should remain stateless with respect to the disk between requests, or return an explicit `workspaceVersion`/hash; this prevents writing changes to stale files. AST/LSP for TypeScript/JavaScript and Roslyn for C# remain separate backends, with the same neutral change-plan format.

## What not to claim yet

- Do not claim that OmniSharp/csharp-ls/the Roslyn server offer an identical refactoring catalog.
- Do not claim that `dotnet format` will run an arbitrary IDE refactoring without an analyzer/code fix.
- Do not claim that `Extract Method` is a public Roslyn API.
- Do not publish assumptions about VS internal providers as a public contract.
- Do not treat the mere existence of a NuGet package as proof that a specific version works with every SDK/project; a capability probe and fixture are mandatory.
