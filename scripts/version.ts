import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nextVersion, releaseChannel } from "./release-version.ts";

export async function bumpVersion(manifestPath: string, change: string, options: { preid?: string; dryRun?: boolean } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.name !== "refactor-ai" || manifest.private !== true) throw new Error("INVALID_MANIFEST: expected the private refactor-ai author package");
  const version = nextVersion(manifest.version, change, options.preid);
  const result = { previous: manifest.version as string, version, gitTag: `v${version}`, npmTag: releaseChannel(version) };
  if (!options.dryRun) await writeFile(manifestPath, JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  return result;
}

async function main(args: string[]): Promise<void> {
  if (!args.length || args.includes("--help") || args.includes("-h") || args[0] === "help") {
    console.log(`refactor-ai package versioning — one shared SemVer version for fifteen npm tools

Usage:
  node dist/version.mjs <increment | exact-version> [--preid <identifier>] [--dry-run] [--manifest <file>]
  bun run version:packages <increment | exact-version> [options]

Increments: patch, minor, major, prepatch, preminor, premajor, prerelease.
An exact version must be newer than the current version. Versions are canonical
SemVer without build metadata. --preid accepts beta, rc or another identifier
starting with a letter, and is allowed only with prerelease increments.

Options:
  --preid <identifier>  Prerelease identifier; use beta or rc for named channels.
  --dry-run            Print the proposed version and tags without writing files.
  --manifest <file>    Author package.json path; default: this checkout/package.json.
  --help, -h           Show help without reading or changing files.

Only the private author package.json is updated. All fifteen generated packages
inherit its version on the next package:npm build. bun.lock has no root version
field and needs no update. No Git commits/tags, builds or publications are made.
Stable releases publish to latest; all prereleases publish to next. Before 1.0,
use minor for breaking changes and patch for compatible changes. From 1.0, use
major for breaking changes, minor for compatible features and patch for fixes.
SemVer determines promotion: patch on 0.2.0-beta.1 produces 0.2.0.

Requirements: Node.js 22+; build this script with Bun before use.
Exit 0: success/help; exit 1: invalid options, version or manifest/read/write error.

Examples:
  bun run build
  bun run version:packages patch --dry-run
  bun run version:packages minor
  bun run version:packages preminor --preid beta
  bun run version:packages prerelease --preid beta
  bun run version:packages 1.0.0-rc.1
  bun run version:packages 1.0.0
  bun run package:npm
  node dist/npm-release.mjs pack --ref v1.0.0

Review and commit the version change with the release sources, then create and
push the printed Git tag. See docs/github-actions.md for publication and retries.
`);
    return;
  }
  const change = args.shift()!;
  const flags: Record<string, string> = {};
  let dryRun = false;
  while (args.length) {
    const flag = args.shift()!;
    if (flag === "--dry-run" && !dryRun) { dryRun = true; continue; }
    if (!["--preid", "--manifest"].includes(flag) || flags[flag] !== undefined || !args[0] || args[0].startsWith("-")) throw new Error(`INVALID_ARGUMENT: ${flag}`);
    flags[flag] = args.shift()!;
  }
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await bumpVersion(resolve(flags["--manifest"] ?? join(repo, "package.json")), change, { preid: flags["--preid"], dryRun });
  console.log(JSON.stringify({ dryRun, ...result }, null, 2));
  console.log("Rebuild packages before packing; commit the release sources before tagging.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
