using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

/// <summary>Solution plus the non-document state a file operation plans (project files, new-file encodings).</summary>
internal sealed class OperationOutcome(Solution solution, string conflictCode)
{
    public Solution Solution { get; set; } = solution;
    public string ConflictCode { get; } = conflictCode;
    public Dictionary<string, ProjectModel> Projects { get; } = new(Paths.Comparer);
    public Dictionary<string, bool> NewDocumentBom { get; } = new(Paths.Comparer);
    public List<string> Notes { get; } = [];

    public async Task<ProjectModel> ProjectModelAsync(Project project)
    {
        var path = Path.GetFullPath(project.FilePath
            ?? throw new ProtocolException("PROJECT_SCOPE_INCOMPLETE", $"Project has no file path: {project.Name}"));
        if (!Projects.TryGetValue(path, out var model))
        {
            model = ProjectModel.Create(project, await ProjectFileText.LoadAsync(path));
            Projects[path] = model;
        }
        return model;
    }
}

internal static class FileOperations
{
    public static async Task<OperationOutcome> RenameFileAsync(Solution solution, Document document, Request request)
    {
        var outcome = new OperationOutcome(solution, "RENAME_FILE_CONFLICT");
        var project = document.Project;
        EnsureNotLinked(document, project);
        var root = await CompilationUnitAsync(document);
        var type = await SelectTypeAsync(document, root, request, nestedSelectsContainer: true);
        var name = DeclaredName(type);
        var newPath = Path.Combine(Path.GetDirectoryName(request.File)!, $"{name}.cs");
        if (Paths.Equal(newPath, request.File))
        {
            outcome.Notes.Add($"File name already matches declared type '{name}'; no changes are needed.");
            return outcome;
        }
        if (string.Equals(newPath, request.File, StringComparison.OrdinalIgnoreCase))
        {
            throw new ProtocolException("CASE_ONLY_RENAME", "Case-only file renames are not supported safely across file systems.");
        }
        EnsureTargetAvailable(solution, newPath);
        EnsureOwnedBy(solution, newPath, project);

        var model = await outcome.ProjectModelAsync(project);
        model.Rename(request.File, newPath);
        var text = await document.GetTextAsync();
        var added = solution.RemoveDocument(document.Id)
            .GetProject(project.Id)!
            .AddDocument(Path.GetFileName(newPath), text, document.Folders, newPath);
        outcome.Solution = added.Project.Solution;
        outcome.NewDocumentBom[newPath] = (await Program.ReadUtf8FileAsync(request.File)).HasBom;
        outcome.Notes.Add($"Renamed {Path.GetFileName(request.File)} to {Path.GetFileName(newPath)} to match declared type '{name}'; source text is unchanged.");
        outcome.Notes.Add(model.Mode == CompileItemMode.Explicit
            ? $"Updated the explicit Compile item in {Path.GetFileName(model.File.Path)}."
            : "The project includes sources through SDK default globbing; no project file change is needed.");
        return outcome;
    }

    public static async Task<OperationOutcome> SyncNamespaceAsync(Solution solution, Document document, Request request)
    {
        var outcome = new OperationOutcome(solution, "SYNC_NAMESPACE_CONFLICT");
        var project = document.Project;
        EnsureNotLinked(document, project);
        var root = await CompilationUnitAsync(document);
        RejectDirectives(root, null);
        var layout = NamespaceLayout.Analyze(root);
        var semanticModel = await document.GetSemanticModelAsync()
            ?? throw new ProtocolException("SYNC_NAMESPACE_FAILED", "Could not create the C# semantic model.");
        var types = layout.Types.Select(type => DeclaredSymbol(semanticModel, type)).ToArray();
        foreach (var type in types)
        {
            EnsureDeclaredOnlyIn(type, root.SyntaxTree);
        }

        var oldNamespace = NamespaceName(types[0].ContainingNamespace);
        var newNamespace = ConventionalNamespace(project, request.File, request.RootNamespace);
        if (string.Equals(oldNamespace, newNamespace, StringComparison.Ordinal))
        {
            outcome.Notes.Add($"Namespace '{newNamespace}' already matches the project folder convention; no changes are needed.");
            return outcome;
        }
        if (newNamespace.Length == 0)
        {
            throw new ProtocolException("UNSUPPORTED_NAMESPACE", "Moving declarations into the global namespace is not supported.");
        }
        if (layout.Namespace is null && ((CSharpParseOptions)root.SyntaxTree.Options).LanguageVersion < LanguageVersion.CSharp10)
        {
            throw new ProtocolException(
                "UNSUPPORTED_NAMESPACE", "Adding a namespace to a global-namespace file requires C# 10 file-scoped namespaces.");
        }

        var relocation = new TypeRelocation(
            solution, document, types, oldNamespace, newNamespace, project, outcome,
            rewrittenRoot => new DeclarationRewrite(SetNamespace(rewrittenRoot, newNamespace), null, null));
        outcome.Solution = await relocation.RunAsync();
        outcome.Notes.Add(
            $"Changed namespace '{DisplayNamespace(oldNamespace)}' to '{newNamespace}' for {string.Join(", ", types.Select(type => type.Name))} "
            + "in the selected file only; other declarations of the old namespace are unchanged.");
        outcome.Notes.Add(request.RootNamespace is null
            ? $"Expected namespace derived from project root namespace '{project.DefaultNamespace}' and folders."
            : $"Expected namespace derived from root namespace override '{request.RootNamespace}' and folders.");
        return outcome;
    }

