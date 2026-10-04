import { helpRequested, renderHelp } from "./help.ts";
import type { BackendLoader, Operation } from "./types.ts";
import type { Language } from "./languages.ts";
import { runCli } from "./cli-core.ts";

export interface NpmCliOptions {
  packageName: string;
  packageRoot: string;
  operation?: Operation;
  language?: Language;
  loadBackend: BackendLoader;
}

/** Answer help before invoking a refactoring engine or building the .NET helper. */
export async function runNpmCli(args: string[], options: NpmCliOptions): Promise<void> {
  try {
    if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("UNSUPPORTED_RUNTIME: Node.js 22+ is required");
    const invocation = `npx ${options.packageName}`;
    if (helpRequested(args)) {
      const topics = args[0] === "help" ? args.slice(1) : args;
      const command = topics[0]?.startsWith("-") ? undefined : topics[0];
      const helpArgs = options.operation && (!command || command === "plan")
        ? ["plan", options.operation, "--help"] : args;
      if (options.operation && command === "plan" && topics[1] && !topics[1].startsWith("-") && topics[1] !== options.operation) {
        throw new Error(`UNSUPPORTED: this tool only supports ${options.operation}`);
      }
      const typescript = options.language !== "csharp";
      const csharp = options.language !== "typescript";
      const runtimeRequirements = `Requirements:\n  Node.js 22+ and npm. The package includes its built Node runner.\n${typescript ? "  npm installs the pinned TypeScript compiler dependency for TS/JS operations.\n" : ""}${csharp ? "  C#: .NET 8 SDK (dotnet in PATH), the project's SDK/workloads and restored project\n  dependencies. The bundled Roslyn helper builds on first C# use; initial NuGet\n  restore needs network access and a writable npm package/cache directory.\n" : ""}  No checkout or Bun is required. Help does not load projects or build helpers.\n`;
      let help = renderHelp(helpArgs, invocation, runtimeRequirements, options.language);
      if (options.operation) {
        help = help.split(`${invocation} plan ${options.operation}`).join(`${invocation} plan`);
        help += `\nThis package plans only ${options.operation}. Commands: plan, capabilities, preview,\nvalidate and apply. Use ${invocation} <command> --help for command help.\n`;
      }
      process.stdout.write(help);
      return;
    }
    const normalized = [...args];
    if (options.operation && normalized[0] === "plan") {
      if (!normalized[1] || normalized[1].startsWith("-")) normalized.splice(1, 0, options.operation);
      else if (normalized[1] !== options.operation) throw new Error(`UNSUPPORTED: this tool only supports ${options.operation}`);
    }
    process.env.REFACTOR_AI_HOME = options.packageRoot;
    await runCli(normalized, { invocation, operation: options.operation, language: options.language, loadBackend: options.loadBackend });
  } catch (error) {
    console.error(JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
