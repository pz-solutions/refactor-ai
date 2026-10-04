using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text;
using Microsoft.Build.Locator;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;
using Microsoft.CodeAnalysis.Formatting;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Rename;

internal static class Program
{
    private const string BackendName = "roslyn";
    private const string BackendVersion = "4.12.0";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static async Task<int> Main(string[] args)
    {
        try
        {
            if (args.Any(arg => arg is "--help" or "-h") || args.FirstOrDefault() == "help")
            {
                await Console.Out.WriteAsync(HelperHelp.Text);
                return 0;
            }
            if (args.Length > 0)
            {
                throw new ProtocolException("INVALID_ARGUMENT", "The helper accepts a JSON request on stdin or --help.");
            }
            var input = await Console.In.ReadToEndAsync();
            var request = JsonSerializer.Deserialize<Request>(input, JsonOptions)
                ?? throw new ProtocolException("INVALID_REQUEST", "Expected a JSON request.");

            ValidateRequest(request);
            MSBuildLocator.RegisterDefaults();
            var result = await AnalyzeAsync(request);
            await Console.Out.WriteAsync(JsonSerializer.Serialize(new Response(Result: result), JsonOptions));
            return 0;
        }
        catch (ProtocolException exception)
        {
            await Console.Out.WriteAsync(JsonSerializer.Serialize(
                new Response(Error: new ErrorResponse(exception.Code, exception.Message)), JsonOptions));
            return 2;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(exception);
            await Console.Out.WriteAsync(JsonSerializer.Serialize(
                new Response(Error: new ErrorResponse("HELPER_ERROR", exception.Message)), JsonOptions));
            return 1;
        }
    }

    private static async Task<Result> AnalyzeAsync(Request request)
    {
        using var workspace = MSBuildWorkspace.Create();
        var workspaceNotes = new List<string>();
        var workspaceFailures = new List<string>();
        workspace.WorkspaceFailed += (_, args) =>
        {
            var note = $"MSBuildWorkspace {args.Diagnostic.Kind}: {args.Diagnostic.Message}";
            workspaceNotes.Add(note);
            if (args.Diagnostic.Kind == WorkspaceDiagnosticKind.Failure)
            {
                workspaceFailures.Add(note);
            }
            Console.Error.WriteLine(note);
        };

        var solution = await OpenAsync(workspace, request.Project);
        ThrowIfWorkspaceFailed(workspaceFailures);
        ValidateLoadedScope(solution, request.Root);
        var document = FindDocument(solution, request.File);
        var diagnosticsBefore = await GetErrorDiagnosticsAsync(solution);
        ThrowIfWorkspaceFailed(workspaceFailures);

        Solution changedSolution;
        OperationOutcome? outcome = null;
        var notes = new List<string>(workspaceNotes);
        switch (request.Operation)
        {
            case "rename-file":
                outcome = await FileOperations.RenameFileAsync(solution, document, request);
                changedSolution = outcome.Solution;
                break;
            case "sync-namespace":
                outcome = await FileOperations.SyncNamespaceAsync(solution, document, request);
                changedSolution = outcome.Solution;
                break;
            case "move-type":
                outcome = await FileOperations.MoveTypeAsync(solution, document, request);
                changedSolution = outcome.Solution;
                break;
            case "rename":
                changedSolution = await RenameAsync(solution, document, request);
                notes.Add("Renamed with Roslyn semantic symbol resolution; comments and strings were not renamed.");
                break;
            case "format":
                changedSolution = await FormatAsync(solution, document);
                notes.Add("Formatted the selected document with the public Roslyn Formatter API.");
                break;
            case "imports" when request.Mode == "remove-unused":
                changedSolution = await RemoveUnusedImportsAsync(solution, document);
                notes.Add("Removed unused imports identified by Roslyn compiler diagnostic CS8019.");
                break;
            case "imports":
                throw new ProtocolException("UNSUPPORTED_OPERATION", "C# import sorting is not supported safely.");
            case "extract-function" or "extract-variable":
                throw new ProtocolException("UNSUPPORTED_OPERATION", $"C# operation '{request.Operation}' is not supported.");
            default:
                throw new ProtocolException("UNSUPPORTED_OPERATION", $"Unknown operation '{request.Operation}'.");
        }

        ThrowIfWorkspaceFailed(workspaceFailures);
        var diagnosticsAfter = await GetErrorDiagnosticsAsync(changedSolution);
        ThrowIfWorkspaceFailed(workspaceFailures);
        if (request.Operation == "rename" && IntroducesErrors(diagnosticsBefore, diagnosticsAfter))
        {
            throw new ProtocolException("RENAME_CONFLICT", "Rename introduced compilation errors; no changes were returned.");
        }
        if (outcome is not null && IntroducesErrors(diagnosticsBefore, diagnosticsAfter))
        {
            var added = NewDiagnostics(diagnosticsBefore, diagnosticsAfter)
                .Take(5)
                .Select(diagnostic => $"{diagnostic.File}: {diagnostic.Code} {diagnostic.Message}");
            throw new ProtocolException(
                outcome.ConflictCode,
                $"The {request.Operation} change would introduce compilation errors; no changes were returned. {string.Join("; ", added)}");
        }
        if (outcome is not null)
        {
            notes.AddRange(outcome.Notes);
        }

        var changes = await GetChangesAsync(solution, changedSolution, request.Root, outcome);
        return new Result(
            BackendName,
            BackendVersion,
            changes,
            diagnosticsBefore,
            diagnosticsAfter,
            notes.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray());
    }

