var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// src/backends/typescript-timing.ts
function timed(phase, run) {
  if (process.env.REFACTOR_AI_TIMINGS !== "on")
    return run();
  const start = performance.now();
  process.stderr.write(JSON.stringify({ phase, event: "start" }) + `
`);
  try {
    return run();
  } finally {
    process.stderr.write(JSON.stringify({ phase, event: "end", ms: Math.round(performance.now() - start) }) + `
`);
  }
}

// src/backends/typescript-diagnostics-cache.ts
import ts from "typescript";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

class CompilerInputs {
  enabled;
  inputs = new Map;
  consistent = true;
  sys;
  constructor(enabled = process.env.REFACTOR_AI_CACHE === "on") {
    this.enabled = enabled;
    this.sys = { ...ts.sys };
    if (!enabled)
      return;
    for (const method of methods) {
      const original = ts.sys[method];
      if (!original)
        continue;
      this.sys[method] = (...args) => {
        const value = original(...args);
        const key = JSON.stringify([method, args]), digest = hash(value);
        if (this.inputs.has(key) && this.inputs.get(key).digest !== digest)
          this.consistent = false;
        this.inputs.set(key, { method, args, digest });
        return value;
      };
    }
  }
  snapshot() {
    return [...this.inputs.values()];
  }
  unchanged() {
    try {
      return this.consistent && this.snapshot().every(current);
    } catch {
      return false;
    }
  }
}
function current(input) {
  if (!input || !methods.includes(input.method) || !Array.isArray(input.args) || typeof input.digest !== "string")
    return false;
  const method = ts.sys[input.method];
  return !!method && hash(method(...input.args)) === input.digest;
}
function regularDirectory(path, create) {
  const parent = dirname(path);
  if (parent !== path && !regularDirectory(parent, create))
    return false;
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    if (error.code !== "ENOENT" || !create)
      return false;
    mkdirSync(path, { mode: 448 });
    return true;
  }
}
function baselineDiagnostics(root, config, program, only, inputs, compute) {
  if (process.env.REFACTOR_AI_CACHE !== "on" || !inputs.enabled)
    return compute();
  const options = { ...program.getCompilerOptions(), configFile: undefined };
  const key = hash([
    1,
    ts.version,
    ts.sys.useCaseSensitiveFileNames,
    config,
    options,
    program.getRootFileNames(),
    only ? [...only].sort() : null,
    program.getSourceFiles().map((source) => [source.fileName, hash(source.text), source.impliedNodeFormat])
  ]);
  const directory = resolve(process.env.REFACTOR_AI_CACHE_DIR ?? resolve(root, ".refactor-ai/cache"));
  const path = resolve(directory, `${key}.json`);
  try {
    if (regularDirectory(directory, false) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) {
      const entry = JSON.parse(readFileSync(path, "utf8"));
      const { checksum, ...body } = entry;
      if (entry.version === 1 && entry.key === key && checksum === hash(body) && Array.isArray(entry.inputs) && entry.inputs.every(current) && Array.isArray(entry.diagnostics) && entry.diagnostics.every((item) => typeof item.file === "string" && typeof item.code === "string" && typeof item.message === "string")) {
        return entry.diagnostics;
      }
    }
  } catch {}
  const diagnostics = compute();
  try {
    const observed = inputs.snapshot();
    if (inputs.unchanged() && regularDirectory(directory, true)) {
      if (!process.env.REFACTOR_AI_CACHE_DIR) {
        try {
          writeFileSync(resolve(root, ".refactor-ai/.gitignore"), `*
`, { flag: "wx", mode: 384 });
        } catch (error) {
          if (error.code !== "EEXIST")
            throw error;
        }
      }
      const body = { version: 1, key, inputs: observed, diagnostics };
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ ...body, checksum: hash(body) }), { mode: 384, flag: "wx" });
      renameSync(temporary, path);
    }
  } catch {}
  return diagnostics;
}
var hash = (value) => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex"), methods;
var init_typescript_diagnostics_cache = __esm(() => {
  methods = ["readFile", "fileExists", "directoryExists", "getDirectories", "readDirectory", "realpath"];
});

// src/backends/typescript-paths.ts
import { existsSync, readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname2, isAbsolute, join, relative, sep } from "node:path";
function portablePath(path, separator = sep) {
  return path.split(separator).join("/");
}
function isInside(root, path) {
  const difference = relative(root, path);
  return difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}
function workspaceRootHint(root, outside) {
  let current2 = root;
  for (;; ) {
    const manifest = join(current2, "package.json");
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync2(manifest, "utf8")).workspaces && outside.every((path) => isInside(current2, path))) {
          return `; these files belong to the workspace at ${current2}: rerun with --root ${current2}`;
        }
      } catch {}
    }
    const parent = dirname2(current2);
    if (parent === current2)
      return "; widen --root to a directory containing them";
    current2 = parent;
  }
}
var init_typescript_paths = () => {};

// src/backends/typescript-vfs.ts
import ts2 from "typescript";
import { existsSync as existsSync2, readdirSync, readFileSync as readFileSync3, realpathSync, statSync } from "node:fs";
import { basename, dirname as dirname3, relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";
function fail(code, reason) {
  throw new Error(`${code}: ${reason}`);
}
function swapCase(value) {
  return [...value].map((char) => char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()).join("");
}
function detectCaseSensitivity(root) {
  const probe = [root, ...readdirSync(root).map((name) => resolve2(root, name))].find((path) => swapCase(basename(path)) !== basename(path));
  if (!probe)
    return ts2.sys.useCaseSensitiveFileNames;
  const swapped = resolve2(dirname3(probe), swapCase(basename(probe)));
  if (!existsSync2(swapped))
    return true;
  const a = statSync(probe), b = statSync(swapped);
  return !(a.ino === b.ino && a.dev === b.dev);
}
function eolOf(text) {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? `\r
` : `
`;
}
function withEol(text, eol) {
  return text.replace(/\r?\n/g, eol);
}
function specComponents(spec, basePath) {
  const normalized = portablePath(resolve2(basePath, spec));
  const parts = normalized.split("/").filter((component, index) => index === 0 || component !== "");
  if (normalized.startsWith("//"))
    parts[0] = "/";
  return parts;
}
function subPattern(spec, basePath, usage) {
  const { single, double } = matchers[usage];
  const components = specComponents(spec, basePath);
  const last = components[components.length - 1];
  if (usage !== "exclude" && last === "**")
    return;
  if (!/[.*?]/.test(last))
    components.push("**", "*");
  const replace = (match) => match === "*" ? single : match === "?" ? "[^/]" : `\\${match}`;
  let pattern = "";
  let written = false;
  let optional = 0;
  for (let component of components) {
    if (component === "**") {
      pattern += double;
    } else {
      if (usage === "directories") {
        pattern += "(";
        optional += 1;
      }
      if (written)
        pattern += "/";
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
        if (componentPattern !== component)
          pattern += packageFolders;
        pattern += componentPattern;
      } else {
        pattern += component.replace(/[^\w\s/]/g, replace);
      }
    }
    written = true;
  }
  while (optional-- > 0)
    pattern += ")?";
  return pattern;
}
function wildcardRegex(specs, basePath, usage, flags) {
  const patterns = (specs ?? []).map((spec) => subPattern(spec, basePath, usage)).filter((item) => !!item);
  if (!patterns.length)
    return;
  return new RegExp(`^(?:${patterns.map((item) => `(?:${item})`).join("|")})${usage === "exclude" ? "(?:$|/)" : "$"}`, flags);
}
function includeBasePath(absolute) {
  const wildcard = absolute.search(/[*?]/);
  if (wildcard < 0)
    return basename(absolute).includes(".") ? dirname3(absolute) : absolute;
  const normalized = portablePath(absolute);
  const end = normalized.lastIndexOf("/", wildcard);
  return end === 2 && /^[A-Za-z]:/.test(normalized) ? normalized.slice(0, 3) : normalized.slice(0, end) || "/";
}

