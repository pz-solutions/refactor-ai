import ts from "typescript";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { builtinModules } from "node:module";
import { moduleSpecifiers, sharedOptionKeys } from "./typescript-workspace";
import { fail, isInside } from "./typescript-vfs";

export function parseConfig(config: string): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (error) => fail("INVALID_CONFIG", ts.flattenDiagnosticMessageText(error.messageText, "\n")),
  });
  if (!parsed || parsed.errors.length) fail("INVALID_CONFIG", `${config}: ${parsed?.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("; ") ?? "cannot parse"}`);
  return parsed;
}

export function checkSharedOptions(first: ts.CompilerOptions, second: ts.CompilerOptions, source: string, target: string): void {
  for (const option of sharedOptionKeys) {
    if (JSON.stringify(first[option]) !== JSON.stringify(second[option])) {
      fail("PROJECT_OPTIONS_INCOMPATIBLE", `${target} and ${source} differ in compiler option '${option}'; use projects with compatible syntax and emit settings`);
    }
  }
}

function packageAt(root: string, file: string): { path: string; directory: string; json: Record<string, any> } | undefined {
  for (let directory = dirname(file); isInside(root, directory); directory = dirname(directory)) {
    const path = resolve(directory, "package.json");
    const text = ts.sys.readFile(path);
    if (text !== undefined) {
      try { return { path, directory, json: JSON.parse(text) }; }
      catch { fail("INVALID_PACKAGE", path); }
    }
    if (directory === root) break;
  }
  return undefined;
}

export function installationHint(root: string, file: string): string {
  const pkg = packageAt(root, file);
  if (!pkg || existsSync(resolve(pkg.directory, "node_modules"))) return "";
  return `; ${pkg.directory}/node_modules is missing; run the workspace package manager install from ${root}`;
}

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const versionOf = (json: Record<string, any>, name: string): string | undefined => dependencyFields.map(field => json[field]?.[name]).find(value => typeof value === "string");

/** Disk-only proof of relocation blockers; no Program or checker is constructed. */
export function precheckMove(root: string, sourceConfig: string, targetConfig: string, renames: [string, string][]): void {
  const source = parseConfig(sourceConfig), target = sourceConfig === targetConfig ? source : parseConfig(targetConfig);
  checkSharedOptions(source.options, target.options, sourceConfig, targetConfig);
  const moved = new Set(renames.map(([from]) => from));
  const blockers: string[] = [];
  for (const [from, to] of renames) {
    if (!/\.[cm]?[jt]sx?$/.test(from)) continue;
    const text = ts.sys.readFile(from);
    if (text === undefined) fail("FILE_NOT_FOUND", from);
    const file = ts.createSourceFile(from, text, ts.ScriptTarget.Latest, true);
    file.impliedNodeFormat = ts.getImpliedNodeFormatForFile(from, undefined, ts.sys, source.options);
    const sourcePackage = packageAt(root, from), destination = packageAt(root, to);
    const specifiers = moduleSpecifiers(file);
    const relocated = ts.createSourceFile(to, text, ts.ScriptTarget.Latest, true);
    relocated.impliedNodeFormat = ts.getImpliedNodeFormatForFile(to, undefined, ts.sys, target.options);
    const targetSpecifiers = moduleSpecifiers(relocated);
    for (const [index, specifier] of specifiers.entries()) {
      const name = specifier.text;
      const mode = ts.getModeForUsageLocation(file, specifier, source.options);
      const original = ts.resolveModuleName(name, from, source.options, ts.sys, undefined, undefined, mode).resolvedModule;
      if (original && moved.has(resolve(original.resolvedFileName))) continue;
      // Relative imports and destination self-imports are rewritten by move-file.
      if (name.startsWith(".") || builtins.has(name) || (destination?.json.name && (name === destination.json.name || name.startsWith(`${destination.json.name}/`)))) continue;
      const alias = Object.keys(source.options.paths ?? {}).some(pattern => {
        const [prefix, suffix] = pattern.split("*");
        return pattern.includes("*") ? name.startsWith(prefix!) && name.endsWith(suffix!) : name === pattern;
      });
      const targetMode = ts.getModeForUsageLocation(relocated, targetSpecifiers[index]!, target.options);
      if (alias) {
        if (original && !ts.resolveModuleName(name, to, target.options, ts.sys, undefined, undefined, targetMode).resolvedModule) {
          blockers.push(`MOVE_IMPORT_UNRESOLVED: ${from}: '${name}' cannot resolve from ${to}; unresolved source-project alias imports: ${name}; move its dependency too or retarget the alias before moving${installationHint(root, to)}`);
        }
        continue;
      }
      if (!destination || !sourcePackage || destination.path === sourcePackage.path) continue;
      const packageName = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]!;
      const version = versionOf(sourcePackage.json, packageName);
      // A declared source dependency remains a relocation requirement even
      // before install, when resolution cannot yet identify its declaration.
      if ((version || original?.isExternalLibraryImport) && !name.startsWith("#") && !versionOf(destination.json, packageName)) {
        const hint = version ? `add ${packageName}@${version} to ${destination.path}` : `add '${packageName}' to ${destination.path}`;
        blockers.push(`MISSING_DEPENDENCY: ${destination.path} must declare '${packageName}' (source version ${version ?? "not declared"}); ${hint} and install before moving ${from}${installationHint(root, to)}`);
        continue;
      }
      if (!ts.resolveModuleName(name, to, target.options, ts.sys, undefined, undefined, targetMode).resolvedModule) {
        // Ambient declarations and wildcard modules need the full checker. Only
        // reject imports originally resolved to a concrete external package.
        if (original?.isExternalLibraryImport) blockers.push(`MOVE_IMPORT_UNRESOLVED: '${name}' cannot resolve from ${to}; install the destination dependencies or fix its package exports${installationHint(root, to)}`);
      }
    }
  }
  if (blockers.length) throw new Error([...new Set(blockers)].sort((a, b) => Number(b.startsWith("MOVE_IMPORT_UNRESOLVED")) - Number(a.startsWith("MOVE_IMPORT_UNRESOLVED"))).join("; "));
}
