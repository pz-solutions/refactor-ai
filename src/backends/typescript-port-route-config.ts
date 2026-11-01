import ts from "typescript";
import { dirname, isAbsolute, resolve } from "node:path";
import { fail, isInside } from "./typescript-vfs";

/**
 * Project-owned port-route configuration (<root>/.refactor-ai/port-route.json).
 * Framework knowledge stays in the engine (Next App Router directories, TanStack
 * flat route files); every project API — ports, query helpers, import paths and
 * file shapes — comes from this file and its templates.
 */
export interface Snippet {
  /** Import declarations required by setup/value, e.g. `import { x } from "y";`. */
  imports?: string[];
  /** Statements placed before the value is used (component body or loader). */
  setup?: string[];
  value: string;
}

export interface PortRouteConfig {
  next: {
    /** Directory whose children are URL segments, e.g. apps/web/src/app/[locale]. */
    appDirectory: string;
    /** Files and globs (relative to the route directory) that stay in Next. */
    exclude: string[];
    /** Files importing these modules stay in Next. */
    serverOnlyModules: string[];
    /** Calls whose first argument is a Convex function reference and second its arguments. */
    preloadFunctions: string[];
    /** Adapter file name next to page.tsx; {{view}} is the view module's base name, {{route}} the final segment (view stem for dynamic routes). */
    adapterFile: string;
    /** Imports every generated adapter needs. */
    imports: string[];
  };
  start: {
    project: string;
    routes: string;
    routeTree?: { generator: string; configDirectory: string; file: string };
    /** Loader parameter names, included when the generated loader body uses them. */
    loaderArgs: string[];
    /** Loader parameter holding route params. */
    paramsObject: string;
    /** Imports every generated Start route needs. */
    imports: string[];
  };
  /** move-file module maps applied to the moved files (CLI --map entries win). */
  map: Record<string, string>;
  /** Page expressions (whitespace-insensitive source text) and their Start loader equivalents. */
  translate: Record<string, string>;
  /** View contract: each preloaded prop becomes a data prop. */
  data: {
    hook: { module: string; name: string };
    /** Data prop name; {{Name}} is the preloaded prop without its `preloaded` prefix. */
    prop: string;
    /** Fallback type when the view's hook call has no type argument ({{query}}). */
    type: Snippet;
    /** Type when the hook call has a type argument ({{type}}); default {{type}}. */
    typeArgument: string;
  };
  /** View props filled by app-specific hooks, by prop name. */
  ports: Record<string, { next: Snippet; start: Snippet }>;
  /** View props named like a dynamic route segment ({{name}}). */
  params?: { next: Snippet; start: Snippet };
  snippets: {
    nextHookType: Snippet;
    nextDirectType: Snippet;
    nextData: Snippet;
    startQuery: Snippet;
    startPrefetch: string;
    startData: Snippet;
    startLoader: Snippet;
    /** Loader used when the route has dynamic segments. */
    startRecordLoader?: Snippet;
    startSearchDeps?: string;
    /** Typechecking placeholder for untranslatable values ({{message}} is a string literal). */
    todo: string;
  };
  templates: { nextAdapter: string; startRoute: string };
  /** Commands to run after apply (generated registries, route trees); reported as plan notes, never run. */
  afterApply: string[];
  /** argv command reading source on stdin and writing formatted source to stdout; {{file}} is the intended absolute path. */
  formatCommand?: string[];
}

const defaults = {
  exclude: ["page.tsx", "page.ts", "layout.tsx", "loading.tsx", "error.tsx", "not-found.tsx", "template.tsx", "default.tsx", "route.ts", "**/_hooks/**", "*adapter*"],
  serverOnlyModules: ["server-only"],
  adapterFile: "{{view}}-adapter.tsx",
  loaderArgs: ["context", "location", "params"],
  todo: "(() => { throw new Error({{message}}); })()",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function invalid(path: string, field: string): never {
  fail("INVALID_PORT_ROUTE_CONFIG", `${path}: ${field}`);
}

function strings(path: string, field: string, value: unknown, fallback?: string[]): string[] {
  if (value === undefined && fallback) return fallback;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item)) invalid(path, `${field} must be an array of non-empty strings`);
  return value as string[];
}

function text(path: string, field: string, value: unknown, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !value) invalid(path, `${field} must be a non-empty string`);
  return value;
}

