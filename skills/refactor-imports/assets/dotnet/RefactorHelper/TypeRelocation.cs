using System.Globalization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

/// <summary>
/// Moves top-level types to another namespace, file and/or project and keeps every reference bound
/// to the same symbol. Each simple name in affected documents is annotated before editing; after the
/// edit the annotated names are re-bound and compared with the original symbols (mapped to their new
/// identity). Imports are added only where binding requires them, and any remaining binding change
/// rejects the operation instead of silently changing semantics.
/// </summary>
internal sealed class TypeRelocation
{
    public const string MovedKind = "RefactorAi.MovedType";
    public const string NamespaceKind = "RefactorAi.Namespace";
    private const string NameKind = "RefactorAi.Name";
    private const string OldUsingKind = "RefactorAi.OldUsing";

    private readonly Solution solution;
    private readonly DocumentId declarationId;
    private readonly IReadOnlyList<INamedTypeSymbol> types;
    private readonly string oldNamespace;
    private readonly string newNamespace;
    private readonly ProjectId sourceProjectId;
    private readonly ProjectId targetProjectId;
    private readonly string targetAssembly;
    private readonly OperationOutcome outcome;
    private readonly Func<CompilationUnitSyntax, DeclarationRewrite> rewrite;
    private readonly HashSet<string> movedKeys = new(StringComparer.Ordinal);
    private readonly List<(string Old, string New)> renames = [];
    private readonly HashSet<string> watchedNames = new(StringComparer.Ordinal);
    private readonly List<DocumentId> candidates = [];
    private readonly Dictionary<string, Expectation> expected = new(StringComparer.Ordinal);
    private readonly HashSet<ProjectId> usingProjects = [];
    private readonly Dictionary<string, ProjectId?> dependencies = new(StringComparer.Ordinal);
    private DocumentId? createdId;

    public TypeRelocation(
        Solution solution,
        Document declaration,
        IReadOnlyList<INamedTypeSymbol> types,
        string oldNamespace,
        string newNamespace,
        Project targetProject,
        OperationOutcome outcome,
        Func<CompilationUnitSyntax, DeclarationRewrite> rewrite)
    {
        this.solution = solution;
        declarationId = declaration.Id;
        this.types = types;
        this.oldNamespace = oldNamespace;
        this.newNamespace = newNamespace;
        sourceProjectId = declaration.Project.Id;
        targetProjectId = targetProject.Id;
        targetAssembly = targetProject.AssemblyName;
        this.outcome = outcome;
        this.rewrite = rewrite;

        foreach (var type in types)
        {
            movedKeys.Add(TypeKey(type));
            var oldName = DocumentationCommentId.CreateDeclarationId(type)![2..];
            renames.Add((oldName, newNamespace.Length == 0 ? type.MetadataName : $"{newNamespace}.{type.MetadataName}"));
            watchedNames.Add(type.Name);
            if (type.Name.EndsWith("Attribute", StringComparison.Ordinal) && type.Name.Length > "Attribute".Length)
            {
                watchedNames.Add(type.Name[..^"Attribute".Length]);
            }
            foreach (var method in type.GetMembers().OfType<IMethodSymbol>().Where(method => method.IsExtensionMethod))
            {
                watchedNames.Add(method.Name);
            }
        }
        renames.Sort((left, right) => right.Old.Length.CompareTo(left.Old.Length));
    }

    public async Task<Solution> RunAsync()
    {
        var annotated = await AnnotateAsync();
        await RecordExpectationsAsync(annotated);
        var rewritten = await RewriteAsync(annotated);
        var repaired = await RepairAsync(rewritten);
        var pruned = await PruneCreatedUsingsAsync(repaired);
        await VerifyAsync(pruned);
        return pruned;
    }

