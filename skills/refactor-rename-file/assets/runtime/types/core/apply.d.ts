import { type Plan } from "./plan.js";
export declare function applyPlan(plan: Plan): Promise<{
    status: "applied";
    files: string[];
    journal: string | null;
}>;
