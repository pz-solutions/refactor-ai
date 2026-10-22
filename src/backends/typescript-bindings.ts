import ts from "typescript";
import { fail } from "./typescript-vfs";

/**
 * `--verify bindings`: syntax and import/export binding resolution of changed
 * files, without a type checker or program diagnostics. Each changed file is
 * resolved with its owning project's options (like `tsc -p`), and named imports
 * and re-exports must name an export of the resolved module. Export tables are
 * computed syntactically, following `export *` chains. A module whose exports
 * cannot be proven syntactically (`export =`, CommonJS, scripts, JSON,
 * unresolved `export *`) accepts every name. Problems that already existed in
 * the original files are not attributed to the plan.
 */
export interface BindingState {
  /** Parsed text of a file in the state being checked; undefined when absent. */
  source(path: string): ts.SourceFile | undefined;
  /** Resolved file of a module specifier, using the owning project's options. */
  resolve(specifier: ts.StringLiteralLike, source: ts.SourceFile): string | undefined;
  key(path: string): string;
}

interface Problem { file: string; name: string; message: string }

type Ambient = (name: string) => boolean;

/** Exact and wildcard `declare module "..."` names of the given declaration files and scripts. */
export function ambientModules(sources: readonly ts.SourceFile[]): Ambient {
  const exact = new Set<string>(), patterns: [string, string][] = [];
  for (const source of sources) {
    for (const statement of source.statements) {
      if (!ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name)) continue;
      const name = statement.name.text, star = name.indexOf("*");
      if (star < 0) exact.add(name);
      else patterns.push([name.slice(0, star), name.slice(star + 1)]);
    }
  }
  return name => exact.has(name) || patterns.some(([prefix, suffix]) => name.length >= prefix.length + suffix.length && name.startsWith(prefix) && name.endsWith(suffix));
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some(modifier => modifier.kind === kind) ?? false);
}

function bindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) names.add(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, names);
}

const commonJs = /\bmodule\.exports\b|\bexports\.[A-Za-z_$]|@typedef\b|@callback\b/;

/** Syntactic export names; undefined when they cannot be proven without a checker. */
function exportsOf(state: BindingState, path: string, cache: Map<string, Set<string> | undefined>, visiting = new Set<string>()): Set<string> | undefined {
  const key = state.key(path);
  if (cache.has(key)) return cache.get(key);
  if (visiting.has(key)) return new Set();
  const source = /\.(?:[cm]?[jt]sx?)$/i.test(path) ? state.source(path) : undefined;
  if (!source || !ts.isExternalModule(source) || (/\.[cm]?jsx?$/i.test(path) && commonJs.test(source.text))) {
    cache.set(key, undefined);
    return undefined;
  }
  visiting.add(key);
  let names: Set<string> | undefined = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals) { names = undefined; break; }
      names.add("default");
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) names.add(element.name.text);
      else if (statement.exportClause) names.add(statement.exportClause.name.text);
      else if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const target = state.resolve(statement.moduleSpecifier, source);
        const star = target && exportsOf(state, target, cache, visiting);
        if (!star) { names = undefined; break; }
        for (const name of star) if (name !== "default") names.add(name);
      }
    } else if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) names.add("default");
      else if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name, names);
      else if ("name" in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) names.add((statement.name as ts.Identifier).text);
    }
  }
  visiting.delete(key);
  cache.set(key, names);
  return names;
}

/** Module references of a file and the names each one binds ("*" checks only the module). */
function references(source: ts.SourceFile): { specifier: ts.StringLiteralLike; names: string[] }[] {
  const found: { specifier: ts.StringLiteralLike; names: string[] }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && node.importClause) {
      const clause = node.importClause, names: string[] = [];
      if (clause.name) names.push("default");
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) names.push((element.propertyName ?? element.name).text);
      else if (clause.namedBindings) names.push("*");
      found.push({ specifier: node.moduleSpecifier, names });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const names = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements.map(element => (element.propertyName ?? element.name).text) : ["*"];
      found.push({ specifier: node.moduleSpecifier, names });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      found.push({ specifier: node.moduleReference.expression, names: ["*"] });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      found.push({ specifier: node.argument.literal, names: ["*"] });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
      found.push({ specifier: node.arguments[0] as ts.StringLiteralLike, names: ["*"] });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function problems(state: BindingState, path: string, ambient: Ambient, cache: Map<string, Set<string> | undefined>): Problem[] {
  const source = state.source(path);
  if (!source) return [];
  const found: Problem[] = [];
  const parse = (source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (!Array.isArray(parse)) fail("VERIFY_UNSUPPORTED", "this TypeScript version does not expose parse diagnostics");
  for (const diagnostic of parse) {
    found.push({ file: path, name: `syntax:TS${diagnostic.code}`, message: `TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}` });
  }
  for (const { specifier, names } of references(source)) {
    const target = state.resolve(specifier, source);
    if (!target) {
      if (!ambient(specifier.text)) for (const name of names) found.push({ file: path, name, message: `'${specifier.text}' does not resolve` });
      continue;
    }
    const exported = names.some(name => name !== "*") ? exportsOf(state, target, cache) : undefined;
    for (const name of names) {
      if (exported && name !== "*" && !exported.has(name)) found.push({ file: path, name, message: `'${specifier.text}' (${target}) has no export '${name}'` });
    }
  }
  return found;
}

/**
 * Fail with the problems that the plan introduces in `changed` files. `origin`
 * maps a planned path to its original path (moves), or undefined for new files.
 * Returns the number of files checked.
 */
export function assertBindings(planned: BindingState, original: <T>(run: (state: BindingState) => T) => T, changed: string[],
  ambient: Ambient, origin: (path: string) => string | undefined): number {
  const files = changed.filter(path => /\.[cm]?[jt]sx?$/i.test(path) && !/\.d\.[cm]?ts$/i.test(path));
  const cache = new Map<string, Set<string> | undefined>();
  const introduced: Problem[] = [];
  for (const path of files) {
    const after = problems(planned, path, ambient, cache);
    if (!after.length) continue;
    const from = origin(path);
    const before = from === undefined ? [] : original(state => problems(state, from, ambient, new Map()));
    const counts = new Map<string, number>();
    for (const item of before) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
    for (const item of after) {
      const count = counts.get(item.name) ?? 0;
      if (count) counts.set(item.name, count - 1);
      else introduced.push(item);
    }
  }
  const syntax = introduced.filter(item => item.name.startsWith("syntax:"));
  if (syntax.length) fail("NEW_DIAGNOSTICS", syntax.map(item => `${item.message} (${item.file})`).join("; "));
  if (introduced.length) {
    fail("BINDINGS_NOT_PRESERVED", `${introduced.map(item => `${item.file}: ${item.message}`).join("; ")}; --verify bindings checks syntax and import/export bindings of changed files; fix the bindings, or rerun with --verify full when an export is only visible to the type checker (module augmentation)`);
  }
  return files.length;
}
