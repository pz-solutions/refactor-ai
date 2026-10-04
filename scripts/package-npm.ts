import { chmod, cp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { operationHelp } from "../src/help.ts";
import { npmScope } from "../src/npm-config.ts";
import { assertVersion } from "./release-version.ts";

const defaultScope = npmScope;
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
  console.log(`refactor-ai npm packager — build nine independently publishable CLI packages

Usage:
  bun run package:npm [--scope <name>] [--out <directory>]
  bun scripts/package-npm.ts [--scope <name>] [--out <directory>]

Options:
  --scope <name>     Override npm scope, with or without @; default: @${defaultScope}.
  --out <directory>  Output relative to cwd; default: dist/npm in this checkout.
                    Managed package directories within it are replaced; avoid
                    directories containing hand-written package content.
  --help, -h        Show help without building, copying or publishing files.

Produces @${defaultScope}/cli plus @${defaultScope}/{rename,imports,format,extract-function,
extract-variable,rename-file,sync-namespace,move-type}. Each has a single bin,
bundled Node ESM runner, pinned TypeScript dependency and English README/help.
C# tools include Roslyn helper sources and locked NuGet dependencies; the helper
builds on first C# use. No install/postinstall/prepare scripts or Bun at runtime.
The author checkout stays private; only generated packages are publishable.

Requirements: Bun, installed checkout dependencies and helper sources.
Consumers: Node.js 22+ and npm; C# needs .NET 8 SDK and the project's SDK/workloads.
Initial npm/NuGet downloads need network access. No registry changes are made.

Examples:
  bun install --frozen-lockfile
  bun run package:npm
  bun run package:npm --scope @refactor-ai
  bun run package:npm --out ./release/npm
  npm pack ./dist/npm/rename --pack-destination /tmp
  npx --yes file:/tmp/refactor-ai-rename-0.1.0.tgz --help
  npm publish ./dist/npm/rename --dry-run
  npm publish ./dist/npm/rename --access public
  npx @refactor-ai/rename plan --project ./tsconfig.json --file ./src.ts --at 1:14 --name newName
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
const operations = Object.keys(operationHelp) as (keyof typeof operationHelp)[];
const entries = [undefined, ...operations];
// Reject the output root and every managed package directory if either could
// replace the checkout or an ancestor, including through a symlink alias.
const outputTargets = [destination, ...entries.map(operation => join(destination, operation ?? "cli"))];
for (const target of outputTargets) {
  const difference = relative(target, repo);
  if (difference === "" || (!isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`))) {
    throw new Error("INVALID_ARGUMENT: npm output must not replace the checkout or its ancestors");
  }
}
await mkdir(destination, { recursive: true });
for (const operation of entries) {
  const baseName = operation ?? "cli";
  const packageName = scope ? `@${scope}/${baseName}` : baseName;
  const binName = operation ? `refactor-${operation}` : "refactor-ai";
  const packageRoot = join(destination, baseName);
  const csharp = !operation || !["extract-function", "extract-variable"].includes(operation);
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await mkdir(join(packageRoot, "lib"));
  const source = join(packageRoot, "entry.ts");
  await writeFile(source, `import { dirname, resolve } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nimport { runNpmCli } from ${JSON.stringify(join(repo, "src", "npm-cli.ts"))};\nawait runNpmCli(process.argv.slice(2), { packageName: ${JSON.stringify(packageName)}, packageRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'), ${operation ? `operation: ${JSON.stringify(operation)}` : ""} });\n`);
  const runner = join(packageRoot, "lib", "runner.mjs");
  const result = spawnSync("bun", ["build", source, "--target", "node", "--format", "esm", "--external", "typescript", "--outfile", runner], { cwd: repo, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  await rm(source);
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
    name: packageName, version: rootManifest.version, description: operation ? operationHelp[operation].description : "Deterministic TypeScript, JavaScript and C# refactoring CLI.",
    type: "module", repository: rootManifest.repository, bin: { [binName]: "bin/cli.mjs" }, engines: { node: ">=22" },
    files: ["bin/", "lib/", "licenses/", ...(csharp ? ["dotnet/**/*.cs", "dotnet/**/*.csproj", "dotnet/**/packages.lock.json"] : [])],
    dependencies: { typescript: rootManifest.dependencies.typescript }, publishConfig: { access: "public", tag: rootManifest.version.includes("-") ? "next" : "latest" },
  };
  await writeFile(join(packageRoot, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  const plan = operation ? "plan" : "plan rename";
  const example = operation ? operationHelp[operation].examples[0].replace(`plan ${operation}`, "plan") : operationHelp.rename.examples[0];
  const csharpRequirements = csharp
    ? "C# also requires the .NET 8 SDK, the project's required SDK/workloads and restored project dependencies. The bundled Roslyn helper builds on first C# use; initial NuGet restore needs network access and a writable package/cache directory."
    : "This operation supports TypeScript and JavaScript; .NET is unnecessary.";
  await writeFile(join(packageRoot, "README.md"), `# ${packageName}\n\n${manifest.description}\n\nUse Node.js 22+ and npm. Bun and a source checkout are unnecessary. ${csharpRequirements} This package has no install lifecycle scripts.\n\n\`\`\`sh\nnpx ${packageName} --help\nnpx ${packageName} ${plan} --help\nnpx ${packageName} ${example}\n\`\`\`\n\nReplace example paths with your project paths. Planning leaves sources untouched and returns a saved plan path. Preview and validate it, then apply that exact plan:\n\n\`\`\`sh\nnpx ${packageName} preview --plan ./path/to/plan.json\nnpx ${packageName} validate --plan ./path/to/plan.json\nnpx ${packageName} apply --plan ./path/to/plan.json\n\`\`\`\n\nOr install with \`npm install --save-dev ${packageName}\` and run \`npx ${binName} --help\`. ${operation ? `Only ${operation} can be planned by this tool. ` : ""}Plans use snapshots, compiler diagnostics and journaled writes. Validation does not run project tests. Full options, language support, limitations and examples are available in \`--help\`.\n\nBuilt from refactor-ai ${rootManifest.version}. Third-party diff license: \`licenses/diff.txt\`.\n`);
  console.log(`Built ${packageName}: ${packageRoot}`);
}
