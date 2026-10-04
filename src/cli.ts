#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runCli, type CliContext } from "./cli-core.ts";
import { loadBackend } from "./backends/load.ts";
export { offset } from "./cli-core.ts";

/** Complete author CLI; language packages inject their own backend loader. */
export async function main(args: string[], context: Omit<CliContext, "loadBackend"> = {}): Promise<void> {
  return runCli(args, { ...context, loadBackend });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}