    private async Task<Solution> AnnotateAsync()
    {
        var current = solution;
        var counter = 0;
        foreach (var project in solution.Projects)
        {
            foreach (var document in project.Documents)
            {
                var root = await FileOperations.CompilationUnitAsync(document);
                var isDeclaration = document.Id == declarationId;
                if (!isDeclaration && !Mentions(root))
                {
                    continue;
                }
                candidates.Add(document.Id);

                var annotations = new Dictionary<SyntaxNode, List<SyntaxAnnotation>>();
                void Add(SyntaxNode node, SyntaxAnnotation annotation)
                {
                    if (!annotations.TryGetValue(node, out var list)) annotations[node] = list = [];
                    list.Add(annotation);
                }
                foreach (var name in root.DescendantNodes(descendIntoTrivia: true).OfType<SimpleNameSyntax>())
                {
                    if (!IsNamespaceDeclarationName(name))
                    {
                        Add(name, new SyntaxAnnotation(NameKind, (counter++).ToString(CultureInfo.InvariantCulture)));
                    }
                }
                foreach (var directive in root.DescendantNodes().OfType<UsingDirectiveSyntax>())
                {
                    if (oldNamespace.Length > 0 && IsPlainUsing(directive) && NormalizedName(directive.NamespaceOrType) == oldNamespace)
                    {
                        Add(directive, new SyntaxAnnotation(OldUsingKind));
                    }
                }
                if (isDeclaration)
                {
                    foreach (var reference in types.SelectMany(type => type.DeclaringSyntaxReferences))
                    {
                        Add(reference.GetSyntax(), new SyntaxAnnotation(MovedKind));
                    }
                    if (root.DescendantNodes().OfType<BaseNamespaceDeclarationSyntax>().SingleOrDefault() is { } @namespace)
                    {
                        Add(@namespace, new SyntaxAnnotation(NamespaceKind));
                    }
                }
                var annotatedRoot = root.ReplaceNodes(
                    annotations.Keys, (original, updated) => updated.WithAdditionalAnnotations(annotations[original]));
                current = current.WithDocumentSyntaxRoot(document.Id, annotatedRoot);
            }
        }
        return current;
    }

    private bool Mentions(CompilationUnitSyntax root) =>
        root.DescendantTokens(descendIntoTrivia: true)
            .Any(token => token.IsKind(SyntaxKind.IdentifierToken) && watchedNames.Contains(token.ValueText))
        || (oldNamespace.Length > 0 && root.DescendantNodes().OfType<UsingDirectiveSyntax>()
            .Any(directive => IsPlainUsing(directive) && NormalizedName(directive.NamespaceOrType) == oldNamespace));

    private async Task RecordExpectationsAsync(Solution current)
    {
        foreach (var id in candidates)
        {
            var document = current.GetDocument(id)!;
            var model = await SemanticModelAsync(document);
            var root = await FileOperations.CompilationUnitAsync(document);
            var movedNodes = id == declarationId ? root.GetAnnotatedNodes(MovedKind).ToArray() : [];
            foreach (var name in AnnotatedNames(root))
            {
                var symbol = Bind(model, name);
                if (symbol is null)
                {
                    continue;
                }
                expected[Key(name)] = new Expectation(
                    Identity(symbol, oldWorld: true),
                    RepairNamespace(symbol, out var extension),
                    extension,
                    symbol.ToDisplayString());
                var insideMoved = movedNodes.Any(node => node.Span.Contains(name.Span));
                var moved = IsMoved(symbol);
                if (moved && !insideMoved)
                {
                    usingProjects.Add(document.Project.Id);
                }
                else if (!moved && insideMoved && symbol is not INamespaceSymbol && symbol.ContainingAssembly is { } assembly)
                {
                    dependencies[assembly.Name] = current.GetProject(assembly)?.Id;
                }
            }
        }
    }

    private async Task<Solution> RewriteAsync(Solution annotated)
    {
        var current = annotated;
        foreach (var id in candidates)
        {
            var document = annotated.GetDocument(id)!;
            var model = await SemanticModelAsync(document);
            var root = await FileOperations.CompilationUnitAsync(document);
            var replacements = new Dictionary<SyntaxNode, Func<SyntaxNode, SyntaxNode>>();
            foreach (var name in AnnotatedNames(root))
            {
                if (IsMovedTypeReference(Bind(model, name)))
                {
                    Requalify(model, name, replacements);
                }
            }
            var rewritten = replacements.Count == 0
                ? root
                : root.ReplaceNodes(replacements.Keys, (original, updated) => replacements[original](updated));

            if (id != declarationId)
            {
                if (replacements.Count > 0 && !IsBuildOutput(document)) current = current.WithDocumentSyntaxRoot(id, rewritten);
                continue;
            }

            var result = rewrite(rewritten);
            current = result.Remaining is null
                ? current.RemoveDocument(id)
                : current.WithDocumentSyntaxRoot(id, result.Remaining);
            if (result.Created is not null && result.CreatedPath is not null)
            {
                var targetProject = current.GetProject(targetProjectId)!;
                var folders = Paths.RelativeSegments(
                    Path.GetDirectoryName(targetProject.FilePath!)!, Path.GetDirectoryName(result.CreatedPath)!);
                var created = targetProject.AddDocument(
                    Path.GetFileName(result.CreatedPath), result.Created, folders, result.CreatedPath);
                createdId = created.Id;
                current = created.Project.Solution;
            }
        }
        return await AddProjectReferencesAsync(annotated, current);
    }