    private static void ThrowIfWorkspaceFailed(IReadOnlyCollection<string> failures)
    {
        if (failures.Count > 0)
        {
            throw new ProtocolException("PROJECT_LOAD_FAILED", string.Join(Environment.NewLine, failures));
        }
    }

    private static void ValidateLoadedScope(Solution solution, string root)
    {
        foreach (var project in solution.Projects)
        {
            if (project.FilePath is null)
            {
                throw new ProtocolException(
                    "PROJECT_SCOPE_INCOMPLETE", $"Loaded project has no file path: {project.Name}");
            }
            EnsureWithinRoot(root, Path.GetFullPath(project.FilePath), "loaded project");

            foreach (var document in project.Documents)
            {
                if (document.FilePath is null)
                {
                    throw new ProtocolException(
                        "PROJECT_SCOPE_INCOMPLETE", $"Source document has no file path: {document.Name}");
                }
                EnsureWithinRoot(root, Path.GetFullPath(document.FilePath), "source document");
            }
        }
    }

    private static async Task<Solution> OpenAsync(MSBuildWorkspace workspace, string projectPath)
    {
        try
        {
            return Path.GetExtension(projectPath).Equals(".sln", StringComparison.OrdinalIgnoreCase)
                ? await workspace.OpenSolutionAsync(projectPath)
                : (await workspace.OpenProjectAsync(projectPath)).Solution;
        }
        catch (Exception exception)
        {
            throw new ProtocolException("PROJECT_LOAD_FAILED", exception.Message);
        }
    }

    private static Document FindDocument(Solution solution, string filePath)
    {
        var fullPath = Path.GetFullPath(filePath);
        var documents = solution.Projects
            .SelectMany(project => project.Documents)
            .Where(document => document.FilePath is not null && PathsEqual(document.FilePath, fullPath))
            .ToArray();

        return documents.Length switch
        {
            1 => documents[0],
            0 => throw new ProtocolException("FILE_NOT_IN_PROJECT", $"File is not part of the loaded project: {fullPath}"),
            _ => throw new ProtocolException("AMBIGUOUS_FILE", $"File is linked by multiple loaded projects: {fullPath}"),
        };
    }

