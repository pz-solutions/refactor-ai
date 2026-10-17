import ts from "typescript";
import { statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import type { BackendResult, Capability, Diagnostic, FileChange, RefactorRequest } from "../types";
import { analyzeFileOperation, fileCapabilities } from "./typescript-fileops";
import { moduleSpecifiers } from "./typescript-workspace";
import { isInside } from "./typescript-paths";

export const capabilities: Capability[] = [
  { operation: "rename", description: "Rename a TypeScript or JavaScript symbol across its configured project." },
  { operation: "imports", modes: ["sort", "remove-unused"], description: "Sort imports or explicitly remove unused imports." },
  { operation: "format", description: "Format a source file with the TypeScript formatter." },
  { operation: "extract-function", description: "Extract the selected statements or expression to a named function." },
  { operation: "extract-variable", description: "Extract the selected expression to a named variable." },
  ...fileCapabilities,
];

const formatOptions: ts.FormatCodeSettings = {
  indentSize: 2,
  tabSize: 2,
  newLineCharacter: "\n",
  convertTabsToSpaces: true,
  indentStyle: ts.IndentStyle.Smart,
  insertSpaceAfterCommaDelimiter: true,
  insertSpaceAfterSemicolonInForStatements: true,
  insertSpaceBeforeAndAfterBinaryOperators: true,
  insertSpaceAfterKeywordsInControlFlowStatements: true,
  insertSpaceAfterFunctionKeywordForAnonymousFunctions: false,
  insertSpaceBeforeFunctionParenthesis: false,
  insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
  semicolons: ts.SemicolonPreference.Insert,
};

interface ProjectState {
  configPath: string;
  root: string;
  fileNames: string[];
  options: ts.CompilerOptions;
  overlays: Map<string, string>;
  versions: Map<string, number>;
  service: ts.LanguageService;
  bumpProjectVersion(): void;
}

function fail(code: string, reason: string): never {
  throw new Error(`${code}: ${reason}`);
}

function canonical(path: string): string {
  return resolve(path);
}

function assertAbsolute(name: string, value: string): string {
  if (!isAbsolute(value)) fail("INVALID_REQUEST", `${name} must be an absolute path`);
  return canonical(value);
}

function configPathFor(project: string): string {
  let stat;
  try {
    stat = statSync(project);
  } catch {
    fail("PROJECT_NOT_FOUND", project);
  }
  if (stat.isFile()) {
    if (!["tsconfig.json", "jsconfig.json"].includes(basename(project))) {
      fail("UNSUPPORTED_PROJECT", "project must name tsconfig.json or jsconfig.json");
    }
    return project;
  }
  if (!stat.isDirectory()) fail("UNSUPPORTED_PROJECT", "project must be a config file or directory");
  const candidates = ["tsconfig.json", "jsconfig.json"]
    .map((name) => resolve(project, name))
    .filter(ts.sys.fileExists);
  if (candidates.length === 0) fail("CONFIG_NOT_FOUND", `no tsconfig.json or jsconfig.json in ${project}`);
  if (candidates.length > 1) fail("MULTIPLE_CONFIGS", `both tsconfig.json and jsconfig.json exist in ${project}`);
  return candidates[0]!;
}

function loadProject(request: RefactorRequest): ProjectState {
  const root = assertAbsolute("root", request.root);
  const project = assertAbsolute("project", request.project);
  const configPath = configPathFor(project);
  if (!isInside(root, configPath)) fail("OUTSIDE_ROOT", `project config is outside ${root}`);

  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      fail("INVALID_CONFIG", ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (!parsed) fail("INVALID_CONFIG", `could not parse ${configPath}`);
  const configErrors = parsed.errors.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (configErrors.length) fail("INVALID_CONFIG", ts.flattenDiagnosticMessageText(configErrors[0]!.messageText, "\n"));
  if (parsed.projectReferences?.length) {
    fail("PROJECT_REFERENCES_UNSUPPORTED", "project references require more than one configured program");
  }

  const fileNames = parsed.fileNames.map(canonical).sort();
  const overlays = new Map<string, string>();
  const versions = new Map<string, number>();
  let projectVersion = 0;
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => [...new Set([...fileNames, ...overlays.keys()])].sort(),
    getScriptVersion: (fileName) => String(versions.get(canonical(fileName)) ?? 0),
    getScriptSnapshot(fileName) {
      const path = canonical(fileName);
      const text = overlays.get(path) ?? ts.sys.readFile(path);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => dirname(configPath),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
    getProjectVersion: () => String(projectVersion),
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  return {
    configPath,
    root,
    fileNames,
    options: parsed.options,
    overlays,
    versions,
    service,
    bumpProjectVersion() { projectVersion += 1; },
  };
}

function sourceText(state: ProjectState, path: string): string | undefined {
  return state.overlays.get(path) ?? ts.sys.readFile(path);
}

function setOverlay(state: ProjectState, path: string, text: string): void {
  state.overlays.set(path, text);
  state.versions.set(path, (state.versions.get(path) ?? 0) + 1);
  state.bumpProjectVersion();
}

function applyTextChanges(text: string, changes: readonly ts.TextChange[]): string {
  const ordered = changes
    .map((change, index) => ({ change, index }))
    .sort((a, b) => b.change.span.start - a.change.span.start || b.index - a.index)
    .map(({ change }) => change);
  let boundary = text.length;
  for (const change of ordered) {
    const end = change.span.start + change.span.length;
    if (change.span.start < 0 || end > text.length) fail("INVALID_EDIT", "TypeScript returned an out-of-bounds edit");
    if (end > boundary) fail("OVERLAPPING_EDITS", "TypeScript returned overlapping edits");
    text = text.slice(0, change.span.start) + change.newText + text.slice(end);
    boundary = change.span.start;
  }
  return text;
}

function applyFileEdits(state: ProjectState, edits: readonly ts.FileTextChanges[]): void {
  for (const edit of [...edits].sort((a, b) => canonical(a.fileName).localeCompare(canonical(b.fileName)))) {
    const path = canonical(edit.fileName);
    if (!isInside(state.root, path)) fail("OUTSIDE_ROOT", `TypeScript proposed a change outside ${state.root}: ${path}`);
    const before = sourceText(state, path);
    if (before === undefined && !edit.isNewFile) fail("MISSING_FILE", path);
    setOverlay(state, path, applyTextChanges(before ?? "", edit.textChanges));
  }
}

function diagnosticRecord(diagnostic: ts.Diagnostic, fallback: string): Diagnostic {
  return {
    file: diagnostic.file ? canonical(diagnostic.file.fileName) : fallback,
    code: `TS${diagnostic.code}`,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  };
}

function diagnostics(state: ProjectState, only?: Set<string>): Diagnostic[] {
  const records: Diagnostic[] = [];
  const add = (diagnostic: ts.Diagnostic) => {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) return;
    records.push(diagnosticRecord(diagnostic, state.configPath));
  };
  for (const item of state.service.getCompilerOptionsDiagnostics()) add(item);
  const programFiles = state.service.getProgram()?.getSourceFiles()
    .map((source) => canonical(source.fileName))
    .filter((path) => isInside(state.root, path) && !path.includes("/node_modules/")) ?? state.fileNames;
  for (const file of [...new Set(programFiles)].filter((path) => !only || only.has(path)).sort()) {
    for (const item of state.service.getSyntacticDiagnostics(file)) add(item);
    for (const item of state.service.getSemanticDiagnostics(file)) add(item);
  }
  return records.sort((a, b) => a.file.localeCompare(b.file) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
}

/** User files that import each user file (directly), from the unmodified program. */
function importersByFile(state: ProjectState): Map<string, Set<string>> {
  const program = state.service.getProgram()!;
  const host = ts.sys;
  const cache = ts.createModuleResolutionCache(dirname(state.configPath), (name) => host.useCaseSensitiveFileNames ? name : name.toLowerCase(), state.options);
  const importers = new Map<string, Set<string>>();
  const link = (target: string, importer: string) => {
    if (!isInside(state.root, target) || target.includes("/node_modules/")) return;
    const set = importers.get(target) ?? new Set<string>();
    set.add(importer);
    importers.set(target, set);
  };
  for (const source of program.getSourceFiles()) {
    const file = canonical(source.fileName);
    if (!isInside(state.root, file) || file.includes("/node_modules/")) continue;
    for (const specifier of moduleSpecifiers(source)) {
      const mode = program.getModeForUsageLocation(source, specifier);
      const resolved = ts.resolveModuleName(specifier.text, file, state.options, host, cache, undefined, mode).resolvedModule;
      if (resolved) link(canonical(resolved.resolvedFileName), file);
    }
    for (const reference of source.referencedFiles) link(canonical(resolve(dirname(file), reference.fileName)), file);
  }
  return importers;
}

/** A change to this file can alter types outside its importers (scripts, global or ambient module augmentation). */
function hasGlobalEffect(text: string, path: string): boolean {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
  if (!ts.isExternalModule(source)) return true;
  return source.statements.some((statement) => ts.isModuleDeclaration(statement)
    && (ts.isStringLiteral(statement.name) || (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0));
}

/**
 * Changed files and their transitive importers, or undefined when a changed
 * file (before or after) can affect unrelated files; then the whole program is checked.
 */
function affectedFiles(state: ProjectState, importers: Map<string, Set<string>>, originals: Map<string, string | undefined>): Set<string> | undefined {
  const changed = [...state.overlays.keys()].filter((path) => originals.get(path) !== state.overlays.get(path));
  for (const path of changed) {
    if (!/\.[cm]?[jt]sx?$/i.test(path) || /\.d\.[cm]?ts$/i.test(path)) return undefined;
    for (const text of [originals.get(path), state.overlays.get(path)]) if (text !== undefined && hasGlobalEffect(text, path)) return undefined;
  }
  const affected = new Set<string>();
  const pending = [...changed];
  while (pending.length) {
    const path = pending.pop()!;
    if (affected.has(path)) continue;
    affected.add(path);
    pending.push(...(importers.get(path) ?? []));
  }
  return affected;
}

/** Diagnostics of `only` (or everything) for the unmodified sources, restoring the overlays afterwards. */
function originalDiagnostics(state: ProjectState, only: Set<string> | undefined): Diagnostic[] {
  const saved = new Map(state.overlays);
  for (const path of saved.keys()) {
    state.overlays.delete(path);
    state.versions.set(path, (state.versions.get(path) ?? 0) + 1);
  }
  state.bumpProjectVersion();
  try {
    return diagnostics(state, only);
  } finally {
    for (const [path, text] of saved) setOverlay(state, path, text);
  }
}

function validatePosition(text: string, position: number | undefined, label = "position"): number {
  if (!Number.isInteger(position) || position! < 0 || position! > text.length) {
    fail("INVALID_RANGE", `${label} must be a UTF-16 offset within the file`);
  }
  return position!;
}

function isValidIdentifier(name: string, target: ts.ScriptTarget): boolean {
  const scanner = ts.createScanner(target, false, ts.LanguageVariant.Standard, name);
  return scanner.scan() === ts.SyntaxKind.Identifier
    && scanner.getTokenText() === name
    && scanner.scan() === ts.SyntaxKind.EndOfFileToken;
}

function renameLocationKey(fileName: string, start: number, length: number): string {
  return `${canonical(fileName)}\0${start}\0${length}`;
}

function mappedRenameLocations(
  grouped: ReadonlyMap<string, readonly ts.RenameLocation[]>,
  newName: string,
): { fileName: string; start: number; length: number }[] {
  const mapped: { fileName: string; start: number; length: number }[] = [];
  for (const [fileName, fileLocations] of grouped) {
    let delta = 0;
    const ordered = [...fileLocations].sort((a, b) => a.textSpan.start - b.textSpan.start);
    for (const location of ordered) {
      const prefixLength = location.prefixText?.length ?? 0;
      const replacementLength = prefixLength + newName.length + (location.suffixText?.length ?? 0);
      const item = {
        fileName,
        start: location.textSpan.start + delta + prefixLength,
        length: newName.length,
      };
      mapped.push(item);
      delta += replacementLength - location.textSpan.length;
    }
  }
  return mapped;
}

function assertRenameSemantics(
  state: ProjectState,
  anchorBefore: ts.RenameLocation,
  grouped: ReadonlyMap<string, readonly ts.RenameLocation[]>,
  newName: string,
): void {
  const expected = mappedRenameLocations(grouped, newName);
  let anchor: { fileName: string; start: number; length: number } | undefined;
  for (const [fileName, fileLocations] of grouped) {
    let delta = 0;
    for (const location of [...fileLocations].sort((a, b) => a.textSpan.start - b.textSpan.start)) {
      const prefixLength = location.prefixText?.length ?? 0;
      if (canonical(anchorBefore.fileName) === fileName
        && location.textSpan.start === anchorBefore.textSpan.start
        && location.textSpan.length === anchorBefore.textSpan.length) {
        anchor = { fileName, start: location.textSpan.start + delta + prefixLength, length: newName.length };
      }
      delta += prefixLength + newName.length + (location.suffixText?.length ?? 0) - location.textSpan.length;
    }
  }
  if (!anchor) fail("RENAME_CONFLICT", "could not map the renamed symbol declaration");

  const after = state.service.findRenameLocations(anchor.fileName, anchor.start, false, false, {
    providePrefixAndSuffixTextForRename: true,
  });
  const expectedCounts = new Map<string, number>();
  for (const location of expected) {
    const key = renameLocationKey(location.fileName, location.start, location.length);
    expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
  }
  const actualCounts = new Map<string, number>();
  for (const location of after ?? []) {
    const key = renameLocationKey(location.fileName, location.textSpan.start, location.textSpan.length);
    actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
  }
  let missing = 0;
  let additional = 0;
  for (const [key, count] of expectedCounts) missing += Math.max(0, count - (actualCounts.get(key) ?? 0));
  for (const [key, count] of actualCounts) additional += Math.max(0, count - (expectedCounts.get(key) ?? 0));
  if (missing || additional) {
    fail("RENAME_CONFLICT", `rename changes symbol binding (${missing} missing, ${additional} additional locations)`);
  }
}

function rename(state: ProjectState, file: string, request: RefactorRequest): void {
  const text = sourceText(state, file)!;
  const position = validatePosition(text, request.position);
  if (!request.newName?.trim()) fail("INVALID_REQUEST", "newName is required for rename");
  if (!isValidIdentifier(request.newName, state.options.target ?? ts.ScriptTarget.Latest)) {
    fail("INVALID_NAME", `${request.newName} is not a valid identifier`);
  }
  const info = state.service.getRenameInfo(file, position, { providePrefixAndSuffixTextForRename: true });
  if (!info.canRename) fail("RENAME_UNAVAILABLE", info.localizedErrorMessage);
  const locations = state.service.findRenameLocations(file, position, false, false, { providePrefixAndSuffixTextForRename: true });
  if (!locations?.length) fail("RENAME_UNAVAILABLE", "TypeScript found no semantic rename locations");
  const definitions = state.service.getDefinitionAndBoundSpan(file, position)?.definitions ?? [];
  const anchor = definitions
    .map((definition) => locations.find((location) => canonical(location.fileName) === canonical(definition.fileName)
      && location.textSpan.start === definition.textSpan.start
      && location.textSpan.length === definition.textSpan.length))
    .find((location): location is ts.RenameLocation => location !== undefined)
    ?? locations.find((location) => canonical(location.fileName) === file
      && position >= location.textSpan.start
      && position <= location.textSpan.start + location.textSpan.length)
    ?? locations[0]!;
  const grouped = new Map<string, ts.RenameLocation[]>();
  for (const location of locations) {
    const path = canonical(location.fileName);
    if (!isInside(state.root, path)) fail("OUTSIDE_ROOT", `rename location is outside ${state.root}: ${path}`);
    const list = grouped.get(path) ?? [];
    list.push(location);
    grouped.set(path, list);
  }
  applyFileEdits(state, [...grouped].map(([fileName, fileLocations]) => ({
    fileName,
    textChanges: fileLocations.map((location) => ({
      span: location.textSpan,
      newText: `${location.prefixText ?? ""}${request.newName}${location.suffixText ?? ""}`,
    })),
  })));
  assertRenameSemantics(state, anchor, grouped, request.newName);
}

function imports(state: ProjectState, file: string, request: RefactorRequest): void {
  if (request.mode !== "sort" && request.mode !== "remove-unused") {
    fail("INVALID_REQUEST", "imports mode must be sort or remove-unused");
  }
  const mode = request.mode === "sort" ? ts.OrganizeImportsMode.SortAndCombine : ts.OrganizeImportsMode.RemoveUnused;
  applyFileEdits(state, state.service.organizeImports({ type: "file", fileName: file, mode }, formatOptions, {}));
}

function format(state: ProjectState, file: string): void {
  const text = sourceText(state, file)!;
  const edits = state.service.getFormattingEditsForDocument(file, formatOptions);
  setOverlay(state, file, applyTextChanges(text, edits));
}

function extraction(state: ProjectState, file: string, request: RefactorRequest): void {
  const text = sourceText(state, file)!;
  const position = validatePosition(text, request.position);
  const end = validatePosition(text, request.end, "end");
  if (end <= position) fail("INVALID_RANGE", "end must be greater than position");
  if (!request.newName?.trim() || !isValidIdentifier(request.newName, state.options.target ?? ts.ScriptTarget.Latest)) {
    fail("INVALID_NAME", "newName must be a valid identifier for extraction");
  }
  const range = { pos: position, end };
  const applicable = state.service.getApplicableRefactors(file, range, {}, "invoked", undefined, false);
  const actionName = request.operation === "extract-function" ? "function_scope_0" : "constant_scope_0";
  const selected = applicable
    .filter((refactor) => refactor.name === "Extract Symbol")
    .flatMap((refactor) => refactor.actions.map((action) => ({ refactor, action })))
    .find(({ action }) => action.name === actionName && !action.notApplicableReason);
  if (!selected) fail("REFACTOR_UNAVAILABLE", `TypeScript cannot ${request.operation} for the selected range`);
  const result = state.service.getEditsForRefactor(file, formatOptions, range, selected.refactor.name, selected.action.name, {});
  if (!result || result.notApplicableReason) fail("REFACTOR_UNAVAILABLE", result?.notApplicableReason ?? "TypeScript returned no edits");
  applyFileEdits(state, result.edits);
  if (result.renameLocation === undefined) fail("REFACTOR_UNAVAILABLE", "TypeScript did not provide a semantic rename location for the extraction");
  const renameFile = canonical(result.renameFilename ?? file);
  rename(state, renameFile, { ...request, operation: "rename", file: renameFile, position: result.renameLocation });
}

function changedFiles(state: ProjectState, originals: Map<string, string | undefined>): FileChange[] {
  return [...state.overlays]
    .filter(([path, after]) => originals.get(path) !== after)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, after]) => ({ path, before: originals.get(path) ?? null, after }));
}

export async function analyze(request: RefactorRequest): Promise<BackendResult> {
  if (request.operation === "rename-file" || request.operation === "move-type") return analyzeFileOperation(request);
  if (request.operation === "sync-namespace") {
    fail("UNSUPPORTED_OPERATION", "sync-namespace is C# only; ES modules have no namespace-to-directory convention");
  }
  const state = loadProject(request);
  try {
    const file = assertAbsolute("file", request.file);
    if (!isInside(state.root, file)) fail("OUTSIDE_ROOT", `file is outside ${state.root}`);
    const text = sourceText(state, file);
    if (text === undefined) fail("FILE_NOT_FOUND", file);
    const extension = extname(file).toLowerCase();
    if (![".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(extension)) {
      fail("UNSUPPORTED_FILE", extension || "file has no extension");
    }
    const program = state.service.getProgram();
    if (!program?.getSourceFile(file)) fail("FILE_NOT_IN_PROJECT", file);
    const outsideUserSources = program.getSourceFiles()
      .filter((source) => !isInside(state.root, canonical(source.fileName)) && !source.isDeclarationFile)
      .map((source) => canonical(source.fileName))
      .sort();
    if (outsideUserSources.length) {
      fail("PROJECT_SCOPE_INCOMPLETE", `program contains user source outside ${state.root}: ${outsideUserSources.join(", ")}`);
    }

    const importers = importersByFile(state);
    const originals = new Map<string, string | undefined>();
    for (const path of state.fileNames) originals.set(path, sourceText(state, path));

    switch (request.operation) {
      case "rename": rename(state, file, request); break;
      case "imports": imports(state, file, request); break;
      case "format": format(state, file); break;
      case "extract-function":
      case "extract-variable": extraction(state, file, request); break;
      default: fail("UNSUPPORTED_OPERATION", String(request.operation));
    }

    for (const path of state.overlays.keys()) if (!originals.has(path)) originals.set(path, ts.sys.readFile(path));
    // Validate the changed files and everything that (transitively) imports them; unrelated files cannot change.
    const affected = affectedFiles(state, importers, originals);
    const diagnosticsBefore = originalDiagnostics(state, affected);
    const diagnosticsAfter = diagnostics(state, affected);
    const beforeCounts = new Map<string, number>();
    for (const item of diagnosticsBefore) {
      const key = `${item.file}\0${item.code}\0${item.message}`;
      beforeCounts.set(key, (beforeCounts.get(key) ?? 0) + 1);
    }
    const introduced = diagnosticsAfter.filter((item) => {
      const key = `${item.file}\0${item.code}\0${item.message}`;
      const count = beforeCounts.get(key) ?? 0;
      if (count === 0) return true;
      beforeCounts.set(key, count - 1);
      return false;
    });
    if (introduced.length) fail("NEW_DIAGNOSTICS", introduced.map((item) => `${item.code} ${item.message}`).join("; "));

    const notes: string[] = [];
    if (affected) notes.push(`Validated ${affected.size} affected file(s): the changed files and their transitive importers.`);
    if (request.operation === "imports") {
      notes.push(request.mode === "sort"
        ? "Sorting imports can reorder module initialization; verify application behavior."
        : "Removing unused value imports can remove module initialization; bare side-effect imports are retained.");
    }
    if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension) && ["rename", "extract-function", "extract-variable"].includes(request.operation)) {
      notes.push("JavaScript analysis is semantic only for symbols TypeScript can resolve; dynamic properties, reflection, and string-based references are not changed.");
    }
    return {
      backend: "typescript",
      version: ts.version,
      changes: changedFiles(state, originals),
      diagnosticsBefore,
      diagnosticsAfter,
      notes,
    };
  } finally {
    state.service.dispose();
  }
}
