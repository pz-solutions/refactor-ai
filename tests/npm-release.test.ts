import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertReleaseRef, packRelease, publishRelease, type Runner } from "../scripts/npm-release.ts";
import { npmDistributions } from "../src/npm-config.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(version = "0.1.0") {
  const root = await mkdtemp(join(tmpdir(), "refactor-ai-release-test-"));
  roots.push(root);
  const archives = [];
  for (const base of npmDistributions.map(entry => entry.name)) {
    const content = Buffer.from(`test archive content for ${base}`);
    const filename = `${base}.tgz`;
    const integrity = `sha512-${createHash("sha512").update(content).digest("base64")}`;
    await writeFile(join(root, filename), content);
    archives.push({ name: `@refactor-ai/${base}`, version, filename, integrity });
  }
  const release = { version, archives };
  await writeFile(join(root, "release.json"), JSON.stringify(release));
  return { root, release };
}

test("rejects changed archives and incorrect release refs before any npm call", async () => {
  const { root, release } = await fixture();
  const runner: Runner = () => { throw new Error("npm must not be invoked"); };
  await expect(publishRelease(root, { ref: "main" }, runner)).rejects.toThrow("VERSION_MISMATCH");
  await writeFile(join(root, release.archives[8].filename), "changed archive");
  await expect(publishRelease(root, { ref: "v0.1.0" }, runner)).rejects.toThrow("INTEGRITY_MISMATCH");
  expect(() => assertReleaseRef("not-a-version")).toThrow("INVALID_VERSION");
});

test("preflights all packages and retries only missing versions with identical content", async () => {
  const { root, release } = await fixture();
  const calls: string[][] = [];
  const runner: Runner = args => {
    calls.push(args);
    if (args[0] === "view") {
      if (args[2] === "dist-tags") return { status: 0, stdout: '{"latest":"0.0.9"}', stderr: "" };
      const existing = release.archives.slice(0, 4).find(archive => args[1] === `${archive.name}@${archive.version}`);
      return existing ? { status: 0, stdout: JSON.stringify(existing.integrity), stderr: "" }
        : { status: 1, stdout: '{"error":{"code":"E404"}}', stderr: "" };
    }
    expect(calls.slice(0, release.archives.length * 2).every(call => call[0] === "view")).toBe(true);
    return { status: 0, stdout: "", stderr: "" };
  };
  await publishRelease(root, { ref: "v0.1.0" }, runner);
  const publishes = calls.filter(args => args[0] === "publish");
  expect(publishes).toHaveLength(release.archives.length - 4);
  expect(publishes[0][1]).toBe(join(root, release.archives[4].filename));
  expect(publishes.every(args => args[args.indexOf("--tag") + 1] === "latest")).toBe(true);
});

test("a registry content conflict or network failure prevents all publication", async () => {
  const { root, release } = await fixture();
  for (const failure of [
    { status: 0, stdout: '"sha512-other-content"', stderr: "" },
    { status: 1, stdout: '{"error":{"code":"ENETUNREACH"}}', stderr: "Network unavailable" },
  ]) {
    let publishes = 0;
    const runner: Runner = args => {
      if (args[0] === "publish") publishes++;
      if (args[1] === `${release.archives[8].name}@${release.version}`) return failure;
      return { status: 1, stdout: '{"error":{"code":"E404"}}', stderr: "" };
    };
    await expect(publishRelease(root, { ref: "v0.1.0" }, runner)).rejects.toThrow(failure.status === 0 ? "REGISTRY_CONFLICT" : "REGISTRY_FAILED");
    expect(publishes).toBe(0);
  }
});

test("real publication requires an explicit matching version ref", async () => {
  const { root } = await fixture();
  await expect(publishRelease(root, {}, () => { throw new Error("must not call npm"); })).rejects.toThrow("RELEASE_REF_REQUIRED");
});

test("stable and prerelease downgrades abort every upload, including partially published releases", async () => {
  for (const [version, tags] of [
    ["0.1.0", { latest: "0.2.0" }],
    ["0.2.0-beta.2", { latest: "0.1.0", next: "0.2.0-beta.10" }],
    ["0.2.0-beta.11", { latest: "0.2.0" }],
  ] as const) {
    const { root, release } = await fixture(version);
    let publishes = 0;
    const runner: Runner = args => {
      if (args[0] === "publish") publishes++;
      if (args[2] === "dist-tags") return { status: 0, stdout: JSON.stringify(args[1] === release.archives[0].name ? tags : {}), stderr: "" };
      if (args[1] === `${release.archives[0].name}@${version}`) return { status: 0, stdout: JSON.stringify(release.archives[0].integrity), stderr: "" };
      return { status: 1, stdout: '{"error":{"code":"E404"}}', stderr: "" };
    };
    await expect(publishRelease(root, { ref: `v${version}` }, runner)).rejects.toThrow("VERSION_DOWNGRADE");
    expect(publishes).toBe(0);
  }
});

