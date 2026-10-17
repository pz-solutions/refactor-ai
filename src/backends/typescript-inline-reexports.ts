import ts from "typescript";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { portablePath, isInside } from "./typescript-paths";
import { eolOf, fail } from "./typescript-vfs";
import { applyTextChanges, moduleSpecifiers, type Workspace } from "./typescript-workspace";

interface Origin {
  specifier: ts.StringLiteralLike;
  target: ts.SourceFile;
  name: string;
  typeOnly: boolean;
}

/** Resolve by symbol identity, preserving the first bare/public module boundary. */
class Origins {
  readonly checker: ts.TypeChecker;
  constructor(readonly ws: Workspace) { this.checker = ws.program().getTypeChecker(); }

  exports(source: ts.SourceFile): ts.Symbol[] {
    const symbol = this.checker.getSymbolAtLocation(source);
    return symbol ? this.checker.getExportsOfModule(symbol) : [];
  }

  actual(symbol: ts.Symbol): ts.Symbol {
    return symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
  }

  exported(source: ts.SourceFile, name: string): ts.Symbol {
    const symbol = this.exports(source).find((item) => item.name === name);
    if (!symbol) fail("REEXPORT_UNRESOLVED", `${source.fileName} has no resolved export '${name}'`);
    return symbol;
  }

  module(source: ts.SourceFile, specifier: ts.StringLiteralLike): ts.SourceFile {
    const symbol = this.checker.getSymbolAtLocation(specifier);
    const target = symbol?.declarations?.find(ts.isSourceFile);
    if (!target) fail("REEXPORT_UNRESOLVED", `${specifier.text} in ${source.fileName} has no resolved module`);
    return target;
  }

  find(source: ts.SourceFile, name: string, seen = new Set<string>()): Origin | undefined {
    const key = `${source.fileName}\0${name}`;
    if (seen.has(key)) fail("REEXPORT_CYCLE", `cyclic re-export of '${name}' in ${source.fileName}`);
    const visited = new Set([...seen, key]);
    const symbol = this.exported(source, name);
    // Explicit exports override star exports, even when both refer to the same symbol.
    const declarations = source.statements.filter(ts.isExportDeclaration);
    const explicit = declarations.find((item) => item.exportClause && ts.isNamedExports(item.exportClause)
      && item.exportClause.elements.some((element) => element.name.text === name));
    if (explicit) {
      if (explicit.attributes) fail("REEXPORT_UNSUPPORTED", `re-export attributes in ${source.fileName}`);
      const element = (explicit.exportClause as ts.NamedExports).elements.find((item) => item.name.text === name)!;
      if (!explicit.moduleSpecifier) return this.localOrigin(element, visited, explicit.isTypeOnly || element.isTypeOnly);
      if (!ts.isStringLiteralLike(explicit.moduleSpecifier)) return undefined;
      return this.follow(source, explicit.moduleSpecifier, (element.propertyName ?? element.name).text,
        explicit.isTypeOnly || element.isTypeOnly, visited);
    }
    if (this.actual(symbol).declarations?.some((item) => item.getSourceFile() === source)) return undefined;
    for (const statement of declarations) {
      if (statement.exportClause || !statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier) || name === "default") continue;
      const target = this.module(source, statement.moduleSpecifier);
      const candidate = this.exports(target).find((item) => item.name === name);
      if (candidate && this.actual(candidate) === this.actual(symbol)) {
        if (statement.attributes) fail("REEXPORT_UNSUPPORTED", `re-export attributes in ${source.fileName}`);
        return this.follow(source, statement.moduleSpecifier, name, statement.isTypeOnly, visited);
      }
    }
    return undefined;
  }

  packageBoundary(source: ts.SourceFile, target: ts.SourceFile): boolean {
    const owner = (file: string): { directory: string; manifest: Record<string, unknown> } | undefined => {
      for (let directory = dirname(file); isInside(this.ws.root, directory); directory = dirname(directory)) {
        const text = this.ws.vfs.readFile(resolve(directory, "package.json"));
        if (text) {
          try { return { directory, manifest: JSON.parse(text) }; }
          catch { fail("INVALID_PACKAGE", `cannot parse ${directory}/package.json`); }
        }
        if (directory === dirname(directory)) break;
      }
      return undefined;
    };
    const destination = owner(target.fileName);
    if (!destination?.manifest.name || owner(source.fileName)?.directory === destination.directory) return false;
    const values = (value: unknown): string[] => typeof value === "string" ? [value]
      : value && typeof value === "object" ? Object.values(value).flatMap(values) : [];
    const entries = destination.manifest.exports !== undefined ? values(destination.manifest.exports)
      : [destination.manifest.types, destination.manifest.typings, destination.manifest.main, "./index.ts", "./index.js"].flatMap(values);
    const stem = (path: string) => path.replace(/(?:\.d)?\.[cm]?[jt]sx?$/, "");
    return entries.some((entry) => {
      const parts = stem(resolve(destination.directory, entry)).split("*");
      const path = stem(target.fileName);
      return parts.length === 1 ? this.ws.vfs.samePath(parts[0]!, path)
        : parts.length === 2 && this.ws.vfs.key(path).startsWith(this.ws.vfs.key(parts[0]!)) && path.endsWith(parts[1]!);
    });
  }

  localOrigin(element: ts.ExportSpecifier, seen: Set<string>, typeOnly: boolean): Origin | undefined {
    const local = this.checker.getExportSpecifierLocalTargetSymbol(element);
    const declaration = local?.declarations?.[0];
    if (!declaration || (!ts.isImportSpecifier(declaration) && !ts.isImportClause(declaration))) return undefined;
    const clause = ts.isImportSpecifier(declaration) ? declaration.parent.parent : declaration;
    const statement = clause.parent;
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) return undefined;
    if (statement.attributes) fail("REEXPORT_UNSUPPORTED", `import attributes in ${element.getSourceFile().fileName}`);
    const name = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : "default";
    return this.follow(element.getSourceFile(), statement.moduleSpecifier, name,
      typeOnly || clause.isTypeOnly || (ts.isImportSpecifier(declaration) && declaration.isTypeOnly), seen);
  }

  follow(source: ts.SourceFile, specifier: ts.StringLiteralLike, name: string, typeOnly: boolean, seen: Set<string>): Origin {
    const target = this.module(source, specifier);
    this.exported(target, name);
    const next = isRelative(specifier.text) && !this.packageBoundary(source, target) ? this.find(target, name, seen) : undefined;
    return next ? { ...next, typeOnly: typeOnly || next.typeOnly } : { specifier, target, name, typeOnly };
  }
}

