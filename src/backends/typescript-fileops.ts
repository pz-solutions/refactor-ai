import ts from "typescript";
import { inlineReexports } from "./typescript-inline-reexports";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { BackendResult, Capability, Diagnostic, RefactorRequest } from "../types";
import { eolOf, fail, isInside, withEol } from "./typescript-vfs";
import { Workspace, applyTextChanges, baseFormatOptions, configPathFor, moduleSpecifiers, scriptKindFor } from "./typescript-workspace";
import { packageSpecifier, relativeStyle } from "./typescript-package-specifiers";
import { portablePath } from "./typescript-paths";

export const fileCapabilities: Capability[] = [
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
  const text = ws.vfs.readFile(path);
  if (text === undefined) return undefined;
  const impliedNodeFormat = ts.getImpliedNodeFormatForFile(path, undefined, ws.vfs.moduleResolutionHost(), ws.editOptions);
  return ts.createSourceFile(path, text, { languageVersion: ts.ScriptTarget.Latest, impliedNodeFormat }, true, scriptKindFor(path));
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
        added.length ? `gain ${added.join(", ")}` : "",
        missing.length ? `lose ${missing.join(", ")}` : "",
      ].filter(Boolean).join(" and ")}; adjust include/files patterns or choose another target`);
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
function movePaths(root: string, file: string, target: string): [string, string][] {
  if (!isInside(root, target)) fail("OUTSIDE_ROOT", `target is outside ${root}`);
  let stat;
  try { stat = lstatSync(file); } catch { fail("FILE_NOT_FOUND", file); }
  if (stat.isSymbolicLink()) fail("SYMLINK_UNSUPPORTED", file);
  if (stat.isFile()) {
    if (extname(file) !== extname(target)) fail("UNSUPPORTED_TARGET", "move-file must retain the file extension");
    return [[file, target]];
  }
  if (!stat.isDirectory()) fail("UNSUPPORTED_FILE", file);
  if (isInside(file, target) || isInside(target, file)) fail("INVALID_REQUEST", "source and destination directories must not overlap");
  const paths: [string, string][] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
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
  const before = membership(ws);
  const beforeOwners = new Map<string, string[]>();
  for (const [config, keys] of before) {
    if (ws.isObserver(config)) continue;
    for (const key of keys) beforeOwners.set(key, [...(beforeOwners.get(key) ?? []), config]);
  }
  const graphBefore = projectGraph(ws, userFiles(ws), path => ws.ownersOf(path));
  const imports = relocationImports(ws, renames);
  const mapping = new Map(renames.map(([from, to]) => [ws.vfs.key(from), to]));
  const relocated = (path: string) => mapping.get(ws.vfs.key(path)) ?? path;
  const styleCache = new Map<string, string | null>();
  const styles = new Map(imports.filter(edge => mapping.has(ws.vfs.key(edge.target)))
    .map(edge => [edge, relativeStyle(ws, relocated(edge.target), edge.original, styleCache)]));
  const beforeImporters = importerMap(ws, renames.map(([from]) => from));
  const expectedImporters = new Map(renames.map(([from, to]) => [to, beforeImporters.get(ws.vfs.key(from))!.map(relocated).map(path => ws.vfs.key(path)).sort()]));
  applyEdits(context, ws.service.getEditsForFileRename(file, target, formatFor(context.sourceFile.text), preferencesFor(ws)));
  for (const [from, to] of renames) {
    const text = ws.vfs.readFile(from)!;
    const bom = ws.vfs.hasBom(from);
    ws.vfs.write(from, null);
    ws.vfs.write(to, text, bom);
  }

  const sameProject = ws.vfs.samePath(ws.sourceConfig, ws.targetConfig);
  const configRenames: [string, string][] = directory ? [[file, target], ...renames] : renames;
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
  for (const edge of imports) {
    if (!mapping.has(ws.vfs.key(edge.target))) continue;
    const from = relocated(edge.file), to = relocated(edge.target);
    const source = parseFile(ws, from)!;
    const specifier = moduleSpecifiers(source)[edge.index];
    if (!specifier) fail("REFERENCES_NOT_PRESERVED", `module specifier disappeared in ${from}`);
    const owner = ws.ownersOf(from)[0];
    const options = owner ? ws.participant(owner).parsed.options : ws.editOptions;
    const bare = packageSpecifier(ws, from, to, ts.getModeForUsageLocation(source, specifier, options));
    const style = styles.get(edge)!;
    const name = bare ?? specifierLike(from, to, style, edge.target);
    const start = specifier.getStart(source) + 1;
    const list = changes.get(from) ?? [];
    list.push({ span: { start, length: specifier.end - start - 1 }, newText: JSON.stringify(name).slice(1, -1) });
    changes.set(from, list);
  }
  for (const [path, edits] of changes) ws.vfs.write(path, applyTextChanges(ws.vfs.readFile(path)!, edits));
  ws.reparse();
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
    const afterImporters = importerMap(ws, renames.map(([, to]) => to));
    for (const [to, expected] of expectedImporters) {
      const actual = afterImporters.get(ws.vfs.key(to))!;
      if (JSON.stringify(expected) !== JSON.stringify(actual)) fail("REFERENCES_NOT_PRESERVED", `${expected.length} module references expected for ${to}, found ${actual.length}`);
    }
  };
  context.notes.push(`Moved ${renames.length} file(s) from ${relative(root, file)} to ${relative(root, target)}; validated source and target project membership.`);
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

export async function analyzeFileOperation(request: RefactorRequest): Promise<BackendResult> {
  const root = assertAbsolute("root", request.root);
  const file = assertAbsolute("file", request.file);
  if (!isInside(root, file)) fail("OUTSIDE_ROOT", `file is outside ${root}`);
  const movingFiles = request.operation === "move-file" ? movePaths(root, file, assertAbsolute("target", request.target)) : undefined;
  const extension = movingFiles ? extname(file) : sourceExtension(file);
  const sourceConfig = configPathFor(assertAbsolute("project", request.project));
  const targetConfig = ["move-type", "move-file"].includes(request.operation) && request.targetProject
    ? configPathFor(assertAbsolute("targetProject", request.targetProject))
    : sourceConfig;
  const affected = movingFiles ? movingFiles.map(([from]) => from) : [file];
  if (request.operation === "move-type" && request.target && isAbsolute(request.target) && existsSync(request.target)) affected.push(resolve(request.target));
  const ws = new Workspace(root, sourceConfig, targetConfig, affected, !!movingFiles);
  try {
    if (!movingFiles && !ws.vfs.fileExists(file)) fail("FILE_NOT_FOUND", file);
    const selected = movingFiles ? movingFiles.map(([from]) => from).filter(path => /\.[cm]?[jt]sx?$/.test(path)) : [file];
    for (const file of selected) {
      const owners = ws.ownersOf(file);
      if (!owners.some((owner) => ws.vfs.samePath(owner, sourceConfig))) fail("FILE_NOT_IN_PROJECT", `${file} is not included by ${sourceConfig}`);
      if (owners.length > 1) fail("OWNERSHIP_AMBIGUOUS", `${file} is included by several projects: ${owners.join(", ")}`);
    }
    ws.assertNoUnhandledProjects(selected, true, false);
    const sourceFile = ws.program().getSourceFile(selected[0] ?? file) ?? (movingFiles ? ts.createSourceFile(file, "", ts.ScriptTarget.Latest) : undefined);
    if (!sourceFile) fail("FILE_NOT_IN_PROJECT", file);
    const isJs = jsExtensions.includes(extension);
    const context: Context = { ws, root, file, sourceFile, isJs, notes: [] };

    const diagnosticsBefore = ws.diagnostics();
    let renamed: [string, string] | undefined;
    if (request.operation === "rename-file") renamed = renameFile(context, request).renamed;
    else if (request.operation === "move-type") moveType(context, request);
    else if (movingFiles) moveFile(context, request, movingFiles);
    else if (request.operation === "inline-reexports") {
      const before = membership(ws);
      const deleted = inlineReexports(ws, file, sourceFile, context.notes, request.keep);
      assertMembership(ws, before, [], deleted ? [file] : []);
    }
    else fail("UNSUPPORTED_OPERATION", String(request.operation));

    const written = ws.vfs.changes().filter((change) => change.after !== null && !/\.json$/i.test(change.path)).map((change) => change.path);
    if (written.length) ws.assertNoUnhandledProjects(written, false);
    const layoutsBefore = new Map(ws.layouts);
    const diagnosticsAfter = ws.diagnostics();
    const renameMap = new Map((movingFiles ?? (renamed ? [renamed] : [])).map(([from, to]) => [ws.vfs.key(from), to]));
    const comparable = movingFiles ? diagnosticsBefore.map(item => ({ ...item, file: renameMap.get(ws.vfs.key(item.file)) ?? item.file })) : renamed
      ? diagnosticsBefore.map((item) => ws.vfs.samePath(item.file, renamed[0]) ? { ...item, file: renamed[1] } : item)
      : diagnosticsBefore;
    const introduced = newDiagnostics(comparable, diagnosticsAfter);
    if (introduced.length) fail("NEW_DIAGNOSTICS", introduced.map((item) => `${item.code} ${item.file}: ${item.message}`).join("; ")
      + (context.aliasHints?.length ? `; unresolved source-project alias imports: ${context.aliasHints.join(", ")}; move their dependencies too or replace these aliases` : ""));
    context.verify?.();
    for (const [key, layout] of layoutsBefore) {
      const after = ws.layouts.get(key);
      if (after !== undefined && after !== layout) {
        fail("OUTPUT_LAYOUT_CHANGED", `${ws.participant(key).configPath} has no rootDir and its emitted files would move from mirroring ${layout} to mirroring ${after}; set rootDir or choose another target`);
      }
    }

    for (const config of ws.importingConfigs) {
      context.notes.push(`Included ${relative(root, config)} because its program imports ${relative(root, file)} without a project reference.`);
    }
    for (const config of ws.observers()) {
      context.notes.push(`Updated and validated ${relative(root, config)}, a variant config that also compiles the affected files.`);
    }
    if (ws.participants.size > 1) {
      context.notes.push(`Validated ${ws.participants.size} projects (${[...ws.participants.values()].map((item) => relative(root, item.configPath)).join(", ")}) with in-memory declaration builds for project references.`);
    }
    if (isJs) {
      context.notes.push("JavaScript analysis is semantic only for references TypeScript can resolve; dynamic imports with computed paths and string-based references are not changed.");
    }
    if (renamed) context.notes.push(`Renamed ${relative(root, renamed[0])} to ${relative(root, renamed[1])}; the plan deletes the old path and creates the new one.`);
    return {
      backend: "typescript",
      version: ts.version,
      changes: ws.vfs.changes(),
      diagnosticsBefore: comparable,
      diagnosticsAfter,
      notes: context.notes,
    };
  } finally {
    ws.dispose();
  }
}