    /// <summary>Rewrites namespace qualifiers of a moved-type reference; unqualified names are repaired later.</summary>
    private void Requalify(SemanticModel model, SimpleNameSyntax name, Dictionary<SyntaxNode, Func<SyntaxNode, SyntaxNode>> replacements)
    {
        switch (name.Parent)
        {
            case QualifiedNameSyntax qualified when qualified.Right == name:
                if (!BindsToOldNamespace(model, qualified.Left)) return;
                if (newNamespace.Length == 0)
                {
                    replacements[qualified] = updated => GlobalAlias(((QualifiedNameSyntax)updated).Right).WithTriviaFrom(updated);
                }
                else
                {
                    var prefix = GlobalPrefix(model, qualified.Left);
                    replacements[qualified.Left] = updated => SyntaxFactory.ParseName(prefix + newNamespace).WithTriviaFrom(updated);
                }
                return;
            case MemberAccessExpressionSyntax access when access.Name == name:
                if (!BindsToOldNamespace(model, access.Expression)) return;
                if (newNamespace.Length == 0)
                {
                    replacements[access] = updated => GlobalAlias(((MemberAccessExpressionSyntax)updated).Name).WithTriviaFrom(updated);
                }
                else
                {
                    var prefix = GlobalPrefix(model, access.Expression);
                    replacements[access.Expression] = updated => SyntaxFactory.ParseName(prefix + newNamespace).WithTriviaFrom(updated);
                }
                return;
            case AliasQualifiedNameSyntax alias when alias.Name == name:
                if (newNamespace.Length > 0 && alias.Alias.Identifier.IsKind(SyntaxKind.GlobalKeyword))
                {
                    replacements[alias] = updated => SyntaxFactory.QualifiedName(
                        SyntaxFactory.ParseName($"global::{newNamespace}"),
                        ((AliasQualifiedNameSyntax)updated).Name.WithoutTrivia()).WithTriviaFrom(updated);
                }
                return;
        }

        // Using aliases and static usings cannot rely on other imports: qualify them fully.
        if (name.Ancestors().Any(ancestor => ancestor is UsingDirectiveSyntax))
        {
            replacements[name] = updated => FullyQualified((SimpleNameSyntax)updated);
        }
    }

