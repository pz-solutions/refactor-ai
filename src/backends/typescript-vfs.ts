import ts from "typescript";
import { CompilerInputs } from "./typescript-diagnostics-cache";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { FileChange } from "../types";
import { isInside, portablePath } from "./typescript-paths";
export { isInside } from "./typescript-paths";

/**
 * Read-only view of the disk with in-memory overlays. Planning never writes:
 * created, edited and deleted files and in-memory declaration outputs live here,
 * and every TypeScript host callback (module resolution, config globbing,
 * directory listing) observes the overlay state.
 */

interface Overlay {
  path: string;
  text: string | null;
  bom: boolean;
}

interface Entries {
  files: string[];
  directories: string[];
}

const BOM = "﻿";

export function fail(code: string, reason: string): never {
  throw new Error(`${code}: ${reason}`);
}

function swapCase(value: string): string {
  return [...value].map((char) => char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()).join("");
}

function detectCaseSensitivity(root: string): boolean {
  const probe = [root, ...readdirSync(root).map((name) => resolve(root, name))]
    .find((path) => swapCase(basename(path)) !== basename(path));
  if (!probe) return ts.sys.useCaseSensitiveFileNames;
  const swapped = resolve(dirname(probe), swapCase(basename(probe)));
  if (!existsSync(swapped)) return true;
  const a = statSync(probe), b = statSync(swapped);
  return !(a.ino === b.ino && a.dev === b.dev);
}

