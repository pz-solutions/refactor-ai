import { prepareMoveMocks } from "./typescript-move-mocks";
import { CompilerInputs } from "./typescript-diagnostics-cache";
import { mapMoveImports, moveMapEntries } from "./typescript-retarget-import";
import ts from "typescript";
import { timed } from "./typescript-timing";
import { moveMappings, precheckMove } from "./typescript-prechecks";
import { inlineReexports } from "./typescript-inline-reexports";
import { bothIdentity, loadTs7Checker, ts7Identity } from "./typescript-ts7";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { BackendResult, Capability, Diagnostic, RefactorRequest } from "../types";
import { eolOf, excludedByPatterns, fail, isInside, withEol } from "./typescript-vfs";
import { Workspace, applyTextChanges, baseFormatOptions, configPathFor, moduleSpecifiers } from "./typescript-workspace";
import { anticipatePackageExport, packageSelfImport, packageSpecifier, relativeStyle } from "./typescript-package-specifiers";
import { moveSuppressions } from "./typescript-suppressions";
import { portablePath } from "./typescript-paths";
import { describeInputPath } from "../core/snapshot";
import { ambientModules, assertBindings, type BindingState } from "./typescript-bindings";
import { RouteExtractor, generatePortRoute, portRouteExtractOptions, preparePortRoute, regenerateRouteTree, rewriteView, type PortRoutePrep } from "./typescript-port-route";

export const fileCapabilities: Capability[] = [
  { operation: "port-route", description: "Port a Next App Router route: move its client view into a feature package and generate the thin Next adapter and TanStack Start route from its preload calls." },
  { operation: "move-file", description: "Move whole TS/JS modules or directories within or between workspace packages, updating imports, exports and project file lists." },
  { operation: "inline-reexports", description: "Inline shim re-exports into workspace callers, deleting unreferenced pure shims unless kept." },
  {
    operation: "rename-file",
    description: "Rename a TS/JS file after its declared type (TS class, interface, type alias or enum; JS class), updating imports in all projects that reference it.",
  },
  {
    operation: "move-type",
    description: "Move a top-level TS type or JS class to another file, directory or referenced project, updating imports, re-exports and project file lists.",
  },
];

const tsExtensions = [".ts", ".tsx", ".mts", ".cts"];
const jsExtensions = [".js", ".jsx", ".mjs", ".cjs"];

/** Engine preferences; the quote style follows the majority of existing module specifiers. */
function preferencesFor(ws: Workspace): ts.UserPreferences {
  let single = 0, double = 0;
  for (const path of userFiles(ws)) {
    const sourceFile = parseFile(ws, path);
    for (const specifier of sourceFile ? moduleSpecifiers(sourceFile) : []) {
      const quote = sourceFile!.text[specifier.getStart(sourceFile)];
      if (quote === "'") single += 1;
      else if (quote === '"') double += 1;
    }
  }
  return { allowTextChangesInNewFiles: true, quotePreference: single > double ? "single" : double > single ? "double" : "auto" };
}

interface Selection {
  name: string;
  declarations: ts.DeclarationStatement[];
}

interface Context {
  ws: Workspace;
  root: string;
  file: string;
  sourceFile: ts.SourceFile;
  isJs: boolean;
  notes: string[];
  verify?: () => void;
  aliasHints?: string[];
}

function assertAbsolute(name: string, value: string | undefined): string {
  if (!value || !isAbsolute(value)) fail("INVALID_REQUEST", `${name} must be an absolute path`);
  return resolve(value);
}

function sourceExtension(path: string): string {
  if (/\.d(\.[^./]+)?\.[cm]?ts$/i.test(path)) fail("UNSUPPORTED_FILE", "declaration files cannot be renamed or moved");
  const extension = extname(path);
  if (![...tsExtensions, ...jsExtensions].includes(extension)) fail("UNSUPPORTED_FILE", extension || "file has no extension");
  return extension;
}

function formatFor(text: string): ts.FormatCodeSettings {
  return { ...baseFormatOptions, newLineCharacter: eolOf(text) };
}

function declaredTypes(sourceFile: ts.SourceFile, isJs: boolean): ts.DeclarationStatement[] {
  return sourceFile.statements.filter((statement): statement is ts.DeclarationStatement => {
    if (ts.isClassDeclaration(statement)) return statement.name !== undefined;
    return !isJs && (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement));
  });
}

function namespaceMembers(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isModuleDeclaration(node)) {
      names.add(node.name.text);
      if (node.body) ts.forEachChild(node.body, visit);
    } else if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
      names.add(node.name.text);
    } else if (ts.isModuleBlock(node)) {
      ts.forEachChild(node, visit);
    }
  };
  for (const statement of sourceFile.statements) if (ts.isModuleDeclaration(statement)) visit(statement);
  return names;
}

function selectType(context: Context, request: RefactorRequest): Selection {
  const { sourceFile, isJs } = context;
  const types = declaredTypes(sourceFile, isJs);
  const namespaced = namespaceMembers(sourceFile);
  const named = (name: string) => types.filter((declaration) => declaration.name?.getText(sourceFile) === name);
  let name = request.typeName;
  if (request.position !== undefined) {
    if (!Number.isInteger(request.position) || request.position < 0 || request.position > sourceFile.text.length) {
      fail("INVALID_RANGE", "position must be a UTF-16 offset within the file");
    }
    const statement = sourceFile.statements.find((item) => item.getStart(sourceFile) <= request.position! && request.position! <= item.end);
    if (statement && ts.isModuleDeclaration(statement)) fail("NAMESPACE_UNSUPPORTED", "types inside TypeScript namespaces are not supported");
    const declaration = types.find((item) => item === statement);
    if (!declaration) fail("TYPE_NOT_FOUND", `position does not select a top-level ${isJs ? "class" : "class, interface, type alias or enum"}`);
    const selected = declaration.name!.getText(sourceFile);
    if (name !== undefined && name !== selected) fail("INVALID_REQUEST", `position selects ${selected} but typeName is ${name}`);
    name = selected;
  }
  if (name === undefined) {
    const names = [...new Set(types.map((declaration) => declaration.name!.getText(sourceFile)))];
    if (names.length === 0) {
      if (namespaced.size) fail("NAMESPACE_UNSUPPORTED", "the file only declares types inside TypeScript namespaces");
      fail("TYPE_NOT_FOUND", `the file declares no top-level ${isJs ? "named class" : "class, interface, type alias or enum"}`);
    }
    if (names.length > 1) fail("AMBIGUOUS_TYPE", `the file declares ${names.join(", ")}; select one with typeName (--type) or position`);
    name = names[0]!;
  }
  const declarations = named(name);
  if (!declarations.length) {
    if (namespaced.has(name)) fail("NAMESPACE_UNSUPPORTED", `${name} is declared inside a TypeScript namespace`);
    fail("TYPE_NOT_FOUND", `${name} is not a top-level ${isJs ? "class" : "class, interface, type alias or enum"} in ${context.file}`);
  }
  return { name, declarations };
}

/** Case check on the real disk: an existing entry spelled differently is the same file on case-insensitive volumes. */
function assertCaseSafe(root: string, path: string): void {
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    let names: string[];
    try { names = readdirSync(current); } catch { return; }
    const next = resolve(current, part);
    if (!names.includes(part)) {
      if (existsSync(next)) {
        const actual = names.find((name) => name.toLowerCase() === part.toLowerCase()) ?? "an existing entry";
        fail("CASE_COLLISION", `${next} differs only in case from ${actual}; this volume is case-insensitive and the change could overwrite data`);
      }
      return;
    }
    current = next;
  }
}

function parseFile(ws: Workspace, path: string): ts.SourceFile | undefined {
  return ws.syntaxFile(path);
}

function userFiles(ws: Workspace): string[] {
  return ws.unionFiles().filter((path) => isInside(ws.root, path) && !path.split(sep).includes("node_modules"));
}

/** Applies language-service edits to the overlays, keeping each file's newline style. */
function applyEdits(context: Context, edits: readonly ts.FileTextChanges[], newFile?: { eol: string; bom: boolean }): void {
  const { ws } = context;
  for (const edit of [...edits].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    const path = resolve(edit.fileName);
    if (!isInside(ws.root, path)) fail("OUTSIDE_ROOT", `TypeScript proposed a change outside ${ws.root}: ${path}`);
    if (path.split(sep).includes("node_modules") || ws.vfs.isHidden(path)) fail("OUTSIDE_PROJECT", `TypeScript proposed a change to a dependency or build output: ${path}`);
    const before = ws.vfs.readFile(path);
    if (edit.isNewFile) {
      if (before !== undefined) fail("TARGET_EXISTS", path);
      if (!newFile) fail("INVALID_EDIT", `unexpected new file ${path}`);
      ws.vfs.write(path, withEol(edit.textChanges.map((change) => change.newText).join(""), newFile.eol), newFile.bom);
      continue;
    }
    if (before === undefined) fail("MISSING_FILE", path);
    const eol = eolOf(before);
    ws.vfs.write(path, applyTextChanges(before, edit.textChanges.map((change) => ({ ...change, newText: withEol(change.newText, eol) }))));
  }
}

function membership(ws: Workspace): Map<string, string[]> {
  return new Map([...ws.participants.values()].map((item) => [item.configPath, ws.fileNames(item.configPath).map((path) => ws.vfs.key(path)).sort()]));
}

/** `gains.path` must join the `must` configs and may join the `may` configs (sibling variants matching it by pattern). */
interface Gains {
  path: string;
  must: string[];
  may: string[];
}