    private async Task<Solution> AddProjectReferencesAsync(Solution annotated, Solution current)
    {
        if (sourceProjectId == targetProjectId)
        {
            return current;
        }

        var target = annotated.GetProject(targetProjectId)!;
        var targetCompilation = await target.GetCompilationAsync()
            ?? throw new ProtocolException("PROJECT_LOAD_FAILED", $"No compilation for {target.Name}.");
        var edges = new List<(ProjectId From, ProjectId To)>();
        foreach (var (assembly, projectId) in dependencies.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            if (assembly == targetAssembly)
            {
                continue;
            }
            if (projectId is not null)
            {
                edges.Add((targetProjectId, projectId));
            }
            else if (!targetCompilation.ReferencedAssemblyNames.Any(identity => identity.Name == assembly))
            {
                throw new ProtocolException(
                    "MISSING_DEPENDENCY",
                    $"The moved type uses assembly '{assembly}', which project {target.Name} does not reference; package references are not planned.");
            }
        }
        foreach (var projectId in usingProjects.Where(projectId => projectId != targetProjectId))
        {
            edges.Add((projectId, targetProjectId));
        }
        edges = edges.Distinct()
            .Where(edge => !annotated.GetProject(edge.From)!.ProjectReferences.Any(reference => reference.ProjectId == edge.To))
            .OrderBy(edge => annotated.GetProject(edge.From)!.FilePath, StringComparer.Ordinal)
            .ThenBy(edge => annotated.GetProject(edge.To)!.FilePath, StringComparer.Ordinal)
            .ToList();

        var graph = annotated.Projects.ToDictionary(
            project => project.Id, project => project.ProjectReferences.Select(reference => reference.ProjectId).ToHashSet());
        foreach (var (from, to) in edges)
        {
            graph[from].Add(to);
        }
        if (HasCycle(graph))
        {
            var description = string.Join(", ", edges.Select(edge =>
                $"{annotated.GetProject(edge.From)!.Name} -> {annotated.GetProject(edge.To)!.Name}"));
            throw new ProtocolException(
                "REFERENCE_CYCLE", $"Moving the type requires project references that form a cycle: {description}.");
        }

        var added = new List<(ProjectId From, ProjectId To)>();
        foreach (var (from, to) in edges)
        {
            var fromProject = annotated.GetProject(from)!;
            var toProject = annotated.GetProject(to)!;
            if (TargetFrameworkKey(fromProject) != TargetFrameworkKey(toProject))
            {
                throw new ProtocolException(
                    "TARGET_FRAMEWORK_MISMATCH",
                    $"Adding a reference from {fromProject.Name} to {toProject.Name} across different target frameworks is not supported.");
            }
            var model = await outcome.ProjectModelAsync(fromProject);
            model.AddProjectReference(Path.GetFullPath(toProject.FilePath!));
            current = current.AddProjectReference(from, new ProjectReference(to));
            added.Add((from, to));
            outcome.Notes.Add($"Added a ProjectReference from {fromProject.Name} to {toProject.Name}.");
        }

        // MSBuild flows SDK project references transitively; mirror that for validation without editing dependents.
        var changed = added.Count > 0;
        while (changed)
        {
            changed = false;
            foreach (var project in current.Projects.ToArray())
            {
                if (project.FilePath is null || !(await outcome.ProjectModelAsync(project)).TransitiveReferences)
                {
                    continue;
                }
                var direct = project.ProjectReferences.Select(reference => reference.ProjectId).ToHashSet();
                foreach (var (from, to) in added.ToArray())
                {
                    if (direct.Contains(from) && !direct.Contains(to) && to != project.Id)
                    {
                        current = current.AddProjectReference(project.Id, new ProjectReference(to));
                        added.Add((project.Id, to));
                        direct.Add(to);
                        changed = true;
                    }
                }
            }
        }
        return current;
    }

    private async Task<Solution> RepairAsync(Solution current)
    {
        var next = current;
        foreach (var id in ActiveDocuments(current))
        {
            var document = current.GetDocument(id)!;
            if (IsBuildOutput(document))
            {
                continue;
            }
            var model = await SemanticModelAsync(document);
            var compilation = model.Compilation;
            var root = await FileOperations.CompilationUnitAsync(document);
            var imports = new SortedSet<string>(StringComparer.Ordinal);
            foreach (var name in AnnotatedNames(root))
            {
                if (!expected.TryGetValue(Key(name), out var expectation)) continue;
                var actual = Bind(model, name);
                if (actual is not null && Identity(actual, oldWorld: false) == expectation.Identity) continue;
                if (expectation.RepairNamespace is { Length: > 0 } import && (expectation.IsExtension || IsUnqualified(name)))
                {
                    imports.Add(import);
                }
            }
            var stale = oldNamespace.Length == 0 || NamespaceExists(compilation, oldNamespace)
                ? []
                : root.GetAnnotatedNodes(OldUsingKind).OfType<UsingDirectiveSyntax>().ToArray();
            imports.RemoveWhere(import => !NamespaceExists(compilation, import) || IsImported(root, import));
            if (imports.Count == 0 && stale.Length == 0)
            {
                continue;
            }

            var eol = FileOperations.EndOfLine(root);
            if (stale.Length > 0)
            {
                var renamed = imports.Contains(newNamespace)
                    ? stale.FirstOrDefault(directive => directive.GlobalKeyword.IsKind(SyntaxKind.None))
                    : null;
                if (renamed is not null)
                {
                    imports.Remove(newNamespace);
                }
                var remove = new SyntaxAnnotation();
                root = root.ReplaceNodes(stale, (original, updated) => original == renamed
                    ? ((UsingDirectiveSyntax)updated).WithNamespaceOrType(
                        SyntaxFactory.ParseName(newNamespace).WithTriviaFrom(((UsingDirectiveSyntax)updated).NamespaceOrType))
                    : updated.WithAdditionalAnnotations(remove));
                root = RemoveUsings(root, remove);
            }
            foreach (var import in imports)
            {
                root = AddUsing(root, import, eol);
            }
            next = next.WithDocumentSyntaxRoot(id, root);
        }
        return next;
    }

