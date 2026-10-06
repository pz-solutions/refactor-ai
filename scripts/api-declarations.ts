import { spawnSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const apiDeclaration = `export type { RefactorApi, PlanOptions, Plan, ValidationResult, ApplyResult, Capability, Diagnostic, FileChange, Operation } from "./types/api.js";
import type { RefactorApi } from "./types/api.js";
export declare function createRefactor(): Promise<RefactorApi>;
`;

/** Emit the public interface and its transitive types with the pinned TS compiler. */
export async function buildApiDeclarations(repo: string, destination: string): Promise<void> {
  const result = spawnSync(process.execPath, [join(repo, "node_modules", "typescript", "bin", "tsc"),
    join(repo, "src", "api.ts"), "--rootDir", join(repo, "src"), "--outDir", destination,
    "--declaration", "--emitDeclarationOnly", "--skipLibCheck", "--target", "ES2023", "--module", "esnext",
    "--moduleResolution", "bundler", "--allowImportingTsExtensions", "--strict", "--types", "node"], { cwd: repo, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  async function rewrite(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await rewrite(path);
      else if (entry.name.endsWith(".d.ts")) {
        const text = await readFile(path, "utf8");
        await writeFile(path, text.replace(/((?:from\s+|import\()["'])(\.[^"']+)(["'])/g, (_match, prefix: string, specifier: string, suffix: string) => {
          const module = specifier.endsWith(".ts") ? specifier.slice(0, -3) + ".js"
            : /\.[a-z]+$/i.test(specifier) ? specifier : specifier + ".js";
          return prefix + module + suffix;
        }));
      }
    }
  }
  await rewrite(destination);
}
