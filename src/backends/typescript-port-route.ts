import ts from "typescript";
import { createRequire } from "node:module";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RefactorRequest } from "../types";
import { ImportSet, fill, loadPortRouteConfig, render, type LoadedConfig, type Snippet } from "./typescript-port-route-config";
import { RouteExtractor, type ImportRef, type Preload, type RouteModel, type Translation } from "./typescript-port-route-extract";
import { packageSpecifier } from "./typescript-package-specifiers";
import { portablePath } from "./typescript-paths";
import { excludedByPatterns, fail, isInside } from "./typescript-vfs";
import { applyTextChanges, configPathFor, type Workspace } from "./typescript-workspace";

/**
 * port-route: move a Next App Router route's client view into a feature
 * package, then generate the thin Next adapter and the TanStack Start route
 * from the page's preload calls. One plan, validated like move-file.
 */

export interface PortRoutePrep {
  config: LoadedConfig;
  routeDir: string;
  page: string;
  /** TanStack path segments, e.g. ["dashboard", "properties", "$code", "units"]. */
  segments: string[];
  params: string[];
  index: boolean;
  startRoutes: string;
  startConfig: string;
  startFile: string;
  /** createFileRoute id, e.g. /dashboard/tenancies/$id/ for index routes. */
  routeId: string;
  /** Logical URL, e.g. /dashboard/properties/$code/units. */
  routePath: string;
  routeName: string;
  moves: [string, string][];
  map: Record<string, string>;
  /** Files kept in Next because they are excluded, server-only or nested routes. */
  kept: string[];
}

const pageNames = ["page.tsx", "page.ts", "page.jsx", "page.js"];

function pascal(value: string): string {
  return value.split(/[^A-Za-z0-9]+/).filter(Boolean).map(part => part[0]!.toUpperCase() + part.slice(1)).join("");
}

function camel(value: string): string {
  const name = pascal(value);
  return name ? name[0]!.toLowerCase() + name.slice(1) : name;
}

function hasPage(directory: string): boolean {
  return pageNames.some(name => { try { return lstatSync(join(directory, name)).isFile(); } catch { return false; } });
}

/** Disk-only: configuration, route naming and the files to move. */
export function preparePortRoute(request: RefactorRequest, sys: ts.System): PortRoutePrep {
  const root = request.root, routeDir = resolve(request.file);
  if (!request.config) fail("INVALID_REQUEST", "port-route requires a configuration");
  if (!request.target) fail("INVALID_REQUEST", "port-route requires --to");
  const config = loadPortRouteConfig(root, request.config, sys);
  const page = pageNames.map(name => join(routeDir, name)).find(path => sys.fileExists(path));
  if (!page) fail("PORT_ROUTE_PAGE_NOT_FOUND", `${routeDir} has no page.tsx`);
  const appDirectory = config.next.appDirectory;
  if (!isInside(appDirectory, routeDir)) fail("PORT_ROUTE_OUTSIDE_APP", `${routeDir} is not below next.appDirectory ${appDirectory}`);
  const segments: string[] = [], params: string[] = [];
  for (const part of portablePath(relative(appDirectory, routeDir)).split("/").filter(Boolean)) {
    if (/^\(.+\)$/.test(part)) continue;
    if (/^\[\[?\.\.\./.test(part) || part.startsWith("@") || part.startsWith("_")) fail("PORT_ROUTE_UNSUPPORTED_SEGMENT", `${part}: catch-all, parallel and private segments need a hand-written Start route`);
    const dynamic = /^\[([A-Za-z_$][\w$]*)\]$/.exec(part);
    if (dynamic) { segments.push(`$${dynamic[1]}`); params.push(dynamic[1]!); continue; }
    if (part.includes("[") || part.includes(".")) fail("PORT_ROUTE_UNSUPPORTED_SEGMENT", `${part} cannot be expressed as a flat TanStack route segment`);
    segments.push(part);
  }
  // Nested Next routes make this route a TanStack index leaf beside its children.
  const kept: string[] = [], moves: [string, string][] = [];
  let index = false;
  const target = resolve(request.target);
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("SYMLINK_UNSUPPORTED", path);
      if (entry.isDirectory()) {
        if (hasPage(path) || nestedRoute(path)) { index = true; kept.push(path); continue; }
        visit(path);
        continue;
      }
      if (!entry.isFile()) fail("UNSUPPORTED_FILE", path);
      const excluded = excludedByPatterns(path, routeDir, [...config.next.exclude, ...(request.exclude ?? [])]);
      if (excluded || serverOnly(path)) { kept.push(path); continue; }
      moves.push([path, join(target, relative(routeDir, path))]);
    }
  };
  const nestedRoute = (directory: string): boolean => readdirSync(directory, { withFileTypes: true })
    .some(entry => entry.isDirectory() && (hasPage(join(directory, entry.name)) || nestedRoute(join(directory, entry.name))));
  const serverOnly = (path: string) => {
    if (!/\.[cm]?[jt]sx?$/.test(path)) return false;
    const text = sys.readFile(path) ?? "";
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
    return source.statements.some(statement => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && config.next.serverOnlyModules.includes(statement.moduleSpecifier.text));
  };
  visit(routeDir);
  if (!moves.length) fail("EMPTY_DIRECTORY", `${routeDir} has no client files to move after exclusions`);
  const startRoutes = request.startRoutes ? resolve(request.startRoutes) : config.start.routes;
  const startConfig = configPathFor(config.start.project);
  const fileName = segments.length ? `${segments.join(".")}${index ? ".index" : ""}.tsx` : "index.tsx";
  const routePath = `/${segments.join("/")}`;
  const routeId = segments.length ? `${routePath}${index ? "/" : ""}` : "/";
  const routeName = pascal([...segments].reverse().find(segment => !segment.startsWith("$")) ?? "index");
  return {
    config, routeDir, page, segments, params, index, startRoutes, startConfig, startFile: join(startRoutes, fileName), routeId, routePath, routeName,
    moves, map: { ...config.map, ...(request.map ?? {}) }, kept: kept.sort(),
  };
}

