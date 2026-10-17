#!/usr/bin/env node
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

// src/backends/typescript-paths.ts
import { isAbsolute as isAbsolute3, relative as relative4, sep as sep4 } from "node:path";
function portablePath(path, separator = sep4) {
  return path.split(separator).join("/");
}
function isInside(root, path) {
  const difference = relative4(root, path);
  return difference !== ".." && !difference.startsWith(`..${sep4}`) && !isAbsolute3(difference);
}
var init_typescript_paths = () => {};

// src/backends/typescript-vfs.ts
import ts from "typescript";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename as basename3, dirname as dirname5, relative as relative5, resolve as resolve6, sep as sep5 } from "node:path";
function fail(code, reason) {
  throw new Error(`${code}: ${reason}`);
}
function swapCase(value) {
  return [...value].map((char) => char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()).join("");
}
function detectCaseSensitivity(root) {
  const probe = [root, ...readdirSync(root).map((name) => resolve6(root, name))].find((path) => swapCase(basename3(path)) !== basename3(path));
  if (!probe)
    return ts.sys.useCaseSensitiveFileNames;
  const swapped = resolve6(dirname5(probe), swapCase(basename3(probe)));
  if (!existsSync(swapped))
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
  const normalized = portablePath(resolve6(basePath, spec));
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
    return basename3(absolute).includes(".") ? dirname5(absolute) : absolute;
  const normalized = portablePath(absolute);
  const end = normalized.lastIndexOf("/", wildcard);
  return end === 2 && /^[A-Za-z]:/.test(normalized) ? normalized.slice(0, 3) : normalized.slice(0, end) || "/";
}