    /// <summary>The new file starts with a copy of the source imports; drop the ones the compiler reports unused or unresolved.</summary>
    private async Task<Solution> PruneCreatedUsingsAsync(Solution current)
    {
        if (createdId is null)
        {
            return current;
        }
        var document = current.GetDocument(createdId)!;
        var model = await SemanticModelAsync(document);
        var root = await FileOperations.CompilationUnitAsync(document);
        var unused = model.GetDiagnostics()
            .Where(diagnostic => diagnostic.Id == "CS8019" && diagnostic.Location.IsInSource)
            .Select(diagnostic => root.FindNode(diagnostic.Location.SourceSpan, getInnermostNodeForTie: true)
                .FirstAncestorOrSelf<UsingDirectiveSyntax>())
            .OfType<UsingDirectiveSyntax>()
            .Concat(root.DescendantNodes().OfType<UsingDirectiveSyntax>().Where(directive =>
                directive.Alias is null && model.GetSymbolInfo(directive.NamespaceOrType).Symbol is null))
            .Where(directive => directive.GlobalKeyword.IsKind(SyntaxKind.None))
            .Distinct()
            .ToArray();
        if (unused.Length == 0)
        {
            return current;
        }
        var remove = new SyntaxAnnotation();
        root = root.ReplaceNodes(unused, (_, updated) => updated.WithAdditionalAnnotations(remove));
        return current.WithDocumentSyntaxRoot(createdId, RemoveUsings(root, remove));
    }

    private async Task VerifyAsync(Solution current)
    {
        var problems = new List<string>();
        foreach (var id in ActiveDocuments(current))
        {
            var document = current.GetDocument(id)!;
            var model = await SemanticModelAsync(document);
            var root = await FileOperations.CompilationUnitAsync(document);
            foreach (var name in AnnotatedNames(root))
            {
                if (!expected.TryGetValue(Key(name), out var expectation)) continue;
                var actual = Bind(model, name);
                if (actual is null || Identity(actual, oldWorld: false) != expectation.Identity)
                {
                    var line = name.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
                    var reason = model.GetSymbolInfo(name).CandidateReason;
                    var now = actual?.ToDisplayString()
                        ?? (reason == CandidateReason.None ? "nothing" : $"nothing ({reason.ToString().ToLowerInvariant()})");
                    problems.Add($"{document.FilePath}:{line}: '{name}' bound to {expectation.Display} but would bind to {now}");
                }
            }
        }
        if (problems.Count > 0)
        {
            throw new ProtocolException(
                "BINDING_CONFLICT",
                $"The change would alter what existing code refers to: {string.Join("; ", problems.Take(5))}");
        }

        foreach (var type in types)
        {
            var metadataName = newNamespace.Length == 0 ? type.MetadataName : $"{newNamespace}.{type.MetadataName}";
            foreach (var project in current.Projects)
            {
                var compilation = await project.GetCompilationAsync();
                if (compilation is not null && compilation.GetTypesByMetadataName(metadataName).Length > 1)
                {
                    throw new ProtocolException(
                        "TYPE_CONFLICT", $"Type '{metadataName}' would be declared more than once as seen from project {project.Name}.");
                }
            }
        }
    }

    private IEnumerable<DocumentId> ActiveDocuments(Solution current) =>
        candidates.Where(id => current.GetDocument(id) is not null)
            .Concat(createdId is null ? [] : [createdId]);

    /// <summary>Generated sources under obj/ or bin/ are verified but never edited.</summary>
    private static bool IsBuildOutput(Document document)
    {
        var directory = Path.GetDirectoryName(document.Project.FilePath!)!;
        return document.FilePath is null
            || Paths.IsUnder(document.FilePath, Path.Combine(directory, "obj"))
            || Paths.IsUnder(document.FilePath, Path.Combine(directory, "bin"));
    }

    private static IEnumerable<SimpleNameSyntax> AnnotatedNames(SyntaxNode root) =>
        root.DescendantNodes(descendIntoTrivia: true).OfType<SimpleNameSyntax>().Where(name => name.HasAnnotations(NameKind));

