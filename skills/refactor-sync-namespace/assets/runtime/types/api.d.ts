import { type Plan } from "./core/plan.js";
import type { Capability, Operation } from "./types.js";
import { RefactorContext } from "./refactor-context.js";
export type { Plan } from "./core/plan.js";
export type { Capability, Diagnostic, FileChange, Operation } from "./types.js";
export interface PlanOptions {
    project: string;
    file?: string;
    /** Defaults to the project configuration's directory. Must cover all changed files. */
    root?: string;
    /** Required for the aggregate API; operation packages select their own operation. */
    operation?: Operation;
    /** Exact source/destination module specifiers for retarget-import. */
    from?: string;
    to?: string;
    map?: Record<string, string>;
    only?: string[];
    /** retarget-import: report affected test mocks (default), or add parallel mocks. */
    mocks?: "report" | "add";
    /** A 1-based UTF-16 line:column string or a zero-based UTF-16 offset. */
    at?: string | number;
    /** Exclusive extraction end, using the same coordinates as at. */
    end?: string | number;
    name?: string;
    mode?: "sort" | "remove-unused";
    /** Keep an inlined re-export shim; valid only for inline-reexports. */
    keep?: boolean;
    target?: string;
    targetProject?: string;
    typeName?: string;
    rootNamespace?: string;
}
export interface ValidationResult {
    status: "validated" | "failed";
    validation: Plan["validation"];
    id: string;
}
export interface ApplyResult {
    status: "applied";
    files: string[];
    journal: string | null;
}
export interface RefactorApi {
    /** Compute changes without writing sources or a plan file. Failed diagnostics remain in the plan. */
    plan(options: PlanOptions): Promise<Plan>;
    preview(plan: Plan): string;
    /** Check integrity, snapshot freshness and stored compiler diagnostics; does not run project tests. */
    validate(plan: Plan): Promise<ValidationResult>;
    /** Apply exactly this plan with the shared snapshot, lock and journal protections. */
    apply(plan: Plan): Promise<ApplyResult>;
    loadPlan(path: string): Promise<Plan>;
    capabilities(project: string): Promise<Capability[]>;
}
export declare function offset(text: string, point: string): number;
/** Internal binding shared by CLI, installed skills and language-specific npm packages. */
export declare function createRefactorApi(context: RefactorContext): RefactorApi;
