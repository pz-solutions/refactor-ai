import ts from "typescript";
import { dirname, extname, relative, resolve } from "node:path";
import { eolOf, fail, isInside } from "./typescript-vfs";
import { Workspace, applyTextChanges, moduleSpecifiers } from "./typescript-workspace";
import { portablePath } from "./typescript-paths";

interface Package {
  path: string;
  directory: string;
  name: string;
  json: Record<string, unknown>;
}

export function packageFor(ws: Workspace, file: string): Package | undefined {
  for (let directory = dirname(file); isInside(ws.root, directory); directory = dirname(directory)) {
    const path = resolve(directory, "package.json");
    const text = ws.vfs.readFile(path);
    if (text !== undefined) {
      let json: Record<string, unknown>;
      try { json = JSON.parse(text); } catch { fail("INVALID_PACKAGE", path); }
      if (typeof json.name === "string" && json.name) return { path, directory, name: json.name, json };
    }
    if (ws.vfs.samePath(directory, ws.root)) break;
  }
  return undefined;
}

/** A bare self-import can become relative only when its resolved target belongs to the same package. */
export function packageSelfImport(ws: Workspace, importer: string, target: string, specifier: string): boolean {
  const pkg = packageFor(ws, importer);
  return !!pkg && (specifier === pkg.name || specifier.startsWith(`${pkg.name}/`))
    && packageFor(ws, target)?.path === pkg.path;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

/** Invert exact exports and single-star targets; the compiler verifies condition/precedence semantics afterwards. */
function exportedPaths(pkg: Package, target: string): string[] {
  const exports = pkg.json.exports;
  const entries = exports && typeof exports === "object" && !Array.isArray(exports)
    && Object.keys(exports).some(key => key.startsWith("."))
    ? Object.entries(exports) : [[".", exports] as const];
  const candidates: string[] = [];
  const path = `./${portablePath(relative(pkg.directory, target))}`;
  for (const [key, value] of entries) {
    if (key !== "." && !key.startsWith("./")) continue;
    for (const pattern of strings(value)) {
      if (!pattern.startsWith("./")) continue;
      if (!pattern.includes("*") && pattern === path && !key.includes("*")) candidates.push(key);
      else if (pattern.split("*").length === 2 && key.split("*").length === 2) {
        const [prefix, suffix] = pattern.split("*") as [string, string];
        if (path.startsWith(prefix) && path.endsWith(suffix) && path.length >= prefix.length + suffix.length) {
          candidates.push(key.replace("*", path.slice(prefix.length, path.length - suffix.length)));
        }
      }
    }
  }
  return [...new Set(candidates)].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/** Append without reprinting the manifest, preserving existing whitespace, ordering and trailing commas. */
function addExport(ws: Workspace, pkg: Package, target: string): string {
  const text = ws.vfs.readFile(pkg.path)!;
  const json = ts.parseJsonText(pkg.path, text);
  const object = json.statements[0]?.expression;
  if (!object || !ts.isObjectLiteralExpression(object)) fail("INVALID_PACKAGE", pkg.path);
  const property = object.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item)
    && ts.isStringLiteral(item.name) && item.name.text === "exports");
  if (!property) fail("PACKAGE_EXPORTS_REQUIRED", `${pkg.path} has no exports field; declare the package's public surface before moving files into it`);
  if (!ts.isObjectLiteralExpression(property.initializer)
    || property.initializer.properties.some(item => !ts.isPropertyAssignment(item) || !ts.isStringLiteral(item.name) || !item.name.text.startsWith("."))) {
    fail("PACKAGE_EXPORTS_UNSUPPORTED", `${pkg.path}: automatic exports require an object of subpath entries`);
  }
  const path = portablePath(relative(pkg.directory, target));
  if (path.startsWith("../")) fail("PACKAGE_EXPORTS_UNSUPPORTED", target);
  // A directory's index module is published as the directory (`./feature`, or `.` for src/index).
  const subpath = path.replace(/^src\//, "").slice(0, -extname(path).length).replace(/(^|\/)index$/, "");
  const key = subpath ? `./${subpath}` : ".";
  const entries = property.initializer.properties;
  if (entries.some(item => ts.isPropertyAssignment(item) && ts.isStringLiteral(item.name) && item.name.text === key)) {
    fail("PACKAGE_EXPORT_CONFLICT", `${pkg.path}: ${key} already names another target`);
  }
  const literal = `${JSON.stringify(key)}: ${JSON.stringify(`./${path}`)}`;
  const last = entries[entries.length - 1];
  const multiline = text.slice(property.initializer.getStart(json), property.initializer.end).includes("\n");
  const indentAt = (position: number) => text.slice(text.lastIndexOf("\n", position) + 1, position).match(/^[\t ]*/)?.[0] ?? "";
  const indent = last ? indentAt(last.getStart(json)) : indentAt(property.getStart(json)) + (text.match(/\n([\t ]+)"/)?.[1] ?? "  ");
  const start = last?.end ?? property.initializer.getStart(json) + 1;
  const tail = text.slice(start, property.initializer.end - 1);
  const comma = tail.indexOf(",");
  const changes: ts.TextChange[] = [];
  if (last && comma >= 0) {
    changes.push({ span: { start: start + comma + 1, length: 0 }, newText: `${multiline ? eolOf(text) + indent : " "}${literal},` });
  } else {
    changes.push({ span: { start, length: 0 }, newText: `${last ? "," : ""}${multiline ? eolOf(text) + indent : last ? " " : ""}${literal}` });
  }
  ws.vfs.write(pkg.path, applyTextChanges(text, changes));
  return key;
}

export function packageSpecifier(ws: Workspace, importer: string, target: string, mode?: ts.ResolutionMode): string | undefined {
  const destination = packageFor(ws, target);
  const source = packageFor(ws, importer);
  if (!destination || (source && ws.vfs.samePath(source.path, destination.path))) return undefined;
  if (!source) fail("MISSING_DEPENDENCY", `${importer} has no named package declaring ${destination.name}`);
  const declares = ["dependencies", "devDependencies", "peerDependencies"].some(field => {
    const value = source.json[field];
    return value && typeof value === "object" && Object.hasOwn(value, destination.name);
  });
  if (!declares) fail("MISSING_DEPENDENCY", `${source.path} must declare ${destination.name} in dependencies, devDependencies or peerDependencies`);
  const paths = exportedPaths(destination, target);
  const nameFor = (key: string) => destination.name + (key === "." ? "" : key.slice(1));
  const owner = ws.ownersOf(importer)[0];
  const options = owner ? ws.participant(owner).parsed.options : ws.editOptions;
  const key = paths.find(key => {
    const resolved = ts.resolveModuleName(nameFor(key), importer, options, ws.vfs.moduleResolutionHost(), undefined, undefined, mode).resolvedModule;
    return resolved && ws.vfs.samePath(resolved.resolvedFileName, target);
  }) ?? paths[0] ?? addExport(ws, destination, target);
  return nameFor(key);
}

/** Relative extension style of the receiving package, falling back to the import being retargeted. */
export function relativeStyle(ws: Workspace, target: string, fallback: string, cache = new Map<string, string | null>()): string {
  const pkg = packageFor(ws, target);
  if (!pkg) return fallback.startsWith(".") ? fallback : "./module";
  const fallbackStyle = fallback.startsWith(".") ? fallback : "./module";
  if (cache.has(pkg.path)) return cache.get(pkg.path) ?? fallbackStyle;
  let explicit = 0, implicit = 0;
  let sample = "./module";
  for (const file of ws.unionFiles()) {
    if (!isInside(pkg.directory, file) || packageFor(ws, file)?.path !== pkg.path) continue;
    const text = ws.vfs.readFile(file);
    if (text === undefined) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const specifier of moduleSpecifiers(source)) {
      if (!/^\.\.?\//.test(specifier.text)) continue;
      if (/\.[cm]?[jt]sx?$/.test(specifier.text)) { explicit += 1; sample = specifier.text; }
      else implicit += 1;
    }
  }
  const style = !explicit && !implicit ? null : explicit > implicit ? sample : "./module";
  cache.set(pkg.path, style);
  return style ?? fallbackStyle;
}