    private static string Key(SyntaxNode name) => name.GetAnnotations(NameKind).First().Data!;

    private static async Task<SemanticModel> SemanticModelAsync(Document document) =>
        await document.GetSemanticModelAsync()
        ?? throw new ProtocolException("HELPER_ERROR", $"Could not create a semantic model for {document.FilePath}.");

    private static ISymbol? Bind(SemanticModel model, SimpleNameSyntax name)
    {
        var symbol = model.GetSymbolInfo(name).Symbol;
        if (symbol is IAliasSymbol alias) symbol = alias.Target;
        if (symbol is IMethodSymbol method)
        {
            if (method.MethodKind is MethodKind.LocalFunction or MethodKind.AnonymousFunction) return null;
            symbol = method.ReducedFrom ?? method;
        }
        symbol = symbol?.OriginalDefinition;
        return symbol is null or IErrorTypeSymbol
            || symbol.Kind is SymbolKind.Local or SymbolKind.Parameter or SymbolKind.RangeVariable or SymbolKind.Label
                or SymbolKind.TypeParameter or SymbolKind.Discard or SymbolKind.Preprocessing
            ? null
            : symbol;
    }

    private string Identity(ISymbol symbol, bool oldWorld)
    {
        if (symbol is INamespaceSymbol @namespace)
        {
            return $"N:{FileOperations.NamespaceName(@namespace)}";
        }
        var id = DocumentationCommentId.CreateDeclarationId(symbol)
            ?? $"{symbol.Kind}:{symbol.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat)}";
        var assembly = symbol.ContainingAssembly?.Name ?? "";
        if (oldWorld)
        {
            if (IsMoved(symbol)) assembly = targetAssembly;
            id = MapIds(id);
        }
        return $"{assembly}|{id}";
    }

    /// <summary>Replaces old fully qualified moved-type names inside a documentation id.</summary>
    private string MapIds(string id)
    {
        foreach (var (oldName, newName) in renames)
        {
            var index = 0;
            while ((index = id.IndexOf(oldName, index, StringComparison.Ordinal)) >= 0)
            {
                var end = index + oldName.Length;
                var startsName = index == 0 || id[index - 1] is ':' or '(' or ',' or '{';
                var endsName = end == id.Length || !(char.IsLetterOrDigit(id[end]) || id[end] is '_' or '`');
                if (startsName && endsName)
                {
                    id = id[..index] + newName + id[end..];
                    index += newName.Length;
                }
                else
                {
                    index = end;
                }
            }
        }
        return id;
    }

    private bool IsMoved(ISymbol symbol)
    {
        for (var type = symbol as INamedTypeSymbol ?? symbol.ContainingType; type is not null; type = type.ContainingType)
        {
            if (type.ContainingType is null && movedKeys.Contains(TypeKey(type)))
            {
                return true;
            }
        }
        return false;
    }

    private bool IsMovedTypeReference(ISymbol? symbol) => symbol switch
    {
        INamedTypeSymbol type => type.ContainingType is null && IsMoved(type),
        IMethodSymbol { MethodKind: MethodKind.Constructor } constructor =>
            constructor.ContainingType.ContainingType is null && IsMoved(constructor.ContainingType),
        _ => false,
    };