    public static async Task<OperationOutcome> MoveTypeAsync(Solution solution, Document document, Request request)
    {
        var outcome = new OperationOutcome(solution, "MOVE_TYPE_CONFLICT");
        var target = request.Target ?? throw new ProtocolException("INVALID_REQUEST", "move-type requires target.");
        var sourceProject = document.Project;
        EnsureNotLinked(document, sourceProject);
        if (Paths.Equal(target, request.File))
        {
            throw new ProtocolException("INVALID_REQUEST", "move-type target must differ from the source file.");
        }
        EnsureTargetAvailable(solution, target);
        var targetProject = ResolveTargetProject(solution, target, request.TargetProject);
        EnsureOwnedBy(solution, target, targetProject);

        var root = await CompilationUnitAsync(document);
        var layout = NamespaceLayout.Analyze(root);
        var typeNode = await SelectTypeAsync(document, root, request, nestedSelectsContainer: false);
        RejectDirectives(root, typeNode);
        var semanticModel = await document.GetSemanticModelAsync()
            ?? throw new ProtocolException("MOVE_TYPE_FAILED", "Could not create the C# semantic model.");
        var type = DeclaredSymbol(semanticModel, typeNode);
        EnsureDeclaredOnlyIn(type, root.SyntaxTree);
        if (type.DeclaringSyntaxReferences.Length != 1)
        {
            throw new ProtocolException("PARTIAL_TYPE_UNSUPPORTED", $"Type '{type.Name}' has multiple partial declarations.");
        }
        if (type.IsFileLocal)
        {
            throw new ProtocolException("FILE_LOCAL_TYPE_UNSUPPORTED", $"File-local type '{type.Name}' cannot move to another file.");
        }

        var oldNamespace = NamespaceName(type.ContainingNamespace);
        string newNamespace;
        if (request.RootNamespace is not null)
        {
            newNamespace = ConventionalNamespace(targetProject, target, request.RootNamespace);
        }
        else if (sourceProject.DefaultNamespace is not null
            && string.Equals(oldNamespace, ConventionalNamespace(sourceProject, request.File, null), StringComparison.Ordinal))
        {
            newNamespace = ConventionalNamespace(targetProject, target, null);
        }
        else
        {
            newNamespace = oldNamespace;
            outcome.Notes.Add("Kept the existing namespace because the source file does not follow its project's folder namespace convention.");
        }
        if (newNamespace.Length == 0 && oldNamespace.Length != 0)
        {
            throw new ProtocolException("UNSUPPORTED_NAMESPACE", "Moving a type into the global namespace is not supported.");
        }
        if (layout.Namespace is null && newNamespace.Length != 0
            && ((CSharpParseOptions)root.SyntaxTree.Options).LanguageVersion < LanguageVersion.CSharp10)
        {
            throw new ProtocolException(
                "UNSUPPORTED_NAMESPACE", "Adding a namespace to a global-namespace type requires C# 10 file-scoped namespaces.");
        }

        // Global imports belong to the source project even when its only type moves.
        var removesSource = layout.Types.Count == 1 && root.AttributeLists.Count == 0
            && !root.Usings.Any(directive => !directive.GlobalKeyword.IsKind(SyntaxKind.None));
        var sourceModel = await outcome.ProjectModelAsync(sourceProject);
        var targetModel = await outcome.ProjectModelAsync(targetProject);
        if (removesSource)
        {
            sourceModel.Exclude(request.File);
        }
        targetModel.Include(target);
        outcome.NewDocumentBom[target] = (await Program.ReadUtf8FileAsync(request.File)).HasBom;

        var relocation = new TypeRelocation(
            solution, document, [type], oldNamespace, newNamespace, targetProject, outcome,
            rewrittenRoot => SplitType(rewrittenRoot, newNamespace, removesSource, target));
        outcome.Solution = await relocation.RunAsync();

        outcome.Notes.Add(
            $"Moved type '{type.Name}' from {Path.GetFileName(request.File)} ({sourceProject.Name}) to {Path.GetFileName(target)} ({targetProject.Name}).");
        if (!string.Equals(oldNamespace, newNamespace, StringComparison.Ordinal))
        {
            outcome.Notes.Add($"Changed the moved type's namespace from '{DisplayNamespace(oldNamespace)}' to '{newNamespace}'.");
        }
        outcome.Notes.Add(removesSource
            ? "The source file contained only the moved type and is deleted."
            : "Other declarations remain in the source file.");
        if (sourceProject.Id != targetProject.Id)
        {
            outcome.Notes.Add("The moved type now belongs to a different assembly; reflection, InternalsVisibleTo and assembly-qualified names that depend on its assembly are not rewritten.");
            if (!Path.GetExtension(request.Project).Equals(".sln", StringComparison.OrdinalIgnoreCase))
            {
                outcome.Notes.Add("Only projects loaded from the requested project file were updated and validated; use a .sln to include every dependent project.");
            }
        }
        return outcome;
    }

