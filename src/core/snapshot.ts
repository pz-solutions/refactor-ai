import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const excluded = new Set([".git", "node_modules", "bin", "obj", "dist", ".refactor-ai"]);

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface Snapshot {
  files: Record<string, string>;
  hash: string;
}

export function inside(root: string, file: string): string {
  const result = resolve(file);
  const rel = relative(root, result);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`OUTSIDE_ROOT: ${file}`);
  }
  if (rel.split(sep).some(part => excluded.has(part))) {
    throw new Error(`EXCLUDED_PATH: ${file}`);
  }
  return result;
}

export async function assertRegularPath(root: string, file: string, allowMissing = false, allowDirectory = false): Promise<void> {
  if (allowDirectory && resolve(file) === root && (await lstat(root)).isDirectory()) return;
  const target = inside(root, file);
  const parts = relative(root, target).split(sep);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = resolve(current, parts[i]);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      // A missing component means everything below it is missing too; callers
      // creating files create those parents themselves.
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`SYMLINK_UNSUPPORTED: ${current}`);
    if (i === parts.length - 1 && !stat.isFile() && !(allowDirectory && stat.isDirectory())) throw new Error(`NOT_A_FILE: ${current}`);
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`NOT_A_DIRECTORY: ${current}`);
  }
}

/** Canonicalize a possibly missing path via its nearest existing ancestor. */
export async function canonicalMissing(file: string): Promise<string> {
  const absolute = resolve(file);
  const parent = dirname(absolute);
  if (parent === absolute) return realpath(absolute);
  try { return resolve(await realpath(parent), basename(absolute)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolve(await canonicalMissing(parent), basename(absolute));
  }
}

/** Ancestor directories of file (below root) that do not exist yet, outermost first. */
export async function missingDirectories(root: string, file: string): Promise<string[]> {
  const parts = relative(root, dirname(inside(root, file))).split(sep).filter(Boolean);
  const missing: string[] = [];
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    if (missing.length) { missing.push(current); continue; }
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`SYMLINK_UNSUPPORTED: ${current}`);
      if (!stat.isDirectory()) throw new Error(`NOT_A_DIRECTORY: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(current);
    }
  }
  return missing;
}

/**
 * Fingerprint every regular file and symlink under the root. Symlinks are recorded
 * by their link text, never followed; writes through them are still rejected by
 * assertRegularPath. Inside a Git work tree only tracked and unignored files count,
 * so build caches and ignored artifacts neither slow planning nor make plans stale.
 */
export async function snapshot(rootPath: string): Promise<Snapshot> {
  const root = await realpath(rootPath);
  const files: Record<string, string> = {};
  const record = async (file: string, kind: "file" | "symlink") => {
    files[relative(root, file)] = kind === "symlink" ? `symlink:${await readlink(file)}` : sha256(await readFile(file));
  };
  const listed = await gitFiles(root);
  if (listed) {
    for (const name of listed) {
      if (name.split("/").some(part => excluded.has(part))) continue;
      const file = resolve(root, name);
      const stat = await lstat(file).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (stat?.isSymbolicLink()) await record(file, "symlink");
      else if (stat?.isFile()) await record(file, "file");
    }
  } else {
    async function walk(directory: string): Promise<void> {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        if (excluded.has(entry.name)) continue;
        const file = resolve(directory, entry.name);
        if (entry.isSymbolicLink()) await record(file, "symlink");
        else if (entry.isDirectory()) await walk(file);
        else if (entry.isFile()) await record(file, "file");
      }
    }
    await walk(root);
  }
  return { files, hash: sha256(JSON.stringify(files)) };
}

const run = promisify(execFile);

/** Tracked and unignored untracked files below root, sorted; null outside a Git work tree. */
async function gitFiles(root: string): Promise<string[] | null> {
  try {
    // Without --full-name, paths are relative to cwd (the root); -z disables quoting.
    const { stdout } = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], {
      cwd: root, maxBuffer: 1 << 28, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    const names = [...new Set(stdout.split("\0").filter(Boolean))].map(name => name.split(sep).join("/"));
    return names.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  } catch {
    return null;
  }
}