function assertMembership(ws: Workspace, before: Map<string, string[]>, renames: [string, string][], deletions: string[], gains?: Gains | Gains[]): void {
  const vfs = ws.vfs;
  const renameMap = new Map(renames.map(([from, to]) => [vfs.key(from), vfs.key(to)]));
  const deleted = new Set(deletions.map((path) => vfs.key(path)));
  for (const [config, files] of before) {
    const expected = files.filter((key) => !deleted.has(key)).map((key) => renameMap.get(key) ?? key);
    const actual = ws.fileNames(config).map((path) => vfs.key(path)).sort();
    for (const gain of gains ? Array.isArray(gains) ? gains : [gains] : []) {
      if (expected.includes(vfs.key(gain.path))) continue;
      const must = gain.must.some((item) => vfs.samePath(item, config));
      if (must || (gain.may.some((item) => vfs.samePath(item, config)) && actual.includes(vfs.key(gain.path)))) expected.push(vfs.key(gain.path));
    }
    expected.sort();
    const added = actual.filter((key) => !expected.includes(key));
    const missing = expected.filter((key) => !actual.includes(key));
    if (added.length || missing.length) {
      fail("PROJECT_MEMBERSHIP_CHANGED", `${config} would ${[
        added.length ? `gain ${added.map(describeInputPath).join(", ")}` : "",
        missing.length ? `lose ${missing.map(describeInputPath).join(", ")}` : "",
      ].filter(Boolean).join(" and ")}; adjust include/files patterns or choose another target; if a dev server regenerated these inputs, retry after its generators settle`);
    }
  }
}

/** Importer multiset (by importing file) of module specifiers and reference paths that resolve to path. */
function importerMap(ws: Workspace, paths: string[]): Map<string, string[]> {
  const found = new Map(paths.map(path => [ws.vfs.key(path), [] as string[]]));
  for (const file of userFiles(ws)) {
    const sourceFile = parseFile(ws, file);
    if (!sourceFile) continue;
    for (const specifier of moduleSpecifiers(sourceFile)) {
      const resolved = ws.resolveModule(specifier, sourceFile);
      if (resolved) found.get(ws.vfs.key(resolved.resolvedFileName))?.push(ws.vfs.key(file));
    }
    for (const reference of sourceFile.referencedFiles) {
      found.get(ws.vfs.key(resolve(dirname(file), reference.fileName)))?.push(ws.vfs.key(file));
    }
  }
  for (const files of found.values()) files.sort();
  return found;
}

function importers(ws: Workspace, path: string): string[] {
  return importerMap(ws, [path]).get(ws.vfs.key(path))!;
}

function nodeAt(sourceFile: ts.SourceFile, position: number): ts.Node {
  let node: ts.Node = sourceFile;
  for (;;) {
    const child = node.getChildren(sourceFile).find((item) => item.getStart(sourceFile) <= position && position < item.end);
    if (!child) return node;
    node = child;
  }
}

function inModuleSyntax(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current && !ts.isSourceFile(current); current = current.parent) {
    if (ts.isImportSpecifier(current) || ts.isExportSpecifier(current) || ts.isImportClause(current)
      || ts.isNamespaceImport(current) || ts.isImportEqualsDeclaration(current)) return true;
    if (ts.isStatement(current)) return false;
  }
  return false;
}

/** Non-import references per file to the symbol at position; references inside `moved` count toward `movedTo`. */
function referenceCounts(ws: Workspace, file: string, position: number, moved?: { start: number; end: number; to: string }): Map<string, number> {
  const program = ws.program();
  const counts = new Map<string, number>();
  for (const symbol of ws.service.findReferences(file, position) ?? []) {
    for (const entry of symbol.references) {
      if (entry.isDefinition) continue;
      const sourceFile = program.getSourceFile(entry.fileName);
      if (!sourceFile || inModuleSyntax(nodeAt(sourceFile, entry.textSpan.start))) continue;
      const inMoved = moved && ws.vfs.samePath(entry.fileName, file) && entry.textSpan.start >= moved.start && entry.textSpan.start < moved.end;
      const key = ws.vfs.key(inMoved ? moved.to : entry.fileName);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function assertSameCounts(before: Map<string, number>, after: Map<string, number>, name: string): void {
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changed = keys.filter((key) => (before.get(key) ?? 0) !== (after.get(key) ?? 0));
  if (changed.length) {
    fail("REFERENCES_NOT_PRESERVED", `references to ${name} would no longer bind to it in ${changed.map((key) => `${key} (${before.get(key) ?? 0} -> ${after.get(key) ?? 0})`).join(", ")}`);
  }
}

function usesCommonJs(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") found = true;
    else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
      && ((node.expression.text === "module" && node.name.text === "exports") || node.expression.text === "exports")) found = true;
    else if (ts.isExportAssignment(node) && node.isExportEquals) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

const jsEquivalent: Record<string, string> = { ".ts": ".js", ".tsx": ".js", ".mts": ".mjs", ".cts": ".cjs" };

/** Specifier from `from` to `to`, mirroring the extension style of an existing relative specifier. */
function specifierLike(from: string, to: string, original: string, originalTarget: string): string {
  if (!original.startsWith("./") && !original.startsWith("../")) {
    fail("REEXPORT_UNSUPPORTED", `non-relative specifier '${original}' in ${from} cannot be retargeted deterministically`);
  }
  const written = extname(original);
  const targetExtension = extname(to);
  if (![...tsExtensions, ...jsExtensions].includes(targetExtension)) {
    const path = portablePath(relative(dirname(from), to));
    return path.startsWith(".") ? path : `./${path}`;
  }
  let extension = "";
  if ([...tsExtensions, ...jsExtensions].includes(written)) {
    extension = written === extname(originalTarget) ? targetExtension
      : written === ".jsx" && targetExtension === ".tsx" ? ".jsx"
      : jsEquivalent[targetExtension] ?? targetExtension;
  }
  const path = portablePath(relative(dirname(from), to.slice(0, to.length - targetExtension.length))) + extension;
  return path.startsWith(".") ? path : `./${path}`;
}

/** Retarget `export ... from` declarations that re-exported the moved type from its old file. */
function updateReexports(context: Context, target: string, name: string, exported: boolean, sourceDeleted: boolean): void {
  const { ws, file } = context;
  for (const path of userFiles(ws)) {
    if (ws.vfs.samePath(path, target) || ws.vfs.samePath(path, file)) continue;
    const sourceFile = parseFile(ws, path);
    if (!sourceFile) continue;
    const text = sourceFile.text;
    const eol = eolOf(text);
    const changes: ts.TextChange[] = [];
    for (const statement of sourceFile.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const resolved = ws.resolveModule(statement.moduleSpecifier, sourceFile);
      if (!resolved || !ws.vfs.samePath(resolved.resolvedFileName, file)) continue;
      const specifierStart = statement.moduleSpecifier.getStart(sourceFile);
      const quote = text[specifierStart]!;
      const literal = `${quote}${specifierLike(path, target, statement.moduleSpecifier.text, file)}${quote}`;
      const typeOnly = statement.isTypeOnly ? "type " : "";
      if (!statement.exportClause) {
        if (sourceDeleted) changes.push({ span: { start: specifierStart, length: statement.moduleSpecifier.end - specifierStart }, newText: literal });
        else if (exported) changes.push({ span: { start: statement.end, length: 0 }, newText: `${eol}export ${typeOnly}{ ${name} } from ${literal};` });
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        if (exported) fail("REEXPORT_UNSUPPORTED", `${path} re-exports ${file} as namespace '${statement.exportClause.name.getText(sourceFile)}'; moving ${name} would change that namespace`);
      } else {
        const elements = statement.exportClause.elements;
        const moved = elements.filter((element) => (element.propertyName ?? element.name).text === name);
        if (!moved.length) continue;
        const kept = elements.filter((element) => !moved.includes(element));
        const movedDeclaration = `export ${typeOnly}{ ${moved.map((element) => element.getText(sourceFile)).join(", ")} } from ${literal};`;
        if (!kept.length) {
          const start = statement.getStart(sourceFile);
          changes.push({ span: { start, length: statement.end - start }, newText: movedDeclaration });
        } else {
          const start = statement.exportClause.getStart(sourceFile);
          changes.push({ span: { start, length: statement.exportClause.end - start }, newText: `{ ${kept.map((element) => element.getText(sourceFile)).join(", ")} }` });
          changes.push({ span: { start: statement.end, length: 0 }, newText: `${eol}${movedDeclaration}` });
        }
      }
    }
    if (changes.length) ws.vfs.write(path, applyTextChanges(text, changes));
  }
}

interface ModuleEdge {
  file: string;
  target: string;
  from: string[];
  to: string[];
}

/** Resolved module edges from files owned by a loaded project to user files (not dependencies or build outputs). */
function moduleEdges(ws: Workspace, files: string[], owners: (path: string) => string[]): ModuleEdge[] {
  const edges: ModuleEdge[] = [];
  for (const file of files) {
    const from = owners(file);
    if (!from.length) continue;
    const sourceFile = parseFile(ws, file);
    if (!sourceFile) continue;
    const options = ws.participant(from[0]!).parsed.options;
    for (const specifier of moduleSpecifiers(sourceFile)) {
      const resolved = ws.resolveModule(specifier, sourceFile, options);
      if (!resolved) continue;
      const target = resolve(resolved.resolvedFileName);
      if (!isInside(ws.root, target) || target.split(sep).includes("node_modules") || ws.vfs.isHidden(target)) continue;
      edges.push({ file, target, from, to: owners(target) });
    }
  }
  return edges;
}

/**
 * Module edges from changed files that their projects cannot compile. A
 * project may import another project's source directly when neither is
 * composite (tsc then compiles that source as part of the importer, which the
 * per-project validation checks); composite projects are only reachable
 * through project references.
 */
function accessViolations(ws: Workspace, files: string[], owners: (path: string) => string[]): Map<string, string> {
  const violations = new Map<string, string>();
  const composite = (config: string) => !!ws.participant(config).parsed.options.composite;
  for (const { file, target, from, to } of moduleEdges(ws, files, owners)) {
    if (to.length === 0) {
      if (/\.d\.[cm]?ts$/.test(target)) continue;
    } else {
      const reachable = from.some((owner) => to.some((targetOwner) => ws.vfs.samePath(owner, targetOwner)
        || ws.references(owner).some((reference) => ws.vfs.samePath(reference, targetOwner))));
      if (reachable || ![...from, ...to].some(composite)) continue;
    }
    const key = `${ws.vfs.key(file)}\0${ws.vfs.key(target)}`;
    violations.set(key, to.length
      ? `${file} (${from.join(", ")}) would import ${target} from ${to.join(", ")}, which it does not reference (composite projects require project references)`
      : `${file} would import ${target}, which belongs to no loaded project`);
  }
  return violations;
}

/** Project-level dependency graph (config key -> config keys) from direct imports and project references. */
function projectGraph(ws: Workspace, files: string[], owners: (path: string) => string[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    if (ws.vfs.samePath(from, to)) return;
    const targets = graph.get(ws.vfs.key(from)) ?? new Set<string>();
    targets.add(ws.vfs.key(to));
    graph.set(ws.vfs.key(from), targets);
  };
  for (const item of ws.participants.values()) for (const reference of item.references) link(item.configPath, reference);
  for (const edge of moduleEdges(ws, files, owners)) for (const from of edge.from) for (const to of edge.to) link(from, to);
  return graph;
}

/** New project-level edges that close a dependency cycle between projects. */
function introducedCycles(before: Map<string, Set<string>>, after: Map<string, Set<string>>): string[] {
  const reaches = (from: string, to: string) => {
    const seen = new Set<string>();
    const pending = [from];
    while (pending.length) {
      const current = pending.pop()!;
      if (current === to) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...(after.get(current) ?? []));
    }
    return false;
  };
  const cycles: string[] = [];
  for (const [from, targets] of [...after].sort(([a], [b]) => a.localeCompare(b))) {
    for (const to of [...targets].sort()) {
      if (!before.get(from)?.has(to) && reaches(to, from)) cycles.push(`${from} -> ${to}`);
    }
  }
  return cycles;
}

function renameFile(context: Context, request: RefactorRequest): { renamed?: [string, string] } {
  const { ws, file, root } = context;
  if (request.targetProject && !ws.vfs.samePath(configPathFor(assertAbsolute("targetProject", request.targetProject)), ws.sourceConfig)) {
    fail("INVALID_REQUEST", "rename-file keeps the file in its project; targetProject must be omitted");
  }
  const { name } = selectType(context, request);
  const target = resolve(dirname(file), `${name}${extname(file)}`);
  if (request.target !== undefined && assertAbsolute("target", request.target) !== target) {
    fail("INVALID_REQUEST", `rename-file derives its destination from the type name: ${target}`);
  }
  if (target === file) {
    context.notes.push(`${file} already matches ${name}; no changes planned.`);
    return {};
  }
  if (ws.vfs.samePath(target, file)) {
    if (!ws.vfs.caseSensitive) {
      fail("CASE_ONLY_RENAME_UNSUPPORTED", `${file} -> ${target} differs only in case on a case-insensitive volume; rename through an intermediate name`);
    }
  } else {
    if (ws.vfs.fileExists(target) || ws.vfs.directoryExists(target)) fail("TARGET_EXISTS", target);
    assertCaseSafe(root, target);
  }

  const before = membership(ws);
  const importersBefore = importers(ws, file).map((key) => ws.vfs.samePath(key, file) ? ws.vfs.key(target) : key);
  const text = ws.vfs.readFile(file)!;
  applyEdits(context, ws.service.getEditsForFileRename(file, target, formatFor(text), preferencesFor(ws)));
  const bom = ws.vfs.hasBom(file);
  const moved = ws.vfs.readFile(file)!;
  ws.vfs.write(file, null);
  ws.vfs.write(target, moved, bom);
  ws.updateConfigLists([[file, target]], []);
  ws.reparse();
  assertMembership(ws, before, [[file, target]], []);
  const stale = importers(ws, file);
  if (stale.length) fail("REFERENCES_NOT_PRESERVED", `imports in ${[...new Set(stale)].join(", ")} still name ${file}`);
  const importersAfter = importers(ws, target);
  if (JSON.stringify(importersAfter) !== JSON.stringify(importersBefore.sort())) {
    fail("REFERENCES_NOT_PRESERVED", `${importersBefore.length} module references resolved to ${file} but ${importersAfter.length} resolve to ${target}`);
  }
  return { renamed: [file, target] };
}

function topLevelNames(sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const names = new Map<string, ts.Node>();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name) names.set(clause.name.text, statement);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.set(clause.namedBindings.name.text, statement);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) names.set(element.name.text, statement);
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.set(declaration.name.text, statement);
      }
    } else if ("name" in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) {
      names.set((statement.name as ts.Identifier).text, statement);
    }
  }
  return names;
}

