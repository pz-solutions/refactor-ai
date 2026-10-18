import ts from "typescript";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fail, isInside } from "./typescript-vfs";

export function packageAt(root: string, file: string, sys = ts.sys): { path: string; directory: string; json: Record<string, any> } | undefined {
  for (let directory = dirname(file); isInside(root, directory); directory = dirname(directory)) {
    const path = resolve(directory, "package.json");
    const text = sys.readFile(path);
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

