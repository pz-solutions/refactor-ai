import { lstat, mkdir, readFile, readdir, rm, unlink } from "node:fs/promises";
import { resolve } from "node:path";

/** Keep interrupted/rolled-back journals; collect completed transactions under the apply lock. */
export async function collectJournals(root: string): Promise<{ status: "collected"; files: string[] }> {
  const directory = resolve(root, ".refactor-ai");
  const stat = await lstat(directory).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return { status: "collected", files: [] };
  if (stat.isSymbolicLink()) throw new Error("SYMLINK_UNSUPPORTED: state directory");
  const lock = resolve(directory, "apply.lock");
  try { await mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("APPLY_LOCKED: inspect .refactor-ai/apply.lock before gc");
    throw error;
  }
  const files: string[] = [];
  try {
    for (const name of (await readdir(directory)).sort()) {
      if (!/^[a-f0-9]{64}\.journal\.json$/.test(name)) continue;
      const path = resolve(directory, name);
      if (!(await lstat(path)).isFile()) continue;
      let journal;
      try { journal = JSON.parse(await readFile(path, "utf8")); } catch { continue; }
      if (journal.schemaVersion !== 2 || journal.status !== "applied" || journal.planId !== name.slice(0, 64) || !Array.isArray(journal.changes)) continue;
      await unlink(path); files.push(path);
    }
    return { status: "collected", files };
  } finally { await rm(lock, { recursive: true, force: true }); }
}