/** Moving runtime evaluation into another module must not reorder observable effects. */
function assertSafeInitialization(declaration: ts.DeclarationStatement): void {
  const reject = () => fail("INITIALIZATION_EFFECTS_UNSUPPORTED", "move-type cannot preserve runtime initialization order for this declaration; static effects, computed names, decorators and evaluated base classes are unsupported");
  // Only primitive constants are accepted as eager expressions. Identifiers,
  // property access and even otherwise pure calls can observe evaluation order.
  const constant = (expression: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
      || ts.isSatisfiesExpression(expression)) return constant(expression.expression);
    if (ts.isPrefixUnaryExpression(expression)) return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.TildeToken].includes(expression.operator)
      && constant(expression.operand);
    return ts.isNumericLiteral(expression) || ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
      || ts.isBigIntLiteral(expression) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(expression.kind);
  };
  if (ts.isEnumDeclaration(declaration)) {
    if (declaration.members.some(member => member.initializer && !constant(member.initializer))) reject();
  }
  if (!ts.isClassDeclaration(declaration)) return;
  if (ts.getDecorators(declaration)?.length || declaration.heritageClauses?.some(clause => clause.token === ts.SyntaxKind.ExtendsKeyword
    && clause.types.some(type => !ts.isIdentifier(type.expression)))) reject();
  for (const member of declaration.members) {
    if ((ts.canHaveDecorators(member) && ts.getDecorators(member)?.length) || ts.isClassStaticBlockDeclaration(member)
      || (member.name && ts.isComputedPropertyName(member.name))) reject();
    if (ts.isConstructorDeclaration(member) && member.parameters.some(parameter => ts.getDecorators(parameter)?.length)) reject();
    if (ts.isPropertyDeclaration(member) && ts.getModifiers(member)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)
      && member.initializer && !constant(member.initializer)) reject();
  }
}

/** Identity of an imported binding, independent of its local name or specifier spelling. */
function importedTarget(ws: Workspace, binding: ts.Declaration): string | undefined {
  const imported = ts.isImportSpecifier(binding) ? (binding.propertyName ?? binding.name).text
    : ts.isImportClause(binding) ? "default" : ts.isNamespaceImport(binding) ? "*" : undefined;
  if (imported === undefined) return undefined;
  let parent: ts.Node = binding;
  while (parent.parent && !ts.isImportDeclaration(parent)) parent = parent.parent;
  if (!ts.isImportDeclaration(parent) || !ts.isStringLiteralLike(parent.moduleSpecifier)) return undefined;
  const resolved = ws.resolveModule(parent.moduleSpecifier, parent.getSourceFile());
  return resolved ? `${ws.vfs.key(resolved.resolvedFileName)}\0${imported}` : undefined;
}