    private static DeclarationRewrite SplitType(CompilationUnitSyntax root, string newNamespace, bool removesSource, string target)
    {
        var eol = EndOfLine(root);
        var typeNode = root.GetAnnotatedNodes(TypeRelocation.MovedKind).OfType<MemberDeclarationSyntax>().Single();
        var namespaceNode = root.GetAnnotatedNodes(TypeRelocation.NamespaceKind).OfType<BaseNamespaceDeclarationSyntax>().SingleOrDefault();

        MemberDeclarationSyntax created;
        if (namespaceNode is not null)
        {
            var member = namespaceNode is NamespaceDeclarationSyntax
                ? typeNode.WithLeadingTrivia(StripLeadingBlankLines(typeNode.GetLeadingTrivia()))
                : typeNode.WithLeadingTrivia(SyntaxFactory.TriviaList(eol).AddRange(StripLeadingBlankLines(typeNode.GetLeadingTrivia())));
            created = namespaceNode
                .WithName(SyntaxFactory.ParseName(newNamespace).WithTriviaFrom(namespaceNode.Name))
                .WithMembers(SyntaxFactory.SingletonList(member));
        }
        else if (newNamespace.Length == 0)
        {
            created = typeNode.WithLeadingTrivia(StripLeadingBlankLines(typeNode.GetLeadingTrivia()));
        }
        else
        {
            var declaration = FileScopedNamespace(newNamespace, eol);
            created = declaration.WithMembers(SyntaxFactory.SingletonList(typeNode.WithLeadingTrivia(
                SyntaxFactory.TriviaList(eol).AddRange(StripLeadingBlankLines(typeNode.GetLeadingTrivia())))));
        }
        var usings = SyntaxFactory.List(root.Usings.Where(directive => directive.GlobalKeyword.IsKind(SyntaxKind.None)));
        if (usings.Count > 0 || root.Externs.Count > 0)
        {
            created = created.WithLeadingTrivia(SyntaxFactory.TriviaList(eol).AddRange(StripLeadingBlankLines(created.GetLeadingTrivia())));
        }
        else
        {
            created = created.WithLeadingTrivia(StripLeadingBlankLines(created.GetLeadingTrivia()));
        }
        var createdRoot = SyntaxFactory.CompilationUnit(
            root.Externs, usings, default, SyntaxFactory.SingletonList(created), SyntaxFactory.Token(SyntaxKind.EndOfFileToken));

        CompilationUnitSyntax? remaining = null;
        if (!removesSource)
        {
            var parentMembers = typeNode.Parent switch
            {
                BaseNamespaceDeclarationSyntax container => container.Members,
                _ => root.Members,
            };
            var index = parentMembers.IndexOf(typeNode);
            var next = index + 1 < parentMembers.Count ? parentMembers[index + 1] : null;
            if (index == 0 && next is not null)
            {
                var leading = StripLeadingBlankLines(next.GetLeadingTrivia());
                var adjusted = typeNode.Parent is NamespaceDeclarationSyntax
                    ? next.WithLeadingTrivia(leading)
                    : next.WithLeadingTrivia(typeNode.GetLeadingTrivia().TakeWhile(IsBlankTrivia).Concat(leading));
                root = root.ReplaceNode(next, adjusted);
                typeNode = root.GetAnnotatedNodes(TypeRelocation.MovedKind).OfType<MemberDeclarationSyntax>().Single();
            }
            remaining = root.RemoveNode(typeNode, SyntaxRemoveOptions.KeepNoTrivia);
        }
        return new DeclarationRewrite(remaining, createdRoot, target);
    }

