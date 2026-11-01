import { createRequire } from "node:module";
import { resolve } from "node:path";
import type ts from "typescript";
import type { API, APIOptions, Diagnostic as NativeDiagnostic } from "typescript7/unstable/sync";
import type { CheckerIdentity, Diagnostic } from "../types";
import { fail, type VirtualFs } from "./typescript-vfs";
import { timed } from "./typescript-timing";
import { isInside, portablePath } from "./typescript-paths";

export const ts7Identity: CheckerIdentity = { name: "ts7", version: "7.0.2" };
export const bothIdentity: CheckerIdentity = { name: "both", version: "7.0.2", comparedWith: "typescript@5.9.3" };
export interface DiagnosticInput {
  root: string;
  config: string;
  options: ts.CompilerOptions;
  files: string[];
  only?: Set<string>;
  fs: NonNullable<APIOptions["fs"]>;
  expected: Diagnostic[];
  isUserFile(path: string): boolean;
}
export interface NativeChecker {
  (input: DiagnosticInput): Diagnostic[];
  /** One immutable VFS view; closes before any further edits or baseline checking. */
  withSession?<T>(configs: string[], run: () => T): T;
}

function nativeMessage(diagnostic: NativeDiagnostic): string {
  return [diagnostic.text, ...(diagnostic.messageChain ?? []).map(child => nativeMessage(child).split("\n").map(line => `  ${line}`).join("\n"))].join("\n");
}

/** Compare error sets, including multiplicity; message wording is version-specific. */
export function assertCheckerParity(expected: Diagnostic[], actual: Diagnostic[]): void {
  const keys = (items: Diagnostic[]) => items.map(item => JSON.stringify([resolve(item.file), item.code])).sort();
  const reference = keys(expected), native = keys(actual);
  if (JSON.stringify(reference) !== JSON.stringify(native)) {
    fail("CHECKER_MISMATCH", `TS7 7.0.2 disagrees with TypeScript 5.9.3 (file+code); TS5=${JSON.stringify(reference)}; TS7=${JSON.stringify(native)}. Plan rejected; use the default checker to inspect it.`);
  }
}

/** Optional peer only. Importing or executing the default backend never installs TS7. */
export async function loadTs7Checker(mode: "ts7" | "both" = "both"): Promise<NativeChecker> {
  if (process.versions.bun) fail("CHECKER_RUNTIME", "TS7's synchronous Go API requires Node.js 22+; run the built CLI/API with node");
  let Constructor: typeof API;
  try {
    const metadata = createRequire(import.meta.url)("typescript7/package.json");
    if (metadata.version !== ts7Identity.version) fail("CHECKER_VERSION", `expected typescript7 alias npm:typescript@7.0.2, found ${metadata.version}`);
    Constructor = (await import("typescript7/unstable/sync")).API;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CHECKER_VERSION:")) throw error;
    fail("CHECKER_UNAVAILABLE", "--checker ts7 requires the separately installed optional peer typescript7@npm:typescript@7.0.2 and its platform binary; no runtime download is performed");
  }
  type Session = { configs: string[]; api?: API; snapshot?: ReturnType<API["updateSnapshot"]> };
  let session: Session | undefined;
  const checker: NativeChecker = input => timed("diagnostics.ts7", () => {
    let api: API;
    try { api = session?.api ?? new Constructor({ cwd: input.root, fs: input.fs }); if (session) session.api = api; }
    catch (error) { fail("CHECKER_UNAVAILABLE", `cannot start the installed TS7 7.0.2 platform binary: ${error instanceof Error ? error.message : error}`); }
    try {
      const snapshot = session?.snapshot ?? api.updateSnapshot({ openProjects: session?.configs ?? [input.config] });
      if (session) session.snapshot = snapshot;
      const project = snapshot.getProject(input.config);
      if (!project) fail("CHECKER_PROJECT", `TS7 did not load ${input.config}`);
      const program = project.program;
      const actual: Diagnostic[] = [];
      const add = (items: readonly NativeDiagnostic[]) => {
        for (const item of items) if (item.category === 1) actual.push({
          file: item.fileName ? resolve(item.fileName) : input.config, code: `TS${item.code}`, message: nativeMessage(item),
        });
      };
      add(program.getConfigFileParsingDiagnostics());
      add(program.getProgramDiagnostics());
      add(program.getGlobalDiagnostics());
      const nativeFiles = new Set(program.getSourceFileNames().map(path => resolve(path)));
      const expectedFiles = [...input.files].sort(), actualFiles = [...nativeFiles].filter(input.isUserFile).sort();
      if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
        fail("CHECKER_SOURCE_MISMATCH", `TS7 and TS5 disagree on user source membership in ${input.config}; plan rejected`);
      }
      if (mode === "ts7") {
        // TS5's dependency closure need not be sound for TS7's resolver/type
        // semantics. Check all user sources in native mode, batching IPC too.
        const user = (items: readonly NativeDiagnostic[]) => items.filter(item => !item.fileName || input.isUserFile(resolve(item.fileName)));
        add(user(program.getSyntacticDiagnostics()));
        add(user(program.getSemanticDiagnostics()));
        if (input.options.declaration || input.options.composite) add(user(program.getDeclarationDiagnostics()));
      } else {
        for (const file of input.files) {
          if (input.only && !input.only.has(file)) continue;
          add(program.getSyntacticDiagnostics(file));
          add(program.getSemanticDiagnostics(file));
          if (input.options.declaration || input.options.composite) add(program.getDeclarationDiagnostics(file));
        }
      }
      if (mode === "both") {
        assertCheckerParity(input.expected, actual);
        return input.expected;
      }
      return actual.sort((a, b) => a.file.localeCompare(b.file) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
    } finally { if (!session) api.close(); }
  });
  checker.withSession = (configs, run) => {
    if (session) fail("CHECKER_SESSION", "native checker sessions must not overlap");
    const view: Session = { configs };
    session = view;
    try { return run(); }
    finally { session = undefined; view.api?.close(); }
  };
  return checker;
}

export function compareWorkspaceDiagnostics(checker: NativeChecker, vfs: VirtualFs, config: string, options: ts.CompilerOptions,
  files: string[], expected: Diagnostic[], only?: Set<string>): Diagnostic[] {
  return checker({ root: vfs.root, config, options, files, expected,
    only: only && new Set(files.filter(file => only.has(vfs.key(file)))), fs: vfs.nativeFileSystem(),
    isUserFile: path => isInside(vfs.root, path) && !portablePath(path).split("/").includes("node_modules") && !vfs.isHidden(path),
  });
}
