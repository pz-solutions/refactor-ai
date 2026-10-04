using System.Security;
using System.Xml;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;

internal static class Paths
{
    public static StringComparer Comparer { get; } =
        OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    public static bool Equal(string left, string right) =>
        Comparer.Equals(Path.GetFullPath(left), Path.GetFullPath(right));

    public static bool IsUnder(string path, string directory)
    {
        var relative = Path.GetRelativePath(directory, path);
        return !Path.IsPathFullyQualified(relative)
            && !relative.Equals("..", StringComparison.Ordinal)
            && !relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            && !relative.Equals(".", StringComparison.Ordinal);
    }

    public static string[] RelativeSegments(string directory, string path)
    {
        var relative = Path.GetRelativePath(directory, path);
        return relative == "."
            ? []
            : relative.Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
    }
}

/// <summary>Raw MSBuild project text edited with minimal, position-preserving changes.</summary>
internal sealed class ProjectFileText
{
    private ProjectFileText(string path, string body, bool hasBom)
    {
        Path = path;
        OriginalBody = body;
        Body = body;
        HasBom = hasBom;
    }

    public string Path { get; }
    public string OriginalBody { get; }
    public string Body { get; private set; }
    public bool HasBom { get; }
    public string Directory => System.IO.Path.GetDirectoryName(Path)!;
    public bool Changed => !string.Equals(OriginalBody, Body, StringComparison.Ordinal);
    public string Before => HasBom ? $"﻿{OriginalBody}" : OriginalBody;
    public string After => HasBom ? $"﻿{Body}" : Body;
    private string NewLine => Body.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";

    public static async Task<ProjectFileText> LoadAsync(string path)
    {
        var text = await Program.ReadUtf8FileAsync(path);
        return new ProjectFileText(path, text.Body, text.HasBom);
    }

    public XDocument Parse()
    {
        try
        {
            return XDocument.Parse(Body, LoadOptions.SetLineInfo | LoadOptions.PreserveWhitespace);
        }
        catch (XmlException exception)
        {
            throw new ProtocolException("UNSUPPORTED_PROJECT_FILE", $"Could not parse {Path}: {exception.Message}");
        }
    }

    public void ReplaceAttributeValue(XAttribute attribute, string value)
    {
        var start = Offset(attribute);
        var equals = Body.IndexOf('=', start);
        var quoteStart = equals < 0 ? -1 : SkipWhitespace(equals + 1);
        if (quoteStart < 0 || quoteStart >= Body.Length || (Body[quoteStart] != '"' && Body[quoteStart] != '\''))
        {
            throw Unsupported($"could not locate attribute {attribute.Name.LocalName}");
        }
        var quoteEnd = Body.IndexOf(Body[quoteStart], quoteStart + 1);
        if (quoteEnd < 0 || !string.Equals(Body[(quoteStart + 1)..quoteEnd], attribute.Value, StringComparison.Ordinal))
        {
            throw Unsupported($"attribute {attribute.Name.LocalName} uses XML escapes");
        }
        Body = Body[..(quoteStart + 1)] + SecurityElement.Escape(value) + Body[quoteEnd..];
    }

    public void RemoveElement(XElement element)
    {
        var (start, end) = ElementSpan(element);
        var lineStart = Body.LastIndexOf('\n', Math.Max(0, start - 1)) + 1;
        if (start == 0)
        {
            lineStart = 0;
        }
        var lineEnd = end;
        while (lineEnd < Body.Length && (Body[lineEnd] == ' ' || Body[lineEnd] == '\t'))
        {
            lineEnd++;
        }
        var ownLine = string.IsNullOrWhiteSpace(Body[lineStart..start])
            && (lineEnd == Body.Length || Body[lineEnd] == '\r' || Body[lineEnd] == '\n');
        if (ownLine)
        {
            if (lineEnd < Body.Length && Body[lineEnd] == '\r') lineEnd++;
            if (lineEnd < Body.Length && Body[lineEnd] == '\n') lineEnd++;
            Body = Body[..lineStart] + Body[lineEnd..];
        }
        else
        {
            Body = Body[..start] + Body[end..];
        }
    }

