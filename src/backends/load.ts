import { languageForProject } from "../languages.ts";
import type { BackendLoader } from "../types.ts";

/** This loader belongs only to distributions that support both engines. */
export const loadBackend: BackendLoader = async (project, toolkitRoot) => {
  if (languageForProject(project) !== "csharp") return import("./typescript.ts");
  const backend = await import("./csharp.ts");
  return { capabilities: backend.capabilities, analyze: request => backend.analyze(request, toolkitRoot) };
};
