import type { BackendResult, CheckerIdentity, Diagnostic, FileChange, RefactorRequest } from "../types.js";
import { type Snapshot } from "./snapshot.js";
/**
 * Schema 1: edits and file creations (`after` is always a string).
 * Schema 2: adds deletions (`after: null`) and creations below parent
 * directories that do not exist yet. New plans use 2 only when a change
 * creates or deletes a file, so edit-only plans stay readable by older tools.
 */
export type PlanSchemaVersion = 1 | 2;
export interface Plan {
    checker?: CheckerIdentity;
    schemaVersion: PlanSchemaVersion;
    id: string;
    request: RefactorRequest;
    backend: string;
    backendVersion: string;
    snapshot: Snapshot;
    changes: BackendResult["changes"];
    validation: {
        status: "passed" | "failed";
        newDiagnostics: Diagnostic[];
    };
    diagnosticsBefore: Diagnostic[];
    diagnosticsAfter: Diagnostic[];
    notes: string[];
    /** Optional for legacy plans; source moves inherit source permissions. */
    fileModes?: Record<string, {
        before: number | null;
        after: number | null;
    }>;
}
export declare function newDiagnostics(before: Diagnostic[], after: Diagnostic[]): Diagnostic[];
export declare function planId(plan: Omit<Plan, "id"> | Plan): string;
export type ChangeKind = "create" | "edit" | "delete";
export declare function changeKind(change: FileChange): ChangeKind;
/** Structural and integrity validation shared by loadPlan and applyPlan. */
export declare function assertPlanShape(plan: Plan): void;
export declare function createPlan(request: RefactorRequest, analyze: (request: RefactorRequest) => Promise<BackendResult>): Promise<Plan>;
export declare function loadPlan(path: string): Promise<Plan>;
export declare function assertFresh(plan: Plan): Promise<void>;
export declare function preview(plan: Plan): string;