class VirtualFs {
  root;
  caseSensitive;
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
    const normalized = resolve6(path);
    return this.caseSensitive ? normalized : normalized.toLowerCase();
  }
  samePath(a, b) {
    return this.key(a) === this.key(b);
  }
  contains(directory, path) {
    return isInside(this.key(directory), this.key(path));
  }
  setHiddenDirectories(directories) {
    this.hiddenDirectories = directories.map((directory) => resolve6(directory));
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
  rawDisk(path) {
    const key = this.key(path);
    if (!this.disk.has(key)) {
      let text;
      try {
        if (statSync(path).isFile())
          text = readFileSync(path, "utf8");
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
    const overlay = this.suspended ? undefined : this.overlays.get(this.key(path));
    if (overlay)
      return overlay.bom;
    return this.diskText(path)?.startsWith(BOM) ?? false;
  }
  readFile(path) {
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
    this.overlays.set(key, { path: existing?.path ?? resolve6(path), text: text?.startsWith(BOM) ? text.slice(1) : text, bom });
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
    this.generated.set(key, { path: resolve6(path), text });
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    this.version += 1;
  }
  diskEntries(directory) {
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
        const stat2 = statSync(resolve6(directory, name));
        if (stat2.isFile())
          files.push(name);
        else if (stat2.isDirectory())
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
    directory = resolve6(directory);
    const hidden = this.isHidden(directory);
    const files = new Map;
    const directories = new Map;
    if (!hidden) {
      const disk = this.diskEntries(directory);
      for (const name of disk.files) {
        const path = resolve6(directory, name);
        if (!this.isHidden(path) && this.fileExists(path))
          files.set(this.key(path), name);
      }
      for (const name of disk.directories) {
        const path = resolve6(directory, name);
        if (!this.isHidden(path) || this.directoryExists(path))
          directories.set(this.key(path), name);
      }
    }
    for (const path of this.virtualPaths()) {
      if (!this.contains(directory, path) || this.samePath(directory, path))
        continue;
      const rest = relative5(directory, path).split(sep5);
      const child = resolve6(directory, rest[0]);
      if (rest.length === 1)
        files.set(this.key(child), rest[0]);
      else
        directories.set(this.key(child), rest[0]);
    }
    return { files: [...files.values()], directories: [...directories.values()] };
  }
  directoryExists(path) {
    path = resolve6(path);
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
    const key = this.key(path);
    if (this.generated.has(key) || !this.suspended && this.overlays.has(key))
      return resolve6(path);
    try {
      return ts.sys.realpath?.(path) ?? path;
    } catch {
      return path;
    }
  }
  readDirectory(path, extensions, excludes, includes, depth) {
    path = resolve6(path);
    const flags = this.caseSensitive ? "" : "i";
    const includeFiles = includes?.length ? includes.map((spec) => subPattern(spec, path, "files")).map((pattern) => pattern === undefined ? undefined : new RegExp(`^${pattern}$`, flags)) : undefined;
    const includeDirectories = wildcardRegex(includes, path, "directories", flags);
    const exclude = wildcardRegex(excludes, path, "exclude", flags);
    const results = includeFiles ? includeFiles.map(() => []) : [[]];
    const bases = [path];
    for (const base of (includes ?? []).map((spec) => includeBasePath(resolve6(path, spec))).sort()) {
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
        const absolute = resolve6(directory, name);
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
        const absolute = resolve6(directory, name);
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
  init_typescript_paths();
  init_typescript_paths();
  matchers = {
    files: { single: "([^./]|(\\.(?!min\\.js$))?)*", double: `(/${packageFolders}[^/.][^/]*)*?` },
    directories: { single: "[^/]*", double: `(/${packageFolders}[^/.][^/]*)*?` },
    exclude: { single: "[^/]*", double: "(/.+?)?" }
  };
});

// src/backends/typescript-workspace.ts
import ts2 from "typescript";
import { readdirSync as readdirSync2, statSync as statSync2 } from "node:fs";
import { basename as basename4, dirname as dirname6, relative as relative6, resolve as resolve7 } from "node:path";
function configPathFor(project) {
  let stat2;
  try {
    stat2 = statSync2(project);
  } catch {
    fail("PROJECT_NOT_FOUND", project);
  }
  if (stat2.isFile()) {
    if (!configName.test(basename4(project)))
      fail("UNSUPPORTED_PROJECT", "project must name a tsconfig*.json or jsconfig*.json file");
    return resolve7(project);
  }
  if (!stat2.isDirectory())
    fail("UNSUPPORTED_PROJECT", "project must be a config file or directory");
  const candidates = ["tsconfig.json", "jsconfig.json"].map((name) => resolve7(project, name)).filter((path) => {
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
      const path = resolve7(directory, name);
      let stat2;
      try {
        stat2 = statSync2(path);
      } catch {
        continue;
      }
      if (stat2.isDirectory()) {
        if (name !== "node_modules" && !name.startsWith("."))
          visit(path);
      } else if (stat2.isFile() && configName.test(name)) {
        found.push(path);
      }
    }
  };
  visit(root);
  return found;
}
function flatten(diagnostic) {
  return ts2.flattenDiagnosticMessageText(diagnostic.messageText, `
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
    return ts2.ScriptKind.TSX;
  if (lower.endsWith(".jsx"))
    return ts2.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(lower))
    return ts2.ScriptKind.JS;
  if (lower.endsWith(".json"))
    return ts2.ScriptKind.JSON;
  return ts2.ScriptKind.TS;
}
function moduleSpecifiers(sourceFile) {
  const found = [];
  const seen = new Set;
  const isJs = /\.[cm]?jsx?$/i.test(sourceFile.fileName);
  const visit = (node) => {
    if (seen.has(node))
      return;
    seen.add(node);
    if ((ts2.isImportDeclaration(node) || ts2.isExportDeclaration(node)) && node.moduleSpecifier && ts2.isStringLiteralLike(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier);
    } else if (ts2.isExternalModuleReference(node) && ts2.isStringLiteralLike(node.expression)) {
      found.push(node.expression);
    } else if (ts2.isCallExpression(node) && node.arguments.length >= 1 && ts2.isStringLiteralLike(node.arguments[0]) && (node.expression.kind === ts2.SyntaxKind.ImportKeyword || ts2.isIdentifier(node.expression) && node.expression.text === "require")) {
      found.push(node.arguments[0]);
    } else if (ts2.isImportTypeNode(node) && ts2.isLiteralTypeNode(node.argument) && ts2.isStringLiteralLike(node.argument.literal)) {
      found.push(node.argument.literal);
    }
    if (isJs)
      for (const doc of ts2.getJSDocCommentsAndTags(node))
        visit(doc);
    ts2.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found.sort((a, b) => a.getStart(sourceFile) - b.getStart(sourceFile));
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
    const vfs = this.vfs;
    const host = {
      getCompilationSettings: () => this.editOptions,
      getScriptFileNames: () => this.unionFiles(),
      getScriptVersion: (fileName) => vfs.scriptVersion(fileName),
      getScriptSnapshot: (fileName) => {
        const text = vfs.readFile(fileName);
        return text === undefined ? undefined : ts2.ScriptSnapshot.fromString(text);
      },
      getScriptKind: (fileName) => scriptKindFor(fileName),
      getCurrentDirectory: () => dirname6(sourceConfig),
      getDefaultLibFileName: (options) => ts2.getDefaultLibFilePath(options),
      fileExists: (path) => vfs.fileExists(path),
      readFile: (path) => vfs.readFile(path),
      readDirectory: (path, extensions, excludes, includes, depth) => vfs.readDirectory(path, extensions, excludes, includes, depth),
      directoryExists: (path) => vfs.directoryExists(path),
      getDirectories: (path) => vfs.getDirectories(path),
      realpath: (path) => vfs.realpath(path),
      useCaseSensitiveFileNames: () => vfs.caseSensitive,
      getNewLine: () => `
`,
      getProjectVersion: () => String(vfs.version)
    };
    this.service = ts2.createLanguageService(host, ts2.createDocumentRegistry(vfs.caseSensitive));
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
    const host = useDisk ? { ...ts2.sys, onUnRecoverableConfigFileDiagnostic: onError } : this.vfs.parseConfigHost(onError);
    const parsed = ts2.getParsedCommandLineOfConfigFile(configPath, undefined, host);
    if (!parsed)
      fail("INVALID_CONFIG", `could not parse ${configPath}`);
    const errors = parsed.errors.filter((diagnostic) => diagnostic.category === ts2.DiagnosticCategory.Error);
    if (planned && errors.some((diagnostic) => diagnostic.code === 18003)) {
      fail("PROJECT_WOULD_BE_EMPTY", `${configPath} would no longer include any source file`);
    }
    if (errors.length)
      fail("INVALID_CONFIG", `${configPath}: ${flatten(errors[0])}`);
    return parsed;
  }
  rawReferences(configPath) {
    const result = ts2.readConfigFile(configPath, (path) => this.vfs.readFile(path));
    const references = result.config?.references;
    if (!Array.isArray(references))
      return [];
    return references.map((reference) => typeof reference?.path === "string" ? resolve7(ts2.resolveProjectReferencePath({ path: resolve7(dirname6(configPath), reference.path) })) : undefined).filter((path) => path !== undefined);
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
    const graphDirectories = new Set([...affected].map((key) => vfs.key(dirname6(paths.get(key)))));
    const observers = new Set;
    for (const config of this.discovered) {
      if (affected.has(vfs.key(config)) || editorConfigName.test(basename4(config)) || this.isBaseConfig(config))
        continue;
      if (!graphDirectories.has(vfs.key(dirname6(config))) || !this.listsAny(config, this.affected))
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
        pending.push(resolve7(ts2.resolveProjectReferencePath(reference)));
    }
    for (const [key, parsed] of diskParsed) {
      const configPath = paths.get(key);
      if (parsed.options.outFile)
        fail("UNSUPPORTED_PROJECT", `${configPath}: outFile bundles are not supported`);
      const references = (parsed.projectReferences ?? []).map((reference) => resolve7(ts2.resolveProjectReferencePath(reference)));
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
      if (!isInside(this.root, output) || vfs.samePath(output, dirname6(item.configPath)) || vfs.contains(output, dirname6(item.configPath))) {
        fail("DECLARATION_OUTPUT_UNSUPPORTED", `${item.configPath}: declaration output directory must be a dedicated directory inside ${this.root}`);
      }
      item.outputDirectory = resolve7(output);
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
          fail("PROJECT_OPTIONS_INCOMPATIBLE", `${item.configPath} and ${first.configPath} differ in compiler option '${option}'; cross-project planning requires identical module resolution settings`);
        }
      }
    }
    const configDirectories = new Set(withFiles.map((item) => vfs.key(dirname6(item.configPath))));
    if (configDirectories.size > 1 && first.parsed.options.paths && !first.parsed.options.baseUrl) {
      fail("PROJECT_OPTIONS_INCOMPATIBLE", "'paths' without 'baseUrl' resolves relative to each config; set baseUrl to plan across projects");
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
    return this.participant(config).parsed.fileNames.map((path) => resolve7(path));
  }
  unionFiles() {
    const files = new Map;
    for (const item of this.participants.values())
      for (const path of item.parsed.fileNames)
        files.set(this.vfs.key(path), resolve7(path));
    return [...files.values()].sort();
  }
  program() {
    const program = this.service.getProgram();
    if (!program)
      fail("PROGRAM_UNAVAILABLE", "TypeScript could not create a program");
    return program;
  }
  resolveModule(specifier, sourceFile, options = this.editOptions) {
    const mode = ts2.getModeForUsageLocation(sourceFile, specifier, options);
    return ts2.resolveModuleName(specifier.text, sourceFile.fileName, options, this.vfs.moduleResolutionHost(), undefined, undefined, mode).resolvedModule;
  }
  looseParse(config) {
    const text = this.vfs.readFile(config);
    const cached = this.looseConfigs.get(this.vfs.key(config));
    if (cached && cached.text === text)
      return cached.parsed;
    let parsed;
    try {
      parsed = ts2.getParsedCommandLineOfConfigFile(config, undefined, this.vfs.parseConfigHost(() => {
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
    if (editorConfigName.test(basename4(config)))
      return false;
    if (!this.extendedConfigs) {
      this.extendedConfigs = new Set;
      for (const candidate of this.discovered) {
        const raw = ts2.readConfigFile(candidate, (path) => this.vfs.diskText(path) ?? undefined).config?.extends;
        for (const entry of Array.isArray(raw) ? raw : [raw]) {
          if (typeof entry !== "string" || !/^\.\.?[\\/]/.test(entry))
            continue;
          const path = resolve7(dirname6(candidate), entry);
          this.extendedConfigs.add(this.vfs.key(/\.json$/i.test(path) ? path : `${path}.json`));
        }
      }
    }
    if (!this.extendedConfigs.has(this.vfs.key(config)))
      return false;
    const own = ts2.readConfigFile(config, (path) => this.vfs.diskText(path) ?? undefined).config;
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
    const program = ts2.createProgram({
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
          if (hit && editorConfigName.test(basename4(config))) {
            fail("UNHANDLED_PROJECT_GRAPH", `${config} also includes ${hit} but is not connected to ${this.sourceConfig} by project references`);
          }
          if (hit) {
            fail("UNHANDLED_PROJECT_GRAPH", `${config} also includes ${hit} but is neither a project in the planned graph nor a variant next to one; it would not be updated or validated`);
          }
        }
        if (checkImports && this.importsAffected(config, paths)) {
          fail("UNHANDLED_PROJECT_GRAPH", `${config} imports a changed file (${paths.map((path) => relative6(this.root, path)).join(", ")}) but was not part of the planned project graph`);
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
    const file = ts2.createSourceFile(fileName, text, settings, false, scriptKindFor(fileName));
    this.sourceFiles.set(key, { text, file });
    return file;
  }
  compilerHost(configPath, options) {
    const vfs = this.vfs;
    return {
      getSourceFile: (fileName, settings) => this.sourceFile(fileName, settings, options),
      getDefaultLibFileName: (options2) => ts2.getDefaultLibFilePath(options2),
      writeFile: () => {},
      getCurrentDirectory: () => dirname6(configPath),
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
  diagnostics() {
    const vfs = this.vfs;
    vfs.clearGenerated();
    this.layouts = new Map;
    const referenced = new Set([...this.participants.values()].flatMap((item) => item.references.map((path) => vfs.key(path))));
    const merged = new Map;
    for (const key of this.order) {
      const item = this.participants.get(key);
      const program = ts2.createProgram({
        rootNames: item.parsed.fileNames,
        options: item.parsed.options,
        projectReferences: item.parsed.projectReferences,
        host: this.compilerHost(item.configPath, item.parsed.options)
      });
      const counts = new Map;
      const add = (diagnostic) => {
        if (diagnostic.category !== ts2.DiagnosticCategory.Error)
          return;
        const record = {
          file: diagnostic.file ? resolve7(diagnostic.file.fileName) : item.configPath,
          code: `TS${diagnostic.code}`,
          message: flatten(diagnostic)
        };
        const recordKey = `${record.file}\x00${record.code}\x00${record.message}`;
        const entry = counts.get(recordKey) ?? { record, count: 0 };
        entry.count += 1;
        counts.set(recordKey, entry);
      };
      program.getOptionsDiagnostics().forEach(add);
      program.getGlobalDiagnostics().forEach(add);
      for (const sourceFile of program.getSourceFiles()) {
        const path = resolve7(sourceFile.fileName);
        if (!isInside(this.root, path)) {
          if (!sourceFile.isDeclarationFile)
            fail("PROJECT_SCOPE_INCOMPLETE", `${item.configPath} uses user source outside ${this.root}: ${path}`);
          continue;
        }
        if (portablePath(path).split("/").includes("node_modules") || vfs.isHidden(path))
          continue;
        program.getSyntacticDiagnostics(sourceFile).forEach(add);
        program.getSemanticDiagnostics(sourceFile).forEach(add);
        if (item.parsed.options.declaration || item.parsed.options.composite)
          program.getDeclarationDiagnostics(sourceFile).forEach(add);
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
    const directories = program.getSourceFiles().filter((sourceFile) => !sourceFile.isDeclarationFile && !program.isSourceFileFromExternalLibrary(sourceFile)).filter((sourceFile) => !(options.noEmitForJsFiles && /\.[cm]?jsx?$/i.test(sourceFile.fileName))).filter((sourceFile) => !/\.json$/i.test(sourceFile.fileName) || options.outDir).map((sourceFile) => portablePath(dirname6(resolve7(sourceFile.fileName))).split("/"));
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
      const json = ts2.parseJsonText(item.configPath, text);
      const object = json.statements[0]?.expression;
      if (!object || !ts2.isObjectLiteralExpression(object))
        continue;
      const directory = dirname6(item.configPath);
      const changes = [];
      for (const property of object.properties) {
        if (!ts2.isPropertyAssignment(property) || !ts2.isStringLiteral(property.name))
          continue;
        if (!["files", "include"].includes(property.name.text) || !ts2.isArrayLiteralExpression(property.initializer))
          continue;
        const elements = property.initializer.elements;
        elements.forEach((element, index) => {
          if (!ts2.isStringLiteral(element) || /[*?]/.test(element.text))
            return;
          const absolute = resolve7(directory, element.text);
          const start = element.getStart(json);
          const rename2 = configRenames.find(([from]) => vfs.samePath(from, absolute));
          if (rename2) {
            const relativePath = portablePath(relative6(directory, rename2[1]));
            const spec = element.text.startsWith("./") && !relativePath.startsWith("../") ? `./${relativePath}` : relativePath;
            const quote = text[start];
            changes.push({ span: { start, length: element.end - start }, newText: `${quote}${JSON.stringify(spec).slice(1, -1)}${quote}` });
          } else if (deletions.some((path) => vfs.samePath(path, absolute))) {
            const span = index < elements.length - 1 ? { start, length: elements[index + 1].getStart(json) - start } : index > 0 ? { start: elements[index - 1].end, length: element.end - elements[index - 1].end } : { start, length: element.end - start };
            changes.push({ span, newText: "" });
          }
        });
      }
      if (changes.length)
        vfs.write(item.configPath, applyTextChanges(text, changes));
    }
  }
  addToFiles(configPath, path) {
    const text = this.vfs.readFile(configPath);
    const json = ts2.parseJsonText(configPath, text);
    const object = json.statements[0]?.expression;
    if (!object || !ts2.isObjectLiteralExpression(object))
      return false;
    const files = object.properties.find((property) => ts2.isPropertyAssignment(property) && ts2.isStringLiteral(property.name) && property.name.text === "files");
    if (!files || !ts2.isArrayLiteralExpression(files.initializer))
      return false;
    const elements = files.initializer.elements;
    const relativePath = portablePath(relative6(dirname6(configPath), path));
    const dotted = elements.some((element) => ts2.isStringLiteral(element) && element.text.startsWith("./"));
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
var baseFormatOptions, configName, editorConfigName, sharedOptionKeys;
var init_typescript_workspace = __esm(() => {
  init_typescript_vfs();
  init_typescript_paths();
  baseFormatOptions = {
    indentSize: 2,
    tabSize: 2,
    newLineCharacter: `
`,
    convertTabsToSpaces: true,
    indentStyle: ts2.IndentStyle.Smart,
    insertSpaceAfterCommaDelimiter: true,
    insertSpaceAfterSemicolonInForStatements: true,
    insertSpaceBeforeAndAfterBinaryOperators: true,
    insertSpaceAfterKeywordsInControlFlowStatements: true,
    insertSpaceAfterFunctionKeywordForAnonymousFunctions: false,
    insertSpaceBeforeFunctionParenthesis: false,
    insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
    semicolons: ts2.SemicolonPreference.Insert
  };
  configName = /^(tsconfig|jsconfig)(\..+)?\.json$/;
  editorConfigName = /^(tsconfig|jsconfig)\.json$/;
  sharedOptionKeys = [
    "module",
    "moduleResolution",
    "moduleDetection",
    "baseUrl",
    "paths",
    "rootDirs",
    "allowJs",
    "jsx",
    "jsxImportSource",
    "esModuleInterop",
    "allowSyntheticDefaultImports",
    "resolveJsonModule",
    "resolvePackageJsonExports",
    "resolvePackageJsonImports",
    "customConditions",
    "moduleSuffixes",
    "allowImportingTsExtensions",
    "rewriteRelativeImportExtensions",
    "allowArbitraryExtensions",
    "verbatimModuleSyntax",
    "preserveSymlinks",
    "experimentalDecorators",
    "typeRoots"
  ];
});

// src/backends/typescript-fileops.ts
import ts3 from "typescript";
import { existsSync as existsSync2, readdirSync as readdirSync3 } from "node:fs";
import { dirname as dirname7, extname as extname2, isAbsolute as isAbsolute4, relative as relative7, resolve as resolve8, sep as sep6 } from "node:path";
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
  if (!value || !isAbsolute4(value))
    fail("INVALID_REQUEST", `${name} must be an absolute path`);
  return resolve8(value);
}
function sourceExtension(path) {
  if (/\.d(\.[^./]+)?\.[cm]?ts$/i.test(path))
    fail("UNSUPPORTED_FILE", "declaration files cannot be renamed or moved");
  const extension = extname2(path);
  if (![...tsExtensions, ...jsExtensions].includes(extension))
    fail("UNSUPPORTED_FILE", extension || "file has no extension");
  return extension;
}
function formatFor(text) {
  return { ...baseFormatOptions, newLineCharacter: eolOf(text) };
}
function declaredTypes(sourceFile, isJs) {
  return sourceFile.statements.filter((statement) => {
    if (ts3.isClassDeclaration(statement))
      return statement.name !== undefined;
    return !isJs && (ts3.isInterfaceDeclaration(statement) || ts3.isTypeAliasDeclaration(statement) || ts3.isEnumDeclaration(statement));
  });
}
function namespaceMembers(sourceFile) {
  const names = new Set;
  const visit = (node) => {
    if (ts3.isModuleDeclaration(node)) {
      names.add(node.name.text);
      if (node.body)
        ts3.forEachChild(node.body, visit);
    } else if ((ts3.isClassDeclaration(node) || ts3.isInterfaceDeclaration(node) || ts3.isTypeAliasDeclaration(node) || ts3.isEnumDeclaration(node)) && node.name) {
      names.add(node.name.text);
    } else if (ts3.isModuleBlock(node)) {
      ts3.forEachChild(node, visit);
    }
  };
  for (const statement of sourceFile.statements)
    if (ts3.isModuleDeclaration(statement))
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
    if (statement && ts3.isModuleDeclaration(statement))
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
  let current = root;
  for (const part of relative7(root, path).split(sep6)) {
    let names;
    try {
      names = readdirSync3(current);
    } catch {
      return;
    }
    const next = resolve8(current, part);
    if (!names.includes(part)) {
      if (existsSync2(next)) {
        const actual = names.find((name) => name.toLowerCase() === part.toLowerCase()) ?? "an existing entry";
        fail("CASE_COLLISION", `${next} differs only in case from ${actual}; this volume is case-insensitive and the change could overwrite data`);
      }
      return;
    }
    current = next;
  }
}
function parseFile(ws, path) {
  const text = ws.vfs.readFile(path);
  if (text === undefined)
    return;
  const impliedNodeFormat = ts3.getImpliedNodeFormatForFile(path, undefined, ws.vfs.moduleResolutionHost(), ws.editOptions);
  return ts3.createSourceFile(path, text, { languageVersion: ts3.ScriptTarget.Latest, impliedNodeFormat }, true, scriptKindFor(path));
}
function userFiles(ws) {
  return ws.unionFiles().filter((path) => isInside(ws.root, path) && !path.split(sep6).includes("node_modules"));
}
function applyEdits(context, edits, newFile) {
  const { ws } = context;
  for (const edit of [...edits].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    const path = resolve8(edit.fileName);
    if (!isInside(ws.root, path))
      fail("OUTSIDE_ROOT", `TypeScript proposed a change outside ${ws.root}: ${path}`);
    if (path.split(sep6).includes("node_modules") || ws.vfs.isHidden(path))
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
    if (gains && !expected.includes(vfs.key(gains.path))) {
      const must = gains.must.some((item) => vfs.samePath(item, config));
      if (must || gains.may.some((item) => vfs.samePath(item, config)) && actual.includes(vfs.key(gains.path)))
        expected.push(vfs.key(gains.path));
    }
    expected.sort();
    const added = actual.filter((key) => !expected.includes(key));
    const missing = expected.filter((key) => !actual.includes(key));
    if (added.length || missing.length) {
      fail("PROJECT_MEMBERSHIP_CHANGED", `${config} would ${[
        added.length ? `gain ${added.join(", ")}` : "",
        missing.length ? `lose ${missing.join(", ")}` : ""
      ].filter(Boolean).join(" and ")}; adjust include/files patterns or choose another target`);
    }
  }
}
function importers(ws, path) {
  const found = [];
  for (const file of userFiles(ws)) {
    const sourceFile = parseFile(ws, file);
    if (!sourceFile)
      continue;
    for (const specifier of moduleSpecifiers(sourceFile)) {
      const resolved = ws.resolveModule(specifier, sourceFile);
      if (resolved && ws.vfs.samePath(resolved.resolvedFileName, path))
        found.push(ws.vfs.key(file));
    }
    for (const reference of sourceFile.referencedFiles) {
      if (ws.vfs.samePath(resolve8(dirname7(file), reference.fileName), path))
        found.push(ws.vfs.key(file));
    }
  }
  return found.sort();
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
  for (let current = node;current && !ts3.isSourceFile(current); current = current.parent) {
    if (ts3.isImportSpecifier(current) || ts3.isExportSpecifier(current) || ts3.isImportClause(current) || ts3.isNamespaceImport(current) || ts3.isImportEqualsDeclaration(current))
      return true;
    if (ts3.isStatement(current))
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
    if (ts3.isCallExpression(node) && ts3.isIdentifier(node.expression) && node.expression.text === "require")
      found = true;
    else if (ts3.isPropertyAccessExpression(node) && ts3.isIdentifier(node.expression) && (node.expression.text === "module" && node.name.text === "exports" || node.expression.text === "exports"))
      found = true;
    else if (ts3.isExportAssignment(node) && node.isExportEquals)
      found = true;
    else
      ts3.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
function specifierLike(from, to, original, originalTarget) {
  if (!original.startsWith("./") && !original.startsWith("../")) {
    fail("REEXPORT_UNSUPPORTED", `non-relative specifier '${original}' in ${from} cannot be retargeted deterministically`);
  }
  const written = extname2(original);
  const targetExtension = extname2(to);
  let extension = "";
  if ([...tsExtensions, ...jsExtensions].includes(written)) {
    extension = written === extname2(originalTarget) ? targetExtension : written === ".jsx" && targetExtension === ".tsx" ? ".jsx" : jsEquivalent[targetExtension] ?? targetExtension;
  }
  const path = portablePath(relative7(dirname7(from), to.slice(0, to.length - targetExtension.length))) + extension;
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
      if (!ts3.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts3.isStringLiteral(statement.moduleSpecifier))
        continue;
      const resolved = ws.resolveModule(statement.moduleSpecifier, sourceFile);
      if (!resolved || !ws.vfs.samePath(resolved.resolvedFileName, file))
        continue;
      const specifierStart = statement.moduleSpecifier.getStart(sourceFile);
      const quote = text[specifierStart];
      const literal = `${quote}${specifierLike(path, target, statement.moduleSpecifier.text, file)}${quote}`;
      const typeOnly = statement.isTypeOnly ? "type " : "";
      if (!statement.exportClause) {
        if (sourceDeleted)
          changes.push({ span: { start: specifierStart, length: statement.moduleSpecifier.end - specifierStart }, newText: literal });
        else if (exported)
          changes.push({ span: { start: statement.end, length: 0 }, newText: `${eol}export ${typeOnly}{ ${name} } from ${literal};` });
      } else if (ts3.isNamespaceExport(statement.exportClause)) {
        if (exported)
          fail("REEXPORT_UNSUPPORTED", `${path} re-exports ${file} as namespace '${statement.exportClause.name.getText(sourceFile)}'; moving ${name} would change that namespace`);
      } else {
        const elements = statement.exportClause.elements;
        const moved = elements.filter((element) => (element.propertyName ?? element.name).text === name);
        if (!moved.length)
          continue;
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
      if (!resolved || resolved.isExternalLibraryImport)
        continue;
      const target = resolve8(resolved.resolvedFileName);
      if (!isInside(ws.root, target) || target.split(sep6).includes("node_modules") || ws.vfs.isHidden(target))
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
      const current = pending.pop();
      if (current === to)
        return true;
      if (seen.has(current))
        continue;
      seen.add(current);
      pending.push(...after.get(current) ?? []);
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
  const target = resolve8(dirname7(file), `${name}${extname2(file)}`);
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
    if (ts3.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name)
        names.set(clause.name.text, statement);
      if (clause?.namedBindings && ts3.isNamespaceImport(clause.namedBindings))
        names.set(clause.namedBindings.name.text, statement);
      if (clause?.namedBindings && ts3.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements)
          names.set(element.name.text, statement);
      }
    } else if (ts3.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts3.isIdentifier(declaration.name))
          names.set(declaration.name.text, statement);
      }
    } else if ("name" in statement && statement.name && ts3.isIdentifier(statement.name)) {
      names.set(statement.name.text, statement);
    }
  }
  return names;
}
function assertSafeInitialization(declaration) {
  const reject = () => fail("INITIALIZATION_EFFECTS_UNSUPPORTED", "move-type cannot preserve runtime initialization order for this declaration; static effects, computed names, decorators and evaluated base classes are unsupported");
  const constant = (expression) => {
    if (ts3.isParenthesizedExpression(expression) || ts3.isAsExpression(expression) || ts3.isTypeAssertionExpression(expression) || ts3.isSatisfiesExpression(expression))
      return constant(expression.expression);
    if (ts3.isPrefixUnaryExpression(expression))
      return [ts3.SyntaxKind.PlusToken, ts3.SyntaxKind.MinusToken, ts3.SyntaxKind.ExclamationToken, ts3.SyntaxKind.TildeToken].includes(expression.operator) && constant(expression.operand);
    return ts3.isNumericLiteral(expression) || ts3.isStringLiteral(expression) || ts3.isNoSubstitutionTemplateLiteral(expression) || ts3.isBigIntLiteral(expression) || [ts3.SyntaxKind.TrueKeyword, ts3.SyntaxKind.FalseKeyword, ts3.SyntaxKind.NullKeyword].includes(expression.kind);
  };
  if (ts3.isEnumDeclaration(declaration)) {
    if (declaration.members.some((member) => member.initializer && !constant(member.initializer)))
      reject();
  }
  if (!ts3.isClassDeclaration(declaration))
    return;
  if (ts3.getDecorators(declaration)?.length || declaration.heritageClauses?.some((clause) => clause.token === ts3.SyntaxKind.ExtendsKeyword && clause.types.some((type) => !ts3.isIdentifier(type.expression))))
    reject();
  for (const member of declaration.members) {
    if (ts3.canHaveDecorators(member) && ts3.getDecorators(member)?.length || ts3.isClassStaticBlockDeclaration(member) || member.name && ts3.isComputedPropertyName(member.name))
      reject();
    if (ts3.isConstructorDeclaration(member) && member.parameters.some((parameter) => ts3.getDecorators(parameter)?.length))
      reject();
    if (ts3.isPropertyDeclaration(member) && ts3.getModifiers(member)?.some((modifier) => modifier.kind === ts3.SyntaxKind.StaticKeyword) && member.initializer && !constant(member.initializer))
      reject();
  }
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
  if (!ts3.isExternalModule(sourceFile))
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
  const exported = (ts3.getCombinedModifierFlags(declaration) & ts3.ModifierFlags.Export) !== 0;
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
    if (!ts3.isExternalModule(targetSource2))
      fail("MODULE_REQUIRED", `${target} is not an ES module`);
    if (isJs && usesCommonJs(targetSource2))
      fail("COMMONJS_UNSUPPORTED", `${target} uses CommonJS`);
    const existing = topLevelNames(targetSource2).get(name);
    const importsMoved = existing && ts3.isImportDeclaration(existing) && ts3.isStringLiteral(existing.moduleSpecifier) && ws.vfs.samePath(ws.resolveModule(existing.moduleSpecifier, targetSource2)?.resolvedFileName ?? "", file);
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
  const siblings = ws.observers().filter((config) => ws.vfs.samePath(dirname7(config), dirname7(ws.targetConfig)));
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
  const modulesBefore = ts3.isClassDeclaration(declaration) ? moduleGraph() : undefined;
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
function newDiagnostics2(before, after) {
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
  const extension = sourceExtension(file);
  const sourceConfig = configPathFor(assertAbsolute("project", request.project));
  const targetConfig = request.operation === "move-type" && request.targetProject ? configPathFor(assertAbsolute("targetProject", request.targetProject)) : sourceConfig;
  const affected = [file];
  if (request.operation === "move-type" && request.target && isAbsolute4(request.target) && existsSync2(request.target))
    affected.push(resolve8(request.target));
  const ws = new Workspace(root, sourceConfig, targetConfig, affected);
  try {
    if (!ws.vfs.fileExists(file))
      fail("FILE_NOT_FOUND", file);
    const owners = ws.ownersOf(file);
    if (!owners.some((owner) => ws.vfs.samePath(owner, sourceConfig)))
      fail("FILE_NOT_IN_PROJECT", `${file} is not included by ${sourceConfig}`);
    if (owners.length > 1)
      fail("OWNERSHIP_AMBIGUOUS", `${file} is included by several projects: ${owners.join(", ")}`);
    ws.assertNoUnhandledProjects([file], true, false);
    const sourceFile = ws.program().getSourceFile(file);
    if (!sourceFile)
      fail("FILE_NOT_IN_PROJECT", file);
    const isJs = jsExtensions.includes(extension);
    const context = { ws, root, file, sourceFile, isJs, notes: [] };
    const diagnosticsBefore = ws.diagnostics();
    let renamed;
    if (request.operation === "rename-file")
      renamed = renameFile(context, request).renamed;
    else if (request.operation === "move-type")
      moveType(context, request);
    else
      fail("UNSUPPORTED_OPERATION", String(request.operation));
    const written = ws.vfs.changes().filter((change) => change.after !== null && !/\.json$/i.test(change.path)).map((change) => change.path);
    if (written.length)
      ws.assertNoUnhandledProjects(written, false);
    const layoutsBefore = new Map(ws.layouts);
    const diagnosticsAfter = ws.diagnostics();
    const comparable = renamed ? diagnosticsBefore.map((item) => ws.vfs.samePath(item.file, renamed[0]) ? { ...item, file: renamed[1] } : item) : diagnosticsBefore;
    const introduced = newDiagnostics2(comparable, diagnosticsAfter);
    if (introduced.length)
      fail("NEW_DIAGNOSTICS", introduced.map((item) => `${item.code} ${item.file}: ${item.message}`).join("; "));
    for (const [key, layout] of layoutsBefore) {
      const after = ws.layouts.get(key);
      if (after !== undefined && after !== layout) {
        fail("OUTPUT_LAYOUT_CHANGED", `${ws.participant(key).configPath} has no rootDir and its emitted files would move from mirroring ${layout} to mirroring ${after}; set rootDir or choose another target`);
      }
    }
    for (const config of ws.importingConfigs) {
      context.notes.push(`Included ${relative7(root, config)} because its program imports ${relative7(root, file)} without a project reference.`);
    }
    for (const config of ws.observers()) {
      context.notes.push(`Updated and validated ${relative7(root, config)}, a variant config that also compiles the affected files.`);
    }
    if (ws.participants.size > 1) {
      context.notes.push(`Validated ${ws.participants.size} projects (${[...ws.participants.values()].map((item) => relative7(root, item.configPath)).join(", ")}) with in-memory declaration builds for project references.`);
    }
    if (isJs) {
      context.notes.push("JavaScript analysis is semantic only for references TypeScript can resolve; dynamic imports with computed paths and string-based references are not changed.");
    }
    if (renamed)
      context.notes.push(`Renamed ${relative7(root, renamed[0])} to ${relative7(root, renamed[1])}; the plan deletes the old path and creates the new one.`);
    return {
      backend: "typescript",
      version: ts3.version,
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
  init_typescript_vfs();
  init_typescript_workspace();
  init_typescript_paths();
  fileCapabilities = [
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

// src/backends/typescript.ts
var exports_typescript = {};
__export(exports_typescript, {
  analyze: () => analyze,
  capabilities: () => capabilities
});
import ts4 from "typescript";
import { statSync as statSync3 } from "node:fs";
import { basename as basename5, dirname as dirname8, extname as extname3, isAbsolute as isAbsolute5, resolve as resolve9 } from "node:path";
function fail2(code, reason) {
  throw new Error(`${code}: ${reason}`);
}
function canonical(path) {
  return resolve9(path);
}
function assertAbsolute2(name, value) {
  if (!isAbsolute5(value))
    fail2("INVALID_REQUEST", `${name} must be an absolute path`);
  return canonical(value);
}
function configPathFor2(project) {
  let stat2;
  try {
    stat2 = statSync3(project);
  } catch {
    fail2("PROJECT_NOT_FOUND", project);
  }
  if (stat2.isFile()) {
    if (!["tsconfig.json", "jsconfig.json"].includes(basename5(project))) {
      fail2("UNSUPPORTED_PROJECT", "project must name tsconfig.json or jsconfig.json");
    }
    return project;
  }
  if (!stat2.isDirectory())
    fail2("UNSUPPORTED_PROJECT", "project must be a config file or directory");
  const candidates = ["tsconfig.json", "jsconfig.json"].map((name) => resolve9(project, name)).filter(ts4.sys.fileExists);
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
  const parsed = ts4.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts4.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      fail2("INVALID_CONFIG", ts4.flattenDiagnosticMessageText(diagnostic.messageText, `
`));
    }
  });
  if (!parsed)
    fail2("INVALID_CONFIG", `could not parse ${configPath}`);
  const configErrors = parsed.errors.filter((diagnostic) => diagnostic.category === ts4.DiagnosticCategory.Error);
  if (configErrors.length)
    fail2("INVALID_CONFIG", ts4.flattenDiagnosticMessageText(configErrors[0].messageText, `
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
      const text = overlays.get(path) ?? ts4.sys.readFile(path);
      return text === undefined ? undefined : ts4.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => dirname8(configPath),
    getDefaultLibFileName: (options) => ts4.getDefaultLibFilePath(options),
    fileExists: ts4.sys.fileExists,
    readFile: ts4.sys.readFile,
    readDirectory: ts4.sys.readDirectory,
    directoryExists: ts4.sys.directoryExists,
    getDirectories: ts4.sys.getDirectories,
    realpath: ts4.sys.realpath,
    useCaseSensitiveFileNames: () => ts4.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts4.sys.newLine,
    getProjectVersion: () => String(projectVersion)
  };
  const service = ts4.createLanguageService(host, ts4.createDocumentRegistry());
  return {
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
}
function sourceText(state, path) {
  return state.overlays.get(path) ?? ts4.sys.readFile(path);
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
    message: ts4.flattenDiagnosticMessageText(diagnostic.messageText, `
`)
  };
}
function diagnostics(state) {
  const records = [];
  const add = (diagnostic) => {
    if (diagnostic.category !== ts4.DiagnosticCategory.Error)
      return;
    records.push(diagnosticRecord(diagnostic, state.configPath));
  };
  for (const item of state.service.getCompilerOptionsDiagnostics())
    add(item);
  const programFiles = state.service.getProgram()?.getSourceFiles().map((source) => canonical(source.fileName)).filter((path) => isInside(state.root, path) && !path.includes("/node_modules/")) ?? state.fileNames;
  for (const file of [...new Set(programFiles)].sort()) {
    for (const item of state.service.getSyntacticDiagnostics(file))
      add(item);
    for (const item of state.service.getSemanticDiagnostics(file))
      add(item);
  }
  return records.sort((a, b) => a.file.localeCompare(b.file) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
}
function validatePosition(text, position, label = "position") {
  if (!Number.isInteger(position) || position < 0 || position > text.length) {
    fail2("INVALID_RANGE", `${label} must be a UTF-16 offset within the file`);
  }
  return position;
}
function isValidIdentifier(name, target) {
  const scanner = ts4.createScanner(target, false, ts4.LanguageVariant.Standard, name);
  return scanner.scan() === ts4.SyntaxKind.Identifier && scanner.getTokenText() === name && scanner.scan() === ts4.SyntaxKind.EndOfFileToken;
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
function rename2(state, file, request) {
  const text = sourceText(state, file);
  const position = validatePosition(text, request.position);
  if (!request.newName?.trim())
    fail2("INVALID_REQUEST", "newName is required for rename");
  if (!isValidIdentifier(request.newName, state.options.target ?? ts4.ScriptTarget.Latest)) {
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
  const mode = request.mode === "sort" ? ts4.OrganizeImportsMode.SortAndCombine : ts4.OrganizeImportsMode.RemoveUnused;
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
  if (!request.newName?.trim() || !isValidIdentifier(request.newName, state.options.target ?? ts4.ScriptTarget.Latest)) {
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
  rename2(state, renameFile2, { ...request, operation: "rename", file: renameFile2, position: result.renameLocation });
}
function changedFiles(state, originals) {
  return [...state.overlays].filter(([path, after]) => originals.get(path) !== after).sort(([a], [b]) => a.localeCompare(b)).map(([path, after]) => ({ path, before: originals.get(path) ?? null, after }));
}
async function analyze(request) {
  if (request.operation === "rename-file" || request.operation === "move-type")
    return analyzeFileOperation(request);
  if (request.operation === "sync-namespace") {
    fail2("UNSUPPORTED_OPERATION", "sync-namespace is C# only; ES modules have no namespace-to-directory convention");
  }
  const state = loadProject(request);
  try {
    const file = assertAbsolute2("file", request.file);
    if (!isInside(state.root, file))
      fail2("OUTSIDE_ROOT", `file is outside ${state.root}`);
    const text = sourceText(state, file);
    if (text === undefined)
      fail2("FILE_NOT_FOUND", file);
    const extension = extname3(file).toLowerCase();
    if (![".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(extension)) {
      fail2("UNSUPPORTED_FILE", extension || "file has no extension");
    }
    const program = state.service.getProgram();
    if (!program?.getSourceFile(file))
      fail2("FILE_NOT_IN_PROJECT", file);
    const outsideUserSources = program.getSourceFiles().filter((source) => !isInside(state.root, canonical(source.fileName)) && !source.isDeclarationFile).map((source) => canonical(source.fileName)).sort();
    if (outsideUserSources.length) {
      fail2("PROJECT_SCOPE_INCOMPLETE", `program contains user source outside ${state.root}: ${outsideUserSources.join(", ")}`);
    }
    const diagnosticsBefore = diagnostics(state);
    const originals = new Map;
    for (const path of state.fileNames)
      originals.set(path, sourceText(state, path));
    switch (request.operation) {
      case "rename":
        rename2(state, file, request);
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
        originals.set(path, ts4.sys.readFile(path));
    const diagnosticsAfter = diagnostics(state);
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
    const notes = [];
    if (request.operation === "imports") {
      notes.push(request.mode === "sort" ? "Sorting imports can reorder module initialization; verify application behavior." : "Removing unused value imports can remove module initialization; bare side-effect imports are retained.");
    }
    if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension) && ["rename", "extract-function", "extract-variable"].includes(request.operation)) {
      notes.push("JavaScript analysis is semantic only for symbols TypeScript can resolve; dynamic properties, reflection, and string-based references are not changed.");
    }
    return {
      backend: "typescript",
      version: ts4.version,
      changes: changedFiles(state, originals),
      diagnosticsBefore,
      diagnosticsAfter,
      notes
    };
  } finally {
    state.service.dispose();
  }
}
var capabilities, formatOptions;
var init_typescript = __esm(() => {
  init_typescript_fileops();
  init_typescript_paths();
  capabilities = [
    { operation: "rename", description: "Rename a TypeScript or JavaScript symbol across its configured project." },
    { operation: "imports", modes: ["sort", "remove-unused"], description: "Sort imports or explicitly remove unused imports." },
    { operation: "format", description: "Format a source file with the TypeScript formatter." },
    { operation: "extract-function", description: "Extract the selected statements or expression to a named function." },
    { operation: "extract-variable", description: "Extract the selected expression to a named variable." },
    ...fileCapabilities
  ];
  formatOptions = {
    indentSize: 2,
    tabSize: 2,
    newLineCharacter: `
`,
    convertTabsToSpaces: true,
    indentStyle: ts4.IndentStyle.Smart,
    insertSpaceAfterCommaDelimiter: true,
    insertSpaceAfterSemicolonInForStatements: true,
    insertSpaceBeforeAndAfterBinaryOperators: true,
    insertSpaceAfterKeywordsInControlFlowStatements: true,
    insertSpaceAfterFunctionKeywordForAnonymousFunctions: false,
    insertSpaceBeforeFunctionParenthesis: false,
    insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
    semicolons: ts4.SemicolonPreference.Insert
  };
});

// src/backends/csharp.ts
var exports_csharp = {};
__export(exports_csharp, {
  analyze: () => analyze2,
  capabilities: () => capabilities2
});
import { basename as basename6, dirname as dirname9, isAbsolute as isAbsolute6, join, relative as relative8, resolve as resolve10, sep as sep7 } from "node:path";
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
    if (!isAbsolute6(value)) {
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
    if (!request.target || !isAbsolute6(request.target) || !request.target.endsWith(".cs")) {
      throw new Error("INVALID_REQUEST: move-type requires an absolute target .cs file path");
    }
    ensureWithinRoot(request.root, request.target, "target");
    if (request.targetProject !== undefined) {
      if (!isAbsolute6(request.targetProject) || !request.targetProject.toLowerCase().endsWith(".csproj")) {
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
    if (!isAbsolute6(change.path)) {
      throw new Error("CSHARP_PROTOCOL_ERROR: helper returned a relative change path");
    }
    ensureWithinRoot(root, change.path, "changed file");
  }
}
function ensureWithinRoot(root, path, label) {
  const difference = relative8(resolve10(root), resolve10(path));
  if (difference === ".." || difference.startsWith(`..${sep7}`) || isAbsolute6(difference)) {
    throw new Error(`OUTSIDE_ROOT: ${label} is outside root: ${path}`);
  }
}
async function findOrBuildHelper(toolkitRoot) {
  const configured = toolkitRoot ?? process.env.REFACTOR_AI_HOME;
  const directory = dirname9(fileURLToPath(import.meta.url));
  const sourceRoot = configured ? resolve10(configured) : resolve10(directory, basename6(directory) === "backends" && basename6(dirname9(directory)) === "src" ? "../.." : "..");
  const dll = helperDll(sourceRoot);
  if (await exists(dll))
    return dll;
  const project = join(sourceRoot, "dotnet", "RefactorHelper", "RefactorHelper.csproj");
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
  return join(root, "dotnet", "RefactorHelper", "bin", "Release", "net8.0", "RefactorHelper.dll");
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

// src/cli.ts
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// src/cli-core.ts
import { lstat as lstat4, mkdir as mkdir2, realpath as realpath4, writeFile as writeFile2 } from "node:fs/promises";
import { basename as basename2, dirname as dirname4, isAbsolute as isAbsolute2, relative as relative3, resolve as resolve5, sep as sep3 } from "node:path";

// src/api.ts
import { readFile as readFile4, realpath as realpath3 } from "node:fs/promises";
import { dirname as dirname3, resolve as resolve4 } from "node:path";

// src/core/apply.ts
import { lstat as lstat3, mkdir, open, readFile as readFile3, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname as dirname2, resolve as resolve3 } from "node:path";
import { randomUUID } from "node:crypto";

// src/core/plan.ts
import { lstat as lstat2, readFile as readFile2, realpath as realpath2 } from "node:fs/promises";
import { relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";
// node_modules/diff/libesm/diff/base.js
class Diff {
  diff(oldStr, newStr, options = {}) {
    let callback;
    if (typeof options === "function") {
      callback = options;
      options = {};
    } else if ("callback" in options) {
      callback = options.callback;
    }
    const oldString = this.castInput(oldStr, options);
    const newString = this.castInput(newStr, options);
    const oldTokens = this.removeEmpty(this.tokenize(oldString, options));
    const newTokens = this.removeEmpty(this.tokenize(newString, options));
    return this.diffWithOptionsObj(oldTokens, newTokens, options, callback);
  }
  diffWithOptionsObj(oldTokens, newTokens, options, callback) {
    var _a;
    const done = (value) => {
      value = this.postProcess(value, options);
      if (callback) {
        setTimeout(function() {
          callback(value);
        }, 0);
        return;
      } else {
        return value;
      }
    };
    const newLen = newTokens.length, oldLen = oldTokens.length;
    let editLength = 1;
    let maxEditLength = newLen + oldLen;
    if (options.maxEditLength != null) {
      maxEditLength = Math.min(maxEditLength, options.maxEditLength);
    }
    const maxExecutionTime = (_a = options.timeout) !== null && _a !== undefined ? _a : Infinity;
    const abortAfterTimestamp = Date.now() + maxExecutionTime;
    const bestPath = [{ oldPos: -1, lastComponent: undefined }];
    let newPos = this.extractCommon(bestPath[0], newTokens, oldTokens, 0, options);
    if (bestPath[0].oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
      return done(this.buildValues(bestPath[0].lastComponent, newTokens, oldTokens));
    }
    let minDiagonalToConsider = -Infinity, maxDiagonalToConsider = Infinity;
    const execEditLength = () => {
      for (let diagonalPath = Math.max(minDiagonalToConsider, -editLength);diagonalPath <= Math.min(maxDiagonalToConsider, editLength); diagonalPath += 2) {
        let basePath;
        const removePath = bestPath[diagonalPath - 1], addPath = bestPath[diagonalPath + 1];
        if (removePath) {
          bestPath[diagonalPath - 1] = undefined;
        }
        let canAdd = false;
        if (addPath) {
          const addPathNewPos = addPath.oldPos - diagonalPath;
          canAdd = addPath && 0 <= addPathNewPos && addPathNewPos < newLen;
        }
        const canRemove = removePath && removePath.oldPos + 1 < oldLen;
        if (!canAdd && !canRemove) {
          bestPath[diagonalPath] = undefined;
          continue;
        }
        if (!canRemove || canAdd && removePath.oldPos < addPath.oldPos) {
          basePath = this.addToPath(addPath, true, false, 0, options);
        } else {
          basePath = this.addToPath(removePath, false, true, 1, options);
        }
        newPos = this.extractCommon(basePath, newTokens, oldTokens, diagonalPath, options);
        if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
          return done(this.buildValues(basePath.lastComponent, newTokens, oldTokens)) || true;
        } else {
          bestPath[diagonalPath] = basePath;
          if (basePath.oldPos + 1 >= oldLen) {
            maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
          }
          if (newPos + 1 >= newLen) {
            minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
          }
        }
      }
      editLength++;
    };
    if (callback) {
      (function exec() {
        setTimeout(function() {
          if (editLength > maxEditLength || Date.now() > abortAfterTimestamp) {
            return callback(undefined);
          }
          if (!execEditLength()) {
            exec();
          }
        }, 0);
      })();
    } else {
      while (editLength <= maxEditLength && Date.now() <= abortAfterTimestamp) {
        const ret = execEditLength();
        if (ret) {
          return ret;
        }
      }
    }
  }
  addToPath(path, added, removed, oldPosInc, options) {
    const last = path.lastComponent;
    if (last && !options.oneChangePerToken && last.added === added && last.removed === removed) {
      return {
        oldPos: path.oldPos + oldPosInc,
        lastComponent: { count: last.count + 1, added, removed, previousComponent: last.previousComponent }
      };
    } else {
      return {
        oldPos: path.oldPos + oldPosInc,
        lastComponent: { count: 1, added, removed, previousComponent: last }
      };
    }
  }
  extractCommon(basePath, newTokens, oldTokens, diagonalPath, options) {
    const newLen = newTokens.length, oldLen = oldTokens.length;
    let oldPos = basePath.oldPos, newPos = oldPos - diagonalPath, commonCount = 0;
    while (newPos + 1 < newLen && oldPos + 1 < oldLen && this.equals(oldTokens[oldPos + 1], newTokens[newPos + 1], options)) {
      newPos++;
      oldPos++;
      commonCount++;
      if (options.oneChangePerToken) {
        basePath.lastComponent = { count: 1, previousComponent: basePath.lastComponent, added: false, removed: false };
      }
    }
    if (commonCount && !options.oneChangePerToken) {
      basePath.lastComponent = { count: commonCount, previousComponent: basePath.lastComponent, added: false, removed: false };
    }
    basePath.oldPos = oldPos;
    return newPos;
  }
  equals(left, right, options) {
    if (options.comparator) {
      return options.comparator(left, right);
    } else {
      return left === right || !!options.ignoreCase && left.toLowerCase() === right.toLowerCase();
    }
  }
  removeEmpty(array) {
    const ret = [];
    for (let i = 0;i < array.length; i++) {
      if (array[i]) {
        ret.push(array[i]);
      }
    }
    return ret;
  }
  castInput(value, options) {
    return value;
  }
  tokenize(value, options) {
    return Array.from(value);
  }
  join(chars) {
    return chars.join("");
  }
  postProcess(changeObjects, options) {
    return changeObjects;
  }
  get useLongestToken() {
    return false;
  }
  buildValues(lastComponent, newTokens, oldTokens) {
    const components = [];
    let nextComponent;
    while (lastComponent) {
      components.push(lastComponent);
      nextComponent = lastComponent.previousComponent;
      delete lastComponent.previousComponent;
      lastComponent = nextComponent;
    }
    components.reverse();
    const componentLen = components.length;
    let componentPos = 0, newPos = 0, oldPos = 0;
    for (;componentPos < componentLen; componentPos++) {
      const component = components[componentPos];
      if (!component.removed) {
        if (!component.added && this.useLongestToken) {
          let value = newTokens.slice(newPos, newPos + component.count);
          value = value.map(function(value2, i) {
            const oldValue = oldTokens[oldPos + i];
            return oldValue.length > value2.length ? oldValue : value2;
          });
          component.value = this.join(value);
        } else {
          component.value = this.join(newTokens.slice(newPos, newPos + component.count));
        }
        newPos += component.count;
        if (!component.added) {
          oldPos += component.count;
        }
      } else {
        component.value = this.join(oldTokens.slice(oldPos, oldPos + component.count));
        oldPos += component.count;
      }
    }
    return components;
  }
}

// node_modules/diff/libesm/diff/line.js
class LineDiff extends Diff {
  constructor() {
    super(...arguments);
    this.tokenize = tokenize;
  }
  equals(left, right, options) {
    if (options.ignoreWhitespace) {
      if (!options.newlineIsToken || !left.includes(`
`)) {
        left = left.trim();
      }
      if (!options.newlineIsToken || !right.includes(`
`)) {
        right = right.trim();
      }
    } else if (options.ignoreNewlineAtEof && !options.newlineIsToken) {
      if (left.endsWith(`
`)) {
        left = left.slice(0, -1);
      }
      if (right.endsWith(`
`)) {
        right = right.slice(0, -1);
      }
    }
    return super.equals(left, right, options);
  }
}
var lineDiff = new LineDiff;
function diffLines(oldStr, newStr, options) {
  return lineDiff.diff(oldStr, newStr, options);
}
function tokenize(value, options) {
  if (options.stripTrailingCr) {
    value = value.replace(/\r\n/g, `
`);
  }
  const retLines = [], linesAndNewlines = value.split(/(\n|\r\n)/);
  if (!linesAndNewlines[linesAndNewlines.length - 1]) {
    linesAndNewlines.pop();
  }
  for (let i = 0;i < linesAndNewlines.length; i++) {
    const line = linesAndNewlines[i];
    if (i % 2 && !options.newlineIsToken) {
      retLines[retLines.length - 1] += line;
    } else {
      retLines.push(line);
    }
  }
  return retLines;
}

// node_modules/diff/libesm/patch/create.js
function structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options) {
  let optionsObj;
  if (!options) {
    optionsObj = {};
  } else if (typeof options === "function") {
    optionsObj = { callback: options };
  } else {
    optionsObj = options;
  }
  if (typeof optionsObj.context === "undefined") {
    optionsObj.context = 4;
  }
  const context = optionsObj.context;
  if (optionsObj.newlineIsToken) {
    throw new Error("newlineIsToken may not be used with patch-generation functions, only with diffing functions");
  }
  if (!optionsObj.callback) {
    return diffLinesResultToPatch(diffLines(oldStr, newStr, optionsObj));
  } else {
    const { callback } = optionsObj;
    diffLines(oldStr, newStr, Object.assign(Object.assign({}, optionsObj), { callback: (diff) => {
      const patch = diffLinesResultToPatch(diff);
      callback(patch);
    } }));
  }
  function diffLinesResultToPatch(diff) {
    if (!diff) {
      return;
    }
    diff.push({ value: "", lines: [] });
    function contextLines(lines) {
      return lines.map(function(entry) {
        return " " + entry;
      });
    }
    const hunks = [];
    let oldRangeStart = 0, newRangeStart = 0, curRange = [], oldLine = 1, newLine = 1;
    for (let i = 0;i < diff.length; i++) {
      const current = diff[i], lines = current.lines || splitLines(current.value);
      current.lines = lines;
      if (current.added || current.removed) {
        if (!oldRangeStart) {
          const prev = diff[i - 1];
          oldRangeStart = oldLine;
          newRangeStart = newLine;
          if (prev) {
            curRange = context > 0 ? contextLines(prev.lines.slice(-context)) : [];
            oldRangeStart -= curRange.length;
            newRangeStart -= curRange.length;
          }
        }
        for (const line of lines) {
          curRange.push((current.added ? "+" : "-") + line);
        }
        if (current.added) {
          newLine += lines.length;
        } else {
          oldLine += lines.length;
        }
      } else {
        if (oldRangeStart) {
          if (lines.length <= context * 2 && i < diff.length - 2) {
            for (const line of contextLines(lines)) {
              curRange.push(line);
            }
          } else {
            const contextSize = Math.min(lines.length, context);
            for (const line of contextLines(lines.slice(0, contextSize))) {
              curRange.push(line);
            }
            const hunk = {
              oldStart: oldRangeStart,
              oldLines: oldLine - oldRangeStart + contextSize,
              newStart: newRangeStart,
              newLines: newLine - newRangeStart + contextSize,
              lines: curRange
            };
            hunks.push(hunk);
            oldRangeStart = 0;
            newRangeStart = 0;
            curRange = [];
          }
        }
        oldLine += lines.length;
        newLine += lines.length;
      }
    }
    for (const hunk of hunks) {
      for (let i = 0;i < hunk.lines.length; i++) {
        if (hunk.lines[i].endsWith(`
`)) {
          hunk.lines[i] = hunk.lines[i].slice(0, -1);
        } else {
          hunk.lines.splice(i + 1, 0, "\\ No newline at end of file");
          i++;
        }
      }
    }
    return {
      oldFileName,
      newFileName,
      oldHeader,
      newHeader,
      hunks
    };
  }
}
function formatPatch(patch) {
  if (Array.isArray(patch)) {
    return patch.map(formatPatch).join(`
`);
  }
  const ret = [];
  if (patch.oldFileName == patch.newFileName) {
    ret.push("Index: " + patch.oldFileName);
  }
  ret.push("===================================================================");
  ret.push("--- " + patch.oldFileName + (typeof patch.oldHeader === "undefined" ? "" : "\t" + patch.oldHeader));
  ret.push("+++ " + patch.newFileName + (typeof patch.newHeader === "undefined" ? "" : "\t" + patch.newHeader));
  for (let i = 0;i < patch.hunks.length; i++) {
    const hunk = patch.hunks[i];
    if (hunk.oldLines === 0) {
      hunk.oldStart -= 1;
    }
    if (hunk.newLines === 0) {
      hunk.newStart -= 1;
    }
    ret.push("@@ -" + hunk.oldStart + "," + hunk.oldLines + " +" + hunk.newStart + "," + hunk.newLines + " @@");
    for (const line of hunk.lines) {
      ret.push(line);
    }
  }
  return ret.join(`
`) + `
`;
}
function createTwoFilesPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options) {
  if (typeof options === "function") {
    options = { callback: options };
  }
  if (!(options === null || options === undefined ? undefined : options.callback)) {
    const patchObj = structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options);
    if (!patchObj) {
      return;
    }
    return formatPatch(patchObj);
  } else {
    const { callback } = options;
    structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, Object.assign(Object.assign({}, options), { callback: (patchObj) => {
      if (!patchObj) {
        callback(undefined);
      } else {
        callback(formatPatch(patchObj));
      }
    } }));
  }
}
function splitLines(text) {
  const hasTrailingNl = text.endsWith(`
`);
  const result = text.split(`
`).map((line) => line + `
`);
  if (hasTrailingNl) {
    result.pop();
  } else {
    result.push(result.pop().slice(0, -1));
  }
  return result;
}
// src/core/snapshot.ts
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
var excluded = new Set([".git", "node_modules", "bin", "obj", "dist", ".refactor-ai"]);
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function inside(root, file) {
  const result = resolve(file);
  const rel = relative(root, result);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`OUTSIDE_ROOT: ${file}`);
  }
  if (rel.split(sep).some((part) => excluded.has(part))) {
    throw new Error(`EXCLUDED_PATH: ${file}`);
  }
  return result;
}
async function assertRegularPath(root, file, allowMissing = false) {
  const target = inside(root, file);
  const parts = relative(root, target).split(sep);
  let current = root;
  for (let i = 0;i < parts.length; i++) {
    current = resolve(current, parts[i]);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (allowMissing && error.code === "ENOENT")
        return;
      throw error;
    }
    if (stat.isSymbolicLink())
      throw new Error(`SYMLINK_UNSUPPORTED: ${current}`);
    if (i === parts.length - 1 && !stat.isFile())
      throw new Error(`NOT_A_FILE: ${current}`);
    if (i < parts.length - 1 && !stat.isDirectory())
      throw new Error(`NOT_A_DIRECTORY: ${current}`);
  }
}
async function canonicalMissing(file) {
  const absolute = resolve(file);
  const parent = dirname(absolute);
  if (parent === absolute)
    return realpath(absolute);
  try {
    return resolve(await realpath(parent), basename(absolute));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw error;
    return resolve(await canonicalMissing(parent), basename(absolute));
  }
}
async function missingDirectories(root, file) {
  const parts = relative(root, dirname(inside(root, file))).split(sep).filter(Boolean);
  const missing = [];
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    if (missing.length) {
      missing.push(current);
      continue;
    }
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new Error(`SYMLINK_UNSUPPORTED: ${current}`);
      if (!stat.isDirectory())
        throw new Error(`NOT_A_DIRECTORY: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT")
        throw error;
      missing.push(current);
    }
  }
  return missing;
}
async function snapshot(rootPath) {
  const root = await realpath(rootPath);
  const files = {};
  const record = async (file, kind) => {
    files[relative(root, file)] = kind === "symlink" ? `symlink:${await readlink(file)}` : sha256(await readFile(file));
  };
  const listed = await gitFiles(root);
  if (listed) {
    for (const name of listed) {
      if (name.split("/").some((part) => excluded.has(part)))
        continue;
      const file = resolve(root, name);
      const stat = await lstat(file).catch((error) => {
        if (error.code === "ENOENT")
          return null;
        throw error;
      });
      if (stat?.isSymbolicLink())
        await record(file, "symlink");
      else if (stat?.isFile())
        await record(file, "file");
    }
  } else {
    async function walk(directory) {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        if (excluded.has(entry.name))
          continue;
        const file = resolve(directory, entry.name);
        if (entry.isSymbolicLink())
          await record(file, "symlink");
        else if (entry.isDirectory())
          await walk(file);
        else if (entry.isFile())
          await record(file, "file");
      }
    }
    await walk(root);
  }
  return { files, hash: sha256(JSON.stringify(files)) };
}
var run = promisify(execFile);
async function gitFiles(root) {
  try {
    const { stdout } = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], {
      cwd: root,
      maxBuffer: 1 << 28,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
    });
    const names = [...new Set(stdout.split("\x00").filter(Boolean))].map((name) => name.split(sep).join("/"));
    return names.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  } catch {
    return null;
  }
}

// src/core/plan.ts
function newDiagnostics(before, after) {
  const key = (d) => JSON.stringify([d.file, d.code, d.message]);
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
function planId(plan) {
  const { id: _id, ...body } = plan;
  return sha256(JSON.stringify(body));
}
function changeKind(change) {
  if (change.before === null && change.after === null)
    throw new Error(`INVALID_CHANGE: ${change.path} has neither before nor after content`);
  return change.before === null ? "create" : change.after === null ? "delete" : "edit";
}
function byPath(a, b) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
function caseConflict(root, files, changes) {
  const removed = new Set(changes.filter((c) => c.after === null).map((c) => relative2(root, c.path)));
  const created = changes.filter((c) => c.before === null).map((c) => relative2(root, c.path));
  const spellings = new Map;
  const record = (file) => {
    const parts = file.split(sep2);
    for (let i = 1;i <= parts.length; i++) {
      const exact = parts.slice(0, i).join(sep2);
      const key = exact.normalize("NFC").toLowerCase();
      const set = spellings.get(key) ?? new Set;
      set.add(exact);
      spellings.set(key, set);
    }
  };
  for (const file of Object.keys(files))
    if (!removed.has(file))
      record(file);
  for (const file of created)
    record(file);
  for (const file of created) {
    const parts = file.split(sep2);
    for (let i = 1;i <= parts.length; i++) {
      if ((spellings.get(parts.slice(0, i).join(sep2).normalize("NFC").toLowerCase())?.size ?? 0) > 1)
        return resolve2(root, file);
    }
  }
  return;
}
function assertPlanShape(plan) {
  if (plan?.schemaVersion !== 1 && plan?.schemaVersion !== 2 || !plan.request || typeof plan.request.root !== "string" || !Array.isArray(plan.changes) || !plan.snapshot || !plan.validation || !Array.isArray(plan.diagnosticsBefore) || !Array.isArray(plan.diagnosticsAfter)) {
    throw new Error("INVALID_PLAN: unsupported or malformed plan");
  }
  if (plan.id !== planId(plan))
    throw new Error("INVALID_PLAN: plan integrity check failed");
  if (plan.snapshot.hash !== sha256(JSON.stringify(plan.snapshot.files)))
    throw new Error("INVALID_PLAN: invalid snapshot");
  const added = newDiagnostics(plan.diagnosticsBefore, plan.diagnosticsAfter);
  if (JSON.stringify(added) !== JSON.stringify(plan.validation.newDiagnostics) || plan.validation.status !== (added.length ? "failed" : "passed")) {
    throw new Error("INVALID_PLAN: inconsistent validation");
  }
  const seen = new Set;
  let previous = "";
  for (const change of plan.changes) {
    if (!change || typeof change.path !== "string" || change.before !== null && typeof change.before !== "string" || change.after !== null && typeof change.after !== "string" || change.before === null && change.after === null || change.before === change.after) {
      throw new Error("INVALID_PLAN: invalid change");
    }
    if (change.after === null && plan.schemaVersion < 2)
      throw new Error("INVALID_PLAN: deletions require plan schema 2");
    const path = inside(plan.request.root, change.path);
    if (path !== change.path || seen.has(path) || path < previous)
      throw new Error("INVALID_PLAN: duplicate, unsorted or noncanonical path");
    seen.add(path);
    previous = path;
    const expected = plan.snapshot.files[relative2(plan.request.root, path)];
    if (change.before === null ? expected !== undefined : sha256(Buffer.from(change.before)) !== expected) {
      throw new Error(`INVALID_PLAN: before content does not match snapshot: ${path}`);
    }
  }
  const conflict = caseConflict(plan.request.root, plan.snapshot.files, plan.changes);
  if (conflict)
    throw new Error(`INVALID_PLAN: case-insensitive path collision: ${conflict}`);
  if (plan.fileModes !== undefined) {
    if (!plan.fileModes || Object.keys(plan.fileModes).length !== plan.changes.length)
      throw new Error("INVALID_PLAN: invalid file modes");
    const validMode = (value) => Number.isInteger(value) && value >= 0 && value <= 511;
    for (const change of plan.changes) {
      const modes = plan.fileModes[change.path];
      if (!modes || (change.before === null ? modes.before !== null : !validMode(modes.before)) || (change.after === null ? modes.after !== null : !validMode(modes.after)) || change.before !== null && change.after !== null && modes.before !== modes.after) {
        throw new Error(`INVALID_PLAN: invalid file modes: ${change.path}`);
      }
    }
  }
}
async function canonicalRequest(request) {
  const root = await realpath2(request.root);
  const result = { ...request, root, project: await realpath2(request.project), file: await realpath2(request.file) };
  await assertRegularPath(root, result.project);
  await assertRegularPath(root, result.file);
  if (request.targetProject !== undefined) {
    result.targetProject = await realpath2(request.targetProject);
    await assertRegularPath(root, result.targetProject);
  }
  if (request.target !== undefined) {
    result.target = inside(root, await canonicalMissing(request.target));
    await assertRegularPath(root, result.target, true);
  }
  return result;
}
var fileId = (stat) => `${stat.dev}:${stat.ino}`;
async function createPlan(request, analyze) {
  request = await canonicalRequest(request);
  const root = request.root;
  const before = await snapshot(root);
  const result = await analyze(request);
  if ((await snapshot(root)).hash !== before.hash)
    throw new Error("STALE_SNAPSHOT: project changed during analysis");
  const seen = new Set;
  const changes = [];
  for (const change of result.changes) {
    const kind = changeKind(change);
    const path = inside(root, kind === "create" ? await canonicalMissing(change.path) : await realpath2(change.path));
    if (seen.has(path))
      throw new Error(`DUPLICATE_CHANGE: ${path}`);
    seen.add(path);
    if (kind === "create") {
      if (before.files[relative2(root, path)] !== undefined)
        throw new Error(`TARGET_EXISTS: ${path}`);
    } else {
      await assertRegularPath(root, path);
      if (sha256(Buffer.from(change.before)) !== before.files[relative2(root, path)])
        throw new Error(`BEFORE_MISMATCH: ${path}`);
    }
    if (change.before !== change.after)
      changes.push({ path, before: change.before, after: change.after });
  }
  const deleted = new Set;
  for (const change of changes)
    if (change.after === null)
      deleted.add(fileId(await lstat2(change.path)));
  for (const change of changes) {
    if (change.before !== null)
      continue;
    await assertRegularPath(root, change.path, true);
    const existing = await lstat2(change.path).catch((error) => {
      if (error.code === "ENOENT")
        return null;
      throw error;
    });
    if (existing && !deleted.has(fileId(existing)))
      throw new Error(`TARGET_EXISTS: ${change.path}`);
  }
  changes.sort(byPath);
  const fileModes = {};
  const createdMode = ["move-type", "rename-file"].includes(request.operation) ? (await lstat2(request.file)).mode & 511 : 384;
  for (const change of changes) {
    const beforeMode = change.before === null ? null : (await lstat2(change.path)).mode & 511;
    fileModes[change.path] = { before: beforeMode, after: change.after === null ? null : beforeMode ?? createdMode };
  }
  const conflict = caseConflict(root, before.files, changes);
  if (conflict)
    throw new Error(`CASE_CONFLICT: ${conflict} differs only by case from another path`);
  const added = newDiagnostics(result.diagnosticsBefore, result.diagnosticsAfter);
  const body = {
    schemaVersion: changes.some((c) => c.before === null || c.after === null) ? 2 : 1,
    request,
    backend: result.backend,
    backendVersion: result.version,
    snapshot: before,
    changes,
    fileModes,
    validation: { status: added.length ? "failed" : "passed", newDiagnostics: added },
    diagnosticsBefore: result.diagnosticsBefore,
    diagnosticsAfter: result.diagnosticsAfter,
    notes: result.notes
  };
  return { ...body, id: planId(body) };
}
async function loadPlan(path) {
  let plan;
  try {
    plan = JSON.parse(await readFile2(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("INVALID_PLAN: plan is not valid JSON");
    throw error;
  }
  assertPlanShape(plan);
  return plan;
}
async function assertFresh(plan) {
  if (plan.id !== planId(plan))
    throw new Error("INVALID_PLAN: plan integrity check failed");
  if (await realpath2(plan.request.root) !== plan.request.root)
    throw new Error("INVALID_PLAN: noncanonical root");
  if ((await snapshot(plan.request.root)).hash !== plan.snapshot.hash)
    throw new Error("STALE_SNAPSHOT: project changed; create a new plan");
  for (const [path, modes] of Object.entries(plan.fileModes ?? {})) {
    if (modes.before !== null && ((await lstat2(path)).mode & 511) !== modes.before) {
      throw new Error(`STALE_SNAPSHOT: file permissions changed; create a new plan: ${path}`);
    }
  }
}
function preview(plan) {
  return plan.changes.map((change) => {
    const name = relative2(plan.request.root, change.path);
    return createTwoFilesPatch(change.before === null ? "/dev/null" : `a/${name}`, change.after === null ? "/dev/null" : `b/${name}`, change.before ?? "", change.after ?? "", "", "", { context: 3 });
  }).join(`
`);
}

// src/core/apply.ts
async function readOrNull(path) {
  return readFile3(path).catch((error) => {
    if (error.code === "ENOENT")
      return null;
    throw error;
  });
}
var sameContent = (current, expected) => expected === null ? current === null : current !== null && sha256(current) === sha256(expected);
async function atomicWrite(path, content, mode, expectedContent) {
  const temporary = resolve3(dirname2(path), `.refactor-write-${randomUUID()}`);
  try {
    const handle = await open(temporary, "wx", 384);
    try {
      await handle.writeFile(content, "utf8");
      if (mode !== undefined)
        await handle.chmod(mode & 511);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (expectedContent !== undefined && !sameContent(await readOrNull(path), expectedContent)) {
      throw new Error(`STALE_SNAPSHOT: ${path} changed while staging the write`);
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function ensureDirectories(root, file, created) {
  for (const directory of await missingDirectories(root, file)) {
    try {
      await mkdir(directory);
      created.push(directory);
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
      const existing = await lstat3(directory);
      if (existing.isSymbolicLink() || !existing.isDirectory())
        throw new Error(`NOT_A_DIRECTORY: ${directory}`);
    }
  }
}
var fileId2 = (s) => `${s.dev}:${s.ino}`;
async function order(plan) {
  const steps = plan.changes.map((change) => ({ change, kind: changeKind(change) }));
  const deleted = new Set;
  for (const step of steps)
    if (step.kind === "delete")
      deleted.add(fileId2(await lstat3(step.change.path)));
  const aliases = new Set;
  for (const step of steps) {
    if (step.kind !== "create")
      continue;
    const existing = await lstat3(step.change.path).catch((error) => {
      if (error.code === "ENOENT")
        return null;
      throw error;
    });
    if (!existing)
      continue;
    if (!deleted.has(fileId2(existing)))
      throw new Error(`STALE_SNAPSHOT: ${step.change.path} already exists`);
    aliases.add(step.change);
  }
  const rank = (step) => step.kind === "create" ? aliases.has(step.change) ? 3 : 0 : step.kind === "edit" ? 1 : 2;
  return steps.toSorted((a, b) => rank(a) - rank(b));
}
async function applyPlan(plan) {
  assertPlanShape(plan);
  if (plan.validation.status !== "passed" || newDiagnostics(plan.diagnosticsBefore, plan.diagnosticsAfter).length) {
    throw new Error("VALIDATION_FAILED: plan adds compiler errors");
  }
  const root = plan.request.root;
  const stateDirectory = resolve3(root, ".refactor-ai");
  await mkdir(stateDirectory, { recursive: true });
  if ((await lstat3(stateDirectory)).isSymbolicLink())
    throw new Error("SYMLINK_UNSUPPORTED: state directory");
  const lock = resolve3(stateDirectory, "apply.lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error("APPLY_LOCKED: another apply or interrupted transaction; inspect .refactor-ai/apply.lock");
    throw error;
  }
  const journalPath = resolve3(stateDirectory, `${plan.id}.journal.json`);
  const written = [];
  const createdDirectories = [];
  const journal = {
    schemaVersion: 2,
    planId: plan.id,
    status: "writing",
    changes: plan.changes.map((c) => ({
      path: c.path,
      kind: changeKind(c),
      before: c.before,
      afterHash: c.after === null ? null : sha256(c.after),
      ...plan.fileModes?.[c.path] ? { beforeMode: plan.fileModes[c.path].before, afterMode: plan.fileModes[c.path].after } : {}
    })),
    createdDirectories
  };
  const saveJournal = () => atomicWrite(journalPath, JSON.stringify(journal, null, 2) + `
`);
  try {
    await assertFresh(plan);
    if (!plan.changes.length)
      return { status: "applied", files: [], journal: null };
    const steps = await order(plan);
    const sourceMode = (await stat(plan.request.file)).mode & 511;
    for (const step of steps) {
      const record = journal.changes.find((item) => item.path === step.change.path);
      record.beforeMode = step.kind === "create" ? null : (await stat(step.change.path)).mode & 511;
      record.afterMode = step.kind === "delete" ? null : plan.fileModes?.[step.change.path]?.after ?? record.beforeMode ?? (["move-type", "rename-file"].includes(plan.request.operation) ? sourceMode : 384);
    }
    await saveJournal();
    for (const step of steps) {
      const { change, kind } = step;
      if (kind === "create") {
        const before = createdDirectories.length;
        await ensureDirectories(root, change.path, createdDirectories);
        if (createdDirectories.length !== before)
          await saveJournal();
      }
      await assertRegularPath(root, change.path, kind === "create");
      const current = await readOrNull(change.path);
      if (!sameContent(current, change.before))
        throw new Error(`STALE_SNAPSHOT: ${change.path} changed during apply`);
      const mode = current === null ? undefined : (await stat(change.path)).mode & 511;
      const record = journal.changes.find((item) => item.path === change.path);
      if (mode !== undefined && mode !== record.beforeMode)
        throw new Error(`STALE_SNAPSHOT: permissions changed during apply: ${change.path}`);
      if (kind === "delete")
        await unlink(change.path);
      else
        await atomicWrite(change.path, change.after, record.afterMode ?? undefined, change.before);
      written.push({ ...step, mode });
    }
    journal.status = "applied";
    await saveJournal();
    return { status: "applied", files: written.map((s) => s.change.path), journal: journalPath };
  } catch (error) {
    let recoveryNeeded = false;
    for (const { change, kind, mode } of written.toReversed()) {
      try {
        await assertRegularPath(root, change.path, true);
        const current = await readOrNull(change.path);
        if (kind === "delete") {
          if (current === null)
            await atomicWrite(change.path, change.before, mode, null);
          else if (!sameContent(current, change.before))
            recoveryNeeded = true;
        } else if (!sameContent(current, change.after)) {
          if (!(kind === "create" && current === null))
            recoveryNeeded = true;
        } else if (kind === "create")
          await unlink(change.path);
        else
          await atomicWrite(change.path, change.before, mode, change.after);
      } catch {
        recoveryNeeded = true;
      }
    }
    for (const directory of createdDirectories.toReversed()) {
      await rmdir(directory).catch(() => {});
    }
    if (written.length || createdDirectories.length) {
      journal.status = recoveryNeeded ? "recovery-needed" : "rolled-back";
      await writeFile(journalPath, JSON.stringify(journal, null, 2) + `
`).catch(() => {});
    }
    if (recoveryNeeded)
      throw new Error(`RECOVERY_NEEDED: inspect ${journalPath}; ${String(error)}`);
    throw error;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

// src/languages.ts
import { extname } from "node:path";
var languageOperations = {
  typescript: ["rename", "imports", "format", "extract-function", "extract-variable", "rename-file", "move-type"],
  csharp: ["rename", "imports", "format", "rename-file", "sync-namespace", "move-type"]
};
function languageForProject(project) {
  const extension = extname(project).toLowerCase();
  if (extension === ".csproj" || extension === ".sln")
    return "csharp";
  if (extension === ".json")
    return "typescript";
  throw new Error("UNSUPPORTED_PROJECT: use tsconfig/jsconfig.json, .csproj or .sln");
}

// src/api.ts
function offset(text, point) {
  const match = /^(\d+):(\d+)$/.exec(point);
  if (!match)
    throw new Error(`INVALID_POSITION: ${point}`);
  const line = Number(match[1]), column = Number(match[2]);
  const lines = text.split(`
`);
  if (line < 1 || line > lines.length || column < 1 || column > lines[line - 1].replace(/\r$/, "").length + 1) {
    throw new Error(`INVALID_POSITION: ${point}`);
  }
  return lines.slice(0, line - 1).reduce((total, item) => total + item.length + 1, 0) + column - 1;
}
function createRefactorApi(context) {
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("UNSUPPORTED_RUNTIME: Node.js 22+ is required");
  function assertLanguage(project, backend) {
    if (context.language && (languageForProject(project) !== context.language || backend !== undefined && backend !== (context.language === "typescript" ? "typescript" : "roslyn"))) {
      throw new Error(`UNSUPPORTED_LANGUAGE: this tool only supports ${context.language === "typescript" ? "TypeScript/JavaScript" : "C#"}`);
    }
  }
  function checkPlan(plan) {
    assertPlanShape(plan);
    assertLanguage(plan.request.project, plan.backend);
  }
  return {
    async plan(options) {
      const { project, request } = await resolveRequest();
      const engine = await context.loadBackend(project, context.toolkitRoot);
      return createPlan(request, engine.analyze);
      async function resolveRequest() {
        const operation = options.operation ?? context.operation;
        if (!operation || !Object.values(languageOperations).some((items) => items.includes(operation)))
          throw new Error(`UNSUPPORTED: ${operation}`);
        if (context.operation && operation !== context.operation)
          throw new Error(`UNSUPPORTED: this tool only supports ${context.operation}`);
        assertLanguage(options.project);
        if (options.targetProject)
          assertLanguage(options.targetProject);
        if (options.mode !== undefined && !["sort", "remove-unused"].includes(options.mode))
          throw new Error("INVALID_ARGUMENT: mode sort|remove-unused");
        if (operation === "move-type" && !options.target)
          throw new Error("INVALID_ARGUMENT: target required for move-type");
        if ((options.target !== undefined || options.targetProject !== undefined) && operation !== "move-type") {
          throw new Error("INVALID_ARGUMENT: target and targetProject require move-type");
        }
        const project2 = await realpath3(resolve4(options.project));
        const file = await realpath3(resolve4(options.file));
        const root = await realpath3(resolve4(options.root ?? dirname3(project2)));
        const text = await readFile4(file, "utf8");
        const position = (point) => {
          if (typeof point === "string")
            return offset(text, point);
          if (!Number.isInteger(point) || point < 0 || point > text.length)
            throw new Error(`INVALID_POSITION: ${point}`);
          return point;
        };
        const request2 = {
          project: project2,
          root,
          file,
          operation,
          ...options.at !== undefined ? { position: position(options.at) } : {},
          ...options.end !== undefined ? { end: position(options.end) } : {},
          ...options.name !== undefined ? { newName: options.name } : {},
          ...operation === "imports" ? { mode: options.mode ?? (context.language === "csharp" ? "remove-unused" : "sort") } : {},
          ...options.target !== undefined ? { target: resolve4(options.target) } : {},
          ...options.targetProject !== undefined ? { targetProject: await realpath3(resolve4(options.targetProject)) } : {},
          ...options.typeName !== undefined ? { typeName: options.typeName } : {},
          ...options.rootNamespace !== undefined ? { rootNamespace: options.rootNamespace } : {}
        };
        return { project: project2, request: request2 };
      }
    },
    preview(plan) {
      checkPlan(plan);
      return preview(plan);
    },
    async validate(plan) {
      checkPlan(plan);
      await assertFresh(plan);
      return { status: plan.validation.status === "passed" ? "validated" : "failed", validation: plan.validation, id: plan.id };
    },
    async apply(plan) {
      checkPlan(plan);
      return applyPlan(plan);
    },
    async loadPlan(path) {
      const plan = await loadPlan(resolve4(path));
      checkPlan(plan);
      return plan;
    },
    async capabilities(project) {
      assertLanguage(project);
      const engine = await context.loadBackend(await realpath3(resolve4(project)), context.toolkitRoot);
      return engine.capabilities.filter((item) => !context.operation || item.operation === context.operation).map((item) => ({ ...item, ...item.modes ? { modes: [...item.modes] } : {} }));
    }
  };
}
// src/help.ts
var operationHelp = {
  rename: {
    description: "Rename a symbol and its semantic references.",
    support: "TypeScript, JavaScript and C#",
    required: "--at <line:column> --name <identifier>",
    details: "Comments and string literals are excluded. Use a .sln and a common --root for C# callers across projects. External consumers and dynamic references are outside the loaded scope.",
    examples: [
      "plan rename --project examples/typescript/tsconfig.json --file examples/typescript/math.ts --at 1:17 --name sum",
      "plan rename --project examples/javascript/jsconfig.json --file examples/javascript/math.js --at 2:17 --name sum",
      "plan rename --project examples/csharp/Caller.csproj --file examples/csharp/Utility.cs --at 7:23 --name Sum"
    ]
  },
  imports: {
    description: "Sort imports or explicitly remove unused imports / using directives.",
    support: "TS/JS: sort and remove-unused; C#: remove-unused only",
    required: "[--mode <sort|remove-unused>]",
    details: "Default mode: sort. C# requires --mode remove-unused. TS sort retains unused imports. Sorting can change module initialization order; removing an unused value import can remove initialization. Bare side-effect imports are retained.",
    examples: [
      "plan imports --project examples/typescript/tsconfig.json --file examples/typescript/caller.ts --mode sort",
      "plan imports --project examples/javascript/jsconfig.json --file examples/javascript/caller.js --mode remove-unused",
      "plan imports --project examples/csharp/Caller.csproj --file examples/csharp/Utility.cs --mode remove-unused"
    ]
  },
  format: {
    description: "Format a file using the TypeScript or Roslyn formatter.",
    support: "TypeScript, JavaScript and C#",
    required: "No additional required options.",
    details: "TS/JS uses the runner's fixed formatting settings; C# uses Roslyn document options. An already formatted file produces a plan with no changes.",
    examples: [
      "plan format --project examples/typescript/tsconfig.json --file examples/typescript/math.ts",
      "plan format --project examples/csharp/Caller.csproj --file examples/csharp/Utility.cs"
    ]
  },
  "extract-function": {
    description: "Extract selected statements or an expression into a named function.",
    support: "TypeScript and JavaScript; C# extraction is unavailable",
    required: "--at <line:column> --end <line:column> --name <identifier>",
    details: "The end position is exclusive. The TypeScript engine chooses the scope, parameters and returned values; semantic rename assigns the requested name. Invalid ranges and name conflicts are rejected.",
    examples: [
      "plan extract-function --project examples/typescript/tsconfig.json --file examples/typescript/math.ts --at 2:3 --end 2:23 --name sumParts"
    ]
  },
  "extract-variable": {
    description: "Extract an expression into a named constant.",
    support: "TypeScript and JavaScript; C# extraction is unavailable",
    required: "--at <line:column> --end <line:column> --name <identifier>",
    details: "The end position is exclusive. Scope and edits come from the TypeScript refactoring action, followed by semantic rename. Unsupported expressions and name conflicts are rejected.",
    examples: [
      "plan extract-variable --project examples/typescript/tsconfig.json --file examples/typescript/math.ts --at 2:10 --end 2:22 --name total"
    ]
  },
  "rename-file": {
    description: "Rename a source file to match a selected declared type.",
    support: "TypeScript, JavaScript and C#",
    required: "[--type <identifier> | --at <line:column>]",
    details: "The only top-level type is selected automatically. Select explicitly when several types are declared. The extension is retained and the whole file is renamed; other declarations remain in it. TS/JS import paths and supported project file lists are updated. C# explicit Compile entries are updated. Existing targets and unsupported case-only renames are rejected.",
    examples: [
      "plan rename-file --project ./tsconfig.json --file ./src/Wrong.ts --type Widget",
      "plan rename-file --project ./App.csproj --file ./Models/Wrong.cs --type Widget"
    ]
  },
  "sync-namespace": {
    description: "Align a C# file's namespace with RootNamespace and its project-relative folders.",
    support: "C# only; ES modules have no namespace-to-folder convention",
    required: "[--root-namespace <dotted-name>]",
    details: "Updates the selected file's types and semantic references while retaining other files in their original namespace. Use a .sln for callers across projects. Multiple/nested namespaces, conditional compilation and partial declarations spread across files are rejected.",
    examples: [
      "plan sync-namespace --project ./App.csproj --file ./Models/Widget.cs",
      "plan sync-namespace --project ./Workspace.sln --root . --file ./App/Models/Widget.cs --root-namespace Company.App"
    ]
  },
  "move-type": {
    description: "Move a selected top-level type into another file or project.",
    support: "TypeScript, JavaScript and C#",
    required: "--to <destination-file> [--type <identifier> | --at <line:column>] [--target-project <config>] [--root-namespace <dotted-name>]",
    details: "The only top-level type is selected automatically. Other declarations stay in the source; an empty source may be deleted. Missing destination directories are created during apply. Use a --root covering source, destination and callers. Cross-project moves use --target-project; C# requires a loaded target project (normally through a .sln) and a new destination file. TS/JS source must use ES modules, even when compiled to CommonJS. TS projects need compatible module resolution settings; composite projects require valid references. TS/JS runtime declarations with effectful static initializers, static blocks, decorators, computed members, evaluated base-class expressions or nonconstant enum initializers are rejected (INITIALIZATION_EFFECTS_UNSUPPORTED). Simple identifier base classes are supported when the move introduces no module cycle. Compiler checks do not prove whole-program behavior equivalence; run application tests. C# keeps global using directives in the source project, plans unconditional required ProjectReference edits and follows the destination namespace convention when the source follows its convention, otherwise retaining the custom namespace unless overridden. A cross-project C# move changes assembly identity. Cycles, inaccessible dependencies, unsupported project rules and new compiler errors are rejected.",
    examples: [
      "plan move-type --project ./tsconfig.json --file ./src/types.ts --type Widget --to ./src/models/Widget.ts",
      "plan move-type --project ./Source/tsconfig.json --root . --file ./Source/types.ts --type Widget --to ./Target/Models/Widget.ts --target-project ./Target/tsconfig.json",
      "plan move-type --project ./Workspace.sln --root . --file ./Source/Types.cs --type Widget --to ./Target/Models/Widget.cs --target-project ./Target/Target.csproj"
    ]
  }
};
var languageDetails = {
  typescript: {
    rename: { details: "Comments and string literals are excluded. References are resolved within the configured project; external consumers and dynamic references are outside the loaded scope." },
    imports: { description: "Sort imports or explicitly remove unused imports.", details: "Default mode: sort. Sorting retains unused imports and can change module initialization order. Removing an unused value import can remove initialization; bare side-effect imports are retained." },
    format: { description: "Format a file with the TypeScript formatter.", details: "Uses the runner's fixed formatting settings. An already formatted file produces a plan with no changes." },
    "rename-file": { details: "The only top-level type is selected automatically; select explicitly when several exist. Renames the whole file and keeps its extension and other declarations. Compiler-resolved imports and supported project file lists are updated. Existing targets and unsupported case-only renames are rejected." },
    "move-type": { details: "Select a top-level type explicitly when several exist. Other declarations stay in the source; an empty source may be deleted. Missing destination directories are created during apply. Use a --root covering source, destination and callers, and --target-project for a cross-project move. Sources must use ES modules; compatible module resolution and valid composite project references are required. Effectful static initializers, static blocks, decorators, computed members, evaluated bases and nonconstant enum initializers are rejected (INITIALIZATION_EFFECTS_UNSUPPORTED). Simple identifier bases are supported if no new module cycle is introduced. Compiler checks do not prove whole-program behavior equivalence; run application tests." }
  },
  csharp: {
    imports: { description: "Remove unused C# using directives identified by Roslyn.", required: "[--mode remove-unused]", details: "The C# package defaults to remove-unused; sorting is unsupported. Uses Roslyn's built-in compiler diagnostics." },
    format: { description: "Format a C# file with the Roslyn Formatter API.", details: "Uses Roslyn document options. An already formatted file produces a plan with no changes." },
    "rename-file": { details: "The only top-level type is selected automatically; select explicitly when several exist. Renames the whole file and keeps its extension and other declarations. Explicit Compile entries are updated. Existing targets and unsupported case-only renames are rejected." },
    "move-type": { details: "Select a top-level type explicitly when several exist. Other declarations stay in the source; an empty source may be deleted. Missing destination directories are created during apply. Use a --root covering source, destination and callers. Cross-project moves require a loaded target project, normally through a .sln, --target-project and a new destination file. Global using directives stay in the source project. Required ProjectReference edits are unconditional. The destination namespace convention is followed when the source follows its convention; custom namespaces are otherwise retained unless overridden. Moving between projects changes assembly identity. Cycles, inaccessible dependencies, unsupported project rules and new compiler errors are rejected. Run application tests after applying." }
  }
};
function operationHelpFor(operation, language) {
  const item = operationHelp[operation];
  if (!language)
    return item;
  return {
    ...item,
    ...languageDetails[language][operation],
    support: language === "typescript" ? "TypeScript and JavaScript" : "C#",
    examples: item.examples.filter((example) => language === "csharp" ? /--project \S+\.(csproj|sln)(?: |$)/.test(example) : /--project \S+\.json(?: |$)/.test(example))
  };
}
function optionsText(language) {
  const project = language === "typescript" ? "tsconfig.json or jsconfig.json" : language === "csharp" ? ".csproj or .sln" : "tsconfig.json, jsconfig.json, .csproj or .sln";
  return `  --project <config>       Required for capabilities and plan; ${project}.
${language !== "csharp" ? `                           Named TS configurations are supported by file/type operations.
` : ""}  --file <source>          Required for plan; file included by the selected project.
  --root <directory>       Boundary for source, configs and callers; defaults to
                           the project configuration's directory.
  --at <line:column>       Symbol/type position or extraction start, 1-based UTF-16.
  --end <line:column>      Extraction end, exclusive, 1-based UTF-16.
  --name <identifier>      Required new name for rename and extraction.
  --mode <mode>            imports: ${language === "csharp" ? "remove-unused (default); sorting is unsupported" : "sort (default) or remove-unused"}.
  --type <identifier>      Declared type for rename-file or move-type; select when
                           several types exist, or use --at.
  --to <file>              Required destination for move-type; relative to cwd.
  --target-project <config> Destination project config; move-type only.
${language !== "typescript" ? `  --root-namespace <name>  C# namespace convention override for sync-namespace
                           or move-type.
` : ""}  --out <plan.json>        Plan output; defaults to <root>/.refactor-ai/<id>.json.
                           Within root, store plans only in .refactor-ai;
                           an output path outside root is also allowed.
  --plan <plan.json>       Required for preview, validate and apply.
  --help, -h              Show general, command or operation help; no project needed.
`;
}
function contextText(language) {
  return `Paths are relative to the current working directory unless absolute. Quote paths
with spaces. Source/config paths must exist; a move destination may be new.
Positions count UTF-16 code units: an emoji occupies two columns. CRLF is supported.
${language !== "csharp" ? `TS/JS rename, imports, format and extract reject project references; file/type
operations validate supported project graphs and affected named configurations.
` : ""}`;
}
var requirements = `Requirements:
  Node.js 22+. Installed skill commands use npm to set up pinned TypeScript 5.9.3
  on first execution; initial setup needs network access and a writable skill
  directory. Help does not install dependencies or load a project.
  C#: .NET 8 SDK (dotnet in PATH), the project's required SDK/workloads and restored
  project dependencies. A skill builds its bundled Roslyn helper on first C# use;
  initial NuGet restore needs network access. Bun is for development builds only.
  Checkout setup: bun install --frozen-lockfile; bun run build:csharp; bun run build.
  Relocated C# runner: set REFACTOR_AI_HOME to the package directory containing
  dotnet/RefactorHelper. Installed skills locate their bundled helper automatically.
`;
function examples(invocation, commands) {
  return commands.map((command) => `  ${invocation} ${command}`).join(`
`);
}
function workflow(invocation) {
  return `Plan workflow:
  Planning computes edits and compiler diagnostics in memory; source files are
  untouched. Read the JSON response's plan path, then use that exact plan:
${examples(invocation, ["preview --plan ./path/to/plan.json", "validate --plan ./path/to/plan.json", "apply --plan ./path/to/plan.json"])}
  Validation checks snapshot freshness and stored compiler analysis; it does not
  run your project's tests. Apply requires passed validation and a fresh snapshot.
  Changed sources/configs require replanning. Multi-file writes use a journal and
  attempt rollback on failure; they are not a filesystem-wide atomic transaction.

Output and exit status:
  Status and capabilities: JSON on stdout. Help and preview: text on stdout.
  Errors: JSON on stderr. Exit 0: success (including no-op); exit 1: error or failed
  validation. Plans creating/deleting files use schemaVersion 2; edit-only and
  legacy plans use version 1. After interrupted apply inspect .refactor-ai/apply.lock
  and the .journal.json journal before recovery; preserve subsequent external edits.
`;
}
function operationText(operation, invocation, language) {
  const item = operationHelpFor(operation, language);
  return `${operation}: ${item.description}
  Languages: ${item.support}
  Operation options: ${item.required}
  ${item.details}
Examples (replace custom paths/type names with your project's values):
${examples(invocation, item.examples)}
`;
}
function helpRequested(args) {
  return args.length === 0 || args[0] === "help" || args.includes("--help") || args.includes("-h");
}
function renderHelp(args, invocation = "node dist/cli.js", runtimeRequirements = requirements, language) {
  const topics = args[0] === "help" ? args.slice(1) : args;
  const command = topics[0]?.startsWith("-") ? undefined : topics[0];
  const operation = topics[1]?.startsWith("-") ? undefined : topics[1];
  const known = ["capabilities", "plan", "preview", "validate", "apply"];
  if (command && !known.includes(command))
    throw new Error(`INVALID_ARGUMENT: unknown help command ${command}`);
  if (operation && (command !== "plan" || !Object.hasOwn(operationHelp, operation))) {
    throw new Error(`UNSUPPORTED: help topic ${command} ${operation}`);
  }
  if (operation && language && !languageOperations[language].includes(operation))
    throw new Error(`UNSUPPORTED: ${operation} is unavailable for ${language}`);
  const title = `refactor-ai — deterministic ${language === "typescript" ? "TypeScript/JavaScript" : language === "csharp" ? "C#" : "TypeScript/JavaScript and C#"} refactorings
`;
  const options = optionsText(language);
  const context = contextText(language);
  if (["preview", "validate", "apply"].includes(command ?? "")) {
    const descriptions = {
      preview: "Print the stored unified diff, including file creation/deletion. Does not write sources or check snapshot freshness; use validate before apply.",
      validate: "Check the plan's integrity, current snapshot and stored compiler analysis. Does not re-run compilation or project tests. A failed validation returns exit 1.",
      apply: "Apply the exact validated plan to an unchanged snapshot. Uses a lock and journal; on failure attempts to roll back its own writes. Replan after changes."
    };
    return `${title}
${command}: ${descriptions[command]}

Usage:
  ${invocation} ${command} --plan <plan.json>

Options:
  --plan <plan.json>  Required saved plan path.
  --help, -h         Show this help.

Examples:
${examples(invocation, [`${command} --plan ./.refactor-ai/saved-plan.json`, `${command} --plan "/path with spaces/plan.json"`])}

${workflow(invocation)}`;
  }
  if (command === "capabilities") {
    return `${title}
capabilities: List implemented operations and modes as JSON for the selected backend.

Usage:
  ${invocation} capabilities --project <config>

Options:
  --project <config>  Required ${language === "typescript" ? "tsconfig.json or jsconfig.json" : language === "csharp" ? ".csproj or .sln" : "tsconfig.json, jsconfig.json, .csproj or .sln"}.
  --help, -h          Show this help.

Examples:
${examples(invocation, ["capabilities --project examples/typescript/tsconfig.json", "capabilities --project examples/javascript/jsconfig.json", "capabilities --project examples/csharp/Caller.csproj"].filter((example) => !language || (language === "csharp" ? example.includes("csharp/") : !example.includes("csharp/"))))}

The configuration must exist. This command reports implemented backend capabilities,
not whether a particular source selection can be refactored. It does not load or
change source files.

${runtimeRequirements}`;
  }
  if (operation) {
    return `${title}
Usage:
  ${invocation} plan ${operation} --project <config> --file <source> [operation options]

${operationText(operation, invocation, language)}
Options and defaults:
${options}
${context}
${workflow(invocation)}
${runtimeRequirements}`;
  }
  const commands = command === "plan" ? `Usage:
  ${invocation} plan <operation> --project <config> --file <source> [options]
` : `Commands:
  capabilities --project <config>       List backend operations and modes (JSON).
  plan <operation> --project <config> --file <source> [options]
                                       Compute a plan without writing sources.
  preview --plan <plan.json>            Print a stored unified diff.
  validate --plan <plan.json>           Check freshness and stored validation.
  apply --plan <plan.json>              Apply the exact plan and journal writes.
  help [command] [operation]            Show help, also available via --help/-h.
`;
  return `${title}
${commands}
Help examples:
${examples(invocation, ["--help", "plan move-type --help", "help plan rename", "apply --help"])}

Options and defaults:
${options}
${context}
Operations:
${(language ? languageOperations[language] : Object.keys(operationHelp)).map((key) => operationText(key, invocation, language)).join(`
`)}
${workflow(invocation)}
${runtimeRequirements}`;
}

// src/cli-core.ts
function parse(args) {
  const command = args.shift() ?? "help";
  const operation = args[0] && !args[0].startsWith("--") ? args.shift() : undefined;
  const flags = {};
  const allowed = new Set(["project", "file", "root", "at", "end", "name", "mode", "out", "plan", "to", "target-project", "type", "root-namespace"]);
  while (args.length) {
    const key = args.shift();
    const value = args.shift();
    if (!key.startsWith("--") || !allowed.has(key.slice(2)) || !value || value.startsWith("--") || flags[key.slice(2)] !== undefined) {
      throw new Error(`INVALID_ARGUMENT: ${key}`);
    }
    flags[key.slice(2)] = value;
  }
  return { command, operation, flags };
}
function required(flags, key) {
  if (!flags[key])
    throw new Error(`INVALID_ARGUMENT: --${key} required`);
  return flags[key];
}
async function canonicalDirectory(path) {
  try {
    return await realpath4(path);
  } catch (error) {
    if (error.code !== "ENOENT")
      throw error;
    return resolve5(await canonicalDirectory(dirname4(path)), basename2(path));
  }
}
async function runCli(args, context) {
  if (helpRequested(args)) {
    process.stdout.write(renderHelp(args, context.invocation, undefined, context.language));
    return;
  }
  const { command, operation, flags } = parse([...args]);
  const api = createRefactorApi(context);
  if (["preview", "validate", "apply"].includes(command)) {
    const plan2 = await api.loadPlan(required(flags, "plan"));
    if (command === "preview") {
      process.stdout.write(api.preview(plan2) || `No changes.
`);
      return;
    }
    if (command === "apply") {
      console.log(JSON.stringify(await api.apply(plan2), null, 2));
      return;
    }
    console.log(JSON.stringify(await api.validate(plan2), null, 2));
    if (plan2.validation.status !== "passed")
      process.exitCode = 1;
    return;
  }
  if (command === "capabilities") {
    console.log(JSON.stringify(await api.capabilities(required(flags, "project")), null, 2));
    return;
  }
  if (command !== "plan")
    throw new Error(`INVALID_ARGUMENT: unknown command ${command}`);
  const plan = await api.plan({
    project: required(flags, "project"),
    file: required(flags, "file"),
    operation,
    root: flags.root,
    at: flags.at,
    end: flags.end,
    name: flags.name,
    mode: flags.mode,
    target: flags.to,
    targetProject: flags["target-project"],
    typeName: flags.type,
    rootNamespace: flags["root-namespace"]
  });
  const root = plan.request.root;
  let output = resolve5(flags.out ?? resolve5(root, ".refactor-ai", `${plan.id}.json`));
  const stateDirectory = resolve5(root, ".refactor-ai");
  const stateStat = await lstat4(stateDirectory).catch((error) => {
    if (error.code === "ENOENT")
      return;
    throw error;
  });
  if (stateStat?.isSymbolicLink())
    throw new Error("SYMLINK_UNSUPPORTED: state directory");
  output = resolve5(await canonicalDirectory(dirname4(output)), basename2(output));
  const within = (directory, path) => {
    const difference = relative3(directory, path);
    return difference !== ".." && !difference.startsWith(`..${sep3}`) && !isAbsolute2(difference);
  };
  if (within(root, output) && !within(stateDirectory, output)) {
    throw new Error("INVALID_ARGUMENT: store plan outside the project or in <root>/.refactor-ai to keep snapshot fresh");
  }
  await mkdir2(dirname4(output), { recursive: true });
  if (await realpath4(dirname4(output)) !== dirname4(output))
    throw new Error("SYMLINK_UNSUPPORTED: plan output directory changed");
  const outputStat = await lstat4(output).catch((error) => {
    if (error.code === "ENOENT")
      return;
    throw error;
  });
  if (outputStat?.isSymbolicLink())
    throw new Error("SYMLINK_UNSUPPORTED: plan output file");
  await writeFile2(output, JSON.stringify(plan, null, 2) + `
`);
  console.log(JSON.stringify({
    status: "planned",
    plan: output,
    id: plan.id,
    backend: plan.backend,
    files: plan.changes.map((c) => c.path),
    validation: plan.validation,
    notes: plan.notes
  }, null, 2));
  if (plan.validation.status !== "passed")
    process.exitCode = 1;
}

// src/backends/load.ts
var loadBackend = async (project, toolkitRoot) => {
  if (languageForProject(project) !== "csharp")
    return Promise.resolve().then(() => (init_typescript(), exports_typescript));
  const backend = await Promise.resolve().then(() => (init_csharp(), exports_csharp));
  return { capabilities: backend.capabilities, analyze: (request) => backend.analyze(request, toolkitRoot) };
};

// src/cli.ts
async function main(args, context = {}) {
  return runCli(args, { ...context, loadBackend });
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}
export {
  main,
  offset
};
