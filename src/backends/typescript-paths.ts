import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/** Normalize separators only where TypeScript globs or module specifiers require '/'. */
export function portablePath(path: string, separator = sep): string {
  return path.split(separator).join("/");
}

export function isInside(root: string, path: string): boolean {
  const difference = relative(root, path);
  return difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}

/**
 * Hint for sources found outside the root: the nearest ancestor of the root
 * whose package.json declares workspaces and covers them, so --root can widen.
 */
export function workspaceRootHint(root: string, outside: string[]): string {
  let current = root;
  for (;;) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync(manifest, "utf8")).workspaces && outside.every((path) => isInside(current, path))) {
          return `; these files belong to the workspace at ${current}: rerun with --root ${current}`;
        }
      } catch { /* not JSON; keep searching */ }
    }
    const parent = dirname(current);
    if (parent === current) return "; widen --root to a directory containing them";
    current = parent;
  }
}
