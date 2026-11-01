import type { Operation } from "./types.js";
export type Language = "typescript" | "csharp";
export declare const languageOperations: Record<Language, readonly Operation[]>;
export declare function languageForProject(project: string): Language;
