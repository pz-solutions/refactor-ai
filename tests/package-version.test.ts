import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { nextVersion, releaseChannel } from "../scripts/release-version.ts";
import { bumpVersion } from "../scripts/version.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("common version supports fixes, features, breaking changes and beta promotion", () => {
  expect(nextVersion("0.1.0", "patch")).toBe("0.1.1");
  expect(nextVersion("0.1.0", "minor")).toBe("0.2.0");
  expect(nextVersion("0.1.0", "major")).toBe("1.0.0");
  expect(nextVersion("0.1.0", "preminor", "beta")).toBe("0.2.0-beta.0");
  expect(nextVersion("0.2.0-beta.9", "prerelease", "beta")).toBe("0.2.0-beta.10");
  expect(nextVersion("0.2.0-beta.10", "patch")).toBe("0.2.0");
  expect(nextVersion("0.2.0", "1.0.0-rc.1")).toBe("1.0.0-rc.1");
  expect(releaseChannel("0.2.0")).toBe("latest");
  expect(releaseChannel("0.2.0-beta.10")).toBe("next");
});

test("invalid versions, non-increasing bumps and incompatible preid options fail", () => {
  for (const version of ["0.1.0", "0.0.9", "0.1.0-beta.1", "v0.2.0", "01.2.0", "0.2.0-beta.01", "0.2.0-beta..1", "0.2.0+sha.1", "banana"]) {
    expect(() => nextVersion("0.1.0", version)).toThrow();
  }
  expect(() => nextVersion("0.1.0", "minor", "beta")).toThrow("INVALID_ARGUMENT");
  expect(() => nextVersion("0.1.0", "prerelease", "beta.1")).toThrow("INVALID_ARGUMENT");
});

test("dry-run leaves the author manifest intact; real bumps preserve metadata and print exact tags", async () => {
  const root = await mkdtemp(join(tmpdir(), "refactor-ai-version-test-"));
  roots.push(root);
  const file = join(root, "package.json");
  const manifest = { name: "refactor-ai", private: true, version: "0.1.0", dependencies: { typescript: "5.9.3" }, scripts: { demo: "node dist/demo.js" } };
  const original = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(file, original);
  expect(await bumpVersion(file, "preminor", { preid: "beta", dryRun: true })).toEqual({ previous: "0.1.0", version: "0.2.0-beta.0", gitTag: "v0.2.0-beta.0", npmTag: "next" });
  expect(await readFile(file, "utf8")).toBe(original);
  await bumpVersion(file, "minor");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...manifest, version: "0.2.0" });
  const after = await readFile(file, "utf8");
  await expect(bumpVersion(file, "0.1.0")).rejects.toThrow("VERSION_NOT_NEWER");
  expect(await readFile(file, "utf8")).toBe(after);
  await writeFile(file, JSON.stringify({ ...manifest, private: false }));
  await expect(bumpVersion(file, "patch")).rejects.toThrow("INVALID_MANIFEST");
});

test("bundled version CLI runs through Node without source dependencies and rejects duplicate flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "refactor-ai-version-node-"));
  roots.push(root);
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, "../scripts/version.ts")], target: "node", format: "esm", outdir: root, naming: "version.mjs" });
  expect(result.success).toBe(true);
  const file = join(root, "package.json");
  const original = '{"name":"refactor-ai","private":true,"version":"0.1.0"}\n';
  await writeFile(file, original);
  const run = (...args: string[]) => spawnSync("node", [join(root, "version.mjs"), ...args], { cwd: root, encoding: "utf8" });
  const help = run("--help");
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("Examples:");
  const dryRun = run("minor", "--manifest", file, "--dry-run");
  expect(dryRun.status).toBe(0);
  expect(dryRun.stdout).toContain('"gitTag": "v0.2.0"');
  expect(await readFile(file, "utf8")).toBe(original);
  expect(run("minor", "--dry-run", "--dry-run").status).toBe(1);
  expect(run("patch", "--manifest", file).status).toBe(0);
  expect(JSON.parse(await readFile(file, "utf8")).version).toBe("0.1.1");
});