    private static async Task<Solution> RenameAsync(Solution solution, Document document, Request request)
    {
        if (request.Position is null || string.IsNullOrWhiteSpace(request.NewName))
        {
            throw new ProtocolException("INVALID_REQUEST", "Rename requires position and newName.");
        }

        var position = await ResolvePositionAsync(document, request.File, request.Position.Value);
        var symbol = await SymbolFinder.FindSymbolAtPositionAsync(document, position)
            ?? throw new ProtocolException("SYMBOL_NOT_FOUND", "No renameable symbol exists at the requested position.");

        if (!SyntaxFacts.IsValidIdentifier(request.NewName))
        {
            throw new ProtocolException("INVALID_NAME", $"'{request.NewName}' is not a valid C# identifier.");
        }

        try
        {
            var options = new SymbolRenameOptions(
                RenameOverloads: false,
                RenameInStrings: false,
                RenameInComments: false,
                RenameFile: false);
            return await Renamer.RenameSymbolAsync(solution, symbol, options, request.NewName, CancellationToken.None);
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException)
        {
            throw new ProtocolException("RENAME_FAILED", exception.Message);
        }
    }

    /// <summary>Maps a UTF-16 offset in the on-disk text (including any BOM) to a Roslyn document position.</summary>
    internal static async Task<int> ResolvePositionAsync(Document document, string file, int requested)
    {
        var text = await document.GetTextAsync();
        var diskText = await ReadUtf8FileAsync(file);
        var offsetAdjustment = diskText.HasBom && (text.Length == 0 || text[0] != '﻿') ? 1 : 0;
        var position = requested - offsetAdjustment;
        if (position < 0 || position > text.Length)
        {
            throw new ProtocolException("INVALID_POSITION", "Position is outside the file.");
        }
        return position == text.Length && text.Length > 0 ? text.Length - 1 : position;
    }

    private static async Task<Solution> FormatAsync(Solution solution, Document document)
    {
        var formatted = await Formatter.FormatAsync(document);
        return formatted.Project.Solution;
    }

    private static async Task<Solution> RemoveUnusedImportsAsync(Solution solution, Document document)
    {
        var root = await document.GetSyntaxRootAsync()
            ?? throw new ProtocolException("IMPORTS_FAILED", "Could not read the C# syntax tree.");
        var semanticModel = await document.GetSemanticModelAsync()
            ?? throw new ProtocolException("IMPORTS_FAILED", "Could not create the C# semantic model.");
        var unusedImports = semanticModel.GetDiagnostics()
            .Where(diagnostic => diagnostic.Id == "CS8019" && diagnostic.Location.IsInSource)
            .Select(diagnostic => root.FindNode(diagnostic.Location.SourceSpan, getInnermostNodeForTie: true)
                .FirstAncestorOrSelf<UsingDirectiveSyntax>())
            .Where(node => node is not null)
            .Distinct()
            .Cast<UsingDirectiveSyntax>()
            .ToArray();

        if (unusedImports.Length == 0)
        {
            return solution;
        }

        var changedRoot = root.RemoveNodes(unusedImports, SyntaxRemoveOptions.KeepExteriorTrivia)
            ?? throw new ProtocolException("IMPORTS_FAILED", "Roslyn could not remove unused imports.");
        return document.WithSyntaxRoot(changedRoot).Project.Solution;
    }

    private static async Task<DiagnosticResponse[]> GetErrorDiagnosticsAsync(Solution solution)
    {
        var diagnostics = new List<DiagnosticResponse>();
        foreach (var project in solution.Projects.OrderBy(project => project.FilePath, StringComparer.Ordinal))
        {
            var compilation = await project.GetCompilationAsync();
            if (compilation is null)
            {
                throw new ProtocolException(
                    "PROJECT_LOAD_FAILED", $"Roslyn could not create a compilation for project: {project.Name}");
            }

            foreach (var diagnostic in compilation.GetDiagnostics().Where(item => item.Severity == DiagnosticSeverity.Error))
            {
                var file = diagnostic.Location.IsInSource
                    ? diagnostic.Location.SourceTree?.FilePath
                    : project.FilePath;
                diagnostics.Add(new DiagnosticResponse(
                    Path.GetFullPath(file ?? project.Name),
                    diagnostic.Id,
                    diagnostic.GetMessage()));
            }
        }

        return diagnostics
            .OrderBy(item => item.File, StringComparer.Ordinal)
            .ThenBy(item => item.Code, StringComparer.Ordinal)
            .ThenBy(item => item.Message, StringComparer.Ordinal)
            .ToArray();
    }