class VirtualFs {
  root;
  inputs = new CompilerInputs;
  caseSensitive;
  readPaths = new Map;
  disk = new Map;
  overlays = new Map;
  generated = new Map;
  versions = new Map;
  hiddenDirectories = [];
  suspended = false;
  version = 0;
  constructor(root) {
    this.root = root;
    this.caseSensitive = detectCaseSensitivity(root);
  }
  key(path) {
    const normalized = resolve2(path);
    return this.caseSensitive ? normalized : normalized.toLowerCase();
  }
  samePath(a, b) {
    return this.key(a) === this.key(b);
  }
  contains(directory, path) {
    return isInside(this.key(directory), this.key(path));
  }
  setHiddenDirectories(directories) {
    this.hiddenDirectories = directories.map((directory) => resolve2(directory));
  }
  isHidden(path) {
    return this.hiddenDirectories.some((directory) => this.contains(directory, path));
  }
  original(callback) {
    const previous = this.suspended;
    this.suspended = true;
    this.version += 1;
    try {
      return callback();
    } finally {
      this.suspended = previous;
      this.version += 1;
    }
  }
  readPath(path) {
    path = resolve2(path);
    if (!path.split(sep2).includes("node_modules"))
      return path;
    const cached = this.readPaths.get(path);
    if (cached)
      return cached;
    let ancestor = path;
    while (!existsSync2(ancestor) && dirname3(ancestor) !== ancestor)
      ancestor = dirname3(ancestor);
    let canonical = path;
    try {
      const real = resolve2(realpathSync(ancestor), relative2(ancestor, path));
      if (isInside(this.root, real) && !real.split(sep2).includes("node_modules"))
        canonical = real;
    } catch {}
    this.readPaths.set(path, canonical);
    return canonical;
  }
  rawDisk(path) {
    const key = this.key(path);
    if (!this.disk.has(key)) {
      if (this.inputs.enabled) {
        this.inputs.sys.fileExists(path);
        this.inputs.sys.readFile(path);
      }
      let text;
      try {
        if (statSync(path).isFile())
          text = readFileSync3(path, "utf8");
      } catch {
        text = undefined;
      }
      this.disk.set(key, text);
    }
    return this.disk.get(key);
  }
  diskText(path) {
    if (this.isHidden(path))
      return null;
    return this.rawDisk(path) ?? null;
  }
  hasBom(path) {
    path = this.readPath(path);
    const overlay = this.suspended ? undefined : this.overlays.get(this.key(path));
    if (overlay)
      return overlay.bom;
    return this.diskText(path)?.startsWith(BOM) ?? false;
  }
  readFile(path) {
    path = this.readPath(path);
    const key = this.key(path);
    const generated = this.generated.get(key);
    if (generated)
      return generated.text;
    if (this.isHidden(path))
      return;
    const overlay = this.suspended ? undefined : this.overlays.get(key);
    if (overlay)
      return overlay.text ?? undefined;
    const text = this.rawDisk(path);
    return text?.startsWith(BOM) ? text.slice(1) : text;
  }
  fileExists(path) {
    return this.readFile(path) !== undefined;
  }
  scriptVersion(path) {
    return `${this.suspended ? "o" : "c"}${this.versions.get(this.key(path)) ?? 0}`;
  }
  write(path, text, bom = this.hasBom(path)) {
    const key = this.key(path);
    const existing = this.overlays.get(key);
    this.overlays.set(key, { path: existing?.path ?? resolve2(path), text: text?.startsWith(BOM) ? text.slice(1) : text, bom });
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    this.version += 1;
  }
  clearGenerated() {
    for (const key of this.generated.keys())
      this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    this.generated.clear();
    this.version += 1;
  }
  writeGenerated(path, text) {
    if (!this.isHidden(path))
      fail("DECLARATION_OUTPUT_UNSUPPORTED", `in-memory build would emit outside a declaration output directory: ${path}`);
    const key = this.key(path);
    this.generated.set(key, { path: resolve2(path), text });
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    this.version += 1;
  }
  diskEntries(directory) {
    if (this.inputs.enabled) {
      this.inputs.sys.getDirectories(directory);
      this.inputs.sys.readDirectory(directory, undefined, undefined, ["*"], 1);
    }
    const files = [];
    const directories = [];
    let names;
    try {
      names = readdirSync(directory);
    } catch {
      return { files, directories };
    }
    for (const name of names) {
      try {
        const stat = statSync(resolve2(directory, name));
        if (stat.isFile())
          files.push(name);
        else if (stat.isDirectory())
          directories.push(name);
      } catch {}
    }
    return { files, directories };
  }
  virtualPaths() {
    const paths = [...this.generated.values()].map((item) => item.path);
    if (!this.suspended) {
      for (const overlay of this.overlays.values())
        if (overlay.text !== null)
          paths.push(overlay.path);
    }
    return paths;
  }
  entries(directory) {
    directory = this.readPath(directory);
    const hidden = this.isHidden(directory);
    const files = new Map;
    const directories = new Map;
    if (!hidden) {
      const disk = this.diskEntries(directory);
      for (const name of disk.files) {
        const path = resolve2(directory, name);
        if (!this.isHidden(path) && this.fileExists(path))
          files.set(this.key(path), name);
      }
      for (const name of disk.directories) {
        const path = resolve2(directory, name);
        if (!this.isHidden(path) || this.directoryExists(path))
          directories.set(this.key(path), name);
      }
    }
    for (const path of this.virtualPaths()) {
      if (!this.contains(directory, path) || this.samePath(directory, path))
        continue;
      const rest = relative2(directory, path).split(sep2);
      const child = resolve2(directory, rest[0]);
      if (rest.length === 1)
        files.set(this.key(child), rest[0]);
      else
        directories.set(this.key(child), rest[0]);
    }
    return { files: [...files.values()], directories: [...directories.values()] };
  }
  directoryExists(path) {
    path = this.readPath(path);
    if (this.inputs.enabled)
      this.inputs.sys.directoryExists(path);
    if (this.virtualPaths().some((item) => this.contains(path, item) && !this.samePath(path, item)))
      return true;
    if (this.isHidden(path))
      return false;
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }
  getDirectories(path) {
    return this.entries(path).directories;
  }
  realpath(path) {
    path = this.readPath(path);
    const key = this.key(path);
    if (this.generated.has(key) || !this.suspended && this.overlays.has(key))
      return resolve2(path);
    try {
      return this.inputs.sys.realpath?.(path) ?? path;
    } catch {
      return path;
    }
  }
  readDirectory(path, extensions, excludes, includes, depth) {
    path = resolve2(path);
    const flags = this.caseSensitive ? "" : "i";
    const includeFiles = includes?.length ? includes.map((spec) => subPattern(spec, path, "files")).map((pattern) => pattern === undefined ? undefined : new RegExp(`^${pattern}$`, flags)) : undefined;
    const includeDirectories = wildcardRegex(includes, path, "directories", flags);
    const exclude = wildcardRegex(excludes, path, "exclude", flags);
    const results = includeFiles ? includeFiles.map(() => []) : [[]];
    const bases = [path];
    for (const base of (includes ?? []).map((spec) => includeBasePath(resolve2(path, spec))).sort()) {
      if (bases.every((existing) => !this.contains(existing, base)))
        bases.push(base);
    }
    const visited = new Set;
    const visit = (directory, remaining) => {
      const key = this.key(this.realpath(directory));
      if (visited.has(key))
        return;
      visited.add(key);
      const { files, directories } = this.entries(directory);
      for (const name of [...files].sort()) {
        const absolute = resolve2(directory, name);
        if (extensions && !extensions.some((extension) => absolute.endsWith(extension)))
          continue;
        const normalized = portablePath(absolute);
        if (exclude?.test(normalized))
          continue;
        if (!includeFiles)
          results[0].push(absolute);
        else {
          const index = includeFiles.findIndex((regex) => regex?.test(normalized));
          if (index !== -1)
            results[index].push(absolute);
        }
      }
      if (remaining !== undefined && --remaining === 0)
        return;
      for (const name of [...directories].sort()) {
        const absolute = resolve2(directory, name);
        const normalized = portablePath(absolute);
        if ((!includeDirectories || includeDirectories.test(normalized)) && !exclude?.test(normalized))
          visit(absolute, remaining);
      }
    };
    for (const base of bases)
      visit(base, depth);
    return results.flat();
  }
  moduleResolutionHost() {
    return {
      fileExists: (path) => this.fileExists(path),
      readFile: (path) => this.readFile(path),
      directoryExists: (path) => this.directoryExists(path),
      getDirectories: (path) => this.getDirectories(path),
      realpath: (path) => this.realpath(path),
      useCaseSensitiveFileNames: this.caseSensitive
    };
  }
  parseConfigHost(onError) {
    return {
      useCaseSensitiveFileNames: this.caseSensitive,
      readDirectory: (path, extensions, excludes, includes, depth) => this.readDirectory(path, extensions, excludes, includes, depth),
      fileExists: (path) => this.fileExists(path),
      readFile: (path) => this.readFile(path),
      getCurrentDirectory: () => this.root,
      onUnRecoverableConfigFileDiagnostic: onError
    };
  }
  changes() {
    const changes = [];
    for (const overlay of this.overlays.values()) {
      const before = this.rawDisk(overlay.path) ?? null;
      const after = overlay.text === null ? null : `${overlay.bom ? BOM : ""}${overlay.text}`;
      if (before === after)
        continue;
      changes.push({ path: overlay.path, before, after });
    }
    return changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  changedPaths() {
    return this.changes().map((change) => change.path);
  }
}
var BOM = "\uFEFF", packageFolders = "(?!(node_modules|bower_components|jspm_packages)(/|$))", matchers;
var init_typescript_vfs = __esm(() => {
  init_typescript_diagnostics_cache();
  init_typescript_paths();
  init_typescript_paths();
  matchers = {
    files: { single: "([^./]|(\\.(?!min\\.js$))?)*", double: `(/${packageFolders}[^/.][^/]*)*?` },
    directories: { single: "[^/]*", double: `(/${packageFolders}[^/.][^/]*)*?` },
    exclude: { single: "[^/]*", double: "(/.+?)?" }
  };
});

// src/backends/typescript-workspace.ts
import ts3 from "typescript";
import { readdirSync as readdirSync2, statSync as statSync2 } from "node:fs";
import { basename as basename2, dirname as dirname4, relative as relative3, resolve as resolve3 } from "node:path";
function configPathFor(project) {
  let stat;
  try {
    stat = statSync2(project);
  } catch {
    fail("PROJECT_NOT_FOUND", project);
  }
  if (stat.isFile()) {
    if (!configName.test(basename2(project)))
      fail("UNSUPPORTED_PROJECT", "project must name a tsconfig*.json or jsconfig*.json file");
    return resolve3(project);
  }
  if (!stat.isDirectory())
    fail("UNSUPPORTED_PROJECT", "project must be a config file or directory");
  const candidates = ["tsconfig.json", "jsconfig.json"].map((name) => resolve3(project, name)).filter((path) => {
    try {
      return statSync2(path).isFile();
    } catch {
      return false;
    }
  });
  if (candidates.length === 0)
    fail("CONFIG_NOT_FOUND", `no tsconfig.json or jsconfig.json in ${project}`);
  if (candidates.length > 1)
    fail("MULTIPLE_CONFIGS", `both tsconfig.json and jsconfig.json exist in ${project}`);
  return candidates[0];
}
function discoverConfigs(root) {
  const found = [];
  const visit = (directory) => {
    let names;
    try {
      names = readdirSync2(directory).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = resolve3(directory, name);
      let stat;
      try {
        stat = statSync2(path);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (name !== "node_modules" && !name.startsWith("."))
          visit(path);
      } else if (stat.isFile() && configName.test(name)) {
        found.push(path);
      }
    }
  };
  visit(root);
  return found;
}
function flatten(diagnostic) {
  return ts3.flattenDiagnosticMessageText(diagnostic.messageText, `
`);
}
function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function isDeclarationPath(path) {
  return /\.d(\.[^./]+)?\.[cm]?ts$/.test(path);
}
function scriptKindFor(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx"))
    return ts3.ScriptKind.TSX;
  if (lower.endsWith(".jsx"))
    return ts3.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(lower))
    return ts3.ScriptKind.JS;
  if (lower.endsWith(".json"))
    return ts3.ScriptKind.JSON;
  return ts3.ScriptKind.TS;
}
function isModuleMockCall(node) {
  return ts3.isCallExpression(node) && node.arguments.length >= 1 && ts3.isStringLiteralLike(node.arguments[0]) && ts3.isPropertyAccessExpression(node.expression) && ts3.isIdentifier(node.expression.expression) && mockObjects.has(node.expression.expression.text) && mockMethods.has(node.expression.name.text);
}
function moduleSpecifiers(sourceFile) {
  const found = [];
  const seen = new Set;
  const isJs = /\.[cm]?jsx?$/i.test(sourceFile.fileName);
  const visit = (node) => {
    if (seen.has(node))
      return;
    seen.add(node);
    if ((ts3.isImportDeclaration(node) || ts3.isExportDeclaration(node)) && node.moduleSpecifier && ts3.isStringLiteralLike(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier);
    } else if (ts3.isExternalModuleReference(node) && ts3.isStringLiteralLike(node.expression)) {
      found.push(node.expression);
    } else if (ts3.isCallExpression(node) && node.arguments.length >= 1 && ts3.isStringLiteralLike(node.arguments[0]) && (node.expression.kind === ts3.SyntaxKind.ImportKeyword || ts3.isIdentifier(node.expression) && node.expression.text === "require")) {
      found.push(node.arguments[0]);
    } else if (isModuleMockCall(node)) {
      found.push(node.arguments[0]);
    } else if (ts3.isImportTypeNode(node) && ts3.isLiteralTypeNode(node.argument) && ts3.isStringLiteralLike(node.argument.literal)) {
      found.push(node.argument.literal);
    }
    if (isJs)
      for (const doc of ts3.getJSDocCommentsAndTags(node))
        visit(doc);
    ts3.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found.sort((a, b) => a.getStart(sourceFile) - b.getStart(sourceFile));
}
function hasAmbientEffect(source) {
  const visit = (node) => ts3.isModuleDeclaration(node) && (ts3.isStringLiteral(node.name) || (node.flags & ts3.NodeFlags.GlobalAugmentation) !== 0) || !!ts3.forEachChild(node, visit);
  return visit(source);
}

class Workspace {
  root;
  affected;
  vfs;
  participants = new Map;
  order = [];
  sourceConfig;
  targetConfig;
  editOptions;
  service;
  registry;
  discovered;
  importingConfigs = [];
  layouts = new Map;
  owners = new Map;
  sourceFiles = new Map;
  looseConfigs = new Map;
  extendedConfigs;
  constructor(root, sourceConfig, targetConfig, affected = []) {
    this.root = root;
    this.affected = affected;
    this.vfs = new VirtualFs(root);
    this.registry = ts3.createDocumentRegistry(this.vfs.caseSensitive);
    this.sourceConfig = sourceConfig;
    this.targetConfig = targetConfig;
    for (const config of [sourceConfig, targetConfig]) {
      if (!isInside(root, config))
        fail("OUTSIDE_ROOT", `project config is outside ${root}: ${config}`);
    }
    this.discovered = discoverConfigs(root);
    this.loadGraph();
    this.editOptions = { ...this.participant(sourceConfig).parsed.options, noEmit: true };
    for (const key of [
      "configFile",
      "configFilePath",
      "composite",
      "incremental",
      "tsBuildInfoFile",
      "declaration",
      "declarationMap",
      "emitDeclarationOnly",
      "declarationDir",
      "outDir",
      "rootDir"
    ])
      delete this.editOptions[key];
    this.service = this.languageService(sourceConfig, () => this.editOptions, () => this.unionFiles());
  }
  languageService(config, options, files) {
    const vfs = this.vfs;
    const host = {
      getCompilationSettings: options,
      getScriptFileNames: files,
      getScriptVersion: (fileName) => vfs.scriptVersion(fileName),
      getScriptSnapshot: (fileName) => {
        const text = vfs.readFile(fileName);
        return text === undefined ? undefined : ts3.ScriptSnapshot.fromString(text);
      },
      getScriptKind: (fileName) => scriptKindFor(fileName),
      getCurrentDirectory: () => dirname4(config),
      getDefaultLibFileName: (options2) => ts3.getDefaultLibFilePath(options2),
      fileExists: (path) => vfs.fileExists(path),
      readFile: (path) => vfs.readFile(path),
      readDirectory: (path, extensions, excludes, includes, depth) => vfs.readDirectory(path, extensions, excludes, includes, depth),
      directoryExists: (path) => vfs.directoryExists(path),
      getDirectories: (path) => vfs.getDirectories(path),
      realpath: (path) => vfs.realpath(path),
      useCaseSensitiveFileNames: () => vfs.caseSensitive,
      getNewLine: () => `
`,
      getProjectVersion: () => String(vfs.version),
      hasInvalidatedResolutions: () => true
    };
    return ts3.createLanguageService(host, this.registry);
  }
  dispose() {
    this.service.dispose();
  }
  participant(config) {
    const found = this.participants.get(this.vfs.key(config));
    if (!found)
      fail("UNHANDLED_PROJECT_GRAPH", `${config} is not part of the loaded project graph`);
    return found;
  }
  parse(configPath, useDisk = false, planned = false) {
    const onError = (diagnostic) => fail("INVALID_CONFIG", `${configPath}: ${flatten(diagnostic)}`);
    const host = useDisk ? { ...ts3.sys, onUnRecoverableConfigFileDiagnostic: onError } : this.vfs.parseConfigHost(onError);
    const parsed = ts3.getParsedCommandLineOfConfigFile(configPath, undefined, host);
    if (!parsed)
      fail("INVALID_CONFIG", `could not parse ${configPath}`);
    const errors = parsed.errors.filter((diagnostic) => diagnostic.category === ts3.DiagnosticCategory.Error);
    if (planned && errors.some((diagnostic) => diagnostic.code === 18003)) {
      fail("PROJECT_WOULD_BE_EMPTY", `${configPath} would no longer include any source file`);
    }
    if (errors.length)
      fail("INVALID_CONFIG", `${configPath}: ${flatten(errors[0])}`);
    return parsed;
  }
  rawReferences(configPath) {
    const result = ts3.readConfigFile(configPath, (path) => this.vfs.readFile(path));
    const references = result.config?.references;
    if (!Array.isArray(references))
      return [];
    return references.map((reference) => typeof reference?.path === "string" ? resolve3(ts3.resolveProjectReferencePath({ path: resolve3(dirname4(configPath), reference.path) })) : undefined).filter((path) => path !== undefined);
  }
  loadGraph() {
    const vfs = this.vfs;
    const affected = new Set([vfs.key(this.sourceConfig), vfs.key(this.targetConfig)]);
    const paths = new Map([[vfs.key(this.sourceConfig), this.sourceConfig], [vfs.key(this.targetConfig), this.targetConfig]]);
    for (const config of this.discovered) {
      if (affected.has(vfs.key(config)) || !this.importsAffected(config, this.affected))
        continue;
      affected.add(vfs.key(config));
      paths.set(vfs.key(config), config);
      this.importingConfigs.push(config);
    }
    const graphDirectories = new Set([...affected].map((key) => vfs.key(dirname4(paths.get(key)))));
    const observers = new Set;
    for (const config of this.discovered) {
      if (affected.has(vfs.key(config)) || editorConfigName.test(basename2(config)) || this.isBaseConfig(config))
        continue;
      if (!graphDirectories.has(vfs.key(dirname4(config))) || !this.listsAny(config, this.affected))
        continue;
      affected.add(vfs.key(config));
      paths.set(vfs.key(config), config);
      observers.add(vfs.key(config));
    }
    const rawReferences = new Map(this.discovered.map((config) => [vfs.key(config), this.rawReferences(config)]));
    let grew = true;
    while (grew) {
      grew = false;
      for (const config of this.discovered) {
        if (affected.has(vfs.key(config)))
          continue;
        if (rawReferences.get(vfs.key(config)).some((reference) => affected.has(vfs.key(reference)))) {
          affected.add(vfs.key(config));
          paths.set(vfs.key(config), config);
          grew = true;
        }
      }
    }
    const diskParsed = new Map;
    const pending = [...affected].map((key) => paths.get(key));
    while (pending.length) {
      const config = pending.shift();
      const key = vfs.key(config);
      if (diskParsed.has(key))
        continue;
      if (!isInside(this.root, config))
        fail("OUTSIDE_ROOT", `referenced project is outside ${this.root}: ${config}`);
      if (!vfs.fileExists(config))
        fail("PROJECT_NOT_FOUND", `referenced project does not exist: ${config}`);
      const parsed = this.parse(config, true);
      diskParsed.set(key, parsed);
      paths.set(key, config);
      for (const reference of parsed.projectReferences ?? [])
        pending.push(resolve3(ts3.resolveProjectReferencePath(reference)));
    }
    for (const [key, parsed] of diskParsed) {
      const configPath = paths.get(key);
      if (parsed.options.outFile)
        fail("UNSUPPORTED_PROJECT", `${configPath}: outFile bundles are not supported`);
      const references = (parsed.projectReferences ?? []).map((reference) => resolve3(ts3.resolveProjectReferencePath(reference)));
      if (references.some((reference) => !diskParsed.has(vfs.key(reference)))) {
        fail("UNHANDLED_PROJECT_GRAPH", `${configPath} references a project that could not be loaded`);
      }
      if ((parsed.projectReferences ?? []).some((reference) => reference.prepend)) {
        fail("UNSUPPORTED_PROJECT", `${configPath}: prepended project references are not supported`);
      }
      this.participants.set(key, { configPath, parsed, references, observer: observers.has(key) });
    }
    const referenced = new Set([...this.participants.values()].flatMap((item) => item.references.map((path) => vfs.key(path))));
    const outputs = [];
    for (const key of referenced) {
      const item = this.participants.get(key);
      const output = item.parsed.options.declarationDir ?? item.parsed.options.outDir;
      if (!output) {
        fail("DECLARATION_OUTPUT_UNSUPPORTED", `${item.configPath} is referenced by another project and must emit declarations to outDir or declarationDir`);
      }
      if (!isInside(this.root, output) || vfs.samePath(output, dirname4(item.configPath)) || vfs.contains(output, dirname4(item.configPath))) {
        fail("DECLARATION_OUTPUT_UNSUPPORTED", `${item.configPath}: declaration output directory must be a dedicated directory inside ${this.root}`);
      }
      item.outputDirectory = resolve3(output);
      outputs.push(item.outputDirectory);
    }
    vfs.setHiddenDirectories(outputs);
    for (const [key, item] of this.participants) {
      const disk = diskParsed.get(key).fileNames.map((path) => vfs.key(path)).sort();
      item.parsed = this.parse(item.configPath);
      const virtual = item.parsed.fileNames.map((path) => vfs.key(path)).sort();
      const inOutputs = item.parsed.fileNames.concat(diskParsed.get(key).fileNames).find((path) => vfs.isHidden(path));
      if (inOutputs)
        fail("DECLARATION_OUTPUT_UNSUPPORTED", `${item.configPath} includes a file inside a declaration output directory: ${inOutputs}`);
      if (!sameValue(disk, virtual)) {
        fail("CONFIG_PATTERNS_UNSUPPORTED", `${item.configPath}: include/exclude patterns could not be reproduced exactly for in-memory planning`);
      }
      const outside = item.parsed.fileNames.find((path) => !isInside(this.root, path));
      if (outside)
        fail("OUTSIDE_ROOT", `${item.configPath} includes ${outside}, outside ${this.root}`);
    }
    const state = new Map;
    const visit = (key, trail) => {
      if (state.get(key) === "done")
        return;
      if (state.get(key) === "visiting")
        fail("UNHANDLED_PROJECT_GRAPH", `project reference cycle: ${[...trail, key].join(" -> ")}`);
      state.set(key, "visiting");
      for (const reference of this.participants.get(key).references)
        visit(vfs.key(reference), [...trail, key]);
      state.set(key, "done");
      this.order.push(key);
    };
    for (const key of [...this.participants.keys()].sort())
      visit(key, []);
    const withFiles = [...this.participants.values()].filter((item) => item.parsed.fileNames.length > 0);
    const first = this.participant(this.sourceConfig);
    for (const item of withFiles) {
      for (const option of sharedOptionKeys) {
        if (!sameValue(item.parsed.options[option], first.parsed.options[option])) {
          fail("PROJECT_OPTIONS_INCOMPATIBLE", `${item.configPath} and ${first.configPath} differ in compiler option '${option}'; cross-project planning requires compatible syntax, emit and extension settings`);
        }
      }
    }
    this.indexOwners();
  }
  indexOwners() {
    this.owners = new Map;
    for (const item of this.participants.values()) {
      if (item.observer)
        continue;
      for (const path of item.parsed.fileNames) {
        const key = this.vfs.key(path);
        this.owners.set(key, [...this.owners.get(key) ?? [], item.configPath]);
      }
    }
  }
  reparse() {
    for (const item of this.participants.values())
      item.parsed = this.parse(item.configPath, false, true);
    this.indexOwners();
    this.vfs.version += 1;
  }
  ownersOf(path) {
    return this.owners.get(this.vfs.key(path)) ?? [];
  }
  isObserver(config) {
    return this.participant(config).observer === true;
  }
  observers() {
    return [...this.participants.values()].filter((item) => item.observer).map((item) => item.configPath).sort();
  }
  references(config) {
    return this.participant(config).references;
  }
  fileNames(config) {
    return this.participant(config).parsed.fileNames.map((path) => resolve3(path));
  }
  unionFiles() {
    const files = new Map;
    for (const item of this.participants.values())
      for (const path of item.parsed.fileNames)
        files.set(this.vfs.key(path), resolve3(path));
    return [...files.values()].sort();
  }
  program() {
    const program = this.service.getProgram();
    if (!program)
      fail("PROGRAM_UNAVAILABLE", "TypeScript could not create a program");
    return program;
  }
  resolveModule(specifier, sourceFile, options) {
    options ??= this.ownersOf(sourceFile.fileName)[0] ? this.participant(this.ownersOf(sourceFile.fileName)[0]).parsed.options : this.editOptions;
    const mode = ts3.getModeForUsageLocation(sourceFile, specifier, options);
    return ts3.resolveModuleName(specifier.text, sourceFile.fileName, options, this.vfs.moduleResolutionHost(), undefined, undefined, mode).resolvedModule;
  }
  looseParse(config) {
    const text = this.vfs.readFile(config);
    const cached = this.looseConfigs.get(this.vfs.key(config));
    if (cached && cached.text === text)
      return cached.parsed;
    let parsed;
    try {
      parsed = ts3.getParsedCommandLineOfConfigFile(config, undefined, this.vfs.parseConfigHost(() => {
        throw new Error("unparseable");
      }));
    } catch {
      parsed = undefined;
    }
    this.looseConfigs.set(this.vfs.key(config), { text, parsed });
    return parsed;
  }
  listsAny(config, paths) {
    if (!paths.length)
      return false;
    const parsed = this.looseParse(config);
    if (!parsed)
      fail("UNHANDLED_PROJECT_GRAPH", `${config} cannot be parsed, so it cannot be shown to be unaffected`);
    const listed = new Set(parsed.fileNames.map((path) => this.vfs.key(path)));
    return paths.some((path) => listed.has(this.vfs.key(path)));
  }
  isBaseConfig(config) {
    if (editorConfigName.test(basename2(config)))
      return false;
    if (!this.extendedConfigs) {
      this.extendedConfigs = new Set;
      for (const candidate of this.discovered) {
        const raw = ts3.readConfigFile(candidate, (path) => this.vfs.diskText(path) ?? undefined).config?.extends;
        for (const entry of Array.isArray(raw) ? raw : [raw]) {
          if (typeof entry !== "string" || !/^\.\.?[\\/]/.test(entry))
            continue;
          const path = resolve3(dirname4(candidate), entry);
          this.extendedConfigs.add(this.vfs.key(/\.json$/i.test(path) ? path : `${path}.json`));
        }
      }
    }
    if (!this.extendedConfigs.has(this.vfs.key(config)))
      return false;
    const own = ts3.readConfigFile(config, (path) => this.vfs.diskText(path) ?? undefined).config;
    return !own || !["files", "include", "references"].some((key) => (key in own));
  }
  importsAffected(config, paths) {
    if (!paths.length)
      return false;
    const parsed = this.looseParse(config);
    if (!parsed)
      fail("UNHANDLED_PROJECT_GRAPH", `${config} cannot be parsed, so it cannot be shown to be unaffected`);
    const listed = new Set(parsed.fileNames.map((path) => this.vfs.key(path)));
    if (!parsed.fileNames.length || paths.some((path) => listed.has(this.vfs.key(path))))
      return false;
    const program = ts3.createProgram({
      rootNames: parsed.fileNames,
      options: { ...parsed.options, noEmit: true },
      projectReferences: parsed.projectReferences,
      host: this.compilerHost(config, parsed.options)
    });
    const wanted = new Set(paths.map((path) => this.vfs.key(path)));
    return program.getSourceFiles().some((sourceFile) => wanted.has(this.vfs.key(sourceFile.fileName)));
  }
  assertNoUnhandledProjects(paths, useOriginal, checkImports = true) {
    const check = () => {
      for (const config of this.discovered) {
        if (this.participants.has(this.vfs.key(config)))
          continue;
        if (!this.isBaseConfig(config)) {
          const parsed = this.looseParse(config);
          if (!parsed)
            fail("UNHANDLED_PROJECT_GRAPH", `${config} cannot be parsed, so it cannot be shown to be unaffected`);
          const included = new Set(parsed.fileNames.map((path) => this.vfs.key(path)));
          const hit = paths.find((path) => included.has(this.vfs.key(path)));
          if (hit && editorConfigName.test(basename2(config))) {
            fail("UNHANDLED_PROJECT_GRAPH", `${config} also includes ${hit} but is not connected to ${this.sourceConfig} by project references`);
          }
          if (hit) {
            fail("UNHANDLED_PROJECT_GRAPH", `${config} also includes ${hit} but is neither a project in the planned graph nor a variant next to one; it would not be updated or validated`);
          }
        }
        if (checkImports && this.importsAffected(config, paths)) {
          fail("UNHANDLED_PROJECT_GRAPH", `${config} imports a changed file (${paths.map((path) => relative3(this.root, path)).join(", ")}) but was not part of the planned project graph`);
        }
      }
    };
    if (useOriginal)
      this.vfs.original(check);
    else
      check();
  }
  sourceFile(fileName, settings, options) {
    const text = this.vfs.readFile(fileName);
    if (text === undefined)
      return;
    const detail = typeof settings === "object" ? `${settings.languageVersion}|${settings.impliedNodeFormat}|${settings.jsDocParsingMode}` : String(settings);
    const key = `${this.vfs.key(fileName)}|${detail}|${options.moduleDetection}|${options.jsx}`;
    const cached = this.sourceFiles.get(key);
    if (cached?.text === text)
      return cached.file;
    const file = ts3.createSourceFile(fileName, text, settings, true, scriptKindFor(fileName));
    this.sourceFiles.set(key, { text, file });
    return file;
  }
  compilerHost(configPath, options) {
    const vfs = this.vfs;
    return {
      getSourceFile: (fileName, settings) => this.sourceFile(fileName, settings, options),
      getDefaultLibFileName: (options2) => ts3.getDefaultLibFilePath(options2),
      writeFile: () => {},
      getCurrentDirectory: () => dirname4(configPath),
      getCanonicalFileName: (fileName) => vfs.caseSensitive ? fileName : fileName.toLowerCase(),
      useCaseSensitiveFileNames: () => vfs.caseSensitive,
      getNewLine: () => `
`,
      fileExists: (path) => vfs.fileExists(path),
      readFile: (path) => vfs.readFile(path),
      readDirectory: (path, extensions, excludes, includes, depth) => vfs.readDirectory(path, extensions, excludes, includes, depth),
      directoryExists: (path) => vfs.directoryExists(path),
      getDirectories: (path) => vfs.getDirectories(path),
      realpath: (path) => vfs.realpath(path),
      getParsedCommandLine: (fileName) => this.participants.get(vfs.key(fileName))?.parsed ?? this.looseParse(fileName)
    };
  }
  validationPrograms() {
    return new Map(this.order.map((key) => {
      const item = this.participant(key);
      return [key, ts3.createProgram({
        rootNames: item.parsed.fileNames,
        options: item.parsed.options,
        projectReferences: item.parsed.projectReferences,
        host: this.compilerHost(item.configPath, item.parsed.options)
      })];
    }));
  }
  prepareValidation(skipCleanBaseline = false) {
    if ([...this.participants.values()].some((item) => item.references.length)) {
      const before = this.diagnostics();
      return () => ({ before, after: this.diagnostics() });
    }
    const beforePrograms = this.validationPrograms();
    const beforeGraphs = new Map([...beforePrograms].map(([key, program]) => [key, this.validationGraph(program)]));
    for (const [key, program] of beforePrograms) {
      const layout = this.computedOutputRoot(this.participant(key), program);
      if (layout !== undefined)
        this.layouts.set(key, layout);
    }
    return () => {
      const afterPrograms = this.validationPrograms();
      const only = new Map;
      let affected = 0;
      for (const [key, before] of beforePrograms) {
        const after = afterPrograms.get(key);
        const closure = this.validationClosure(before, after, beforeGraphs.get(key), this.validationGraph(after));
        if (closure) {
          only.set(key, closure);
          affected += closure.size;
        }
      }
      const beforeRecords = [], afterRecords = [];
      const afterLayouts = new Map;
      for (const key of this.order) {
        afterRecords.push(this.diagnostics(new Map([[key, afterPrograms.get(key)]]), only));
        for (const [config, layout] of this.layouts)
          afterLayouts.set(config, layout);
        afterPrograms.delete(key);
      }
      if (!skipCleanBaseline || afterRecords.some((records) => records.length)) {
        for (const key of this.order) {
          beforeRecords.push(this.vfs.original(() => this.diagnostics(new Map([[key, beforePrograms.get(key)]]), only, true)));
          beforePrograms.delete(key);
        }
      }
      beforePrograms.clear();
      beforeGraphs.clear();
      this.layouts = afterLayouts;
      const merge = (groups) => {
        const merged = new Map;
        for (const group of groups) {
          const counts = new Map;
          for (const record of group) {
            const key = JSON.stringify(record), count = (counts.get(key) ?? 0) + 1;
            counts.set(key, count);
            if (count > (merged.get(key)?.count ?? 0))
              merged.set(key, { record, count });
          }
        }
        return [...merged.values()].flatMap(({ record, count }) => Array.from({ length: count }, () => record)).sort((a, b) => a.file.localeCompare(b.file) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
      };
      return { before: merge(beforeRecords), after: merge(afterRecords), affected: only.size ? affected : undefined, affectedProjects: only.size };
    };
  }
  validationGraph(program) {
    const options = program.getCompilerOptions();
    const host = this.vfs.moduleResolutionHost();
    const cache = ts3.createModuleResolutionCache(this.root, (path) => this.vfs.key(path), options);
    const graph = new Map;
    for (const source of program.getSourceFiles()) {
      if (!this.validationSource(source))
        continue;
      const dependencies = moduleSpecifiers(source).map((specifier) => {
        const mode = program.getModeForUsageLocation(source, specifier);
        const resolved = ts3.resolveModuleName(specifier.text, source.fileName, options, host, cache, undefined, mode).resolvedModule;
        return resolved ? this.vfs.key(resolved.resolvedFileName) : undefined;
      });
      for (const reference of source.referencedFiles)
        dependencies.push(this.vfs.key(resolve3(dirname4(source.fileName), reference.fileName)));
      graph.set(this.vfs.key(source.fileName), dependencies);
    }
    return graph;
  }
  validationSource(source) {
    const path = resolve3(source.fileName);
    if (!isInside(this.root, path)) {
      if (!source.isDeclarationFile)
        fail("PROJECT_SCOPE_INCOMPLETE", `user source outside ${this.root}: ${path}${workspaceRootHint(this.root, [path])}`);
      return false;
    }
    return !portablePath(path).split("/").includes("node_modules") && !this.vfs.isHidden(path);
  }
  validationClosure(before, after, oldGraph, newGraph) {
    const changes = this.vfs.changes();
    const changed = new Set(changes.map((change) => this.vfs.key(change.path)));
    const options = (program) => Object.fromEntries(Object.entries(program.getCompilerOptions()).filter(([key]) => key !== "configFile"));
    if (!sameValue(options(before), options(after)))
      return;
    const oldRoots = new Set(before.getRootFileNames().map((path) => this.vfs.key(path)));
    const newRoots = new Set(after.getRootFileNames().map((path) => this.vfs.key(path)));
    if ([...oldRoots, ...newRoots].some((path) => oldRoots.has(path) !== newRoots.has(path) && !changed.has(path)))
      return;
    if (changes.some((change) => configName.test(basename2(change.path))))
      return;
    for (const change of changes.filter((change2) => basename2(change2.path) === "package.json")) {
      if (change.before === null || change.after === null)
        return;
      const withoutExports = (text) => {
        try {
          const { exports: _exports, ...rest } = JSON.parse(text ?? "{}");
          return rest;
        } catch {
          return;
        }
      };
      const oldShape = withoutExports(change.before), newShape = withoutExports(change.after);
      if (oldShape === undefined || newShape === undefined || !sameValue(oldShape, newShape))
        return;
    }
    const importers = new Map;
    const pending = [...changed];
    for (const graph of [oldGraph, newGraph])
      for (const [file, dependencies] of graph) {
        for (const target of dependencies) {
          if (!target)
            continue;
          const callers = importers.get(target) ?? new Set;
          callers.add(file);
          importers.set(target, callers);
        }
      }
    for (const file of new Set([...oldGraph.keys(), ...newGraph.keys()])) {
      if (!sameValue(oldGraph.get(file), newGraph.get(file)))
        pending.push(file);
    }
    const oldFiles = new Set(before.getSourceFiles().map((source) => this.vfs.key(source.fileName)));
    const newFiles = new Set(after.getSourceFiles().map((source) => this.vfs.key(source.fileName)));
    for (const program of [before, after])
      for (const source of program.getSourceFiles()) {
        const key = this.vfs.key(source.fileName);
        if (!changed.has(key) && oldFiles.has(key) === newFiles.has(key))
          continue;
        if (!/\.json$/i.test(source.fileName) && (changed.has(key) && source.isDeclarationFile || !ts3.isExternalModule(source) || hasAmbientEffect(source)))
          return;
      }
    const closure = new Set;
    while (pending.length) {
      const file = pending.pop();
      if (closure.has(file))
        continue;
      closure.add(file);
      pending.push(...importers.get(file) ?? []);
    }
    return new Set([...closure].filter((file) => oldGraph.has(file) || newGraph.has(file)));
  }
  diagnostics(programs, only, baseline = false) {
    const vfs = this.vfs;
    vfs.clearGenerated();
    this.layouts = new Map;
    const referenced = new Set([...this.participants.values()].flatMap((item) => item.references.map((path) => vfs.key(path))));
    const merged = new Map;
    for (const key of this.order.filter((key2) => !programs || programs.has(key2))) {
      const item = this.participants.get(key);
      const program = programs?.get(key) ?? ts3.createProgram({
        rootNames: item.parsed.fileNames,
        options: item.parsed.options,
        projectReferences: item.parsed.projectReferences,
        host: this.compilerHost(item.configPath, item.parsed.options)
      });
      const collect = () => {
        const records2 = [];
        const add = (diagnostic) => {
          if (diagnostic.category !== ts3.DiagnosticCategory.Error)
            return;
          const record = {
            file: diagnostic.file ? resolve3(diagnostic.file.fileName) : item.configPath,
            code: `TS${diagnostic.code}`,
            message: flatten(diagnostic)
          };
          records2.push(record);
        };
        program.getOptionsDiagnostics().forEach(add);
        program.getGlobalDiagnostics().forEach(add);
        for (const sourceFile of program.getSourceFiles()) {
          const path = resolve3(sourceFile.fileName);
          if (!isInside(this.root, path)) {
            if (!sourceFile.isDeclarationFile)
              fail("PROJECT_SCOPE_INCOMPLETE", `${item.configPath} uses user source outside ${this.root}: ${path}${workspaceRootHint(this.root, [path])}`);
            continue;
          }
          if (portablePath(path).split("/").includes("node_modules") || vfs.isHidden(path))
            continue;
          if (only?.has(key) && !only.get(key).has(vfs.key(path)))
            continue;
          program.getSyntacticDiagnostics(sourceFile).forEach(add);
          program.getSemanticDiagnostics(sourceFile).forEach(add);
          if (program.getCompilerOptions().declaration || program.getCompilerOptions().composite)
            program.getDeclarationDiagnostics(sourceFile).forEach(add);
        }
        return records2;
      };
      const records = baseline && !referenced.size ? baselineDiagnostics(this.root, item.configPath, program, only?.get(key), vfs.inputs, collect) : collect();
      const counts = new Map;
      for (const record of records) {
        const recordKey = `${record.file}\x00${record.code}\x00${record.message}`;
        const entry = counts.get(recordKey) ?? { record, count: 0 };
        entry.count += 1;
        counts.set(recordKey, entry);
      }
      for (const [recordKey, entry] of counts) {
        if ((merged.get(recordKey)?.count ?? 0) < entry.count)
          merged.set(recordKey, entry);
      }
      const layout = this.computedOutputRoot(item, program);
      if (layout !== undefined)
        this.layouts.set(key, layout);
      if (referenced.has(key)) {
        program.emit(undefined, (fileName, text) => {
          if (isDeclarationPath(fileName))
            vfs.writeGenerated(fileName, text);
        }, undefined, true);
      }
    }
    return [...merged.values()].flatMap(({ record, count }) => Array.from({ length: count }, () => record)).sort((a, b) => a.file.localeCompare(b.file) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
  }
  computedOutputRoot(item, program) {
    const options = item.parsed.options;
    if (options.noEmit || options.rootDir || options.composite || !options.outDir && !options.declarationDir)
      return;
    const directories = program.getSourceFiles().filter((sourceFile) => !sourceFile.isDeclarationFile && !program.isSourceFileFromExternalLibrary(sourceFile)).filter((sourceFile) => !(options.noEmitForJsFiles && /\.[cm]?jsx?$/i.test(sourceFile.fileName))).filter((sourceFile) => !/\.json$/i.test(sourceFile.fileName) || options.outDir).map((sourceFile) => portablePath(dirname4(resolve3(sourceFile.fileName))).split("/"));
    if (!directories.length)
      return;
    let common = directories[0];
    for (const parts of directories.slice(1)) {
      let length = 0;
      while (length < common.length && length < parts.length && (this.vfs.caseSensitive ? common[length] === parts[length] : common[length].toLowerCase() === parts[length].toLowerCase()))
        length += 1;
      common = common.slice(0, length);
    }
    return common.length === 1 && /^[A-Za-z]:$/.test(common[0]) ? `${common[0]}/` : common.join("/") || "/";
  }
  updateConfigLists(renames, deletions, substitutions = new Map) {
    const vfs = this.vfs;
    for (const item of [...this.participants.values()].sort((a, b) => a.configPath.localeCompare(b.configPath))) {
      const configRenames = [...substitutions.get(vfs.key(item.configPath)) ?? [], ...renames];
      const text = vfs.readFile(item.configPath);
      if (text === undefined)
        continue;
      const json = ts3.parseJsonText(item.configPath, text);
      const object = json.statements[0]?.expression;
      if (!object || !ts3.isObjectLiteralExpression(object))
        continue;
      const directory = dirname4(item.configPath);
      const changes = [];
      for (const property of object.properties) {
        if (!ts3.isPropertyAssignment(property) || !ts3.isStringLiteral(property.name))
          continue;
        if (!["files", "include"].includes(property.name.text) || !ts3.isArrayLiteralExpression(property.initializer))
          continue;
        const elements = property.initializer.elements;
        const removed = new Set;
        elements.forEach((element, index) => {
          if (!ts3.isStringLiteral(element) || /[*?]/.test(element.text))
            return;
          const absolute = resolve3(directory, element.text);
          const start = element.getStart(json);
          const rename = configRenames.find(([from]) => vfs.samePath(from, absolute));
          if (rename) {
            const relativePath = portablePath(relative3(directory, rename[1]));
            const spec = element.text.startsWith("./") && !relativePath.startsWith("../") ? `./${relativePath}` : relativePath;
            const quote = text[start];
            changes.push({ span: { start, length: element.end - start }, newText: `${quote}${JSON.stringify(spec).slice(1, -1)}${quote}` });
          } else if (deletions.some((path) => vfs.samePath(path, absolute))) {
            removed.add(index);
          }
        });
        for (let index = 0;index < elements.length; index++) {
          if (!removed.has(index))
            continue;
          const first = index;
          while (removed.has(index + 1))
            index += 1;
          const all = first === 0 && index === elements.length - 1;
          const start = all ? property.initializer.getStart(json) + 1 : first === 0 ? elements[first].getStart(json) : elements[first - 1].end;
          const end = all ? property.initializer.end - 1 : first === 0 ? elements[index + 1].getStart(json) : elements[index].end;
          changes.push({ span: { start, length: end - start }, newText: "" });
        }
      }
      if (changes.length)
        vfs.write(item.configPath, applyTextChanges(text, changes));
    }
  }
  addToFiles(configPath, path) {
    const text = this.vfs.readFile(configPath);
    const json = ts3.parseJsonText(configPath, text);
    const object = json.statements[0]?.expression;
    if (!object || !ts3.isObjectLiteralExpression(object))
      return false;
    const files = object.properties.find((property) => ts3.isPropertyAssignment(property) && ts3.isStringLiteral(property.name) && property.name.text === "files");
    if (!files || !ts3.isArrayLiteralExpression(files.initializer))
      return false;
    const elements = files.initializer.elements;
    const relativePath = portablePath(relative3(dirname4(configPath), path));
    const dotted = elements.some((element) => ts3.isStringLiteral(element) && element.text.startsWith("./"));
    const literal = JSON.stringify(dotted && !relativePath.startsWith("../") ? `./${relativePath}` : relativePath);
    let change;
    if (elements.length) {
      const last = elements[elements.length - 1];
      const lastStart = last.getStart(json);
      const lineStart = text.lastIndexOf(`
`, lastStart) + 1;
      const multiline = text.slice(elements[0].getStart(json), lastStart).includes(`
`) || text.slice(files.initializer.getStart(json), elements[0].getStart(json)).includes(`
`);
      const indent = text.slice(lineStart, lastStart);
      const separator = multiline && /^\s*$/.test(indent) ? `,${text.includes(`\r
`) ? `\r
` : `
`}${indent}` : ", ";
      change = { span: { start: last.end, length: 0 }, newText: `${separator}${literal}` };
    } else {
      change = { span: { start: files.initializer.getStart(json) + 1, length: 0 }, newText: literal };
    }
    this.vfs.write(configPath, applyTextChanges(text, [change]));
    return true;
  }
}
function applyTextChanges(text, changes) {
  const ordered = changes.map((change, index) => ({ change, index })).sort((a, b) => b.change.span.start - a.change.span.start || b.index - a.index).map(({ change }) => change);
  let boundary = text.length;
  for (const change of ordered) {
    const end = change.span.start + change.span.length;
    if (change.span.start < 0 || end > text.length)
      fail("INVALID_EDIT", "TypeScript returned an out-of-bounds edit");
    if (end > boundary)
      fail("OVERLAPPING_EDITS", "TypeScript returned overlapping edits");
    text = text.slice(0, change.span.start) + change.newText + text.slice(end);
    boundary = change.span.start;
  }
  return text;
}
var baseFormatOptions, configName, editorConfigName, sharedOptionKeys, mockObjects, mockMethods;
var init_typescript_workspace = __esm(() => {
  init_typescript_diagnostics_cache();
  init_typescript_vfs();
  init_typescript_paths();
  baseFormatOptions = {
    indentSize: 2,
    tabSize: 2,
    newLineCharacter: `
`,
    convertTabsToSpaces: true,
    indentStyle: ts3.IndentStyle.Smart,
    insertSpaceAfterCommaDelimiter: true,
    insertSpaceAfterSemicolonInForStatements: true,
    insertSpaceBeforeAndAfterBinaryOperators: true,
    insertSpaceAfterKeywordsInControlFlowStatements: true,
    insertSpaceAfterFunctionKeywordForAnonymousFunctions: false,
    insertSpaceBeforeFunctionParenthesis: false,
    insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
    semicolons: ts3.SemicolonPreference.Insert
  };
  configName = /^(tsconfig|jsconfig)(\..+)?\.json$/;
  editorConfigName = /^(tsconfig|jsconfig)\.json$/;
  sharedOptionKeys = [
    "module",
    "moduleResolution",
    "moduleDetection",
    "allowJs",
    "jsx",
    "jsxImportSource",
    "esModuleInterop",
    "allowSyntheticDefaultImports",
    "resolveJsonModule",
    "rewriteRelativeImportExtensions",
    "allowArbitraryExtensions",
    "verbatimModuleSyntax",
    "preserveSymlinks",
    "experimentalDecorators",
    "typeRoots"
  ];
  mockObjects = new Set(["vi", "vitest", "jest"]);
  mockMethods = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock", "requireActual", "requireMock", "createMockFromModule"]);
});

// src/backends/typescript-prechecks.ts
import ts4 from "typescript";
import { existsSync as existsSync3 } from "node:fs";
import { dirname as dirname5, resolve as resolve4 } from "node:path";
import { builtinModules } from "node:module";
function parseConfig(config) {
  const parsed = ts4.getParsedCommandLineOfConfigFile(config, {}, {
    ...ts4.sys,
    onUnRecoverableConfigFileDiagnostic: (error) => fail("INVALID_CONFIG", ts4.flattenDiagnosticMessageText(error.messageText, `
`))
  });
  if (!parsed || parsed.errors.length)
    fail("INVALID_CONFIG", `${config}: ${parsed?.errors.map((error) => ts4.flattenDiagnosticMessageText(error.messageText, `
`)).join("; ") ?? "cannot parse"}`);
  return parsed;
}
function checkSharedOptions(first, second, source, target) {
  for (const option of sharedOptionKeys) {
    if (JSON.stringify(first[option]) !== JSON.stringify(second[option])) {
      fail("PROJECT_OPTIONS_INCOMPATIBLE", `${target} and ${source} differ in compiler option '${option}'; use projects with compatible syntax and emit settings`);
    }
  }
}
function packageAt(root, file) {
  for (let directory = dirname5(file);isInside(root, directory); directory = dirname5(directory)) {
    const path = resolve4(directory, "package.json");
    const text = ts4.sys.readFile(path);
    if (text !== undefined) {
      try {
        return { path, directory, json: JSON.parse(text) };
      } catch {
        fail("INVALID_PACKAGE", path);
      }
    }
    if (directory === root)
      break;
  }
  return;
}
function installationHint(root, file) {
  const pkg = packageAt(root, file);
  if (!pkg || existsSync3(resolve4(pkg.directory, "node_modules")))
    return "";
  return `; ${pkg.directory}/node_modules is missing; run the workspace package manager install from ${root}`;
}
function precheckMove(root, sourceConfig, targetConfig, renames) {
  const source = parseConfig(sourceConfig), target = sourceConfig === targetConfig ? source : parseConfig(targetConfig);
  checkSharedOptions(source.options, target.options, sourceConfig, targetConfig);
  const moved = new Set(renames.map(([from]) => from));
  const blockers = [];
  for (const [from, to] of renames) {
    if (!/\.[cm]?[jt]sx?$/.test(from))
      continue;
    const text = ts4.sys.readFile(from);
    if (text === undefined)
      fail("FILE_NOT_FOUND", from);
    const file = ts4.createSourceFile(from, text, ts4.ScriptTarget.Latest, true);
    file.impliedNodeFormat = ts4.getImpliedNodeFormatForFile(from, undefined, ts4.sys, source.options);
    const sourcePackage = packageAt(root, from), destination = packageAt(root, to);
    const specifiers = moduleSpecifiers(file);
    const relocated = ts4.createSourceFile(to, text, ts4.ScriptTarget.Latest, true);
    relocated.impliedNodeFormat = ts4.getImpliedNodeFormatForFile(to, undefined, ts4.sys, target.options);
    const targetSpecifiers = moduleSpecifiers(relocated);
    for (const [index, specifier] of specifiers.entries()) {
      const name = specifier.text;
      const mode = ts4.getModeForUsageLocation(file, specifier, source.options);
      const original = ts4.resolveModuleName(name, from, source.options, ts4.sys, undefined, undefined, mode).resolvedModule;
      if (original && moved.has(resolve4(original.resolvedFileName)))
        continue;
      if (name.startsWith(".") || builtins.has(name) || destination?.json.name && (name === destination.json.name || name.startsWith(`${destination.json.name}/`)))
        continue;
      const alias = Object.keys(source.options.paths ?? {}).some((pattern) => {
        const [prefix, suffix] = pattern.split("*");
        return pattern.includes("*") ? name.startsWith(prefix) && name.endsWith(suffix) : name === pattern;
      });
      const targetMode = ts4.getModeForUsageLocation(relocated, targetSpecifiers[index], target.options);
      if (alias) {
        if (original && !ts4.resolveModuleName(name, to, target.options, ts4.sys, undefined, undefined, targetMode).resolvedModule) {
          blockers.push(`MOVE_IMPORT_UNRESOLVED: ${from}: '${name}' cannot resolve from ${to}; unresolved source-project alias imports: ${name}; move its dependency too or retarget the alias before moving${installationHint(root, to)}`);
        }
        continue;
      }
      if (!destination || !sourcePackage || destination.path === sourcePackage.path)
        continue;
      const packageName = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
      const version = versionOf(sourcePackage.json, packageName);
      if ((version || original?.isExternalLibraryImport) && !name.startsWith("#") && !versionOf(destination.json, packageName)) {
        const hint = version ? `add ${packageName}@${version} to ${destination.path}` : `add '${packageName}' to ${destination.path}`;
        blockers.push(`MISSING_DEPENDENCY: ${destination.path} must declare '${packageName}' (source version ${version ?? "not declared"}); ${hint} and install before moving ${from}${installationHint(root, to)}`);
        continue;
      }
      if (!ts4.resolveModuleName(name, to, target.options, ts4.sys, undefined, undefined, targetMode).resolvedModule) {
        if (original?.isExternalLibraryImport)
          blockers.push(`MOVE_IMPORT_UNRESOLVED: '${name}' cannot resolve from ${to}; install the destination dependencies or fix its package exports${installationHint(root, to)}`);
      }
    }
  }
  if (blockers.length)
    throw new Error([...new Set(blockers)].sort((a, b) => Number(b.startsWith("MOVE_IMPORT_UNRESOLVED")) - Number(a.startsWith("MOVE_IMPORT_UNRESOLVED"))).join("; "));
}
var builtins, dependencyFields, versionOf = (json, name) => dependencyFields.map((field) => json[field]?.[name]).find((value) => typeof value === "string");
var init_typescript_prechecks = __esm(() => {
  init_typescript_workspace();
  init_typescript_vfs();
  builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
  dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
});

// src/backends/typescript-inline-reexports.ts
import ts5 from "typescript";
import { dirname as dirname6, extname as extname2, relative as relative4, resolve as resolve5, sep as sep3 } from "node:path";

class Origins {
  ws;
  checker;
  constructor(ws) {
    this.ws = ws;
    this.checker = ws.program().getTypeChecker();
  }
  exports(source) {
    const symbol = this.checker.getSymbolAtLocation(source);
    return symbol ? this.checker.getExportsOfModule(symbol) : [];
  }
  actual(symbol) {
    return symbol.flags & ts5.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
  }
  exported(source, name) {
    const symbol = this.exports(source).find((item) => item.name === name);
    if (!symbol)
      fail("REEXPORT_UNRESOLVED", `${source.fileName} has no resolved export '${name}'`);
    return symbol;
  }
  module(source, specifier) {
    const symbol = this.checker.getSymbolAtLocation(specifier);
    const target = symbol?.declarations?.find(ts5.isSourceFile);
    if (!target)
      fail("REEXPORT_UNRESOLVED", `${specifier.text} in ${source.fileName} has no resolved module`);
    return target;
  }
  find(source, name, seen = new Set) {
    const key = `${source.fileName}\x00${name}`;
    if (seen.has(key))
      fail("REEXPORT_CYCLE", `cyclic re-export of '${name}' in ${source.fileName}`);
    const visited = new Set([...seen, key]);
    const symbol = this.exported(source, name);
    const declarations = source.statements.filter(ts5.isExportDeclaration);
    const explicit = declarations.find((item) => item.exportClause && ts5.isNamedExports(item.exportClause) && item.exportClause.elements.some((element) => element.name.text === name));
    if (explicit) {
      if (explicit.attributes)
        fail("REEXPORT_UNSUPPORTED", `re-export attributes in ${source.fileName}`);
      const element = explicit.exportClause.elements.find((item) => item.name.text === name);
      if (!explicit.moduleSpecifier)
        return this.localOrigin(element, visited, explicit.isTypeOnly || element.isTypeOnly);
      if (!ts5.isStringLiteralLike(explicit.moduleSpecifier))
        return;
      return this.follow(source, explicit.moduleSpecifier, (element.propertyName ?? element.name).text, explicit.isTypeOnly || element.isTypeOnly, visited);
    }
    if (this.actual(symbol).declarations?.some((item) => item.getSourceFile() === source))
      return;
    for (const statement of declarations) {
      if (statement.exportClause || !statement.moduleSpecifier || !ts5.isStringLiteralLike(statement.moduleSpecifier) || name === "default")
        continue;
      const target = this.module(source, statement.moduleSpecifier);
      const candidate = this.exports(target).find((item) => item.name === name);
      if (candidate && this.actual(candidate) === this.actual(symbol)) {
        if (statement.attributes)
          fail("REEXPORT_UNSUPPORTED", `re-export attributes in ${source.fileName}`);
        return this.follow(source, statement.moduleSpecifier, name, statement.isTypeOnly, visited);
      }
    }
    return;
  }
  packageBoundary(source, target) {
    const owner = (file) => {
      for (let directory = dirname6(file);isInside(this.ws.root, directory); directory = dirname6(directory)) {
        const text = this.ws.vfs.readFile(resolve5(directory, "package.json"));
        if (text) {
          try {
            return { directory, manifest: JSON.parse(text) };
          } catch {
            fail("INVALID_PACKAGE", `cannot parse ${directory}/package.json`);
          }
        }
        if (directory === dirname6(directory))
          break;
      }
      return;
    };
    const destination = owner(target.fileName);
    if (!destination?.manifest.name || owner(source.fileName)?.directory === destination.directory)
      return false;
    const values = (value) => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(values) : [];
    const entries = destination.manifest.exports !== undefined ? values(destination.manifest.exports) : [destination.manifest.types, destination.manifest.typings, destination.manifest.main, "./index.ts", "./index.js"].flatMap(values);
    const stem = (path) => path.replace(/(?:\.d)?\.[cm]?[jt]sx?$/, "");
    return entries.some((entry) => {
      const parts = stem(resolve5(destination.directory, entry)).split("*");
      const path = stem(target.fileName);
      return parts.length === 1 ? this.ws.vfs.samePath(parts[0], path) : parts.length === 2 && this.ws.vfs.key(path).startsWith(this.ws.vfs.key(parts[0])) && path.endsWith(parts[1]);
    });
  }
  localOrigin(element, seen, typeOnly) {
    const local = this.checker.getExportSpecifierLocalTargetSymbol(element);
    const declaration = local?.declarations?.[0];
    if (!declaration || !ts5.isImportSpecifier(declaration) && !ts5.isImportClause(declaration))
      return;
    const clause = ts5.isImportSpecifier(declaration) ? declaration.parent.parent : declaration;
    const statement = clause.parent;
    if (!ts5.isImportDeclaration(statement) || !ts5.isStringLiteralLike(statement.moduleSpecifier))
      return;
    if (statement.attributes)
      fail("REEXPORT_UNSUPPORTED", `import attributes in ${element.getSourceFile().fileName}`);
    const name = ts5.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : "default";
    return this.follow(element.getSourceFile(), statement.moduleSpecifier, name, typeOnly || clause.isTypeOnly || ts5.isImportSpecifier(declaration) && declaration.isTypeOnly, seen);
  }
  follow(source, specifier, name, typeOnly, seen) {
    const target = this.module(source, specifier);
    this.exported(target, name);
    const next = isRelative(specifier.text) && !this.packageBoundary(source, target) ? this.find(target, name, seen) : undefined;
    return next ? { ...next, typeOnly: typeOnly || next.typeOnly } : { specifier, target, name, typeOnly };
  }
}
function isRelative(specifier) {
  return /^\.\.?\//.test(specifier);
}
function originSpecifier(origin, importer) {
  const original = origin.specifier.text;
  if (!isRelative(original))
    return original;
  const written = original.match(/(?:\.d)?\.[cm]?[jt]sx?$/)?.[0] ?? "";
  const extension = origin.target.fileName.match(/(?:\.d)?\.[cm]?[jt]sx?$/)?.[0] ?? extname2(origin.target.fileName);
  const runtime = { ".ts": ".js", ".tsx": ".js", ".mts": ".mjs", ".cts": ".cjs" };
  const suffix = written === extension ? extension : [".js", ".jsx", ".mjs", ".cjs"].includes(written) ? written === ".jsx" && extension === ".tsx" ? ".jsx" : runtime[extension.replace(/^\.d/, "")] ?? extension : "";
  const target = origin.target.fileName.slice(0, -extension.length) + suffix;
  const path = portablePath(relative4(dirname6(importer.fileName), target));
  return path.startsWith(".") ? path : `./${path}`;
}
function literal(text, quote) {
  const escaped = JSON.stringify(text).slice(1, -1);
  return `${quote}${quote === "'" ? escaped.replace(/'/g, "\\'") : escaped}${quote}`;
}
function bindingName(name) {
  return /^[$\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(name) ? name : JSON.stringify(name);
}
function resolveAs(ws, text, source, usage) {
  const mode = ts5.getModeForUsageLocation(source, usage, ws.editOptions);
  return ts5.resolveModuleName(text, source.fileName, ws.editOptions, ws.vfs.moduleResolutionHost(), undefined, undefined, mode).resolvedModule;
}
function groupsFor(origins, shim, importer, specifier, bindings) {
  const groups = new Map;
  for (const binding of bindings) {
    const origin = origins.find(shim, binding.imported);
    const direct = origin ? originSpecifier(origin, importer) : specifier.text;
    if (origin) {
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
function renderGroup(group, exporting, typeOnly, quote, suffix) {
  const defaults = exporting ? [] : group.bindings.filter((item) => item.defaultImport && item.imported === "default");
  const named = group.bindings.filter((item) => !defaults.includes(item));
  const allType = typeOnly;
  if (!typeOnly && defaults.some((item) => item.typeOnly)) {
    const typed = defaults.filter((item) => item.typeOnly);
    const remaining = group.bindings.filter((item) => !typed.includes(item));
    return [
      renderGroup({ ...group, bindings: typed }, false, true, quote, suffix),
      ...remaining.length ? [renderGroup({ ...group, bindings: remaining }, false, false, quote, suffix)] : []
    ].join(`
`);
  }
  const names = named.map((item) => `${!allType && item.typeOnly ? "type " : ""}${bindingName(item.imported)}${item.imported === item.local ? "" : ` as ${bindingName(item.local)}`}`);
  if (allType && defaults.length && named.length) {
    return [
      renderGroup({ ...group, bindings: defaults }, exporting, true, quote, suffix),
      renderGroup({ ...group, bindings: named }, exporting, true, quote, suffix)
    ].join(`
`);
  }
  const clause = [...defaults.map((item) => item.local), ...names.length ? [`{ ${names.join(", ")} }`] : []].join(", ");
  return `${exporting ? "export" : "import"} ${allType ? "type " : ""}${clause} from ${literal(group.specifier, quote)}${suffix}`;
}
function pureShim(source) {
  return source.statements.some(ts5.isExportDeclaration) && source.statements.every((item) => ts5.isExportDeclaration(item) && !!item.moduleSpecifier || ts5.isExpressionStatement(item) && ts5.isStringLiteral(item.expression));
}
function singleStar(source) {
  const exports = source.statements.filter(ts5.isExportDeclaration);
  return pureShim(source) && exports.length === 1 && !exports[0].exportClause && !exports[0].isTypeOnly ? exports[0] : undefined;
}
function retargetNamespace(origins, shim, source, specifier) {
  const star = singleStar(shim);
  if (!star || !star.moduleSpecifier || !ts5.isStringLiteralLike(star.moduleSpecifier)) {
    fail("NAMESPACE_IMPORT_UNSUPPORTED", `${source.fileName} imports a namespace from ${shim.fileName}; only pure single-origin export * shims support this`);
  }
  if (star.attributes)
    fail("REEXPORT_UNSUPPORTED", `re-export attributes in ${shim.fileName}`);
  const target = origins.module(shim, star.moduleSpecifier);
  if (origins.exports(target).some((item) => item.name === "default"))
    fail("NAMESPACE_IMPORT_UNSUPPORTED", "origin exports default, which export * excludes");
  const origin = { specifier: star.moduleSpecifier, target, name: "", typeOnly: false };
  const direct = originSpecifier(origin, source);
  const resolved = resolveAs(origins.ws, direct, source, specifier);
  if (!resolved || !origins.ws.vfs.samePath(resolved.resolvedFileName, target.fileName))
    fail("REEXPORT_RESOLUTION_CHANGED", direct);
  const start = specifier.getStart(source);
  return { span: { start, length: specifier.end - start }, newText: literal(direct, source.text[start]) };
}
function rewrite(origins, shim, source, notes) {
  const changes = [];
  for (const statement of source.statements) {
    if (!ts5.isImportDeclaration(statement) && !ts5.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts5.isStringLiteralLike(statement.moduleSpecifier))
      continue;
    const specifier = statement.moduleSpecifier;
    const resolved = origins.ws.resolveModule(specifier, source);
    if (!resolved || !origins.ws.vfs.samePath(resolved.resolvedFileName, shim.fileName))
      continue;
    const exporting = ts5.isExportDeclaration(statement);
    const clause = exporting ? statement.exportClause : statement.importClause;
    if (!exporting && !clause) {
      notes.push(`Kept side-effect import of ${shim.fileName} in ${source.fileName}.`);
      continue;
    }
    if (statement.attributes)
      fail("REEXPORT_UNSUPPORTED", `import/export attributes in ${source.fileName}`);
    if (!exporting && statement.importClause?.namedBindings && ts5.isNamespaceImport(statement.importClause.namedBindings) || exporting && statement.exportClause && ts5.isNamespaceExport(statement.exportClause)) {
      changes.push(retargetNamespace(origins, shim, source, specifier));
      continue;
    }
    const typeOnly = exporting ? statement.isTypeOnly : statement.importClause.isTypeOnly;
    const bindings = [];
    if (!exporting && statement.importClause.name)
      bindings.push({ imported: "default", local: statement.importClause.name.text, typeOnly, defaultImport: true });
    const named = exporting ? statement.exportClause : statement.importClause.namedBindings;
    if (named && (ts5.isNamedExports(named) || ts5.isNamedImports(named))) {
      for (const item of named.elements)
        bindings.push({ imported: (item.propertyName ?? item.name).text, local: item.name.text, typeOnly: typeOnly || item.isTypeOnly });
    } else if (exporting && !named) {
      for (const symbol of origins.exports(shim))
        if (symbol.name !== "default")
          bindings.push({ imported: symbol.name, local: symbol.name, typeOnly: typeOnly || !(origins.actual(symbol).flags & ts5.SymbolFlags.Value) });
    }
    if (!bindings.length)
      continue;
    const groups = groupsFor(origins, shim, source, specifier, bindings);
    if (groups.length === 1 && groups[0].specifier === specifier.text)
      continue;
    const start = statement.getStart(source);
    const quote = source.text[specifier.getStart(source)];
    const suffix = source.text.slice(specifier.end, statement.end);
    const output = groups.map((group) => renderGroup(group, exporting, typeOnly, quote, suffix)).join(`
`).replace(/\n/g, eolOf(source.text));
    changes.push({ span: { start, length: statement.end - start }, newText: output });
  }
  return changes;
}
function inlineReexports(ws, file, source, notes, keep = false) {
  if (file.split(sep3).includes("node_modules") || ws.vfs.isHidden(file))
    fail("OUTSIDE_PROJECT", `cannot inline a dependency or build output: ${file}`);
  const origins = new Origins(ws);
  const files = ws.program().getSourceFiles().filter((item) => isInside(ws.root, resolve5(item.fileName)) && !item.fileName.split(sep3).includes("node_modules") && !ws.vfs.isHidden(item.fileName));
  const edits = files.filter((item) => !ws.vfs.samePath(item.fileName, file)).map((item) => ({ source: item, changes: rewrite(origins, source, item, notes) }));
  for (const edit of edits)
    if (edit.changes.length)
      ws.vfs.write(edit.source.fileName, applyTextChanges(edit.source.text, edit.changes));
  const remaining = ws.program().getSourceFiles().filter((item) => isInside(ws.root, resolve5(item.fileName)) && !item.fileName.split(sep3).includes("node_modules") && !ws.vfs.isHidden(item.fileName)).some((item) => moduleSpecifiers(item).some((specifier) => {
    const target = ws.resolveModule(specifier, item);
    return target && ws.vfs.samePath(target.resolvedFileName, file);
  }) || item.referencedFiles.some((reference) => ws.vfs.samePath(resolve5(dirname6(item.fileName), reference.fileName), file)));
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
var init_typescript_inline_reexports = __esm(() => {
  init_typescript_paths();
  init_typescript_vfs();
  init_typescript_workspace();
});

// src/backends/typescript-package-specifiers.ts
import ts6 from "typescript";
import { dirname as dirname7, extname as extname3, relative as relative5, resolve as resolve6 } from "node:path";
function packageFor(ws, file) {
  for (let directory = dirname7(file);isInside(ws.root, directory); directory = dirname7(directory)) {
    const path = resolve6(directory, "package.json");
    const text = ws.vfs.readFile(path);
    if (text !== undefined) {
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        fail("INVALID_PACKAGE", path);
      }
      if (typeof json.name === "string" && json.name)
        return { path, directory, name: json.name, json };
    }
    if (ws.vfs.samePath(directory, ws.root))
      break;
  }
  return;
}
function packageSelfImport(ws, importer, target, specifier) {
  const pkg = packageFor(ws, importer);
  return !!pkg && (specifier === pkg.name || specifier.startsWith(`${pkg.name}/`)) && packageFor(ws, target)?.path === pkg.path;
}
function strings(value) {
  if (typeof value === "string")
    return [value];
  if (Array.isArray(value))
    return value.flatMap(strings);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(strings);
  return [];
}
function exportedPaths(pkg, target) {
  const exports = pkg.json.exports;
  const entries = exports && typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith(".")) ? Object.entries(exports) : [[".", exports]];
  const candidates = [];
  const path = `./${portablePath(relative5(pkg.directory, target))}`;
  for (const [key, value] of entries) {
    if (key !== "." && !key.startsWith("./"))
      continue;
    for (const pattern of strings(value)) {
      if (!pattern.startsWith("./"))
        continue;
      if (!pattern.includes("*") && pattern === path && !key.includes("*"))
        candidates.push(key);
      else if (pattern.split("*").length === 2 && key.split("*").length === 2) {
        const [prefix, suffix] = pattern.split("*");
        if (path.startsWith(prefix) && path.endsWith(suffix) && path.length >= prefix.length + suffix.length) {
          candidates.push(key.replace("*", path.slice(prefix.length, path.length - suffix.length)));
        }
      }
    }
  }
  return [...new Set(candidates)].sort((a, b) => a.length - b.length || a.localeCompare(b));
}
function addExport(ws, pkg, target) {
  const text = ws.vfs.readFile(pkg.path);
  const json = ts6.parseJsonText(pkg.path, text);
  const object = json.statements[0]?.expression;
  if (!object || !ts6.isObjectLiteralExpression(object))
    fail("INVALID_PACKAGE", pkg.path);
  const property = object.properties.find((item) => ts6.isPropertyAssignment(item) && ts6.isStringLiteral(item.name) && item.name.text === "exports");
  if (!property)
    fail("PACKAGE_EXPORTS_REQUIRED", `${pkg.path} has no exports field; declare the package's public surface before moving files into it`);
  if (!ts6.isObjectLiteralExpression(property.initializer) || property.initializer.properties.some((item) => !ts6.isPropertyAssignment(item) || !ts6.isStringLiteral(item.name) || !item.name.text.startsWith("."))) {
    fail("PACKAGE_EXPORTS_UNSUPPORTED", `${pkg.path}: automatic exports require an object of subpath entries`);
  }
  const path = portablePath(relative5(pkg.directory, target));
  if (path.startsWith("../"))
    fail("PACKAGE_EXPORTS_UNSUPPORTED", target);
  const subpath = path.replace(/^src\//, "").slice(0, -extname3(path).length).replace(/(^|\/)index$/, "");
  const key = subpath ? `./${subpath}` : ".";
  const entries = property.initializer.properties;
  if (entries.some((item) => ts6.isPropertyAssignment(item) && ts6.isStringLiteral(item.name) && item.name.text === key)) {
    fail("PACKAGE_EXPORT_CONFLICT", `${pkg.path}: ${key} already names another target`);
  }
  const literal2 = `${JSON.stringify(key)}: ${JSON.stringify(`./${path}`)}`;
  const last = entries[entries.length - 1];
  const multiline = text.slice(property.initializer.getStart(json), property.initializer.end).includes(`
`);
  const indentAt = (position) => text.slice(text.lastIndexOf(`
`, position) + 1, position).match(/^[\t ]*/)?.[0] ?? "";
  const indent = last ? indentAt(last.getStart(json)) : indentAt(property.getStart(json)) + (text.match(/\n([\t ]+)"/)?.[1] ?? "  ");
  const start = last?.end ?? property.initializer.getStart(json) + 1;
  const tail = text.slice(start, property.initializer.end - 1);
  const comma = tail.indexOf(",");
  const changes = [];
  if (last && comma >= 0) {
    changes.push({ span: { start: start + comma + 1, length: 0 }, newText: `${multiline ? eolOf(text) + indent : " "}${literal2},` });
  } else {
    changes.push({ span: { start, length: 0 }, newText: `${last ? "," : ""}${multiline ? eolOf(text) + indent : last ? " " : ""}${literal2}` });
  }
  ws.vfs.write(pkg.path, applyTextChanges(text, changes));
  return key;
}
function packageSpecifier(ws, importer, target, mode) {
  const destination = packageFor(ws, target);
  const source = packageFor(ws, importer);
  if (!destination || source && ws.vfs.samePath(source.path, destination.path))
    return;
  if (!source)
    fail("MISSING_DEPENDENCY", `${importer} has no named package declaring ${destination.name}`);
  const declares = ["dependencies", "devDependencies", "peerDependencies"].some((field) => {
    const value = source.json[field];
    return value && typeof value === "object" && Object.hasOwn(value, destination.name);
  });
  if (!declares)
    fail("MISSING_DEPENDENCY", `${source.path} must declare ${destination.name} in dependencies, devDependencies or peerDependencies`);
  const paths = exportedPaths(destination, target);
  const nameFor = (key2) => destination.name + (key2 === "." ? "" : key2.slice(1));
  const owner = ws.ownersOf(importer)[0];
  const options = owner ? ws.participant(owner).parsed.options : ws.editOptions;
  const key = paths.find((key2) => {
    const resolved = ts6.resolveModuleName(nameFor(key2), importer, options, ws.vfs.moduleResolutionHost(), undefined, undefined, mode).resolvedModule;
    return resolved && ws.vfs.samePath(resolved.resolvedFileName, target);
  }) ?? paths[0] ?? addExport(ws, destination, target);
  return nameFor(key);
}
function relativeStyle(ws, target, fallback, cache = new Map) {
  const pkg = packageFor(ws, target);
  if (!pkg)
    return fallback.startsWith(".") ? fallback : "./module";
  const fallbackStyle = fallback.startsWith(".") ? fallback : "./module";
  if (cache.has(pkg.path))
    return cache.get(pkg.path) ?? fallbackStyle;
  let explicit = 0, implicit = 0;
  let sample = "./module";
  for (const file of ws.unionFiles()) {
    if (!isInside(pkg.directory, file) || packageFor(ws, file)?.path !== pkg.path)
      continue;
    const text = ws.vfs.readFile(file);
    if (text === undefined)
      continue;
    const source = ts6.createSourceFile(file, text, ts6.ScriptTarget.Latest, true);
    for (const specifier of moduleSpecifiers(source)) {
      if (!/^\.\.?\//.test(specifier.text))
        continue;
      if (/\.[cm]?[jt]sx?$/.test(specifier.text)) {
        explicit += 1;
        sample = specifier.text;
      } else
        implicit += 1;
    }
  }
  const style = !explicit && !implicit ? null : explicit > implicit ? sample : "./module";
  cache.set(pkg.path, style);
  return style ?? fallbackStyle;
}
var init_typescript_package_specifiers = __esm(() => {
  init_typescript_vfs();
  init_typescript_workspace();
  init_typescript_paths();
});

// src/backends/typescript-suppressions.ts
import { readdirSync as readdirSync3 } from "node:fs";
import { dirname as dirname8, relative as relative6, resolve as resolve7 } from "node:path";
function nearestLedger(ws, file) {
  for (let directory = dirname8(file);isInside(ws.root, directory); directory = dirname8(directory)) {
    const path = resolve7(directory, "eslint-suppressions.json");
    if (ws.vfs.fileExists(path))
      return path;
    if (ws.vfs.samePath(directory, ws.root))
      break;
  }
  return;
}
function newLedger(ws, file) {
  const directory = packageFor(ws, file)?.directory ?? dirname8(ws.targetConfig);
  let names;
  try {
    names = readdirSync3(directory);
  } catch {
    return;
  }
  return names.some((name) => /^eslint\.config\.[cm]?[jt]s$/.test(name) && ws.vfs.fileExists(resolve7(directory, name))) ? resolve7(directory, "eslint-suppressions.json") : undefined;
}
function record(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function readLedger(ws, path) {
  const text = ws.vfs.readFile(path);
  let entries = {};
  try {
    if (text !== undefined)
      entries = JSON.parse(text);
  } catch {
    fail("INVALID_SUPPRESSIONS", path);
  }
  if (!record(entries) || Object.values(entries).some((rules) => !record(rules) || Object.values(rules).some((rule) => !record(rule) || !Number.isSafeInteger(rule.count) || rule.count < 0))) {
    fail("INVALID_SUPPRESSIONS", `${path}: expected file entries containing rule counts`);
  }
  const keys = Object.keys(entries);
  const sorted = [...keys].sort();
  return { entries, sorted: keys.every((key, index) => key === sorted[index]) };
}
function moveSuppressions(ws, renames, notes) {
  const ledgers = new Map;
  const ledger = (path) => {
    if (!ledgers.has(path))
      ledgers.set(path, readLedger(ws, path));
    return ledgers.get(path);
  };
  const transfers = renames.flatMap(([from, to]) => {
    const source = nearestLedger(ws, from);
    if (!source)
      return [];
    const key = portablePath(relative6(dirname8(source), from));
    const entries = ledger(source).entries;
    if (!Object.hasOwn(entries, key))
      return [];
    const destination = nearestLedger(ws, to) ?? newLedger(ws, to);
    if (destination)
      ledger(destination);
    return [{ source, key, rules: entries[key], destination, to }];
  });
  for (const { source, key } of transfers)
    delete ledger(source).entries[key];
  for (const { source, key, rules, destination, to } of transfers) {
    const label = `${portablePath(relative6(ws.root, source))}:${key}`;
    if (!destination) {
      notes.push(`Dropped ESLint suppressions for ${label}; ${portablePath(relative6(ws.root, to))} has no destination ledger or package eslint.config.*; review suppressions.`);
      continue;
    }
    const targetKey = portablePath(relative6(dirname8(destination), to));
    const entries = ledger(destination).entries;
    if (!Object.hasOwn(entries, targetKey))
      Object.defineProperty(entries, targetKey, { value: {}, enumerable: true, configurable: true, writable: true });
    const target = entries[targetKey];
    for (const [rule, value] of Object.entries(rules)) {
      const count = (Object.hasOwn(target, rule) ? target[rule].count : 0) + value.count;
      if (!Number.isSafeInteger(count))
        fail("INVALID_SUPPRESSIONS", `${destination}: count overflow for ${rule}`);
      Object.defineProperty(target, rule, { value: { ...value, count }, enumerable: true, configurable: true, writable: true });
    }
    notes.push(`Moved ESLint suppressions ${label} -> ${portablePath(relative6(ws.root, destination))}:${targetKey}.`);
  }
  const changed = new Set(transfers.flatMap((item) => [item.source, ...item.destination ? [item.destination] : []]));
  for (const path of changed) {
    const { entries, sorted } = ledger(path);
    const ordered = sorted ? Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entries;
    ws.vfs.write(path, JSON.stringify(ordered, null, 2) + `
`);
  }
}
var init_typescript_suppressions = __esm(() => {
  init_typescript_package_specifiers();
  init_typescript_paths();
  init_typescript_vfs();
});

// src/core/snapshot.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename as basename3, dirname as dirname9, isAbsolute as isAbsolute2, relative as relative7, resolve as resolve8, sep as sep4 } from "node:path";
function describeInputPath(path) {
  const portable = path.split(sep4).join("/");
  return /(^|\/)(next-env\.d\.ts|[^/]+\.gen\.[^/]+|_generated|\.next)(\/|$)/.test(portable) ? `${path} [generated candidate]` : path;
}
var excluded, run;
var init_snapshot = __esm(() => {
  excluded = new Set([".git", "node_modules", "bin", "obj", "dist", ".refactor-ai"]);
  run = promisify(execFile);
});

// src/backends/typescript-fileops.ts
import ts7 from "typescript";
import { existsSync as existsSync4, lstatSync as lstatSync2, readFileSync as readFileSync4, readdirSync as readdirSync4 } from "node:fs";
import { dirname as dirname10, extname as extname4, isAbsolute as isAbsolute3, relative as relative8, resolve as resolve9, sep as sep5 } from "node:path";
function preferencesFor(ws) {
  let single = 0, double = 0;
  for (const path of userFiles(ws)) {
    const sourceFile = parseFile(ws, path);
    for (const specifier of sourceFile ? moduleSpecifiers(sourceFile) : []) {
      const quote = sourceFile.text[specifier.getStart(sourceFile)];
      if (quote === "'")
        single += 1;
      else if (quote === '"')
        double += 1;
    }
  }
  return { allowTextChangesInNewFiles: true, quotePreference: single > double ? "single" : double > single ? "double" : "auto" };
}
function assertAbsolute(name, value) {
  if (!value || !isAbsolute3(value))
    fail("INVALID_REQUEST", `${name} must be an absolute path`);
  return resolve9(value);
}
function sourceExtension(path) {
  if (/\.d(\.[^./]+)?\.[cm]?ts$/i.test(path))
    fail("UNSUPPORTED_FILE", "declaration files cannot be renamed or moved");
  const extension = extname4(path);
  if (![...tsExtensions, ...jsExtensions].includes(extension))
    fail("UNSUPPORTED_FILE", extension || "file has no extension");
  return extension;
}
function formatFor(text) {
  return { ...baseFormatOptions, newLineCharacter: eolOf(text) };
}
function declaredTypes(sourceFile, isJs) {
  return sourceFile.statements.filter((statement) => {
    if (ts7.isClassDeclaration(statement))
      return statement.name !== undefined;
    return !isJs && (ts7.isInterfaceDeclaration(statement) || ts7.isTypeAliasDeclaration(statement) || ts7.isEnumDeclaration(statement));
  });
}
function namespaceMembers(sourceFile) {
  const names = new Set;
  const visit = (node) => {
    if (ts7.isModuleDeclaration(node)) {
      names.add(node.name.text);
      if (node.body)
        ts7.forEachChild(node.body, visit);
    } else if ((ts7.isClassDeclaration(node) || ts7.isInterfaceDeclaration(node) || ts7.isTypeAliasDeclaration(node) || ts7.isEnumDeclaration(node)) && node.name) {
      names.add(node.name.text);
    } else if (ts7.isModuleBlock(node)) {
      ts7.forEachChild(node, visit);
    }
  };
  for (const statement of sourceFile.statements)
    if (ts7.isModuleDeclaration(statement))
      visit(statement);
  return names;
}
function selectType(context, request) {
  const { sourceFile, isJs } = context;
  const types = declaredTypes(sourceFile, isJs);
  const namespaced = namespaceMembers(sourceFile);
  const named = (name2) => types.filter((declaration) => declaration.name?.getText(sourceFile) === name2);
  let name = request.typeName;
  if (request.position !== undefined) {
    if (!Number.isInteger(request.position) || request.position < 0 || request.position > sourceFile.text.length) {
      fail("INVALID_RANGE", "position must be a UTF-16 offset within the file");
    }
    const statement = sourceFile.statements.find((item) => item.getStart(sourceFile) <= request.position && request.position <= item.end);
    if (statement && ts7.isModuleDeclaration(statement))
      fail("NAMESPACE_UNSUPPORTED", "types inside TypeScript namespaces are not supported");
    const declaration = types.find((item) => item === statement);
    if (!declaration)
      fail("TYPE_NOT_FOUND", `position does not select a top-level ${isJs ? "class" : "class, interface, type alias or enum"}`);
    const selected = declaration.name.getText(sourceFile);
    if (name !== undefined && name !== selected)
      fail("INVALID_REQUEST", `position selects ${selected} but typeName is ${name}`);
    name = selected;
  }
  if (name === undefined) {
    const names = [...new Set(types.map((declaration) => declaration.name.getText(sourceFile)))];
    if (names.length === 0) {
      if (namespaced.size)
        fail("NAMESPACE_UNSUPPORTED", "the file only declares types inside TypeScript namespaces");
      fail("TYPE_NOT_FOUND", `the file declares no top-level ${isJs ? "named class" : "class, interface, type alias or enum"}`);
    }
    if (names.length > 1)
      fail("AMBIGUOUS_TYPE", `the file declares ${names.join(", ")}; select one with typeName (--type) or position`);
    name = names[0];
  }
  const declarations = named(name);
  if (!declarations.length) {
    if (namespaced.has(name))
      fail("NAMESPACE_UNSUPPORTED", `${name} is declared inside a TypeScript namespace`);
    fail("TYPE_NOT_FOUND", `${name} is not a top-level ${isJs ? "class" : "class, interface, type alias or enum"} in ${context.file}`);
  }
  return { name, declarations };
}
function assertCaseSafe(root, path) {
  let current2 = root;
  for (const part of relative8(root, path).split(sep5)) {
    let names;
    try {
      names = readdirSync4(current2);
    } catch {
      return;
    }
    const next = resolve9(current2, part);
    if (!names.includes(part)) {
      if (existsSync4(next)) {
        const actual = names.find((name) => name.toLowerCase() === part.toLowerCase()) ?? "an existing entry";
        fail("CASE_COLLISION", `${next} differs only in case from ${actual}; this volume is case-insensitive and the change could overwrite data`);
      }
      return;
    }
    current2 = next;
  }
}
function parseFile(ws, path) {
  const text = ws.vfs.readFile(path);
  if (text === undefined)
    return;
  const impliedNodeFormat = ts7.getImpliedNodeFormatForFile(path, undefined, ws.vfs.moduleResolutionHost(), ws.editOptions);
  return ts7.createSourceFile(path, text, { languageVersion: ts7.ScriptTarget.Latest, impliedNodeFormat }, true, scriptKindFor(path));
}
function userFiles(ws) {
  return ws.unionFiles().filter((path) => isInside(ws.root, path) && !path.split(sep5).includes("node_modules"));
}
function applyEdits(context, edits, newFile) {
  const { ws } = context;
  for (const edit of [...edits].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    const path = resolve9(edit.fileName);
    if (!isInside(ws.root, path))
      fail("OUTSIDE_ROOT", `TypeScript proposed a change outside ${ws.root}: ${path}`);
    if (path.split(sep5).includes("node_modules") || ws.vfs.isHidden(path))
      fail("OUTSIDE_PROJECT", `TypeScript proposed a change to a dependency or build output: ${path}`);
    const before = ws.vfs.readFile(path);
    if (edit.isNewFile) {
      if (before !== undefined)
        fail("TARGET_EXISTS", path);
      if (!newFile)
        fail("INVALID_EDIT", `unexpected new file ${path}`);
      ws.vfs.write(path, withEol(edit.textChanges.map((change) => change.newText).join(""), newFile.eol), newFile.bom);
      continue;
    }
    if (before === undefined)
      fail("MISSING_FILE", path);
    const eol = eolOf(before);
    ws.vfs.write(path, applyTextChanges(before, edit.textChanges.map((change) => ({ ...change, newText: withEol(change.newText, eol) }))));
  }
}
function membership(ws) {
  return new Map([...ws.participants.values()].map((item) => [item.configPath, ws.fileNames(item.configPath).map((path) => ws.vfs.key(path)).sort()]));
}
function assertMembership(ws, before, renames, deletions, gains) {
  const vfs = ws.vfs;
  const renameMap = new Map(renames.map(([from, to]) => [vfs.key(from), vfs.key(to)]));
  const deleted = new Set(deletions.map((path) => vfs.key(path)));
  for (const [config, files] of before) {
    const expected = files.filter((key) => !deleted.has(key)).map((key) => renameMap.get(key) ?? key);
    const actual = ws.fileNames(config).map((path) => vfs.key(path)).sort();
    for (const gain of gains ? Array.isArray(gains) ? gains : [gains] : []) {
      if (expected.includes(vfs.key(gain.path)))
        continue;
      const must = gain.must.some((item) => vfs.samePath(item, config));
      if (must || gain.may.some((item) => vfs.samePath(item, config)) && actual.includes(vfs.key(gain.path)))
        expected.push(vfs.key(gain.path));
    }
    expected.sort();
    const added = actual.filter((key) => !expected.includes(key));
    const missing = expected.filter((key) => !actual.includes(key));
    if (added.length || missing.length) {
      fail("PROJECT_MEMBERSHIP_CHANGED", `${config} would ${[
        added.length ? `gain ${added.map(describeInputPath).join(", ")}` : "",
        missing.length ? `lose ${missing.map(describeInputPath).join(", ")}` : ""
      ].filter(Boolean).join(" and ")}; adjust include/files patterns or choose another target; if a dev server regenerated these inputs, retry after its generators settle`);
    }
  }
}
function importerMap(ws, paths) {
  const found = new Map(paths.map((path) => [ws.vfs.key(path), []]));
  for (const file of userFiles(ws)) {
    const sourceFile = parseFile(ws, file);
    if (!sourceFile)
      continue;
    for (const specifier of moduleSpecifiers(sourceFile)) {
      const resolved = ws.resolveModule(specifier, sourceFile);
      if (resolved)
        found.get(ws.vfs.key(resolved.resolvedFileName))?.push(ws.vfs.key(file));
    }
    for (const reference of sourceFile.referencedFiles) {
      found.get(ws.vfs.key(resolve9(dirname10(file), reference.fileName)))?.push(ws.vfs.key(file));
    }
  }
  for (const files of found.values())
    files.sort();
  return found;
}
function importers(ws, path) {
  return importerMap(ws, [path]).get(ws.vfs.key(path));
}
function nodeAt(sourceFile, position) {
  let node = sourceFile;
  for (;; ) {
    const child = node.getChildren(sourceFile).find((item) => item.getStart(sourceFile) <= position && position < item.end);
    if (!child)
      return node;
    node = child;
  }
}
function inModuleSyntax(node) {
  for (let current2 = node;current2 && !ts7.isSourceFile(current2); current2 = current2.parent) {
    if (ts7.isImportSpecifier(current2) || ts7.isExportSpecifier(current2) || ts7.isImportClause(current2) || ts7.isNamespaceImport(current2) || ts7.isImportEqualsDeclaration(current2))
      return true;
    if (ts7.isStatement(current2))
      return false;
  }
  return false;
}
function referenceCounts(ws, file, position, moved) {
  const program = ws.program();
  const counts = new Map;
  for (const symbol of ws.service.findReferences(file, position) ?? []) {
    for (const entry of symbol.references) {
      if (entry.isDefinition)
        continue;
      const sourceFile = program.getSourceFile(entry.fileName);
      if (!sourceFile || inModuleSyntax(nodeAt(sourceFile, entry.textSpan.start)))
        continue;
      const inMoved = moved && ws.vfs.samePath(entry.fileName, file) && entry.textSpan.start >= moved.start && entry.textSpan.start < moved.end;
      const key = ws.vfs.key(inMoved ? moved.to : entry.fileName);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}
function assertSameCounts(before, after, name) {
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changed = keys.filter((key) => (before.get(key) ?? 0) !== (after.get(key) ?? 0));
  if (changed.length) {
    fail("REFERENCES_NOT_PRESERVED", `references to ${name} would no longer bind to it in ${changed.map((key) => `${key} (${before.get(key) ?? 0} -> ${after.get(key) ?? 0})`).join(", ")}`);
  }
}
function usesCommonJs(sourceFile) {
  let found = false;
  const visit = (node) => {
    if (found)
      return;
    if (ts7.isCallExpression(node) && ts7.isIdentifier(node.expression) && node.expression.text === "require")
      found = true;
    else if (ts7.isPropertyAccessExpression(node) && ts7.isIdentifier(node.expression) && (node.expression.text === "module" && node.name.text === "exports" || node.expression.text === "exports"))
      found = true;
    else if (ts7.isExportAssignment(node) && node.isExportEquals)
      found = true;
    else
      ts7.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
function specifierLike(from, to, original, originalTarget) {
  if (!original.startsWith("./") && !original.startsWith("../")) {
    fail("REEXPORT_UNSUPPORTED", `non-relative specifier '${original}' in ${from} cannot be retargeted deterministically`);
  }
  const written = extname4(original);
  const targetExtension = extname4(to);
  if (![...tsExtensions, ...jsExtensions].includes(targetExtension)) {
    const path2 = portablePath(relative8(dirname10(from), to));
    return path2.startsWith(".") ? path2 : `./${path2}`;
  }
  let extension = "";
  if ([...tsExtensions, ...jsExtensions].includes(written)) {
    extension = written === extname4(originalTarget) ? targetExtension : written === ".jsx" && targetExtension === ".tsx" ? ".jsx" : jsEquivalent[targetExtension] ?? targetExtension;
  }
  const path = portablePath(relative8(dirname10(from), to.slice(0, to.length - targetExtension.length))) + extension;
  return path.startsWith(".") ? path : `./${path}`;
}
function updateReexports(context, target, name, exported, sourceDeleted) {
  const { ws, file } = context;
  for (const path of userFiles(ws)) {
    if (ws.vfs.samePath(path, target) || ws.vfs.samePath(path, file))
      continue;
    const sourceFile = parseFile(ws, path);
    if (!sourceFile)
      continue;
    const text = sourceFile.text;
    const eol = eolOf(text);
    const changes = [];
    for (const statement of sourceFile.statements) {
      if (!ts7.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts7.isStringLiteral(statement.moduleSpecifier))
        continue;
      const resolved = ws.resolveModule(statement.moduleSpecifier, sourceFile);
      if (!resolved || !ws.vfs.samePath(resolved.resolvedFileName, file))
        continue;
      const specifierStart = statement.moduleSpecifier.getStart(sourceFile);
      const quote = text[specifierStart];
      const literal2 = `${quote}${specifierLike(path, target, statement.moduleSpecifier.text, file)}${quote}`;
      const typeOnly = statement.isTypeOnly ? "type " : "";
      if (!statement.exportClause) {
        if (sourceDeleted)
          changes.push({ span: { start: specifierStart, length: statement.moduleSpecifier.end - specifierStart }, newText: literal2 });
        else if (exported)
          changes.push({ span: { start: statement.end, length: 0 }, newText: `${eol}export ${typeOnly}{ ${name} } from ${literal2};` });
      } else if (ts7.isNamespaceExport(statement.exportClause)) {
        if (exported)
          fail("REEXPORT_UNSUPPORTED", `${path} re-exports ${file} as namespace '${statement.exportClause.name.getText(sourceFile)}'; moving ${name} would change that namespace`);
      } else {
        const elements = statement.exportClause.elements;
        const moved = elements.filter((element) => (element.propertyName ?? element.name).text === name);
        if (!moved.length)
          continue;
        const kept = elements.filter((element) => !moved.includes(element));
        const movedDeclaration = `export ${typeOnly}{ ${moved.map((element) => element.getText(sourceFile)).join(", ")} } from ${literal2};`;
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
    if (changes.length)
      ws.vfs.write(path, applyTextChanges(text, changes));
  }
}
function moduleEdges(ws, files, owners) {
  const edges = [];
  for (const file of files) {
    const from = owners(file);
    if (!from.length)
      continue;
    const sourceFile = parseFile(ws, file);
    if (!sourceFile)
      continue;
    const options = ws.participant(from[0]).parsed.options;
    for (const specifier of moduleSpecifiers(sourceFile)) {
      const resolved = ws.resolveModule(specifier, sourceFile, options);
      if (!resolved)
        continue;
      const target = resolve9(resolved.resolvedFileName);
      if (!isInside(ws.root, target) || target.split(sep5).includes("node_modules") || ws.vfs.isHidden(target))
        continue;
      edges.push({ file, target, from, to: owners(target) });
    }
  }
  return edges;
}
function accessViolations(ws, files, owners) {
  const violations = new Map;
  const composite = (config) => !!ws.participant(config).parsed.options.composite;
  for (const { file, target, from, to } of moduleEdges(ws, files, owners)) {
    if (to.length === 0) {
      if (/\.d\.[cm]?ts$/.test(target))
        continue;
    } else {
      const reachable = from.some((owner) => to.some((targetOwner) => ws.vfs.samePath(owner, targetOwner) || ws.references(owner).some((reference) => ws.vfs.samePath(reference, targetOwner))));
      if (reachable || ![...from, ...to].some(composite))
        continue;
    }
    const key = `${ws.vfs.key(file)}\x00${ws.vfs.key(target)}`;
    violations.set(key, to.length ? `${file} (${from.join(", ")}) would import ${target} from ${to.join(", ")}, which it does not reference (composite projects require project references)` : `${file} would import ${target}, which belongs to no loaded project`);
  }
  return violations;
}
function projectGraph(ws, files, owners) {
  const graph = new Map;
  const link = (from, to) => {
    if (ws.vfs.samePath(from, to))
      return;
    const targets = graph.get(ws.vfs.key(from)) ?? new Set;
    targets.add(ws.vfs.key(to));
    graph.set(ws.vfs.key(from), targets);
  };
  for (const item of ws.participants.values())
    for (const reference of item.references)
      link(item.configPath, reference);
  for (const edge of moduleEdges(ws, files, owners))
    for (const from of edge.from)
      for (const to of edge.to)
        link(from, to);
  return graph;
}
function introducedCycles(before, after) {
  const reaches = (from, to) => {
    const seen = new Set;
    const pending = [from];
    while (pending.length) {
      const current2 = pending.pop();
      if (current2 === to)
        return true;
      if (seen.has(current2))
        continue;
      seen.add(current2);
      pending.push(...after.get(current2) ?? []);
    }
    return false;
  };
  const cycles = [];
  for (const [from, targets] of [...after].sort(([a], [b]) => a.localeCompare(b))) {
    for (const to of [...targets].sort()) {
      if (!before.get(from)?.has(to) && reaches(to, from))
        cycles.push(`${from} -> ${to}`);
    }
  }
  return cycles;
}
function renameFile(context, request) {
  const { ws, file, root } = context;
  if (request.targetProject && !ws.vfs.samePath(configPathFor(assertAbsolute("targetProject", request.targetProject)), ws.sourceConfig)) {
    fail("INVALID_REQUEST", "rename-file keeps the file in its project; targetProject must be omitted");
  }
  const { name } = selectType(context, request);
  const target = resolve9(dirname10(file), `${name}${extname4(file)}`);
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
    if (ws.vfs.fileExists(target) || ws.vfs.directoryExists(target))
      fail("TARGET_EXISTS", target);
    assertCaseSafe(root, target);
  }
  const before = membership(ws);
  const importersBefore = importers(ws, file).map((key) => ws.vfs.samePath(key, file) ? ws.vfs.key(target) : key);
  const text = ws.vfs.readFile(file);
  applyEdits(context, ws.service.getEditsForFileRename(file, target, formatFor(text), preferencesFor(ws)));
  const bom = ws.vfs.hasBom(file);
  const moved = ws.vfs.readFile(file);
  ws.vfs.write(file, null);
  ws.vfs.write(target, moved, bom);
  ws.updateConfigLists([[file, target]], []);
  ws.reparse();
  assertMembership(ws, before, [[file, target]], []);
  const stale = importers(ws, file);
  if (stale.length)
    fail("REFERENCES_NOT_PRESERVED", `imports in ${[...new Set(stale)].join(", ")} still name ${file}`);
  const importersAfter = importers(ws, target);
  if (JSON.stringify(importersAfter) !== JSON.stringify(importersBefore.sort())) {
    fail("REFERENCES_NOT_PRESERVED", `${importersBefore.length} module references resolved to ${file} but ${importersAfter.length} resolve to ${target}`);
  }
  return { renamed: [file, target] };
}
function topLevelNames(sourceFile) {
  const names = new Map;
  for (const statement of sourceFile.statements) {
    if (ts7.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name)
        names.set(clause.name.text, statement);
      if (clause?.namedBindings && ts7.isNamespaceImport(clause.namedBindings))
        names.set(clause.namedBindings.name.text, statement);
      if (clause?.namedBindings && ts7.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements)
          names.set(element.name.text, statement);
      }
    } else if (ts7.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts7.isIdentifier(declaration.name))
          names.set(declaration.name.text, statement);
      }
    } else if ("name" in statement && statement.name && ts7.isIdentifier(statement.name)) {
      names.set(statement.name.text, statement);
    }
  }
  return names;
}
function assertSafeInitialization(declaration) {
  const reject = () => fail("INITIALIZATION_EFFECTS_UNSUPPORTED", "move-type cannot preserve runtime initialization order for this declaration; static effects, computed names, decorators and evaluated base classes are unsupported");
  const constant = (expression) => {
    if (ts7.isParenthesizedExpression(expression) || ts7.isAsExpression(expression) || ts7.isTypeAssertionExpression(expression) || ts7.isSatisfiesExpression(expression))
      return constant(expression.expression);
    if (ts7.isPrefixUnaryExpression(expression))
      return [ts7.SyntaxKind.PlusToken, ts7.SyntaxKind.MinusToken, ts7.SyntaxKind.ExclamationToken, ts7.SyntaxKind.TildeToken].includes(expression.operator) && constant(expression.operand);
    return ts7.isNumericLiteral(expression) || ts7.isStringLiteral(expression) || ts7.isNoSubstitutionTemplateLiteral(expression) || ts7.isBigIntLiteral(expression) || [ts7.SyntaxKind.TrueKeyword, ts7.SyntaxKind.FalseKeyword, ts7.SyntaxKind.NullKeyword].includes(expression.kind);
  };
  if (ts7.isEnumDeclaration(declaration)) {
    if (declaration.members.some((member) => member.initializer && !constant(member.initializer)))
      reject();
  }
  if (!ts7.isClassDeclaration(declaration))
    return;
  if (ts7.getDecorators(declaration)?.length || declaration.heritageClauses?.some((clause) => clause.token === ts7.SyntaxKind.ExtendsKeyword && clause.types.some((type) => !ts7.isIdentifier(type.expression))))
    reject();
  for (const member of declaration.members) {
    if (ts7.canHaveDecorators(member) && ts7.getDecorators(member)?.length || ts7.isClassStaticBlockDeclaration(member) || member.name && ts7.isComputedPropertyName(member.name))
      reject();
    if (ts7.isConstructorDeclaration(member) && member.parameters.some((parameter) => ts7.getDecorators(parameter)?.length))
      reject();
    if (ts7.isPropertyDeclaration(member) && ts7.getModifiers(member)?.some((modifier) => modifier.kind === ts7.SyntaxKind.StaticKeyword) && member.initializer && !constant(member.initializer))
      reject();
  }
}
function importedTarget(ws, binding) {
  const imported = ts7.isImportSpecifier(binding) ? (binding.propertyName ?? binding.name).text : ts7.isImportClause(binding) ? "default" : ts7.isNamespaceImport(binding) ? "*" : undefined;
  if (imported === undefined)
    return;
  let parent = binding;
  while (parent.parent && !ts7.isImportDeclaration(parent))
    parent = parent.parent;
  if (!ts7.isImportDeclaration(parent) || !ts7.isStringLiteralLike(parent.moduleSpecifier))
    return;
  const resolved = ws.resolveModule(parent.moduleSpecifier, parent.getSourceFile());
  return resolved ? `${ws.vfs.key(resolved.resolvedFileName)}\x00${imported}` : undefined;
}
function typeImportTargets(ws, declaration) {
  const checker = ws.program().getTypeChecker();
  const targets = new Set;
  const visit = (node) => {
    if (ts7.isIdentifier(node))
      for (const binding of checker.getSymbolAtLocation(node)?.declarations ?? []) {
        const target = importedTarget(ws, binding);
        if (target)
          targets.add(target);
      }
    if (ts7.isImportTypeNode(node) && ts7.isLiteralTypeNode(node.argument) && ts7.isStringLiteralLike(node.argument.literal)) {
      const resolved = ws.resolveModule(node.argument.literal, node.getSourceFile());
      if (resolved)
        targets.add(`${ws.vfs.key(resolved.resolvedFileName)}\x00import-type:${node.qualifier?.getText() ?? "*"}`);
    }
    ts7.forEachChild(node, visit);
  };
  visit(declaration);
  return targets;
}
function moveType(context, request) {
  const { ws, file, root, sourceFile, isJs } = context;
  const target = assertAbsolute("target", request.target);
  if (!isInside(root, target))
    fail("OUTSIDE_ROOT", `target is outside ${root}`);
  const targetExtension = sourceExtension(target);
  if (!(isJs ? jsExtensions : tsExtensions).includes(targetExtension)) {
    fail("UNSUPPORTED_TARGET", `a ${isJs ? "JavaScript" : "TypeScript"} type must move to a ${isJs ? jsExtensions.join("/") : tsExtensions.join("/")} file`);
  }
  if (ws.vfs.samePath(target, file))
    fail("INVALID_REQUEST", "target must differ from the source file");
  if (!ts7.isExternalModule(sourceFile))
    fail("MODULE_REQUIRED", "move-type requires an ES module source file (with import or export)");
  if (isJs && usesCommonJs(sourceFile))
    fail("COMMONJS_UNSUPPORTED", "CommonJS require/exports are not supported by move-type");
  const { name, declarations } = selectType(context, request);
  if (declarations.length !== 1)
    fail("MERGED_DECLARATION_UNSUPPORTED", `${name} has ${declarations.length} merged declarations`);
  const declaration = declarations[0];
  assertSafeInitialization(declaration);
  const program = ws.program();
  const programSource = program.getSourceFile(file);
  const nameStart = declaration.name.getStart(sourceFile);
  const symbol = program.getTypeChecker().getSymbolAtLocation(nodeAt(programSource, nameStart));
  if (!symbol || (symbol.declarations?.length ?? 0) !== 1) {
    fail("MERGED_DECLARATION_UNSUPPORTED", `${name} merges with other declarations (namespace, interface or global augmentation)`);
  }
  const importedTargets = typeImportTargets(ws, declaration);
  const exported = (ts7.getCombinedModifierFlags(declaration) & ts7.ModifierFlags.Export) !== 0;
  const targetExists = ws.vfs.fileExists(target);
  if (!targetExists && ws.vfs.directoryExists(target))
    fail("TARGET_EXISTS", `${target} is a directory`);
  assertCaseSafe(root, target);
  if (targetExists) {
    const owners = ws.ownersOf(target);
    if (owners.length !== 1 || !ws.vfs.samePath(owners[0], ws.targetConfig)) {
      fail("TARGET_NOT_IN_PROJECT", `${target} must belong to exactly ${ws.targetConfig}; owners: ${owners.join(", ") || "none"}`);
    }
    const targetSource2 = program.getSourceFile(target);
    if (!ts7.isExternalModule(targetSource2))
      fail("MODULE_REQUIRED", `${target} is not an ES module`);
    if (isJs && usesCommonJs(targetSource2))
      fail("COMMONJS_UNSUPPORTED", `${target} uses CommonJS`);
    const existing = topLevelNames(targetSource2).get(name);
    const importsMoved = existing && ts7.isImportDeclaration(existing) && ts7.isStringLiteral(existing.moduleSpecifier) && ws.vfs.samePath(ws.resolveModule(existing.moduleSpecifier, targetSource2)?.resolvedFileName ?? "", file);
    if (existing && !importsMoved)
      fail("TARGET_CONFLICT", `${target} already declares ${name}`);
  }
  const before = membership(ws);
  const beforeOwners = new Map;
  for (const [config, keys] of before) {
    if (ws.isObserver(config))
      continue;
    for (const key of keys)
      beforeOwners.set(key, [...beforeOwners.get(key) ?? [], config]);
  }
  const listedBefore = (config, path) => before.get(config).includes(ws.vfs.key(path));
  const siblings = ws.observers().filter((config) => ws.vfs.samePath(dirname10(config), dirname10(ws.targetConfig)));
  const mirroring = siblings.filter((config) => listedBefore(config, file) && !listedBefore(config, target));
  const statementStart = declaration.getStart(sourceFile);
  const moduleGraph = () => {
    const graph = new Map;
    for (const edge of moduleEdges(ws, userFiles(ws), (path) => ws.ownersOf(path))) {
      const from = ws.vfs.key(edge.file), to = ws.vfs.key(edge.target);
      graph.set(from, new Set([...graph.get(from) ?? [], to]));
    }
    return graph;
  };
  const modulesBefore = ts7.isClassDeclaration(declaration) ? moduleGraph() : undefined;
  const countsBefore = referenceCounts(ws, file, nameStart, { start: declaration.pos, end: declaration.end, to: target });
  const range = { pos: statementStart, end: declaration.end };
  const preferences = preferencesFor(ws);
  const action = ws.service.getApplicableRefactors(file, range, preferences, "invoked", undefined, true).filter((refactor) => refactor.name === "Move to file").flatMap((refactor) => refactor.actions).find((item) => item.name === "Move to file");
  if (!action || action.notApplicableReason)
    fail("REFACTOR_UNAVAILABLE", action?.notApplicableReason ?? `TypeScript cannot move ${name}`);
  const result = ws.service.getEditsForRefactor(file, formatFor(sourceFile.text), range, "Move to file", "Move to file", preferences, { targetFile: target });
  if (!result || result.notApplicableReason || !result.edits.length)
    fail("REFACTOR_UNAVAILABLE", result?.notApplicableReason ?? "TypeScript returned no edits");
  applyEdits(context, result.edits, { eol: eolOf(sourceFile.text), bom: ws.vfs.hasBom(file) });
  if (!ws.vfs.fileExists(target))
    fail("REFACTOR_UNAVAILABLE", "TypeScript did not produce the target file");
  const remaining = parseFile(ws, file);
  const sourceDeleted = remaining.statements.length === 0;
  updateReexports(context, target, name, exported, sourceDeleted);
  if (sourceDeleted) {
    if (remaining.text.trim())
      context.notes.push(`${file} only kept comments after the move and is deleted; its previous content is in the plan.`);
    else
      context.notes.push(`${file} is empty after the move and is deleted.`);
    const stale = importers(ws, file);
    if (stale.length)
      fail("SOURCE_STILL_REFERENCED", `${[...new Set(stale)].join(", ")} still import ${file}, which would be empty after the move`);
    ws.vfs.write(file, null);
  }
  const substitutions = new Map(sourceDeleted ? mirroring.map((config) => [ws.vfs.key(config), [[file, target]]]) : []);
  ws.updateConfigLists([], sourceDeleted ? [file] : [], substitutions);
  ws.reparse();
  const includes = (config) => ws.fileNames(config).some((path) => ws.vfs.samePath(path, target));
  for (const config of [...targetExists ? [] : [ws.targetConfig], ...mirroring]) {
    if (includes(config))
      continue;
    if (!ws.addToFiles(config, target)) {
      fail("TARGET_NOT_IN_PROJECT", `${target} is not matched by the include patterns of ${config}`);
    }
    ws.reparse();
    context.notes.push(`Added ${target} to the files list of ${config}.`);
  }
  assertMembership(ws, before, [], sourceDeleted ? [file] : [], {
    path: target,
    must: [...targetExists ? [] : [ws.targetConfig], ...mirroring],
    may: targetExists ? [] : siblings
  });
  const targetSource = ws.program().getSourceFile(target);
  const movedDeclaration = targetSource && declaredTypes(targetSource, isJs).find((item) => item.name?.getText(targetSource) === name);
  if (!targetSource || !movedDeclaration)
    fail("REFACTOR_UNAVAILABLE", `${name} was not found in ${target} after the move`);
  assertSameCounts(countsBefore, referenceCounts(ws, target, movedDeclaration.name.getStart(targetSource)), name);
  context.verify = () => {
    const actual = typeImportTargets(ws, movedDeclaration);
    for (const dependency of importedTargets) {
      if (!actual.has(dependency))
        fail("REFERENCES_NOT_PRESERVED", `${name} in ${target} no longer imports ${dependency.replace("\x00", " export ")}`);
    }
  };
  const changed = ws.vfs.changes().filter((change) => change.after !== null && !/\.json$/i.test(change.path)).map((change) => change.path);
  const afterViolations = accessViolations(ws, changed, (path) => ws.ownersOf(path));
  const beforeViolations = ws.vfs.original(() => accessViolations(ws, changed.filter((path) => ws.vfs.diskText(path) !== null), (path) => beforeOwners.get(ws.vfs.key(path)) ?? []));
  const introduced = [...afterViolations].filter(([key]) => !beforeViolations.has(key)).map(([, message]) => message);
  if (introduced.length)
    fail("INACCESSIBLE_DEPENDENCY", `${introduced.join("; ")}; add a project reference or move dependencies first`);
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
function movePaths(root, file, target) {
  if (!isInside(root, target))
    fail("OUTSIDE_ROOT", `target is outside ${root}`);
  let stat;
  try {
    stat = lstatSync2(file);
  } catch {
    fail("FILE_NOT_FOUND", file);
  }
  if (stat.isSymbolicLink())
    fail("SYMLINK_UNSUPPORTED", file);
  if (stat.isFile()) {
    if (extname4(file) !== extname4(target))
      fail("UNSUPPORTED_TARGET", "move-file must retain the file extension");
    return [[file, target]];
  }
  if (!stat.isDirectory())
    fail("UNSUPPORTED_FILE", file);
  if (isInside(file, target) || isInside(target, file))
    fail("INVALID_REQUEST", "source and destination directories must not overlap");
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync4(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve9(directory, entry.name);
      if (entry.isSymbolicLink())
        fail("SYMLINK_UNSUPPORTED", path);
      if (entry.isDirectory())
        visit(path);
      else if (entry.isFile())
        paths.push([path, resolve9(target, relative8(file, path))]);
      else
        fail("UNSUPPORTED_FILE", path);
    }
  };
  visit(file);
  if (!paths.length)
    fail("EMPTY_DIRECTORY", `${file} contains no files`);
  return paths;
}
function relocationImports(ws, renames) {
  const moved = new Set(renames.map(([from]) => ws.vfs.key(from)));
  const imports = [];
  for (const file of userFiles(ws)) {
    const source = parseFile(ws, file);
    if (!source)
      continue;
    const owner = ws.ownersOf(file)[0];
    const options = owner ? ws.participant(owner).parsed.options : ws.editOptions;
    moduleSpecifiers(source).forEach((specifier, index) => {
      const resolved = ws.resolveModule(specifier, source, options);
      if (!resolved)
        return;
      const target = resolve9(resolved.resolvedFileName);
      if (!moved.has(ws.vfs.key(file)) && !moved.has(ws.vfs.key(target)))
        return;
      const alias = Object.keys(options.paths ?? {}).some((pattern) => {
        const [prefix, suffix] = pattern.split("*");
        return pattern.includes("*") ? specifier.text.startsWith(prefix) && specifier.text.endsWith(suffix) : pattern === specifier.text;
      });
      imports.push({ file, index, target, original: specifier.text, alias });
    });
  }
  return imports;
}
function moveFile(context, request, renames) {
  const { ws, root, file } = context;
  const target = assertAbsolute("target", request.target);
  const directory = lstatSync2(file).isDirectory();
  if (ws.vfs.samePath(file, target))
    fail("INVALID_REQUEST", "target must differ from the source");
  if (ws.vfs.fileExists(target) || !directory && ws.vfs.directoryExists(target))
    fail("TARGET_EXISTS", target);
  for (const [from, to] of renames) {
    if (ws.vfs.fileExists(to) || ws.vfs.directoryExists(to))
      fail("TARGET_EXISTS", to);
    assertCaseSafe(root, to);
    const bytes = readFileSync4(from);
    if (!Buffer.from(bytes.toString("utf8")).equals(bytes))
      fail("UNSUPPORTED_ENCODING", `${from}: move-file plans require UTF-8 text`);
  }
  const before = membership(ws);
  const beforeOwners = new Map;
  for (const [config, keys] of before) {
    if (ws.isObserver(config))
      continue;
    for (const key of keys)
      beforeOwners.set(key, [...beforeOwners.get(key) ?? [], config]);
  }
  const graphBefore = projectGraph(ws, userFiles(ws), (path) => ws.ownersOf(path));
  const imports = relocationImports(ws, renames);
  const mapping = new Map(renames.map(([from, to]) => [ws.vfs.key(from), to]));
  const relocated = (path) => mapping.get(ws.vfs.key(path)) ?? path;
  const styleCache = new Map;
  const retargeted = imports.filter((edge) => mapping.has(ws.vfs.key(edge.target)) || mapping.has(ws.vfs.key(edge.file)) && packageSelfImport(ws, relocated(edge.file), relocated(edge.target), edge.original));
  const styles = new Map(retargeted.map((edge) => [edge, relativeStyle(ws, relocated(edge.target), edge.original, styleCache)]));
  const beforeImporters = importerMap(ws, renames.map(([from]) => from));
  const expectedImporters = new Map(renames.map(([from, to]) => [to, beforeImporters.get(ws.vfs.key(from)).map(relocated).map((path) => ws.vfs.key(path)).sort()]));
  applyEdits(context, ws.service.getEditsForFileRename(file, target, formatFor(context.sourceFile.text), preferencesFor(ws)));
  for (const [from, to] of renames) {
    const text = ws.vfs.readFile(from);
    const bom = ws.vfs.hasBom(from);
    ws.vfs.write(from, null);
    ws.vfs.write(to, text, bom);
  }
  const sameProject = ws.vfs.samePath(ws.sourceConfig, ws.targetConfig);
  const configRenames = directory ? [[file, target], ...renames] : renames;
  const substitutions = new Map;
  if (!sameProject)
    for (const item of ws.participants.values()) {
      if (ws.vfs.samePath(dirname10(item.configPath), dirname10(ws.targetConfig)))
        substitutions.set(ws.vfs.key(item.configPath), configRenames);
    }
  ws.updateConfigLists(sameProject ? configRenames : [], sameProject ? [] : configRenames.map(([from]) => from), substitutions);
  ws.reparse();
  const sourceRenames = renames.filter(([from]) => [...before.values()].some((files) => files.includes(ws.vfs.key(from))));
  const siblings = ws.observers().filter((config) => ws.vfs.samePath(dirname10(config), dirname10(ws.targetConfig)));
  for (const [, to] of sourceRenames) {
    if (!ws.fileNames(ws.targetConfig).some((path) => ws.vfs.samePath(path, to))) {
      if (!ws.addToFiles(ws.targetConfig, to))
        fail("TARGET_NOT_IN_PROJECT", `${to} is not matched by the include patterns of ${ws.targetConfig}`);
      ws.reparse();
    }
    const owners = ws.ownersOf(to);
    if (owners.length !== 1 || !ws.vfs.samePath(owners[0], ws.targetConfig))
      fail("TARGET_NOT_IN_PROJECT", `${to} must belong to exactly ${ws.targetConfig}; owners: ${owners.join(", ") || "none"}`);
  }
  assertMembership(ws, before, sameProject ? sourceRenames : [], sameProject ? [] : sourceRenames.map(([from]) => from), sameProject ? undefined : sourceRenames.map(([, path]) => ({ path, must: [ws.targetConfig], may: siblings })));
  const changes = new Map;
  for (const edge of retargeted) {
    const from = relocated(edge.file), to = relocated(edge.target);
    const source = parseFile(ws, from);
    const specifier = moduleSpecifiers(source)[edge.index];
    if (!specifier)
      fail("REFERENCES_NOT_PRESERVED", `module specifier disappeared in ${from}`);
    const owner = ws.ownersOf(from)[0];
    const options = owner ? ws.participant(owner).parsed.options : ws.editOptions;
    const bare = packageSpecifier(ws, from, to, ts7.getModeForUsageLocation(source, specifier, options));
    const style = styles.get(edge);
    const name = bare ?? specifierLike(from, to, style, edge.target);
    const start = specifier.getStart(source) + 1;
    const list = changes.get(from) ?? [];
    list.push({ span: { start, length: specifier.end - start - 1 }, newText: JSON.stringify(name).slice(1, -1) });
    changes.set(from, list);
  }
  for (const [path, edits] of changes)
    ws.vfs.write(path, applyTextChanges(ws.vfs.readFile(path), edits));
  ws.reparse();
  context.aliasHints = imports.filter((edge) => edge.alias && mapping.has(ws.vfs.key(edge.file)) && !mapping.has(ws.vfs.key(edge.target))).filter((edge) => {
    const source = parseFile(ws, relocated(edge.file));
    const specifier = moduleSpecifiers(source)[edge.index];
    return specifier && !ws.resolveModule(specifier, source, ws.participant(ws.targetConfig).parsed.options);
  }).map((edge) => `${edge.original} (${relocated(edge.file)})`);
  const changed = ws.vfs.changes().filter((change) => change.after !== null && /\.[cm]?[jt]sx?$/.test(change.path)).map((change) => change.path);
  const afterViolations = accessViolations(ws, changed, (path) => ws.ownersOf(path));
  const originals = new Map(renames.map(([from, to]) => [ws.vfs.key(to), from]));
  const originalPaths = changed.map((path) => originals.get(ws.vfs.key(path)) ?? path);
  const beforeViolations = ws.vfs.original(() => accessViolations(ws, originalPaths.filter((path) => ws.vfs.diskText(path) !== null), (path) => beforeOwners.get(ws.vfs.key(path)) ?? []));
  const priorKeys = new Set([...beforeViolations.keys()].map((key) => key.split("\x00").map(relocated).map((path) => ws.vfs.key(path)).join("\x00")));
  const introduced = [...afterViolations].filter(([key]) => !priorKeys.has(key)).map(([, message]) => message);
  if (introduced.length)
    fail("INACCESSIBLE_DEPENDENCY", `${introduced.join("; ")}; add a project reference or move dependencies first`);
  const cycles = introducedCycles(graphBefore, projectGraph(ws, userFiles(ws), (path) => ws.ownersOf(path)));
  if (cycles.length)
    fail("PROJECT_DEPENDENCY_CYCLE", `the move introduces project cycles (${cycles.join("; ")}); move dependencies first`);
  context.verify = () => {
    for (const edge of imports) {
      const from = relocated(edge.file), to = relocated(edge.target);
      const source = parseFile(ws, from);
      const specifier = moduleSpecifiers(source)[edge.index];
      const resolved = specifier && ws.resolveModule(specifier, source);
      if (!resolved || !ws.vfs.samePath(resolved.resolvedFileName, to)) {
        fail("REFERENCES_NOT_PRESERVED", `${edge.original} in ${from} must still resolve to ${to}`);
      }
    }
    const afterImporters = importerMap(ws, renames.map(([, to]) => to));
    for (const [to, expected] of expectedImporters) {
      const actual = afterImporters.get(ws.vfs.key(to));
      if (JSON.stringify(expected) !== JSON.stringify(actual))
        fail("REFERENCES_NOT_PRESERVED", `${expected.length} module references expected for ${to}, found ${actual.length}`);
    }
  };
  moveSuppressions(ws, renames, context.notes);
  context.notes.push(`Moved ${renames.length} file(s) from ${relative8(root, file)} to ${relative8(root, target)}; validated source and target project membership.`);
}
function newDiagnostics(before, after) {
  const key = (item) => `${item.file}\x00${item.code}\x00${item.message}`;
  const counts = new Map;
  for (const item of before)
    counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return after.filter((item) => {
    const count = counts.get(key(item)) ?? 0;
    if (!count)
      return true;
    counts.set(key(item), count - 1);
    return false;
  });
}
async function analyzeFileOperation(request) {
  const root = assertAbsolute("root", request.root);
  const file = assertAbsolute("file", request.file);
  if (!isInside(root, file))
    fail("OUTSIDE_ROOT", `file is outside ${root}`);
  const movingFiles = request.operation === "move-file" ? movePaths(root, file, assertAbsolute("target", request.target)) : undefined;
  const extension = movingFiles ? extname4(file) : sourceExtension(file);
  const sourceConfig = configPathFor(assertAbsolute("project", request.project));
  const targetConfig = ["move-type", "move-file"].includes(request.operation) && request.targetProject ? configPathFor(assertAbsolute("targetProject", request.targetProject)) : sourceConfig;
  const affected = movingFiles ? movingFiles.map(([from]) => from) : [file];
  if (request.operation === "move-type" && request.target && isAbsolute3(request.target) && existsSync4(request.target))
    affected.push(resolve9(request.target));
  if (movingFiles || sourceConfig !== targetConfig)
    precheckMove(root, sourceConfig, targetConfig, movingFiles ?? []);
  const ws = timed("workspace.load", () => new Workspace(root, sourceConfig, targetConfig, affected));
  try {
    if (!movingFiles && !ws.vfs.fileExists(file))
      fail("FILE_NOT_FOUND", file);
    const selected = movingFiles ? movingFiles.map(([from]) => from).filter((path) => /\.[cm]?[jt]sx?$/.test(path)) : [file];
    for (const file2 of selected) {
      const owners = ws.ownersOf(file2);
      if (!owners.some((owner) => ws.vfs.samePath(owner, sourceConfig)))
        fail("FILE_NOT_IN_PROJECT", `${file2} is not included by ${sourceConfig}`);
      if (owners.length > 1)
        fail("OWNERSHIP_AMBIGUOUS", `${file2} is included by several projects: ${owners.join(", ")}`);
    }
    ws.assertNoUnhandledProjects(selected, true, false);
    const sourceFile = ws.program().getSourceFile(selected[0] ?? file) ?? (movingFiles ? ts7.createSourceFile(file, "", ts7.ScriptTarget.Latest) : undefined);
    if (!sourceFile)
      fail("FILE_NOT_IN_PROJECT", file);
    const isJs = jsExtensions.includes(extension);
    const context = { ws, root, file, sourceFile, isJs, notes: [] };
    const validate = timed("workspace.prepare", () => ws.prepareValidation(true));
    let renamed;
    if (request.operation === "rename-file")
      renamed = renameFile(context, request).renamed;
    else if (request.operation === "move-type")
      moveType(context, request);
    else if (movingFiles)
      timed("workspace.move", () => moveFile(context, request, movingFiles));
    else if (request.operation === "inline-reexports") {
      const before = membership(ws);
      const deleted = inlineReexports(ws, file, sourceFile, context.notes, request.keep);
      assertMembership(ws, before, [], deleted ? [file] : []);
    } else
      fail("UNSUPPORTED_OPERATION", String(request.operation));
    const written = ws.vfs.changes().filter((change) => change.after !== null && !/\.json$/i.test(change.path)).map((change) => change.path);
    if (written.length)
      ws.assertNoUnhandledProjects(written, false);
    if (request.operation !== "move-type" && ![...ws.participants.values()].some((item) => item.references.length)) {
      context.verify?.();
      context.verify = undefined;
      ws.service.cleanupSemanticCache();
    }
    const layoutsBefore = new Map(ws.layouts);
    const { before: diagnosticsBefore, after: diagnosticsAfter, affected: validatedFiles, affectedProjects: validatedProjects = ws.participants.size } = timed("workspace.validate", validate);
    const renameMap = new Map((movingFiles ?? (renamed ? [renamed] : [])).map(([from, to]) => [ws.vfs.key(from), to]));
    const comparable = movingFiles ? diagnosticsBefore.map((item) => ({ ...item, file: renameMap.get(ws.vfs.key(item.file)) ?? item.file })) : renamed ? diagnosticsBefore.map((item) => ws.vfs.samePath(item.file, renamed[0]) ? { ...item, file: renamed[1] } : item) : diagnosticsBefore;
    if (!diagnosticsAfter.length && ![...ws.participants.values()].some((item) => item.references.length))
      context.notes.push("Skipped baseline diagnostics: the planned affected set has no errors.");
    const introduced = newDiagnostics(comparable, diagnosticsAfter);
    if (introduced.length)
      fail("NEW_DIAGNOSTICS", introduced.map((item) => `${item.code} ${item.file}: ${item.message}`).join("; ") + (context.aliasHints?.length ? `; unresolved source-project alias imports: ${context.aliasHints.join(", ")}; move their dependencies too or replace these aliases` : ""));
    context.verify?.();
    for (const [key, layout] of layoutsBefore) {
      const after = ws.layouts.get(key);
      if (after !== undefined && after !== layout) {
        fail("OUTPUT_LAYOUT_CHANGED", `${ws.participant(key).configPath} has no rootDir and its emitted files would move from mirroring ${layout} to mirroring ${after}; set rootDir or choose another target`);
      }
    }
    for (const config of ws.importingConfigs) {
      context.notes.push(`Included ${relative8(root, config)} because its program imports ${relative8(root, file)} without a project reference.`);
    }
    for (const config of ws.observers()) {
      context.notes.push(`Updated and validated ${relative8(root, config)}, a variant config that also compiles the affected files.`);
    }
    if (validatedFiles !== undefined) {
      context.notes.push(`Validated ${validatedFiles} affected file(s) across ${validatedProjects} project(s): the changed files and their transitive importers in the original and planned module graphs.${validatedProjects < ws.participants.size ? ` Fully checked ${ws.participants.size - validatedProjects} other project(s).` : ""}`);
    } else if (ws.participants.size > 1) {
      context.notes.push(`Validated ${ws.participants.size} projects (${[...ws.participants.values()].map((item) => relative8(root, item.configPath)).join(", ")}) with in-memory declaration builds for project references.`);
    }
    if (isJs) {
      context.notes.push("JavaScript analysis is semantic only for references TypeScript can resolve; dynamic imports with computed paths and string-based references are not changed.");
    }
    if (renamed)
      context.notes.push(`Renamed ${relative8(root, renamed[0])} to ${relative8(root, renamed[1])}; the plan deletes the old path and creates the new one.`);
    return {
      backend: "typescript",
      version: ts7.version,
      changes: ws.vfs.changes(),
      diagnosticsBefore: comparable,
      diagnosticsAfter,
      notes: context.notes
    };
  } finally {
    ws.dispose();
  }
}
var fileCapabilities, tsExtensions, jsExtensions, jsEquivalent;
var init_typescript_fileops = __esm(() => {
  init_typescript_prechecks();
  init_typescript_inline_reexports();
  init_typescript_vfs();
  init_typescript_workspace();
  init_typescript_package_specifiers();
  init_typescript_suppressions();
  init_typescript_paths();
  init_snapshot();
  fileCapabilities = [
    { operation: "move-file", description: "Move whole TS/JS modules or directories within or between workspace packages, updating imports, exports and project file lists." },
    { operation: "inline-reexports", description: "Inline shim re-exports into workspace callers, deleting unreferenced pure shims unless kept." },
    {
      operation: "rename-file",
      description: "Rename a TS/JS file after its declared type (TS class, interface, type alias or enum; JS class), updating imports in all projects that reference it."
    },
    {
      operation: "move-type",
      description: "Move a top-level TS type or JS class to another file, directory or referenced project, updating imports, re-exports and project file lists."
    }
  ];
  tsExtensions = [".ts", ".tsx", ".mts", ".cts"];
  jsExtensions = [".js", ".jsx", ".mjs", ".cjs"];
  jsEquivalent = { ".ts": ".js", ".tsx": ".js", ".mts": ".mjs", ".cts": ".cjs" };
});

// src/backends/typescript-retarget-mocks.ts
import ts8 from "typescript";
import { resolve as resolve10 } from "node:path";
function mockCalls(source, name) {
  return moduleSpecifiers(source).filter((specifier) => specifier.text === name && isModuleMockCall(specifier.parent) && ts8.isPropertyAccessExpression(specifier.parent.expression) && ["mock", "doMock"].includes(specifier.parent.expression.name.text)).map((specifier) => specifier.parent);
}
function affectedMockFiles(context, affected, from) {
  if (!affected.length)
    return [];
  const program = context.service.getProgram();
  const files = program.getSourceFiles().filter((source) => isInside(context.root, resolve10(source.fileName)) && !source.fileName.replaceAll("\\", "/").includes("/node_modules/"));
  const callers = new Map;
  const cache = ts8.createModuleResolutionCache(context.root, (path) => path, context.options);
  for (const source of files) {
    for (const specifier of moduleSpecifiers(source)) {
      if (isModuleMockCall(specifier.parent) && ts8.isPropertyAccessExpression(specifier.parent.expression) && !["importActual", "importMock", "requireActual", "requireMock"].includes(specifier.parent.expression.name.text))
        continue;
      const mode = ts8.getModeForUsageLocation(source, specifier, context.options);
      const target = ts8.resolveModuleName(specifier.text, source.fileName, context.options, ts8.sys, cache, undefined, mode).resolvedModule;
      if (!target)
        continue;
      const key = resolve10(target.resolvedFileName);
      if (!callers.has(key))
        callers.set(key, new Set);
      callers.get(key).add(resolve10(source.fileName));
    }
  }
  const reached = new Set(affected.map((source) => resolve10(source.fileName)));
  const queue = [...reached];
  for (let index = 0;index < queue.length; index++) {
    for (const caller of callers.get(queue[index]) ?? []) {
      if (reached.has(caller))
        continue;
      reached.add(caller);
      queue.push(caller);
    }
  }
  return files.filter((source) => reached.has(resolve10(source.fileName)) && mockCalls(source, from).length).map((source) => source.fileName).sort();
}
function addParallelMocks(context, files, request) {
  const added = [];
  for (const file of files) {
    const source = context.service.getProgram().getSourceFile(file);
    if (mockCalls(source, request.to).length)
      continue;
    const edits = [];
    for (const call of mockCalls(source, request.from)) {
      const statement = call.parent;
      if (!ts8.isExpressionStatement(statement) || !ts8.isSourceFile(statement.parent) && !ts8.isBlock(statement.parent)) {
        fail("UNSUPPORTED_MOCK_CALL", `${file}: --mocks add requires standalone mock statements in a source file or block; use --mocks report`);
      }
      const specifier = call.arguments[0];
      const mode = ts8.getModeForUsageLocation(source, specifier, context.options);
      if (!ts8.resolveModuleName(request.to, file, context.options, ts8.sys, undefined, undefined, mode).resolvedModule) {
        fail("TARGET_UNRESOLVED", `${file} (${request.to})`);
      }
      const start = call.getStart(source);
      const quote = source.text[specifier.getStart(source)];
      const escaped = JSON.stringify(request.to).slice(1, -1);
      const literal2 = quote === '"' ? JSON.stringify(request.to) : quote + escaped.replaceAll(quote, (match) => `\\${match}`).replaceAll("${", quote === "`" ? "\\${" : "${") + quote;
      const text2 = source.text.slice(start, specifier.getStart(source)) + literal2 + source.text.slice(specifier.end, call.end);
      const indent = source.text.slice(source.text.lastIndexOf(`
`, statement.getStart(source)) + 1, statement.getStart(source)).match(/^[\t ]*/)?.[0] ?? "";
      const tail = source.text.slice(statement.end);
      const trivia = /^(?:[\t ]|\/\*[^]*?\*\/)*(?:\/\/[^\r\n]*)?(?=\r?\n|$)/.exec(tail)?.[0];
      const end = statement.end + (trivia?.length ?? 0);
      const prefix = trivia === undefined && !source.text.slice(statement.getStart(source), statement.end).endsWith(";") ? ";" : "";
      edits.push({ start: end, text: `${prefix}${eolOf(source.text)}${indent}${text2};` });
    }
    let text = source.text;
    for (const edit of edits.sort((a, b) => b.start - a.start))
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.start);
    if (edits.length) {
      context.setText(file, text);
      added.push(file);
    }
  }
  return added;
}
var init_typescript_retarget_mocks = __esm(() => {
  init_typescript_vfs();
  init_typescript_workspace();
});

// src/backends/typescript-retarget-import.ts
import ts9 from "typescript";
import { statSync as statSync3 } from "node:fs";
import { resolve as resolve11 } from "node:path";
function identifier(name) {
  const scanner = ts9.createScanner(ts9.ScriptTarget.Latest, false, ts9.LanguageVariant.Standard, name);
  return scanner.scan() === ts9.SyntaxKind.Identifier && scanner.getTokenText() === name && scanner.scan() === ts9.SyntaxKind.EndOfFileToken;
}
function mappedName(request, name) {
  return request?.map && Object.hasOwn(request.map, name) ? request.map[name] : undefined;
}
function validate(request) {
  if (!request.from || !request.to)
    fail("INVALID_REQUEST", "retarget-import requires from and to");
  if (request.from.includes("*") || request.to.includes("*"))
    fail("UNSUPPORTED_SPECIFIER", "retarget-import requires exact specifiers; wildcard prefixes are unsupported");
  if (request.from === request.to)
    fail("INVALID_REQUEST", "from and to must differ");
  if (request.mocks !== undefined && !["report", "add"].includes(request.mocks))
    fail("INVALID_REQUEST", "mocks must be report or add");
  if (request.only && (!Array.isArray(request.only) || !request.only.length || request.only.some((name) => !name))) {
    fail("INVALID_REQUEST", "only must contain pre-map export names");
  }
  for (const [from, to] of Object.entries(request.map ?? {})) {
    if (!identifier(from) || !identifier(to))
      fail("INVALID_NAME", `invalid export mapping ${from}=${to}`);
  }
}
function members(node) {
  if (ts9.isImportDeclaration(node)) {
    const bindings = node.importClause?.namedBindings;
    return bindings && ts9.isNamedImports(bindings) ? bindings.elements : undefined;
  }
  return node.exportClause && ts9.isNamedExports(node.exportClause) ? node.exportClause.elements : undefined;
}
function selections(source, request) {
  const found = [];
  for (const node of source.statements) {
    if (!ts9.isImportDeclaration(node) && !ts9.isExportDeclaration(node) || !node.moduleSpecifier || !ts9.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== request.from)
      continue;
    const list = members(node);
    if (request.only && ts9.isImportDeclaration(node) && (node.importClause?.name || node.importClause?.namedBindings && ts9.isNamespaceImport(node.importClause.namedBindings))) {
      fail("UNSUPPORTED_SELECTION", `${source.fileName}: --only cannot select default or namespace imports`);
    }
    const selected = list?.filter((item) => !request.only || request.only.includes((item.propertyName ?? item.name).text));
    if (request.only && !selected?.length)
      continue;
    found.push({ declaration: node, target: request.to, members: selected });
  }
  return found;
}
function selectedFiles(context, request) {
  const scope = resolve11(request.file);
  if (!isInside(context.root, scope))
    fail("OUTSIDE_ROOT", scope);
  let directory = true;
  if (!request.projectScope) {
    try {
      directory = statSync3(scope).isDirectory();
    } catch {
      fail("FILE_NOT_FOUND", scope);
    }
  }
  const files = context.service.getProgram().getSourceFiles().filter((source) => !context.service.getProgram().isSourceFileDefaultLibrary(source) && !source.fileName.replaceAll("\\", "/").includes("/node_modules/") && isInside(context.root, resolve11(source.fileName)) && (request.projectScope || (directory ? isInside(scope, resolve11(source.fileName)) : resolve11(source.fileName) === scope)));
  if (!directory && !files.length)
    fail("FILE_NOT_IN_PROJECT", scope);
  return files.sort((a, b) => a.fileName.localeCompare(b.fileName));
}
function renameBindings(context, file, request) {
  const renamed = new Set;
  for (;; ) {
    const source = context.service.getProgram().getSourceFile(file);
    const match = selections(source, request).flatMap((selection, index) => (selection.members ?? []).map((member) => ({
      item: member,
      key: `${index}:${members(selection.declaration).indexOf(member)}`
    }))).find(({ item: item2 }) => ts9.isImportSpecifier(item2) && !item2.propertyName && mappedName(request, item2.name.text) && mappedName(request, item2.name.text) !== item2.name.text);
    if (!match)
      return renamed;
    const { item, key } = match;
    renamed.add(key);
    const end = item.name.end;
    context.setText(file, source.text.slice(0, end) + ` as ${item.name.text}` + source.text.slice(end));
    context.rename(file, end + 4, mappedName(request, item.name.text));
  }
}
function replace(text, edits) {
  let boundary = text.length;
  for (const edit of edits.sort((a, b) => b.span.start - a.span.start)) {
    const end = edit.span.start + edit.span.length;
    if (end > boundary)
      fail("OVERLAPPING_EDITS", "retarget-import declarations overlap");
    text = text.slice(0, edit.span.start) + edit.newText + text.slice(end);
    boundary = edit.span.start;
  }
  return text;
}
function memberText(source, list, item, request, collapseAlias = false) {
  const index = list.indexOf(item);
  const limit = list[index + 1]?.pos ?? item.parent.end - 1;
  let raw = source.text.slice(item.pos, limit);
  const edits = [];
  const scanner = ts9.createScanner(ts9.ScriptTarget.Latest, false, ts9.LanguageVariant.Standard, raw);
  while (scanner.scan() !== ts9.SyntaxKind.EndOfFileToken) {
    if (scanner.getToken() === ts9.SyntaxKind.CommaToken)
      edits.push({ span: { start: scanner.getTokenPos(), length: 1 }, newText: "" });
  }
  const imported = item.propertyName ?? item.name;
  const mapped = mappedName(request, imported.text);
  if (mapped && mapped !== imported.text) {
    edits.push({ span: { start: imported.getStart(source) - item.pos, length: imported.end - imported.getStart(source) }, newText: mapped });
    if (collapseAlias && ts9.isImportSpecifier(item) && item.propertyName && item.name.text === mapped) {
      const between = source.text.slice(item.propertyName.end, item.name.end);
      if (!between.includes("/*") && !between.includes("//"))
        edits.push({ span: { start: item.propertyName.end - item.pos, length: item.name.end - item.propertyName.end }, newText: "" });
    }
  }
  raw = replace(raw, edits).trim();
  return raw.includes("//") ? raw + (source.text.includes(`\r
`) ? `\r
` : `
`) : raw;
}
function memberTokens(text) {
  const tokens = [], comments = [];
  const scanner = ts9.createScanner(ts9.ScriptTarget.Latest, false, ts9.LanguageVariant.Standard, text);
  while (scanner.scan() !== ts9.SyntaxKind.EndOfFileToken) {
    const kind = scanner.getToken();
    if (kind === ts9.SyntaxKind.SingleLineCommentTrivia)
      comments.push(scanner.getTokenText() + (text.includes(`\r
`) ? `\r
` : `
`));
    else if (kind === ts9.SyntaxKind.MultiLineCommentTrivia)
      comments.push(scanner.getTokenText() + " ");
    else if (kind > ts9.SyntaxKind.LastTriviaToken)
      tokens.push(scanner.getTokenText());
  }
  return { key: JSON.stringify(tokens), comments: comments.join("") };
}
function mergeMembers(existing, moved) {
  for (const text of moved) {
    const { key, comments } = memberTokens(text);
    const index = existing.findIndex((item) => memberTokens(item).key === key);
    if (index < 0)
      existing.push(text);
    else if (comments)
      existing[index] = comments + existing[index];
  }
}
function namedText(items) {
  return `{ ${items.join(", ")} }`;
}
function typeOnly(node) {
  return ts9.isImportDeclaration(node) ? !!node.importClause?.isTypeOnly : node.isTypeOnly;
}
function attributes(node, source) {
  return node.attributes?.getText(source) ?? "";
}
function outerComments(source, node, named) {
  const start = node.getStart(source), text = node.getText(source);
  const outside = text.slice(0, named.getStart(source) - start) + text.slice(named.end - start);
  return memberTokens(outside).comments;
}
function transformFile(source, request, renamed) {
  const replacements = new Map;
  const additions = new Map;
  const newline = source.text.includes(`\r
`) ? `\r
` : `
`;
  for (const [index, selection] of selections(source, request).entries()) {
    const node = selection.declaration, module = node.moduleSpecifier;
    const list = members(node), chosen = selection.members;
    const quote = source.text[module.getStart(source)];
    const literal2 = quote + selection.target.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`) + quote;
    const edit = [{ span: { start: module.getStart(source) - node.getStart(source), length: module.getWidth(source) }, newText: literal2 }];
    if (!list || !chosen?.length) {
      replacements.set(node, replace(node.getText(source), edit));
      continue;
    }
    const remaining = list.filter((item) => !chosen.includes(item));
    const moved = chosen.map((item) => memberText(source, list, item, request, renamed.has(`${index}:${list.indexOf(item)}`)));
    const named = list[0].parent;
    const pureNamed = ts9.isImportDeclaration(node) && !node.importClause?.name;
    const merge = pureNamed ? source.statements.find((other) => ts9.isImportDeclaration(other) && ts9.isStringLiteral(other.moduleSpecifier) && other.moduleSpecifier.text === selection.target && !!other.importClause && (!other.importClause.namedBindings || ts9.isNamedImports(other.importClause.namedBindings)) && !(other.importClause.isTypeOnly && other.importClause.name) && typeOnly(other) === typeOnly(node) && attributes(other, source) === attributes(node, source)) : undefined;
    if (merge) {
      const existing = members(merge) ?? [];
      const texts = additions.get(merge) ?? existing.map((item) => memberText(source, existing, item));
      mergeMembers(texts, moved);
      additions.set(merge, texts);
    }
    if (remaining.length) {
      const original = replace(node.getText(source), [{ span: { start: named.getStart(source) - node.getStart(source), length: named.getWidth(source) }, newText: namedText(remaining.map((item) => memberText(source, list, item))) }]);
      const kind = ts9.isImportDeclaration(node) ? "import" : "export";
      const suffix = source.text.slice(module.end, node.end);
      replacements.set(node, original + (merge ? "" : `${newline}${kind}${typeOnly(node) ? " type" : ""} ${namedText(moved)} from ${literal2}${suffix}`));
    } else if (merge)
      replacements.set(node, outerComments(source, node, named));
    else if (!chosen.some((item) => mappedName(request, (item.propertyName ?? item.name).text))) {
      replacements.set(node, replace(node.getText(source), edit));
    } else {
      edit.push({ span: { start: named.getStart(source) - node.getStart(source), length: named.getWidth(source) }, newText: namedText(moved) });
      replacements.set(node, replace(node.getText(source), edit));
    }
  }
  for (const [node, texts] of additions) {
    const named = node.importClause.namedBindings;
    const start = node.getStart(source);
    const span = named ? { start: named.getStart(source) - start, length: named.getWidth(source) } : { start: node.importClause.name.end - start, length: 0 };
    replacements.set(node, replace(node.getText(source), [{ span, newText: (named ? "" : ", ") + namedText(texts) }]));
  }
  return replace(source.text, [...replacements].map(([node, newText]) => ({ span: { start: node.getStart(source), length: node.getWidth(source) }, newText })));
}
function retargetImports(context, request) {
  validate(request);
  const affected = selectedFiles(context, request).filter((source) => selections(source, request).length);
  const unresolved = [];
  const cache = ts9.createModuleResolutionCache(ts9.sys.getCurrentDirectory(), (path) => path, context.options);
  for (const source of affected) {
    for (const { declaration, target } of selections(source, request)) {
      const mode = ts9.getModeForUsageLocation(source, declaration.moduleSpecifier, context.options);
      if (!ts9.resolveModuleName(target, source.fileName, context.options, ts9.sys, cache, undefined, mode).resolvedModule) {
        unresolved.push(`${source.fileName} (${target})`);
      }
    }
  }
  if (unresolved.length)
    fail("TARGET_UNRESOLVED", [...new Set(unresolved)].sort().join(", ") + installationHint(context.root, affected[0].fileName));
  const mocks = affectedMockFiles(context, affected, request.from);
  if (!request.map || Object.keys(request.map).length === 0) {
    const edits = affected.map((source) => [source.fileName, transformFile(source, request, new Set)]);
    for (const [file, text] of edits)
      context.setText(file, text);
  } else {
    for (const source of affected) {
      const renamed = renameBindings(context, source.fileName, request);
      const current2 = context.service.getProgram().getSourceFile(source.fileName);
      context.setText(source.fileName, transformFile(current2, request, renamed));
    }
  }
  const notes = affected.length ? ["Retargeted imports/re-exports; compiler validation does not prove runtime API compatibility."] : ["No matching imports or re-exports; no changes."];
  if (request.mocks === "add") {
    const added = addParallelMocks(context, mocks, request);
    if (added.length)
      notes.push(`Added parallel mocks for ${request.to} in: ${added.join(", ")}. Review factory runtime compatibility.`);
  } else if (mocks.length) {
    notes.push(`Tests mocking ${request.from} import retargeted files: ${mocks.join(", ")}. Review mocks or use --mocks add.`);
  }
  return notes;
}
var init_typescript_retarget_import = __esm(() => {
  init_typescript_prechecks();
  init_typescript_paths();
  init_typescript_vfs();
  init_typescript_retarget_mocks();
});

// src/backends/typescript.ts
var exports_typescript = {};
__export(exports_typescript, {
  analyze: () => analyze,
  capabilities: () => capabilities,
  setWarmMode: () => setWarmMode
});
import ts10 from "typescript";
import { statSync as statSync4 } from "node:fs";
import { basename as basename4, dirname as dirname11, extname as extname5, isAbsolute as isAbsolute4, resolve as resolve12 } from "node:path";
function setWarmMode(enabled) {
  warmMode = enabled;
  if (!enabled) {
    for (const state of warmProjects.values())
      state.service.dispose();
    warmProjects.clear();
  }
}
function fail2(code, reason) {
  throw new Error(`${code}: ${reason}`);
}
function canonical(path) {
  return resolve12(path);
}
function assertAbsolute2(name, value) {
  if (!isAbsolute4(value))
    fail2("INVALID_REQUEST", `${name} must be an absolute path`);
  return canonical(value);
}
function configPathFor2(project) {
  let stat;
  try {
    stat = statSync4(project);
  } catch {
    fail2("PROJECT_NOT_FOUND", project);
  }
  if (stat.isFile()) {
    if (!["tsconfig.json", "jsconfig.json"].includes(basename4(project))) {
      fail2("UNSUPPORTED_PROJECT", "project must name tsconfig.json or jsconfig.json");
    }
    return project;
  }
  if (!stat.isDirectory())
    fail2("UNSUPPORTED_PROJECT", "project must be a config file or directory");
  const candidates = ["tsconfig.json", "jsconfig.json"].map((name) => resolve12(project, name)).filter(ts10.sys.fileExists);
  if (candidates.length === 0)
    fail2("CONFIG_NOT_FOUND", `no tsconfig.json or jsconfig.json in ${project}`);
  if (candidates.length > 1)
    fail2("MULTIPLE_CONFIGS", `both tsconfig.json and jsconfig.json exist in ${project}`);
  return candidates[0];
}
function loadProject(request) {
  const root = assertAbsolute2("root", request.root);
  const project = assertAbsolute2("project", request.project);
  const configPath = configPathFor2(project);
  if (!isInside(root, configPath))
    fail2("OUTSIDE_ROOT", `project config is outside ${root}`);
  const cacheKey = `${root}\x00${configPath}`;
  const warm = warmProjects.get(cacheKey);
  if (warm && warm.inputs.unchanged())
    return warm;
  if (warm) {
    warm.service.dispose();
    warmProjects.delete(cacheKey);
  }
  const inputs = new CompilerInputs(process.env.REFACTOR_AI_CACHE === "on" || warmMode);
  const parsed = ts10.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...inputs.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      fail2("INVALID_CONFIG", ts10.flattenDiagnosticMessageText(diagnostic.messageText, `
`));
    }
  });
  if (!parsed)
    fail2("INVALID_CONFIG", `could not parse ${configPath}`);
  const configErrors = parsed.errors.filter((diagnostic) => diagnostic.category === ts10.DiagnosticCategory.Error);
  if (configErrors.length)
    fail2("INVALID_CONFIG", ts10.flattenDiagnosticMessageText(configErrors[0].messageText, `
`));
  if (parsed.projectReferences?.length) {
    fail2("PROJECT_REFERENCES_UNSUPPORTED", "project references require more than one configured program");
  }
  const fileNames = parsed.fileNames.map(canonical).sort();
  const overlays = new Map;
  const versions = new Map;
  let projectVersion = 0;
  const host = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => [...new Set([...fileNames, ...overlays.keys()])].sort(),
    getScriptVersion: (fileName) => String(versions.get(canonical(fileName)) ?? 0),
    getScriptSnapshot(fileName) {
      const path = canonical(fileName);
      const text = overlays.get(path) ?? inputs.sys.readFile(path);
      return text === undefined ? undefined : ts10.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => dirname11(configPath),
    getDefaultLibFileName: (options) => ts10.getDefaultLibFilePath(options),
    fileExists: inputs.sys.fileExists,
    readFile: inputs.sys.readFile,
    readDirectory: inputs.sys.readDirectory,
    directoryExists: inputs.sys.directoryExists,
    getDirectories: inputs.sys.getDirectories,
    realpath: inputs.sys.realpath,
    useCaseSensitiveFileNames: () => ts10.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts10.sys.newLine,
    getProjectVersion: () => String(projectVersion)
  };
  const service = ts10.createLanguageService(host, ts10.createDocumentRegistry());
  const state = {
    inputs,
    configPath,
    root,
    fileNames,
    options: parsed.options,
    overlays,
    versions,
    service,
    bumpProjectVersion() {
      projectVersion += 1;
    }
  };
  if (warmMode) {
    if (warmProjects.size >= 4) {
      const [key, oldest] = warmProjects.entries().next().value;
      oldest.service.dispose();
      warmProjects.delete(key);
    }
    warmProjects.set(cacheKey, state);
  }
  return state;
}
function sourceText(state, path) {
  return state.overlays.get(path) ?? ts10.sys.readFile(path);
}
function setOverlay(state, path, text) {
  state.overlays.set(path, text);
  state.versions.set(path, (state.versions.get(path) ?? 0) + 1);
  state.bumpProjectVersion();
}
function applyTextChanges2(text, changes) {
  const ordered = changes.map((change, index) => ({ change, index })).sort((a, b) => b.change.span.start - a.change.span.start || b.index - a.index).map(({ change }) => change);
  let boundary = text.length;
  for (const change of ordered) {
    const end = change.span.start + change.span.length;
    if (change.span.start < 0 || end > text.length)
      fail2("INVALID_EDIT", "TypeScript returned an out-of-bounds edit");
    if (end > boundary)
      fail2("OVERLAPPING_EDITS", "TypeScript returned overlapping edits");
    text = text.slice(0, change.span.start) + change.newText + text.slice(end);
    boundary = change.span.start;
  }
  return text;
}
function applyFileEdits(state, edits) {
  for (const edit of [...edits].sort((a, b) => canonical(a.fileName).localeCompare(canonical(b.fileName)))) {
    const path = canonical(edit.fileName);
    if (!isInside(state.root, path))
      fail2("OUTSIDE_ROOT", `TypeScript proposed a change outside ${state.root}: ${path}`);
    const before = sourceText(state, path);
    if (before === undefined && !edit.isNewFile)
      fail2("MISSING_FILE", path);
    setOverlay(state, path, applyTextChanges2(before ?? "", edit.textChanges));
  }
}
function diagnosticRecord(diagnostic, fallback) {
  return {
    file: diagnostic.file ? canonical(diagnostic.file.fileName) : fallback,
    code: `TS${diagnostic.code}`,
    message: ts10.flattenDiagnosticMessageText(diagnostic.messageText, `
`)
  };
}
function diagnostics(state, program, only) {
  const records = [];
  const add = (diagnostic) => {
    if (diagnostic.category !== ts10.DiagnosticCategory.Error)
      return;
    records.push(diagnosticRecord(diagnostic, state.configPath));
  };
  for (const item of program.getOptionsDiagnostics())
    add(item);
  for (const item of program.getGlobalDiagnostics())
    add(item);
  const programFiles = program.getSourceFiles().map((source) => canonical(source.fileName)).filter((path) => isInside(state.root, path) && !path.includes("/node_modules/")) ?? state.fileNames;
  for (const file of [...new Set(programFiles)].filter((path) => !only || only.has(path)).sort()) {
    const source = program.getSourceFile(file);
    for (const item of program.getSyntacticDiagnostics(source))
      add(item);
    for (const item of program.getSemanticDiagnostics(source))
      add(item);
    if (state.options.declaration || state.options.composite)
      for (const item of program.getDeclarationDiagnostics(source))
        add(item);
  }
  return records.sort((a, b) => a.file.localeCompare(b.file) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
}
function importersByFile(state, program = state.service.getProgram()) {
  const host = ts10.sys;
  const cache = ts10.createModuleResolutionCache(dirname11(state.configPath), (name) => host.useCaseSensitiveFileNames ? name : name.toLowerCase(), state.options);
  const importers2 = new Map;
  const link = (target, importer) => {
    if (!isInside(state.root, target) || target.includes("/node_modules/"))
      return;
    const set = importers2.get(target) ?? new Set;
    set.add(importer);
    importers2.set(target, set);
  };
  for (const source of program.getSourceFiles()) {
    const file = canonical(source.fileName);
    if (!isInside(state.root, file) || file.includes("/node_modules/"))
      continue;
    for (const specifier of moduleSpecifiers(source)) {
      const mode = program.getModeForUsageLocation(source, specifier);
      const resolved = ts10.resolveModuleName(specifier.text, file, state.options, host, cache, undefined, mode).resolvedModule;
      if (resolved)
        link(canonical(resolved.resolvedFileName), file);
    }
    for (const reference of source.referencedFiles)
      link(canonical(resolve12(dirname11(file), reference.fileName)), file);
  }
  return importers2;
}
function hasGlobalEffect(text, path) {
  const source = ts10.createSourceFile(path, text, ts10.ScriptTarget.Latest, false);
  if (!ts10.isExternalModule(source))
    return true;
  const visit = (node) => ts10.isModuleDeclaration(node) && (ts10.isStringLiteral(node.name) || (node.flags & ts10.NodeFlags.GlobalAugmentation) !== 0) || !!ts10.forEachChild(node, visit);
  return visit(source);
}
function affectedFiles(state, importers2, originals) {
  const changed = [...state.overlays.keys()].filter((path) => originals.get(path) !== state.overlays.get(path));
  for (const path of changed) {
    if (!/\.[cm]?[jt]sx?$/i.test(path) || /\.d\.[cm]?ts$/i.test(path))
      return;
    for (const text of [originals.get(path), state.overlays.get(path)])
      if (text !== undefined && hasGlobalEffect(text, path))
        return;
  }
  const affected = new Set;
  const pending = [...changed];
  while (pending.length) {
    const path = pending.pop();
    if (affected.has(path))
      continue;
    affected.add(path);
    pending.push(...importers2.get(path) ?? []);
  }
  return affected;
}
function validatePosition(text, position, label = "position") {
  if (!Number.isInteger(position) || position < 0 || position > text.length) {
    fail2("INVALID_RANGE", `${label} must be a UTF-16 offset within the file`);
  }
  return position;
}
function isValidIdentifier(name, target) {
  const scanner = ts10.createScanner(target, false, ts10.LanguageVariant.Standard, name);
  return scanner.scan() === ts10.SyntaxKind.Identifier && scanner.getTokenText() === name && scanner.scan() === ts10.SyntaxKind.EndOfFileToken;
}
function renameLocationKey(fileName, start, length) {
  return `${canonical(fileName)}\x00${start}\x00${length}`;
}
function mappedRenameLocations(grouped, newName) {
  const mapped = [];
  for (const [fileName, fileLocations] of grouped) {
    let delta = 0;
    const ordered = [...fileLocations].sort((a, b) => a.textSpan.start - b.textSpan.start);
    for (const location of ordered) {
      const prefixLength = location.prefixText?.length ?? 0;
      const replacementLength = prefixLength + newName.length + (location.suffixText?.length ?? 0);
      const item = {
        fileName,
        start: location.textSpan.start + delta + prefixLength,
        length: newName.length
      };
      mapped.push(item);
      delta += replacementLength - location.textSpan.length;
    }
  }
  return mapped;
}
function assertRenameSemantics(state, anchorBefore, grouped, newName) {
  const expected = mappedRenameLocations(grouped, newName);
  let anchor;
  for (const [fileName, fileLocations] of grouped) {
    let delta = 0;
    for (const location of [...fileLocations].sort((a, b) => a.textSpan.start - b.textSpan.start)) {
      const prefixLength = location.prefixText?.length ?? 0;
      if (canonical(anchorBefore.fileName) === fileName && location.textSpan.start === anchorBefore.textSpan.start && location.textSpan.length === anchorBefore.textSpan.length) {
        anchor = { fileName, start: location.textSpan.start + delta + prefixLength, length: newName.length };
      }
      delta += prefixLength + newName.length + (location.suffixText?.length ?? 0) - location.textSpan.length;
    }
  }
  if (!anchor)
    fail2("RENAME_CONFLICT", "could not map the renamed symbol declaration");
  const after = state.service.findRenameLocations(anchor.fileName, anchor.start, false, false, {
    providePrefixAndSuffixTextForRename: true
  });
  const expectedCounts = new Map;
  for (const location of expected) {
    const key = renameLocationKey(location.fileName, location.start, location.length);
    expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
  }
  const actualCounts = new Map;
  for (const location of after ?? []) {
    const key = renameLocationKey(location.fileName, location.textSpan.start, location.textSpan.length);
    actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
  }
  let missing = 0;
  let additional = 0;
  for (const [key, count] of expectedCounts)
    missing += Math.max(0, count - (actualCounts.get(key) ?? 0));
  for (const [key, count] of actualCounts)
    additional += Math.max(0, count - (expectedCounts.get(key) ?? 0));
  if (missing || additional) {
    fail2("RENAME_CONFLICT", `rename changes symbol binding (${missing} missing, ${additional} additional locations)`);
  }
}
function rename(state, file, request) {
  const text = sourceText(state, file);
  const position = validatePosition(text, request.position);
  if (!request.newName?.trim())
    fail2("INVALID_REQUEST", "newName is required for rename");
  if (!isValidIdentifier(request.newName, state.options.target ?? ts10.ScriptTarget.Latest)) {
    fail2("INVALID_NAME", `${request.newName} is not a valid identifier`);
  }
  const info = state.service.getRenameInfo(file, position, { providePrefixAndSuffixTextForRename: true });
  if (!info.canRename)
    fail2("RENAME_UNAVAILABLE", info.localizedErrorMessage);
  const locations = state.service.findRenameLocations(file, position, false, false, { providePrefixAndSuffixTextForRename: true });
  if (!locations?.length)
    fail2("RENAME_UNAVAILABLE", "TypeScript found no semantic rename locations");
  const definitions = state.service.getDefinitionAndBoundSpan(file, position)?.definitions ?? [];
  const anchor = definitions.map((definition) => locations.find((location) => canonical(location.fileName) === canonical(definition.fileName) && location.textSpan.start === definition.textSpan.start && location.textSpan.length === definition.textSpan.length)).find((location) => location !== undefined) ?? locations.find((location) => canonical(location.fileName) === file && position >= location.textSpan.start && position <= location.textSpan.start + location.textSpan.length) ?? locations[0];
  const grouped = new Map;
  for (const location of locations) {
    const path = canonical(location.fileName);
    if (!isInside(state.root, path))
      fail2("OUTSIDE_ROOT", `rename location is outside ${state.root}: ${path}`);
    const list = grouped.get(path) ?? [];
    list.push(location);
    grouped.set(path, list);
  }
  applyFileEdits(state, [...grouped].map(([fileName, fileLocations]) => ({
    fileName,
    textChanges: fileLocations.map((location) => ({
      span: location.textSpan,
      newText: `${location.prefixText ?? ""}${request.newName}${location.suffixText ?? ""}`
    }))
  })));
  assertRenameSemantics(state, anchor, grouped, request.newName);
}
function imports(state, file, request) {
  if (request.mode !== "sort" && request.mode !== "remove-unused") {
    fail2("INVALID_REQUEST", "imports mode must be sort or remove-unused");
  }
  const mode = request.mode === "sort" ? ts10.OrganizeImportsMode.SortAndCombine : ts10.OrganizeImportsMode.RemoveUnused;
  applyFileEdits(state, state.service.organizeImports({ type: "file", fileName: file, mode }, formatOptions, {}));
}
function format(state, file) {
  const text = sourceText(state, file);
  const edits = state.service.getFormattingEditsForDocument(file, formatOptions);
  setOverlay(state, file, applyTextChanges2(text, edits));
}
function extraction(state, file, request) {
  const text = sourceText(state, file);
  const position = validatePosition(text, request.position);
  const end = validatePosition(text, request.end, "end");
  if (end <= position)
    fail2("INVALID_RANGE", "end must be greater than position");
  if (!request.newName?.trim() || !isValidIdentifier(request.newName, state.options.target ?? ts10.ScriptTarget.Latest)) {
    fail2("INVALID_NAME", "newName must be a valid identifier for extraction");
  }
  const range = { pos: position, end };
  const applicable = state.service.getApplicableRefactors(file, range, {}, "invoked", undefined, false);
  const actionName = request.operation === "extract-function" ? "function_scope_0" : "constant_scope_0";
  const selected = applicable.filter((refactor) => refactor.name === "Extract Symbol").flatMap((refactor) => refactor.actions.map((action) => ({ refactor, action }))).find(({ action }) => action.name === actionName && !action.notApplicableReason);
  if (!selected)
    fail2("REFACTOR_UNAVAILABLE", `TypeScript cannot ${request.operation} for the selected range`);
  const result = state.service.getEditsForRefactor(file, formatOptions, range, selected.refactor.name, selected.action.name, {});
  if (!result || result.notApplicableReason)
    fail2("REFACTOR_UNAVAILABLE", result?.notApplicableReason ?? "TypeScript returned no edits");
  applyFileEdits(state, result.edits);
  if (result.renameLocation === undefined)
    fail2("REFACTOR_UNAVAILABLE", "TypeScript did not provide a semantic rename location for the extraction");
  const renameFile2 = canonical(result.renameFilename ?? file);
  rename(state, renameFile2, { ...request, operation: "rename", file: renameFile2, position: result.renameLocation });
}
function changedFiles(state, originals) {
  return [...state.overlays].filter(([path, after]) => originals.get(path) !== after).sort(([a], [b]) => a.localeCompare(b)).map(([path, after]) => ({ path, before: originals.get(path) ?? null, after }));
}
async function analyze(request) {
  if (request.operation === "rename-file" || request.operation === "move-type" || request.operation === "move-file" || request.operation === "inline-reexports")
    return analyzeFileOperation(request);
  if (request.operation === "sync-namespace") {
    fail2("UNSUPPORTED_OPERATION", "sync-namespace is C# only; ES modules have no namespace-to-directory convention");
  }
  const state = loadProject(request);
  try {
    const file = assertAbsolute2("file", request.file);
    if (!isInside(state.root, file))
      fail2("OUTSIDE_ROOT", `file is outside ${state.root}`);
    const text = request.operation === "retarget-import" ? "" : sourceText(state, file);
    if (text === undefined)
      fail2("FILE_NOT_FOUND", file);
    const extension = extname5(file).toLowerCase();
    if (request.operation !== "retarget-import" && ![".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(extension)) {
      fail2("UNSUPPORTED_FILE", extension || "file has no extension");
    }
    let program = state.service.getProgram();
    if (!program || request.operation !== "retarget-import" && !program.getSourceFile(file))
      fail2("FILE_NOT_IN_PROJECT", file);
    const outsideUserSources = program.getSourceFiles().filter((source) => !isInside(state.root, canonical(source.fileName)) && !source.isDeclarationFile).map((source) => canonical(source.fileName)).sort();
    if (outsideUserSources.length) {
      fail2("PROJECT_SCOPE_INCOMPLETE", `program contains user source outside ${state.root}: ${outsideUserSources.slice(0, 5).join(", ")}${outsideUserSources.length > 5 ? ` and ${outsideUserSources.length - 5} more` : ""}${workspaceRootHint(state.root, outsideUserSources)}`);
    }
    const importers2 = importersByFile(state);
    const originals = new Map;
    for (const path of state.fileNames)
      originals.set(path, sourceText(state, path));
    let operationNotes = [];
    switch (request.operation) {
      case "retarget-import":
        operationNotes = retargetImports({
          service: state.service,
          options: state.options,
          root: state.root,
          setText: (path, text2) => setOverlay(state, path, text2),
          rename: (path, position, newName) => rename(state, path, { ...request, operation: "rename", file: path, position, newName })
        }, request);
        break;
      case "rename":
        rename(state, file, request);
        break;
      case "imports":
        imports(state, file, request);
        break;
      case "format":
        format(state, file);
        break;
      case "extract-function":
      case "extract-variable":
        extraction(state, file, request);
        break;
      default:
        fail2("UNSUPPORTED_OPERATION", String(request.operation));
    }
    for (const path of state.overlays.keys())
      if (!originals.has(path))
        originals.set(path, ts10.sys.readFile(path));
    let afterProgram = state.service.getProgram();
    for (const [target, callers] of importersByFile(state, afterProgram)) {
      importers2.set(target, new Set([...importers2.get(target) ?? [], ...callers]));
    }
    let affected = affectedFiles(state, importers2, originals);
    const beforePaths = new Set(program.getSourceFiles().map((source) => canonical(source.fileName)));
    const afterPaths = new Set(afterProgram.getSourceFiles().map((source) => canonical(source.fileName)));
    for (const source of [...program.getSourceFiles(), ...afterProgram.getSourceFiles()]) {
      const path = canonical(source.fileName);
      if (beforePaths.has(path) !== afterPaths.has(path) && !/\.json$/i.test(path) && hasGlobalEffect(source.text, path))
        affected = undefined;
    }
    const diagnosticsAfter = timed("diagnostics.after", () => diagnostics(state, afterProgram, affected));
    if (diagnosticsAfter.length) {
      state.service.cleanupSemanticCache();
      afterProgram = undefined;
    }
    const diagnosticsBefore = diagnosticsAfter.length ? timed("diagnostics.before", () => baselineDiagnostics(state.root, state.configPath, program, affected, state.inputs, () => diagnostics(state, program, affected))) : [];
    program = undefined;
    const beforeCounts = new Map;
    for (const item of diagnosticsBefore) {
      const key = `${item.file}\x00${item.code}\x00${item.message}`;
      beforeCounts.set(key, (beforeCounts.get(key) ?? 0) + 1);
    }
    const introduced = diagnosticsAfter.filter((item) => {
      const key = `${item.file}\x00${item.code}\x00${item.message}`;
      const count = beforeCounts.get(key) ?? 0;
      if (count === 0)
        return true;
      beforeCounts.set(key, count - 1);
      return false;
    });
    if (introduced.length)
      fail2("NEW_DIAGNOSTICS", introduced.map((item) => `${item.code} ${item.message}`).join("; "));
    const notes = operationNotes;
    if (!diagnosticsAfter.length)
      notes.push("Skipped baseline diagnostics: the planned affected set has no errors.");
    if (affected)
      notes.push(`Validated ${affected.size} affected file(s): the changed files and their transitive importers.`);
    if (request.operation === "imports") {
      notes.push(request.mode === "sort" ? "Sorting imports can reorder module initialization; verify application behavior." : "Removing unused value imports can remove module initialization; bare side-effect imports are retained.");
    }
    if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension) && ["rename", "extract-function", "extract-variable"].includes(request.operation)) {
      notes.push("JavaScript analysis is semantic only for symbols TypeScript can resolve; dynamic properties, reflection, and string-based references are not changed.");
    }
    return {
      backend: "typescript",
      version: ts10.version,
      changes: changedFiles(state, originals),
      diagnosticsBefore,
      diagnosticsAfter,
      notes
    };
  } finally {
    if (warmMode) {
      for (const path of state.overlays.keys())
        state.versions.set(path, (state.versions.get(path) ?? 0) + 1);
      state.overlays.clear();
      state.bumpProjectVersion();
    } else
      state.service.dispose();
  }
}
var capabilities, formatOptions, warmMode = false, warmProjects;
var init_typescript = __esm(() => {
  init_typescript_diagnostics_cache();
  init_typescript_fileops();
  init_typescript_workspace();
  init_typescript_retarget_import();
  init_typescript_paths();
  capabilities = [
    { operation: "rename", description: "Rename a TypeScript or JavaScript symbol across its configured project." },
    { operation: "imports", modes: ["sort", "remove-unused"], description: "Sort imports or explicitly remove unused imports." },
    { operation: "format", description: "Format a source file with the TypeScript formatter." },
    { operation: "extract-function", description: "Extract the selected statements or expression to a named function." },
    { operation: "extract-variable", description: "Extract the selected expression to a named variable." },
    { operation: "retarget-import", description: "Retarget imports and re-exports to an API-compatible module, with optional export mapping." },
    ...fileCapabilities
  ];
  formatOptions = {
    indentSize: 2,
    tabSize: 2,
    newLineCharacter: `
`,
    convertTabsToSpaces: true,
    indentStyle: ts10.IndentStyle.Smart,
    insertSpaceAfterCommaDelimiter: true,
    insertSpaceAfterSemicolonInForStatements: true,
    insertSpaceBeforeAndAfterBinaryOperators: true,
    insertSpaceAfterKeywordsInControlFlowStatements: true,
    insertSpaceAfterFunctionKeywordForAnonymousFunctions: false,
    insertSpaceBeforeFunctionParenthesis: false,
    insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
    semicolons: ts10.SemicolonPreference.Insert
  };
  warmProjects = new Map;
});

// src/backends/csharp.ts
var exports_csharp = {};
__export(exports_csharp, {
  analyze: () => analyze2,
  capabilities: () => capabilities2
});
import { basename as basename5, dirname as dirname12, isAbsolute as isAbsolute5, join as join2, relative as relative9, resolve as resolve13, sep as sep6 } from "node:path";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
async function analyze2(request, toolkitRoot) {
  validateRequest(request);
  const helper = await findOrBuildHelper(toolkitRoot);
  const { stdout, stderr, exitCode, timedOut } = await runDotnet([helper], JSON.stringify(request));
  if (timedOut) {
    throw new Error("CSHARP_HELPER_TIMEOUT: helper exceeded 120 seconds");
  }
  let response;
  try {
    response = JSON.parse(stdout);
  } catch {
    const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    throw new Error(`CSHARP_HELPER_FAILED: ${detail}`);
  }
  if (response.error) {
    throw new Error(`${response.error.code}: ${response.error.message}`);
  }
  if (exitCode !== 0) {
    const detail = stderr.trim() || `exit code ${exitCode}`;
    throw new Error(`CSHARP_HELPER_FAILED: ${detail}`);
  }
  if (!response.result) {
    const detail = stderr.trim() || `helper exited with code ${exitCode}`;
    throw new Error(`CSHARP_PROTOCOL_ERROR: ${detail}`);
  }
  validateResult(response.result, request.root);
  return response.result;
}
function validateRequest(request) {
  for (const [name, value] of [
    ["project", request.project],
    ["root", request.root],
    ["file", request.file]
  ]) {
    if (!isAbsolute5(value)) {
      throw new Error(`INVALID_REQUEST: ${name} must be an absolute path`);
    }
  }
  ensureWithinRoot(request.root, request.project, "project");
  ensureWithinRoot(request.root, request.file, "file");
  if (request.operation === "rename" && (!Number.isInteger(request.position) || request.position < 0 || !request.newName?.trim())) {
    throw new Error("INVALID_REQUEST: rename requires a non-negative position and newName");
  }
  if (request.operation === "imports" && request.mode !== "remove-unused") {
    throw new Error("UNSUPPORTED_OPERATION: C# supports only imports mode remove-unused");
  }
  if (request.operation === "extract-function" || request.operation === "extract-variable") {
    throw new Error(`UNSUPPORTED_OPERATION: C# operation '${request.operation}' is not supported`);
  }
  if (request.position !== undefined && (!Number.isInteger(request.position) || request.position < 0)) {
    throw new Error("INVALID_REQUEST: position must be a non-negative integer");
  }
  if (request.typeName !== undefined && !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(request.typeName)) {
    throw new Error("INVALID_REQUEST: typeName must be a simple C# identifier");
  }
  if (request.rootNamespace !== undefined && request.rootNamespace !== "" && !/^[\p{L}_][\p{L}\p{N}_]*(\.[\p{L}_][\p{L}\p{N}_]*)*$/u.test(request.rootNamespace)) {
    throw new Error("INVALID_REQUEST: rootNamespace must be a dotted C# namespace");
  }
  if (request.operation === "move-type") {
    if (!request.target || !isAbsolute5(request.target) || !request.target.endsWith(".cs")) {
      throw new Error("INVALID_REQUEST: move-type requires an absolute target .cs file path");
    }
    ensureWithinRoot(request.root, request.target, "target");
    if (request.targetProject !== undefined) {
      if (!isAbsolute5(request.targetProject) || !request.targetProject.toLowerCase().endsWith(".csproj")) {
        throw new Error("INVALID_REQUEST: targetProject must be an absolute .csproj path");
      }
      ensureWithinRoot(request.root, request.targetProject, "targetProject");
    }
  } else if (request.target !== undefined || request.targetProject !== undefined) {
    throw new Error("INVALID_REQUEST: target and targetProject are only valid for move-type");
  }
}
function validateResult(result, root) {
  if (result.backend !== "roslyn" || result.version !== "4.12.0") {
    throw new Error("CSHARP_PROTOCOL_ERROR: unexpected helper identity");
  }
  for (const change of result.changes) {
    if (typeof change.path !== "string" || change.before !== null && typeof change.before !== "string" || change.after !== null && typeof change.after !== "string" || change.before === null && change.after === null) {
      throw new Error("CSHARP_PROTOCOL_ERROR: helper returned a malformed change");
    }
    if (!isAbsolute5(change.path)) {
      throw new Error("CSHARP_PROTOCOL_ERROR: helper returned a relative change path");
    }
    ensureWithinRoot(root, change.path, "changed file");
  }
}
function ensureWithinRoot(root, path, label) {
  const difference = relative9(resolve13(root), resolve13(path));
  if (difference === ".." || difference.startsWith(`..${sep6}`) || isAbsolute5(difference)) {
    throw new Error(`OUTSIDE_ROOT: ${label} is outside root: ${path}`);
  }
}
async function findOrBuildHelper(toolkitRoot) {
  const configured = toolkitRoot ?? process.env.REFACTOR_AI_HOME;
  const directory = dirname12(fileURLToPath(import.meta.url));
  const sourceRoot = configured ? resolve13(configured) : resolve13(directory, basename5(directory) === "backends" && basename5(dirname12(directory)) === "src" ? "../.." : "..");
  const dll = helperDll(sourceRoot);
  if (await exists(dll))
    return dll;
  const project = join2(sourceRoot, "dotnet", "RefactorHelper", "RefactorHelper.csproj");
  if (!await exists(project))
    throw new Error("CSHARP_HELPER_NOT_FOUND: the selected toolkit root has no helper; set REFACTOR_AI_HOME to the package root");
  const { stdout, stderr, exitCode, timedOut } = await runDotnet([
    "build",
    project,
    "-c",
    "Release",
    "--nologo",
    "-p:RestoreLockedMode=true"
  ]);
  if (timedOut)
    throw new Error("CSHARP_HELPER_BUILD_TIMEOUT: build exceeded 120 seconds");
  if (exitCode !== 0) {
    throw new Error(`CSHARP_HELPER_BUILD_FAILED: ${(stderr || stdout).trim()}`);
  }
  return helperDll(sourceRoot);
}
function helperDll(root) {
  return join2(root, "dotnet", "RefactorHelper", "bin", "Release", "net8.0", "RefactorHelper.dll");
}
function processEnv() {
  return { ...process.env, DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1" };
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT")
      return false;
    throw error;
  }
}
function runDotnet(args, input) {
  return new Promise((resolveResult, reject) => {
    const child = spawn("dotnet", args, { stdio: ["pipe", "pipe", "pipe"], env: processEnv() });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 120000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`CSHARP_HELPER_FAILED: ${error.message}`));
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") {
        clearTimeout(timeout);
        child.kill("SIGKILL");
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolveResult({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });
    child.stdin.end(input);
  });
}
var capabilities2;
var init_csharp = __esm(() => {
  capabilities2 = [
    {
      operation: "rename",
      description: "Solution-wide semantic symbol rename using Roslyn."
    },
    {
      operation: "format",
      description: "Document formatting using the public Roslyn Formatter API."
    },
    {
      operation: "imports",
      modes: ["remove-unused"],
      description: "Remove unused imports identified by Roslyn's built-in compiler diagnostics."
    },
    {
      operation: "rename-file",
      description: "Rename a file to match its selected top-level type, updating explicit Compile items."
    },
    {
      operation: "sync-namespace",
      description: "Set a file's namespace from RootNamespace and folders, updating references with Roslyn binding checks."
    },
    {
      operation: "move-type",
      description: "Move a top-level type to a new file in the same or another project, updating namespaces, references and project references."
    }
  ];
});

// src/languages.ts
import { extname } from "node:path";
function languageForProject(project) {
  const extension = extname(project).toLowerCase();
  if (extension === ".csproj" || extension === ".sln")
    return "csharp";
  if (extension === ".json")
    return "typescript";
  throw new Error("UNSUPPORTED_PROJECT: use tsconfig/jsconfig.json, .csproj or .sln");
}

// src/backends/load.ts
var loadBackend = async (project, toolkitRoot) => {
  if (languageForProject(project) !== "csharp")
    return Promise.resolve().then(() => (init_typescript(), exports_typescript));
  const backend = await Promise.resolve().then(() => (init_csharp(), exports_csharp));
  return { capabilities: backend.capabilities, analyze: (request) => backend.analyze(request, toolkitRoot) };
};
export {
  loadBackend
};
