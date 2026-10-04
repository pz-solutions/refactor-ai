import { helpRequested, renderHelp } from "./help.ts";
import type { Operation } from "./types.ts";

export interface NpmCliOptions {
  packageName: string;
  packageRoot: string;
  operation?: Operation;
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
      const csharp = options.operation !== "extract-function" && options.operation !== "extract-variable";
      const runtimeRequirements = `Requirements:\n  Node.js 22+ and npm. The package includes the built Node runner and npm installs\n  its pinned TypeScript runtime dependency. No checkout or Bun is required.\n${csharp ? "  C#: .NET 8 SDK (dotnet in PATH), the project's SDK/workloads and restored project\n  dependencies. The bundled Roslyn helper builds on first C# use; initial NuGet\n  restore needs network access and a writable npm package/cache directory.\n" : "  This operation supports TypeScript and JavaScript; .NET is unnecessary.\n"}  Help does not load a project or build the helper.\n`;
      let help = renderHelp(helpArgs, invocation, runtimeRequirements);
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
    const { main } = await import("./cli.ts");
    await main(normalized, { invocation, operation: options.operation });
  } catch (error) {
    console.error(JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