test("prerelease advancement uses numeric SemVer precedence and leaves latest untouched", async () => {
  const { root } = await fixture("0.2.0-beta.10");
  const publishes: string[][] = [];
  await publishRelease(root, { ref: "v0.2.0-beta.10" }, args => {
    if (args[2] === "dist-tags") return { status: 0, stdout: '{"latest":"0.1.0","next":"0.2.0-beta.9"}', stderr: "" };
    if (args[0] === "view") return { status: 1, stdout: '{"error":{"code":"E404"}}', stderr: "" };
    publishes.push(args);
    return { status: 0, stdout: "", stderr: "" };
  });
  expect(publishes).toHaveLength(npmDistributions.length);
  expect(publishes.every(args => args[args.indexOf("--tag") + 1] === "next")).toBe(true);
});

test("completed old releases are idempotent and preserve newer registry tags", async () => {
  const { root, release } = await fixture();
  const calls: string[][] = [];
  await publishRelease(root, { ref: "v0.1.0" }, args => {
    calls.push(args);
    const archive = release.archives.find(archive => args[1] === `${archive.name}@${archive.version}`)!;
    expect(args[2]).toBe("dist.integrity");
    return { status: 0, stdout: JSON.stringify(archive.integrity), stderr: "" };
  });
  expect(calls).toHaveLength(npmDistributions.length);
});

test("channel lookup supports beta-only packages and falls back when next is absent", async () => {
  for (const betaOnly of [true, false]) {
    const { root } = await fixture("0.2.0-beta.2");
    const queries: string[][] = [];
    await expect(publishRelease(root, { ref: "v0.2.0-beta.2" }, args => {
      if (args[0] === "publish") throw new Error("must not upload a downgrade");
      if (args[2] !== "dist-tags") return { status: 1, stdout: '{"error":{"code":"E404"}}', stderr: "" };
      queries.push(args);
      if (!betaOnly && args[args.indexOf("--tag") + 1] === "next") return { status: 1, stdout: '{"error":{"code":"E404"}}', stderr: "" };
      return { status: 0, stdout: JSON.stringify(betaOnly ? { next: "0.2.0-beta.3" } : { latest: "0.2.0" }), stderr: "" };
    })).rejects.toThrow("VERSION_DOWNGRADE");
    expect(queries).toHaveLength(betaOnly ? 1 : 2);
  }
});

test("tag lookup errors and malformed responses prevent every upload", async () => {
  const { root } = await fixture();
  for (const failure of [
    { status: 1, stdout: '{"error":{"code":"E503"}}', stderr: "Service unavailable" },
    { status: 0, stdout: "invalid-json", stderr: "" },
    { status: 0, stdout: "[]", stderr: "" },
    { status: 0, stdout: '{"latest":"invalid-version"}', stderr: "" },
  ]) {
    let publishes = 0;
    await expect(publishRelease(root, { ref: "v0.1.0" }, args => {
      if (args[0] === "publish") publishes++;
      return args[2] === "dist-tags" ? failure : { status: 1, stdout: '{"error":{"code":"E404"}}', stderr: "" };
    })).rejects.toThrow();
    expect(publishes).toBe(0);
  }
});

test("packing rejects inconsistent versions and invalid prereleases before creating archives", async () => {
  const { root, release } = await fixture();
  const packages = join(root, "packages");
  for (const archive of release.archives) {
    const directory = join(packages, archive.name.split("/")[1]);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: archive.name, version: archive.version, repository: { url: "git+https://github.com/pz-solutions/refactor-ai.git" } }));
  }
  const runner: Runner = () => { throw new Error("must not call npm"); };
  const manifest = join(packages, "csharp-move-type", "package.json");
  await writeFile(manifest, JSON.stringify({ name: "@refactor-ai/csharp-move-type", version: "0.2.0", repository: { url: "git+https://github.com/pz-solutions/refactor-ai.git" } }));
  await expect(packRelease(packages, join(root, "output"), "v0.1.0", runner)).rejects.toThrow("INVALID_RELEASE");
  for (const version of ["0.2.0-beta..1", "0.2.0-beta.01", "v0.2.0", "0.2.0+build.1"]) expect(() => assertReleaseRef(version)).toThrow("INVALID_VERSION");
});

test("prerelease dry runs use next and never query registry state", async () => {
  const { root } = await fixture("0.2.0-beta.1");
  const calls: string[][] = [];
  await publishRelease(root, { dryRun: true, ref: "v0.2.0-beta.1" }, args => {
    calls.push(args);
    return { status: 0, stdout: "", stderr: "" };
  });
  expect(calls).toHaveLength(npmDistributions.length);
  expect(calls.every(args => args[0] === "publish" && args.includes("--dry-run") && args[args.indexOf("--tag") + 1] === "next")).toBe(true);
});
