import { isAbsolute, relative, sep } from "node:path";

/** Normalize separators only where TypeScript globs or module specifiers require '/'. */
export function portablePath(path: string, separator = sep): string {
  return path.split(separator).join("/");
}

export function isInside(root: string, path: string): boolean {
  const difference = relative(root, path);
  return difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference);
}
