import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { npmCli } from "./npm.ts";

export async function ensureSkillRuntime(skillRoot: string, quiet = false): Promise<void> {
  const runtime = join(skillRoot, "assets", "runtime");
  const ready = () => {
    try {
      const manifest = JSON.parse(readFileSync(join(runtime, "node_modules", "typescript", "package.json"), "utf8"));
      return manifest.version === "5.9.3" && existsSync(join(runtime, "node_modules", "typescript", "lib", "typescript.js"));
    } catch { return false; }
  };
  if (ready()) return;
  const lock = join(runtime, ".setup.lock");
  try { await mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`SKILL_SETUP_BUSY: another setup is running; after an interrupted setup inspect ${lock}`);
    throw error;
  }
  try {
    if (ready()) return;
    if (!quiet) process.stderr.write("Installing the skill's locked TypeScript runtime dependency...\n");
    const result = spawnSync(process.execPath, [npmCli(), "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: runtime, stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", process.stderr, process.stderr], timeout: 180_000, encoding: "utf8",
    });
    if (result.error) throw new Error(`SKILL_SETUP_FAILED: ${result.error.message}`);
    if (result.status !== 0 || !ready()) throw new Error(`SKILL_SETUP_FAILED: npm ci did not install the locked runtime dependency${quiet ? `\n${result.stderr || result.stdout}` : ""}`);
  } finally { await rm(lock, { recursive: true, force: true }); }
}
