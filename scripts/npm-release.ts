import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { npmDistributions, npmScope } from "../src/npm-config.ts";
import { npmCli } from "../src/runtime/npm.ts";
import { assertChannelAdvance, assertVersion, releaseChannel } from "./release-version.ts";

const repository = "git+https://github.com/pz-solutions/refactor-ai.git";
const names = npmDistributions.map(entry => entry.name);
interface Archive { name: string; version: string; filename: string; integrity: string }
interface Release { version: string; archives: Archive[] }
export type Runner = (args: string[]) => { status: number | null; stdout: string; stderr: string };
const npm: Runner = args => {
  const result = spawnSync(process.execPath, [npmCli(), ...args], { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
};
const digest = (content: Buffer) => `sha512-${createHash("sha512").update(content).digest("base64")}`;

function execute(args: string[], runner: Runner): string {
  const result = runner(args);
  if (result.status !== 0) throw new Error(`NPM_FAILED: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function registryTags(name: string, runner: Runner): unknown {
  // npm view resolves a version before returning packument fields. A beta-only
  // package has no latest version, so try next first, then latest if absent.
  for (const channel of ["next", "latest"]) {
    const result = runner(["view", name, "dist-tags", "--json", "--tag", channel, "--registry", "https://registry.npmjs.org"]);
    if (result.status === 0) {
      if (!result.stdout.trim()) continue;
      try { return JSON.parse(result.stdout); } catch { throw new Error(`REGISTRY_FAILED: invalid dist-tags JSON for ${name}`); }
    }
    let code: string | undefined;
    try { code = JSON.parse(result.stdout).error?.code; } catch { /* Fail closed. */ }
    if (code !== "E404") throw new Error(`REGISTRY_FAILED: ${result.stderr || result.stdout}`);
  }
  return {};
}

export function assertReleaseRef(version: string, ref?: string): void {
  assertVersion(version);
  if (ref !== undefined && ref !== `v${version}`) throw new Error(`VERSION_MISMATCH: expected v${version}, received ${ref}`);
}

export async function packRelease(packages: string, artifacts: string, ref?: string, runner: Runner = npm): Promise<void> {
  const manifests = await Promise.all(names.map(async name => JSON.parse(await readFile(join(packages, name, "package.json"), "utf8"))));
  const version = manifests[0].version;
  assertReleaseRef(version, ref);
  for (let index = 0; index < manifests.length; index++) {
    const manifest = manifests[index];
    if (manifest.name !== `@${npmScope}/${names[index]}` || manifest.version !== version || manifest.repository?.url !== repository) {
      throw new Error("INVALID_RELEASE: package names, versions or repository metadata differ");
    }
  }
  await mkdir(artifacts, { recursive: true });
  const archives: Archive[] = [];
  for (const name of names) {
    const packed = JSON.parse(execute(["pack", join(packages, name), "--json", "--ignore-scripts", "--pack-destination", artifacts], runner))[0];
    archives.push({ name: packed.name, version: packed.version, filename: packed.filename, integrity: packed.integrity });
  }
  await writeFile(join(artifacts, "release.json"), JSON.stringify({ version, archives }, null, 2) + "\n");
  await verifyRelease(artifacts, ref);
  console.log(`Packed ${archives.length} verified archives for ${version} into ${artifacts}`);
}

async function verifyRelease(artifacts: string, ref?: string): Promise<Release> {
  const release: Release = JSON.parse(await readFile(join(artifacts, "release.json"), "utf8"));
  assertReleaseRef(release.version, ref);
  if (!Array.isArray(release.archives) || release.archives.length !== names.length) throw new Error("INVALID_RELEASE: expected fourteen archives");
  const expected = new Set(names.map(name => `@${npmScope}/${name}`));
  for (const archive of release.archives) {
    if (!expected.delete(archive.name) || archive.version !== release.version || typeof archive.filename !== "string" ||
        archive.filename !== basename(archive.filename) || !archive.filename.endsWith(".tgz")) throw new Error("INVALID_RELEASE: inconsistent archive manifest");
    if (digest(await readFile(join(artifacts, archive.filename))) !== archive.integrity) throw new Error(`INTEGRITY_MISMATCH: ${archive.filename}`);
  }
  return release;
}

export async function publishRelease(artifacts: string, options: { ref?: string; dryRun?: boolean } = {}, runner: Runner = npm): Promise<void> {
  const release = await verifyRelease(artifacts, options.ref);
  if (!options.dryRun && options.ref === undefined) throw new Error("RELEASE_REF_REQUIRED: real publication requires --ref v<package-version>");
  const distTag = releaseChannel(release.version);
  const pending: Archive[] = [];
  // Complete preflight for every package before publishing the first one.
  for (const archive of release.archives) {
    if (options.dryRun) { pending.push(archive); continue; }
    const result = runner(["view", `${archive.name}@${archive.version}`, "dist.integrity", "--json", "--registry", "https://registry.npmjs.org"]);
    if (result.status === 0) {
      if (JSON.parse(result.stdout) !== archive.integrity) throw new Error(`REGISTRY_CONFLICT: ${archive.name}@${archive.version} already has different content; release a new version`);
      console.log(`Already published: ${archive.name}@${archive.version}`);
    } else {
      let code: string | undefined;
      try { code = JSON.parse(result.stdout).error?.code; } catch { /* Treat malformed responses as failures. */ }
      if (code !== "E404") throw new Error(`REGISTRY_FAILED: ${result.stderr || result.stdout}`);
      pending.push(archive);
    }
  }
  // A completed release retry never moves tags. An incomplete release must not
  // replace a newer channel, including on packages already uploaded in a retry.
  if (!options.dryRun && pending.length) {
    for (const archive of release.archives) {
      assertChannelAdvance(archive.name, release.version, registryTags(archive.name, runner));
    }
  }
  for (const archive of pending) {
    const output = execute(["publish", join(artifacts, archive.filename), "--access", "public", "--tag", distTag, "--ignore-scripts",
      "--registry", "https://registry.npmjs.org", ...(options.dryRun ? ["--dry-run"] : [])], runner);
    process.stdout.write(output);
  }
  console.log(`${options.dryRun ? "Dry run" : "Release"}: ${pending.length} packages, version ${release.version}, npm tag ${distTag}`);
}

async function main(args: string[]): Promise<void> {
  if (!args.length || args.includes("--help") || args.includes("-h") || args[0] === "help") {
    console.log(`refactor-ai npm release runner — pack and publish verified @refactor-ai archives

Usage:
  node dist/npm-release.mjs pack [--packages <directory>] [--artifacts <directory>] [--ref <vX.Y.Z>]
  node dist/npm-release.mjs publish [--artifacts <directory>] [--ref <vX.Y.Z>] [--dry-run]

Options:
  --packages <directory>   pack only; default: dist/npm in this checkout.
  --artifacts <directory>  Archive/manifest directory; default: dist/npm-artifacts.
  --ref <tag>              Exact v<package-version>; required for real publication.
  --dry-run                publish only; validate archives and run npm publish --dry-run.
  --help, -h               Show help without reading packages or calling npm.

Pack requires exactly fourteen @refactor-ai packages with the same semantic version and
pz-solutions/refactor-ai repository metadata. Writes .tgz files and release.json with
SHA-512 integrity. Publish checks all archives before contacting the registry;
matching published versions are skipped, differing content or registry errors
abort preflight. A partial publication can be rerun with the same artifacts.
Stable versions use latest; prereleases use next. Incomplete releases check all
packages' registry tags before uploading and refuse to move latest or next to an
older version. Prereleases must also be newer than latest. Completed retries
skip every upload and preserve tags. Dry run does not query existing
versions or reserve names. Publication across fourteen packages is not atomic.

Requirements: Node.js 22+, npm and previously built packages. GitHub OIDC needs
Node >=22.14, npm >=11.5.1, id-token: write and per-package Trusted Publisher setup;
local real publication requires npm login. Initial package creation is manual.
This runner never builds packages or changes versions. Use version:packages to
bump the common version, then regenerate packages. Paths are relative to cwd.
Exit 0: success/help; exit 1: invalid arguments, integrity/ref mismatch or npm error.

Examples (from the checkout root):
  bun run build
  bun run package:npm
  node dist/npm-release.mjs pack
  node dist/npm-release.mjs pack --ref v0.1.0
  node dist/npm-release.mjs publish --ref v0.1.0 --dry-run
  node dist/npm-release.mjs publish --artifacts ./downloaded/npm-packages --ref v0.1.0
  bun run release:npm --help
`);
    return;
  }
  const command = args.shift();
  if (command !== "pack" && command !== "publish") throw new Error("INVALID_ARGUMENT: use pack or publish");
  const flags: Record<string, string> = {};
  let dryRun = false;
  while (args.length) {
    const flag = args.shift()!;
    if (flag === "--dry-run" && command === "publish" && !dryRun) { dryRun = true; continue; }
    if (!["--artifacts", "--ref", ...(command === "pack" ? ["--packages"] : [])].includes(flag) || flags[flag] !== undefined || !args[0] || args[0].startsWith("--")) throw new Error(`INVALID_ARGUMENT: ${flag}`);
    flags[flag] = args.shift()!;
  }
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const artifacts = resolve(flags["--artifacts"] ?? join(repo, "dist", "npm-artifacts"));
  if (command === "pack") await packRelease(resolve(flags["--packages"] ?? join(repo, "dist", "npm")), artifacts, flags["--ref"]);
  else await publishRelease(artifacts, { ref: flags["--ref"], dryRun });
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