/** Imported bindings used by a declaration, resolved with the containing project's options. */
function typeImportTargets(ws: Workspace, declaration: ts.Node): Set<string> {
  const checker = ws.program().getTypeChecker();
  const targets = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) for (const binding of checker.getSymbolAtLocation(node)?.declarations ?? []) {
      const target = importedTarget(ws, binding);
      if (target) targets.add(target);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      const resolved = ws.resolveModule(node.argument.literal, node.getSourceFile());
      if (resolved) targets.add(`${ws.vfs.key(resolved.resolvedFileName)}\0import-type:${node.qualifier?.getText() ?? "*"}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  return targets;
}

function moveType(context: Context, request: RefactorRequest): void {
  const { ws, file, root, sourceFile, isJs } = context;
  const target = assertAbsolute("target", request.target);
  if (!isInside(root, target)) fail("OUTSIDE_ROOT", `target is outside ${root}`);
  const targetExtension = sourceExtension(target);
  if (!(isJs ? jsExtensions : tsExtensions).includes(targetExtension)) {
    fail("UNSUPPORTED_TARGET", `a ${isJs ? "JavaScript" : "TypeScript"} type must move to a ${isJs ? jsExtensions.join("/") : tsExtensions.join("/")} file`);
  }
  if (ws.vfs.samePath(target, file)) fail("INVALID_REQUEST", "target must differ from the source file");
  if (!ts.isExternalModule(sourceFile)) fail("MODULE_REQUIRED", "move-type requires an ES module source file (with import or export)");
  if (isJs && usesCommonJs(sourceFile)) fail("COMMONJS_UNSUPPORTED", "CommonJS require/exports are not supported by move-type");

  const { name, declarations } = selectType(context, request);
  if (declarations.length !== 1) fail("MERGED_DECLARATION_UNSUPPORTED", `${name} has ${declarations.length} merged declarations`);
  const declaration = declarations[0]!;
  assertSafeInitialization(declaration);
  const program = ws.program();
  const programSource = program.getSourceFile(file)!;
  const nameStart = declaration.name!.getStart(sourceFile);
  const symbol = program.getTypeChecker().getSymbolAtLocation(nodeAt(programSource, nameStart));
  if (!symbol || (symbol.declarations?.length ?? 0) !== 1) {
    fail("MERGED_DECLARATION_UNSUPPORTED", `${name} merges with other declarations (namespace, interface or global augmentation)`);
  }
  const importedTargets = typeImportTargets(ws, declaration);
  const exported = (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) !== 0;

  const targetExists = ws.vfs.fileExists(target);
  if (!targetExists && ws.vfs.directoryExists(target)) fail("TARGET_EXISTS", `${target} is a directory`);
  assertCaseSafe(root, target);
  if (targetExists) {
    const owners = ws.ownersOf(target);
    if (owners.length !== 1 || !ws.vfs.samePath(owners[0]!, ws.targetConfig)) {
      fail("TARGET_NOT_IN_PROJECT", `${target} must belong to exactly ${ws.targetConfig}; owners: ${owners.join(", ") || "none"}`);
    }
    const targetSource = program.getSourceFile(target)!;
    if (!ts.isExternalModule(targetSource)) fail("MODULE_REQUIRED", `${target} is not an ES module`);
    if (isJs && usesCommonJs(targetSource)) fail("COMMONJS_UNSUPPORTED", `${target} uses CommonJS`);
    const existing = topLevelNames(targetSource).get(name);
    const importsMoved = existing && ts.isImportDeclaration(existing) && ts.isStringLiteral(existing.moduleSpecifier)
      && ws.vfs.samePath(ws.resolveModule(existing.moduleSpecifier, targetSource)?.resolvedFileName ?? "", file);
    if (existing && !importsMoved) fail("TARGET_CONFLICT", `${target} already declares ${name}`);
  }

  const before = membership(ws);
  const beforeOwners = new Map<string, string[]>();
  for (const [config, keys] of before) {
    if (ws.isObserver(config)) continue;
    for (const key of keys) beforeOwners.set(key, [...(beforeOwners.get(key) ?? []), config]);
  }
  // Variant configs next to the target project that compile the source must compile the moved type too.
  const listedBefore = (config: string, path: string) => before.get(config)!.includes(ws.vfs.key(path));
  const siblings = ws.observers().filter((config) => ws.vfs.samePath(dirname(config), dirname(ws.targetConfig)));
  const mirroring = siblings.filter((config) => listedBefore(config, file) && !listedBefore(config, target));
  const statementStart = declaration.getStart(sourceFile);
  const moduleGraph = () => {
    const graph = new Map<string, Set<string>>();
    for (const edge of moduleEdges(ws, userFiles(ws), path => ws.ownersOf(path))) {
      const from = ws.vfs.key(edge.file), to = ws.vfs.key(edge.target);
      graph.set(from, new Set([...(graph.get(from) ?? []), to]));
    }
    return graph;
  };
  const modulesBefore = ts.isClassDeclaration(declaration) ? moduleGraph() : undefined;
  const countsBefore = referenceCounts(ws, file, nameStart, { start: declaration.pos, end: declaration.end, to: target });

  const range = { pos: statementStart, end: declaration.end };
  const preferences = preferencesFor(ws);
  const action = ws.service.getApplicableRefactors(file, range, preferences, "invoked", undefined, true)
    .filter((refactor) => refactor.name === "Move to file")
    .flatMap((refactor) => refactor.actions)
    .find((item) => item.name === "Move to file");
  if (!action || action.notApplicableReason) fail("REFACTOR_UNAVAILABLE", action?.notApplicableReason ?? `TypeScript cannot move ${name}`);
  const result = ws.service.getEditsForRefactor(file, formatFor(sourceFile.text), range, "Move to file", "Move to file", preferences, { targetFile: target });
  if (!result || result.notApplicableReason || !result.edits.length) fail("REFACTOR_UNAVAILABLE", result?.notApplicableReason ?? "TypeScript returned no edits");
  applyEdits(context, result.edits, { eol: eolOf(sourceFile.text), bom: ws.vfs.hasBom(file) });
  if (!ws.vfs.fileExists(target)) fail("REFACTOR_UNAVAILABLE", "TypeScript did not produce the target file");

  const remaining = parseFile(ws, file)!;
  const sourceDeleted = remaining.statements.length === 0;
  updateReexports(context, target, name, exported, sourceDeleted);
  if (sourceDeleted) {
    if (remaining.text.trim()) context.notes.push(`${file} only kept comments after the move and is deleted; its previous content is in the plan.`);
    else context.notes.push(`${file} is empty after the move and is deleted.`);
    const stale = importers(ws, file);
    if (stale.length) fail("SOURCE_STILL_REFERENCED", `${[...new Set(stale)].join(", ")} still import ${file}, which would be empty after the move`);
    ws.vfs.write(file, null);
  }

  const substitutions = new Map(sourceDeleted ? mirroring.map((config) => [ws.vfs.key(config), [[file, target] as [string, string]]]) : []);
  ws.updateConfigLists([], sourceDeleted ? [file] : [], substitutions);
  ws.reparse();
  const includes = (config: string) => ws.fileNames(config).some((path) => ws.vfs.samePath(path, target));
  for (const config of [...(targetExists ? [] : [ws.targetConfig]), ...mirroring]) {
    if (includes(config)) continue;
    if (!ws.addToFiles(config, target)) {
      fail("TARGET_NOT_IN_PROJECT", `${target} is not matched by the include patterns of ${config}`);
    }
    ws.reparse();
    context.notes.push(`Added ${target} to the files list of ${config}.`);
  }
  assertMembership(ws, before, [], sourceDeleted ? [file] : [], {
    path: target,
    must: [...(targetExists ? [] : [ws.targetConfig]), ...mirroring],
    may: targetExists ? [] : siblings,
  });

  const targetSource = ws.program().getSourceFile(target);
  const movedDeclaration = targetSource && declaredTypes(targetSource, isJs).find((item) => item.name?.getText(targetSource) === name);
  if (!targetSource || !movedDeclaration) fail("REFACTOR_UNAVAILABLE", `${name} was not found in ${target} after the move`);
  assertSameCounts(countsBefore, referenceCounts(ws, target, movedDeclaration.name!.getStart(targetSource)), name);
  context.verify = () => {
    const actual = typeImportTargets(ws, movedDeclaration);
    for (const dependency of importedTargets) {
      if (!actual.has(dependency)) fail("REFERENCES_NOT_PRESERVED", `${name} in ${target} no longer imports ${dependency.replace("\0", " export ")}`);
    }
  };

  const changed = ws.vfs.changes().filter((change) => change.after !== null && !/\.json$/i.test(change.path)).map((change) => change.path);
  const afterViolations = accessViolations(ws, changed, (path) => ws.ownersOf(path));
  const beforeViolations = ws.vfs.original(() => accessViolations(ws, changed.filter((path) => ws.vfs.diskText(path) !== null),
    (path) => beforeOwners.get(ws.vfs.key(path)) ?? []));
  const introduced = [...afterViolations].filter(([key]) => !beforeViolations.has(key)).map(([, message]) => message);
  if (introduced.length) fail("INACCESSIBLE_DEPENDENCY", `${introduced.join("; ")}; add a project reference or move dependencies first`);

  if (ws.vfs.samePath(ws.sourceConfig, ws.targetConfig)) {
    if (modulesBefore && introducedCycles(modulesBefore, moduleGraph()).length) {
      fail("MODULE_DEPENDENCY_CYCLE", "moving this runtime class introduces a module cycle; initialization order cannot be preserved safely");
    }
    return;
  }
  const graphAfter = projectGraph(ws, userFiles(ws), (path) => ws.ownersOf(path));
  const graphBefore = ws.vfs.original(() => projectGraph(ws, userFiles(ws), (path) => beforeOwners.get(ws.vfs.key(path)) ?? []));
  const cycles = introducedCycles(graphBefore, graphAfter);
  if (cycles.length) {
    fail("PROJECT_DEPENDENCY_CYCLE", `the move would make projects depend on each other (${cycles.join("; ")}); move the type's dependencies first or choose another target`);
  }
}

/** Enumerate actual files, including assets; unsupported encodings and symlinks fail before any overlay edits. */
function movePaths(root: string, file: string, target: string, exclude: string[] = []): [string, string][] {
  if (!isInside(root, target)) fail("OUTSIDE_ROOT", `target is outside ${root}`);
  let stat;
  try { stat = lstatSync(file); } catch { fail("FILE_NOT_FOUND", file); }
  if (stat.isSymbolicLink()) fail("SYMLINK_UNSUPPORTED", file);
  if (stat.isFile()) {
    if (exclude.length) fail("INVALID_REQUEST", "--exclude requires directory sources");
    if (extname(file) !== extname(target)) fail("UNSUPPORTED_TARGET", "move-file must retain the file extension");
    return [[file, target]];
  }
  if (!stat.isDirectory()) fail("UNSUPPORTED_FILE", file);
  if (isInside(file, target) || isInside(target, file)) fail("INVALID_REQUEST", "source and destination directories must not overlap");
  const paths: [string, string][] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      if (excludedByPatterns(path, file, exclude)) continue;
      if (entry.isSymbolicLink()) fail("SYMLINK_UNSUPPORTED", path);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) paths.push([path, resolve(target, relative(file, path))]);
      else fail("UNSUPPORTED_FILE", path);
    }
  };
  visit(file);
  if (!paths.length) fail("EMPTY_DIRECTORY", `${file} contains no files`);
  return paths;
}