    /// <summary>The namespace whose import would make a simple name bind to the symbol again.</summary>
    private string? RepairNamespace(ISymbol symbol, out bool extension)
    {
        extension = false;
        var type = symbol as INamedTypeSymbol
            ?? (symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } constructor ? constructor.ContainingType : null);
        if (type is null && symbol is IMethodSymbol { IsExtensionMethod: true } method)
        {
            type = method.ContainingType;
            extension = true;
        }
        if (type is null)
        {
            return null;
        }
        while (type.ContainingType is not null) type = type.ContainingType;
        return IsMoved(type) ? newNamespace : FileOperations.NamespaceName(type.ContainingNamespace);
    }

    private static string TypeKey(INamedTypeSymbol type) =>
        $"{type.ContainingAssembly?.Name}|{DocumentationCommentId.CreateDeclarationId(type.OriginalDefinition)}";

    private bool BindsToOldNamespace(SemanticModel model, ExpressionSyntax expression) =>
        model.GetSymbolInfo(expression).Symbol is INamespaceSymbol @namespace
        && FileOperations.NamespaceName(@namespace) == oldNamespace;

    private static string GlobalPrefix(SemanticModel model, ExpressionSyntax expression)
    {
        var leftmost = expression;
        while (true)
        {
            switch (leftmost)
            {
                case QualifiedNameSyntax qualified: leftmost = qualified.Left; continue;
                case MemberAccessExpressionSyntax access: leftmost = access.Expression; continue;
            }
            break;
        }
        return leftmost is AliasQualifiedNameSyntax
            || (leftmost is IdentifierNameSyntax identifier && model.GetAliasInfo(identifier) is not null)
            ? "global::"
            : "";
    }

    private NameSyntax FullyQualified(SimpleNameSyntax name) =>
        newNamespace.Length == 0
            ? GlobalAlias(name).WithTriviaFrom(name)
            : SyntaxFactory.QualifiedName(SyntaxFactory.ParseName($"global::{newNamespace}"), name.WithoutTrivia()).WithTriviaFrom(name);

    private static AliasQualifiedNameSyntax GlobalAlias(SimpleNameSyntax name) =>
        SyntaxFactory.AliasQualifiedName(
            SyntaxFactory.IdentifierName(SyntaxFactory.Token(SyntaxKind.GlobalKeyword)), name.WithoutTrivia());

    private static bool IsUnqualified(SimpleNameSyntax name) => name.Parent switch
    {
        QualifiedNameSyntax qualified => qualified.Right != name,
        MemberAccessExpressionSyntax access => access.Name != name,
        AliasQualifiedNameSyntax alias => alias.Name != name,
        MemberBindingExpressionSyntax => false,
        _ => true,
    };

    private static bool IsNamespaceDeclarationName(SimpleNameSyntax name)
    {
        SyntaxNode node = name;
        while (node.Parent is QualifiedNameSyntax or AliasQualifiedNameSyntax) node = node.Parent;
        return node.Parent is BaseNamespaceDeclarationSyntax declaration && declaration.Name == node;
    }

    private static bool IsPlainUsing(UsingDirectiveSyntax directive) =>
        directive.Alias is null && directive.StaticKeyword.IsKind(SyntaxKind.None) && directive.NamespaceOrType is not null;

    private static string NormalizedName(TypeSyntax? name)
    {
        var text = new string((name?.ToString() ?? "").Where(c => !char.IsWhiteSpace(c)).ToArray());
        return text.StartsWith("global::", StringComparison.Ordinal) ? text["global::".Length..] : text;
    }

    private static bool IsImported(CompilationUnitSyntax root, string @namespace) =>
        root.DescendantNodes().OfType<UsingDirectiveSyntax>()
            .Any(directive => IsPlainUsing(directive) && NormalizedName(directive.NamespaceOrType) == @namespace);

    private static bool NamespaceExists(Compilation compilation, string name)
    {
        INamespaceSymbol? current = compilation.GlobalNamespace;
        foreach (var part in name.Split('.'))
        {
            current = current.GetNamespaceMembers().FirstOrDefault(member => member.Name == part);
            if (current is null) return false;
        }
        return true;
    }

    private static string TargetFrameworkKey(Project project) => string.Join(
        ';',
        (project.ParseOptions?.PreprocessorSymbolNames ?? [])
            .Where(symbol => symbol.StartsWith("NET", StringComparison.Ordinal) && !symbol.EndsWith("_OR_GREATER", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal));

    private static bool HasCycle(Dictionary<ProjectId, HashSet<ProjectId>> graph)
    {
        var state = new Dictionary<ProjectId, int>();
        bool Visit(ProjectId id)
        {
            state.TryGetValue(id, out var current);
            if (current == 1) return true;
            if (current == 2) return false;
            state[id] = 1;
            if (graph.TryGetValue(id, out var edges) && edges.Any(Visit)) return true;
            state[id] = 2;
            return false;
        }
        return graph.Keys.Any(Visit);
    }

    /// <summary>Removes annotated using directives, keeping comments attached to them.</summary>
    private static CompilationUnitSyntax RemoveUsings(CompilationUnitSyntax root, SyntaxAnnotation marker)
    {
        while (root.GetAnnotatedNodes(marker).FirstOrDefault() is { } node)
        {
            var keepComments = node.GetLeadingTrivia().Any(trivia => !FileOperations.IsBlankTrivia(trivia));
            root = root.RemoveNode(node, keepComments ? SyntaxRemoveOptions.KeepLeadingTrivia : SyntaxRemoveOptions.KeepNoTrivia)!;
        }
        if (root.Usings.Count == 0 && root.Externs.Count == 0)
        {
            var first = root.GetFirstToken(includeZeroWidth: true);
            root = root.ReplaceToken(first, first.WithLeadingTrivia(FileOperations.StripLeadingBlankLines(first.LeadingTrivia)));
        }
        return root;
    }

    /// <summary>Adds an import next to existing ones, following their order when they are sorted.</summary>
    private static CompilationUnitSyntax AddUsing(CompilationUnitSyntax root, string @namespace, SyntaxTrivia eol)
    {
        var directive = SyntaxFactory.UsingDirective(SyntaxFactory.ParseName(@namespace))
            .NormalizeWhitespace()
            .WithTrailingTrivia(eol);

        if (root.Usings.Count == 0 && root.Members.Count == 1
            && root.Members[0] is BaseNamespaceDeclarationSyntax container && container.Usings.Count > 0)
        {
            return root.ReplaceNode(container, container.WithUsings(Insert(container.Usings, directive)));
        }
        if (root.Usings.Count > 0)
        {
            return root.WithUsings(Insert(root.Usings, directive));
        }
        if (root.Externs.Count > 0)
        {
            return root.WithUsings(SyntaxFactory.SingletonList(directive));
        }

        var first = root.GetFirstToken(includeZeroWidth: true);
        var (header, rest) = FileOperations.SplitHeader(first.LeadingTrivia);
        root = root.ReplaceToken(first, first.WithLeadingTrivia(
            SyntaxFactory.TriviaList(eol).AddRange(FileOperations.StripLeadingBlankLines(rest))));
        return root.WithUsings(SyntaxFactory.SingletonList(directive.WithLeadingTrivia(header)));
    }

    private static SyntaxList<UsingDirectiveSyntax> Insert(SyntaxList<UsingDirectiveSyntax> usings, UsingDirectiveSyntax directive)
    {
        var plain = usings.Where(item => IsPlainUsing(item) && item.GlobalKeyword.IsKind(SyntaxKind.None)).ToArray();
        var name = NormalizedName(directive.NamespaceOrType);
        Comparison<string>? comparison = null;
        Comparison<string> systemFirst = (left, right) =>
        {
            var leftSystem = left == "System" || left.StartsWith("System.", StringComparison.Ordinal);
            var rightSystem = right == "System" || right.StartsWith("System.", StringComparison.Ordinal);
            return leftSystem != rightSystem ? (leftSystem ? -1 : 1) : StringComparer.OrdinalIgnoreCase.Compare(left, right);
        };
        Comparison<string> alphabetical = (left, right) => StringComparer.OrdinalIgnoreCase.Compare(left, right);
        var names = plain.Select(item => NormalizedName(item.NamespaceOrType)).ToArray();
        if (IsSorted(names, systemFirst)) comparison = systemFirst;
        else if (IsSorted(names, alphabetical)) comparison = alphabetical;

        int index;
        var before = comparison is null ? null : plain.FirstOrDefault(item => comparison(NormalizedName(item.NamespaceOrType), name) > 0);
        if (before is not null)
        {
            index = usings.IndexOf(before);
        }
        else
        {
            index = plain.Length > 0 ? usings.IndexOf(plain[^1]) + 1 : usings.Count;
        }

        var neighbour = usings[index < usings.Count ? index : index - 1];
        var indentation = SyntaxFactory.TriviaList(neighbour.GetLeadingTrivia().Reverse()
            .TakeWhile(trivia => trivia.IsKind(SyntaxKind.WhitespaceTrivia)).Reverse());
        if (index == 0)
        {
            usings = usings.Replace(usings[0], usings[0].WithLeadingTrivia(indentation));
            return usings.Insert(0, directive.WithLeadingTrivia(neighbour.GetLeadingTrivia()));
        }
        return usings.Insert(index, directive.WithLeadingTrivia(indentation));
    }

    private static bool IsSorted(IReadOnlyList<string> names, Comparison<string> comparison)
    {
        for (var index = 1; index < names.Count; index++)
        {
            if (comparison(names[index - 1], names[index]) > 0) return false;
        }
        return true;
    }

    private sealed record Expectation(string Identity, string? RepairNamespace, bool IsExtension, string Display);
}