function isRelative(specifier: string): boolean { return /^\.\.?\//.test(specifier); }

/** Preserve the shim's extension convention, including directory/index resolution. */
function originSpecifier(origin: Origin, importer: ts.SourceFile): string {
  const original = origin.specifier.text;
  if (!isRelative(original)) return original;
  const written = original.match(/(?:\.d)?\.[cm]?[jt]sx?$/)?.[0] ?? "";
  const extension = origin.target.fileName.match(/(?:\.d)?\.[cm]?[jt]sx?$/)?.[0] ?? extname(origin.target.fileName);
  const runtime: Record<string, string> = { ".ts": ".js", ".tsx": ".js", ".mts": ".mjs", ".cts": ".cjs" };
  const suffix = written === extension ? extension : [".js", ".jsx", ".mjs", ".cjs"].includes(written)
    ? written === ".jsx" && extension === ".tsx" ? ".jsx" : runtime[extension.replace(/^\.d/, "")] ?? extension : "";
  const target = origin.target.fileName.slice(0, -extension.length) + suffix;
  const path = portablePath(relative(dirname(importer.fileName), target));
  return path.startsWith(".") ? path : `./${path}`;
}

function literal(text: string, quote: string): string {
  const escaped = JSON.stringify(text).slice(1, -1);
  return `${quote}${quote === "'" ? escaped.replace(/'/g, "\\'") : escaped}${quote}`;
}

function bindingName(name: string): string {
  return /^[$\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(name) ? name : JSON.stringify(name);
}

interface Binding {
  imported: string;
  local: string;
  typeOnly: boolean;
  defaultImport?: boolean;
}

interface Group { specifier: string; bindings: Binding[]; }

function resolveAs(ws: Workspace, text: string, source: ts.SourceFile, usage: ts.StringLiteralLike): ts.ResolvedModuleFull | undefined {
  const mode = ts.getModeForUsageLocation(source, usage, ws.editOptions);
  return ts.resolveModuleName(text, source.fileName, ws.editOptions, ws.vfs.moduleResolutionHost(), undefined, undefined, mode).resolvedModule;
}

function groupsFor(origins: Origins, shim: ts.SourceFile, importer: ts.SourceFile, specifier: ts.StringLiteralLike, bindings: Binding[]): Group[] {
  const groups = new Map<string, Group>();
  for (const binding of bindings) {
    const origin = origins.find(shim, binding.imported);
    const direct = origin ? originSpecifier(origin, importer) : specifier.text;
    if (origin) {
      // Bare aliases can resolve differently from another project/directory. Never silently rebind.
      const resolved = resolveAs(origins.ws, direct, importer, specifier);
      if (!resolved || !origins.ws.vfs.samePath(resolved.resolvedFileName, origin.target.fileName)) {
        fail("REEXPORT_RESOLUTION_CHANGED", `'${direct}' in ${importer.fileName} does not resolve to ${origin.target.fileName}`);
      }
    }
    const group = groups.get(direct) ?? { specifier: direct, bindings: [] };
    group.bindings.push({ ...binding, imported: origin?.name ?? binding.imported, typeOnly: binding.typeOnly || (origin?.typeOnly ?? false) });
    groups.set(direct, group);
  }
  return [...groups.values()];
}

function renderGroup(group: Group, exporting: boolean, typeOnly: boolean, quote: string, suffix: string): string {
  const defaults = exporting ? [] : group.bindings.filter((item) => item.defaultImport && item.imported === "default");
  const named = group.bindings.filter((item) => !defaults.includes(item));
  const allType = typeOnly;
  if (!typeOnly && defaults.some((item) => item.typeOnly)) {
    const typed = defaults.filter((item) => item.typeOnly);
    const remaining = group.bindings.filter((item) => !typed.includes(item));
    return [renderGroup({ ...group, bindings: typed }, false, true, quote, suffix),
      ...(remaining.length ? [renderGroup({ ...group, bindings: remaining }, false, false, quote, suffix)] : [])].join("\n");
  }
  const names = named.map((item) => `${!allType && item.typeOnly ? "type " : ""}${bindingName(item.imported)}${item.imported === item.local ? "" : ` as ${bindingName(item.local)}`}`);
  if (allType && defaults.length && named.length) {
    return [renderGroup({ ...group, bindings: defaults }, exporting, true, quote, suffix),
      renderGroup({ ...group, bindings: named }, exporting, true, quote, suffix)].join("\n");
  }
  const clause = [...defaults.map((item) => item.local), ...(names.length ? [`{ ${names.join(", ")} }`] : [])].join(", ");
  return `${exporting ? "export" : "import"} ${allType ? "type " : ""}${clause} from ${literal(group.specifier, quote)}${suffix}`;
}

function pureShim(source: ts.SourceFile): boolean {
  return source.statements.some(ts.isExportDeclaration) && source.statements.every((item) =>
    (ts.isExportDeclaration(item) && !!item.moduleSpecifier)
    || (ts.isExpressionStatement(item) && ts.isStringLiteral(item.expression)));
}

function singleStar(source: ts.SourceFile): ts.ExportDeclaration | undefined {
  const exports = source.statements.filter(ts.isExportDeclaration);
  return pureShim(source) && exports.length === 1 && !exports[0]!.exportClause && !exports[0]!.isTypeOnly ? exports[0] : undefined;
}

function retargetNamespace(origins: Origins, shim: ts.SourceFile, source: ts.SourceFile, specifier: ts.StringLiteralLike): ts.TextChange {
  const star = singleStar(shim);
  if (!star || !star.moduleSpecifier || !ts.isStringLiteralLike(star.moduleSpecifier)) {
    fail("NAMESPACE_IMPORT_UNSUPPORTED", `${source.fileName} imports a namespace from ${shim.fileName}; only pure single-origin export * shims support this`);
  }
  if (star.attributes) fail("REEXPORT_UNSUPPORTED", `re-export attributes in ${shim.fileName}`);
  const target = origins.module(shim, star.moduleSpecifier);
  // export * omits default. Retargeting a namespace must not add that binding.
  if (origins.exports(target).some((item) => item.name === "default")) fail("NAMESPACE_IMPORT_UNSUPPORTED", "origin exports default, which export * excludes");
  const origin: Origin = { specifier: star.moduleSpecifier, target, name: "", typeOnly: false };
  const direct = originSpecifier(origin, source);
  const resolved = resolveAs(origins.ws, direct, source, specifier);
  if (!resolved || !origins.ws.vfs.samePath(resolved.resolvedFileName, target.fileName)) fail("REEXPORT_RESOLUTION_CHANGED", direct);
  const start = specifier.getStart(source);
  return { span: { start, length: specifier.end - start }, newText: literal(direct, source.text[start]!) };
}

function rewrite(origins: Origins, shim: ts.SourceFile, source: ts.SourceFile, notes: string[]): ts.TextChange[] {
  const changes: ts.TextChange[] = [];
  for (const statement of source.statements) {
    if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier
      || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier;
    const resolved = origins.ws.resolveModule(specifier, source);
    if (!resolved || !origins.ws.vfs.samePath(resolved.resolvedFileName, shim.fileName)) continue;
    const exporting = ts.isExportDeclaration(statement);
    const clause = exporting ? statement.exportClause : statement.importClause;
    if (!exporting && !clause) { notes.push(`Kept side-effect import of ${shim.fileName} in ${source.fileName}.`); continue; }
    if (statement.attributes) fail("REEXPORT_UNSUPPORTED", `import/export attributes in ${source.fileName}`);
    if ((!exporting && statement.importClause?.namedBindings && ts.isNamespaceImport(statement.importClause.namedBindings))
      || (exporting && statement.exportClause && ts.isNamespaceExport(statement.exportClause))) {
      changes.push(retargetNamespace(origins, shim, source, specifier));
      continue;
    }
    const typeOnly = exporting ? statement.isTypeOnly : statement.importClause!.isTypeOnly;
    const bindings: Binding[] = [];
    if (!exporting && statement.importClause!.name) bindings.push({ imported: "default", local: statement.importClause!.name.text, typeOnly, defaultImport: true });
    const named = exporting ? statement.exportClause : statement.importClause!.namedBindings;
    if (named && (ts.isNamedExports(named) || ts.isNamedImports(named))) {
      for (const item of named.elements) bindings.push({ imported: (item.propertyName ?? item.name).text, local: item.name.text, typeOnly: typeOnly || item.isTypeOnly });
    } else if (exporting && !named) {
      for (const symbol of origins.exports(shim)) if (symbol.name !== "default") bindings.push({ imported: symbol.name, local: symbol.name, typeOnly: typeOnly || !(origins.actual(symbol).flags & ts.SymbolFlags.Value) });
    }
    if (!bindings.length) continue;
    const groups = groupsFor(origins, shim, source, specifier, bindings);
    if (groups.length === 1 && groups[0]!.specifier === specifier.text) continue;
    const start = statement.getStart(source);
    const quote = source.text[specifier.getStart(source)]!;
    const suffix = source.text.slice(specifier.end, statement.end);
    const output = groups.map((group) => renderGroup(group, exporting, typeOnly, quote, suffix)).join("\n").replace(/\n/g, eolOf(source.text));
    changes.push({ span: { start, length: statement.end - start }, newText: output });
  }
  return changes;
}

/** Mixed modules retain all re-exports. Return whether an unreferenced pure shim was deleted. */
export function inlineReexports(ws: Workspace, file: string, source: ts.SourceFile, notes: string[], keep = false): boolean {
  if (file.split(sep).includes("node_modules") || ws.vfs.isHidden(file)) fail("OUTSIDE_PROJECT", `cannot inline a dependency or build output: ${file}`);
  const origins = new Origins(ws);
  const files = ws.program().getSourceFiles().filter((item) => isInside(ws.root, resolve(item.fileName))
    && !item.fileName.split(sep).includes("node_modules") && !ws.vfs.isHidden(item.fileName));
  // Compute every edit against one checker/program before changing any overlays.
  const edits = files.filter((item) => !ws.vfs.samePath(item.fileName, file)).map((item) => ({ source: item, changes: rewrite(origins, source, item, notes) }));
  for (const edit of edits) if (edit.changes.length) ws.vfs.write(edit.source.fileName, applyTextChanges(edit.source.text, edit.changes));
  const remaining = ws.program().getSourceFiles().filter((item) => isInside(ws.root, resolve(item.fileName))
    && !item.fileName.split(sep).includes("node_modules") && !ws.vfs.isHidden(item.fileName)).some((item) =>
    moduleSpecifiers(item).some((specifier) => {
      const target = ws.resolveModule(specifier, item);
      return target && ws.vfs.samePath(target.resolvedFileName, file);
    }) || item.referencedFiles.some((reference) => ws.vfs.samePath(resolve(dirname(item.fileName), reference.fileName), file)));
  if (!keep && pureShim(source) && !remaining) {
    ws.vfs.write(file, null);
    ws.updateConfigLists([], [file]);
    ws.reparse();
    notes.push(`Deleted unreferenced re-export shim ${file}.`);
    return true;
  }
  notes.push(keep ? `Kept ${file} (--keep).` : `Kept ${file} and its re-exports (${remaining ? "remaining module references" : "local declarations"}).`);
  return false;
}
