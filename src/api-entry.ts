import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRefactorApi, type RefactorApi } from "./api.ts";
import { loadBackend } from "./backends/load.ts";

export type { RefactorApi, PlanOptions, Plan, ValidationResult, ApplyResult, Capability, Diagnostic, FileChange, Operation } from "./api.ts";

export async function createRefactor(): Promise<RefactorApi> {
  return createRefactorApi({ loadBackend, toolkitRoot: resolve(dirname(fileURLToPath(import.meta.url)), "..") });
}
