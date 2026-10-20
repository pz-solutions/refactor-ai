import ts from "typescript";
import { resolve } from "node:path";
import { fail } from "./typescript-vfs";
import type { Workspace } from "./typescript-workspace";

/**
 * Next App Router page analysis on the original program. Page-scope values are
 * translated into Start loader code only through configured equivalents,
 * route parameters, package imports, moved modules and the page's own pure
 * declarations; everything else becomes an explicit TODO, never a guess.
 */

/** An imported binding referenced by translated code. */
export interface ImportRef {
  local: string;
  /** Imported export name, "default" or "*". */
  imported: string;
  typeOnly: boolean;
  target: { kind: "package"; module: string } | { kind: "file"; path: string };
}

export interface Translation {
  text: string;
  imports: ImportRef[];
}

export class Untranslatable extends Error {}

export interface Preload {
  /** Page variable holding the preloaded value. */
  variable: string;
  /** Translated Convex function reference and arguments (or TODO reason). */
  query: Translation;
  args: Translation | { todo: string };
  /** Hook called by the page; undefined for a direct preload function call. */
  hook?: { name: string; path: string };
}

export interface ViewAttribute {
  name: string;
  kind: "preloaded" | "value";
  preload?: Preload;
  /** Page expression text (Next passthrough). */
  source?: string;
  /** Start translation or TODO reason. */
  start?: Translation | { todo: string };
}

export interface ViewProp { name: string; optional: boolean }

export interface RouteModel {
  page: string;
  /** Start loader statements shared by all translated values, in dependency order. */
  statements: Translation[];
  preloads: Preload[];
  view: {
    tag: string;
    /** The export the page imports: a name or "default". */
    exported: string;
    /** Original (pre-move) module path. */
    path: string;
    component: ts.SignatureDeclaration;
    attributes: ViewAttribute[];
    props: ViewProp[];
    /** JSX wrappers around the view that the generated files do not reproduce. */
    wrappers: string[];
  };
  notes: string[];
}

export interface ExtractOptions {
  preloadFunctions: string[];
  translate: Record<string, string>;
  /** Dynamic segment names of the Start route. */
  params: string[];
  /** Loader parameter holding route params (TanStack: params). */
  paramsObject: string;
  isMoved(path: string): boolean;
}

const normalize = (text: string) => text.replace(/\s+/g, "");

/** Continuation lines of copied page code lose the original statement's indentation. */
function dedent(text: string, source: ts.SourceFile, node: ts.Node): string {
  const start = node.getStart(source);
  const indent = /^[ \t]*/.exec(source.text.slice(source.text.lastIndexOf("\n", start - 1) + 1, start))![0];
  return indent ? text.split("\n").map((line, index) => index && line.startsWith(indent) ? line.slice(indent.length) : line).join("\n") : text;
}

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}

/** Parenthesize a substituted expression unless it is already a primary/member/call expression. */
function wrap(text: string): string {
  const source = ts.createSourceFile("expression.ts", `(${text})`, ts.ScriptTarget.Latest, true);
  const statement = source.statements[0];
  const expression = statement && ts.isExpressionStatement(statement) && ts.isParenthesizedExpression(statement.expression) ? statement.expression.expression : undefined;
  if (expression && (ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression) || ts.isCallExpression(expression)
    || ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression) || ts.isLiteralExpression(expression) || ts.isParenthesizedExpression(expression)
    || expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword || expression.kind === ts.SyntaxKind.NullKeyword)) return text;
  return `(${text})`;
}

interface Scope {
  source: ts.SourceFile;
  /** Function whose parameters and body declarations are in scope. */
  fn: ts.SignatureDeclaration & { body?: ts.Node };
  /** Hook parameter substitutions; page scopes have none and emit statements instead. */
  args?: Map<ts.Symbol, Translation>;
  page: boolean;
}

export class RouteExtractor {
  private readonly checker: ts.TypeChecker;
  private readonly statements: Translation[] = [];
  private readonly emitted = new Map<ts.Symbol, string>();
  private readonly notes: string[] = [];
  private readonly translations: Map<string, string>;

