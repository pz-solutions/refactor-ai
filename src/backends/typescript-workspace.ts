import ts from "typescript";
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import type { Diagnostic } from "../types";
import { VirtualFs, fail, isInside } from "./typescript-vfs";
import { portablePath } from "./typescript-paths";

/**
 * A set of TS/JS projects ("participants") loaded over a VirtualFs.
 *
 * Supported graph: the source and target configs, every config under root whose
 * compiler program imports one of the affected files without a project
 * reference, every config that (transitively) references any of those, and the
 * transitive references of all of them. Variant configs (tsconfig.<name>.json,
 * e.g. tsconfig.build.json) that list an affected file and sit next to a graph
 * config join as observers: their file lists are edited and their programs are
 * validated, but they do not own files. Other variants that list an affected
 * file are rejected; base configs only used through `extends` are skipped. Edits are computed by one language
 * service over the union of the
 * participants' files (they must agree on module-resolution options, except paths/baseUrl
 * for whole-module moves, whose edges resolve per project); results
 * are validated per project like `tsc -b`, with referenced projects'
 * declarations emitted in memory instead of read from stale disk outputs.
 */

export const baseFormatOptions: ts.FormatCodeSettings = {
  indentSize: 2,
  tabSize: 2,
  newLineCharacter: "\n",
  convertTabsToSpaces: true,
  indentStyle: ts.IndentStyle.Smart,
  insertSpaceAfterCommaDelimiter: true,
  insertSpaceAfterSemicolonInForStatements: true,
  insertSpaceBeforeAndAfterBinaryOperators: true,
  insertSpaceAfterKeywordsInControlFlowStatements: true,
  insertSpaceAfterFunctionKeywordForAnonymousFunctions: false,
  insertSpaceBeforeFunctionParenthesis: false,
  insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
  semicolons: ts.SemicolonPreference.Insert,
};

export interface Participant {
  configPath: string;
  parsed: ts.ParsedCommandLine;
  references: string[];
  /** Declaration output directory; set when another participant references this project. */
  outputDirectory?: string;
  /** Variant config validated alongside a sibling project; it does not own files. */
  observer?: boolean;
}

const configName = /^(tsconfig|jsconfig)(\..+)?\.json$/;
const editorConfigName = /^(tsconfig|jsconfig)\.json$/;

/** Options that change how specifiers resolve or how files parse; participants must agree on them. */
const sharedOptionKeys = [
  "module", "moduleResolution", "moduleDetection", "baseUrl", "paths", "rootDirs", "allowJs", "jsx",
  "jsxImportSource", "esModuleInterop", "allowSyntheticDefaultImports", "resolveJsonModule",
  "resolvePackageJsonExports", "resolvePackageJsonImports", "customConditions", "moduleSuffixes",
  "allowImportingTsExtensions", "rewriteRelativeImportExtensions", "allowArbitraryExtensions",
  "verbatimModuleSyntax", "preserveSymlinks", "experimentalDecorators", "typeRoots",
] as const;

export function configPathFor(project: string): string {
  let stat;
  try { stat = statSync(project); } catch { fail("PROJECT_NOT_FOUND", project); }
  if (stat.isFile()) {
    if (!configName.test(basename(project))) fail("UNSUPPORTED_PROJECT", "project must name a tsconfig*.json or jsconfig*.json file");
    return resolve(project);
  }
  if (!stat.isDirectory()) fail("UNSUPPORTED_PROJECT", "project must be a config file or directory");
  const candidates = ["tsconfig.json", "jsconfig.json"].map((name) => resolve(project, name)).filter((path) => {
    try { return statSync(path).isFile(); } catch { return false; }
  });
  if (candidates.length === 0) fail("CONFIG_NOT_FOUND", `no tsconfig.json or jsconfig.json in ${project}`);
  if (candidates.length > 1) fail("MULTIPLE_CONFIGS", `both tsconfig.json and jsconfig.json exist in ${project}`);
  return candidates[0]!;
}

function discoverConfigs(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    let names: string[];
    try { names = readdirSync(directory).sort(); } catch { return; }
    for (const name of names) {
      const path = resolve(directory, name);
      let stat;
      try { stat = statSync(path); } catch { continue; }
      if (stat.isDirectory()) {
        if (name !== "node_modules" && !name.startsWith(".")) visit(path);
      } else if (stat.isFile() && configName.test(name)) {
        found.push(path);
      }
    }
  };
  visit(root);
  return found;
}

