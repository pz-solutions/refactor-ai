export type Operation = "rename" | "imports" | "format" | "extract-function" | "extract-variable" | "rename-file" | "sync-namespace" | "move-type" | "move-file" | "inline-reexports";

export interface RefactorRequest {
  project: string;
  root: string;
  file: string;
  operation: Operation;
  /** Retain the source shim after inline-reexports. */
  keep?: boolean;
  position?: number;
  end?: number;
  newName?: string;
  mode?: "sort" | "remove-unused";
  /** Absolute destination file/directory path for move-type or move-file. */
  target?: string;
  /** Absolute destination .csproj or TS/JS config for cross-project moves. */
  targetProject?: string;
  /** Select a declared type when a file contains several declarations. */
  typeName?: string;
  /** Override the C# project's root namespace when its convention is not in MSBuild. */
  rootNamespace?: string;
}

export interface Diagnostic {
  file: string;
  code: string;
  message: string;
}

export interface FileChange {
  path: string;
  before: string | null;
  /** null deletes an existing file; before:null creates a new file. */
  after: string | null;
}

export interface BackendResult {
  backend: string;
  version: string;
  changes: FileChange[];
  diagnosticsBefore: Diagnostic[];
  diagnosticsAfter: Diagnostic[];
  notes: string[];
}

export interface Capability {
  operation: Operation;
  modes?: string[];
  description: string;
}

/** Compiler adapter injected into the shared command workflow. */
export interface RefactorBackend {
  capabilities: Capability[];
  analyze(request: RefactorRequest): Promise<BackendResult>;
}
export type BackendLoader = (project: string, toolkitRoot?: string) => Promise<RefactorBackend>;
