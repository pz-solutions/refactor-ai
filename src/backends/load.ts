import { languageForProject } from "../languages.ts";
import type { BackendLoader } from "../types.ts";

/** This loader belongs only to distributions that support both engines. */
export const loadBackend: BackendLoader = project => languageForProject(project) === "csharp"
  ? import("./csharp.ts") : import("./typescript.ts");