function flatten(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isDeclarationPath(path: string): boolean {
  return /\.d(\.[^./]+)?\.[cm]?ts$/.test(path);
}

export function scriptKindFor(path: string): ts.ScriptKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(lower)) return ts.ScriptKind.JS;
  if (lower.endsWith(".json")) return ts.ScriptKind.JSON;
  return ts.ScriptKind.TS;
}

/** String literals naming modules: imports, exports, require, import(), import types, JSDoc import types. */
export function moduleSpecifiers(sourceFile: ts.SourceFile): ts.StringLiteralLike[] {
  const found: ts.StringLiteralLike[] = [];
  const seen = new Set<ts.Node>();
  const isJs = /\.[cm]?jsx?$/i.test(sourceFile.fileName);
  const visit = (node: ts.Node): void => {
    if (seen.has(node)) return;
    seen.add(node);
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier);
    } else if (ts.isExternalModuleReference(node) && ts.isStringLiteralLike(node.expression)) {
      found.push(node.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0]!)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      found.push(node.arguments[0] as ts.StringLiteralLike);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      found.push(node.argument.literal);
    }
    if (isJs) for (const doc of ts.getJSDocCommentsAndTags(node)) visit(doc);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found.sort((a, b) => a.getStart(sourceFile) - b.getStart(sourceFile));
}

export class Workspace {
  readonly vfs: VirtualFs;
  readonly participants = new Map<string, Participant>();
  readonly order: string[] = [];
  readonly sourceConfig: string;
  readonly targetConfig: string;
  readonly editOptions: ts.CompilerOptions;
  readonly service: ts.LanguageService;
  private readonly discovered: string[];
  /** Configs that joined the graph only because their programs import an affected file. */
  readonly importingConfigs: string[] = [];
  /** Per-config computed output root from the last diagnostics() run (emitting projects without rootDir only). */
  layouts = new Map<string, string>();
  private owners = new Map<string, string[]>();
  private readonly sourceFiles = new Map<string, { text: string; file: ts.SourceFile }>();
  private readonly looseConfigs = new Map<string, { text: string | undefined; parsed: ts.ParsedCommandLine | undefined }>();
  private extendedConfigs: Set<string> | undefined;

  /** `affected` are the files whose module shape the operation changes (renamed, moved from or into). */
  constructor(readonly root: string, sourceConfig: string, targetConfig: string, private readonly affected: string[] = [], private readonly relocateModules = false) {
    this.vfs = new VirtualFs(root);
    this.sourceConfig = sourceConfig;
    this.targetConfig = targetConfig;
    for (const config of [sourceConfig, targetConfig]) {
      if (!isInside(root, config)) fail("OUTSIDE_ROOT", `project config is outside ${root}: ${config}`);
    }
    this.discovered = discoverConfigs(root);
    this.loadGraph();
    this.editOptions = { ...this.participant(sourceConfig).parsed.options, noEmit: true };
    for (const key of ["configFile", "configFilePath", "composite", "incremental", "tsBuildInfoFile", "declaration", "declarationMap",
      "emitDeclarationOnly", "declarationDir", "outDir", "rootDir"]) delete this.editOptions[key];
    const vfs = this.vfs;
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => this.editOptions,
      getScriptFileNames: () => this.unionFiles(),
      getScriptVersion: (fileName) => vfs.scriptVersion(fileName),
      getScriptSnapshot: (fileName) => {
        const text = vfs.readFile(fileName);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getScriptKind: (fileName) => scriptKindFor(fileName),
      getCurrentDirectory: () => dirname(sourceConfig),
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: (path) => vfs.fileExists(path),
      readFile: (path) => vfs.readFile(path),
      readDirectory: (path, extensions, excludes, includes, depth) => vfs.readDirectory(path, extensions, excludes, includes, depth),
      directoryExists: (path) => vfs.directoryExists(path),
      getDirectories: (path) => vfs.getDirectories(path),
      realpath: (path) => vfs.realpath(path),
      useCaseSensitiveFileNames: () => vfs.caseSensitive,
      getNewLine: () => "\n",
      getProjectVersion: () => String(vfs.version),
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry(vfs.caseSensitive));
  }

  dispose(): void {
    this.service.dispose();
  }

  participant(config: string): Participant {
    const found = this.participants.get(this.vfs.key(config));
    if (!found) fail("UNHANDLED_PROJECT_GRAPH", `${config} is not part of the loaded project graph`);
    return found;
  }