    private static bool IntroducesErrors(
        IReadOnlyCollection<DiagnosticResponse> before,
        IReadOnlyCollection<DiagnosticResponse> after) => NewDiagnostics(before, after).Any();

    private static IEnumerable<DiagnosticResponse> NewDiagnostics(
        IReadOnlyCollection<DiagnosticResponse> before,
        IReadOnlyCollection<DiagnosticResponse> after)
    {
        var counts = before
            .GroupBy(DiagnosticKey)
            .ToDictionary(group => group.Key, group => group.Count(), StringComparer.Ordinal);
        foreach (var diagnostic in after)
        {
            var key = DiagnosticKey(diagnostic);
            if (!counts.TryGetValue(key, out var count) || count == 0)
            {
                yield return diagnostic;
                continue;
            }
            counts[key] = count - 1;
        }
    }

    private static string DiagnosticKey(DiagnosticResponse diagnostic) =>
        $"{diagnostic.File}\0{diagnostic.Code}\0{diagnostic.Message}";

    private static async Task<FileChange[]> GetChangesAsync(
        Solution before, Solution after, string root, OperationOutcome? outcome)
    {
        var changes = new List<FileChange>();
        var changedPaths = new HashSet<string>(Paths.Comparer);
        void Add(FileChange change)
        {
            EnsureWithinRoot(root, change.Path, "changed file");
            if (!changedPaths.Add(change.Path))
            {
                throw new ProtocolException(
                    "AMBIGUOUS_CHANGE", $"Roslyn changed a source file linked by multiple projects: {change.Path}");
            }
            changes.Add(change);
        }

        var solutionChanges = after.GetChanges(before);
        if (solutionChanges.GetAddedProjects().Any() || solutionChanges.GetRemovedProjects().Any())
        {
            throw new ProtocolException("UNSAFE_CHANGE", "Roslyn attempted to add or remove a project.");
        }
        var projectChanges = solutionChanges.GetProjectChanges().ToArray();
        foreach (var documentId in projectChanges.SelectMany(change => change.GetChangedDocuments()).Distinct())
        {
            var oldDocument = before.GetDocument(documentId)!;
            var newDocument = after.GetDocument(documentId)!;
            var path = DocumentPath(oldDocument);
            var oldText = (await oldDocument.GetTextAsync()).ToString();
            var newText = (await newDocument.GetTextAsync()).ToString();
            if (string.Equals(oldText, newText, StringComparison.Ordinal))
            {
                continue;
            }
            var diskText = await ReadLoadedSourceAsync(path, oldText);
            if (diskText.HasBom && newText.StartsWith('\uFEFF'))
            {
                newText = newText[1..];
            }
            Add(new FileChange(path, WithBom(diskText.Body, diskText.HasBom), WithBom(newText, diskText.HasBom)));
        }

        var removed = projectChanges.SelectMany(change => change.GetRemovedDocuments()).Distinct().ToArray();
        var added = projectChanges.SelectMany(change => change.GetAddedDocuments()).Distinct().ToArray();
        if (outcome is null && (removed.Length > 0 || added.Length > 0))
        {
            throw new ProtocolException("UNSAFE_CHANGE", "Roslyn attempted to add or remove a document.");
        }
        foreach (var documentId in removed)
        {
            var oldDocument = before.GetDocument(documentId)!;
            var path = DocumentPath(oldDocument);
            var diskText = await ReadLoadedSourceAsync(path, (await oldDocument.GetTextAsync()).ToString());
            Add(new FileChange(path, WithBom(diskText.Body, diskText.HasBom), null));
        }
        foreach (var documentId in added)
        {
            var newDocument = after.GetDocument(documentId)!;
            var path = DocumentPath(newDocument);
            if (File.Exists(path) || Directory.Exists(path))
            {
                throw new ProtocolException("TARGET_EXISTS", $"Target already exists: {path}");
            }
            var newText = (await newDocument.GetTextAsync()).ToString().TrimStart('\uFEFF');
            var hasBom = outcome!.NewDocumentBom.TryGetValue(path, out var bom) && bom;
            Add(new FileChange(path, null, WithBom(newText, hasBom)));
        }

        foreach (var project in (outcome?.Projects.Values.AsEnumerable() ?? []).Where(project => project.File.Changed))
        {
            var current = await ReadUtf8FileAsync(project.File.Path);
            if (!string.Equals(current.Body, project.File.OriginalBody, StringComparison.Ordinal))
            {
                throw new ProtocolException("SOURCE_CHANGED", $"Project file changed during planning: {project.File.Path}");
            }
            Add(new FileChange(Path.GetFullPath(project.File.Path), project.File.Before, project.File.After));
        }

        return changes.OrderBy(change => change.Path, StringComparer.Ordinal).ToArray();
    }

