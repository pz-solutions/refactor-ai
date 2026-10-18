import { chmod, cp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { operationHelpFor } from "../src/help.ts";
import { npmDistributions, npmScope } from "../src/npm-config.ts";
import { assertVersion } from "./release-version.ts";
import { apiDeclaration, buildApiDeclarations } from "./api-declarations.ts";

const defaultScope = npmScope;
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
  console.log(`refactor-ai npm packager — build independently publishable CLI packages

Usage:
  bun run package:npm [--scope <name>] [--out <directory>]
  bun scripts/package-npm.ts [--scope <name>] [--out <directory>]

Options:
  --scope <name>     Override npm scope, with or without @; default: @${defaultScope}.
  --out <directory>  Output relative to cwd; default: dist/npm in this checkout.
                    Managed package directories within it are replaced; avoid
                    directories containing hand-written package content.
  --help, -h        Show help without building, copying or publishing files.

Produces @${defaultScope}/cli (both backends), @${defaultScope}/ts-<operation>
packages for TypeScript/JavaScript, and six @${defaultScope}/csharp-<operation> packages.
TS operations: rename, imports, format, extract-function, extract-variable,
rename-file, move-type, move-file, inline-reexports and retarget-import. C# operations: rename, imports, format, rename-file,
sync-namespace and move-type. Each package declares one executable and exports createRefactor with TypeScript
declarations for custom scripts. Imports do not execute the CLI or load a project.

TS packages contain only their compiler adapter and pinned TypeScript dependency.
C# packages contain only their Roslyn adapter and helper sources, with no TypeScript
npm dependency. The aggregate cli contains both backends. The .NET helper builds on
first C# use. No lifecycle scripts or Bun at runtime. The author checkout is private.

Requirements: Bun, installed checkout dependencies and helper sources.
Consumers: Node.js 22+ and npm; C# needs .NET 8 SDK and the project's SDK/workloads.
Initial npm/NuGet downloads need network access. No registry changes are made.

Examples:
  bun install --frozen-lockfile
  bun run package:npm
  bun run package:npm --scope @refactor-ai
  bun run package:npm --out ./release/npm
  npm pack ./dist/npm/ts-rename --pack-destination /tmp
  npx --yes file:/tmp/refactor-ai-ts-rename-0.1.3.tgz --help
  npm publish ./dist/npm/ts-rename --dry-run
  npm publish ./dist/npm/ts-rename --access public
  npx @refactor-ai/ts-rename plan --project ./tsconfig.json --file ./src.ts --at 1:14 --name newName
  npx @refactor-ai/cli plan rename --project ./tsconfig.json --file ./src.ts --at 1:14 --name newName

Publication requires npm login and ownership of the chosen name/scope. Names are
configuration defaults, not a claim of registry availability. Use
bun run version:packages --help before generating another release. Exit 0: success/help;
nonzero: invalid options or build/copy failure.
`);
  process.exit(0);
}
let scope = defaultScope, scopeProvided = false, output: string | undefined;
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index], value = args[index + 1];
  if (!value || value.startsWith("-") || !["--scope", "--out"].includes(flag)) throw new Error(`INVALID_ARGUMENT: ${flag}`);
  if (flag === "--scope") {
    if (scopeProvided) throw new Error("INVALID_ARGUMENT: repeated --scope");
    scopeProvided = true;
    scope = value.replace(/^@/, "");
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(scope)) throw new Error("INVALID_ARGUMENT: invalid npm scope");
  } else {
    if (output) throw new Error("INVALID_ARGUMENT: repeated --out");
    output = value;
  }
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function canonicalDirectory(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await canonicalDirectory(dirname(path)), basename(path));
  }
}
const destination = await canonicalDirectory(resolve(output ?? join(repo, "dist", "npm")));
const rootManifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
assertVersion(rootManifest.version);
const helperRoot = join(repo, "dotnet", "RefactorHelper");
const helperFiles = (await readdir(helperRoot)).filter(file => file.endsWith(".cs"));
const entries = npmDistributions;
const declarations = join(repo, "dist", "api-types");
// Reject the output root and every managed package directory if either could
// replace the checkout or an ancestor, including through a symlink alias.
const outputTargets = [destination, ...entries.map(entry => join(destination, entry.name))];
for (const target of outputTargets) {
  const difference = relative(target, repo);
  if (difference === "" || (!isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`))) {
    throw new Error("INVALID_ARGUMENT: npm output must not replace the checkout or its ancestors");
  }
}
await buildApiDeclarations(repo, declarations);
await mkdir(destination, { recursive: true });
for (const { name: baseName, bin: binName, operation, language } of entries) {
  const packageName = scope ? `@${scope}/${baseName}` : baseName;
  const packageRoot = join(destination, baseName);
  const csharp = language !== "typescript";
  const help = operation ? operationHelpFor(operation, language) : undefined;
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await mkdir(join(packageRoot, "lib"));
  const source = join(packageRoot, "entry.ts");
  const loader = language
    ? language === "csharp"
      ? `const loadBackend = async (_project: string, toolkitRoot?: string) => { const backend = await import(${JSON.stringify(join(repo, "src", "backends", "csharp.ts"))}); return { capabilities: backend.capabilities, analyze: (request: import(${JSON.stringify(join(repo, "src", "types.ts"))}).RefactorRequest) => backend.analyze(request, toolkitRoot) }; };`
      : `const loadBackend = (_project: string) => import(${JSON.stringify(join(repo, "src", "backends", "typescript.ts"))});`
    : `import { loadBackend } from ${JSON.stringify(join(repo, "src", "backends", "load.ts"))};`;
  await writeFile(source, `import { dirname, resolve } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nimport { runNpmCli } from ${JSON.stringify(join(repo, "src", "npm-cli.ts"))};\n${loader}\nawait runNpmCli(process.argv.slice(2), { packageName: ${JSON.stringify(packageName)}, packageRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'), loadBackend, language: ${JSON.stringify(language)}, ${operation ? `operation: ${JSON.stringify(operation)}` : ""} });\n`);

  const runner = join(packageRoot, "lib", "runner.mjs");
  const result = spawnSync("bun", ["build", source, "--target", "node", "--format", "esm", "--external", "typescript", "--external", "typescript7", "--outfile", runner], { cwd: repo, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  await rm(source);
  await writeFile(source, `import { dirname, resolve } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nimport { createRefactorApi } from ${JSON.stringify(join(repo, "src", "api.ts"))};\n${loader}\nexport async function createRefactor() { return createRefactorApi({ toolkitRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'), loadBackend, language: ${JSON.stringify(language)}, ${operation ? `operation: ${JSON.stringify(operation)}` : ""} }); }\n`);
  const apiResult = spawnSync("bun", ["build", source, "--target", "node", "--format", "esm", "--external", "typescript", "--external", "typescript7", "--outfile", join(packageRoot, "lib", "api.mjs")], { cwd: repo, encoding: "utf8" });
  if (apiResult.error) throw apiResult.error;
  if (apiResult.status !== 0) throw new Error(apiResult.stderr || apiResult.stdout);
  await rm(source);
  await cp(declarations, join(packageRoot, "lib", "types"), { recursive: true });
  await writeFile(join(packageRoot, "lib", "api.d.mts"), apiDeclaration);
  const bin = join(packageRoot, "bin", "cli.mjs");
  await writeFile(bin, '#!/usr/bin/env node\nimport "../lib/runner.mjs";\n');
  await chmod(bin, 0o755);
  // runner.mjs resides in lib/, so its parent is the package root.
  if (csharp) {
    const helper = join(packageRoot, "dotnet", "RefactorHelper");
    await mkdir(helper, { recursive: true });
    for (const file of [...helperFiles, "RefactorHelper.csproj", "packages.lock.json"]) await cp(join(helperRoot, file), join(helper, file));
  }
  await mkdir(join(packageRoot, "licenses"));
  await cp(join(repo, "node_modules", "diff", "LICENSE"), join(packageRoot, "licenses", "diff.txt"));
  const manifest = {
    name: packageName, version: rootManifest.version, description: operation ? help!.description : "Deterministic TypeScript, JavaScript and C# refactoring CLI.",
    type: "module", exports: { ".": { types: "./lib/api.d.mts", import: "./lib/api.mjs" } }, types: "./lib/api.d.mts", repository: rootManifest.repository, bin: { [binName]: "bin/cli.mjs" }, engines: { node: ">=22" },
    files: ["bin/", "lib/", "licenses/", "API.md", ...(csharp ? ["dotnet/**/*.cs", "dotnet/**/*.csproj", "dotnet/**/packages.lock.json"] : [])],
    dependencies: language === "csharp" ? {} : { typescript: rootManifest.dependencies.typescript },
    ...(language === "csharp" ? {} : { peerDependencies: rootManifest.peerDependencies, peerDependenciesMeta: rootManifest.peerDependenciesMeta }), publishConfig: { access: "public", tag: rootManifest.version.includes("-") ? "next" : "latest" },
  };
  await writeFile(join(packageRoot, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  const plan = operation ? "plan" : "plan rename";
  const example = operation ? help!.examples[0].replace(`plan ${operation}`, "plan") : operationHelpFor("rename").examples[0];
  const csharpRequirements = csharp
    ? "C# also requires the .NET 8 SDK, the project's required SDK/workloads and restored project dependencies. The bundled Roslyn helper builds on first C# use; initial NuGet restore needs network access and a writable package/cache directory."
    : "This package supports TypeScript and JavaScript and includes only their compiler adapter. npm installs its pinned TypeScript dependency.";
  await writeFile(join(packageRoot, "README.md"), `# ${packageName}\n\n${manifest.description}\n\nUse Node.js 22+ and npm. Bun and a source checkout are unnecessary. ${csharpRequirements} This package has no install lifecycle scripts.\n\n\`\`\`sh\nnpx ${packageName} --help\nnpx ${packageName} ${plan} --help\nnpx ${packageName} ${example}\n\`\`\`\n\nReplace example paths with your project paths. Planning leaves sources untouched and returns a saved plan path. Preview and validate it, then apply that exact plan:\n\n\`\`\`sh\nnpx ${packageName} preview --plan ./path/to/plan.json\nnpx ${packageName} validate --plan ./path/to/plan.json\nnpx ${packageName} apply --plan ./path/to/plan.json\n\`\`\`\n\nOr install with \`npm install --save-dev ${packageName}\` and run \`npx ${binName} --help\`. ${operation ? `Only ${operation} can be planned by this tool. ` : ""}Plans use snapshots, compiler diagnostics and journaled writes. Validation does not run project tests. Full options, language support, limitations and examples are available in \`--help\`.\n\nBuilt from refactor-ai ${rootManifest.version}. Third-party diff license: \`licenses/diff.txt\`.\n`);
  await writeFile(join(packageRoot, "API.md"), await readFile(join(repo, "docs", "api.md"), "utf8"));
  const apiHelp = `\n## Programmatic use\n\nImporting the package does not execute the CLI, load a project or build the C# helper. \`createRefactor()\` returns an object with \`plan(options)\`, \`preview(plan)\`, \`validate(plan)\`, \`apply(plan)\`, \`loadPlan(path)\` and \`capabilities(project)\`. Methods return objects and reject with Errors rather than printing CLI output. TypeScript declarations are included.\n\n\`\`\`js\nimport { createRefactor } from "${packageName}";\nconst refactor = await createRefactor();\nconst supported = await refactor.capabilities("./${language === "csharp" ? "App.csproj" : "tsconfig.json"}");\n\`\`\`\n\n${operation ? `This API plans only ${operation}; omit \`operation\` in plan options. ` : "Pass \`operation\` in plan options. "}Read [API.md](API.md) for the complete interface, source-change workflow, coordinate conventions, language requirements and automation examples.\n`;
  await writeFile(join(packageRoot, "README.md"), (await readFile(join(packageRoot, "README.md"), "utf8")) + apiHelp);
  console.log(`Built ${packageName}: ${packageRoot}`);
}