    /// <summary>Inserts a sibling item after an existing element, or a new ItemGroup before the project end.</summary>
    public void InsertItem(XElement? after, string itemName, string include)
    {
        var snippet = $"<{itemName} Include=\"{SecurityElement.Escape(include)}\" />";
        if (after is not null)
        {
            var (start, end) = ElementSpan(after);
            var indentation = Indentation(start);
            Body = Body[..end] + NewLine + indentation + snippet + Body[end..];
            return;
        }

        var root = Parse().Root ?? throw Unsupported("missing project root");
        var closing = Body.LastIndexOf($"</{root.Name.LocalName}>", StringComparison.Ordinal);
        if (closing < 0)
        {
            throw Unsupported("project root is not closed with an end tag");
        }
        var firstChild = root.Elements().FirstOrDefault();
        var unit = firstChild is null ? "  " : Indentation(ElementSpan(firstChild).Start);
        if (unit.Length == 0) unit = "  ";
        var lineStart = Body.LastIndexOf('\n', closing - 1) + 1;
        var insertAt = string.IsNullOrWhiteSpace(Body[lineStart..closing]) ? lineStart : closing;
        var group = $"{NewLine}{unit}<ItemGroup>{NewLine}{unit}{unit}{snippet}{NewLine}{unit}</ItemGroup>{NewLine}";
        Body = Body[..insertAt] + group + Body[insertAt..];
    }

    private string Indentation(int start)
    {
        var lineStart = Body.LastIndexOf('\n', Math.Max(0, start - 1)) + 1;
        if (start == 0) lineStart = 0;
        var prefix = Body[lineStart..start];
        return string.IsNullOrWhiteSpace(prefix) ? prefix : "";
    }

    private (int Start, int End) ElementSpan(XElement element)
    {
        var start = Offset(element) - 1;
        if (start < 0 || Body[start] != '<')
        {
            throw Unsupported($"could not locate element {element.Name.LocalName}");
        }
        var quote = '\0';
        var index = start;
        for (; index < Body.Length; index++)
        {
            var c = Body[index];
            if (quote != '\0')
            {
                if (c == quote) quote = '\0';
            }
            else if (c == '"' || c == '\'')
            {
                quote = c;
            }
            else if (c == '>')
            {
                break;
            }
        }
        if (index >= Body.Length)
        {
            throw Unsupported($"unterminated element {element.Name.LocalName}");
        }
        if (Body[index - 1] == '/')
        {
            return (start, index + 1);
        }
        var closeTag = $"</{element.Name.LocalName}";
        var close = Body.IndexOf(closeTag, index, StringComparison.Ordinal);
        var closeEnd = close < 0 ? -1 : Body.IndexOf('>', close);
        if (closeEnd < 0)
        {
            throw Unsupported($"unterminated element {element.Name.LocalName}");
        }
        return (start, closeEnd + 1);
    }

    private int Offset(IXmlLineInfo info)
    {
        if (!info.HasLineInfo())
        {
            throw Unsupported("missing XML line information");
        }
        var line = 1;
        var index = 0;
        while (line < info.LineNumber && index < Body.Length)
        {
            var c = Body[index++];
            if (c == '\n' || (c == '\r' && (index >= Body.Length || Body[index] != '\n')))
            {
                line++;
            }
        }
        return index + info.LinePosition - 1;
    }

    private int SkipWhitespace(int index)
    {
        while (index < Body.Length && char.IsWhiteSpace(Body[index])) index++;
        return index;
    }

    private ProtocolException Unsupported(string detail) =>
        new("UNSUPPORTED_PROJECT_FILE", $"{Path}: {detail}.");
}

internal enum CompileItemMode
{
    /// <summary>SDK default globbing provably matches every loaded source file.</summary>
    Glob,
    /// <summary>Every loaded source file is a literal Compile Include item.</summary>
    Explicit,
    Unknown,
}

/// <summary>
/// Decides how source files are included by an MSBuild project and plans the item edits a file
/// creation, deletion or rename requires. The decision is checked against the documents MSBuild
/// actually evaluated, so unrecognised item logic is rejected instead of guessed.
/// </summary>
internal sealed class ProjectModel
{
    private ProjectModel(ProjectFileText file, CompileItemMode mode, string reason, bool sdkStyle, bool transitive)
    {
        File = file;
        Mode = mode;
        Reason = reason;
        SdkStyle = sdkStyle;
        TransitiveReferences = transitive;
    }

    public ProjectFileText File { get; }
    public CompileItemMode Mode { get; }
    public string Reason { get; }
    public bool SdkStyle { get; }
    public bool TransitiveReferences { get; }
    public string DirectoryPath => File.Directory;