    private static CompilationUnitSyntax SetNamespace(CompilationUnitSyntax root, string newNamespace)
    {
        var namespaceNode = root.GetAnnotatedNodes(TypeRelocation.NamespaceKind).OfType<BaseNamespaceDeclarationSyntax>().SingleOrDefault();
        if (namespaceNode is not null)
        {
            return root.ReplaceNode(
                namespaceNode,
                namespaceNode.WithName(SyntaxFactory.ParseName(newNamespace).WithTriviaFrom(namespaceNode.Name)));
        }

        var eol = EndOfLine(root);
        var first = root.Members[0];
        var hasDirectives = root.Usings.Count > 0 || root.Externs.Count > 0;
        var (header, rest) = hasDirectives ? (SyntaxFactory.TriviaList(eol), first.GetLeadingTrivia()) : SplitHeader(first.GetLeadingTrivia());
        var members = root.Members.Replace(first, first.WithLeadingTrivia(
            SyntaxFactory.TriviaList(eol).AddRange(StripLeadingBlankLines(rest))));
        var declaration = FileScopedNamespace(newNamespace, eol)
            .WithLeadingTrivia(hasDirectives ? header : StripLeadingBlankLines(header))
            .WithMembers(members)
            .WithAdditionalAnnotations(new SyntaxAnnotation(TypeRelocation.NamespaceKind));
        return root.WithMembers(SyntaxFactory.SingletonList<MemberDeclarationSyntax>(declaration));
    }

    private static FileScopedNamespaceDeclarationSyntax FileScopedNamespace(string name, SyntaxTrivia eol) =>
        (FileScopedNamespaceDeclarationSyntax)SyntaxFactory.ParseCompilationUnit($"namespace {name};{eol.ToFullString()}").Members[0];

    internal static async Task<CompilationUnitSyntax> CompilationUnitAsync(Document document) =>
        await document.GetSyntaxRootAsync() as CompilationUnitSyntax
        ?? throw new ProtocolException("UNSUPPORTED_DOCUMENT", "Could not read the C# compilation unit.");

    private static async Task<MemberDeclarationSyntax> SelectTypeAsync(
        Document document, CompilationUnitSyntax root, Request request, bool nestedSelectsContainer)
    {
        var topLevel = root.DescendantNodes(node => node is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax)
            .OfType<MemberDeclarationSyntax>()
            .Where(IsTypeDeclaration)
            .Where(node => node.Parent is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax)
            .ToArray();

        if (request.TypeName is not null)
        {
            var named = topLevel.Where(node => DeclaredName(node) == request.TypeName).ToArray();
            return named.Length switch
            {
                1 => named[0],
                0 => throw new ProtocolException("TYPE_NOT_FOUND", $"No top-level type named '{request.TypeName}' is declared in the file."),
                _ => throw new ProtocolException("AMBIGUOUS_TYPE", $"Several top-level types are named '{request.TypeName}'."),
            };
        }

        if (request.Position is not null)
        {
            var position = await Program.ResolvePositionAsync(document, request.File, request.Position.Value);
            var innermost = root.FindToken(position).Parent?.AncestorsAndSelf()
                .OfType<MemberDeclarationSyntax>().FirstOrDefault(IsTypeDeclaration)
                ?? throw new ProtocolException("TYPE_NOT_FOUND", "No type declaration contains the requested position.");
            var outermost = innermost.AncestorsAndSelf().OfType<MemberDeclarationSyntax>().Last(IsTypeDeclaration);
            if (innermost != outermost && !nestedSelectsContainer)
            {
                throw new ProtocolException("NESTED_TYPE_UNSUPPORTED", "Moving a nested type out of its containing type is not supported.");
            }
            if (!topLevel.Contains(outermost))
            {
                throw new ProtocolException("TYPE_NOT_FOUND", "The selected type is not a top-level namespace member.");
            }
            return outermost;
        }

        return topLevel.Length switch
        {
            1 => topLevel[0],
            0 => throw new ProtocolException("TYPE_NOT_FOUND", "The file declares no top-level type."),
            _ => throw new ProtocolException(
                "AMBIGUOUS_TYPE",
                $"The file declares several top-level types ({string.Join(", ", topLevel.Select(DeclaredName))}); select one with typeName or position."),
        };
    }

