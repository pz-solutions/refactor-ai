import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

/** Invoke npm's JavaScript entry through Node, including installations with .cmd shims. */
export function npmCli(): string {
  const executableDirectory = dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ...(process.env.PATH ?? "").split(delimiter).map(directory => join(directory, process.platform === "win32" ? "npm.cmd" : "npm")),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      let path = realpathSync(candidate);
      if (path.endsWith(".cmd")) path = join(dirname(path), "node_modules", "npm", "bin", "npm-cli.js");
      if (path.endsWith("npm-cli.js") && existsSync(path)) return path;
    } catch { /* Try the next standard Node/npm installation layout. */ }
  }
  throw new Error("NPM_NOT_FOUND: npm is required; install Node.js with npm");
}
