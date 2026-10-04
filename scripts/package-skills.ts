import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
  process.stdout.write(`refactor-ai skill packager — prepare self-contained npx skills resources

Usage:
  bun scripts/package-skills.ts [--build]

Options:
  --help, -h   Show help without building or copying any files.
  --build      Rebuild the CLI and demo before packaging (package:skills default).

Builds the Node launcher and copies dist/cli.js, pinned npm manifests/lockfiles and
license notices into every skills/* directory. C# skills also receive the Roslyn
helper sources and NuGet lockfile. Successful packaging returns exit 0; failures
return nonzero. This updates generated scripts/ and assets/ in the checkout;
it does not install skills into other projects or publish them.

Requirements:
  Bun, installed repository dependencies, dist/cli.js and the helper source tree.
  Run bun run build for the normal workflow; it builds the CLI before packaging.
  Users of an installed skill need Node.js 22+ and npm; C# also needs .NET 8 SDK.

Examples (from the repository root):
  bun install --frozen-lockfile
  bun run build
  bun run package:skills
  bun run package:skills --help
  bun scripts/package-skills.ts          # repack an already-built CLI
  bun scripts/package-skills.ts --help

After packaging, install from a target project:
  npx skills add /absolute/path/to/refactor-ai --skill '*' --agent codex --yes
`);
  process.exit(0);
}
if (args.some(arg => arg !== "--build") || args.length > 1) throw new Error("INVALID_ARGUMENT: packager accepts --build or --help");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (args.includes("--build")) {
  const result = spawnSync("bun", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const launcher = join(root, "dist", "skill-launcher.mjs");
const built = spawnSync("bun", ["build", "scripts/skill-launcher.ts", "--target", "node", "--format", "esm", "--outfile", launcher], {
  cwd: root, stdio: "inherit",
});
if (built.error) throw built.error;
if (built.status !== 0) throw new Error("Skill launcher build failed");

const names = (await readdir(join(root, "skills"))).sort();
for (const name of names) {
  const skill = join(root, "skills", name);
  await readFile(join(skill, "SKILL.md"));
  const runtime = join(skill, "assets", "runtime");
  await mkdir(join(skill, "scripts"), { recursive: true });
  await mkdir(join(runtime, "licenses"), { recursive: true });
  await cp(launcher, join(skill, "scripts", "refactor.mjs"));
  await cp(join(root, "dist", "cli.js"), join(runtime, "cli.mjs"));
  for (const file of ["package.json", "package-lock.json"]) {
    await cp(join(root, "packaging", "runtime", file), join(runtime, file));
  }
  await cp(join(root, "node_modules", "diff", "LICENSE"), join(runtime, "licenses", "diff.txt"));
  const helper = join(skill, "assets", "dotnet", "RefactorHelper");
  if (["refactor-rename", "refactor-imports", "refactor-format", "refactor-rename-file", "refactor-sync-namespace", "refactor-move-type"].includes(name)) {
    await mkdir(helper, { recursive: true });
    const helperFiles = (await readdir(join(root, "dotnet", "RefactorHelper"))).filter(file => file.endsWith(".cs"));
    for (const file of [...helperFiles, "RefactorHelper.csproj", "packages.lock.json"]) {
      await cp(join(root, "dotnet", "RefactorHelper", file), join(helper, file));
    }
  } else {
    await rm(join(skill, "assets", "dotnet"), { recursive: true, force: true });
  }
}
console.log(`Packaged ${names.length} self-contained skills for npx skills.`);