function relativeSpecifier(from: string, to: string): string {
  const path = portablePath(relative(dirname(from), to)).replace(/\.[cm]?[jt]sx?$/, "").replace(/\/index$/, "");
  return path.startsWith(".") ? path : `./${path}`;
}

interface DataProp { attribute: string; prop: string; name: string; preload: Preload }

const todoReason = (text: string) => `TODO(port-route): ${text}`;

/** Identifier references by name, excluding import bindings and property/attribute names. */
function references(source: ts.SourceFile, name: string): number {
  let count = 0;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent;
      const named = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node)
        || (ts.isPropertySignature(parent) && parent.name === node) || ts.isJsxAttribute(parent) || (ts.isBindingElement(parent) && parent.propertyName === node)
        || (ts.isQualifiedName(parent) && parent.right === node) || (ts.isMethodDeclaration(parent) && parent.name === node);
      if (!named) count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

/** Bindings each import declaration introduces, by local name. */
function importLocals(source: ts.SourceFile): Map<string, { statement: ts.ImportDeclaration; node: ts.Node; module: string; imported: string }> {
  const locals = new Map<string, { statement: ts.ImportDeclaration; node: ts.Node; module: string; imported: string }>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) continue;
    const module = statement.moduleSpecifier.text, clause = statement.importClause;
    if (clause.name) locals.set(clause.name.text, { statement, node: clause.name, module, imported: "default" });
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) locals.set(bindings.name.text, { statement, node: bindings, module, imported: "*" });
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
      locals.set(element.name.text, { statement, node: element, module, imported: (element.propertyName ?? element.name).text });
    }
  }
  return locals;
}

/** Delete a statement with its own line (and leading comments) when it starts one. */
function removal(source: ts.SourceFile, statement: ts.Statement): ts.TextChange {
  const text = source.text;
  const start = statement.getStart(source), lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const ownLine = !text.slice(lineStart, start).trim();
  const from = ownLine ? lineStart : statement.getFullStart();
  const to = ownLine && text[statement.end] === "\n" ? statement.end + 1 : statement.end;
  return { span: { start: from, length: to - from }, newText: "" };
}