interface RelocatedImport {
  file: string;
  index: number;
  target: string;
  original: string;
  alias: boolean;
}

/** Resolve before relocation, using each importer's own config rather than the union service's paths aliases. */
function relocationImports(ws: Workspace, renames: [string, string][]): RelocatedImport[] {
  const moved = new Set(renames.map(([from]) => ws.vfs.key(from)));
  const imports: RelocatedImport[] = [];
  for (const file of userFiles(ws)) {
    const source = parseFile(ws, file);
    if (!source) continue;
    const owner = ws.ownersOf(file)[0];
    const options = owner ? ws.participant(owner).parsed.options : ws.editOptions;
    moduleSpecifiers(source).forEach((specifier, index) => {
      const resolved = ws.resolveModule(specifier, source, options);
      if (!resolved) return;
      const target = resolve(resolved.resolvedFileName);
      if (!moved.has(ws.vfs.key(file)) && !moved.has(ws.vfs.key(target))) return;
      const alias = Object.keys(options.paths ?? {}).some(pattern => {
        const [prefix, suffix] = pattern.split("*");
        return pattern.includes("*") ? specifier.text.startsWith(prefix!) && specifier.text.endsWith(suffix!) : pattern === specifier.text;
      });
      imports.push({ file, index, target, original: specifier.text, alias });
    });
  }
  return imports;
}

