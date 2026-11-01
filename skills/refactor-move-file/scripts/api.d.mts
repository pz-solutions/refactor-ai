export type { RefactorApi, PlanOptions, Plan, ValidationResult, ApplyResult, Capability, Diagnostic, FileChange, Operation } from "../assets/runtime/types/api.js";
import type { RefactorApi } from "../assets/runtime/types/api.js";
export declare function createRefactor(): Promise<RefactorApi>;
