import type { Language } from "./languages.js";
import type { Operation, BackendLoader } from "./types.js";
export interface RefactorContext {
    operation?: Operation;
    language?: Language;
    toolkitRoot?: string;
    loadBackend: BackendLoader;
}