/** Remove import bindings an edit made unused and add required ones, preserving the rest. */
function updateImports(path: string, before: string, after: string, add: ImportSet): string {
  const original = ts.createSourceFile(path, before, ts.ScriptTarget.Latest, true);
  let source = ts.createSourceFile(path, after, ts.ScriptTarget.Latest, true);
  const removed = new Set<ts.Node>();
  for (const [local, binding] of importLocals(source)) {
    if (references(original, local) > 0 && references(source, local) === 0) removed.add(binding.node);
  }
  const edits: ts.TextChange[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const clause = statement.importClause, bindings = clause.namedBindings;
    const elements = bindings && ts.isNamedImports(bindings) ? bindings.elements : undefined;
    const keptElements = elements?.filter(element => !removed.has(element)) ?? [];
    const keepDefault = clause.name && !removed.has(clause.name);
    const keepNamespace = bindings && ts.isNamespaceImport(bindings) && !removed.has(bindings);
    if (!keepDefault && !keepNamespace && !keptElements.length) {
      if (clause.name || bindings) {
        edits.push(removal(source, statement));
      }
      continue;
    }
    if (elements && keptElements.length !== elements.length) {
      edits.push({ span: { start: bindings!.getStart(source), length: bindings!.getWidth(source) }, newText: `{ ${keptElements.map(element => element.getText(source)).join(", ")} }` });
    }
    if (clause.name && !keepDefault) fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${path}: cannot remove the unused default import ${clause.name.text} alongside named imports`);
  }
  let text = applyTextChanges(after, edits);
  source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const existing = importLocals(source);
  const additions = new ImportSet();
  const printed = ts.createSourceFile("add.ts", add.print(), ts.ScriptTarget.Latest, true);
  for (const statement of printed.statements as ts.NodeArray<ts.ImportDeclaration>) {
    const module = (statement.moduleSpecifier as ts.StringLiteral).text;
    const clause = statement.importClause!, bindings = clause.namedBindings;
    const wanted: { local: string; add(): void }[] = [
      ...(clause.name ? [{ local: clause.name.text, add: () => additions.addDefault(module, clause.name!.text, clause.isTypeOnly) }] : []),
      ...(bindings && ts.isNamespaceImport(bindings) ? [{ local: bindings.name.text, add: () => additions.addNamespace(module, bindings.name.text) }] : []),
      ...(bindings && ts.isNamedImports(bindings) ? bindings.elements.map(element => ({ local: element.name.text,
        add: () => additions.addNamed(module, (element.propertyName ?? element.name).text, element.name.text, clause.isTypeOnly || element.isTypeOnly) })) : []),
    ];
    for (const binding of wanted) {
      const found = existing.get(binding.local);
      if (found && found.module !== module) fail("PORT_ROUTE_IMPORT_CONFLICT", `${path} already binds ${binding.local} from ${found.module}; the data prop type needs it from ${module}`);
      if (!found) binding.add();
    }
  }
  const block = additions.print(text.includes("'") && !text.includes('"') ? "'" : '"');
  if (!block) return text;
  const imports = source.statements.filter(ts.isImportDeclaration);
  const anchor = imports.at(-1)?.end ?? (source.statements.find(statement => !ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression))?.getFullStart() ?? 0);
  text = imports.length || anchor ? `${text.slice(0, anchor)}\n${block}${text.slice(anchor)}` : `${block}\n${text}`;
  return text;
}

/** Map preload props to data props in the moved view: `usePreloaded(preloadedX).data` becomes the `initialX` prop. */
function rewriteView(ws: Workspace, prep: PortRoutePrep, model: RouteModel): DataProp[] {
  const program = ws.program(), checker = program.getTypeChecker();
  const component = model.view.component, viewPath = model.view.path;
  const source = component.getSourceFile();
  const preloaded = model.view.attributes.filter(attribute => attribute.kind === "preloaded");
  if (!preloaded.length) return [];
  const parameter = component.parameters[0];
  if (!parameter) fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${model.view.tag} declares no props parameter`);
  const hook = hookSymbol(ws, checker, viewPath, prep.config.data.hook);
  const resolveAlias = (symbol: ts.Symbol | undefined) => symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const edits: ts.TextChange[] = [];
  const typeImports = new ImportSet();
  const result: DataProp[] = [];
  const body = (component as ts.FunctionLikeDeclaration).body;
  const locals = new Set<string>();
  const collect = (node: ts.Node) => { if (ts.isIdentifier(node)) locals.add(node.text); ts.forEachChild(node, collect); };
  collect(component);
  for (const attribute of preloaded) {
    const base = attribute.name.replace(/^preloaded/i, "") || attribute.name;
    const prop = fill(prep.config.data.prop, { Name: pascal(base) === base ? base : base[0]!.toUpperCase() + base.slice(1), name: camel(base) }, "data.prop");
    if (model.view.props.some(item => item.name === prop)) fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${model.view.tag} already declares ${prop}; choose another data.prop pattern`);
    // The props binding: destructured element or `props.<name>` access.
    let reference: ts.Node | undefined, dataReference: string, renamed = false;
    if (ts.isObjectBindingPattern(parameter.name)) {
      const element = parameter.name.elements.find(item => (item.propertyName ?? item.name).getText(source) === attribute.name);
      if (!element || !ts.isIdentifier(element.name) || element.initializer || element.dotDotDotToken) fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${model.view.tag} must destructure ${attribute.name} without a default`);
      const symbol = checker.getSymbolAtLocation(element.name)!;
      const uses: ts.Identifier[] = [];
      const visit = (node: ts.Node) => { if (ts.isIdentifier(node) && node !== element.name && checker.getSymbolAtLocation(node) === symbol) uses.push(node); ts.forEachChild(node, visit); };
      if (body) visit(body);
      if (uses.length !== 1) fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${attribute.name} must be used exactly once, as the ${prep.config.data.hook.name} argument (found ${uses.length})`);
      reference = uses[0];
      if (element.propertyName) {
        edits.push({ span: { start: element.propertyName.getStart(source), length: element.propertyName.getWidth(source) }, newText: prop });
        dataReference = element.name.text;
      } else {
        renamed = true;
        edits.push({ span: { start: element.name.getStart(source), length: element.name.getWidth(source) }, newText: prop });
        dataReference = prop;
      }
    } else if (ts.isIdentifier(parameter.name)) {
      const symbol = checker.getSymbolAtLocation(parameter.name)!;
      const uses: ts.PropertyAccessExpression[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === attribute.name && ts.isIdentifier(node.expression) && checker.getSymbolAtLocation(node.expression) === symbol) uses.push(node);
        ts.forEachChild(node, visit);
      };
      if (body) visit(body);
      if (uses.length !== 1) fail("PORT_ROUTE_VIEW_UNSUPPORTED", `props.${attribute.name} must be used exactly once, as the ${prep.config.data.hook.name} argument`);
      reference = uses[0];
      dataReference = `${parameter.name.text}.${prop}`;
    } else fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${model.view.tag} props must be an identifier or object destructuring`);
    const call = reference!.parent;
    if (!ts.isCallExpression(call) || call.arguments[0] !== reference || resolveAlias(checker.getSymbolAtLocation(call.expression)) !== hook) {
      fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${attribute.name} must be passed directly to ${prep.config.data.hook.name} from ${prep.config.data.hook.module}`);
    }
    const holder = call.parent;
    // `const initialX = usePreloaded(preloadedX).data` collapses into the renamed prop binding.
    const declaration = ts.isVariableDeclaration(holder) ? holder : ts.isPropertyAccessExpression(holder) && ts.isVariableDeclaration(holder.parent) && holder.parent.initializer === holder ? holder.parent : undefined;
    const holderLocal = declaration && (ts.isIdentifier(declaration.name) ? declaration.name.text
      : ts.isObjectBindingPattern(declaration.name) && declaration.name.elements.length === 1 && ts.isIdentifier(declaration.name.elements[0]!.name) ? declaration.name.elements[0]!.name.text : undefined);
    if (renamed && locals.has(prop) && holderLocal !== prop) fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${prop} already names a binding in ${model.view.tag}`);
    const statement = declaration?.parent.parent;
    const collapse = renamed && holderLocal === prop && statement && ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1;
    if (collapse && (ts.isIdentifier(declaration!.name) ? ts.isPropertyAccessExpression(holder) && holder.name.text === "data"
      : (declaration!.name as ts.ObjectBindingPattern).elements[0]!.propertyName?.getText(source) === "data")) {
      edits.push(removal(source, statement!));
    } else if (ts.isVariableDeclaration(holder) && holder.initializer === call && ts.isObjectBindingPattern(holder.name) && holder.name.elements.length === 1
      && (holder.name.elements[0]!.propertyName ?? holder.name.elements[0]!.name).getText(source) === "data" && ts.isIdentifier(holder.name.elements[0]!.name) && !holder.name.elements[0]!.initializer) {
      const local = (holder.name.elements[0]!.name as ts.Identifier).text;
      edits.push({ span: { start: holder.getStart(source), length: holder.getWidth(source) }, newText: `${local} = ${dataReference}` });
    } else if (ts.isPropertyAccessExpression(holder) && holder.expression === call && holder.name.text === "data") {
      edits.push({ span: { start: holder.getStart(source), length: holder.getWidth(source) }, newText: dataReference });
    } else fail("PORT_ROUTE_VIEW_UNSUPPORTED", `use \`const { data } = ${prep.config.data.hook.name}(${attribute.name})\` or \`.data\` in ${model.view.tag} before porting`);
    // The prop's declared member gets the data name and type.
    const property = checker.getTypeAtLocation(parameter).getProperty(attribute.name);
    const member = property?.declarations?.[0];
    if (!member || !ts.isPropertySignature(member) || !member.type || resolve(member.getSourceFile().fileName) !== resolve(source.fileName)) {
      fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${attribute.name} must be declared as a property signature in ${source.fileName}`);
    }
    let typeText: string;
    if (call.typeArguments?.length === 1) typeText = fill(prep.config.data.typeArgument, { type: call.typeArguments[0]!.getText(source) }, "data.typeArgument");
    else {
      typeImports.addText(prep.config.data.type.imports, "data.type.imports");
      for (const item of attribute.preload!.query.imports) addRef(typeImports, item, () => fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${item.local} is imported from a file; data.type needs package imports`));
      typeText = fill(prep.config.data.type.value, { query: attribute.preload!.query.text }, "data.type");
    }
    edits.push({ span: { start: member.name.getStart(source), length: member.name.getWidth(source) }, newText: prop });
    edits.push({ span: { start: member.type.getStart(source), length: member.type.getWidth(source) }, newText: typeText });
    result.push({ attribute: attribute.name, prop, name: camel(base), preload: attribute.preload! });
  }
  const before = ws.vfs.readFile(viewPath)!;
  if (before !== source.text) fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${viewPath} changed before the view rewrite`);
  ws.vfs.write(viewPath, updateImports(viewPath, before, applyTextChanges(before, edits), typeImports));
  return result;
}

function hookSymbol(ws: Workspace, checker: ts.TypeChecker, from: string, hook: { module: string; name: string }): ts.Symbol {
  const options = ws.ownersOf(from)[0] ? ws.participant(ws.ownersOf(from)[0]!).parsed.options : ws.editOptions;
  const resolved = ts.resolveModuleName(hook.module, from, options, ws.vfs.moduleResolutionHost()).resolvedModule;
  const file = resolved && ws.program().getSourceFile(resolved.resolvedFileName);
  const module = file && checker.getSymbolAtLocation(file);
  const exported = module && checker.getExportsOfModule(module).find(symbol => symbol.name === hook.name);
  if (!exported) fail("PORT_ROUTE_HOOK_NOT_FOUND", `${hook.module} does not export ${hook.name} from ${from}`);
  return exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
}

function addRef(set: ImportSet, item: ImportRef, file: (path: string) => string | undefined | never): void {
  const module = item.target.kind === "package" ? item.target.module : file(item.target.path);
  if (module === undefined) return;
  if (item.imported === "default") set.addDefault(module, item.local, item.typeOnly);
  else if (item.imported === "*") set.addNamespace(module, item.local);
  else set.addNamed(module, item.imported, item.local, item.typeOnly);
}

interface Generated { path: string; text: string; todos: string[] }

class Builder {
  readonly imports = new ImportSet();
  readonly setup: string[] = [];
  readonly todos: string[] = [];
  constructor(readonly path: string) {}
  snippet(item: Snippet, values: Record<string, string>, origin: string): string {
    this.imports.addText(item.imports?.map(line => fill(line, values, origin)), origin);
    for (const line of item.setup ?? []) { const text = fill(line, values, origin); if (!this.setup.includes(text)) this.setup.push(text); }
    return fill(item.value, values, origin);
  }
  todo(config: LoadedConfig, reason: string): string {
    this.todos.push(reason);
    return fill(config.snippets.todo, { message: JSON.stringify(todoReason(reason)) }, "snippets.todo");
  }
}

function jsx(tag: string, props: [string, string][]): string {
  if (!props.length) return `<${tag} />`;
  if (props.length === 1) return `<${tag} ${props[0]![0]}={${props[0]![1]}} />`;
  return `<${tag}\n${props.map(([name, value]) => `  ${name}={${value}}`).join("\n")}\n/>`;
}

const viewLocal = (tag: string) => tag.endsWith("View") ? `${tag}Component` : `${tag}View`;

/** Generate adapter, Start route and page rewrite after the move; returns generated files for notes and checks. */
export function generatePortRoute(ws: Workspace, prep: PortRoutePrep, model: RouteModel, dataProps: DataProp[], renames: [string, string][], notes: string[]): Generated[] {
  const moved = new Map(renames.map(([from, to]) => [ws.vfs.key(from), to]));
  const viewTarget = moved.get(ws.vfs.key(model.view.path));
  if (!viewTarget) fail("PORT_ROUTE_VIEW_NOT_FOUND", `${model.view.path} is not among the moved files`);
  const config = prep.config;
  const viewModule = basename(model.view.path, extname(model.view.path));
  const adapterPath = join(prep.routeDir, fill(config.next.adapterFile, { view: viewModule, route: prep.segments.filter(item => !item.startsWith("$")).at(-1) ?? "index" }, "next.adapterFile"));
  if (ws.vfs.fileExists(adapterPath)) fail("TARGET_EXISTS", `${adapterPath}; remove the existing adapter or choose next.adapterFile`);
  if (ws.vfs.fileExists(prep.startFile)) fail("TARGET_EXISTS", `${prep.startFile} (the route is already ported)`);
  const fileSpecifier = (importer: string) => (path: string) => {
    const target = moved.get(ws.vfs.key(path));
    if (!target) fail("PORT_ROUTE_UNSUPPORTED_PAGE", `${importer} cannot import ${path}, which stays in Next`);
    return packageSpecifier(ws, importer, target) ?? relativeSpecifier(importer, target);
  };
  const props = model.view.props.map(item => {
    const data = dataProps.find(entry => entry.attribute === item.name);
    return data ? { name: data.prop, optional: item.optional } : item;
  });
  const adapter = nextAdapter(ws, prep, model, dataProps, props, adapterPath, viewTarget);
  const start = startRoute(ws, prep, model, dataProps, props, viewTarget, fileSpecifier(prep.startFile));
  for (const file of [adapter, start]) {
    ws.vfs.write(file.path, file.text, false);
    for (const reason of file.todos) notes.push(`${todoReason(reason)} (${relative(ws.root, file.path)})`);
  }
  rewritePage(ws, prep, model, viewTarget, adapterPath);
  ws.reparse();
  for (const [path, config] of [[adapterPath, ws.sourceConfig], [prep.startFile, prep.startConfig]] as const) {
    const owners = ws.ownersOf(path);
    if (owners.length !== 1 || !ws.vfs.samePath(owners[0]!, config)) fail("TARGET_NOT_IN_PROJECT", `${path} must belong to exactly ${config}; owners: ${owners.join(", ") || "none"}`);
  }
  notes.push(`Generated ${relative(ws.root, adapterPath)} (Next adapter) and ${relative(ws.root, prep.startFile)} (Start route ${prep.routeId}); ${relative(ws.root, prep.page)} renders the adapter.`);
  if (prep.kept.length) notes.push(`Kept in Next: ${prep.kept.map(path => relative(ws.root, path)).join(", ")}.`);
  notes.push("Server-only page logic (authentication, redirects, notFound, metadata) is not translated; confirm the Start layout and loader cover it.");
  if (config.afterApply.length) notes.push(`After apply run: ${config.afterApply.join("; ")}.`);
  return [adapter, start];
}

function nextAdapter(ws: Workspace, prep: PortRoutePrep, model: RouteModel, dataProps: DataProp[], props: { name: string; optional: boolean }[], path: string, viewTarget: string): Generated {
  const config = prep.config, out = new Builder(path);
  out.imports.addText(config.next.imports, "next.imports");
  const local = viewLocal(model.view.tag);
  const viewModule = packageSpecifier(ws, path, viewTarget) ?? relativeSpecifier(path, viewTarget);
  if (model.view.exported === "default") out.imports.addDefault(viewModule, local);
  else out.imports.addNamed(viewModule, model.view.exported, local);
  const parameters: string[] = [], types: string[] = [], values: [string, string][] = [];
  for (const attribute of model.view.attributes) {
    parameters.push(attribute.name);
    const data = dataProps.find(item => item.attribute === attribute.name);
    if (data) {
      const preload = data.preload;
      let type: string;
      if (preload.hook) {
        out.imports.addNamed(relativeSpecifier(path, preload.hook.path), preload.hook.name, preload.hook.name, true);
        type = out.snippet(config.snippets.nextHookType, { hook: preload.hook.name, query: preload.query.text }, "snippets.nextHookType");
      } else {
        for (const item of preload.query.imports) addRef(out.imports, { ...item, typeOnly: true }, file => relativeSpecifier(path, file));
        type = out.snippet(config.snippets.nextDirectType, { query: preload.query.text }, "snippets.nextDirectType");
      }
      types.push(`${attribute.name}: ${type};`);
      const value = out.snippet(config.snippets.nextData, { name: data.name, prop: attribute.name, query: preload.query.text }, "snippets.nextData");
      values.push([data.prop, value]);
    } else {
      out.imports.addNamed("react", "ComponentProps", "ComponentProps", true);
      const optional = model.view.props.find(item => item.name === attribute.name)?.optional ? "?" : "";
      types.push(`${attribute.name}${optional}: ComponentProps<typeof ${local}>[${JSON.stringify(attribute.name)}];`);
      values.push([attribute.name, attribute.name]);
    }
  }
  fillPorts(out, prep, props, values, "next");
  const exported = model.view.exported === "default" ? model.view.tag : model.view.exported;
  const text = render(config.nextAdapterTemplate, {
    imports: out.imports.print(),
    name: exported,
    export: model.view.exported === "default" ? "export default function" : "export function",
    params: parameters.length ? `{ ${parameters.join(", ")} }` : "",
    propsType: parameters.length ? `: {\n${types.map(line => `  ${line}`).join("\n")}\n}` : "",
    setup: out.setup.join("\n"),
    todos: out.todos.map(reason => `// ${todoReason(reason)}`).join("\n"),
    view: jsx(local, values),
  }, config.templates.nextAdapter);
  return { path, text, todos: out.todos };
}

