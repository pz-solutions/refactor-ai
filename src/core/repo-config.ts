import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Committable planning defaults, e.g. `{"verify":"bindings","checker":"ts7"}`. */
export interface RepoConfig {
  verify?: "full" | "bindings";
  checker?: "ts5" | "ts7" | "both";
}

const allowed: Record<keyof RepoConfig, readonly string[]> = { verify: ["full", "bindings"], checker: ["ts5", "ts7", "both"] };

/** `<root>/.refactor-ai/config.json`; absent means no defaults. Explicit plan options always win. */
export async function readRepoConfig(root: string): Promise<RepoConfig> {
  const path = resolve(root, ".refactor-ai/config.json");
  const stat = await lstat(path).catch(error => {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  });
  if (!stat) return {};
  if (!stat.isFile()) throw new Error(`INVALID_REPO_CONFIG: ${path} must be a regular file`);
  let config: unknown;
  try { config = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error(`INVALID_REPO_CONFIG: ${path} is not valid JSON`); }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`INVALID_REPO_CONFIG: ${path} must contain an object`);
  for (const [key, value] of Object.entries(config)) {
    const values = Object.hasOwn(allowed, key) ? allowed[key as keyof RepoConfig] : undefined;
    if (!values) throw new Error(`INVALID_REPO_CONFIG: ${path}: unknown key '${key}'; supported: verify, checker`);
    if (typeof value !== "string" || !values.includes(value)) throw new Error(`INVALID_REPO_CONFIG: ${path}: ${key} must be ${values.join("|")}`);
  }
  return config as RepoConfig;
}
