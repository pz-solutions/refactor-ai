import { extname } from "node:path";
import type { Operation } from "./types.ts";

export type Language = "typescript" | "csharp";
export const languageOperations: Record<Language, readonly Operation[]> = {
  typescript: ["rename", "imports", "format", "extract-function", "extract-variable", "rename-file", "move-type", "retarget-import"],
  csharp: ["rename", "imports", "format", "rename-file", "sync-namespace", "move-type"],
};

export function languageForProject(project: string): Language {
  const extension = extname(project).toLowerCase();
  if (extension === ".csproj" || extension === ".sln") return "csharp";
  if (extension === ".json") return "typescript";
  throw new Error("UNSUPPORTED_PROJECT: use tsconfig/jsconfig.json, .csproj or .sln");
}