/** View props served by configured ports and route parameters; missing required props become TODOs. */
function fillPorts(out: Builder, prep: PortRoutePrep, props: { name: string; optional: boolean }[], values: [string, string][], side: "next" | "start"): void {
  const config = prep.config;
  for (const prop of props) {
    if (values.some(([name]) => name === prop.name)) continue;
    const port = config.ports[prop.name];
    if (port) { values.push([prop.name, out.snippet(port[side], { name: prop.name, path: prep.routePath }, `ports.${prop.name}.${side}`)]); continue; }
    if (prep.params.includes(prop.name) && config.params) { values.push([prop.name, out.snippet(config.params[side], { name: prop.name, path: prep.routePath }, `params.${side}`)]); continue; }
    if (!prop.optional) values.push([prop.name, out.todo(config, `provide required view prop '${prop.name}' (add ports.${prop.name} to port-route.json)`)]);
  }
}

function startRoute(ws: Workspace, prep: PortRoutePrep, model: RouteModel, dataProps: DataProp[], props: { name: string; optional: boolean }[], viewTarget: string, file: (path: string) => string): Generated {
  const config = prep.config, path = prep.startFile, out = new Builder(path);
  out.imports.addText(config.start.imports, "start.imports");
  const viewModule = packageSpecifier(ws, path, viewTarget) ?? relativeSpecifier(path, viewTarget);
  const local = model.view.exported === "default" ? model.view.tag : model.view.exported;
  if (model.view.exported === "default") out.imports.addDefault(viewModule, local);
  else out.imports.addNamed(viewModule, model.view.exported, local);
  const add = (translation: Translation) => { for (const item of translation.imports) addRef(out.imports, item, file); };
  const queries: string[] = [], statements: string[] = [], prefetches: string[] = [], returns: string[] = [];
  const loaderTodos: string[] = [];
  for (const statement of model.statements) { add(statement); statements.push(statement.text); }
  const names = new Map<Preload, string>();
  const used = new Set<string>();
  for (const preload of model.preloads) {
    const data = dataProps.find(item => item.preload === preload);
    let name = data?.name ?? camel(preload.variable.replace(/^preloaded/i, "") || preload.query.text.split(".").slice(-2).join(" "));
    while (used.has(name)) name = `${name}2`;
    used.add(name); names.set(preload, name);
    add(preload.query);
    out.imports.addText(config.snippets.startQuery.imports?.map(line => fill(line, { name, query: preload.query.text }, "snippets.startQuery")), "snippets.startQuery");
    queries.push(fill(config.snippets.startQuery.value, { name, query: preload.query.text }, "snippets.startQuery"));
    let args: string;
    if ("todo" in preload.args) { loaderTodos.push(`translate ${preload.variable} arguments: ${preload.args.todo}`); args = fill(config.snippets.todo, { message: JSON.stringify(todoReason(`translate ${preload.variable} arguments`)) }, "snippets.todo"); }
    else { add(preload.args); args = preload.args.text; }
    statements.push(`const ${name}Args = ${args};`);
    prefetches.push(fill(config.snippets.startPrefetch, { name, args: `${name}Args`, query: preload.query.text }, "snippets.startPrefetch"));
    returns.push(`${name}Args`);
  }
  const values: [string, string][] = [];
  for (const attribute of model.view.attributes) {
    const data = dataProps.find(item => item.attribute === attribute.name);
    if (data) {
      const name = names.get(data.preload)!;
      values.push([data.prop, out.snippet(config.snippets.startData, { name, args: `${name}Args`, query: data.preload.query.text }, "snippets.startData")]);
      continue;
    }
    const start = attribute.start!;
    const optional = model.view.props.find(item => item.name === attribute.name)?.optional ?? false;
    if ("todo" in start) {
      if (optional) out.todos.push(`translate optional prop '${attribute.name}={${attribute.source}}': ${start.todo}; omitted`);
      else values.push([attribute.name, out.todo(config, `translate prop '${attribute.name}={${attribute.source}}': ${start.todo}`)]);
      continue;
    }
    add(start);
    const literal = /^(?:"[^"\n]*"|'[^'\n]*'|-?\d[\d_.]*|true|false|null)$/.test(start.text);
    if (literal) values.push([attribute.name, start.text]);
    else { statements.push(`const ${attribute.name} = ${start.text};`); returns.push(attribute.name); values.push([attribute.name, attribute.name]); }
  }
  for (const reason of loaderTodos) out.todos.push(reason);
  fillPorts(out, prep, props, values, "start");
  const loaderTodo = loaderTodos.map(reason => `// ${todoReason(reason)}`);
  const body = [...loaderTodo, ...statements].join("\n");
  const loaderValues = (args: string) => ({ loaderArgs: args, statements: body, prefetches: prefetches.join(",\n"), returns: returns.join(", "), path: prep.routePath, id: prep.routeId });
  const loaderSnippet = prep.params.length && config.snippets.startRecordLoader ? config.snippets.startRecordLoader : config.snippets.startLoader;
  out.imports.addText(loaderSnippet.imports, "snippets.startLoader");
  const probe = render(loaderSnippet.value, loaderValues(""), "snippets.startLoader");
  const loaderArgs = config.start.loaderArgs.filter(name => new RegExp(`(?<![\\w$.])${name.replace(/[$]/g, "\\$")}(?![\\w$])`).test(probe));
  const loader = render(loaderSnippet.value, loaderValues(loaderArgs.length ? `{ ${loaderArgs.join(", ")} }` : ""), "snippets.startLoader");
  const component = `${prep.routeName}Page`;
  const localNames = out.imports.locals();
  for (const name of [component, "Route", ...[...names.values()].map(name => `${name}Query`)]) {
    if (localNames.has(name)) fail("PORT_ROUTE_NAME_CONFLICT", `${name} is both generated and imported in ${path}`);
  }
  const setup = [...(returns.length ? [`const { ${returns.join(", ")} } = Route.useLoaderData();`] : []), ...out.setup];
  const text = render(config.startRouteTemplate, {
    imports: out.imports.print(),
    queries: queries.join("\n"),
    id: prep.routeId,
    path: prep.routePath,
    searchDeps: loaderArgs.includes("location") && config.snippets.startSearchDeps ? config.snippets.startSearchDeps : "",
    loader,
    component,
    setup: setup.join("\n"),
    todos: out.todos.filter(reason => !loaderTodos.includes(reason)).map(reason => `// ${todoReason(reason)}`).join("\n"),
    view: jsx(local, values),
  }, config.templates.startRoute);
  return { path, text, todos: out.todos };
}