    private static bool IsTypeDeclaration(MemberDeclarationSyntax node) =>
        node is BaseTypeDeclarationSyntax or DelegateDeclarationSyntax;

    internal static string DeclaredName(MemberDeclarationSyntax node) => node switch
    {
        BaseTypeDeclarationSyntax type => type.Identifier.ValueText,
        DelegateDeclarationSyntax @delegate => @delegate.Identifier.ValueText,
        _ => throw new InvalidOperationException("Not a type declaration."),
    };

    private static INamedTypeSymbol DeclaredSymbol(SemanticModel model, MemberDeclarationSyntax node) =>
        model.GetDeclaredSymbol(node) as INamedTypeSymbol
        ?? throw new ProtocolException("TYPE_NOT_FOUND", $"Roslyn could not resolve type '{DeclaredName(node)}'.");

    private static void EnsureDeclaredOnlyIn(INamedTypeSymbol type, SyntaxTree tree)
    {
        if (type.DeclaringSyntaxReferences.Any(reference => reference.SyntaxTree != tree))
        {
            throw new ProtocolException(
                "PARTIAL_TYPE_UNSUPPORTED", $"Type '{type.Name}' has partial declarations in other files.");
        }
    }

    private static void EnsureNotLinked(Document document, Project project)
    {
        var projectDirectory = Path.GetDirectoryName(project.FilePath!)!;
        if (document.FilePath is null || !Paths.IsUnder(document.FilePath, projectDirectory))
        {
            throw new ProtocolException("LINKED_FILE_UNSUPPORTED", "Files linked from outside their project directory are not supported.");
        }
    }

    private static void EnsureTargetAvailable(Solution solution, string path)
    {
        if (File.Exists(path) || Directory.Exists(path))
        {
            throw new ProtocolException("TARGET_EXISTS", $"Target already exists: {path}");
        }
        // Missing ancestor directories are created when the plan is applied; an existing
        // non-directory ancestor can never hold the target.
        for (var parent = Path.GetDirectoryName(path); parent is not null && !Directory.Exists(parent); parent = Path.GetDirectoryName(parent))
        {
            if (File.Exists(parent))
            {
                throw new ProtocolException("TARGET_PARENT_NOT_DIRECTORY", $"Target ancestor is not a directory: {parent}");
            }
        }
        if (solution.Projects.SelectMany(project => project.Documents).Any(document =>
                document.FilePath is not null && Paths.Equal(document.FilePath, path)))
        {
            throw new ProtocolException("TARGET_EXISTS", $"Target is already a loaded document: {path}");
        }
    }

    /// <summary>The deepest loaded project directory containing a path is the project that would glob it.</summary>
    private static void EnsureOwnedBy(Solution solution, string path, Project expected)
    {
        var owner = solution.Projects
            .Where(project => project.FilePath is not null && Paths.IsUnder(path, Path.GetDirectoryName(project.FilePath)!))
            .GroupBy(project => Path.GetDirectoryName(project.FilePath!)!.Length)
            .OrderByDescending(group => group.Key)
            .FirstOrDefault()?.ToArray() ?? [];
        if (owner.Length == 0 || !owner.All(project => Paths.Equal(project.FilePath!, expected.FilePath!)))
        {
            throw new ProtocolException(
                "TARGET_OUTSIDE_PROJECT",
                $"{path} is not inside the directory of project {expected.Name} (or belongs to a nested project).");
        }
    }

