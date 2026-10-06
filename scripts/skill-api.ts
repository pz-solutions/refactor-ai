import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRefactorApi, type RefactorApi } from "../src/api.ts";
import { ensureSkillRuntime } from "../src/runtime/skill.ts";
import type { Operation } from "../src/types.ts";

/** Importing this module does not install dependencies or load a compiler. */
export async function createInstalledRefactor(moduleUrl: string, operation: Operation): Promise<RefactorApi> {
  const skillRoot = resolve(dirname(fileURLToPath(moduleUrl)), "..");
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("UNSUPPORTED_RUNTIME: Node.js 22+ is required");
  await ensureSkillRuntime(skillRoot, true);
  // The compiler-backed module resolves dependencies inside the installed skill,
  // independently of the importing custom script's location.
  const { loadBackend } = await import(pathToFileURL(join(skillRoot, "assets", "runtime", "api.mjs")).href);
  return createRefactorApi({ loadBackend, operation, language: operation.startsWith("extract-") ? "typescript" : operation === "sync-namespace" ? "csharp" : undefined,
    toolkitRoot: join(skillRoot, "assets") });
}