/** The page keeps its server logic and renders the generated adapter. */
function rewritePage(ws: Workspace, prep: PortRoutePrep, model: RouteModel, viewTarget: string, adapterPath: string): void {
  const text = ws.vfs.readFile(prep.page)!;
  const source = ts.createSourceFile(prep.page, text, ts.ScriptTarget.Latest, true);
  const specifier = relativeSpecifier(prep.page, adapterPath);
  const edits: ts.TextChange[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause) continue;
    const resolved = ws.resolveModule(statement.moduleSpecifier, source);
    if (!resolved || !ws.vfs.samePath(resolved.resolvedFileName, viewTarget)) continue;
    const clause = statement.importClause, bindings = clause.namedBindings;
    const view = model.view.exported === "default" ? clause.name : bindings && ts.isNamedImports(bindings)
      ? bindings.elements.find(element => (element.propertyName ?? element.name).text === model.view.exported) : undefined;
    if (!view) continue;
    const quote = text[statement.moduleSpecifier.getStart(source)]!;
    const others = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter(element => element !== view) : [];
    if (!others.length && !(model.view.exported !== "default" && clause.name)) {
      edits.push({ span: { start: statement.moduleSpecifier.getStart(source) + 1, length: statement.moduleSpecifier.getWidth(source) - 2 }, newText: specifier });
    } else {
      const remaining = model.view.exported === "default" ? `{ ${others.map(item => item.getText(source)).join(", ")} }`
        : [clause.name?.text, others.length ? `{ ${others.map(item => item.getText(source)).join(", ")} }` : undefined].filter(Boolean).join(", ");
      edits.push({ span: { start: statement.getStart(source), length: statement.getWidth(source) },
        newText: `import ${remaining} from ${statement.moduleSpecifier.getText(source)};\nimport ${model.view.exported === "default" ? view.getText(source) : `{ ${view.getText(source)} }`} from ${quote}${specifier}${quote};` });
    }
  }
  if (!edits.length) fail("PORT_ROUTE_VIEW_NOT_FOUND", `${prep.page} no longer imports the moved view`);
  ws.vfs.write(prep.page, applyTextChanges(text, edits));
}

