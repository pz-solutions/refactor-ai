import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshot } from "../src/core/snapshot.ts";

async function repo(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-snapshot-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, ".gitignore"), "cache/\n");
  await mkdir(join(root, "src"));
  await mkdir(join(root, "cache"));
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "cache", "big.bin"), "ignored\n");
  return root;
}

describe("snapshot", () => {
  test("inside Git counts tracked and unignored files only", async () => {
    const root = await repo();
    const before = await snapshot(root);
    expect(Object.keys(before.files).sort()).toEqual([".gitignore", "src/a.ts"]);
    await writeFile(join(root, "cache", "big.bin"), "changed\n");
    expect((await snapshot(root)).hash).toBe(before.hash);
    await writeFile(join(root, "src", "b.ts"), "export const b = 2;\n");
    expect((await snapshot(root)).hash).not.toBe(before.hash);
  });

  test("records symlinks by link text instead of rejecting the project", async () => {
    const root = await repo();
    await symlink("../outside", join(root, "linked"));
    const first = await snapshot(root);
    expect(first.files.linked).toBe("symlink:../outside");
  });
});