  private parse(configPath: string, useDisk = false, planned = false): ts.ParsedCommandLine {
    const onError = (diagnostic: ts.Diagnostic) => fail("INVALID_CONFIG", `${configPath}: ${flatten(diagnostic)}`);
    const host: ts.ParseConfigFileHost = useDisk ? { ...ts.sys, onUnRecoverableConfigFileDiagnostic: onError } : this.vfs.parseConfigHost(onError);
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, host);
    if (!parsed) fail("INVALID_CONFIG", `could not parse ${configPath}`);
    const errors = parsed.errors.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    if (planned && errors.some((diagnostic) => diagnostic.code === 18003)) {
      fail("PROJECT_WOULD_BE_EMPTY", `${configPath} would no longer include any source file`);
    }
    if (errors.length) fail("INVALID_CONFIG", `${configPath}: ${flatten(errors[0]!)}`);
    return parsed;
  }

  private rawReferences(configPath: string): string[] {
    const result = ts.readConfigFile(configPath, (path) => this.vfs.readFile(path));
    const references: unknown = result.config?.references;
    if (!Array.isArray(references)) return [];
    return references
      .map((reference: { path?: unknown }) => typeof reference?.path === "string"
        ? resolve(ts.resolveProjectReferencePath({ path: resolve(dirname(configPath), reference.path) }))
        : undefined)
      .filter((path): path is string => path !== undefined);
  }

  private loadGraph(): void {
    const vfs = this.vfs;
    const affected = new Set([vfs.key(this.sourceConfig), vfs.key(this.targetConfig)]);
    const paths = new Map([[vfs.key(this.sourceConfig), this.sourceConfig], [vfs.key(this.targetConfig), this.targetConfig]]);
    for (const config of this.discovered) {
      if (affected.has(vfs.key(config)) || !this.importsAffected(config, this.affected)) continue;
      affected.add(vfs.key(config));
      paths.set(vfs.key(config), config);
      this.importingConfigs.push(config);
    }
    const graphDirectories = new Set([...affected].map((key) => vfs.key(dirname(paths.get(key)!))));
    const observers = new Set<string>();
    for (const config of this.discovered) {
      if (affected.has(vfs.key(config)) || editorConfigName.test(basename(config)) || this.isBaseConfig(config)) continue;
      if (!graphDirectories.has(vfs.key(dirname(config))) || !this.listsAny(config, this.affected)) continue;
      affected.add(vfs.key(config));
      paths.set(vfs.key(config), config);
      observers.add(vfs.key(config));
    }
    const rawReferences = new Map(this.discovered.map((config) => [vfs.key(config), this.rawReferences(config)]));
    let grew = true;
    while (grew) {
      grew = false;
      for (const config of this.discovered) {
        if (affected.has(vfs.key(config))) continue;
        if (rawReferences.get(vfs.key(config))!.some((reference) => affected.has(vfs.key(reference)))) {
          affected.add(vfs.key(config));
          paths.set(vfs.key(config), config);
          grew = true;
        }
      }
    }

    const diskParsed = new Map<string, ts.ParsedCommandLine>();
    const pending = [...affected].map((key) => paths.get(key)!);
    while (pending.length) {
      const config = pending.shift()!;
      const key = vfs.key(config);
      if (diskParsed.has(key)) continue;
      if (!isInside(this.root, config)) fail("OUTSIDE_ROOT", `referenced project is outside ${this.root}: ${config}`);
      if (!vfs.fileExists(config)) fail("PROJECT_NOT_FOUND", `referenced project does not exist: ${config}`);
      const parsed = this.parse(config, true);
      diskParsed.set(key, parsed);
      paths.set(key, config);
      for (const reference of parsed.projectReferences ?? []) pending.push(resolve(ts.resolveProjectReferencePath(reference)));
    }

    for (const [key, parsed] of diskParsed) {
      const configPath = paths.get(key)!;
      if (parsed.options.outFile) fail("UNSUPPORTED_PROJECT", `${configPath}: outFile bundles are not supported`);
      const references = (parsed.projectReferences ?? []).map((reference) => resolve(ts.resolveProjectReferencePath(reference)));
      if (references.some((reference) => !diskParsed.has(vfs.key(reference)))) {
        fail("UNHANDLED_PROJECT_GRAPH", `${configPath} references a project that could not be loaded`);
      }
      if ((parsed.projectReferences ?? []).some((reference) => reference.prepend)) {
        fail("UNSUPPORTED_PROJECT", `${configPath}: prepended project references are not supported`);
      }
      this.participants.set(key, { configPath, parsed, references, observer: observers.has(key) });
    }

    const referenced = new Set([...this.participants.values()].flatMap((item) => item.references.map((path) => vfs.key(path))));
    const outputs: string[] = [];
    for (const key of referenced) {
      const item = this.participants.get(key)!;
      const output = item.parsed.options.declarationDir ?? item.parsed.options.outDir;
      if (!output) {
        fail("DECLARATION_OUTPUT_UNSUPPORTED", `${item.configPath} is referenced by another project and must emit declarations to outDir or declarationDir`);
      }
      if (!isInside(this.root, output) || vfs.samePath(output, dirname(item.configPath)) || vfs.contains(output, dirname(item.configPath))) {
        fail("DECLARATION_OUTPUT_UNSUPPORTED", `${item.configPath}: declaration output directory must be a dedicated directory inside ${this.root}`);
      }
      item.outputDirectory = resolve(output);
      outputs.push(item.outputDirectory);
    }
    vfs.setHiddenDirectories(outputs);

    for (const [key, item] of this.participants) {
      const disk = diskParsed.get(key)!.fileNames.map((path) => vfs.key(path)).sort();
      item.parsed = this.parse(item.configPath);
      const virtual = item.parsed.fileNames.map((path) => vfs.key(path)).sort();
      const inOutputs = item.parsed.fileNames.concat(diskParsed.get(key)!.fileNames).find((path) => vfs.isHidden(path));
      if (inOutputs) fail("DECLARATION_OUTPUT_UNSUPPORTED", `${item.configPath} includes a file inside a declaration output directory: ${inOutputs}`);
      if (!sameValue(disk, virtual)) {
        fail("CONFIG_PATTERNS_UNSUPPORTED", `${item.configPath}: include/exclude patterns could not be reproduced exactly for in-memory planning`);
      }
      const outside = item.parsed.fileNames.find((path) => !isInside(this.root, path));
      if (outside) fail("OUTSIDE_ROOT", `${item.configPath} includes ${outside}, outside ${this.root}`);
    }

    const state = new Map<string, "visiting" | "done">();
    const visit = (key: string, trail: string[]) => {
      if (state.get(key) === "done") return;
      if (state.get(key) === "visiting") fail("UNHANDLED_PROJECT_GRAPH", `project reference cycle: ${[...trail, key].join(" -> ")}`);
      state.set(key, "visiting");
      for (const reference of this.participants.get(key)!.references) visit(vfs.key(reference), [...trail, key]);
      state.set(key, "done");
      this.order.push(key);
    };
    for (const key of [...this.participants.keys()].sort()) visit(key, []);

    const withFiles = [...this.participants.values()].filter((item) => item.parsed.fileNames.length > 0);
    const first = this.participant(this.sourceConfig);
    for (const item of withFiles) {
      for (const option of sharedOptionKeys) {
        if (this.relocateModules && (option === "paths" || option === "baseUrl")) continue;
        if (!sameValue(item.parsed.options[option], first.parsed.options[option])) {
          fail("PROJECT_OPTIONS_INCOMPATIBLE", `${item.configPath} and ${first.configPath} differ in compiler option '${option}'; cross-project planning requires identical module resolution settings`);
        }
      }
    }
    const configDirectories = new Set(withFiles.map((item) => vfs.key(dirname(item.configPath))));
    if (!this.relocateModules && configDirectories.size > 1 && first.parsed.options.paths && !first.parsed.options.baseUrl) {
      fail("PROJECT_OPTIONS_INCOMPATIBLE", "'paths' without 'baseUrl' resolves relative to each config; set baseUrl to plan across projects");
    }
    this.indexOwners();
  }

  private indexOwners(): void {
    this.owners = new Map();
    for (const item of this.participants.values()) {
      if (item.observer) continue;
      for (const path of item.parsed.fileNames) {
        const key = this.vfs.key(path);
        this.owners.set(key, [...(this.owners.get(key) ?? []), item.configPath]);
      }
    }
  }

  /** Re-read every participant config through the overlays (new/deleted files, edited configs). */
  reparse(): void {
    for (const item of this.participants.values()) item.parsed = this.parse(item.configPath, false, true);
    this.indexOwners();
    this.vfs.version += 1;
  }

  ownersOf(path: string): string[] {
    return this.owners.get(this.vfs.key(path)) ?? [];
  }

  isObserver(config: string): boolean {
    return this.participant(config).observer === true;
  }

  observers(): string[] {
    return [...this.participants.values()].filter((item) => item.observer).map((item) => item.configPath).sort();
  }

  references(config: string): string[] {
    return this.participant(config).references;
  }

  fileNames(config: string): string[] {
    return this.participant(config).parsed.fileNames.map((path) => resolve(path));
  }

  unionFiles(): string[] {
    const files = new Map<string, string>();
    for (const item of this.participants.values()) for (const path of item.parsed.fileNames) files.set(this.vfs.key(path), resolve(path));
    return [...files.values()].sort();
  }

  program(): ts.Program {
    const program = this.service.getProgram();
    if (!program) fail("PROGRAM_UNAVAILABLE", "TypeScript could not create a program");
    return program;
  }

  resolveModule(specifier: ts.StringLiteralLike, sourceFile: ts.SourceFile, options?: ts.CompilerOptions): ts.ResolvedModuleFull | undefined {
    options ??= this.ownersOf(sourceFile.fileName)[0] ? this.participant(this.ownersOf(sourceFile.fileName)[0]!).parsed.options : this.editOptions;
    const mode = ts.getModeForUsageLocation(sourceFile, specifier, options);
    return ts.resolveModuleName(specifier.text, sourceFile.fileName, options, this.vfs.moduleResolutionHost(), undefined, undefined, mode).resolvedModule;
  }

  /** Lenient parse of a config outside the graph through the overlays; undefined when unreadable. */
  private looseParse(config: string): ts.ParsedCommandLine | undefined {
    const text = this.vfs.readFile(config);
    const cached = this.looseConfigs.get(this.vfs.key(config));
    if (cached && cached.text === text) return cached.parsed;
    let parsed: ts.ParsedCommandLine | undefined;
    try {
      parsed = ts.getParsedCommandLineOfConfigFile(config, undefined, this.vfs.parseConfigHost(() => { throw new Error("unparseable"); }));
    } catch {
      parsed = undefined;
    }
    this.looseConfigs.set(this.vfs.key(config), { text, parsed });
    return parsed;
  }

  /** True when the config's own file list (include/files, possibly inherited) names one of `paths`. */
  private listsAny(config: string, paths: string[]): boolean {
    if (!paths.length) return false;
    const parsed = this.looseParse(config);
    if (!parsed) fail("UNHANDLED_PROJECT_GRAPH", `${config} cannot be parsed, so it cannot be shown to be unaffected`);
    const listed = new Set(parsed.fileNames.map((path) => this.vfs.key(path)));
    return paths.some((path) => listed.has(this.vfs.key(path)));
  }

  /**
   * A variant config that only carries shared options: another config under
   * root extends it and it declares no files, include or references itself.
   * Editor configs (tsconfig.json/jsconfig.json) are never treated as bases.
   */
  private isBaseConfig(config: string): boolean {
    if (editorConfigName.test(basename(config))) return false;
    if (!this.extendedConfigs) {
      this.extendedConfigs = new Set();
      for (const candidate of this.discovered) {
        const raw: unknown = ts.readConfigFile(candidate, (path) => this.vfs.diskText(path) ?? undefined).config?.extends;
        for (const entry of Array.isArray(raw) ? raw : [raw]) {
          if (typeof entry !== "string" || !/^\.\.?[\\/]/.test(entry)) continue;
          const path = resolve(dirname(candidate), entry);
          this.extendedConfigs.add(this.vfs.key(/\.json$/i.test(path) ? path : `${path}.json`));
        }
      }
    }
    if (!this.extendedConfigs.has(this.vfs.key(config))) return false;
    const own = ts.readConfigFile(config, (path) => this.vfs.diskText(path) ?? undefined).config;
    return !own || !["files", "include", "references"].some((key) => key in own);
  }

  /**
   * True when the config does not list any of `paths` itself but its compiler
   * program reaches one of them through imports (a disconnected caller).
   */
  private importsAffected(config: string, paths: string[]): boolean {
    if (!paths.length) return false;
    const parsed = this.looseParse(config);
    if (!parsed) fail("UNHANDLED_PROJECT_GRAPH", `${config} cannot be parsed, so it cannot be shown to be unaffected`);
    const listed = new Set(parsed.fileNames.map((path) => this.vfs.key(path)));
    if (!parsed.fileNames.length || paths.some((path) => listed.has(this.vfs.key(path)))) return false;
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: { ...parsed.options, noEmit: true },
      projectReferences: parsed.projectReferences,
      host: this.compilerHost(config, parsed.options),
    });
    const wanted = new Set(paths.map((path) => this.vfs.key(path)));
    return program.getSourceFiles().some((sourceFile) => wanted.has(this.vfs.key(sourceFile.fileName)));
  }

  /**
   * Rejects configs outside the graph that would observe the paths: configs
   * (other than extends-only bases) that list one of them, and any config
   * whose compiler program imports one of them (skippable when the graph was
   * built from the same paths, which already absorbed such importers).
   */
  assertNoUnhandledProjects(paths: string[], useOriginal: boolean, checkImports = true): void {
    const check = () => {
      for (const config of this.discovered) {
        if (this.participants.has(this.vfs.key(config))) continue;
        if (!this.isBaseConfig(config)) {
          const parsed = this.looseParse(config);
          if (!parsed) fail("UNHANDLED_PROJECT_GRAPH", `${config} cannot be parsed, so it cannot be shown to be unaffected`);
          const included = new Set(parsed.fileNames.map((path) => this.vfs.key(path)));
          const hit = paths.find((path) => included.has(this.vfs.key(path)));
          if (hit && editorConfigName.test(basename(config))) {
            fail("UNHANDLED_PROJECT_GRAPH", `${config} also includes ${hit} but is not connected to ${this.sourceConfig} by project references`);
          }
          if (hit) {
            fail("UNHANDLED_PROJECT_GRAPH", `${config} also includes ${hit} but is neither a project in the planned graph nor a variant next to one; it would not be updated or validated`);
          }
        }
        if (checkImports && this.importsAffected(config, paths)) {
          fail("UNHANDLED_PROJECT_GRAPH", `${config} imports a changed file (${paths.map((path) => relative(this.root, path)).join(", ")}) but was not part of the planned project graph`);
        }
      }
    };
    if (useOriginal) this.vfs.original(check); else check();
  }

  private sourceFile(fileName: string, settings: ts.ScriptTarget | ts.CreateSourceFileOptions, options: ts.CompilerOptions): ts.SourceFile | undefined {
    const text = this.vfs.readFile(fileName);
    if (text === undefined) return undefined;
    const detail = typeof settings === "object"
      ? `${settings.languageVersion}|${settings.impliedNodeFormat}|${settings.jsDocParsingMode}`
      : String(settings);
    const key = `${this.vfs.key(fileName)}|${detail}|${options.moduleDetection}|${options.jsx}`;
    const cached = this.sourceFiles.get(key);
    if (cached?.text === text) return cached.file;
    const file = ts.createSourceFile(fileName, text, settings, false, scriptKindFor(fileName));
    this.sourceFiles.set(key, { text, file });
    return file;
  }

  private compilerHost(configPath: string, options: ts.CompilerOptions): ts.CompilerHost {
    const vfs = this.vfs;
    return {
      getSourceFile: (fileName, settings) => this.sourceFile(fileName, settings, options),
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      writeFile: () => {},
      getCurrentDirectory: () => dirname(configPath),
      getCanonicalFileName: (fileName) => vfs.caseSensitive ? fileName : fileName.toLowerCase(),
      useCaseSensitiveFileNames: () => vfs.caseSensitive,
      getNewLine: () => "\n",
      fileExists: (path) => vfs.fileExists(path),
      readFile: (path) => vfs.readFile(path),
      readDirectory: (path, extensions, excludes, includes, depth) => vfs.readDirectory(path, extensions, excludes, includes, depth),
      directoryExists: (path) => vfs.directoryExists(path),
      getDirectories: (path) => vfs.getDirectories(path),
      realpath: (path) => vfs.realpath(path),
      getParsedCommandLine: (fileName) => this.participants.get(vfs.key(fileName))?.parsed ?? this.looseParse(fileName),
    };
  }

  /**
   * Type-check every participant in reference order, emitting declarations of
   * referenced projects in memory so dependents see the planned state. Like
   * `tsc -p`, each program reports every user source file it compiles,
   * including files of other projects it imports directly; a diagnostic seen
   * by several programs is reported with its highest per-program multiplicity.
   */
  diagnostics(): Diagnostic[] {
    const vfs = this.vfs;
    vfs.clearGenerated();
    this.layouts = new Map();
    const referenced = new Set([...this.participants.values()].flatMap((item) => item.references.map((path) => vfs.key(path))));
    const merged = new Map<string, { record: Diagnostic; count: number }>();
    for (const key of this.order) {
      const item = this.participants.get(key)!;
      const program = ts.createProgram({
        rootNames: item.parsed.fileNames,
        options: item.parsed.options,
        projectReferences: item.parsed.projectReferences,
        host: this.compilerHost(item.configPath, item.parsed.options),
      });
      const counts = new Map<string, { record: Diagnostic; count: number }>();
      const add = (diagnostic: ts.Diagnostic) => {
        if (diagnostic.category !== ts.DiagnosticCategory.Error) return;
        const record = {
          file: diagnostic.file ? resolve(diagnostic.file.fileName) : item.configPath,
          code: `TS${diagnostic.code}`,
          message: flatten(diagnostic),
        };
        const recordKey = `${record.file}\0${record.code}\0${record.message}`;
        const entry = counts.get(recordKey) ?? { record, count: 0 };
        entry.count += 1;
        counts.set(recordKey, entry);
      };
      program.getOptionsDiagnostics().forEach(add);
      program.getGlobalDiagnostics().forEach(add);
      for (const sourceFile of program.getSourceFiles()) {
        const path = resolve(sourceFile.fileName);
        if (!isInside(this.root, path)) {
          if (!sourceFile.isDeclarationFile) fail("PROJECT_SCOPE_INCOMPLETE", `${item.configPath} uses user source outside ${this.root}: ${path}`);
          continue;
        }
        if (portablePath(path).split("/").includes("node_modules") || vfs.isHidden(path)) continue;
        program.getSyntacticDiagnostics(sourceFile).forEach(add);
        program.getSemanticDiagnostics(sourceFile).forEach(add);
        if (item.parsed.options.declaration || item.parsed.options.composite) program.getDeclarationDiagnostics(sourceFile).forEach(add);
      }
      for (const [recordKey, entry] of counts) {
        if ((merged.get(recordKey)?.count ?? 0) < entry.count) merged.set(recordKey, entry);
      }
      const layout = this.computedOutputRoot(item, program);
      if (layout !== undefined) this.layouts.set(key, layout);
      if (referenced.has(key)) {
        program.emit(undefined, (fileName, text) => {
          if (isDeclarationPath(fileName)) vfs.writeGenerated(fileName, text);
        }, undefined, true);
      }
    }
    return [...merged.values()]
      .flatMap(({ record, count }) => Array.from({ length: count }, () => record))
      .sort((a, b) => a.file.localeCompare(b.file) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
  }

  /**
   * The directory TypeScript mirrors into outDir/declarationDir when neither
   * rootDir nor composite fixes it: the common directory of the emitted
   * sources (TypeScript's computeCommonSourceDirectoryOfFilenames). Undefined
   * when the layout does not depend on which files the program contains.
   */
  private computedOutputRoot(item: Participant, program: ts.Program): string | undefined {
    const options = item.parsed.options;
    if (options.noEmit || options.rootDir || options.composite || (!options.outDir && !options.declarationDir)) return undefined;
    const directories = program.getSourceFiles()
      .filter((sourceFile) => !sourceFile.isDeclarationFile && !program.isSourceFileFromExternalLibrary(sourceFile))
      .filter((sourceFile) => !(options.noEmitForJsFiles && /\.[cm]?jsx?$/i.test(sourceFile.fileName)))
      .filter((sourceFile) => !/\.json$/i.test(sourceFile.fileName) || options.outDir)
      .map((sourceFile) => portablePath(dirname(resolve(sourceFile.fileName))).split("/"));
    if (!directories.length) return undefined;
    let common = directories[0]!;
    for (const parts of directories.slice(1)) {
      let length = 0;
      while (length < common.length && length < parts.length
        && (this.vfs.caseSensitive ? common[length] === parts[length] : common[length]!.toLowerCase() === parts[length]!.toLowerCase())) length += 1;
      common = common.slice(0, length);
    }
    return common.length === 1 && /^[A-Za-z]:$/.test(common[0]!) ? `${common[0]}/` : common.join("/") || "/";
  }

  /**
   * Rewrite literal `files`/`include` entries for renamed or deleted files in
   * participant configs; `substitutions` (by config) rename instead of delete.
   */
  updateConfigLists(renames: [string, string][], deletions: string[], substitutions = new Map<string, [string, string][]>()): void {
    const vfs = this.vfs;
    for (const item of [...this.participants.values()].sort((a, b) => a.configPath.localeCompare(b.configPath))) {
      const configRenames = [...(substitutions.get(vfs.key(item.configPath)) ?? []), ...renames];
      const text = vfs.readFile(item.configPath);
      if (text === undefined) continue;
      const json = ts.parseJsonText(item.configPath, text);
      const object = json.statements[0]?.expression;
      if (!object || !ts.isObjectLiteralExpression(object)) continue;
      const directory = dirname(item.configPath);
      const changes: ts.TextChange[] = [];
      for (const property of object.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)) continue;
        if (!["files", "include"].includes(property.name.text) || !ts.isArrayLiteralExpression(property.initializer)) continue;
        const elements = property.initializer.elements;
        const removed = new Set<number>();
        elements.forEach((element, index) => {
          if (!ts.isStringLiteral(element) || /[*?]/.test(element.text)) return;
          const absolute = resolve(directory, element.text);
          const start = element.getStart(json);
          const rename = configRenames.find(([from]) => vfs.samePath(from, absolute));
          if (rename) {
            const relativePath = portablePath(relative(directory, rename[1]));
            const spec = element.text.startsWith("./") && !relativePath.startsWith("../") ? `./${relativePath}` : relativePath;
            const quote = text[start]!;
            changes.push({ span: { start, length: element.end - start }, newText: `${quote}${JSON.stringify(spec).slice(1, -1)}${quote}` });
          } else if (deletions.some((path) => vfs.samePath(path, absolute))) {
            removed.add(index);
          }
        });
        // Delete contiguous runs together, so moving a directory cannot produce overlapping list edits.
        for (let index = 0; index < elements.length; index++) {
          if (!removed.has(index)) continue;
          const first = index;
          while (removed.has(index + 1)) index += 1;
          const all = first === 0 && index === elements.length - 1;
          const start = all ? property.initializer.getStart(json) + 1
            : first === 0 ? elements[first]!.getStart(json) : elements[first - 1]!.end;
          const end = all ? property.initializer.end - 1
            : first === 0 ? elements[index + 1]!.getStart(json) : elements[index]!.end;
          changes.push({ span: { start, length: end - start }, newText: "" });
        }
      }
      if (changes.length) vfs.write(item.configPath, applyTextChanges(text, changes));
    }
  }

  /** Append a new file to a config's own literal `files` list; false when the config has none. */
  addToFiles(configPath: string, path: string): boolean {
    const text = this.vfs.readFile(configPath)!;
    const json = ts.parseJsonText(configPath, text);
    const object = json.statements[0]?.expression;
    if (!object || !ts.isObjectLiteralExpression(object)) return false;
    const files = object.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property)
      && ts.isStringLiteral(property.name) && property.name.text === "files");
    if (!files || !ts.isArrayLiteralExpression(files.initializer)) return false;
    const elements = files.initializer.elements;
    const relativePath = portablePath(relative(dirname(configPath), path));
    const dotted = elements.some((element) => ts.isStringLiteral(element) && element.text.startsWith("./"));
    const literal = JSON.stringify(dotted && !relativePath.startsWith("../") ? `./${relativePath}` : relativePath);
    let change: ts.TextChange;
    if (elements.length) {
      const last = elements[elements.length - 1]!;
      const lastStart = last.getStart(json);
      const lineStart = text.lastIndexOf("\n", lastStart) + 1;
      const multiline = text.slice(elements[0]!.getStart(json), lastStart).includes("\n") || text.slice(files.initializer.getStart(json), elements[0]!.getStart(json)).includes("\n");
      const indent = text.slice(lineStart, lastStart);
      const separator = multiline && /^\s*$/.test(indent) ? `,${text.includes("\r\n") ? "\r\n" : "\n"}${indent}` : ", ";
      change = { span: { start: last.end, length: 0 }, newText: `${separator}${literal}` };
    } else {
      change = { span: { start: files.initializer.getStart(json) + 1, length: 0 }, newText: literal };
    }
    this.vfs.write(configPath, applyTextChanges(text, [change]));
    return true;
  }
}

export function applyTextChanges(text: string, changes: readonly ts.TextChange[]): string {
  const ordered = changes
    .map((change, index) => ({ change, index }))
    .sort((a, b) => b.change.span.start - a.change.span.start || b.index - a.index)
    .map(({ change }) => change);
  let boundary = text.length;
  for (const change of ordered) {
    const end = change.span.start + change.span.length;
    if (change.span.start < 0 || end > text.length) fail("INVALID_EDIT", "TypeScript returned an out-of-bounds edit");
    if (end > boundary) fail("OVERLAPPING_EDITS", "TypeScript returned overlapping edits");
    text = text.slice(0, change.span.start) + change.newText + text.slice(end);
    boundary = change.span.start;
  }
  return text;
}
