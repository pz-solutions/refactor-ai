import { languageOperations, type Language } from "./languages.ts";
import type { Operation } from "./types.ts";

/** Distribution namespace; GitHub ownership is configured separately. */
export const npmScope = "refactor-ai";
export interface NpmDistribution {
  name: string;
  bin: string;
  language?: Language;
  operation?: Operation;
}
export const npmDistributions: readonly NpmDistribution[] = [
  { name: "cli", bin: "refactor-ai" },
  ...languageOperations.typescript.map(operation => ({ name: `ts-${operation}`, bin: `refactor-ts-${operation}`, language: "typescript" as const, operation })),
  ...languageOperations.csharp.map(operation => ({ name: `csharp-${operation}`, bin: `refactor-csharp-${operation}`, language: "csharp" as const, operation })),
];