/**
 * Regenerate an ignored route tree with the project's own generator in a
 * scratch mirror of the routes directory. The result is validation-only: it
 * is not part of the plan, because the dev server/typecheck regenerates it.
 */
export async function regenerateRouteTree(ws: Workspace, prep: PortRoutePrep, generated: Generated, notes: string[]): Promise<void> {
  const tree = prep.config.start.routeTree;
  if (!tree) { notes.push("No start.routeTree configured; the Start route validates against the existing route registration."); return; }
  const routesRelative = relative(tree.configDirectory, prep.startRoutes), treeRelative = relative(tree.configDirectory, tree.file);
  if ([routesRelative, treeRelative].some(path => path.startsWith("..") || isInside(prep.startRoutes, tree.file))) fail("INVALID_PORT_ROUTE_CONFIG", "start.routes and start.routeTree.file must be inside start.routeTree.configDirectory, with the tree outside the routes");
  let entry: string;
  try { entry = createRequire(join(tree.configDirectory, "package.json")).resolve(tree.generator); }
  catch { fail("PORT_ROUTE_GENERATOR_NOT_FOUND", `${tree.generator} cannot be resolved from ${tree.configDirectory}; install dependencies (bun install)`); }
  const generator = await import(pathToFileURL(entry).href) as { Generator?: new (options: unknown) => { run(): Promise<void> }; getConfig?: (inline: object, directory: string) => object; default?: unknown };
  const api = (generator.Generator ? generator : generator.default) as typeof generator;
  if (!api?.Generator || !api.getConfig) fail("PORT_ROUTE_GENERATOR_UNSUPPORTED", `${tree.generator} must export Generator and getConfig (TanStack router-generator API)`);
  const scratch = await mkdtemp(join(tmpdir(), "refactor-ai-route-tree-"));
  try {
    ws.vfs.inputs.sys.readFile(join(tree.configDirectory, "tsr.config.json"));
    for (const source of ws.vfs.readDirectory(prep.startRoutes, undefined, undefined, ["**/*"])) {
      const target = join(scratch, routesRelative, relative(prep.startRoutes, source));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, ws.vfs.readFile(source) ?? "");
    }
    const config = api.getConfig({ routesDirectory: join(scratch, routesRelative), generatedRouteTree: join(scratch, treeRelative), tmpDir: join(scratch, ".tmp"), disableLogging: true }, tree.configDirectory);
    await new api.Generator({ config, root: tree.configDirectory }).run();
    const route = await readFile(join(scratch, routesRelative, relative(prep.startRoutes, generated.path)), "utf8");
    if (route !== generated.text) fail("PORT_ROUTE_PATH_MISMATCH", `${tree.generator} rewrote ${relative(ws.root, generated.path)}; its createFileRoute id differs from ${prep.routeId}`);
    const text = readFileSync(join(scratch, treeRelative), "utf8");
    ws.vfs.writeEphemeral(tree.file, text);
    ws.reparse();
    notes.push(`Validated with ${relative(ws.root, tree.file)} regenerated by ${tree.generator}; it is not part of the plan (ignored generator output): regenerate it after apply (dev server or the project's route generation script).`);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export { RouteExtractor, rewriteView };
export const portRouteExtractOptions = (prep: PortRoutePrep, moved: Set<string>, key: (path: string) => string) => ({
  preloadFunctions: prep.config.next.preloadFunctions,
  translate: prep.config.translate,
  params: prep.params,
  paramsObject: prep.config.start.paramsObject,
  isMoved: (path: string) => moved.has(key(path)),
});