    private static string DocumentPath(Document document) => document.FilePath is null
        ? throw new ProtocolException("UNSAFE_CHANGE", "Roslyn changed a document without a path.")
        : Path.GetFullPath(document.FilePath);

    private static string WithBom(string text, bool hasBom) => hasBom ? $"\uFEFF{text}" : text;

    /// <summary>Reads a source file and proves the loaded Roslyn text is what is on disk.</summary>
    private static async Task<Utf8FileText> ReadLoadedSourceAsync(string path, string loadedText)
    {
        var diskText = await ReadUtf8FileAsync(path);
        if (!string.Equals(loadedText, diskText.Body, StringComparison.Ordinal)
            && !(diskText.HasBom && string.Equals(loadedText, $"\uFEFF{diskText.Body}", StringComparison.Ordinal)))
        {
            throw new ProtocolException(
                "SOURCE_CHANGED", $"Loaded source does not match the current UTF-8 file: {path}");
        }
        return diskText;
    }

    internal static async Task<Utf8FileText> ReadUtf8FileAsync(string path)
    {
        var bytes = await File.ReadAllBytesAsync(path);
        if ((bytes.Length >= 4 && bytes[0] == 0xFF && bytes[1] == 0xFE && bytes[2] == 0x00 && bytes[3] == 0x00)
            || (bytes.Length >= 4 && bytes[0] == 0x00 && bytes[1] == 0x00 && bytes[2] == 0xFE && bytes[3] == 0xFF)
            || (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
            || (bytes.Length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF))
        {
            throw new ProtocolException("UNSUPPORTED_ENCODING", $"Only UTF-8 C# source files are supported: {path}");
        }

        var hasBom = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF;
        try
        {
            var utf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);
            return new Utf8FileText(utf8.GetString(bytes, hasBom ? 3 : 0, bytes.Length - (hasBom ? 3 : 0)), hasBom);
        }
        catch (DecoderFallbackException)
        {
            throw new ProtocolException("UNSUPPORTED_ENCODING", $"Only valid UTF-8 C# source files are supported: {path}");
        }
    }

    private static void ValidateRequest(Request request)
    {
        if (string.IsNullOrWhiteSpace(request.Root) || !Path.IsPathFullyQualified(request.Root))
        {
            throw new ProtocolException("INVALID_REQUEST", "root must be an absolute path.");
        }
        if (string.IsNullOrWhiteSpace(request.Project) || !Path.IsPathFullyQualified(request.Project))
        {
            throw new ProtocolException("INVALID_REQUEST", "project must be an absolute path.");
        }
        if (string.IsNullOrWhiteSpace(request.File) || !Path.IsPathFullyQualified(request.File))
        {
            throw new ProtocolException("INVALID_REQUEST", "file must be an absolute path.");
        }

        request.Root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(request.Root));
        request.Project = Path.GetFullPath(request.Project);
        request.File = Path.GetFullPath(request.File);
        EnsureWithinRoot(request.Root, request.Project, "project");
        EnsureWithinRoot(request.Root, request.File, "file");

