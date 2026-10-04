internal static class HelperHelp
{
    public const string Text = """
        RefactorHelper — read-only Roslyn 4.12.0 JSON adapter for refactor-ai

        Usage:
          dotnet /path/to/RefactorHelper.dll < request.json
          dotnet /path/to/RefactorHelper.dll --help

        Options:
          --help, -h   Show this help without reading stdin or loading a project.
          help         Alias for --help.

        This helper computes changes in memory and returns JSON. Use the Node CLI
        for plan, preview, validate and apply; the helper never applies source edits.
        Supply one JSON object on stdin, not command-line refactoring flags.

        Required request fields (camelCase):
          project       Absolute path to a restored .csproj or .sln.
          root          Absolute common directory covering all loaded projects/files.
          file          Absolute source file path, unambiguously owned by a project.
          operation     rename, imports, format, rename-file, sync-namespace or move-type.

        Operation fields:
          rename         position: zero-based UTF-16 offset; newName: new identifier.
                         Comments and strings are excluded; references are semantic.
          imports        mode: "remove-unused" (required). Sorting is unsupported.
          format         No extra fields; uses Roslyn document formatting options.
          rename-file    typeName or position when several top-level types exist;
                         otherwise selects the only type. Retains source text/BOM
                         and updates supported explicit Compile entries.
          sync-namespace Optional rootNamespace override (dotted namespace).
                         Derives namespace from project RootNamespace and folders;
                         updates the selected file's types and semantic references.
          move-type      target: absolute NEW .cs file path (required).
                         Optional targetProject: absolute loaded destination .csproj;
                         otherwise chooses the deepest loaded project folder.
                         Optional typeName or position for selection; optional
                         rootNamespace for the destination convention. Missing target
                         folders are allowed and created by Node apply. Keeps other
                         declarations and plans required Compile/ProjectReference edits.

        The helper's position is a zero-based UTF-16 OFFSET, unlike the Node CLI's
        1-based line:column. In "public class Widget { }", Widget starts at offset 13.
        Source, project and destination paths must stay inside root. Use a .sln to
        include dependent projects; a .csproj cannot discover every external caller.
        Moves change assembly identity. External API consumers, reflection and
        assembly-qualified names need separate verification. Cycles, inaccessible
        symbols, unknown project-item rules, conditional compilation, nested/multiple
        namespaces and partial types spread across files can cause rejection.

        Examples (replace /workspace paths with existing, restored projects):
          printf '%s' '{"project":"/workspace/App/App.csproj","root":"/workspace","file":"/workspace/App/Widget.cs","operation":"rename","position":13,"newName":"Gadget"}' | dotnet /path/to/RefactorHelper.dll
          printf '%s' '{"project":"/workspace/App/App.csproj","root":"/workspace","file":"/workspace/App/Widget.cs","operation":"imports","mode":"remove-unused"}' | dotnet /path/to/RefactorHelper.dll
          printf '%s' '{"project":"/workspace/Workspace.sln","root":"/workspace","file":"/workspace/App/Widget.cs","operation":"move-type","typeName":"Widget","target":"/workspace/Library/Models/Widget.cs","targetProject":"/workspace/Library/Library.csproj"}' | dotnet /path/to/RefactorHelper.dll

        Output:
          Success: {"result":{backend,version,changes,diagnosticsBefore,diagnosticsAfter,notes}}
          Each change has path, before and after; before:null creates, after:null
          deletes. Project-file edits are ordinary changes. Nothing is written.
          Failure: {"error":{"code":"...","message":"..."}} on stdout;
          load diagnostics/exception details may also appear on stderr.
          Exit 0: success or help; exit 2: invalid/unsupported/conflicting request;
          exit 1: unexpected helper failure.

        Requirements:
          .NET 8 SDK, restored project dependencies and the project's required
          SDK/workloads. Initial NuGet restore needs network access.
          Build: dotnet build dotnet/RefactorHelper/RefactorHelper.csproj -c Release
        """ + "\n";
}