function stringMap(path: string, field: string, value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.entries(value).some(([key, item]) => !key || typeof item !== "string" || !item)) invalid(path, `${field} must map strings to strings`);
  return Object.fromEntries(Object.entries(value as Record<string, string>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function snippet(path: string, field: string, value: unknown): Snippet {
  if (typeof value === "string") return { value };
  if (!isRecord(value)) invalid(path, `${field} must be a string or { imports?, setup?, value }`);
  return {
    ...(value.imports !== undefined ? { imports: strings(path, `${field}.imports`, value.imports) } : {}),
    ...(value.setup !== undefined ? { setup: strings(path, `${field}.setup`, value.setup) } : {}),
    value: text(path, `${field}.value`, value.value),
  };
}

function pair(path: string, field: string, value: unknown): { next: Snippet; start: Snippet } {
  if (!isRecord(value)) invalid(path, `${field} must be { next, start }`);
  return { next: snippet(path, `${field}.next`, value.next), start: snippet(path, `${field}.start`, value.start) };
}

/** Root-relative project paths only; the plan root bounds every input and output. */
function projectPath(root: string, path: string, field: string, value: string): string {
  if (isAbsolute(value) || value.split(/[\\/]/).includes("..")) invalid(path, `${field} must be relative to the root without '..'`);
  const absolute = resolve(root, value);
  if (!isInside(root, absolute)) invalid(path, `${field} is outside ${root}`);
  return absolute;
}

export interface LoadedConfig extends PortRouteConfig {
  path: string;
  /** Template texts, read through the tracked compiler inputs. */
  nextAdapterTemplate: string;
  startRouteTemplate: string;
}

export function loadPortRouteConfig(root: string, path: string, sys: ts.System): LoadedConfig {
  const source = sys.readFile(path);
  if (source === undefined) fail("PORT_ROUTE_CONFIG_NOT_FOUND", path);
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { invalid(path, "not valid JSON"); }
  if (!isRecord(raw) || !isRecord(raw.next) || !isRecord(raw.start) || !isRecord(raw.data) || !isRecord(raw.snippets) || !isRecord(raw.templates)) {
    invalid(path, "next, start, data, snippets and templates objects are required");
  }
  const next = raw.next, start = raw.start, data = raw.data, snippets = raw.snippets, templates = raw.templates;
  if (!isRecord(data.hook)) invalid(path, "data.hook must be { module, name }");
  const routeTree = start.routeTree;
  if (routeTree !== undefined && !isRecord(routeTree)) invalid(path, "start.routeTree must be an object");
  const ports = raw.ports === undefined ? {} : raw.ports;
  if (!isRecord(ports)) invalid(path, "ports must be an object");
  const config: PortRouteConfig = {
    next: {
      appDirectory: projectPath(root, path, "next.appDirectory", text(path, "next.appDirectory", next.appDirectory)),
      exclude: strings(path, "next.exclude", next.exclude, defaults.exclude),
      serverOnlyModules: strings(path, "next.serverOnlyModules", next.serverOnlyModules, defaults.serverOnlyModules),
      preloadFunctions: strings(path, "next.preloadFunctions", next.preloadFunctions),
      adapterFile: text(path, "next.adapterFile", next.adapterFile, defaults.adapterFile),
      imports: strings(path, "next.imports", next.imports, []),
    },
    start: {
      project: projectPath(root, path, "start.project", text(path, "start.project", start.project)),
      routes: projectPath(root, path, "start.routes", text(path, "start.routes", start.routes)),
      ...(routeTree ? { routeTree: {
        generator: text(path, "start.routeTree.generator", routeTree.generator),
        configDirectory: projectPath(root, path, "start.routeTree.configDirectory", text(path, "start.routeTree.configDirectory", routeTree.configDirectory)),
        file: projectPath(root, path, "start.routeTree.file", text(path, "start.routeTree.file", routeTree.file)),
      } } : {}),
      loaderArgs: strings(path, "start.loaderArgs", start.loaderArgs, defaults.loaderArgs),
      paramsObject: text(path, "start.paramsObject", start.paramsObject, "params"),
      imports: strings(path, "start.imports", start.imports, []),
    },
    map: stringMap(path, "map", raw.map),
    translate: stringMap(path, "translate", raw.translate),
    data: {
      hook: { module: text(path, "data.hook.module", data.hook.module), name: text(path, "data.hook.name", data.hook.name) },
      prop: text(path, "data.prop", data.prop),
      type: snippet(path, "data.type", data.type),
      typeArgument: text(path, "data.typeArgument", data.typeArgument, "{{type}}"),
    },
    ports: Object.fromEntries(Object.entries(ports).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, value]) => [name, pair(path, `ports.${name}`, value)])),
    ...(raw.params !== undefined ? { params: pair(path, "params", raw.params) } : {}),
    snippets: {
      nextHookType: snippet(path, "snippets.nextHookType", snippets.nextHookType),
      nextDirectType: snippet(path, "snippets.nextDirectType", snippets.nextDirectType),
      nextData: snippet(path, "snippets.nextData", snippets.nextData),
      startQuery: snippet(path, "snippets.startQuery", snippets.startQuery),
      startPrefetch: text(path, "snippets.startPrefetch", snippets.startPrefetch),
      startData: snippet(path, "snippets.startData", snippets.startData),
      startLoader: snippet(path, "snippets.startLoader", snippets.startLoader),
      ...(snippets.startRecordLoader !== undefined ? { startRecordLoader: snippet(path, "snippets.startRecordLoader", snippets.startRecordLoader) } : {}),
      ...(snippets.startSearchDeps !== undefined ? { startSearchDeps: text(path, "snippets.startSearchDeps", snippets.startSearchDeps) } : {}),
      todo: text(path, "snippets.todo", snippets.todo, defaults.todo),
    },
    templates: { nextAdapter: text(path, "templates.nextAdapter", templates.nextAdapter), startRoute: text(path, "templates.startRoute", templates.startRoute) },
    afterApply: strings(path, "afterApply", raw.afterApply, []),
    ...(raw.formatCommand !== undefined ? { formatCommand: strings(path, "formatCommand", raw.formatCommand) } : {}),
  };
  if (config.formatCommand && !config.formatCommand.length) invalid(path, "formatCommand must be nonempty");
  for (const [key] of Object.entries(config.ports)) if (!/^[A-Za-z_$][\w$]*$/.test(key)) invalid(path, `ports.${key} must name a prop`);
  const template = (field: string, value: string) => {
    const file = resolve(dirname(path), value);
    if (!isInside(root, file)) invalid(path, `${field} is outside ${root}`);
    const content = sys.readFile(file);
    if (content === undefined) fail("PORT_ROUTE_TEMPLATE_NOT_FOUND", `${file} (${field})`);
    return content;
  };
  return { ...config, path, nextAdapterTemplate: template("templates.nextAdapter", config.templates.nextAdapter), startRouteTemplate: template("templates.startRoute", config.templates.startRoute) };
}

