import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("the actual VFS parses and updates Windows drive and UNC globs", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-windows-vfs-")));
  try {
    await mkdir(join(root, "src", "ignored"), { recursive: true });
    await writeFile(join(root, "src", "Old.ts"), "export class Widget {}\n");
    await writeFile(join(root, "src", "ignored", "Bad.ts"), "not compiled\n");
    await writeFile(join(root, "tsconfig.json"), '{"include":["src/**/*.ts"],"exclude":["src/ignored/**"]}');
    // Isolate module mocks: translate Windows-shaped paths to a real fixture
    // while exercising the production VFS and TypeScript config parser.
    const script = `
      import { mock } from "bun:test";
      import fs from "node:fs";
      import { win32, join as nativeJoin } from "node:path";
      const actualRoot = ${JSON.stringify(root)};
      const native = { ...fs };
      const diskJoin = nativeJoin;
      let windowsRoot;
      const diskPath = value => {
        const path = String(value);
        if (!path.toLowerCase().startsWith(windowsRoot.toLowerCase())) return path;
        return diskJoin(actualRoot, ...path.slice(windowsRoot.length).split(/[\\\\/]/).filter(Boolean));
      };
      const realpath = value => {
        const path = String(value);
        if (path.toLowerCase().startsWith(windowsRoot.toLowerCase())) { native.realpathSync(diskPath(path)); return path; }
        return native.realpathSync(path);
      };
      realpath.native = realpath;
      mock.module("node:path", () => ({ ...win32, win32 }));
      mock.module("node:fs", () => ({ ...native,
        statSync: (path, ...args) => native.statSync(diskPath(path), ...args),
        existsSync: path => native.existsSync(diskPath(path)),
        readFileSync: (path, ...args) => native.readFileSync(diskPath(path), ...args),
        readdirSync: (path, ...args) => native.readdirSync(diskPath(path), ...args),
        realpathSync: realpath,
      }));
      const { VirtualFs } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/backends/typescript-vfs.ts"))});
      const ts = (await import("typescript")).default;
      for (const prefix of ["C:\\\\review\\\\project", "\\\\\\\\server\\\\share\\\\project"]) {
        windowsRoot = prefix;
        const vfs = new VirtualFs(prefix);
        const parse = () => ts.getParsedCommandLineOfConfigFile(win32.join(prefix, "tsconfig.json"), {}, vfs.parseConfigHost(error => { throw new Error(String(error.messageText)); }));
        const before = parse();
        if (before.errors.length || before.fileNames.length !== 1 || !before.fileNames[0].endsWith("Old.ts")) throw new Error("Windows glob did not match the original file: " + JSON.stringify(before));
        const target = win32.join(prefix, "src", "nested", "Widget.ts");
        vfs.write(win32.join(prefix, "src", "Old.ts"), null);
        vfs.write(target, "export class Widget {}\\n");
        const after = parse();
        if (after.errors.length || after.fileNames.length !== 1 || vfs.key(after.fileNames[0]) !== vfs.key(target)) throw new Error("Windows glob did not observe the nested overlay: " + JSON.stringify(after));
        if (!vfs.entries(win32.join(prefix, "src")).directories.includes("nested")) throw new Error("Windows parent directory missing");
      }
      console.log("Windows drive and UNC overlays passed");
    `;
    const result = Bun.spawnSync([process.execPath, "--eval", script], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    expect(new TextDecoder().decode(result.stdout)).toContain("Windows drive and UNC overlays passed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
