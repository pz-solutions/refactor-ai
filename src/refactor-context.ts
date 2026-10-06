import type { Language } from "./languages";
import type { Operation, BackendLoader } from "./types";


export interface RefactorContext {
  operation?: Operation;
  language?: Language;
  toolkitRoot?: string;
  loadBackend: BackendLoader;
}