        if (!Directory.Exists(request.Root) || !File.Exists(request.Project) || !File.Exists(request.File))
        {
            throw new ProtocolException("INVALID_REQUEST", "root, project, and file must exist.");
        }
        var extension = Path.GetExtension(request.Project);
        if (!extension.Equals(".sln", StringComparison.OrdinalIgnoreCase)
            && !extension.Equals(".csproj", StringComparison.OrdinalIgnoreCase))
        {
            throw new ProtocolException("INVALID_REQUEST", "project must be a .sln or .csproj file.");
        }

        if (request.Target is not null)
        {
            if (!Path.IsPathFullyQualified(request.Target))
            {
                throw new ProtocolException("INVALID_REQUEST", "target must be an absolute path.");
            }
            request.Target = Path.GetFullPath(request.Target);
            EnsureWithinRoot(request.Root, request.Target, "target");
        }
        if (request.TargetProject is not null)
        {
            if (!Path.IsPathFullyQualified(request.TargetProject))
            {
                throw new ProtocolException("INVALID_REQUEST", "targetProject must be an absolute path.");
            }
            request.TargetProject = Path.GetFullPath(request.TargetProject);
            EnsureWithinRoot(request.Root, request.TargetProject, "targetProject");
            if (!File.Exists(request.TargetProject)
                || !Path.GetExtension(request.TargetProject).Equals(".csproj", StringComparison.OrdinalIgnoreCase))
            {
                throw new ProtocolException("INVALID_REQUEST", "targetProject must be an existing .csproj file.");
            }
        }
        if (request.TypeName is not null && !SyntaxFacts.IsValidIdentifier(request.TypeName))
        {
            throw new ProtocolException("INVALID_REQUEST", $"typeName '{request.TypeName}' is not a valid C# identifier.");
        }
        if (request.Operation == "move-type")
        {
            if (request.Target is null || !request.Target.EndsWith(".cs", StringComparison.Ordinal))
            {
                throw new ProtocolException("INVALID_REQUEST", "move-type requires an absolute target .cs file path.");
            }
        }
        else if (request.Target is not null || request.TargetProject is not null)
        {
            throw new ProtocolException("INVALID_REQUEST", "target and targetProject are only valid for move-type.");
        }
    }

    internal static void EnsureWithinRoot(string root, string path, string label)
    {
        var relative = Path.GetRelativePath(root, path);
        if (Path.IsPathFullyQualified(relative)
            || relative.Equals("..", StringComparison.Ordinal)
            || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
        {
            throw new ProtocolException("OUTSIDE_ROOT", $"{label} is outside root: {path}");
        }
    }

    private static bool PathsEqual(string left, string right) =>
        string.Equals(Path.GetFullPath(left), Path.GetFullPath(right),
            OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
}

internal sealed record Request
{
    public required string Project { get; set; }
    public required string Root { get; set; }
    public required string File { get; set; }
    public required string Operation { get; init; }
    public int? Position { get; init; }
    public int? End { get; init; }
    public string? NewName { get; init; }
    public string? Mode { get; init; }
    public string? Target { get; set; }
    public string? TargetProject { get; set; }
    public string? TypeName { get; init; }
    public string? RootNamespace { get; init; }
}

internal sealed record Response(Result? Result = null, ErrorResponse? Error = null);
internal sealed record ErrorResponse(string Code, string Message);
internal sealed record Result(
    string Backend,
    string Version,
    FileChange[] Changes,
    DiagnosticResponse[] DiagnosticsBefore,
    DiagnosticResponse[] DiagnosticsAfter,
    string[] Notes);
/// <summary>Before null creates a file; After null deletes it. Nulls are serialized explicitly.</summary>
internal sealed record FileChange(
    string Path,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Before,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? After);
internal sealed record DiagnosticResponse(string File, string Code, string Message);
internal sealed record Utf8FileText(string Body, bool HasBom);

internal sealed class ProtocolException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