    private static Project ResolveTargetProject(Solution solution, string target, string? targetProject)
    {
        Project[] candidates;
        if (targetProject is not null)
        {
            candidates = solution.Projects.Where(project => project.FilePath is not null && Paths.Equal(project.FilePath, targetProject)).ToArray();
            if (candidates.Length == 0)
            {
                throw new ProtocolException(
                    "TARGET_PROJECT_NOT_LOADED", $"Target project is not loaded from the requested project or solution: {targetProject}");
            }
        }
        else
        {
            candidates = solution.Projects
                .Where(project => project.FilePath is not null && Paths.IsUnder(target, Path.GetDirectoryName(project.FilePath)!))
                .GroupBy(project => Path.GetDirectoryName(project.FilePath!)!.Length)
                .OrderByDescending(group => group.Key)
                .FirstOrDefault()?.ToArray() ?? [];
            if (candidates.Length == 0)
            {
                throw new ProtocolException("TARGET_PROJECT_UNKNOWN", $"No loaded project contains the target path: {target}");
            }
        }
        if (candidates.Length > 1)
        {
            throw new ProtocolException("AMBIGUOUS_PROJECT", "The target project is loaded more than once (multi-targeting is not supported).");
        }
        return candidates[0];
    }

    /// <summary>Rejects preprocessor directives whose meaning would change with the edit.</summary>
    private static void RejectDirectives(CompilationUnitSyntax root, SyntaxNode? moved)
    {
        foreach (var directive in root.DescendantTrivia(descendIntoTrivia: true).Where(trivia => trivia.IsDirective))
        {
            var conditional = directive.Kind() is SyntaxKind.IfDirectiveTrivia or SyntaxKind.ElifDirectiveTrivia
                or SyntaxKind.ElseDirectiveTrivia or SyntaxKind.EndIfDirectiveTrivia
                or SyntaxKind.DefineDirectiveTrivia or SyntaxKind.UndefDirectiveTrivia;
            if (conditional)
            {
                throw new ProtocolException("UNSUPPORTED_DIRECTIVES", "Files with conditional compilation directives are not supported.");
            }
            if (moved is not null)
            {
                var harmless = directive.Kind() is SyntaxKind.RegionDirectiveTrivia or SyntaxKind.EndRegionDirectiveTrivia
                    or SyntaxKind.PragmaWarningDirectiveTrivia;
                if (!harmless || moved.FullSpan.IntersectsWith(directive.Span))
                {
                    throw new ProtocolException(
                        "UNSUPPORTED_DIRECTIVES", $"Preprocessor directive '{directive.ToString().Trim()}' would not move safely with the type.");
                }
            }
        }
    }

    internal static string ConventionalNamespace(Project project, string file, string? rootOverride)
    {
        var rootNamespace = rootOverride ?? project.DefaultNamespace
            ?? throw new ProtocolException("ROOT_NAMESPACE_UNKNOWN", $"Project {project.Name} has no RootNamespace; pass rootNamespace.");
        var parts = rootNamespace.Length == 0 ? new List<string>() : rootNamespace.Split('.').ToList();
        foreach (var part in parts)
        {
            if (!SyntaxFacts.IsValidIdentifier(part) || SyntaxFacts.GetKeywordKind(part) != SyntaxKind.None)
            {
                throw new ProtocolException("INVALID_NAMESPACE", $"Root namespace '{rootNamespace}' is not a valid C# namespace.");
            }
        }
        var projectDirectory = Path.GetDirectoryName(project.FilePath!)!;
        foreach (var folder in Paths.RelativeSegments(projectDirectory, Path.GetDirectoryName(file)!))
        {
            foreach (var piece in folder.Split('.', StringSplitOptions.RemoveEmptyEntries))
            {
                var builder = new System.Text.StringBuilder();
                foreach (var c in piece)
                {
                    builder.Append(SyntaxFacts.IsIdentifierPartCharacter(c) ? c : '_');
                }
                if (!SyntaxFacts.IsIdentifierStartCharacter(builder[0]))
                {
                    builder.Insert(0, '_');
                }
                var identifier = builder.ToString();
                if (SyntaxFacts.GetKeywordKind(identifier) != SyntaxKind.None)
                {
                    throw new ProtocolException("INVALID_NAMESPACE", $"Folder '{folder}' maps to C# keyword '{identifier}'.");
                }
                parts.Add(identifier);
            }
        }
        return string.Join('.', parts);
    }

    internal static string NamespaceName(INamespaceSymbol symbol) =>
        symbol.IsGlobalNamespace ? "" : symbol.ToDisplayString();

