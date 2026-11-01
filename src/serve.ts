import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { runCli, type CliContext } from "./cli-core";
import { setWarmMode } from "./backends/typescript";

/** Sequential NDJSON plan requests over stdio. EOF releases all retained programs. */
export async function serve(args: string[], context: CliContext): Promise<void> {
  if (args.length !== 2 || args[0] !== "--root") throw new Error("INVALID_ARGUMENT: serve --root <repo>; send NDJSON {id,args:[\"plan\",...]}");
  const root = realpathSync(resolve(args[1]!));
  process.chdir(root);
  setWarmMode(true);
  try {
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      let id: unknown = null;
      try {
        const request = JSON.parse(line);
        id = request.id ?? null;
        if (!Array.isArray(request.args) || !request.args.every((arg: unknown) => typeof arg === "string") || request.args[0] !== "plan") {
          throw new Error("INVALID_REQUEST: serve accepts plan argument arrays only");
        }
        const arguments_: string[] = [...request.args];
        const rootIndex = arguments_.indexOf("--root");
        if (rootIndex >= 0 && realpathSync(resolve(arguments_[rootIndex + 1]!)) !== root) throw new Error("OUTSIDE_ROOT: request root differs from server root");
        if (rootIndex < 0) arguments_.push("--root", root);
        let output = "", exitCode = 0;
        await runCli(arguments_, { ...context, write: text => { output += text; }, setExitCode: code => { exitCode = code; } });
        process.stdout.write(JSON.stringify({ id, status: exitCode === 0 ? "ok" : "failed", output: JSON.parse(output) }) + "\n");
      } catch (error) {
        process.stdout.write(JSON.stringify({ id, status: "failed", error: error instanceof Error ? error.message : String(error) }) + "\n");
      }
    }
  } finally { setWarmMode(false); }
}