    public static ProjectModel Create(Project project, ProjectFileText file)
    {
        var root = file.Parse().Root ?? throw new ProtocolException("UNSUPPORTED_PROJECT_FILE", $"{file.Path}: missing root.");
        var sdkStyle = root.Attribute("Sdk") is not null
            || root.Elements().Any(element => element.Name.LocalName == "Sdk")
            || root.Elements().Any(element => element.Name.LocalName == "Import" && element.Attribute("Sdk") is not null);
        var enableItems = BooleanProperty(root, "EnableDefaultItems");
        var enableCompile = BooleanProperty(root, "EnableDefaultCompileItems");
        var disableTransitive = BooleanProperty(root, "DisableTransitiveProjectReferences");
        var transitive = sdkStyle && disableTransitive is { Known: true, Value: not true };

        var loaded = LoadedSources(project, file.Directory);
        var compileItems = CompileItems(root).ToArray();
        if (!enableItems.Known || !enableCompile.Known)
        {
            return new(file, CompileItemMode.Unknown, "conditional default-item properties", sdkStyle, transitive);
        }

        var defaultCompile = sdkStyle && enableItems.Value != false && enableCompile.Value != false;
        if (defaultCompile)
        {
            if (compileItems.Any(item => item.Attribute("Include") is not null || item.Attribute("Remove") is not null))
            {
                return new(file, CompileItemMode.Unknown, "Compile Include/Remove items alongside default globbing", sdkStyle, transitive);
            }
            return loaded.SetEquals(DefaultGlob(file.Directory))
                ? new(file, CompileItemMode.Glob, "SDK default Compile globbing", sdkStyle, transitive)
                : new(file, CompileItemMode.Unknown, "evaluated sources differ from SDK default globbing", sdkStyle, transitive);
        }

        var includes = new HashSet<string>(Paths.Comparer);
        foreach (var item in compileItems)
        {
            if (item.Attribute("Remove") is not null || item.Attribute("Condition") is not null
                || item.Parent?.Attribute("Condition") is not null)
            {
                return new(file, CompileItemMode.Unknown, "conditional or removed Compile items", sdkStyle, transitive);
            }
            var include = item.Attribute("Include")?.Value;
            if (include is null)
            {
                continue;
            }
            foreach (var value in include.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (!IsLiteral(value) || !includes.Add(Resolve(file.Directory, value)))
                {
                    return new(file, CompileItemMode.Unknown, "wildcard, property or duplicate Compile items", sdkStyle, transitive);
                }
            }
        }
        return loaded.SetEquals(includes)
            ? new(file, CompileItemMode.Explicit, "explicit Compile items", sdkStyle, transitive)
            : new(file, CompileItemMode.Unknown, "evaluated sources differ from literal Compile items", sdkStyle, transitive);
    }

    /// <summary>Ensures a new source file at <paramref name="path"/> will be compiled by this project.</summary>
    public void Include(string path)
    {
        switch (Mode)
        {
            case CompileItemMode.Glob:
                EnsureGlobbed(path);
                break;
            case CompileItemMode.Explicit:
                var document = File.Parse();
                var last = CompileItems(document.Root!).LastOrDefault(item => item.Attribute("Include") is not null);
                File.InsertItem(last, "Compile", RelativeInclude(path, last?.Attribute("Include")?.Value));
                break;
            default:
                throw UnsupportedItems();
        }
    }

    /// <summary>Ensures a deleted source file is no longer referenced by this project.</summary>
    public void Exclude(string path)
    {
        switch (Mode)
        {
            case CompileItemMode.Glob:
                break;
            case CompileItemMode.Explicit:
                File.RemoveElement(FindLiteralItem(path));
                break;
            default:
                throw UnsupportedItems();
        }
    }

    public void Rename(string oldPath, string newPath)
    {
        switch (Mode)
        {
            case CompileItemMode.Glob:
                EnsureGlobbed(newPath);
                break;
            case CompileItemMode.Explicit:
                var item = FindLiteralItem(oldPath);
                var attribute = item.Attribute("Include")!;
                File.ReplaceAttributeValue(attribute, RelativeInclude(newPath, attribute.Value));
                break;
            default:
                throw UnsupportedItems();
        }
    }

    public void AddProjectReference(string projectPath)
    {
        var root = File.Parse().Root!;
        var references = root.Elements().Where(element => element.Name.LocalName == "ItemGroup")
            .SelectMany(group => group.Elements().Where(element => element.Name.LocalName == "ProjectReference"))
            .ToArray();
        static bool Unconditional(XElement reference) => reference.Attribute("Condition") is null
            && reference.Parent?.Attribute("Condition") is null;
        if (references.Any(reference => Unconditional(reference) && reference.Attribute("Include")?.Value is { } include
                && IsLiteral(include) && Paths.Equal(Resolve(File.Directory, include), projectPath)))
        {
            return;
        }
        var last = references.LastOrDefault(reference => Unconditional(reference) && reference.Attribute("Include") is not null);
        File.InsertItem(last, "ProjectReference", RelativeInclude(projectPath, last?.Attribute("Include")?.Value));
    }