/**
 * Replace {{name}} placeholders. A placeholder alone on its line keeps that
 * line's indentation for every line of a multi-line value; an empty value
 * removes the whole line. Inline values continue at the line's indentation. Unknown placeholders are configuration errors.
 */
export function render(template: string, values: Record<string, string>, origin: string): string {
  const lines = template.split("\n").flatMap(line => {
    const alone = /^([ \t]*)\{\{(\w+)\}\}[ \t]*(,?)$/.exec(line);
    if (alone) {
      const value = lookup(alone[2]!);
      if (!value) return [];
      const [first, ...rest] = value.split("\n");
      return [alone[1] + first, ...rest.map(item => item ? alone[1] + item : item)].map((item, index, all) => index === all.length - 1 ? item + alone[3] : item);
    }
    // Inline multi-line values continue at the line's indentation.
    const indent = /^[ \t]*/.exec(line)![0];
    return [line.replace(/\{\{(\w+)\}\}/g, (_, key: string) => lookup(key).replace(/\n(?=.)/g, `\n${indent}`))];
  });
  return lines.join("\n");
  function lookup(key: string): string {
    if (!Object.hasOwn(values, key)) fail("INVALID_PORT_ROUTE_TEMPLATE", `${origin} uses unknown placeholder {{${key}}}; available: ${Object.keys(values).sort().join(", ")}`);
    return values[key]!;
  }
}

interface ImportEntry {
  module: string;
  typeOnly: boolean;
  defaultName?: string;
  namespace?: string;
  named: Map<string, { name: string; alias?: string; typeOnly: boolean }>;
  sideEffect: boolean;
}

/** Structured, mergeable import declarations for generated modules. */
export class ImportSet {
  private readonly entries = new Map<string, ImportEntry>();

  /** Parse configured import declarations; anything else is a configuration error. */
  addText(declarations: string[] | undefined, origin: string): void {
    for (const declaration of declarations ?? []) {
      const source = ts.createSourceFile("import.ts", declaration, ts.ScriptTarget.Latest, true);
      if (!source.statements.length || source.statements.some(statement => !ts.isImportDeclaration(statement))) {
        fail("INVALID_PORT_ROUTE_CONFIG", `${origin}: '${declaration}' must contain import declarations only`);
      }
      for (const statement of source.statements as ts.NodeArray<ts.ImportDeclaration>) this.addDeclaration(statement);
    }
  }