    private static string DisplayNamespace(string name) => name.Length == 0 ? "<global>" : name;

    internal static SyntaxTrivia EndOfLine(SyntaxNode root) =>
        SyntaxFactory.EndOfLine(root.ToFullString().Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n");

    internal static bool IsBlankTrivia(SyntaxTrivia trivia) =>
        trivia.IsKind(SyntaxKind.EndOfLineTrivia) || trivia.IsKind(SyntaxKind.WhitespaceTrivia);

    /// <summary>Removes whole blank lines at the start while keeping indentation of the first content line.</summary>
    internal static SyntaxTriviaList StripLeadingBlankLines(SyntaxTriviaList trivia)
    {
        var start = 0;
        for (var index = 0; index < trivia.Count; index++)
        {
            if (trivia[index].IsKind(SyntaxKind.EndOfLineTrivia))
            {
                start = index + 1;
            }
            else if (!trivia[index].IsKind(SyntaxKind.WhitespaceTrivia))
            {
                break;
            }
        }
        return SyntaxFactory.TriviaList(trivia.Skip(start));
    }

    /// <summary>Splits a file header (comments followed by a blank line) from trivia that belongs to a declaration.</summary>
    internal static (SyntaxTriviaList Header, SyntaxTriviaList Remainder) SplitHeader(SyntaxTriviaList trivia)
    {
        var split = -1;
        var lineIsBlank = true;
        for (var index = 0; index < trivia.Count; index++)
        {
            var item = trivia[index];
            if (item.IsKind(SyntaxKind.EndOfLineTrivia))
            {
                if (lineIsBlank && index > 0) split = index;
                lineIsBlank = true;
            }
            else if (!item.IsKind(SyntaxKind.WhitespaceTrivia))
            {
                lineIsBlank = false;
                if (item.HasStructure) lineIsBlank = true;
            }
        }
        if (split < 0 || !trivia.Take(split).Any(item => !IsBlankTrivia(item)))
        {
            return (default, trivia);
        }
        return (SyntaxFactory.TriviaList(trivia.Take(split + 1)), SyntaxFactory.TriviaList(trivia.Skip(split + 1)));
    }
}

internal sealed record DeclarationRewrite(CompilationUnitSyntax? Remaining, CompilationUnitSyntax? Created, string? CreatedPath);

/// <summary>The supported file shape: one namespace (block or file-scoped) or the global namespace, holding only types.</summary>
internal sealed class NamespaceLayout
{
    private NamespaceLayout(BaseNamespaceDeclarationSyntax? @namespace, IReadOnlyList<MemberDeclarationSyntax> types)
    {
        Namespace = @namespace;
        Types = types;
    }

    public BaseNamespaceDeclarationSyntax? Namespace { get; }
    public IReadOnlyList<MemberDeclarationSyntax> Types { get; }

    public static NamespaceLayout Analyze(CompilationUnitSyntax root)
    {
        if (root.Members.Any(member => member is GlobalStatementSyntax))
        {
            throw new ProtocolException("UNSUPPORTED_NAMESPACE_LAYOUT", "Files with top-level statements are not supported.");
        }
        var namespaces = root.DescendantNodes().OfType<BaseNamespaceDeclarationSyntax>().ToArray();
        if (namespaces.Length > 1)
        {
            throw new ProtocolException("UNSUPPORTED_NAMESPACE_LAYOUT", "Files with multiple or nested namespace declarations are not supported.");
        }
        BaseNamespaceDeclarationSyntax? @namespace = null;
        SyntaxList<MemberDeclarationSyntax> members;
        if (namespaces.Length == 1)
        {
            @namespace = namespaces[0];
            if (root.Members.Count != 1 || root.Members[0] != @namespace)
            {
                throw new ProtocolException(
                    "UNSUPPORTED_NAMESPACE_LAYOUT", "Files mixing global-namespace and namespaced declarations are not supported.");
            }
            members = @namespace.Members;
        }
        else
        {
            members = root.Members;
        }
        if (members.Any(member => member is not (BaseTypeDeclarationSyntax or DelegateDeclarationSyntax)))
        {
            throw new ProtocolException("UNSUPPORTED_NAMESPACE_LAYOUT", "The namespace contains unsupported members.");
        }
        if (members.Count == 0)
        {
            throw new ProtocolException("TYPE_NOT_FOUND", "The file declares no top-level type.");
        }
        return new NamespaceLayout(@namespace, members);
    }
}