    private void EnsureGlobbed(string path)
    {
        var segments = Paths.IsUnder(path, File.Directory) ? Paths.RelativeSegments(File.Directory, path) : [];
        if (segments.Length == 0
            || !path.EndsWith(".cs", StringComparison.Ordinal)
            || (segments.Length > 1 && IsDefaultExcludedRoot(segments[0]))
            || segments[..^1].Any(segment => segment.StartsWith('.')))
        {
            throw new ProtocolException(
                "UNSUPPORTED_PROJECT_ITEMS",
                $"{path} would not be included by the default Compile glob of {File.Path}.");
        }
    }

    private XElement FindLiteralItem(string path)
    {
        var matches = CompileItems(File.Parse().Root!)
            .Where(item => item.Attribute("Include")?.Value is { } include
                && IsLiteral(include) && Paths.Equal(Resolve(File.Directory, include.Trim()), path))
            .ToArray();
        if (matches.Length != 1 || matches[0].Attribute("Include")!.Value.Contains(';')
            || matches[0].Elements().Any(child => child.Name.LocalName == "Link"))
        {
            throw new ProtocolException(
                "UNSUPPORTED_PROJECT_ITEMS",
                $"{path} is not a single literal Compile item in {File.Path}.");
        }
        return matches[0];
    }

    private string RelativeInclude(string path, string? styleSample)
    {
        var relative = Path.GetRelativePath(File.Directory, path);
        var separator = styleSample is not null && styleSample.Contains('/') && !styleSample.Contains('\\') ? '/' : '\\';
        return relative.Replace(Path.DirectorySeparatorChar, separator).Replace(Path.AltDirectorySeparatorChar, separator);
    }

    private ProtocolException UnsupportedItems() =>
        new("UNSUPPORTED_PROJECT_ITEMS", $"Cannot safely plan Compile item changes for {File.Path}: {Reason}.");

    private static IEnumerable<XElement> CompileItems(XElement root) =>
        root.Elements().Where(element => element.Name.LocalName == "ItemGroup")
            .SelectMany(group => group.Elements().Where(element => element.Name.LocalName == "Compile"));

    private static (bool Known, bool? Value) BooleanProperty(XElement root, string name)
    {
        bool? value = null;
        foreach (var group in root.Elements().Where(element => element.Name.LocalName == "PropertyGroup"))
        {
            foreach (var property in group.Elements().Where(element => element.Name.LocalName == name))
            {
                if (group.Attribute("Condition") is not null || property.Attribute("Condition") is not null
                    || property.Value.Contains("$(", StringComparison.Ordinal))
                {
                    return (false, null);
                }
                value = bool.TryParse(property.Value.Trim(), out var parsed) ? parsed : null;
            }
        }
        return (true, value);
    }

    private static HashSet<string> LoadedSources(Project project, string directory)
    {
        var obj = Path.Combine(directory, "obj");
        var bin = Path.Combine(directory, "bin");
        return project.Documents
            .Select(document => document.FilePath)
            .OfType<string>()
            .Select(path => Path.GetFullPath(path))
            .Where(path => !Paths.IsUnder(path, obj) && !Paths.IsUnder(path, bin))
            .ToHashSet(Paths.Comparer);
    }

    private static HashSet<string> DefaultGlob(string directory)
    {
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            AttributesToSkip = 0,
            MatchCasing = MatchCasing.PlatformDefault,
        };
        return Directory.EnumerateFiles(directory, "*.cs", options)
            .Select(path => Path.GetFullPath(path))
            .Where(path =>
            {
                var segments = Paths.RelativeSegments(directory, path);
                return !(segments.Length > 1 && IsDefaultExcludedRoot(segments[0]))
                    && !segments[..^1].Any(segment => segment.StartsWith('.'));
            })
            .ToHashSet(Paths.Comparer);
    }

    private static bool IsDefaultExcludedRoot(string segment) =>
        segment.Equals("bin", StringComparison.OrdinalIgnoreCase) || segment.Equals("obj", StringComparison.OrdinalIgnoreCase);

    private static bool IsLiteral(string include) =>
        include.IndexOfAny(['*', '?']) < 0
        && !include.Contains("$(", StringComparison.Ordinal)
        && !include.Contains("@(", StringComparison.Ordinal)
        && !include.Contains("%(", StringComparison.Ordinal);

    private static string Resolve(string directory, string include) =>
        Path.GetFullPath(Path.Combine(directory, include.Trim()
            .Replace('\\', Path.DirectorySeparatorChar)
            .Replace('/', Path.DirectorySeparatorChar)));
}