  constructor(private readonly ws: Workspace, private readonly options: ExtractOptions) {
    this.checker = ws.program().getTypeChecker();
    this.translations = new Map(Object.entries(options.translate).map(([from, to]) => [normalize(from), to]));
  }

  extract(page: string): RouteModel {
    const source = this.ws.program().getSourceFile(page);
    if (!source) fail("FILE_NOT_IN_PROJECT", page);
    const component = this.pageComponent(source);
    const scope: Scope = { source, fn: component, page: true };
    const preloads = this.preloads(scope);
    const element = this.viewElement(source, component);
    const view = this.view(element, preloads, scope);
    return { page, statements: this.statements, preloads, view, notes: this.notes };
  }

  private pageComponent(source: ts.SourceFile): ts.FunctionLikeDeclaration & { body: ts.Block } {
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.body && ts.getCombinedModifierFlags(statement) & ts.ModifierFlags.Default) return statement as ts.FunctionDeclaration & { body: ts.Block };
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        const symbol = this.checker.getSymbolAtLocation(unwrap(statement.expression));
        const declaration = symbol?.declarations?.[0];
        if (declaration && ts.isFunctionDeclaration(declaration) && declaration.body) return declaration as ts.FunctionDeclaration & { body: ts.Block };
        const fn = unwrap(statement.expression);
        if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isBlock(fn.body)) return fn as ts.FunctionLikeDeclaration & { body: ts.Block };
      }
    }
    fail("PORT_ROUTE_UNSUPPORTED_PAGE", `${source.fileName} must default-export a page function with a block body`);
  }

  /** `const x = await hook(...)` and `const [a, b] = await Promise.all([...])` declarations of the page body. */
  private preloads(scope: Scope): Preload[] {
    const found: Preload[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const init = unwrap(node.initializer);
        const awaited = ts.isAwaitExpression(init) ? unwrap(init.expression) : init;
        if (ts.isIdentifier(node.name)) {
          const preload = ts.isCallExpression(awaited) ? this.preloadCall(awaited, scope) : undefined;
          if (preload) found.push({ ...preload, variable: node.name.text });
        } else if (ts.isArrayBindingPattern(node.name) && ts.isCallExpression(awaited) && awaited.expression.getText(scope.source) === "Promise.all"
          && awaited.arguments[0] && ts.isArrayLiteralExpression(unwrap(awaited.arguments[0]))) {
          const elements = (unwrap(awaited.arguments[0]) as ts.ArrayLiteralExpression).elements;
          node.name.elements.forEach((binding, index) => {
            const element = elements[index] && unwrap(elements[index]!);
            if (!element || !ts.isBindingElement(binding) || !ts.isIdentifier(binding.name) || !ts.isCallExpression(element)) return;
            const preload = this.preloadCall(element, scope);
            if (preload) found.push({ ...preload, variable: binding.name.text });
          });
        }
      }
      if (!ts.isFunctionLike(node) || node === scope.fn) ts.forEachChild(node, visit);
    };
    visit(scope.fn.body!);
    const names = found.map(item => item.variable);
    if (new Set(names).size !== names.length) fail("PORT_ROUTE_UNSUPPORTED_PAGE", `preloaded variables must be unique: ${names.join(", ")}`);
    return found;
  }

  /** A call to a configured preload function, or to a hook (any non-dependency module) returning one. */
  private preloadCall(call: ts.CallExpression, scope: Scope): Omit<Preload, "variable"> | undefined {
    if (!ts.isIdentifier(call.expression)) return undefined;
    const symbol = this.checker.getSymbolAtLocation(call.expression);
    if (this.isPreloadFunction(call.expression, symbol)) return this.directPreload(call, scope);
    if (!symbol) return undefined;
    const target = symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
    const declaration = target.declarations?.[0];
    const fn = declaration && (ts.isFunctionDeclaration(declaration) ? declaration
      : ts.isVariableDeclaration(declaration) && declaration.initializer && (ts.isArrowFunction(unwrap(declaration.initializer)) || ts.isFunctionExpression(unwrap(declaration.initializer)))
        ? unwrap(declaration.initializer) as ts.ArrowFunction | ts.FunctionExpression : undefined);
    if (!fn || !fn.body) return undefined;
    const hookSource = fn.getSourceFile();
    if (hookSource.isDeclarationFile || hookSource.fileName.split(/[\\/]/).includes("node_modules")) return undefined;
    const returned = this.returnedCall(fn);
    if (!returned || !ts.isIdentifier(returned.expression) || !this.isPreloadFunction(returned.expression, this.checker.getSymbolAtLocation(returned.expression))) return undefined;
    if (!returned.arguments[0]) fail("PORT_ROUTE_UNSUPPORTED_PAGE", `${returned.expression.text}(...) needs a function reference argument in ${hookSource.fileName}`);
    const name = ts.isFunctionDeclaration(fn) && fn.name ? fn.name.text : (declaration as ts.VariableDeclaration).name.getText(hookSource);
    const hookScope: Scope = { source: hookSource, fn, args: new Map(), page: false };
    const query = this.attempt(() => this.translate(returned.arguments[0]!, { ...hookScope, args: undefined }));
    if ("todo" in query) fail("PORT_ROUTE_UNSUPPORTED_PAGE", `cannot translate the Convex function reference ${returned.arguments[0]!.getText(hookSource)} in ${hookSource.fileName}: ${query.todo}`);
    // Caller arguments are translated in the page scope, then substituted for the hook's parameters.
    const args = this.attempt(() => {
      fn.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) throw new Untranslatable(`${name} has a destructured or rest parameter`);
        const argument = call.arguments[index];
        const value = argument ? this.translate(argument, scope)
          : parameter.initializer ? this.translate(parameter.initializer, { ...hookScope, args: undefined }) : { text: "undefined", imports: [] };
        hookScope.args!.set(this.checker.getSymbolAtLocation(parameter.name)!, value);
      });
      if (call.arguments.length > fn.parameters.length) throw new Untranslatable(`${name} receives more arguments than it declares`);
      return returned.arguments[1] ? this.translate(returned.arguments[1], hookScope) : { text: "{}", imports: [] };
    });
    return { query, args, hook: { name, path: resolve(hookSource.fileName) } };
  }

  private isPreloadFunction(callee: ts.Identifier, symbol: ts.Symbol | undefined): boolean {
    const imported = symbol && this.importBinding(symbol);
    return this.options.preloadFunctions.includes(imported?.imported ?? callee.text);
  }

  private directPreload(call: ts.CallExpression, scope: Scope): Omit<Preload, "variable"> {
    const callee = call.expression.getText(scope.source);
    if (!call.arguments[0]) fail("PORT_ROUTE_UNSUPPORTED_PAGE", `${callee}(...) needs a function reference argument in ${scope.source.fileName}`);
    const query = this.attempt(() => this.translate(call.arguments[0]!, scope));
    if ("todo" in query) fail("PORT_ROUTE_UNSUPPORTED_PAGE", `cannot translate the Convex function reference ${call.arguments[0]!.getText(scope.source)}: ${query.todo}`);
    const argument = call.arguments[1];
    return { query, args: argument ? this.attempt(() => this.translate(argument, scope)) : { text: "{}", imports: [] } };
  }

  private returnedCall(fn: ts.FunctionLikeDeclaration): ts.CallExpression | undefined {
    const body = fn.body!;
    let expression: ts.Expression | undefined;
    if (!ts.isBlock(body)) expression = body as ts.Expression;
    else {
      const returns = body.statements.filter(ts.isReturnStatement);
      if (returns.length !== 1 || !returns[0]!.expression) return undefined;
      expression = returns[0]!.expression;
    }
    let call = unwrap(expression);
    if (ts.isAwaitExpression(call)) call = unwrap(call.expression);
    return ts.isCallExpression(call) ? call : undefined;
  }

  /** Run a translation transactionally: a TODO discards the statements it emitted. */
  attempt(run: () => Translation): Translation | { todo: string } {
    const statements = this.statements.length, emitted = new Map(this.emitted);
    try { return run(); }
    catch (error) {
      if (!(error instanceof Untranslatable)) throw error;
      this.statements.length = statements;
      this.emitted.clear();
      for (const [key, value] of emitted) this.emitted.set(key, value);
      return { todo: error.message };
    }
  }

  private translate(node: ts.Expression, scope: Scope): Translation {
    const imports: ImportRef[] = [];
    const text = this.expression(node, scope, imports);
    return { text, imports };
  }

  private expression(node: ts.Node, scope: Scope, imports: ImportRef[]): string {
    const source = scope.source;
    if (scope.page && ts.isExpression(node)) {
      const translated = this.translations.get(normalize(node.getText(source)));
      if (translated !== undefined) return translated;
    }
    if (ts.isIdentifier(node)) return this.identifier(node, scope, imports);
    if (ts.isShorthandPropertyAssignment(node)) {
      const symbol = this.checker.getShorthandAssignmentValueSymbol(node);
      const value = symbol ? this.reference(node.name, symbol, scope, imports) : this.identifier(node.name, scope, imports);
      return value === node.name.text ? node.name.text : `${node.name.text}: ${value}`;
    }
    if (ts.isFunctionLike(node) || ts.isClassLike(node) || ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      throw new Untranslatable(`${node.getText(source).slice(0, 60)} contains a function, class or JSX value`);
    }
    // Splice translated children back into the original text.
    const start = node.getStart(source);
    let result = "", cursor = start;
    const children: ts.Node[] = [];
    ts.forEachChild(node, child => { children.push(child); });
    for (const child of children) {
      if (this.skipChild(node, child)) continue;
      const childStart = child.getStart(source);
      result += source.text.slice(cursor, childStart) + this.expression(child, scope, imports);
      cursor = child.end;
    }
    return result + source.text.slice(cursor, node.end);
  }

  /** Names that are not value references: property names, type annotations and type arguments. */
  private skipChild(parent: ts.Node, child: ts.Node): boolean {
    if (ts.isPropertyAccessExpression(parent) && child === parent.name) return true;
    if (ts.isPropertyAssignment(parent) && child === parent.name && !ts.isComputedPropertyName(child)) return true;
    if (ts.isTypeNode(child)) return true;
    if ((ts.isMethodDeclaration(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent)) && child === parent.name) return true;
    return false;
  }

  private identifier(node: ts.Identifier, scope: Scope, imports: ImportRef[]): string {
    if (node.text === "undefined") return node.text;
    const symbol = this.checker.getSymbolAtLocation(node);
    if (!symbol) throw new Untranslatable(`${node.text} has no resolved declaration`);
    return this.reference(node, symbol, scope, imports);
  }

  private reference(node: ts.Identifier, symbol: ts.Symbol, scope: Scope, imports: ImportRef[]): string {
    const substitution = scope.args?.get(symbol);
    if (substitution !== undefined) { imports.push(...substitution.imports); return wrap(substitution.text); }
    const declaration = symbol.declarations?.[0];
    if (!declaration) throw new Untranslatable(`${node.text} has no declaration`);
    const file = resolve(declaration.getSourceFile().fileName);
    if (declaration.getSourceFile().isDeclarationFile && !this.importBinding(symbol)) return node.text;
    const binding = this.importBinding(symbol);
    if (binding) {
      if (binding.target.kind === "file" && !this.options.isMoved(binding.target.path)) {
        throw new Untranslatable(`${node.text} is imported from ${binding.target.path}, which stays in Next`);
      }
      imports.push(binding);
      return node.text;
    }
    if (file !== resolve(scope.source.fileName)) throw new Untranslatable(`${node.text} is declared outside ${scope.source.fileName}`);
    if (ts.isParameter(declaration) || (ts.isBindingElement(declaration) && this.parameterOf(declaration))) {
      throw new Untranslatable(`${node.text} is a ${scope.page ? "page" : "hook"} parameter without a configured translation`);
    }
    const variable = ts.isVariableDeclaration(declaration) ? declaration : ts.isBindingElement(declaration) ? this.variableOf(declaration) : undefined;
    if (!variable || !variable.initializer || !(variable.parent.flags & ts.NodeFlags.Const)) {
      throw new Untranslatable(`${node.text} is not a const value (${ts.SyntaxKind[declaration.kind]})`);
    }
    const local = scope.page && this.within(variable, scope.fn);
    if (!local) {
      if (!ts.isVariableDeclaration(declaration)) throw new Untranslatable(`${node.text}: module-level destructuring is unsupported`);
      return wrap(this.expression(variable.initializer, { ...scope, page: false, args: scope.args }, imports));
    }
    return this.pageBinding(node, symbol, declaration, variable, scope);
  }

  /** Page-body consts become loader statements (once each, dependencies first). */
  private pageBinding(node: ts.Identifier, symbol: ts.Symbol, declaration: ts.Declaration, variable: ts.VariableDeclaration, scope: Scope): string {
    const existing = this.emitted.get(symbol);
    if (existing !== undefined) return existing;
    const imports: ImportRef[] = [];
    let name: ts.BindingName = variable.name, value: string;
    if (ts.isArrayBindingPattern(variable.name)) {
      // const [{ id }, other] = await Promise.all([params, ...]) awaits each element separately.
      let top = declaration as ts.BindingElement;
      while (top.parent.parent !== variable) top = top.parent.parent as ts.BindingElement;
      const initializer = unwrap(variable.initializer!);
      const call = ts.isAwaitExpression(initializer) ? unwrap(initializer.expression) : undefined;
      const list = call && ts.isCallExpression(call) && call.expression.getText(scope.source) === "Promise.all" && call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
      const item = list && ts.isArrayLiteralExpression(list) ? list.elements[variable.name.elements.indexOf(top)] : undefined;
      if (!item || ts.isSpreadElement(item)) throw new Untranslatable(`${node.text}: only await Promise.all([...]) array destructuring is supported`);
      value = this.translations.get(normalize(`await ${item.getText(scope.source)}`)) ?? `await ${this.expression(item, scope, imports)}`;
      name = top.name;
    } else value = this.expression(variable.initializer!, scope, imports);
    if (ts.isIdentifier(name)) {
      this.statements.push({ text: dedent(`const ${node.text} = ${value};`, scope.source, variable), imports });
      this.emitted.set(symbol, node.text);
      return node.text;
    }
    return this.destructured(node, name, value, scope, symbol, imports);
  }

  /** `const { id } = value`, checking route parameters exist in the Start route. */
  private destructured(node: ts.Identifier, pattern: ts.BindingName, value: string, scope: Scope, symbol: ts.Symbol, imports: ImportRef[]): string {
    if (!ts.isObjectBindingPattern(pattern)) throw new Untranslatable(`${node.text}: nested destructuring is unsupported`);
    const element = pattern.elements.find(item => ts.isIdentifier(item.name) && item.name.text === node.text);
    if (!element || element.dotDotDotToken || element.initializer) throw new Untranslatable(`${node.text}: unsupported destructuring`);
    const property = element.propertyName ? element.propertyName.getText(scope.source) : node.text;
    if (value === this.options.paramsObject && !this.options.params.includes(property)) {
      throw new Untranslatable(`route parameter '${property}' is not a segment of the Start route`);
    }
    this.statements.push({ text: `const { ${element.getText(scope.source)} } = ${value};`, imports });
    this.emitted.set(symbol, node.text);
    return node.text;
  }

  private parameterOf(element: ts.BindingElement): ts.ParameterDeclaration | undefined {
    let current: ts.Node = element;
    while (ts.isBindingElement(current) || ts.isObjectBindingPattern(current) || ts.isArrayBindingPattern(current)) current = current.parent;
    return ts.isParameter(current) ? current : undefined;
  }

  private variableOf(element: ts.BindingElement): ts.VariableDeclaration | undefined {
    let current: ts.Node = element;
    while (ts.isBindingElement(current) || ts.isObjectBindingPattern(current) || ts.isArrayBindingPattern(current)) current = current.parent;
    return ts.isVariableDeclaration(current) ? current : undefined;
  }

  private within(node: ts.Node, container: ts.Node): boolean {
    for (let current: ts.Node | undefined = node; current; current = current.parent) if (current === container) return true;
    return false;
  }

  /** The import declaration binding a symbol, with its resolved target. */
  importBinding(symbol: ts.Symbol): ImportRef | undefined {
    const declaration = symbol.declarations?.[0];
    if (!declaration || !(ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration))) return undefined;
    let statement: ts.Node = declaration;
    while (!ts.isImportDeclaration(statement)) statement = statement.parent;
    const specifier = statement.moduleSpecifier as ts.StringLiteral;
    const source = statement.getSourceFile();
    const imported = ts.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : ts.isImportClause(declaration) ? "default" : "*";
    const local = ts.isImportSpecifier(declaration) ? declaration.name.text : ts.isImportClause(declaration) ? declaration.name!.text : declaration.name.text;
    const typeOnly = !!statement.importClause?.isTypeOnly || (ts.isImportSpecifier(declaration) && declaration.isTypeOnly);
    const resolved = this.ws.resolveModule(specifier, source);
    const path = resolved && resolve(resolved.resolvedFileName);
    const workspaceFile = path && !path.split(/[\\/]/).includes("node_modules") && !resolved!.isExternalLibraryImport;
    // Path aliases and relative specifiers name files; bare workspace package specifiers stay as written.
    const owner = this.ws.ownersOf(source.fileName)[0];
    const options = owner ? this.ws.participant(owner).parsed.options : this.ws.editOptions;
    const alias = Object.keys(options.paths ?? {}).some(pattern => {
      const [prefix, suffix] = pattern.split("*");
      return pattern.includes("*") ? specifier.text.startsWith(prefix!) && specifier.text.endsWith(suffix!) : pattern === specifier.text;
    });
    const fileTarget = workspaceFile && (specifier.text.startsWith(".") || alias);
    return { local, imported, typeOnly, target: fileTarget ? { kind: "file", path: path! } : { kind: "package", module: specifier.text } };
  }

  /** The single JSX element rendering a component imported from a moved module. */
  private viewElement(source: ts.SourceFile, component: ts.FunctionLikeDeclaration & { body: ts.Block }): { element: ts.JsxSelfClosingElement | ts.JsxOpeningElement; full: ts.JsxElement | ts.JsxSelfClosingElement; wrappers: string[] } {
    const returns: ts.ReturnStatement[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isReturnStatement(node) && node.expression) returns.push(node);
      if (!ts.isFunctionLike(node) || node === component) ts.forEachChild(node, visit);
    };
    visit(component.body);
    const candidates: { element: ts.JsxSelfClosingElement | ts.JsxOpeningElement; full: ts.JsxElement | ts.JsxSelfClosingElement; wrappers: string[] }[] = [];
    for (const statement of returns) {
      const walk = (node: ts.Node, wrappers: string[]) => {
        const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined;
        if (opening) {
          const symbol = ts.isIdentifier(opening.tagName) ? this.checker.getSymbolAtLocation(opening.tagName) : undefined;
          const binding = symbol && this.importBinding(symbol);
          if (binding?.target.kind === "file" && this.options.isMoved(binding.target.path)) {
            candidates.push({ element: opening, full: node as ts.JsxElement | ts.JsxSelfClosingElement, wrappers });
            return;
          }
          if (ts.isJsxElement(node)) for (const child of node.children) walk(child, [...wrappers, opening.tagName.getText(source)]);
          return;
        }
        if (ts.isJsxFragment(node)) { for (const child of node.children) walk(child, [...wrappers, "<>"]); return; }
        ts.forEachChild(node, child => walk(child, wrappers));
      };
      walk(statement.expression!, []);
    }
    if (candidates.length !== 1) {
      fail("PORT_ROUTE_VIEW_NOT_FOUND", `${source.fileName} must render exactly one component imported from a moved module (found ${candidates.length}); move the view into the route directory or split the page`);
    }
    const found = candidates[0]!;
    if (ts.isJsxElement(found.full) && found.full.children.some(child => !ts.isJsxText(child) || child.getText(source).trim())) {
      fail("PORT_ROUTE_UNSUPPORTED_PAGE", `${found.element.tagName.getText(source)} receives children; pass them as props before porting`);
    }
    return found;
  }

  private view(found: ReturnType<RouteExtractor["viewElement"]>, preloads: Preload[], scope: Scope): RouteModel["view"] {
    const { element } = found;
    const source = scope.source;
    const symbol = this.checker.getSymbolAtLocation(element.tagName)!;
    const binding = this.importBinding(symbol)!;
    const target = this.checker.getAliasedSymbol(symbol);
    const declaration = target.valueDeclaration ?? target.declarations?.[0];
    const component = declaration && (ts.isFunctionDeclaration(declaration) ? declaration
      : ts.isVariableDeclaration(declaration) && declaration.initializer && (ts.isArrowFunction(unwrap(declaration.initializer)) || ts.isFunctionExpression(unwrap(declaration.initializer)))
        ? unwrap(declaration.initializer) as ts.ArrowFunction | ts.FunctionExpression : undefined);
    if (!component || binding.target.kind !== "file" || resolve(component.getSourceFile().fileName) !== binding.target.path) {
      fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${element.tagName.getText(source)} must be a function component declared in its module (re-exports and wrappers such as memo/forwardRef are unsupported)`);
    }
    const attributes: ViewAttribute[] = [];
    for (const attribute of element.attributes.properties) {
      if (!ts.isJsxAttribute(attribute)) fail("PORT_ROUTE_UNSUPPORTED_PAGE", `spread attributes on ${element.tagName.getText(source)} are unsupported`);
      const name = attribute.name.getText(source);
      const initializer = attribute.initializer;
      const expression = !initializer ? undefined : ts.isJsxExpression(initializer) ? initializer.expression : initializer;
      const preload = expression && ts.isIdentifier(unwrap(expression)) ? preloads.find(item => item.variable === (unwrap(expression) as ts.Identifier).text) : undefined;
      if (preload) { attributes.push({ name, kind: "preloaded", preload }); continue; }
      const sourceText = !initializer ? "true" : ts.isStringLiteral(initializer) ? initializer.getText(source) : expression?.getText(source) ?? "undefined";
      const start = !expression || ts.isStringLiteral(expression) ? { text: sourceText, imports: [] } : this.attempt(() => this.translate(expression, scope));
      attributes.push({ name, kind: "value", source: sourceText, start });
    }
    const unused = preloads.filter(item => !attributes.some(attribute => attribute.preload === item));
    for (const item of unused) this.notes.push(`TODO(port-route): ${item.variable} is preloaded but not passed to ${element.tagName.getText(source)}; the Start loader prefetches it without a consumer.`);
    const parameter = component.parameters[0];
    const props = parameter ? this.checker.getPropertiesOfType(this.checker.getTypeAtLocation(parameter)).map(property => ({
      name: property.name, optional: (property.flags & ts.SymbolFlags.Optional) !== 0,
    })).sort((a, b) => a.name < b.name ? -1 : 1) : [];
    for (const wrapper of found.wrappers) this.notes.push(`TODO(port-route): the page wraps ${element.tagName.getText(source)} in <${wrapper}>; the generated adapter and Start route render the view without it.`);
    return { tag: element.tagName.getText(source), exported: binding.imported, path: binding.target.path, component, attributes, props, wrappers: found.wrappers };
  }
}