  addDeclaration(statement: ts.ImportDeclaration): void {
    const module = (statement.moduleSpecifier as ts.StringLiteral).text;
    const clause = statement.importClause;
    if (!clause) { this.entry(module).sideEffect = true; return; }
    if (clause.name) this.addDefault(module, clause.name.text, clause.isTypeOnly);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) this.addNamespace(module, bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
      this.addNamed(module, (element.propertyName ?? element.name).text, element.name.text, clause.isTypeOnly || element.isTypeOnly);
    }
  }

  addNamed(module: string, name: string, local = name, typeOnly = false): void {
    const entry = this.entry(module);
    const existing = entry.named.get(local);
    if (existing && existing.name !== name) fail("PORT_ROUTE_IMPORT_CONFLICT", `${local} is imported as both ${existing.name} and ${name} from ${module}`);
    this.assertLocal(local, module);
    entry.named.set(local, { name, ...(local !== name ? { alias: local } : {}), typeOnly: existing ? existing.typeOnly && typeOnly : typeOnly });
  }

  addDefault(module: string, local: string, typeOnly = false): void {
    const entry = this.entry(module);
    if (entry.defaultName && entry.defaultName !== local) fail("PORT_ROUTE_IMPORT_CONFLICT", `default import of ${module} named ${entry.defaultName} and ${local}`);
    this.assertLocal(local, module);
    entry.defaultName = local;
    entry.typeOnly = entry.typeOnly && typeOnly;
  }

  addNamespace(module: string, local: string): void {
    const entry = this.entry(module);
    this.assertLocal(local, module);
    entry.namespace = local;
  }

  /** Local names this module binds. */
  locals(): Set<string> {
    const names = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.defaultName) names.add(entry.defaultName);
      if (entry.namespace) names.add(entry.namespace);
      for (const local of entry.named.keys()) names.add(local);
    }
    return names;
  }

  private assertLocal(local: string, module: string): void {
    for (const [other, entry] of this.entries) {
      if (other === module) continue;
      if (entry.defaultName === local || entry.namespace === local || entry.named.has(local)) {
        fail("PORT_ROUTE_IMPORT_CONFLICT", `${local} would be imported from both ${other} and ${module}; rename one of the configured imports`);
      }
    }
  }

  private entry(module: string): ImportEntry {
    let entry = this.entries.get(module);
    if (!entry) { entry = { module, typeOnly: true, named: new Map(), sideEffect: false }; this.entries.set(module, entry); }
    return entry;
  }

  /** Deterministic output: modules sorted by specifier, names by imported name. */
  print(quote = '"'): string {
    const literal = (module: string) => `${quote}${module.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`)}${quote}`;
    const lines: string[] = [];
    for (const entry of [...this.entries.values()].sort((a, b) => a.module < b.module ? -1 : a.module > b.module ? 1 : 0)) {
      const key = (item: { name: string; alias?: string }) => [item.name.toLowerCase(), item.name, item.alias ?? ""].join("\0");
      const named = [...entry.named.values()].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
      const allTypes = !entry.defaultName && !entry.namespace && named.length > 0 && named.every(item => item.typeOnly);
      const specifier = (item: { name: string; alias?: string; typeOnly: boolean }) => `${item.typeOnly && !allTypes ? "type " : ""}${item.name}${item.alias ? ` as ${item.alias}` : ""}`;
      if (entry.namespace) lines.push(`import ${entry.defaultName ? `${entry.defaultName}, ` : ""}* as ${entry.namespace} from ${literal(entry.module)};`);
      const head = entry.namespace ? undefined : entry.defaultName;
      if (head || named.length) {
        const parts = [head, named.length ? `{ ${named.map(specifier).join(", ")} }` : undefined].filter(Boolean).join(", ");
        lines.push(`import ${allTypes ? "type " : ""}${parts} from ${literal(entry.module)};`);
      }
      if (entry.sideEffect && !head && !named.length && !entry.namespace) lines.push(`import ${literal(entry.module)};`);
    }
    return lines.join("\n");
  }
}

/** Template value for a snippet with {{key}} placeholders (inline values only). */
export function fill(value: string, values: Record<string, string>, origin: string): string {
  return value.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key)) fail("INVALID_PORT_ROUTE_TEMPLATE", `${origin} uses unknown placeholder {{${key}}}; available: ${Object.keys(values).sort().join(", ")}`);
    return values[key]!;
  });
}