export function eolOf(text: string): string {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

export function withEol(text: string, eol: string): string {
  return text.replace(/\r?\n/g, eol);
}

// Port of TypeScript's documented tsconfig wildcard semantics (include/exclude).
// The workspace cross-checks results against ts.sys before relying on them.
const packageFolders = "(?!(node_modules|bower_components|jspm_packages)(/|$))";
const matchers = {
  files: { single: "([^./]|(\\.(?!min\\.js$))?)*", double: `(/${packageFolders}[^/.][^/]*)*?` },
  directories: { single: "[^/]*", double: `(/${packageFolders}[^/.][^/]*)*?` },
  exclude: { single: "[^/]*", double: "(/.+?)?" },
};
type Usage = keyof typeof matchers;

function specComponents(spec: string, basePath: string): string[] {
  const normalized = portablePath(resolve(basePath, spec));
  const parts = normalized.split("/").filter((component, index) => index === 0 || component !== "");
  if (normalized.startsWith("//")) parts[0] = "/"; // Keep the UNC root's double slash.
  return parts;
}

function subPattern(spec: string, basePath: string, usage: Usage): string | undefined {
  const { single, double } = matchers[usage];
  const components = specComponents(spec, basePath);
  const last = components[components.length - 1]!;
  if (usage !== "exclude" && last === "**") return undefined;
  if (!/[.*?]/.test(last)) components.push("**", "*");
  const replace = (match: string) => match === "*" ? single : match === "?" ? "[^/]" : `\\${match}`;
  let pattern = "";
  let written = false;
  let optional = 0;
  for (let component of components) {
    if (component === "**") {
      pattern += double;
    } else {
      if (usage === "directories") { pattern += "("; optional += 1; }
      if (written) pattern += "/";
      if (usage !== "exclude") {
        let componentPattern = "";
        if (component.startsWith("*")) {
          componentPattern += `([^./]${single})?`;
          component = component.slice(1);
        } else if (component.startsWith("?")) {
          componentPattern += "[^./]";
          component = component.slice(1);
        }
        componentPattern += component.replace(/[^\w\s/]/g, replace);
        if (componentPattern !== component) pattern += packageFolders;
        pattern += componentPattern;
      } else {
        pattern += component.replace(/[^\w\s/]/g, replace);
      }
    }
    written = true;
  }
  while (optional-- > 0) pattern += ")?";
  return pattern;
}

function wildcardRegex(specs: readonly string[] | undefined, basePath: string, usage: Usage, flags: string): RegExp | undefined {
  const patterns = (specs ?? []).map((spec) => subPattern(spec, basePath, usage)).filter((item): item is string => !!item);
  if (!patterns.length) return undefined;
  return new RegExp(`^(?:${patterns.map((item) => `(?:${item})`).join("|")})${usage === "exclude" ? "(?:$|/)" : "$"}`, flags);
}

function includeBasePath(absolute: string): string {
  const wildcard = absolute.search(/[*?]/);
  if (wildcard < 0) return basename(absolute).includes(".") ? dirname(absolute) : absolute;
  const normalized = portablePath(absolute);
  const end = normalized.lastIndexOf("/", wildcard);
  return end === 2 && /^[A-Za-z]:/.test(normalized) ? normalized.slice(0, 3) : normalized.slice(0, end) || "/";
}

export class VirtualFs {
  readonly inputs = new CompilerInputs();
  readonly caseSensitive: boolean;
  private readonly readPaths = new Map<string, string>();
  private readonly disk = new Map<string, string | undefined>();
  private readonly overlays = new Map<string, Overlay>();
  private readonly generated = new Map<string, { path: string; text: string }>();
  private readonly versions = new Map<string, number>();
  private hiddenDirectories: string[] = [];
  private suspended = false;
  version = 0;

  constructor(readonly root: string) {
    this.caseSensitive = detectCaseSensitivity(root);
  }

  key(path: string): string {
    const normalized = resolve(path);
    return this.caseSensitive ? normalized : normalized.toLowerCase();
  }

  samePath(a: string, b: string): boolean {
    return this.key(a) === this.key(b);
  }

  contains(directory: string, path: string): boolean {
    return isInside(this.key(directory), this.key(path));
  }

  setHiddenDirectories(directories: string[]): void {
    this.hiddenDirectories = directories.map((directory) => resolve(directory));
  }

  isHidden(path: string): boolean {
    return this.hiddenDirectories.some((directory) => this.contains(directory, path));
  }

  /** Evaluate a callback against the unmodified disk (generated outputs remain visible). */
  original<T>(callback: () => T): T {
    const previous = this.suspended;
    this.suspended = true;
    this.version += 1;
    try { return callback(); }
    finally { this.suspended = previous; this.version += 1; }
  }

  /** Workspace package symlinks must observe canonical overlays, including newly exported files. */
  private readPath(path: string): string {
    path = resolve(path);
    if (!path.split(sep).includes("node_modules")) return path;
    const cached = this.readPaths.get(path);
    if (cached) return cached;
    let ancestor = path;
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    let canonical = path;
    try {
      const real = resolve(realpathSync(ancestor), relative(ancestor, path));
      if (isInside(this.root, real) && !real.split(sep).includes("node_modules")) canonical = real;
    } catch { /* unresolved dependency stays on disk */ }
    this.readPaths.set(path, canonical);
    return canonical;
  }

  private rawDisk(path: string): string | undefined {
    const key = this.key(path);
    if (!this.disk.has(key)) {
      if (this.inputs.enabled) { this.inputs.sys.fileExists(path); this.inputs.sys.readFile(path); }
      let text: string | undefined;
      try {
        if (statSync(path).isFile()) text = readFileSync(path, "utf8");
      } catch { text = undefined; }
      this.disk.set(key, text);
    }
    return this.disk.get(key);
  }

  /** On-disk content including any BOM, or null when the file does not exist on disk. */
  diskText(path: string): string | null {
    if (this.isHidden(path)) return null;
    return this.rawDisk(path) ?? null;
  }

  hasBom(path: string): boolean {
    path = this.readPath(path);
    const overlay = this.suspended ? undefined : this.overlays.get(this.key(path));
    if (overlay) return overlay.bom;
    return this.diskText(path)?.startsWith(BOM) ?? false;
  }

  readFile(path: string): string | undefined {
    path = this.readPath(path);
    const key = this.key(path);
    const generated = this.generated.get(key);
    if (generated) return generated.text;
    if (this.isHidden(path)) return undefined;
    const overlay = this.suspended ? undefined : this.overlays.get(key);
    if (overlay) return overlay.text ?? undefined;
    const text = this.rawDisk(path);
    return text?.startsWith(BOM) ? text.slice(1) : text;
  }

  fileExists(path: string): boolean {
    return this.readFile(path) !== undefined;
  }

  scriptVersion(path: string): string {
    return `${this.suspended ? "o" : "c"}${this.versions.get(this.key(path)) ?? 0}`;
  }

  write(path: string, text: string | null, bom = this.hasBom(path)): void {
    const key = this.key(path);
    const existing = this.overlays.get(key);
    this.overlays.set(key, { path: existing?.path ?? resolve(path), text: text?.startsWith(BOM) ? text.slice(1) : text, bom });
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    this.version += 1;
  }

  clearGenerated(): void {
    for (const key of this.generated.keys()) this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    this.generated.clear();
    this.version += 1;
  }

  writeGenerated(path: string, text: string): void {
    if (!this.isHidden(path)) fail("DECLARATION_OUTPUT_UNSUPPORTED", `in-memory build would emit outside a declaration output directory: ${path}`);
    const key = this.key(path);
    this.generated.set(key, { path: resolve(path), text });
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    this.version += 1;
  }

  private diskEntries(directory: string): Entries {
    if (this.inputs.enabled) {
      this.inputs.sys.getDirectories(directory);
      this.inputs.sys.readDirectory(directory, undefined, undefined, ["*"], 1);
    }
    const files: string[] = [];
    const directories: string[] = [];
    let names: string[];
    try { names = readdirSync(directory); } catch { return { files, directories }; }
    for (const name of names) {
      try {
        const stat = statSync(resolve(directory, name));
        if (stat.isFile()) files.push(name);
        else if (stat.isDirectory()) directories.push(name);
      } catch { /* dangling symlink */ }
    }
    return { files, directories };
  }

  private virtualPaths(): string[] {
    const paths = [...this.generated.values()].map((item) => item.path);
    if (!this.suspended) {
      for (const overlay of this.overlays.values()) if (overlay.text !== null) paths.push(overlay.path);
    }
    return paths;
  }

  entries(directory: string): Entries {
    directory = this.readPath(directory);
    const hidden = this.isHidden(directory);
    const files = new Map<string, string>();
    const directories = new Map<string, string>();
    if (!hidden) {
      const disk = this.diskEntries(directory);
      for (const name of disk.files) {
        const path = resolve(directory, name);
        if (!this.isHidden(path) && this.fileExists(path)) files.set(this.key(path), name);
      }
      for (const name of disk.directories) {
        const path = resolve(directory, name);
        if (!this.isHidden(path) || this.directoryExists(path)) directories.set(this.key(path), name);
      }
    }
    for (const path of this.virtualPaths()) {
      if (!this.contains(directory, path) || this.samePath(directory, path)) continue;
      const rest = relative(directory, path).split(sep);
      const child = resolve(directory, rest[0]!);
      if (rest.length === 1) files.set(this.key(child), rest[0]!);
      else directories.set(this.key(child), rest[0]!);
    }
    return { files: [...files.values()], directories: [...directories.values()] };
  }

  directoryExists(path: string): boolean {
    path = this.readPath(path);
    if (this.inputs.enabled) this.inputs.sys.directoryExists(path);
    if (this.virtualPaths().some((item) => this.contains(path, item) && !this.samePath(path, item))) return true;
    if (this.isHidden(path)) return false;
    try { return statSync(path).isDirectory(); } catch { return false; }
  }

  getDirectories(path: string): string[] {
    return this.entries(path).directories;
  }

  realpath(path: string): string {
    path = this.readPath(path);
    const key = this.key(path);
    if (this.generated.has(key) || (!this.suspended && this.overlays.has(key))) return resolve(path);
    try { return this.inputs.sys.realpath?.(path) ?? path; } catch { return path; }
  }

  /** Overlay-aware implementation of TypeScript's readDirectory matching. */
  readDirectory(path: string, extensions?: readonly string[], excludes?: readonly string[], includes?: readonly string[], depth?: number): string[] {
    path = resolve(path);
    const flags = this.caseSensitive ? "" : "i";
    const includeFiles = includes?.length
      ? includes.map((spec) => subPattern(spec, path, "files")).map((pattern) => pattern === undefined ? undefined : new RegExp(`^${pattern}$`, flags))
      : undefined;
    const includeDirectories = wildcardRegex(includes, path, "directories", flags);
    const exclude = wildcardRegex(excludes, path, "exclude", flags);
    const results: string[][] = includeFiles ? includeFiles.map(() => []) : [[]];
    const bases = [path];
    for (const base of (includes ?? []).map((spec) => includeBasePath(resolve(path, spec))).sort()) {
      if (bases.every((existing) => !this.contains(existing, base))) bases.push(base);
    }
    const visited = new Set<string>();
    const visit = (directory: string, remaining: number | undefined) => {
      const key = this.key(this.realpath(directory));
      if (visited.has(key)) return;
      visited.add(key);
      const { files, directories } = this.entries(directory);
      for (const name of [...files].sort()) {
        const absolute = resolve(directory, name);
        if (extensions && !extensions.some((extension) => absolute.endsWith(extension))) continue;
        const normalized = portablePath(absolute);
        if (exclude?.test(normalized)) continue;
        if (!includeFiles) results[0]!.push(absolute);
        else {
          const index = includeFiles.findIndex((regex) => regex?.test(normalized));
          if (index !== -1) results[index]!.push(absolute);
        }
      }
      if (remaining !== undefined && --remaining === 0) return;
      for (const name of [...directories].sort()) {
        const absolute = resolve(directory, name);
        const normalized = portablePath(absolute);
        if ((!includeDirectories || includeDirectories.test(normalized)) && !exclude?.test(normalized)) visit(absolute, remaining);
      }
    };
    for (const base of bases) visit(base, depth);
    return results.flat();
  }

  moduleResolutionHost(): ts.ModuleResolutionHost {
    return {
      fileExists: (path) => this.fileExists(path),
      readFile: (path) => this.readFile(path),
      directoryExists: (path) => this.directoryExists(path),
      getDirectories: (path) => this.getDirectories(path),
      realpath: (path) => this.realpath(path),
      useCaseSensitiveFileNames: this.caseSensitive,
    };
  }

  parseConfigHost(onError: (diagnostic: ts.Diagnostic) => void): ts.ParseConfigFileHost {
    return {
      useCaseSensitiveFileNames: this.caseSensitive,
      readDirectory: (path, extensions, excludes, includes, depth) => this.readDirectory(path, extensions, excludes, includes, depth),
      fileExists: (path) => this.fileExists(path),
      readFile: (path) => this.readFile(path),
      getCurrentDirectory: () => this.root,
      onUnRecoverableConfigFileDiagnostic: onError,
    };
  }

  /** Paths whose content differs from disk, with BOMs restored. */
  changes(): FileChange[] {
    const changes: FileChange[] = [];
    for (const overlay of this.overlays.values()) {
      const before = this.rawDisk(overlay.path) ?? null;
      const after = overlay.text === null ? null : `${overlay.bom ? BOM : ""}${overlay.text}`;
      if (before === after) continue;
      changes.push({ path: overlay.path, before, after });
    }
    return changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }

  /** Paths of overlays that currently differ from disk. */
  changedPaths(): string[] {
    return this.changes().map((change) => change.path);
  }
}
