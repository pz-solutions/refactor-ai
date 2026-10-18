import { type Plan } from "./plan.js";
export declare function applyPlan(plan: Plan, compilerBase?: string): Promise<{
    status: "applied";
    files: string[];
    journal: string | null;
}>;
