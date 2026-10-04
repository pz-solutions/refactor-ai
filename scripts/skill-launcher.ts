import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { helpRequested, renderHelp } from "../src/help.ts";
import { npmCli } from "../src/runtime/npm.ts";

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = join(skillRoot, "assets", "runtime");

function runtimeReady(): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(runtime, "node_modules", "typescript", "package.json"), "utf8"));
    return manifest.version === "5.9.3" && existsSync(join(runtime, "node_modules", "typescript", "lib", "typescript.js"));
  } catch { return false; }
}

async function ensureRuntime(): Promise<void> {
  if (runtimeReady()) return;
  const lock = join(runtime, ".setup.lock");
  try { await mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`SKILL_SETUP_BUSY: another setup is running; after an interrupted setup inspect ${lock}`);
    }
    throw error;
  }
  try {
    if (runtimeReady()) return;
    process.stderr.write("Installing the skill's locked TypeScript runtime dependency...\n");
    const installed = spawnSync(process.execPath, [npmCli(), "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: runtime, stdio: ["ignore", process.stderr, process.stderr], timeout: 180_000,
    });
    if (installed.error) throw new Error(`SKILL_SETUP_FAILED: ${installed.error.message}`);
    if (installed.status !== 0 || !runtimeReady()) throw new Error("SKILL_SETUP_FAILED: npm ci did not install the locked runtime dependency");
  } finally { await rm(lock, { recursive: true, force: true }); }
}

try {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("UNSUPPORTED_RUNTIME: Node.js 22+ is required");
  if (helpRequested(process.argv.slice(2))) {
    process.stdout.write(renderHelp(process.argv.slice(2), 'node "<skill-root>/scripts/refactor.mjs"'));
    process.exit(0);
  }
  await ensureRuntime();
  process.env.REFACTOR_AI_HOME = join(skillRoot, "assets");
  const { main } = await import(pathToFileURL(join(runtime, "cli.mjs")).href);
  await main(process.argv.slice(2));
} catch (error) {
  console.error(JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