/** Asset URL strings are outside the semantic module graph: identify consumers needing hand edits. */
function reportAssetReferences(ws: Workspace, renames: [string, string][], notes: string[]): void {
  const moved = new Map(renames.map(([from, to]) => [ws.vfs.key(from), to]));
  for (const path of userFiles(ws)) {
    if (moved.has(ws.vfs.key(path))) continue;
    const source = parseFile(ws, path);
    if (!source) continue;
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL"
        && node.arguments?.length === 2 && ts.isStringLiteralLike(node.arguments[0]!)
        && node.arguments[1]!.getText(source).replace(/\s/g, "") === "import.meta.url") {
        const target = moved.get(ws.vfs.key(resolve(dirname(path), node.arguments[0]!.text)));
        if (target) notes.push(`Review asset URL in ${relative(ws.root, path)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: new URL(${JSON.stringify(node.arguments[0]!.text)}, import.meta.url) refers to a moved file; destination ${relative(ws.root, target)}.`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

function moveFile(context: Context, request: RefactorRequest, renames: [string, string][]): void {
  const { ws, root, file } = context;
  const target = assertAbsolute("target", request.target);
  const directory = lstatSync(file).isDirectory();
  if (ws.vfs.samePath(file, target)) fail("INVALID_REQUEST", "target must differ from the source");
  if (ws.vfs.fileExists(target) || (!directory && ws.vfs.directoryExists(target))) fail("TARGET_EXISTS", target);
  for (const [from, to] of renames) {
    if (ws.vfs.fileExists(to) || ws.vfs.directoryExists(to)) fail("TARGET_EXISTS", to);
    assertCaseSafe(root, to);
    const bytes = readFileSync(from);
    if (!Buffer.from(bytes.toString("utf8")).equals(bytes)) fail("UNSUPPORTED_ENCODING", `${from}: move-file plans require UTF-8 text`);
  }
  reportAssetReferences(ws, renames, context.notes);
  const before = membership(ws);
  const beforeOwners = new Map<string, string[]>();
  for (const [config, keys] of before) {
    if (ws.isObserver(config)) continue;
    for (const key of keys) beforeOwners.set(key, [...(beforeOwners.get(key) ?? []), config]);
  }
  const graphBefore = projectGraph(ws, userFiles(ws), path => ws.ownersOf(path));
  const updateMocks = prepareMoveMocks(ws, renames, request, context.notes);
  for (const [from, to] of renames) {
    const source = parseFile(ws, from);
    if (!source) continue;
    const mapped = mapMoveImports(source, moveMappings(root, to, request.map, ws.vfs.inputs.sys));
    if (mapped !== source.text) ws.vfs.write(from, mapped);
  }
  const references = userFiles(ws).flatMap(path => {
    const source = parseFile(ws, path);
    return source?.referencedFiles.map(reference => ({ file: path, start: reference.pos, length: reference.end - reference.pos, target: resolve(dirname(path), reference.fileName) })) ?? [];
  });
  const imports = relocationImports(ws, renames);
  const mapping = new Map(renames.map(([from, to]) => [ws.vfs.key(from), to]));
  const relocated = (path: string) => mapping.get(ws.vfs.key(path)) ?? path;
  const styleCache = new Map<string, string | null>();
  const retargeted = imports.filter(edge => (mapping.has(ws.vfs.key(edge.file)) && edge.original.startsWith(".")) || mapping.has(ws.vfs.key(edge.target))
    || (mapping.has(ws.vfs.key(edge.file)) && packageSelfImport(ws, relocated(edge.file), relocated(edge.target), edge.original)));
  const styles = new Map(retargeted.map(edge => [edge, relativeStyle(ws, relocated(edge.target), edge.original, styleCache)]));
  const pendingImports = userFiles(ws).flatMap(file => {
    const source = parseFile(ws, file);
    return source ? moduleSpecifiers(source).flatMap((specifier, index) => ws.resolveModule(specifier, source) ? [] : [{ file, index, original: specifier.text }]) : [];
  });
  const beforeImporters = importerMap(ws, renames.flatMap(([from, to]) => [from, to]));
  const expectedImporters = new Map(renames.map(([from, to]) => [to,
    [...beforeImporters.get(ws.vfs.key(from))!, ...beforeImporters.get(ws.vfs.key(to))!].map(relocated).map(path => ws.vfs.key(path)).sort()]));
  if (!request.moves && !request.exclude?.length) applyEdits(context, ws.service.getEditsForFileRename(file, target, formatFor(context.sourceFile.text), preferencesFor(ws)));
  for (const [from, to] of renames) {
    const text = ws.vfs.readFile(from)!;
    const bom = ws.vfs.hasBom(from);
    ws.vfs.write(from, null);
    ws.vfs.write(to, text, bom);
  }

  const sameProject = ws.vfs.samePath(ws.sourceConfig, ws.targetConfig);
  const directoryRenames: [string, string][] = (request.moves ?? [{ file, target }])
    .filter(move => !request.exclude?.length && lstatSync(move.file).isDirectory()).map(move => [move.file, move.target]);
  const configRenames: [string, string][] = [...directoryRenames, ...renames];
  const substitutions = new Map<string, [string, string][]>();
  // A source config loses moved files across projects; target variants retain explicit lists via substitutions.
  if (!sameProject) for (const item of ws.participants.values()) {
    if (ws.vfs.samePath(dirname(item.configPath), dirname(ws.targetConfig))) substitutions.set(ws.vfs.key(item.configPath), configRenames);
  }
  ws.updateConfigLists(sameProject ? configRenames : [], sameProject ? [] : configRenames.map(([from]) => from), substitutions);
  ws.reparse();
  const sourceRenames = renames.filter(([from]) => [...before.values()].some(files => files.includes(ws.vfs.key(from))));
  const siblings = ws.observers().filter(config => ws.vfs.samePath(dirname(config), dirname(ws.targetConfig)));
  for (const [, to] of sourceRenames) {
    if (!ws.fileNames(ws.targetConfig).some(path => ws.vfs.samePath(path, to))) {
      if (!ws.addToFiles(ws.targetConfig, to)) fail("TARGET_NOT_IN_PROJECT", `${to} is not matched by the include patterns of ${ws.targetConfig}`);
      ws.reparse();
    }
    const owners = ws.ownersOf(to);
    if (owners.length !== 1 || !ws.vfs.samePath(owners[0]!, ws.targetConfig)) fail("TARGET_NOT_IN_PROJECT", `${to} must belong to exactly ${ws.targetConfig}; owners: ${owners.join(", ") || "none"}`);
  }
  assertMembership(ws, before, sameProject ? sourceRenames : [], sameProject ? [] : sourceRenames.map(([from]) => from),
    sameProject ? undefined : sourceRenames.map(([, path]) => ({ path, must: [ws.targetConfig], may: siblings })));

  const changes = new Map<string, ts.TextChange[]>();
  for (const edge of retargeted) {
    const from = relocated(edge.file), to = relocated(edge.target);
    const source = parseFile(ws, from)!;
    const specifier = moduleSpecifiers(source)[edge.index];
    if (!specifier) fail("REFERENCES_NOT_PRESERVED", `module specifier disappeared in ${from}`);
    const owner = ws.ownersOf(from)[0];
    const options = owner ? ws.participant(owner).parsed.options : ws.editOptions;
    const bare = mapping.has(ws.vfs.key(edge.target)) || !edge.original.startsWith(".")
      ? packageSpecifier(ws, from, to, ts.getModeForUsageLocation(source, specifier, options)) : undefined;
    const style = styles.get(edge)!;
    const name = bare ?? specifierLike(from, to, style, edge.target);
    const start = specifier.getStart(source) + 1;
    const list = changes.get(from) ?? [];
    list.push({ span: { start, length: specifier.end - start - 1 }, newText: JSON.stringify(name).slice(1, -1) });
    changes.set(from, list);
  }
  if (request.moves || request.exclude?.length) for (const reference of references) {
    if (!mapping.has(ws.vfs.key(reference.file)) && !mapping.has(ws.vfs.key(reference.target))) continue;
    const from = relocated(reference.file), to = relocated(reference.target);
    const path = portablePath(relative(dirname(from), to));
    const edits = changes.get(from) ?? [];
    edits.push({ span: { start: reference.start, length: reference.length }, newText: path.startsWith(".") ? path : `./${path}` });
    changes.set(from, edits);
  }
  for (const [path, edits] of changes) ws.vfs.write(path, applyTextChanges(ws.vfs.readFile(path)!, edits));
  ws.reparse();
  for (const edge of pendingImports) {
    const from = relocated(edge.file), source = parseFile(ws, from);
    const specifier = source && moduleSpecifiers(source)[edge.index];
    if (!source || !specifier || specifier.text !== edge.original) continue;
    for (const [, to] of renames) if (anticipatePackageExport(ws, to, edge.original)) {
      const owner = ws.ownersOf(from)[0];
      const options = owner ? ws.participant(owner).parsed.options : ws.editOptions;
      packageSpecifier(ws, from, to, ts.getModeForUsageLocation(source, specifier, options));
      const resolved = ws.resolveModule(specifier, source, options);
      if (!resolved || !ws.vfs.samePath(resolved.resolvedFileName, to)) fail("REFERENCES_NOT_PRESERVED", `${edge.original} in ${from} must resolve to anticipated destination ${to}`);
    }
  }
  context.aliasHints = imports.filter(edge => edge.alias && mapping.has(ws.vfs.key(edge.file)) && !mapping.has(ws.vfs.key(edge.target)))
    .filter(edge => {
      const source = parseFile(ws, relocated(edge.file))!;
      const specifier = moduleSpecifiers(source)[edge.index];
      return specifier && !ws.resolveModule(specifier, source, ws.participant(ws.targetConfig).parsed.options);
    }).map(edge => `${edge.original} (${relocated(edge.file)})`);

  const changed = ws.vfs.changes().filter(change => change.after !== null && /\.[cm]?[jt]sx?$/.test(change.path)).map(change => change.path);
  const afterViolations = accessViolations(ws, changed, path => ws.ownersOf(path));
  const originals = new Map(renames.map(([from, to]) => [ws.vfs.key(to), from]));
  const originalPaths = changed.map(path => originals.get(ws.vfs.key(path)) ?? path);
  const beforeViolations = ws.vfs.original(() => accessViolations(ws, originalPaths.filter(path => ws.vfs.diskText(path) !== null), path => beforeOwners.get(ws.vfs.key(path)) ?? []));
  const priorKeys = new Set([...beforeViolations.keys()].map(key => key.split("\0").map(relocated).map(path => ws.vfs.key(path)).join("\0")));
  const introduced = [...afterViolations].filter(([key]) => !priorKeys.has(key)).map(([, message]) => message);
  if (introduced.length) fail("INACCESSIBLE_DEPENDENCY", `${introduced.join("; ")}; add a project reference or move dependencies first`);
  const cycles = introducedCycles(graphBefore, projectGraph(ws, userFiles(ws), path => ws.ownersOf(path)));
  if (cycles.length) fail("PROJECT_DEPENDENCY_CYCLE", `the move introduces project cycles (${cycles.join("; ")}); move dependencies first`);
  context.verify = () => {
    for (const edge of imports) {
      const from = relocated(edge.file), to = relocated(edge.target);
      const source = parseFile(ws, from)!;
      const specifier = moduleSpecifiers(source)[edge.index];
      const resolved = specifier && ws.resolveModule(specifier, source);
      if (!resolved || !ws.vfs.samePath(resolved.resolvedFileName, to)) {
        fail("REFERENCES_NOT_PRESERVED", `${edge.original} in ${from} must still resolve to ${to}`);
      }
    }
    // A caller may already name a destination that did not exist before the
    // move. Admit only original unresolved edges whose unchanged text now binds
    // to that destination; references previously bound elsewhere stay protected.
    const additional = new Map(renames.map(([, to]) => [ws.vfs.key(to), [] as string[]]));
    for (const edge of pendingImports) {
      const from = relocated(edge.file), source = parseFile(ws, from);
      const specifier = source && moduleSpecifiers(source)[edge.index];
      if (!source || !specifier || specifier.text !== edge.original) continue;
      const resolved = ws.resolveModule(specifier, source);
      if (resolved) additional.get(ws.vfs.key(resolved.resolvedFileName))?.push(ws.vfs.key(from));
    }
    const afterImporters = importerMap(ws, renames.map(([, to]) => to));
    for (const [to, original] of expectedImporters) {
      const expected = [...original, ...additional.get(ws.vfs.key(to))!].sort();
      const actual = afterImporters.get(ws.vfs.key(to))!;
      if (JSON.stringify(expected) !== JSON.stringify(actual)) fail("REFERENCES_NOT_PRESERVED", `${expected.length} module references expected for ${to}, found ${actual.length}`);
    }
  };
  updateMocks((path, source, edits) => {
    // Parallel registrations are inserted beside existing mocks, so keep the
    // original edge identities aligned before running reference preservation.
    const specifiers = moduleSpecifiers(source);
    const inserted = edits.map(edit => ({ start: edit.start, count: moduleSpecifiers(ts.createSourceFile(path, edit.text, ts.ScriptTarget.Latest, true)).length }));
    for (const edge of [...imports, ...pendingImports]) {
      if (!ws.vfs.samePath(relocated(edge.file), path)) continue;
      const start = specifiers[edge.index]?.getStart(source);
      if (start !== undefined) edge.index += inserted.filter(edit => edit.start <= start).reduce((sum, edit) => sum + edit.count, 0);
    }
  });
  moveSuppressions(ws, renames, context.notes);
  const summary = request.moves
    ? ` across ${request.moves.length} pair(s): ${request.moves.map(move => `${relative(root, move.file)} -> ${relative(root, move.target)}`).join(", ")}`
    : ` from ${relative(root, file)} to ${relative(root, target)}`;
  context.notes.push(`Moved ${renames.length} file(s)${summary}; validated source and target project membership.`);
}

/** --only names declarations exported by this file, rather than import bindings to map. */
function selectedStatement(source: ts.SourceFile, name: string): ts.Statement {
  const matches = source.statements.filter(statement => {
    if (!ts.canHaveModifiers(statement) || ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) || !ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return false;
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === name);
    return "name" in statement && statement.name && ts.isIdentifier(statement.name as ts.Node) && (statement.name as ts.Identifier).text === name;
  });
  if (matches.length !== 1) fail("UNSUPPORTED_SELECTION", `${source.fileName}: --only requires one exported declaration for '${name}' (merged declarations and re-exports are unsupported)`);
  const statement = matches[0]!;
  if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length !== 1) fail("UNSUPPORTED_SELECTION", `${name}: split multi-variable declarations before moving`);
  if (ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) assertSafeInitialization(statement);
  if (ts.isVariableStatement(statement)) fail("UNSUPPORTED_SELECTION", `${name}: runtime variable initialization requires a whole-file move`);
  return statement;
}

function moveSelected(context: Context, request: RefactorRequest): void {
  const { ws, file, sourceFile, root } = context;
  const target = assertAbsolute("target", request.target);
  if (request.moves || lstatSync(file).isDirectory()) fail("UNSUPPORTED_SELECTION", "--only requires one source file; batch whole files separately");
  if (!request.only?.length || new Set(request.only).size !== request.only.length) fail("INVALID_REQUEST", "--only requires distinct exported declaration names");
  if (ws.vfs.fileExists(target) || ws.vfs.directoryExists(target)) fail("TARGET_EXISTS", target);
  assertCaseSafe(root, target);
  const bytes = readFileSync(file);
  if (!Buffer.from(bytes.toString("utf8")).equals(bytes)) fail("UNSUPPORTED_ENCODING", `${file}: selected moves require UTF-8 text`);
  const selected = request.only.map(name => ({ name, statement: selectedStatement(sourceFile, name) })).sort((a, b) => a.statement.pos - b.statement.pos);
  const before = membership(ws);
  const graphBefore = projectGraph(ws, userFiles(ws), path => ws.ownersOf(path));
  const mappings = moveMappings(root, target, request.map, ws.vfs.inputs.sys);
  const rules = moveMapEntries(mappings);
  const remapped = sourceFile.statements.filter(ts.isImportDeclaration).flatMap(statement => {
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) return [];
    const resolved = ws.resolveModule(statement.moduleSpecifier, sourceFile);
    return resolved ? rules.filter(rule => rule.from === (statement.moduleSpecifier as ts.StringLiteralLike).text)
      .map(rule => ({ target: ws.vfs.key(resolved.resolvedFileName), imported: rule.imported })) : [];
  });
  const required = selected.map(item => ({ name: item.name, imports: [...typeImportTargets(ws, item.statement)]
    .filter(dependency => !remapped.some(rule => dependency.startsWith(rule.target + "\0") && (!rule.imported || dependency === rule.target + "\0" + rule.imported))) }));
  const preferences = preferencesFor(ws);
  // Let the compiler copy only imports actually used by each declaration and
  // update semantic callers. No intermediate project graph is validated.
  const groups: typeof selected[] = [];
  for (const item of selected) {
    const previous = groups.at(-1)?.at(-1);
    if (previous && sourceFile.statements.indexOf(item.statement) === sourceFile.statements.indexOf(previous.statement) + 1) groups.at(-1)!.push(item);
    else groups.push([item]);
  }
  for (const group of groups) {
    const current = ws.program().getSourceFile(file)!;
    const first = selectedStatement(current, group[0]!.name), last = selectedStatement(current, group.at(-1)!.name);
    const range = { pos: first.getStart(current), end: last.end };
    const result = ws.service.getEditsForRefactor(file, formatFor(sourceFile.text), range, "Move to file", "Move to file", preferences, { targetFile: target });
    if (!result || result.notApplicableReason || !result.edits.length) fail("REFACTOR_UNAVAILABLE", result?.notApplicableReason ?? `TypeScript cannot move ${group.map(item => item.name).join(", ")}`);
    applyEdits(context, result.edits, { eol: eolOf(sourceFile.text), bom: ws.vfs.hasBom(file) });
    for (const { name } of group) updateReexports(context, target, name, true, false);
  }
  removeSelectedSelfImports(ws, target, new Set(selected.map(item => item.name)));
  const moved = parseFile(ws, target);
  if (!moved) fail("REFACTOR_UNAVAILABLE", "selected declarations did not produce a target file");
  const mapped = mapMoveImports(moved, moveMappings(root, target, request.map, ws.vfs.inputs.sys));
  ws.vfs.write(target, mapped);
  const empty = parseFile(ws, file)!.statements.length === 0;
  if (empty) ws.vfs.write(file, null);
  ws.updateConfigLists([], empty ? [file] : []);
  ws.reparse();
  if (!ws.fileNames(ws.targetConfig).some(path => ws.vfs.samePath(path, target))) {
    if (!ws.addToFiles(ws.targetConfig, target)) fail("TARGET_NOT_IN_PROJECT", `${target} is not matched by ${ws.targetConfig}`);
    ws.reparse();
  }
  const siblings = ws.observers().filter(config => ws.vfs.samePath(dirname(config), dirname(ws.targetConfig)));
  assertMembership(ws, before, [], empty ? [file] : [], { path: target, must: [ws.targetConfig], may: siblings });
  normalizeSelectedImports(ws, target);
  ws.reparse();
  const cycles = introducedCycles(graphBefore, projectGraph(ws, userFiles(ws), path => ws.ownersOf(path)));
  if (cycles.length) fail("PROJECT_DEPENDENCY_CYCLE", `selected declarations still depend on the source project (${cycles.join("; ")}); select their dependencies too or move them first`);
  context.verify = () => {
    for (const { name, imports } of required) {
      const declaration = selectedStatement(ws.program().getSourceFile(target)!, name);
      const actual = typeImportTargets(ws, declaration);
      for (const dependency of imports) if (!actual.has(dependency)) fail("REFERENCES_NOT_PRESERVED", `${name} no longer imports ${dependency.replace("\0", " export ")}; map its source alias explicitly or move the dependency too`);
    }
  };
  context.notes.push(`Moved selected declarations ${selected.map(item => item.name).join(", ")} to ${relative(root, target)}; unselected declarations stay in ${relative(root, file)}.`);
}

