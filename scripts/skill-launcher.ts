import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { helpRequested, renderHelp } from "../src/help.ts";
import { ensureSkillRuntime } from "../src/runtime/skill.ts";

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = join(skillRoot, "assets", "runtime");

try {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("UNSUPPORTED_RUNTIME: Node.js 22+ is required");
  if (helpRequested(process.argv.slice(2))) {
    process.stdout.write(renderHelp(process.argv.slice(2), 'node "<skill-root>/scripts/refactor.mjs"'));
    process.exit(0);
  }
  await ensureSkillRuntime(skillRoot);
  const { main } = await import(pathToFileURL(join(runtime, "cli.mjs")).href);
  await main(process.argv.slice(2), { toolkitRoot: join(skillRoot, "assets") });
} catch (error) {
  console.error(JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