/** TS may copy an import of an earlier selection into the same destination. */
function removeSelectedSelfImports(ws: Workspace, target: string, names: Set<string>): void {
  const source = parseFile(ws, target)!;
  const edits: ts.TextChange[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const resolved = ws.resolveModule(statement.moduleSpecifier, source);
    if (!resolved || !ws.vfs.samePath(resolved.resolvedFileName, target)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (statement.importClause?.name || !bindings || !ts.isNamedImports(bindings)
      || bindings.elements.some(item => item.propertyName && item.propertyName.text !== item.name.text)) fail("UNSUPPORTED_SELECTION", "aliased self-import produced by selected move");
    const kept = bindings.elements.filter(item => !names.has(item.name.text));
    if (!kept.length) edits.push({ span: { start: statement.getStart(source), length: statement.getWidth(source) }, newText: "" });
    else edits.push({ span: { start: bindings.getStart(source), length: bindings.getWidth(source) }, newText: `{ ${kept.map(item => item.getText(source)).join(", ")} }` });
  }
  if (edits.length) ws.vfs.write(target, applyTextChanges(source.text, edits));
}

/** Publish the selected module and normalize the compiler's relative caller edits. */
function normalizeSelectedImports(ws: Workspace, target: string): void {
  for (const path of [...new Set([...userFiles(ws), target])]) {
    const source = parseFile(ws, path);
    if (!source) continue;
    const edits: ts.TextChange[] = [];
    for (const specifier of moduleSpecifiers(source)) {
      const resolved = ws.resolveModule(specifier, source);
      if (!resolved) continue;
      const to = resolve(resolved.resolvedFileName);
      if (!ws.vfs.samePath(to, target) && !(ws.vfs.samePath(path, target) && packageSelfImport(ws, path, to, specifier.text))) continue;
      const owner = ws.ownersOf(path)[0];
      const options = owner ? ws.participant(owner).parsed.options : ws.editOptions;
      const bare = packageSpecifier(ws, path, to, ts.getModeForUsageLocation(source, specifier, options));
      const name = bare ?? specifierLike(path, to, "./module", to);
      edits.push({ span: { start: specifier.getStart(source), length: specifier.getWidth(source) }, newText: JSON.stringify(name) });
    }
    if (edits.length) ws.vfs.write(path, applyTextChanges(source.text, edits));
  }
}

function newDiagnostics(before: Diagnostic[], after: Diagnostic[]): Diagnostic[] {
  const key = (item: Diagnostic) => `${item.file}\0${item.code}\0${item.message}`;
  const counts = new Map<string, number>();
  for (const item of before) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return after.filter((item) => {
    const count = counts.get(key(item)) ?? 0;
    if (!count) return true;
    counts.set(key(item), count - 1);
    return false;
  });
}

function assertLayouts(ws: Workspace, before: Map<string, string>, after: Map<string, string>): void {
  for (const [key, layout] of before) {
    const planned = after.get(key);
    if (planned !== undefined && planned !== layout) {
      fail("OUTPUT_LAYOUT_CHANGED", `${ws.participant(key).configPath} has no rootDir and its emitted files would move from mirroring ${layout} to mirroring ${planned}; set rootDir or choose another target`);
    }
  }
}

/**
 * --verify bindings: capture the original owners, ambient modules and output
 * layouts before editing; the returned check validates the planned changed
 * files (origins map planned paths of moved files to their sources).
 */
function prepareBindings(ws: Workspace): (origins: Map<string, string>) => number {
  const owners = new Map<string, ts.CompilerOptions>();
  for (const item of ws.participants.values()) if (!item.observer) for (const path of item.parsed.fileNames) if (!owners.has(ws.vfs.key(path))) owners.set(ws.vfs.key(path), item.parsed.options);
  const programFiles = ws.program().getSourceFiles();
  const layouts = ws.outputLayouts();
  const state = (options?: (path: string) => ts.CompilerOptions | undefined): BindingState => ({
    source: path => ws.syntaxFile(path),
    resolve: (specifier, source) => ws.resolveModule(specifier, source, options?.(source.fileName))?.resolvedFileName,
    key: path => ws.vfs.key(path),
  });
  return origins => {
    const changed = [...ws.vfs.changes().filter(change => change.after !== null).map(change => change.path), ...ws.vfs.ephemeralPaths()];
    const ambient = ambientModules([...programFiles, ...changed.map(path => ws.syntaxFile(path)).filter((source): source is ts.SourceFile => !!source)]);
    const original = state(path => owners.get(ws.vfs.key(path)) ?? ws.editOptions);
    const checked = assertBindings(state(), run => ws.vfs.original(() => run(original)), changed, ambient,
      path => origins.get(ws.vfs.key(path)) ?? (ws.vfs.diskText(path) !== null ? path : undefined));
    assertLayouts(ws, layouts, ws.outputLayouts());
    return checked;
  };
}

export async function analyzeFileOperation(request: RefactorRequest): Promise<BackendResult> {
  const root = assertAbsolute("root", request.root);
  const file = assertAbsolute("file", request.file);
  if (!isInside(root, file)) fail("OUTSIDE_ROOT", `file is outside ${root}`);
  const inputs = new CompilerInputs(true);
  const port: PortRoutePrep | undefined = request.operation === "port-route" ? preparePortRoute(request, inputs.sys) : undefined;
  // port-route moves its client files as an explicit move-file batch.
  const moveRequest: RefactorRequest = port ? { ...request, operation: "move-file", map: port.map, exclude: undefined, moves: port.moves.map(([from, to]) => ({ file: from, target: to })) } : request;
  const movingFiles = port ? [...port.moves].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) : request.operation === "move-file" ? (request.moves ?? [{ file, target: assertAbsolute("target", request.target) }])
    .flatMap(move => movePaths(root, assertAbsolute("file", move.file), assertAbsolute("target", move.target), request.moves && !lstatSync(move.file).isDirectory() ? [] : request.exclude))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) : undefined;
  if (movingFiles) {
    const sources = new Set(movingFiles.map(([from]) => from)), targets = new Set(movingFiles.map(([, to]) => to));
    if (sources.size !== movingFiles.length || targets.size !== movingFiles.length || [...targets].some(to => sources.has(to) || [...targets].some(other => other !== to && isInside(to, other)))) {
      fail("INVALID_REQUEST", "batch sources/destinations must be unique and must not overlap");
    }
  }
  const extension = movingFiles ? extname(file) : sourceExtension(file);
  const sourceConfig = configPathFor(assertAbsolute("project", request.project));
  const targetConfig = ["move-type", "move-file", "port-route"].includes(request.operation) && request.targetProject
    ? configPathFor(assertAbsolute("targetProject", request.targetProject))
    : sourceConfig;
  const affected = movingFiles ? movingFiles.map(([from]) => from) : request.files ?? [file];
  if (request.operation === "move-type" && request.target && isAbsolute(request.target) && existsSync(request.target)) affected.push(resolve(request.target));
  if (!request.only && (movingFiles || sourceConfig !== targetConfig)) precheckMove(root, sourceConfig, targetConfig, movingFiles ?? [], moveRequest, inputs.sys);
  if (request.verify !== undefined && request.verify !== "bindings") fail("INVALID_REQUEST", "verify must be bindings or omitted (full)");
  const bindingsOnly = request.verify === "bindings";
  if (bindingsOnly && request.checker !== undefined) fail("INVALID_REQUEST", "checker selects program diagnostics, which verify bindings does not compute");
  const checkerMode = request.checker === "both" ? "both" : "ts7";
  const nativeChecker = request.checker === "ts7" || request.checker === "both" ? await loadTs7Checker(checkerMode) : undefined;
  const ws = timed("workspace.load", () => new Workspace(root, sourceConfig, targetConfig, affected, nativeChecker, checkerMode, inputs, port ? [port.startConfig] : [], bindingsOnly));
  try {
    if (!movingFiles && !ws.vfs.fileExists(file)) fail("FILE_NOT_FOUND", file);
    const selected = movingFiles ? movingFiles.map(([from]) => from).filter(path => /\.[cm]?[jt]sx?$/.test(path)) : request.files ?? [file];
    for (const file of selected) {
      const owners = ws.ownersOf(file);
      if (!owners.some((owner) => ws.vfs.samePath(owner, sourceConfig))) fail("FILE_NOT_IN_PROJECT", `${file} is not included by ${sourceConfig}`);
      if (owners.length > 1) fail("OWNERSHIP_AMBIGUOUS", `${file} is included by several projects: ${owners.join(", ")}`);
    }
    ws.assertNoUnhandledProjects(selected, true, false);
    const sourceFile = timed("workspace.program", () => ws.program().getSourceFile(selected[0] ?? file)) ?? (movingFiles ? ts.createSourceFile(file, "", ts.ScriptTarget.Latest) : undefined);
    if (!sourceFile) fail("FILE_NOT_IN_PROJECT", file);
    const isJs = jsExtensions.includes(extension);
    const context: Context = { ws, root, file, sourceFile, isJs, notes: [] };

    if (bindingsOnly && [...ws.participants.values()].some(item => item.references.length)) {
      fail("VERIFY_UNSUPPORTED", "--verify bindings cannot plan across project references: dependents and edits read in-memory declaration builds that require full checking; use --verify full");
    }
    const validate = bindingsOnly ? undefined : timed("workspace.prepare", () => ws.prepareValidation(true));
    const bindings = bindingsOnly ? timed("workspace.bindings-prepare", () => prepareBindings(ws)) : undefined;
    let renamed: [string, string] | undefined;
    if (request.operation === "rename-file") renamed = renameFile(context, request).renamed;
    else if (request.operation === "move-type") moveType(context, request);
    else if (port && movingFiles) {
      const model = timed("port-route.extract", () => new RouteExtractor(ws, portRouteExtractOptions(port, new Set(movingFiles.map(([from]) => ws.vfs.key(from))), path => ws.vfs.key(path))).extract(port.page));
      const dataProps = rewriteView(ws, port, model);
      timed("workspace.move", () => moveFile(context, moveRequest, movingFiles));
      // Relocation identity is checked before the page renders the generated adapter instead of the view.
      context.verify?.();
      context.verify = undefined;
      const [, start] = generatePortRoute(ws, port, model, dataProps, movingFiles, context.notes);
      await regenerateRouteTree(ws, port, start!, context.notes);
      context.notes.push(...model.notes);
    }
    else if (movingFiles && request.only) timed("workspace.move", () => moveSelected(context, request));
    else if (movingFiles) timed("workspace.move", () => moveFile(context, request, movingFiles));
    else if (request.operation === "inline-reexports") {
      const before = membership(ws);
      const deleted: string[] = [];
      for (const path of request.files ?? [file]) {
        const source = ws.program().getSourceFile(path);
        if (!source) fail("FILE_NOT_FOUND", path);
        if (timed("workspace.inline", () => inlineReexports(ws, path, source, context.notes, request.keep))) deleted.push(path);
      }
      assertMembership(ws, before, [], deleted);
    }
    else fail("UNSUPPORTED_OPERATION", String(request.operation));

    const written = ws.vfs.changes().filter((change) => change.after !== null && !/\.json$/i.test(change.path)).map((change) => change.path);
    if (written.length) timed("workspace.external-projects", () => ws.assertNoUnhandledProjects(written, false));
    const renameMap = new Map(((request.only ? [] : movingFiles) ?? (renamed ? [renamed] : [])).map(([from, to]) => [ws.vfs.key(from), to]));
    let diagnosticsBefore: Diagnostic[] = [], diagnosticsAfter: Diagnostic[] = [];
    let validatedFiles: number | undefined, validatedProjects = ws.participants.size;
    if (bindings) {
      context.verify?.();
      context.verify = undefined;
      // Selected declarations and moved types carry their source file's imports into the target.
      const origins = new Map([...renameMap].map(([from, to]) => [ws.vfs.key(to), from]));
      if ((request.only || request.operation === "move-type") && request.target && ws.vfs.diskText(request.target) === null) origins.set(ws.vfs.key(request.target), file);
      const checked = timed("workspace.bindings", () => {
        try { return bindings(origins); }
        catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith("BINDINGS_NOT_PRESERVED")) throw error;
          throw new Error(error.message
            + (context.aliasHints?.length ? `; unresolved source-project alias imports: ${context.aliasHints.join(", ")}; move their dependencies too or replace these aliases` : "")
            + (port ? `; port-route generated ${relative(root, port.startFile)} and the Next adapter from ${relative(root, port.config.path)}: fix its templates, snippets or ports` : ""));
        }
      });
      context.notes.push(`Verified bindings only (--verify bindings): edit prechecks, project membership, reference preservation, syntax and import/export bindings of ${checked} changed file(s); program diagnostics were not computed. Run the project typecheck after apply.`);
    } else {
      if (request.operation !== "move-type" && ![...ws.participants.values()].some(item => item.references.length)) {
        context.verify?.();
        context.verify = undefined;
        ws.service.cleanupSemanticCache();
      }
      const layoutsBefore = new Map(ws.layouts);
      const validation = timed("workspace.validate", validate!);
      ({ after: diagnosticsAfter, affected: validatedFiles, affectedProjects: validatedProjects = ws.participants.size } = validation);
      diagnosticsBefore = movingFiles ? validation.before.map(item => ({ ...item, file: renameMap.get(ws.vfs.key(item.file)) ?? item.file })) : renamed
        ? validation.before.map((item) => ws.vfs.samePath(item.file, renamed[0]) ? { ...item, file: renamed[1] } : item)
        : validation.before;
      if (!diagnosticsAfter.length && ![...ws.participants.values()].some(item => item.references.length)) context.notes.push("Skipped baseline diagnostics: the planned affected set has no errors.");
      const introduced = newDiagnostics(diagnosticsBefore, diagnosticsAfter);
      if (introduced.length) fail("NEW_DIAGNOSTICS", introduced.map((item) => `${item.code} ${item.file}: ${item.message}`).join("; ")
        + (movingFiles ? `; affected consumers: ${[...new Set(introduced.map(item => relative(root, item.file)))].join(", ")}; adapt these consumers before moving, or include dependent files in the same --file source=destination batch` : "")
        + (context.aliasHints?.length ? `; unresolved source-project alias imports: ${context.aliasHints.join(", ")}; move their dependencies too or replace these aliases` : "")
        + (port ? `; port-route generated ${relative(root, port.startFile)} and the Next adapter from ${relative(root, port.config.path)}: fix its templates, snippets or ports for generated-file errors, or prepare the view (props, ports) before porting` : ""));
      context.verify?.();
      assertLayouts(ws, layoutsBefore, ws.layouts);
    }

    for (const config of ws.importingConfigs) {
      context.notes.push(`Included ${relative(root, config)} because its program imports ${relative(root, file)} without a project reference.`);
    }
    for (const config of ws.observers()) {
      context.notes.push(`Updated and validated ${relative(root, config)}, a variant config that also compiles the affected files.`);
    }
    if (bindings) { /* program diagnostics were not computed */ }
    else if (request.checker === "ts7") context.notes.push(`Validated all user sources across ${ws.participants.size} project(s) with TS7 7.0.2; TS5 graph discovery is not used to restrict native diagnostics.`);
    else if (validatedFiles !== undefined) {
      context.notes.push(`Validated ${validatedFiles} affected file(s) across ${validatedProjects} project(s): the changed files and their transitive importers in the original and planned module graphs.${validatedProjects < ws.participants.size ? ` Fully checked ${ws.participants.size - validatedProjects} other project(s).` : ""}`);
    } else if (ws.participants.size > 1) {
      context.notes.push(`Validated ${ws.participants.size} projects (${[...ws.participants.values()].map((item) => relative(root, item.configPath)).join(", ")}) with in-memory declaration builds for project references.`);
    }
    if (isJs) {
      context.notes.push("JavaScript analysis is semantic only for references TypeScript can resolve; dynamic imports with computed paths and string-based references are not changed.");
    }
    if (renamed) context.notes.push(`Renamed ${relative(root, renamed[0])} to ${relative(root, renamed[1])}; the plan deletes the old path and creates the new one.`);
    // createPlan replays this exact read set after analysis (later, so strictly stronger)
    // before accepting a nonempty plan; empty plans need no freshness proof.
    return {
      readSet: inputs.snapshot(),
      backend: "typescript",
      ...(bindings ? {} : { checker: nativeChecker ? checkerMode === "both" ? bothIdentity : ts7Identity : { name: "ts5" as const, version: ts.version } }),
      version: ts.version,
      changes: ws.vfs.changes(),
      diagnosticsBefore,
      diagnosticsAfter,
      notes: context.notes,
    };
  } finally {
    ws.dispose();
  }
}
