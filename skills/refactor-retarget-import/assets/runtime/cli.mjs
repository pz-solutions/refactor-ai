#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res, err) => () => {
  if (fn)
    try {
      res = fn(fn = 0);
    } catch (e) {
      err = [e];
    }
  if (err)
    throw err[0];
  return res;
};

// package.json
var package_default;
var init_package = __esm(() => {
  package_default = {
    name: "refactor-ai",
    version: "0.1.4",
    private: true,
    repository: {
      type: "git",
      url: "git+https://github.com/pz-solutions/refactor-ai.git"
    },
    type: "module",
    scripts: {
      refactor: "node dist/cli.js",
      bench: "bun scripts/bench.ts",
      "bench:warm": "bun scripts/bench-warm.ts",
      "bench:checkers": "bun scripts/bench-checkers.ts",
      build: "bun build src/cli.ts --target node --format esm --outfile dist/cli.js --external typescript --external typescript7 && bun build src/api-entry.ts --target node --format esm --outfile dist/api.mjs --external typescript --external typescript7 && bun build scripts/demo.ts --target node --format esm --outfile dist/demo.js --external typescript --external typescript7 && bun build scripts/npm-release.ts --target node --format esm --outfile dist/npm-release.mjs && bun build scripts/version.ts --target node --format esm --outfile dist/version.mjs && bun scripts/package-skills.ts",
      "package:skills": "bun scripts/package-skills.ts --build",
      "package:npm": "bun scripts/package-npm.ts",
      "release:npm": "node dist/npm-release.mjs",
      "test:npm": "bun test ./tests/npm-packages.integration.ts",
      "build:csharp": "dotnet build dotnet/RefactorHelper/RefactorHelper.csproj -c Release --nologo -p:RestoreLockedMode=true",
      typecheck: "tsc --noEmit",
      test: "bun test",
      "test:skills": "bun run build && bun test ./tests/skills-install.integration.ts",
      demo: "node dist/demo.js",
      "version:packages": "node dist/version.mjs"
    },
    engines: {
      node: ">=22"
    },
    dependencies: {
      diff: "8.0.2",
      typescript: "5.9.3"
    },
    devDependencies: {
      "@types/bun": "1.3.0",
      "@types/semver": "7.8.0",
      semver: "7.8.5",
      typescript7: "npm:typescript@7.0.2"
    },
    peerDependencies: {
      typescript7: "npm:typescript@7.0.2"
    },
    peerDependenciesMeta: {
      typescript7: {
        optional: true
      }
    }
  };
});

// src/core/snapshot.ts
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function describeInputPath(path) {
  const portable = path.split(sep).join("/");
  return /(^|\/)(next-env\.d\.ts|[^/]+\.gen\.[^/]+|_generated|\.next)(\/|$)/.test(portable) ? `${path} [generated candidate]` : path;
}
function snapshotChanges(before, after) {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort().filter((path) => before.files[path] !== after.files[path]).map((path) => `${before.files[path] === undefined ? "added" : after.files[path] === undefined ? "removed" : "changed"} ${describeInputPath(path)}`).join(", ");
}
function inside(root, file) {
  const result = resolve(file);
  const rel = relative(root, result);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`OUTSIDE_ROOT: ${file}`);
  }
  if (rel.split(sep).some((part) => excluded.has(part))) {
    throw new Error(`EXCLUDED_PATH: ${file}`);
  }
  return result;
}
async function assertRegularPath(root, file, allowMissing = false, allowDirectory = false) {
  if (allowDirectory && resolve(file) === root && (await lstat(root)).isDirectory())
    return;
  const target = inside(root, file);
  const parts = relative(root, target).split(sep);
  let current = root;
  for (let i = 0;i < parts.length; i++) {
    current = resolve(current, parts[i]);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (allowMissing && error.code === "ENOENT")
        return;
      throw error;
    }
    if (stat.isSymbolicLink())
      throw new Error(`SYMLINK_UNSUPPORTED: ${current}`);
    if (i === parts.length - 1 && !stat.isFile() && !(allowDirectory && stat.isDirectory()))
      throw new Error(`NOT_A_FILE: ${current}`);
    if (i < parts.length - 1 && !stat.isDirectory())
      throw new Error(`NOT_A_DIRECTORY: ${current}`);
  }
}
async function canonicalMissing(file) {
  const absolute = resolve(file);
  const parent = dirname(absolute);
  if (parent === absolute)
    return realpath(absolute);
  try {
    return resolve(await realpath(parent), basename(absolute));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw error;
    return resolve(await canonicalMissing(parent), basename(absolute));
  }
}
async function missingDirectories(root, file) {
  const parts = relative(root, dirname(inside(root, file))).split(sep).filter(Boolean);
  const missing = [];
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    if (missing.length) {
      missing.push(current);
      continue;
    }
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink())
        throw new Error(`SYMLINK_UNSUPPORTED: ${current}`);
      if (!stat.isDirectory())
        throw new Error(`NOT_A_DIRECTORY: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT")
        throw error;
      missing.push(current);
    }
  }
  return missing;
}
async function snapshot(rootPath) {
  const root = await realpath(rootPath);
  const files = {};
  const record = async (file, kind) => {
    files[relative(root, file)] = kind === "symlink" ? `symlink:${await readlink(file)}` : sha256(await readFile(file));
  };
  const listed = await gitFiles(root);
  if (listed) {
    for (const name of listed) {
      if (name.split("/").some((part) => excluded.has(part)))
        continue;
      const file = resolve(root, name);
      const stat = await lstat(file).catch((error) => {
        if (error.code === "ENOENT")
          return null;
        throw error;
      });
      if (stat?.isSymbolicLink())
        await record(file, "symlink");
      else if (stat?.isFile())
        await record(file, "file");
    }
  } else {
    async function walk(directory) {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        if (excluded.has(entry.name))
          continue;
        const file = resolve(directory, entry.name);
        if (entry.isSymbolicLink())
          await record(file, "symlink");
        else if (entry.isDirectory())
          await walk(file);
        else if (entry.isFile())
          await record(file, "file");
      }
    }
    await walk(root);
  }
  return { files, hash: sha256(JSON.stringify(files)) };
}
async function gitFiles(root) {
  try {
    const { stdout } = await run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], {
      cwd: root,
      maxBuffer: 1 << 28,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
    });
    try {
      await run("git", ["check-ignore", "--no-index", "--quiet", "."], { cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
      return null;
    } catch {}
    const names = [...new Set(stdout.split("\x00").filter(Boolean))].map((name) => name.split(sep).join("/"));
    return names.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  } catch {
    return null;
  }
}
async function ignoreStateDirectory(stateDirectory) {
  const path = resolve(stateDirectory, ".gitignore");
  const stat = await lstat(path).catch((error) => {
    if (error.code === "ENOENT")
      return;
    throw error;
  });
  if (stat?.isSymbolicLink())
    throw new Error("SYMLINK_UNSUPPORTED: state .gitignore");
  if (stat?.isFile()) {
    if (legacyIgnoreTexts.includes(await readFile(path, "utf8")))
      await writeFile(path, stateIgnoreText);
    return;
  }
  try {
    await writeFile(path, stateIgnoreText, { flag: "wx", mode: 420 });
  } catch (error) {
    if (error.code !== "EEXIST")
      throw error;
  }
}
var excluded, run, stateIgnoreText = `*
!config.json
!equivalents.json
!port-route.json
!port-route/
!port-route/**
!.gitignore
`, legacyIgnoreTexts;
var init_snapshot = __esm(() => {
  excluded = new Set([".git", "node_modules", "bin", "obj", "dist", ".refactor-ai"]);
  run = promisify(execFile);
  legacyIgnoreTexts = [`*
`, `*
!equivalents.json
!.gitignore
`, `*
!equivalents.json
!port-route.json
!port-route/
!port-route/**
!.gitignore
`];
});

// src/run-log.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash as createHash2 } from "node:crypto";
import { constants } from "node:fs";
import { lstat as lstat2, mkdir, open, readFile as readFile2, realpath as realpath2 } from "node:fs/promises";
import { dirname as dirname2, resolve as resolve2 } from "node:path";
function updateRun(values) {
  const run = active.getStore();
  if (run)
    Object.assign(run, values);
}
function recordPhase(phase, ms) {
  active.getStore()?.phases.push({ phase, ms });
}
function flag(args, name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}
async function append(run) {
  const root = await realpath2(run.root);
  const directory = resolve2(root, ".refactor-ai");
  await mkdir(directory, { recursive: true, mode: 448 });
  if ((await lstat2(directory)).isSymbolicLink())
    return;
  await ignoreStateDirectory(directory);
  identity ??= readFile2(new URL(import.meta.url)).then((bytes) => ({ version: package_default.version, sha256: createHash2("sha256").update(bytes).digest("hex") }), () => ({ version: package_default.version, sha256: null }));
  run.cli = await identity;
  run.root = root;
  const handle = await open(resolve2(directory, "runs.jsonl"), constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 384);
  try {
    await handle.writeFile(JSON.stringify(run) + `
`);
  } finally {
    await handle.close();
  }
}
async function logRun(args, execute) {
  if (process.env.REFACTOR_AI_RUN_LOG === "off")
    return execute();
  const start = performance.now(), cwd = process.cwd();
  const project = flag(args, "project");
  const command = !args.length || ["help", "--help", "-h"].includes(args[0]) ? "help" : args[0];
  const run = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    command,
    op: command === "plan" ? args[1] ?? "plan" : command,
    argv: [...args],
    cwd,
    root: resolve2(flag(args, "root") ?? (project ? dirname2(resolve2(project)) : cwd)),
    wallMs: 0,
    phases: [],
    status: "ok",
    exitCode: 0,
    errorCode: null,
    planId: null,
    cli: { version: package_default.version, sha256: null },
    checker: null
  };
  return active.run(run, async () => {
    try {
      return await execute();
    } catch (error) {
      run.status = "failed";
      run.exitCode = 1;
      run.errorCode = /^(?:Error: )?([A-Z][A-Z0-9_]+):/.exec(String(error))?.[1] ?? "UNKNOWN_ERROR";
      throw error;
    } finally {
      run.wallMs = Math.round(performance.now() - start);
      await append(run).catch(() => {});
    }
  });
}
var storageKey, runtime, active, identity;
var init_run_log = __esm(() => {
  init_package();
  init_snapshot();
  storageKey = Symbol.for("refactor-ai.run-log.v1");
  runtime = globalThis;
  active = runtime[storageKey] ??= new AsyncLocalStorage;
});

// src/core/read-set.ts
import { createRequire } from "node:module";
import { createHash as createHash3 } from "node:crypto";
function inputDigest(method, value) {
  if (method === "getDirectories" && Array.isArray(value)) {
    value = value.filter((path) => typeof path !== "string" || path.replaceAll("\\", "/").split("/").at(-1) !== ".refactor-ai");
  }
  return inputHash(value);
}
function assertReadSetShape(inputs) {
  if (!Array.isArray(inputs) || inputs.some((input) => !input || !inputMethods.includes(input.method) || !Array.isArray(input.args) || typeof input.args[0] !== "string" || !/^[a-f0-9]{64}$/.test(input.digest))) {
    throw new Error("INVALID_PLAN: malformed read set");
  }
}
function inputQueryDetails(input) {
  if (input.method !== "readDirectory")
    return "";
  const [, extensions, excludes, includes, depth] = input.args;
  return ` (query: ${JSON.stringify({ extensions, excludes, includes, depth })})`;
}
async function assertReadSetFresh(inputs, compilerBase) {
  assertReadSetShape(inputs);
  if (!inputs.length)
    return;
  const load = createRequire(compilerBase ?? import.meta.url);
  const ts = load("typescript");
  for (const input of inputs) {
    const method = ts.sys[input.method];
    if (!method || inputDigest(input.method, method(...input.args.map((value) => value === null ? undefined : value))) !== input.digest) {
      throw new Error(`STALE_PROJECT_INPUTS: ${input.method} changed: ${input.args[0]}${inputQueryDetails(input)}; compiler inputs include project-discovery reads; create a new plan after those writers/generators settle`);
    }
  }
}
var inputMethods, inputHash = (value) => createHash3("sha256").update(typeof value === "string" ? `string:${value}` : JSON.stringify(value) ?? "undefined").digest("hex");
var init_read_set = __esm(() => {
  inputMethods = ["readFile", "fileExists", "directoryExists", "getDirectories", "readDirectory", "realpath"];
});

// node_modules/diff/libesm/diff/base.js
class Diff {
  diff(oldStr, newStr, options = {}) {
    let callback;
    if (typeof options === "function") {
      callback = options;
      options = {};
    } else if ("callback" in options) {
      callback = options.callback;
    }
    const oldString = this.castInput(oldStr, options);
    const newString = this.castInput(newStr, options);
    const oldTokens = this.removeEmpty(this.tokenize(oldString, options));
    const newTokens = this.removeEmpty(this.tokenize(newString, options));
    return this.diffWithOptionsObj(oldTokens, newTokens, options, callback);
  }
  diffWithOptionsObj(oldTokens, newTokens, options, callback) {
    var _a;
    const done = (value) => {
      value = this.postProcess(value, options);
      if (callback) {
        setTimeout(function() {
          callback(value);
        }, 0);
        return;
      } else {
        return value;
      }
    };
    const newLen = newTokens.length, oldLen = oldTokens.length;
    let editLength = 1;
    let maxEditLength = newLen + oldLen;
    if (options.maxEditLength != null) {
      maxEditLength = Math.min(maxEditLength, options.maxEditLength);
    }
    const maxExecutionTime = (_a = options.timeout) !== null && _a !== undefined ? _a : Infinity;
    const abortAfterTimestamp = Date.now() + maxExecutionTime;
    const bestPath = [{ oldPos: -1, lastComponent: undefined }];
    let newPos = this.extractCommon(bestPath[0], newTokens, oldTokens, 0, options);
    if (bestPath[0].oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
      return done(this.buildValues(bestPath[0].lastComponent, newTokens, oldTokens));
    }
    let minDiagonalToConsider = -Infinity, maxDiagonalToConsider = Infinity;
    const execEditLength = () => {
      for (let diagonalPath = Math.max(minDiagonalToConsider, -editLength);diagonalPath <= Math.min(maxDiagonalToConsider, editLength); diagonalPath += 2) {
        let basePath;
        const removePath = bestPath[diagonalPath - 1], addPath = bestPath[diagonalPath + 1];
        if (removePath) {
          bestPath[diagonalPath - 1] = undefined;
        }
        let canAdd = false;
        if (addPath) {
          const addPathNewPos = addPath.oldPos - diagonalPath;
          canAdd = addPath && 0 <= addPathNewPos && addPathNewPos < newLen;
        }
        const canRemove = removePath && removePath.oldPos + 1 < oldLen;
        if (!canAdd && !canRemove) {
          bestPath[diagonalPath] = undefined;
          continue;
        }
        if (!canRemove || canAdd && removePath.oldPos < addPath.oldPos) {
          basePath = this.addToPath(addPath, true, false, 0, options);
        } else {
          basePath = this.addToPath(removePath, false, true, 1, options);
        }
        newPos = this.extractCommon(basePath, newTokens, oldTokens, diagonalPath, options);
        if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
          return done(this.buildValues(basePath.lastComponent, newTokens, oldTokens)) || true;
        } else {
          bestPath[diagonalPath] = basePath;
          if (basePath.oldPos + 1 >= oldLen) {
            maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
          }
          if (newPos + 1 >= newLen) {
            minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
          }
        }
      }
      editLength++;
    };
    if (callback) {
      (function exec() {
        setTimeout(function() {
          if (editLength > maxEditLength || Date.now() > abortAfterTimestamp) {
            return callback(undefined);
          }
          if (!execEditLength()) {
            exec();
          }
        }, 0);
      })();
    } else {
      while (editLength <= maxEditLength && Date.now() <= abortAfterTimestamp) {
        const ret = execEditLength();
        if (ret) {
          return ret;
        }
      }
    }
  }
  addToPath(path, added, removed, oldPosInc, options) {
    const last = path.lastComponent;
    if (last && !options.oneChangePerToken && last.added === added && last.removed === removed) {
      return {
        oldPos: path.oldPos + oldPosInc,
        lastComponent: { count: last.count + 1, added, removed, previousComponent: last.previousComponent }
      };
    } else {
      return {
        oldPos: path.oldPos + oldPosInc,
        lastComponent: { count: 1, added, removed, previousComponent: last }
      };
    }
  }
  extractCommon(basePath, newTokens, oldTokens, diagonalPath, options) {
    const newLen = newTokens.length, oldLen = oldTokens.length;
    let oldPos = basePath.oldPos, newPos = oldPos - diagonalPath, commonCount = 0;
    while (newPos + 1 < newLen && oldPos + 1 < oldLen && this.equals(oldTokens[oldPos + 1], newTokens[newPos + 1], options)) {
      newPos++;
      oldPos++;
      commonCount++;
      if (options.oneChangePerToken) {
        basePath.lastComponent = { count: 1, previousComponent: basePath.lastComponent, added: false, removed: false };
      }
    }
    if (commonCount && !options.oneChangePerToken) {
      basePath.lastComponent = { count: commonCount, previousComponent: basePath.lastComponent, added: false, removed: false };
    }
    basePath.oldPos = oldPos;
    return newPos;
  }
  equals(left, right, options) {
    if (options.comparator) {
      return options.comparator(left, right);
    } else {
      return left === right || !!options.ignoreCase && left.toLowerCase() === right.toLowerCase();
    }
  }
  removeEmpty(array) {
    const ret = [];
    for (let i = 0;i < array.length; i++) {
      if (array[i]) {
        ret.push(array[i]);
      }
    }
    return ret;
  }
  castInput(value, options) {
    return value;
  }
  tokenize(value, options) {
    return Array.from(value);
  }
  join(chars) {
    return chars.join("");
  }
  postProcess(changeObjects, options) {
    return changeObjects;
  }
  get useLongestToken() {
    return false;
  }
  buildValues(lastComponent, newTokens, oldTokens) {
    const components = [];
    let nextComponent;
    while (lastComponent) {
      components.push(lastComponent);
      nextComponent = lastComponent.previousComponent;
      delete lastComponent.previousComponent;
      lastComponent = nextComponent;
    }
    components.reverse();
    const componentLen = components.length;
    let componentPos = 0, newPos = 0, oldPos = 0;
    for (;componentPos < componentLen; componentPos++) {
      const component = components[componentPos];
      if (!component.removed) {
        if (!component.added && this.useLongestToken) {
          let value = newTokens.slice(newPos, newPos + component.count);
          value = value.map(function(value, i) {
            const oldValue = oldTokens[oldPos + i];
            return oldValue.length > value.length ? oldValue : value;
          });
          component.value = this.join(value);
        } else {
          component.value = this.join(newTokens.slice(newPos, newPos + component.count));
        }
        newPos += component.count;
        if (!component.added) {
          oldPos += component.count;
        }
      } else {
        component.value = this.join(oldTokens.slice(oldPos, oldPos + component.count));
        oldPos += component.count;
      }
    }
    return components;
  }
}
// node_modules/diff/libesm/diff/line.js
function diffLines(oldStr, newStr, options) {
  return lineDiff.diff(oldStr, newStr, options);
}
function tokenize(value, options) {
  if (options.stripTrailingCr) {
    value = value.replace(/\r\n/g, `
`);
  }
  const retLines = [], linesAndNewlines = value.split(/(\n|\r\n)/);
  if (!linesAndNewlines[linesAndNewlines.length - 1]) {
    linesAndNewlines.pop();
  }
  for (let i = 0;i < linesAndNewlines.length; i++) {
    const line = linesAndNewlines[i];
    if (i % 2 && !options.newlineIsToken) {
      retLines[retLines.length - 1] += line;
    } else {
      retLines.push(line);
    }
  }
  return retLines;
}
var LineDiff, lineDiff;
var init_line = __esm(() => {
  LineDiff = class LineDiff extends Diff {
    constructor() {
      super(...arguments);
      this.tokenize = tokenize;
    }
    equals(left, right, options) {
      if (options.ignoreWhitespace) {
        if (!options.newlineIsToken || !left.includes(`
`)) {
          left = left.trim();
        }
        if (!options.newlineIsToken || !right.includes(`
`)) {
          right = right.trim();
        }
      } else if (options.ignoreNewlineAtEof && !options.newlineIsToken) {
        if (left.endsWith(`
`)) {
          left = left.slice(0, -1);
        }
        if (right.endsWith(`
`)) {
          right = right.slice(0, -1);
        }
      }
      return super.equals(left, right, options);
    }
  };
  lineDiff = new LineDiff;
});

// node_modules/diff/libesm/patch/create.js
function structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options) {
  let optionsObj;
  if (!options) {
    optionsObj = {};
  } else if (typeof options === "function") {
    optionsObj = { callback: options };
  } else {
    optionsObj = options;
  }
  if (typeof optionsObj.context === "undefined") {
    optionsObj.context = 4;
  }
  const context = optionsObj.context;
  if (optionsObj.newlineIsToken) {
    throw new Error("newlineIsToken may not be used with patch-generation functions, only with diffing functions");
  }
  if (!optionsObj.callback) {
    return diffLinesResultToPatch(diffLines(oldStr, newStr, optionsObj));
  } else {
    const { callback } = optionsObj;
    diffLines(oldStr, newStr, Object.assign(Object.assign({}, optionsObj), { callback: (diff) => {
      const patch = diffLinesResultToPatch(diff);
      callback(patch);
    } }));
  }
  function diffLinesResultToPatch(diff) {
    if (!diff) {
      return;
    }
    diff.push({ value: "", lines: [] });
    function contextLines(lines) {
      return lines.map(function(entry) {
        return " " + entry;
      });
    }
    const hunks = [];
    let oldRangeStart = 0, newRangeStart = 0, curRange = [], oldLine = 1, newLine = 1;
    for (let i = 0;i < diff.length; i++) {
      const current = diff[i], lines = current.lines || splitLines(current.value);
      current.lines = lines;
      if (current.added || current.removed) {
        if (!oldRangeStart) {
          const prev = diff[i - 1];
          oldRangeStart = oldLine;
          newRangeStart = newLine;
          if (prev) {
            curRange = context > 0 ? contextLines(prev.lines.slice(-context)) : [];
            oldRangeStart -= curRange.length;
            newRangeStart -= curRange.length;
          }
        }
        for (const line of lines) {
          curRange.push((current.added ? "+" : "-") + line);
        }
        if (current.added) {
          newLine += lines.length;
        } else {
          oldLine += lines.length;
        }
      } else {
        if (oldRangeStart) {
          if (lines.length <= context * 2 && i < diff.length - 2) {
            for (const line of contextLines(lines)) {
              curRange.push(line);
            }
          } else {
            const contextSize = Math.min(lines.length, context);
            for (const line of contextLines(lines.slice(0, contextSize))) {
              curRange.push(line);
            }
            const hunk = {
              oldStart: oldRangeStart,
              oldLines: oldLine - oldRangeStart + contextSize,
              newStart: newRangeStart,
              newLines: newLine - newRangeStart + contextSize,
              lines: curRange
            };
            hunks.push(hunk);
            oldRangeStart = 0;
            newRangeStart = 0;
            curRange = [];
          }
        }
        oldLine += lines.length;
        newLine += lines.length;
      }
    }
    for (const hunk of hunks) {
      for (let i = 0;i < hunk.lines.length; i++) {
        if (hunk.lines[i].endsWith(`
`)) {
          hunk.lines[i] = hunk.lines[i].slice(0, -1);
        } else {
          hunk.lines.splice(i + 1, 0, "\\ No newline at end of file");
          i++;
        }
      }
    }
    return {
      oldFileName,
      newFileName,
      oldHeader,
      newHeader,
      hunks
    };
  }
}
function formatPatch(patch) {
  if (Array.isArray(patch)) {
    return patch.map(formatPatch).join(`
`);
  }
  const ret = [];
  if (patch.oldFileName == patch.newFileName) {
    ret.push("Index: " + patch.oldFileName);
  }
  ret.push("===================================================================");
  ret.push("--- " + patch.oldFileName + (typeof patch.oldHeader === "undefined" ? "" : "\t" + patch.oldHeader));
  ret.push("+++ " + patch.newFileName + (typeof patch.newHeader === "undefined" ? "" : "\t" + patch.newHeader));
  for (let i = 0;i < patch.hunks.length; i++) {
    const hunk = patch.hunks[i];
    if (hunk.oldLines === 0) {
      hunk.oldStart -= 1;
    }
    if (hunk.newLines === 0) {
      hunk.newStart -= 1;
    }
    ret.push("@@ -" + hunk.oldStart + "," + hunk.oldLines + " +" + hunk.newStart + "," + hunk.newLines + " @@");
    for (const line of hunk.lines) {
      ret.push(line);
    }
  }
  return ret.join(`
`) + `
`;
}
function createTwoFilesPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options) {
  if (typeof options === "function") {
    options = { callback: options };
  }
  if (!(options === null || options === undefined ? undefined : options.callback)) {
    const patchObj = structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options);
    if (!patchObj) {
      return;
    }
    return formatPatch(patchObj);
  } else {
    const { callback } = options;
    structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, Object.assign(Object.assign({}, options), { callback: (patchObj) => {
      if (!patchObj) {
        callback(undefined);
      } else {
        callback(formatPatch(patchObj));
      }
    } }));
  }
}
function splitLines(text) {
  const hasTrailingNl = text.endsWith(`
`);
  const result = text.split(`
`).map((line) => line + `
`);
  if (hasTrailingNl) {
    result.pop();
  } else {
    result.push(result.pop().slice(0, -1));
  }
  return result;
}
var init_create = __esm(() => {
  init_line();
});

// node_modules/diff/libesm/index.js
var init_libesm = __esm(() => {
  init_create();
});

// src/core/plan.ts
import { lstat as lstat3, readFile as readFile3, realpath as realpath3 } from "node:fs/promises";
import { isAbsolute as isAbsolute2, relative as relative2, resolve as resolve3, sep as sep2 } from "node:path";
function newDiagnostics(before, after) {
  const key = (d) => JSON.stringify([d.file, d.code, d.message]);
  const counts = new Map;
  for (const item of before)
    counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return after.filter((item) => {
    const count = counts.get(key(item)) ?? 0;
    if (!count)
      return true;
    counts.set(key(item), count - 1);
    return false;
  });
}
function planId(plan) {
  const { id: _id, ...body } = plan;
  return sha256(JSON.stringify(body));
}
function changeKind(change) {
  if (change.before === null && change.after === null)
    throw new Error(`INVALID_CHANGE: ${change.path} has neither before nor after content`);
  return change.before === null ? "create" : change.after === null ? "delete" : "edit";
}
function byPath(a, b) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
function caseConflict(root, files, changes) {
  const removed = new Set(changes.filter((c) => c.after === null).map((c) => relative2(root, c.path)));
  const created = changes.filter((c) => c.before === null).map((c) => relative2(root, c.path));
  const spellings = new Map;
  const record = (file) => {
    const parts = file.split(sep2);
    for (let i = 1;i <= parts.length; i++) {
      const exact = parts.slice(0, i).join(sep2);
      const key = exact.normalize("NFC").toLowerCase();
      const set = spellings.get(key) ?? new Set;
      set.add(exact);
      spellings.set(key, set);
    }
  };
  for (const file of Object.keys(files))
    if (!removed.has(file))
      record(file);
  for (const file of created)
    record(file);
  for (const file of created) {
    const parts = file.split(sep2);
    for (let i = 1;i <= parts.length; i++) {
      if ((spellings.get(parts.slice(0, i).join(sep2).normalize("NFC").toLowerCase())?.size ?? 0) > 1)
        return resolve3(root, file);
    }
  }
  return;
}
function assertPlanShape(plan) {
  if (plan?.schemaVersion !== 1 && plan?.schemaVersion !== 2 && plan?.schemaVersion !== 3 || !plan.request || typeof plan.request.root !== "string" || !Array.isArray(plan.changes) || !plan.snapshot || !plan.validation || !Array.isArray(plan.diagnosticsBefore) || !Array.isArray(plan.diagnosticsAfter)) {
    throw new Error("INVALID_PLAN: unsupported or malformed plan");
  }
  if (plan.id !== planId(plan))
    throw new Error("INVALID_PLAN: plan integrity check failed");
  if (plan.snapshot.hash !== sha256(JSON.stringify(plan.snapshot.files)))
    throw new Error("INVALID_PLAN: invalid snapshot");
  if (plan.request.verify !== undefined && (plan.request.verify !== "bindings" || plan.diagnosticsBefore.length || plan.diagnosticsAfter.length)) {
    throw new Error("INVALID_PLAN: invalid verification mode");
  }
  if (plan.schemaVersion === 3)
    assertReadSetShape(plan.readSet);
  else if (plan.readSet !== undefined)
    throw new Error("INVALID_PLAN: read set requires schema 3");
  const added = newDiagnostics(plan.diagnosticsBefore, plan.diagnosticsAfter);
  if (JSON.stringify(added) !== JSON.stringify(plan.validation.newDiagnostics) || plan.validation.status !== (added.length ? "failed" : "passed")) {
    throw new Error("INVALID_PLAN: inconsistent validation");
  }
  const seen = new Set;
  let previous = "";
  for (const change of plan.changes) {
    if (!change || typeof change.path !== "string" || change.before !== null && typeof change.before !== "string" || change.after !== null && typeof change.after !== "string" || change.before === null && change.after === null || change.before === change.after) {
      throw new Error("INVALID_PLAN: invalid change");
    }
    if (change.after === null && plan.schemaVersion < 2)
      throw new Error("INVALID_PLAN: deletions require plan schema 2");
    const path = inside(plan.request.root, change.path);
    if (path !== change.path || seen.has(path) || path < previous)
      throw new Error("INVALID_PLAN: duplicate, unsorted or noncanonical path");
    seen.add(path);
    previous = path;
    const expected = plan.snapshot.files[relative2(plan.request.root, path)];
    if (change.before === null ? expected !== undefined : sha256(Buffer.from(change.before)) !== expected) {
      throw new Error(`INVALID_PLAN: before content does not match snapshot: ${path}`);
    }
  }
  const conflict = caseConflict(plan.request.root, plan.snapshot.files, plan.changes);
  if (conflict)
    throw new Error(`INVALID_PLAN: case-insensitive path collision: ${conflict}`);
  if (plan.fileModes !== undefined) {
    if (!plan.fileModes || Object.keys(plan.fileModes).length !== plan.changes.length)
      throw new Error("INVALID_PLAN: invalid file modes");
    const validMode = (value) => Number.isInteger(value) && value >= 0 && value <= 511;
    for (const change of plan.changes) {
      const modes = plan.fileModes[change.path];
      if (!modes || (change.before === null ? modes.before !== null : !validMode(modes.before)) || (change.after === null ? modes.after !== null : !validMode(modes.after)) || change.before !== null && change.after !== null && modes.before !== modes.after) {
        throw new Error(`INVALID_PLAN: invalid file modes: ${change.path}`);
      }
    }
  }
}
async function canonicalRequest(request) {
  const root = await realpath3(request.root);
  const result = { ...request, root, project: await realpath3(request.project), file: await realpath3(request.file) };
  if (request.operation === "move-file" || request.operation === "port-route") {
    if (request.only)
      result.only = [...request.only].sort();
    if (request.exclude)
      result.exclude = [...new Set(request.exclude)].sort();
    if (request.map)
      result.map = Object.fromEntries(Object.entries(request.map).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }
  if (request.files) {
    if (request.operation !== "inline-reexports" || !request.files.length)
      throw new Error("INVALID_REQUEST: files requires inline-reexports");
    result.files = [...new Set(await Promise.all(request.files.map((file) => realpath3(file))))].sort();
    for (const file of result.files)
      await assertRegularPath(root, file);
    result.file = result.files[0];
  }
  if (request.moves) {
    if (request.operation !== "move-file" || !request.moves.length)
      throw new Error("INVALID_REQUEST: moves requires move-file pairs");
    result.moves = [];
    for (const move of request.moves) {
      const file = await realpath3(move.file), target = inside(root, await canonicalMissing(move.target));
      const directory = (await lstat3(file)).isDirectory();
      await assertRegularPath(root, file, false, directory);
      await assertRegularPath(root, target, true, directory);
      result.moves.push({ file, target });
    }
    result.moves.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.target < b.target ? -1 : 1);
    result.file = result.moves[0].file;
    result.target = result.moves[0].target;
  }
  await assertRegularPath(root, result.project);
  const directory = request.operation === "move-file" && (await lstat3(result.file)).isDirectory() || request.operation === "retarget-import" || request.operation === "port-route";
  if (request.operation === "port-route") {
    if (!(await lstat3(result.file)).isDirectory())
      throw new Error(`INVALID_REQUEST: port-route requires a Next route directory: ${result.file}`);
    if (request.config === undefined)
      throw new Error("INVALID_REQUEST: port-route requires a configuration path");
    result.config = await realpath3(request.config).catch((error) => {
      if (error.code === "ENOENT")
        throw new Error(`PORT_ROUTE_CONFIG_NOT_FOUND: ${request.config}; copy examples/port-route/uber-platform/port-route.json to <root>/.refactor-ai/ and adapt it, or pass --config`);
      throw error;
    });
    const configRelative = relative2(root, result.config);
    if (!configRelative || configRelative.startsWith("..") || isAbsolute2(configRelative) || !(await lstat3(result.config)).isFile())
      throw new Error(`INVALID_REQUEST: port-route configuration must be a file inside ${root}: ${result.config}`);
    if (request.startRoutes !== undefined) {
      result.startRoutes = await realpath3(request.startRoutes);
      await assertRegularPath(root, result.startRoutes, false, true);
    }
  }
  await assertRegularPath(root, result.file, false, directory);
  if (request.targetProject !== undefined) {
    result.targetProject = await realpath3(request.targetProject);
    await assertRegularPath(root, result.targetProject);
  }
  if (result.target !== undefined) {
    result.target = inside(root, await canonicalMissing(result.target));
    await assertRegularPath(root, result.target, true, directory);
  }
  return result;
}
async function createPlan(request, analyze, compilerBase) {
  request = await canonicalRequest(request);
  const root = request.root;
  const before = await snapshot(root);
  const result = await analyze(request);
  const after = result.readSet || !result.changes.length ? before : await snapshot(root);
  if (result.changes.length && result.readSet)
    await assertReadSetFresh(result.readSet, compilerBase);
  if (result.changes.length && !result.readSet && after.hash !== before.hash)
    throw new Error(`STALE_SNAPSHOT: project changed during analysis: ${snapshotChanges(before, after)}; retry after writers settle (including dev-server generators)`);
  const seen = new Set;
  const changes = [];
  for (const change of result.changes) {
    const kind = changeKind(change);
    const path = inside(root, kind === "create" ? await canonicalMissing(change.path) : await realpath3(change.path));
    if (seen.has(path))
      throw new Error(`DUPLICATE_CHANGE: ${path}`);
    seen.add(path);
    if (kind === "create") {
      if (before.files[relative2(root, path)] !== undefined)
        throw new Error(`TARGET_EXISTS: ${path}`);
    } else {
      await assertRegularPath(root, path);
      if (sha256(Buffer.from(change.before)) !== before.files[relative2(root, path)])
        throw new Error(`BEFORE_MISMATCH: ${path}`);
    }
    if (change.before !== change.after)
      changes.push({ path, before: change.before, after: change.after });
  }
  const deleted = new Set;
  for (const change of changes)
    if (change.after === null)
      deleted.add(fileId(await lstat3(change.path)));
  for (const change of changes) {
    if (change.before !== null)
      continue;
    await assertRegularPath(root, change.path, true);
    const existing = await lstat3(change.path).catch((error) => {
      if (error.code === "ENOENT")
        return null;
      throw error;
    });
    if (existing && !deleted.has(fileId(existing)))
      throw new Error(`TARGET_EXISTS: ${change.path}`);
  }
  changes.sort(byPath);
  const fileModes = {};
  const createdMode = ["move-type", "rename-file"].includes(request.operation) ? (await lstat3(request.file)).mode & 511 : request.operation === "port-route" ? ((await lstat3(resolve3(request.file, "page.tsx")).catch(() => {
    return;
  }))?.mode ?? 420) & 511 : 384;
  const creationMode = async (path) => {
    if (request.operation === "port-route" && request.target && (path === request.target || path.startsWith(request.target + sep2))) {
      const source = resolve3(request.file, relative2(request.target, path));
      return changes.some((change) => change.path === source && change.after === null) ? (await lstat3(source)).mode & 511 : createdMode;
    }
    if (request.operation === "port-route")
      return createdMode;
    if (request.operation !== "move-file" || !request.target)
      return createdMode;
    const pair = request.moves?.find((move) => path === move.target || path.startsWith(move.target + sep2));
    const moveFile = pair?.file ?? request.file, moveTarget = pair?.target ?? request.target;
    const directory = (await lstat3(moveFile)).isDirectory();
    if (!directory && path !== moveTarget)
      return createdMode;
    const source = directory ? resolve3(moveFile, relative2(moveTarget, path)) : moveFile;
    if (!changes.some((change) => change.path === source && change.after === null))
      return 384;
    return (await lstat3(source)).mode & 511;
  };
  for (const change of changes) {
    const beforeMode = change.before === null ? null : (await lstat3(change.path)).mode & 511;
    fileModes[change.path] = { before: beforeMode, after: change.after === null ? null : beforeMode ?? await creationMode(change.path) };
  }
  const conflict = caseConflict(root, before.files, changes);
  if (conflict)
    throw new Error(`CASE_CONFLICT: ${conflict} differs only by case from another path`);
  const added = newDiagnostics(result.diagnosticsBefore, result.diagnosticsAfter);
  const files = Object.fromEntries(changes.filter((change) => change.before !== null).map((change) => [relative2(root, change.path), before.files[relative2(root, change.path)]]));
  const plannedSnapshot = result.readSet ? { files, hash: sha256(JSON.stringify(files)) } : before;
  const body = {
    ...result.readSet ? { readSet: JSON.parse(JSON.stringify(result.readSet)) } : {},
    schemaVersion: result.readSet ? 3 : changes.some((c) => c.before === null || c.after === null) ? 2 : 1,
    request,
    backend: result.backend,
    backendVersion: result.version,
    snapshot: plannedSnapshot,
    changes,
    fileModes,
    ...result.checker ? { checker: { ...result.checker } } : {},
    validation: { status: added.length ? "failed" : "passed", newDiagnostics: added },
    diagnosticsBefore: result.diagnosticsBefore,
    diagnosticsAfter: result.diagnosticsAfter,
    notes: result.notes
  };
  return { ...body, id: planId(body) };
}
async function loadPlan(path) {
  let plan;
  try {
    plan = JSON.parse(await readFile3(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("INVALID_PLAN: plan is not valid JSON");
    throw error;
  }
  assertPlanShape(plan);
  return plan;
}
async function assertFresh(plan, compilerBase) {
  if (plan.id !== planId(plan))
    throw new Error("INVALID_PLAN: plan integrity check failed");
  if (await realpath3(plan.request.root) !== plan.request.root)
    throw new Error("INVALID_PLAN: noncanonical root");
  if (!plan.changes.length)
    return;
  if (plan.readSet) {
    for (const change of plan.changes) {
      await assertRegularPath(plan.request.root, change.path, change.before === null).catch((error) => {
        if (error.code === "ENOENT")
          throw new Error(`STALE_SNAPSHOT: removed ${change.path}`);
        throw error;
      });
      const text = await readFile3(change.path).catch((error) => {
        if (error.code === "ENOENT")
          return null;
        throw error;
      });
      if (text === null ? change.before !== null : change.before === null || sha256(text) !== sha256(change.before))
        throw new Error(`STALE_SNAPSHOT: changed ${change.path}`);
    }
  }
  if (plan.readSet)
    await assertReadSetFresh(plan.readSet, compilerBase);
  if (plan.readSet && plan.changes.some((change) => change.before === null)) {
    const conflict = caseConflict(plan.request.root, (await snapshot(plan.request.root)).files, plan.changes);
    if (conflict)
      throw new Error(`STALE_SNAPSHOT: case-insensitive path collision: ${conflict}`);
  }
  const current = plan.readSet ? plan.snapshot : await snapshot(plan.request.root);
  if (current.hash !== plan.snapshot.hash)
    throw new Error(`STALE_SNAPSHOT: project changed: ${snapshotChanges(plan.snapshot, current)}; create a new plan after writers settle`);
  for (const [path, modes] of Object.entries(plan.fileModes ?? {})) {
    if (modes.before !== null && ((await lstat3(path)).mode & 511) !== modes.before) {
      throw new Error(`STALE_SNAPSHOT: file permissions changed; create a new plan: ${path}`);
    }
  }
}
function preview(plan) {
  return plan.changes.map((change) => {
    const name = relative2(plan.request.root, change.path);
    return createTwoFilesPatch(change.before === null ? "/dev/null" : `a/${name}`, change.after === null ? "/dev/null" : `b/${name}`, change.before ?? "", change.after ?? "", "", "", { context: 3 });
  }).join(`
`);
}
var fileId = (stat) => `${stat.dev}:${stat.ino}`;
var init_plan = __esm(() => {
  init_read_set();
  init_libesm();
  init_snapshot();
});

// src/core/apply.ts
import { lstat as lstat4, mkdir as mkdir2, open as open2, readFile as readFile4, rename, rm, rmdir, stat, unlink, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname3, resolve as resolve4, sep as sep3 } from "node:path";
import { randomUUID } from "node:crypto";
async function readOrNull(path) {
  return readFile4(path).catch((error) => {
    if (error.code === "ENOENT")
      return null;
    throw error;
  });
}
async function atomicWrite(path, content, mode, expectedContent) {
  const temporary = resolve4(dirname3(path), `.refactor-write-${randomUUID()}`);
  try {
    const handle = await open2(temporary, "wx", 384);
    try {
      await handle.writeFile(content, "utf8");
      if (mode !== undefined)
        await handle.chmod(mode & 511);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (expectedContent !== undefined && !sameContent(await readOrNull(path), expectedContent)) {
      throw new Error(`STALE_SNAPSHOT: ${path} changed while staging the write`);
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function ensureDirectories(root, file, created) {
  for (const directory of await missingDirectories(root, file)) {
    try {
      await mkdir2(directory);
      created.push(directory);
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
      const existing = await lstat4(directory);
      if (existing.isSymbolicLink() || !existing.isDirectory())
        throw new Error(`NOT_A_DIRECTORY: ${directory}`);
    }
  }
}
async function order(plan) {
  const steps = plan.changes.map((change) => ({ change, kind: changeKind(change) }));
  const deleted = new Set;
  for (const step of steps)
    if (step.kind === "delete")
      deleted.add(fileId2(await lstat4(step.change.path)));
  const aliases = new Set;
  for (const step of steps) {
    if (step.kind !== "create")
      continue;
    const existing = await lstat4(step.change.path).catch((error) => {
      if (error.code === "ENOENT")
        return null;
      throw error;
    });
    if (!existing)
      continue;
    if (!deleted.has(fileId2(existing)))
      throw new Error(`STALE_SNAPSHOT: ${step.change.path} already exists`);
    aliases.add(step.change);
  }
  const rank = (step) => step.kind === "create" ? aliases.has(step.change) ? 3 : 0 : step.kind === "edit" ? 1 : 2;
  return steps.toSorted((a, b) => rank(a) - rank(b));
}
async function pruneMoveDirectories(plan) {
  if (!["move-file", "move-type", "rename-file", "port-route"].includes(plan.request.operation))
    return;
  const root = plan.request.root, projectDirectory = dirname3(plan.request.project);
  const directories = new Set;
  for (const change of plan.changes.filter((change) => change.after === null)) {
    for (let directory = dirname3(change.path);directory !== root && directory !== projectDirectory && directory.startsWith(root + sep3); directory = dirname3(directory))
      directories.add(directory);
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length))
    await rmdir(directory).catch(() => {});
}
async function applyPlan(plan, compilerBase) {
  assertPlanShape(plan);
  if (plan.validation.status !== "passed" || newDiagnostics(plan.diagnosticsBefore, plan.diagnosticsAfter).length) {
    throw new Error("VALIDATION_FAILED: plan adds compiler errors");
  }
  const root = plan.request.root;
  const stateDirectory = resolve4(root, ".refactor-ai");
  await mkdir2(stateDirectory, { recursive: true });
  if ((await lstat4(stateDirectory)).isSymbolicLink())
    throw new Error("SYMLINK_UNSUPPORTED: state directory");
  await ignoreStateDirectory(stateDirectory);
  const lock = resolve4(stateDirectory, "apply.lock");
  try {
    await mkdir2(lock);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error("APPLY_LOCKED: another apply or interrupted transaction; inspect .refactor-ai/apply.lock");
    throw error;
  }
  const journalPath = resolve4(stateDirectory, `${plan.id}.journal.json`);
  const written = [];
  const createdDirectories = [];
  const journal = {
    schemaVersion: 2,
    planId: plan.id,
    status: "writing",
    changes: plan.changes.map((c) => ({
      path: c.path,
      kind: changeKind(c),
      before: c.before,
      afterHash: c.after === null ? null : sha256(c.after),
      ...plan.fileModes?.[c.path] ? { beforeMode: plan.fileModes[c.path].before, afterMode: plan.fileModes[c.path].after } : {}
    })),
    createdDirectories
  };
  const saveJournal = () => atomicWrite(journalPath, JSON.stringify(journal, null, 2) + `
`);
  try {
    await assertFresh(plan, compilerBase);
    if (!plan.changes.length)
      return { status: "applied", files: [], journal: null };
    const steps = await order(plan);
    const sourceMode = (await stat(plan.request.file)).mode & 511;
    for (const step of steps) {
      const record = journal.changes.find((item) => item.path === step.change.path);
      record.beforeMode = step.kind === "create" ? null : (await stat(step.change.path)).mode & 511;
      record.afterMode = step.kind === "delete" ? null : plan.fileModes?.[step.change.path]?.after ?? record.beforeMode ?? (["move-type", "rename-file"].includes(plan.request.operation) ? sourceMode : 384);
    }
    await saveJournal();
    for (const step of steps) {
      const { change, kind } = step;
      if (kind === "create") {
        const before = createdDirectories.length;
        await ensureDirectories(root, change.path, createdDirectories);
        if (createdDirectories.length !== before)
          await saveJournal();
      }
      await assertRegularPath(root, change.path, kind === "create");
      const current = await readOrNull(change.path);
      if (!sameContent(current, change.before))
        throw new Error(`STALE_SNAPSHOT: ${change.path} changed during apply`);
      const mode = current === null ? undefined : (await stat(change.path)).mode & 511;
      const record = journal.changes.find((item) => item.path === change.path);
      if (mode !== undefined && mode !== record.beforeMode)
        throw new Error(`STALE_SNAPSHOT: permissions changed during apply: ${change.path}`);
      if (kind === "delete")
        await unlink(change.path);
      else
        await atomicWrite(change.path, change.after, record.afterMode ?? undefined, change.before);
      written.push({ ...step, mode });
    }
    journal.status = "applied";
    await saveJournal();
    await pruneMoveDirectories(plan);
    return { status: "applied", files: written.map((s) => s.change.path), journal: journalPath };
  } catch (error) {
    let recoveryNeeded = false;
    for (const { change, kind, mode } of written.toReversed()) {
      try {
        await assertRegularPath(root, change.path, true);
        const current = await readOrNull(change.path);
        if (kind === "delete") {
          if (current === null)
            await atomicWrite(change.path, change.before, mode, null);
          else if (!sameContent(current, change.before))
            recoveryNeeded = true;
        } else if (!sameContent(current, change.after)) {
          if (!(kind === "create" && current === null))
            recoveryNeeded = true;
        } else if (kind === "create")
          await unlink(change.path);
        else
          await atomicWrite(change.path, change.before, mode, change.after);
      } catch {
        recoveryNeeded = true;
      }
    }
    for (const directory of createdDirectories.toReversed()) {
      await rmdir(directory).catch(() => {});
    }
    if (written.length || createdDirectories.length) {
      journal.status = recoveryNeeded ? "recovery-needed" : "rolled-back";
      await writeFile2(journalPath, JSON.stringify(journal, null, 2) + `
`).catch(() => {});
    }
    if (recoveryNeeded)
      throw new Error(`RECOVERY_NEEDED: inspect ${journalPath}; ${String(error)}`);
    throw error;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
var sameContent = (current, expected) => expected === null ? current === null : current !== null && sha256(current) === sha256(expected), fileId2 = (s) => `${s.dev}:${s.ino}`;
var init_apply = __esm(() => {
  init_plan();
  init_snapshot();
});

// src/languages.ts
import { extname } from "node:path";
function languageForProject(project) {
  const extension = extname(project).toLowerCase();
  if (extension === ".csproj" || extension === ".sln")
    return "csharp";
  if (extension === ".json")
    return "typescript";
  throw new Error("UNSUPPORTED_PROJECT: use tsconfig/jsconfig.json, .csproj or .sln");
}
var languageOperations;
var init_languages = __esm(() => {
  languageOperations = {
    typescript: ["rename", "imports", "format", "extract-function", "extract-variable", "rename-file", "move-type", "move-file", "inline-reexports", "retarget-import", "port-route"],
    csharp: ["rename", "imports", "format", "rename-file", "sync-namespace", "move-type"]
  };
});

// src/core/repo-config.ts
import { lstat as lstat5, readFile as readFile5 } from "node:fs/promises";
import { resolve as resolve5 } from "node:path";
async function readRepoConfig(root) {
  const path = resolve5(root, ".refactor-ai/config.json");
  const stat = await lstat5(path).catch((error) => {
    if (["ENOENT", "ENOTDIR"].includes(error.code ?? ""))
      return;
    throw error;
  });
  if (!stat)
    return {};
  if (!stat.isFile())
    throw new Error(`INVALID_REPO_CONFIG: ${path} must be a regular file`);
  let config;
  try {
    config = JSON.parse(await readFile5(path, "utf8"));
  } catch {
    throw new Error(`INVALID_REPO_CONFIG: ${path} is not valid JSON`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error(`INVALID_REPO_CONFIG: ${path} must contain an object`);
  for (const [key, value] of Object.entries(config)) {
    const values = Object.hasOwn(allowed, key) ? allowed[key] : undefined;
    if (!values)
      throw new Error(`INVALID_REPO_CONFIG: ${path}: unknown key '${key}'; supported: verify, checker`);
    if (typeof value !== "string" || !values.includes(value))
      throw new Error(`INVALID_REPO_CONFIG: ${path}: ${key} must be ${values.join("|")}`);
  }
  return config;
}
var allowed;
var init_repo_config = __esm(() => {
  allowed = { verify: ["full", "bindings"], checker: ["ts5", "ts7", "both"] };
});

// src/api.ts
import { readFile as readFile6, realpath as realpath4 } from "node:fs/promises";
import { dirname as dirname4, resolve as resolve6 } from "node:path";
function offset(text, point) {
  const match = /^(\d+):(\d+)$/.exec(point);
  if (!match)
    throw new Error(`INVALID_POSITION: ${point}`);
  const line = Number(match[1]), column = Number(match[2]);
  const lines = text.split(`
`);
  if (line < 1 || line > lines.length || column < 1 || column > lines[line - 1].replace(/\r$/, "").length + 1) {
    throw new Error(`INVALID_POSITION: ${point}`);
  }
  return lines.slice(0, line - 1).reduce((total, item) => total + item.length + 1, 0) + column - 1;
}
function createRefactorApi(context) {
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("UNSUPPORTED_RUNTIME: Node.js 22+ is required");
  function assertLanguage(project, backend) {
    if (context.language && (languageForProject(project) !== context.language || backend !== undefined && backend !== (context.language === "typescript" ? "typescript" : "roslyn"))) {
      throw new Error(`UNSUPPORTED_LANGUAGE: this tool only supports ${context.language === "typescript" ? "TypeScript/JavaScript" : "C#"}`);
    }
  }
  function checkPlan(plan) {
    assertPlanShape(plan);
    assertLanguage(plan.request.project, plan.backend);
  }
  const compilerBase = context.toolkitRoot ? resolve6(context.toolkitRoot, "runtime/package.json") : undefined;
  return {
    async plan(options) {
      const { project, request } = await resolveRequest();
      const engine = await context.loadBackend(project, context.toolkitRoot);
      return createPlan(request, engine.analyze, compilerBase);
      async function resolveRequest() {
        const operation = options.operation ?? context.operation;
        if (!operation || !Object.values(languageOperations).some((items) => items.includes(operation)))
          throw new Error(`UNSUPPORTED: ${operation}`);
        if (context.operation && operation !== context.operation)
          throw new Error(`UNSUPPORTED: this tool only supports ${context.operation}`);
        assertLanguage(options.project);
        if (options.checker !== undefined && (!["ts5", "ts7", "both"].includes(options.checker) || languageForProject(options.project) !== "typescript"))
          throw new Error("INVALID_ARGUMENT: checker ts5|ts7|both requires TypeScript/JavaScript");
        if ((options.symbol !== undefined || options.public !== undefined) && (operation !== "rename" || languageForProject(options.project) !== "typescript"))
          throw new Error("INVALID_ARGUMENT: symbol and public require TypeScript/JavaScript rename");
        if (options.symbol !== undefined && (typeof options.symbol !== "string" || !options.symbol || options.at !== undefined))
          throw new Error("INVALID_ARGUMENT: symbol selects one declaration instead of at");
        if (options.public !== undefined && typeof options.public !== "boolean")
          throw new Error("INVALID_ARGUMENT: public must be a boolean");
        if (options.verify !== undefined && !["full", "bindings"].includes(options.verify))
          throw new Error("INVALID_ARGUMENT: verify full|bindings");
        if (options.verify === "bindings" && languageForProject(options.project) !== "typescript")
          throw new Error("INVALID_ARGUMENT: verify bindings requires TypeScript/JavaScript");
        if (options.verify === "bindings" && options.checker !== undefined)
          throw new Error("INVALID_ARGUMENT: checker selects program diagnostics, which verify bindings does not compute");
        if (options.targetProject)
          assertLanguage(options.targetProject);
        if (options.mode !== undefined && !["sort", "remove-unused"].includes(options.mode))
          throw new Error("INVALID_ARGUMENT: mode sort|remove-unused");
        if (["move-type", "move-file", "port-route"].includes(operation) && !options.target && !options.moves?.length)
          throw new Error(`INVALID_ARGUMENT: target required for ${operation}`);
        if ((options.target !== undefined || options.targetProject !== undefined) && !["move-type", "move-file", "port-route"].includes(operation)) {
          throw new Error("INVALID_ARGUMENT: target and targetProject require move-type, move-file or port-route");
        }
        if (operation === "port-route" && (!options.targetProject || options.moves || options.only || options.mocks !== undefined)) {
          throw new Error("INVALID_ARGUMENT: port-route requires --route, --to and --target-project; moves, only and mocks are unsupported");
        }
        if ((options.startRoutes !== undefined || options.config !== undefined) && operation !== "port-route")
          throw new Error("INVALID_ARGUMENT: startRoutes and config require port-route");
        if (options.keep !== undefined && (operation !== "inline-reexports" || typeof options.keep !== "boolean"))
          throw new Error("INVALID_ARGUMENT: keep requires inline-reexports and a boolean");
        if (operation === "retarget-import" && (!options.from || !options.to))
          throw new Error("INVALID_ARGUMENT: from and to required for retarget-import");
        if (operation !== "retarget-import" && [options.from, options.to].some((value) => value !== undefined)) {
          throw new Error("INVALID_ARGUMENT: from and to require retarget-import");
        }
        if (!["retarget-import", "move-file", "port-route"].includes(operation) && [options.map, options.only].some((value) => value !== undefined))
          throw new Error("INVALID_ARGUMENT: map and only require retarget-import, move-file or port-route");
        if (operation === "move-file" && languageForProject(options.project) !== "typescript" && (options.map || options.only))
          throw new Error("INVALID_ARGUMENT: move-file mappings require TypeScript/JavaScript");
        if (options.mocks !== undefined && (!["retarget-import", "move-file"].includes(operation) || languageForProject(options.project) !== "typescript"))
          throw new Error("INVALID_ARGUMENT: mocks requires TypeScript retarget-import or move-file");
        if (options.mocks !== undefined && !["report", "add"].includes(options.mocks))
          throw new Error("INVALID_ARGUMENT: mocks report|add");
        if (options.exclude !== undefined && (!["move-file", "port-route"].includes(operation) || languageForProject(options.project) !== "typescript" || options.only || !Array.isArray(options.exclude) || options.exclude.some((pattern) => typeof pattern !== "string" || !pattern || pattern.startsWith("!") || /^(?:[A-Za-z]:|[\\/])/.test(pattern) || pattern.split(/[\\/]/).includes("..")))) {
          throw new Error("INVALID_ARGUMENT: exclude requires relative move-file directory globs without --only");
        }
        if (options.moves !== undefined && (operation !== "move-file" || languageForProject(options.project) !== "typescript" || !Array.isArray(options.moves) || !options.moves.length || options.file !== undefined || options.target !== undefined || options.moves.some((move) => !move || typeof move.file !== "string" || !move.file || typeof move.target !== "string" || !move.target))) {
          throw new Error("INVALID_ARGUMENT: moves requires TypeScript move-file pairs, without file/target");
        }
        if (options.files !== undefined && (operation !== "inline-reexports" || !Array.isArray(options.files) || !options.files.length || options.file !== undefined || options.files.some((file) => typeof file !== "string" || !file)))
          throw new Error("INVALID_ARGUMENT: files requires an inline-reexports batch without file");
        if (!options.file && !options.files?.length && !options.moves?.length && operation !== "retarget-import")
          throw new Error("INVALID_ARGUMENT: file required");
        const project = await realpath4(resolve6(options.project));
        const file = await realpath4(resolve6(options.file ?? options.files?.[0] ?? options.moves?.[0]?.file ?? dirname4(project)));
        const root = await realpath4(resolve6(options.root ?? dirname4(project)));
        const defaults = languageForProject(options.project) === "typescript" ? await readRepoConfig(root) : {};
        const verify = options.verify ?? defaults.verify ?? "full";
        const checker = options.checker ?? (verify === "full" ? defaults.checker : undefined);
        const text = operation !== "retarget-import" && (options.at !== undefined || options.end !== undefined) ? await readFile6(file, "utf8") : "";
        const position = (point) => {
          if (typeof point === "string")
            return offset(text, point);
          if (!Number.isInteger(point) || point < 0 || point > text.length)
            throw new Error(`INVALID_POSITION: ${point}`);
          return point;
        };
        const request = {
          project,
          root,
          file,
          operation,
          ...options.files ? { files: options.files.map((file) => resolve6(file)) } : {},
          ...options.moves ? { moves: options.moves.map((move) => ({ file: resolve6(move.file), target: resolve6(move.target) })), target: resolve6(options.moves[0].target) } : {},
          ...options.exclude ? { exclude: [...new Set(options.exclude)].sort() } : {},
          ...checker !== undefined ? { checker } : {},
          ...verify === "bindings" ? { verify } : {},
          ...options.keep !== undefined ? { keep: options.keep } : {},
          ...operation === "move-file" ? { ...options.mocks ? { mocks: options.mocks } : {}, ...options.map ? { map: options.map } : {}, ...options.only ? { only: options.only } : {} } : {},
          ...operation === "port-route" ? {
            ...options.map ? { map: options.map } : {},
            ...options.startRoutes !== undefined ? { startRoutes: resolve6(options.startRoutes) } : {},
            config: resolve6(options.config ?? resolve6(root, ".refactor-ai/port-route.json"))
          } : {},
          ...operation === "retarget-import" ? {
            from: options.from,
            to: options.to,
            ...options.map ? { map: options.map } : {},
            ...options.only ? { only: options.only } : {},
            ...options.mocks !== undefined ? { mocks: options.mocks } : {},
            ...!options.file ? { projectScope: true } : {}
          } : {},
          ...options.symbol !== undefined ? { symbol: options.symbol } : {},
          ...options.public !== undefined ? { public: options.public } : {},
          ...options.at !== undefined ? { position: position(options.at) } : {},
          ...options.end !== undefined ? { end: position(options.end) } : {},
          ...options.name !== undefined ? { newName: options.name } : {},
          ...operation === "imports" ? { mode: options.mode ?? (context.language === "csharp" ? "remove-unused" : "sort") } : {},
          ...options.target !== undefined ? { target: resolve6(options.target) } : {},
          ...options.targetProject !== undefined ? { targetProject: await realpath4(resolve6(options.targetProject)) } : {},
          ...options.typeName !== undefined ? { typeName: options.typeName } : {},
          ...options.rootNamespace !== undefined ? { rootNamespace: options.rootNamespace } : {}
        };
        return { project, request };
      }
    },
    preview(plan) {
      checkPlan(plan);
      return preview(plan);
    },
    async validate(plan) {
      checkPlan(plan);
      await assertFresh(plan, compilerBase);
      return { status: plan.validation.status === "passed" ? "validated" : "failed", validation: plan.validation, id: plan.id, verify: plan.request.verify ?? "full" };
    },
    async apply(plan) {
      checkPlan(plan);
      const result = await applyPlan(plan, compilerBase);
      return plan.request.verify === "bindings" ? { ...result, verify: "bindings", next: bindingsReminder } : result;
    },
    async loadPlan(path) {
      const plan = await loadPlan(resolve6(path));
      checkPlan(plan);
      return plan;
    },
    async capabilities(project) {
      assertLanguage(project);
      const engine = await context.loadBackend(await realpath4(resolve6(project)), context.toolkitRoot);
      return engine.capabilities.filter((item) => !context.operation || item.operation === context.operation).map((item) => ({ ...item, ...item.modes ? { modes: [...item.modes] } : {} }));
    }
  };
}
var bindingsReminder = "Plan verified bindings only (--verify bindings): program diagnostics were not computed. Run the project's typecheck (e.g. tsc --noEmit / tsgo, or the repo's check-types) before committing.";
var init_api = __esm(() => {
  init_apply();
  init_plan();
  init_languages();
  init_repo_config();
});

// src/help.ts
function operationHelpFor(operation, language) {
  const item = operationHelp[operation];
  if (!language)
    return item;
  return {
    ...item,
    ...languageDetails[language][operation],
    support: language === "typescript" ? "TypeScript and JavaScript" : "C#",
    examples: item.examples.filter((example) => language === "csharp" ? /--project \S+\.(csproj|sln)(?: |$)/.test(example) : /--project \S+\.json(?: |$)/.test(example))
  };
}
function optionsText(language) {
  const project = language === "typescript" ? "tsconfig.json or jsconfig.json" : language === "csharp" ? ".csproj or .sln" : "tsconfig.json, jsconfig.json, .csproj or .sln";
  return `  --project <config>       Required for capabilities and plan; ${project}.
${language !== "csharp" ? `                           Named TS configurations are supported by file/type operations.
` : ""}  --file <source>          Required for plan except retarget-import; a file, or a directory for move-file/retarget-import.
                           move-file accepts repeated --file source=destination pairs; inline-reexports accepts repeated files.
  --keep                   Retain the shim for inline-reexports.
${language !== "csharp" ? `  --checker <ts5|ts7|both> TS5 default; ts7 uses installed Go 7.0.2 diagnostics.
                           both audits TS5+TS7, rejecting any disagreement.
  --verify <full|bindings> full (default) checks program diagnostics; bindings checks
                           edits, references and import bindings only (typecheck after
                           apply). Defaults: <root>/.refactor-ai/config.json.
` : ""}  --root <directory>       Boundary for source, configs and callers; defaults to
                           the project configuration's directory.
  --at <line:column>       Symbol/type position or extraction start, 1-based UTF-16.
${language !== "csharp" ? `  --symbol <name>          TS/JS rename: top-level declaration instead of --at.
  --public                 TS/JS rename: propagate unaliased public export names.
` : ""}  --end <line:column>      Extraction end, exclusive, 1-based UTF-16.
  --name <identifier>      Required new name for rename and extraction.
  --mode <mode>            imports: ${language === "csharp" ? "remove-unused (default); sorting is unsupported" : "sort (default) or remove-unused"}.
  --type <identifier>      Declared type for rename-file or move-type; select when
                           several types exist, or use --at.
  --to <path|specifier>    Destination for move-type/move-file (path) or retarget-import (specifier).
  --from <specifier>       Source module specifier for retarget-import.
  --map <from=to>          Repeatable export mapping (retarget-import), module or module#Export mapping (move-file).
  --only <Name,Name>       retarget-import: pre-map export names; move-file: declarations to move.
  --exclude <glob>         Repeatable directory move exclusions, relative to each source directory.
  --mocks <report|add>     Report affected test mocks (default), or add parallel mocks.
  --target-project <config> Destination project config; move-type, move-file or port-route.
${language !== "csharp" ? `  --route <directory>      port-route: Next App Router route directory (instead of --file).
  --start-routes <dir>     port-route: TanStack Start routes directory override.
  --config <json>          port-route: configuration, default <root>/.refactor-ai/port-route.json.
` : ""}${language !== "typescript" ? `  --root-namespace <name>  C# namespace convention override for sync-namespace
                           or move-type.
` : ""}  --out <plan.json>        Plan output; defaults to <root>/.refactor-ai/<id>.json.
                           Within root, store plans only in .refactor-ai;
                           an output path outside root is also allowed.
  --plan <plan.json>       Required for preview, validate and apply.
  --help, -h              Show general, command or operation help; no project needed.
`;
}
function contextText(language) {
  return `Paths are relative to the current working directory unless absolute. Quote paths
with spaces. Source/config paths must exist; a move destination may be new.
Positions count UTF-16 code units: an emoji occupies two columns. CRLF is supported.
${language !== "csharp" ? `TS/JS rename, imports, format and extract reject project references; file/type
operations validate supported project graphs and affected named configurations.
` : ""}`;
}
function examples(invocation, commands) {
  return commands.map((command) => `  ${invocation} ${command}`).join(`
`);
}
function workflow(invocation) {
  return `Plan workflow:
  Planning computes edits and compiler diagnostics in memory; source files are
  untouched. Read the JSON response's plan path, then use that exact plan:
${examples(invocation, ["preview --plan ./path/to/plan.json", "validate --plan ./path/to/plan.json", "apply --plan ./path/to/plan.json"])}
  Validation checks snapshot freshness and stored compiler analysis; it does not
  run your project's tests. Apply requires passed validation and unchanged recorded inputs. Empty plans apply regardless of unrelated changes.
  Changed sources/configs require replanning. Multi-file writes use a journal and
  attempt rollback on failure; they are not a filesystem-wide atomic transaction.

Output and exit status:
  Status and capabilities: JSON on stdout. Help and preview: text on stdout.
  Errors: JSON on stderr. Exit 0: success (including no-op); exit 1: error or failed
  validation. Plans creating/deleting files use schemaVersion 2; edit-only and
  legacy plans use version 1. After interrupted apply inspect .refactor-ai/apply.lock
  and the .journal.json journal before recovery; preserve subsequent external edits.
`;
}
function operationText(operation, invocation, language) {
  const item = operationHelpFor(operation, language);
  return `${operation}: ${item.description}
  Languages: ${item.support}
  Operation options: ${item.required}
  ${item.details}
Examples (replace custom paths/type names with your project's values):
${examples(invocation, item.examples)}
`;
}
function helpRequested(args) {
  return args.length === 0 || args[0] === "help" || args.includes("--help") || args.includes("-h");
}
function renderHelp(args, invocation = "node dist/cli.js", runtimeRequirements = requirements, language) {
  const topics = args[0] === "help" ? args.slice(1) : args;
  const command = topics[0]?.startsWith("-") ? undefined : topics[0];
  const operation = topics[1]?.startsWith("-") ? undefined : topics[1];
  const known = ["capabilities", "plan", "preview", "validate", "apply", "serve", "gc"];
  if (command && !known.includes(command))
    throw new Error(`INVALID_ARGUMENT: unknown help command ${command}`);
  if (operation && (command !== "plan" || !Object.hasOwn(operationHelp, operation))) {
    throw new Error(`UNSUPPORTED: help topic ${command} ${operation}`);
  }
  if (operation && language && !languageOperations[language].includes(operation))
    throw new Error(`UNSUPPORTED: ${operation} is unavailable for ${language}`);
  const title = `refactor-ai — deterministic ${language === "typescript" ? "TypeScript/JavaScript" : language === "csharp" ? "C#" : "TypeScript/JavaScript and C#"} refactorings
`;
  const options = optionsText(language);
  const context = contextText(language);
  if (["preview", "validate", "apply"].includes(command ?? "")) {
    const descriptions = {
      preview: "Print the stored unified diff, including file creation/deletion. Does not write sources or check snapshot freshness; use validate before apply.",
      validate: "Check the plan's integrity, recorded read set and stored compiler analysis. Does not re-run compilation or project tests. A failed validation returns exit 1.",
      apply: "Apply the exact validated plan to unchanged recorded inputs. Empty plans need no freshness check. Uses a lock and journal; on failure attempts to roll back its own writes. Replan after changes."
    };
    return `${title}
${command}: ${descriptions[command]}

Usage:
  ${invocation} ${command} --plan <plan.json>

Options:
  --plan <plan.json>  Required saved plan path.
  --help, -h         Show this help.

Examples:
${examples(invocation, [`${command} --plan ./.refactor-ai/saved-plan.json`, `${command} --plan "/path with spaces/plan.json"`])}

${workflow(invocation)}`;
  }
  if (command === "gc")
    return `${title}
gc: Remove completed apply journals; retain failed and interrupted transactions.

Usage:
  ${invocation} gc [--root <repo>]

Examples:
  ${invocation} gc --root .
`;
  if (command === "serve") {
    return `${title}
serve (author CLI): Keep TypeScript single-project programs warm between sequential plan requests.

Usage:
  ${invocation} serve --root <repo>

Send one JSON object per stdin line: {"id":1,"args":["plan",<normal plan arguments>]}.
One response per stdout line: {id,status,output} or {id,status,error}. Requests may
only plan within the server root. EOF releases programs and exits. External content,
configuration, resolution probes and directory membership are rechecked before reuse.
Workspace file operations still use fresh workspaces.

Examples:
  ${invocation} serve --root .

REFACTOR_AI_CACHE=on enables the optional persistent baseline cache. Its location defaults to
<root>/.refactor-ai/cache; REFACTOR_AI_CACHE_DIR selects an external directory.
`;
  }
  if (command === "capabilities") {
    return `${title}
capabilities: List implemented operations and modes as JSON for the selected backend.

Usage:
  ${invocation} capabilities --project <config>

Options:
  --project <config>  Required ${language === "typescript" ? "tsconfig.json or jsconfig.json" : language === "csharp" ? ".csproj or .sln" : "tsconfig.json, jsconfig.json, .csproj or .sln"}.
  --help, -h          Show this help.

Examples:
${examples(invocation, ["capabilities --project examples/typescript/tsconfig.json", "capabilities --project examples/javascript/jsconfig.json", "capabilities --project examples/csharp/Caller.csproj"].filter((example) => !language || (language === "csharp" ? example.includes("csharp/") : !example.includes("csharp/"))))}

The configuration must exist. This command reports implemented backend capabilities,
not whether a particular source selection can be refactored. It does not load or
change source files.

${runtimeRequirements}`;
  }
  if (operation) {
    return `${title}
Usage:
  ${invocation} plan ${operation} --project <config> ${operation === "retarget-import" ? "[--file <file|directory>]" : operation === "port-route" ? "--route <directory>" : "--file <source>"} [operation options]

${operationText(operation, invocation, language)}
Options and defaults:
${options}
${context}
${workflow(invocation)}
${runtimeRequirements}`;
  }
  if (!command)
    return `${title}
Commands: capabilities, plan, preview, validate, apply, serve, gc, help.

Operations:
${(language ? languageOperations[language] : Object.keys(operationHelp)).map((key) => `  ${key}`).join(`
`)}

Examples:
  ${invocation} plan <operation> --help
  ${invocation} <command> --help
`;
  const commands = command === "plan" ? `Usage:
  ${invocation} plan <operation> --project <config> --file <source> [options]
` : `Commands:
  capabilities --project <config>       List backend operations and modes (JSON).
  plan <operation> --project <config> --file <source> [options]
                                       Compute a plan without writing sources.
  preview --plan <plan.json>            Print a stored unified diff.
  validate --plan <plan.json>           Check freshness and stored validation.
  apply --plan <plan.json>              Apply the exact plan and journal writes.
  help [command] [operation]            Show help, also available via --help/-h.
`;
  return `${title}
${commands}
Help examples:
${examples(invocation, ["--help", "plan move-type --help", "help plan rename", "apply --help"])}

Options and defaults:
${options}
${context}
Operations:
${(language ? languageOperations[language] : Object.keys(operationHelp)).map((key) => operationText(key, invocation, language)).join(`
`)}
${workflow(invocation)}
${runtimeRequirements}`;
}
var operationHelp, languageDetails, requirements = `Requirements:
  Node.js 22+. Installed skill commands use npm to set up pinned TypeScript 5.9.3
  on first execution; initial setup needs network access and a writable skill
  directory. Help does not install dependencies or load a project.
  C#: .NET 8 SDK (dotnet in PATH), the project's required SDK/workloads and restored
  project dependencies. A skill builds its bundled Roslyn helper on first C# use;
  initial NuGet restore needs network access. Bun is for development builds only.
  Checkout setup: bun install --frozen-lockfile; bun run build:csharp; bun run build.
  Relocated C# runner: set REFACTOR_AI_HOME to the package directory containing
  dotnet/RefactorHelper. Installed skills locate their bundled helper automatically.
`;
var init_help = __esm(() => {
  init_languages();
  operationHelp = {
    "port-route": {
      description: "Port a Next App Router route to TanStack Start in one plan: move its client view, generate the Next adapter and the Start route.",
      support: "TypeScript and JavaScript (Next App Router to TanStack Start, React)",
      required: "--route <next route directory> --to <feature directory> --target-project <config> [--start-routes <directory>] [--config <port-route.json>] [--map <from=to> ...] [--exclude <glob> ...]",
      details: "Reads <root>/.refactor-ai/port-route.json (or --config): Next app directory, exclusions, preload functions, Start project/routes, route-tree generator, module maps, expression translations, ports and templates; project APIs are never built in (see examples/port-route/uber-platform). Client files of the route directory move to --to as one move-file batch with the configured maps; page.tsx, layout/loading/error files, **/_hooks/**, *adapter*, files importing server-only modules and nested route directories stay in Next. The page's default export is analyzed on the original program: const x = await hook(args), await Promise.all([...]) destructuring and direct configured preload calls are traced through hook modules to the Convex function reference and arguments. Arguments translate through configured equivalents (e.g. await searchParams), route parameters of the Start route, package imports, moved modules and the page's own const declarations; anything else (Next-only modules, let/try values, page parameters, functions) becomes a typechecking TODO(port-route) placeholder plus a plan note, never a guess. The page must render exactly one component imported from a moved file; each preloaded prop used as `const { data } = usePreloaded(prop)` or `usePreloaded(prop).data` becomes a data prop (data.prop pattern) typed by the hook's type argument or data.type. The generated Next adapter exports the page's view name, keeps the preloaded props and calls the configured data snippet; page.tsx imports the adapter instead of the view. The Start route file is named from the route's segments (dynamic [x] -> $x, groups dropped, .index when nested routes exist) and renders the view with loader prefetches, loader data and configured ports/params. View props that no page attribute, port or parameter provides become TODO placeholders when required. With start.routeTree the project's TanStack router generator regenerates the ignored route tree in a scratch mirror for validation only; regenerate it after apply. All participating projects, including the Start project, are validated; new diagnostics reject the plan with hints. Catch-all, parallel and private segments, spread or children props, memo/forwardRef views and views using a preloaded prop more than once are rejected. Review TODO notes, server-only logic (auth, redirects, notFound, metadata) and route ownership lists; run application tests and E2E.",
      examples: [
        "plan port-route --project apps/web/tsconfig.json --target-project packages/app-features/tsconfig.json --root . --route 'apps/web/src/app/[locale]/dashboard/properties/[code]/units' --to packages/app-features/src/properties/units --checker ts7 --out /tmp/units.json",
        "plan port-route --project apps/web/tsconfig.json --target-project packages/feature/tsconfig.json --root . --route apps/web/src/app/dashboard/reports --to packages/feature/src/reports --start-routes apps/start/src/routes --config .refactor-ai/port-route.json"
      ]
    },
    "move-file": {
      description: "Move modules atomically, selected declarations, or a directory with exclusions.",
      support: "TypeScript and JavaScript",
      required: "--to <destination> OR repeated --file <source=destination> [--exclude <glob> ...] [--target-project <config>] [--root <directory>]",
      details: "--file accepts a file or directory with --to, or repeated source=destination pairs without --to. A batch loads the workspace once and validates the final graph; mutually importing batch files may move together in any argument order. Directory moves preserve relative layout. Repeat --exclude with tsconfig-style globs relative to each source directory to keep server files/adapters; e.g. page.tsx and **/_hooks/**. File moves retain their extension. Destinations must not collide; target project include/files rules must cover moved sources. Use a --root covering source, destination and callers. TypeScript updates imports; cross-package importers use the destination package's exports and must declare its dependency. Exact exports are appended when needed; packages without exports are rejected. Repeat --map source=destination to retarget moved files’ own imports/re-exports and literal dynamic imports and vi.mock/doMock/importActual calls. Add --map source#Old=destination#New for named exports, preserving local/public names with aliases. Mock factory text stays unchanged: review runtime compatibility. External consumer mocks are reported; --mocks add clones standalone registrations for the mapped module. --only selects exported declarations from one source file and moves only their required imports; unselected declarations stay in the source. Types, functions and safe classes/enums are supported; variable initialization, merged declarations and re-exports require preparation. The r3 mapping-only --only behavior is now available through retarget-import --only before moving. Module maps are simultaneous and scoped to moved files. Root .refactor-ai/equivalents.json supplies default module maps only when the destination declares the alternative; explicit maps win. Compiler checks do not prove runtime compatibility. Aliases between moved files become relative imports; unresolved source-project aliases fail MOVE_IMPORT_UNRESOLVED before program loading; missing destination packages fail MISSING_DEPENDENCY with source versions and install hints. Project membership, references, cycles and new compiler errors are checked. Non-UTF-8 files and symlinks are rejected. Run application tests after moving runtime modules.",
      examples: [
        "plan move-file --project ./tsconfig.json --file ./src/components/button.tsx --to ./src/ui/button.tsx",
        "plan move-file --project ./tsconfig.json --file ./src/a.ts=./src/ui/a.ts --file ./src/b.ts=./src/ui/b.ts",
        "plan move-file --project ./tsconfig.json --file ./src/route --to ./src/ui/route --exclude page.tsx --exclude **/_hooks/**",
        "plan move-file --project ./apps/web/tsconfig.json --root . --file ./apps/web/src/components --to ./packages/feature/src/components --target-project ./packages/feature/tsconfig.json --map @/lib/hooks=@scope/feature/hooks --map next-intl=use-intl --checker ts7"
      ]
    },
    "retarget-import": {
      description: "Retarget imports and re-exports to an API-compatible module.",
      support: "TypeScript and JavaScript",
      required: "--from <specifier> --to <specifier> [--map Old=New ...] [--only Name,Name] [--mocks report|add] [--file <file|directory>]",
      details: "Exact specifiers only; wildcards are rejected. Omit --file for the loaded project. --only selects pre-map export names and splits declarations. Unaliased mapped imports rename local references semantically, including JSX; explicit aliases stay unchanged. Re-export mappings rename the imported export. Compatible named destination imports merge and identical bindings dedupe; type-only modifiers, quotes, directives and comments are retained. Default, namespace, star exports, literal dynamic imports and side-effect imports retarget only without --only; compiler diagnostics validate their compatibility. Targets must resolve from every affected file (TARGET_UNRESOLVED). Missing exports fail NEW_DIAGNOSTICS. No matches succeed with a note. --mocks report (default) lists loaded test files mocking the source while transitively importing retargeted files, including callers outside --file. --mocks add copies each standalone vi/vitest/jest mock/doMock registration for the destination with the same factory text, unless that file already mocks the destination. Expression-valued calls fail UNSUPPORTED_MOCK_CALL in add mode. Project references are unsupported. Verify runtime behavior separately.",
      examples: [
        "plan retarget-import --project apps/web/tsconfig.json --root . --from next-intl --to use-intl --map NextIntlClientProvider=IntlProvider",
        "plan retarget-import --project ./tsconfig.json --from old-lib --to new-lib --only Widget,Options --file ./src/features"
      ]
    },
    rename: {
      description: "Rename a symbol and its semantic references.",
      support: "TypeScript, JavaScript and C#",
      required: "--at <line:column> --name <identifier> (TS/JS: --symbol <name> instead of --at; optional --public)",
      details: "TS/JS --symbol selects one top-level declaration (missing or ambiguous names fail); --public propagates unaliased public names through loaded consumers instead of keeping the old export name. Comments and string literals are excluded. Use a .sln and a common --root for C# callers across projects. External consumers and dynamic references are outside the loaded scope.",
      examples: [
        "plan rename --project examples/typescript/tsconfig.json --file examples/typescript/math.ts --at 1:17 --name sum",
        "plan rename --project examples/javascript/jsconfig.json --file examples/javascript/math.js --at 2:17 --name sum",
        "plan rename --project examples/csharp/Caller.csproj --file examples/csharp/Utility.cs --at 7:23 --name Sum"
      ]
    },
    imports: {
      description: "Sort imports or explicitly remove unused imports / using directives.",
      support: "TS/JS: sort and remove-unused; C#: remove-unused only",
      required: "[--mode <sort|remove-unused>]",
      details: "Default mode: sort. C# requires --mode remove-unused. TS sort retains unused imports. Sorting can change module initialization order; removing an unused value import can remove initialization. Bare side-effect imports are retained.",
      examples: [
        "plan imports --project examples/typescript/tsconfig.json --file examples/typescript/caller.ts --mode sort",
        "plan imports --project examples/javascript/jsconfig.json --file examples/javascript/caller.js --mode remove-unused",
        "plan imports --project examples/csharp/Caller.csproj --file examples/csharp/Utility.cs --mode remove-unused"
      ]
    },
    format: {
      description: "Format a file using the TypeScript or Roslyn formatter.",
      support: "TypeScript, JavaScript and C#",
      required: "No additional required options.",
      details: "TS/JS uses the runner's fixed formatting settings; C# uses Roslyn document options. An already formatted file produces a plan with no changes.",
      examples: [
        "plan format --project examples/typescript/tsconfig.json --file examples/typescript/math.ts",
        "plan format --project examples/csharp/Caller.csproj --file examples/csharp/Utility.cs"
      ]
    },
    "extract-function": {
      description: "Extract selected statements or an expression into a named function.",
      support: "TypeScript and JavaScript; C# extraction is unavailable",
      required: "--at <line:column> --end <line:column> --name <identifier>",
      details: "The end position is exclusive. The TypeScript engine chooses the scope, parameters and returned values; semantic rename assigns the requested name. Invalid ranges and name conflicts are rejected.",
      examples: [
        "plan extract-function --project examples/typescript/tsconfig.json --file examples/typescript/math.ts --at 2:3 --end 2:23 --name sumParts"
      ]
    },
    "extract-variable": {
      description: "Extract an expression into a named constant.",
      support: "TypeScript and JavaScript; C# extraction is unavailable",
      required: "--at <line:column> --end <line:column> --name <identifier>",
      details: "The end position is exclusive. Scope and edits come from the TypeScript refactoring action, followed by semantic rename. Unsupported expressions and name conflicts are rejected.",
      examples: [
        "plan extract-variable --project examples/typescript/tsconfig.json --file examples/typescript/math.ts --at 2:10 --end 2:22 --name total"
      ]
    },
    "inline-reexports": {
      description: "Import re-exported bindings directly from their origin modules.",
      support: "TypeScript and JavaScript",
      required: "[--file <shim> ...] [--keep]",
      details: "Follows compiler-resolved aliases and relative export * chains, stopping at bare/package entries. Splits mixed imports by origin, retaining type modifiers, aliases, quotes and extension conventions. Mixed modules retain all re-exports. Unreferenced pure shims are deleted and config file lists updated unless --keep is supplied. Side-effect imports stay with a note. Namespace imports require a pure single-origin export * shim with no default export at the origin. Literal dynamic imports also retarget pure single-origin star shims with no default export; other dynamic references and import types prevent deletion. Repeat --file to inline several shims with shared callers in one plan. New compiler errors are rejected; run application tests for initialization behavior and external consumers.",
      examples: [
        "plan inline-reexports --project ./tsconfig.json --file ./src/shim.ts",
        "plan inline-reexports --project ./apps/web/tsconfig.json --root . --file ./apps/web/src/shim.ts --keep"
      ]
    },
    "rename-file": {
      description: "Rename a source file to match a selected declared type.",
      support: "TypeScript, JavaScript and C#",
      required: "[--type <identifier> | --at <line:column>]",
      details: "The only top-level type is selected automatically. Select explicitly when several types are declared. The extension is retained and the whole file is renamed; other declarations remain in it. TS/JS import paths and supported project file lists are updated. C# explicit Compile entries are updated. Existing targets and unsupported case-only renames are rejected.",
      examples: [
        "plan rename-file --project ./tsconfig.json --file ./src/Wrong.ts --type Widget",
        "plan rename-file --project ./App.csproj --file ./Models/Wrong.cs --type Widget"
      ]
    },
    "sync-namespace": {
      description: "Align a C# file's namespace with RootNamespace and its project-relative folders.",
      support: "C# only; ES modules have no namespace-to-folder convention",
      required: "[--root-namespace <dotted-name>]",
      details: "Updates the selected file's types and semantic references while retaining other files in their original namespace. Use a .sln for callers across projects. Multiple/nested namespaces, conditional compilation and partial declarations spread across files are rejected.",
      examples: [
        "plan sync-namespace --project ./App.csproj --file ./Models/Widget.cs",
        "plan sync-namespace --project ./Workspace.sln --root . --file ./App/Models/Widget.cs --root-namespace Company.App"
      ]
    },
    "move-type": {
      description: "Move a selected top-level type into another file or project.",
      support: "TypeScript, JavaScript and C#",
      required: "--to <destination-file> [--type <identifier> | --at <line:column>] [--target-project <config>] [--root-namespace <dotted-name>]",
      details: "The only top-level type is selected automatically. Other declarations stay in the source; an empty source may be deleted. Missing destination directories are created during apply. Use a --root covering source, destination and callers. Cross-project moves use --target-project; C# requires a loaded target project (normally through a .sln) and a new destination file. TS/JS source must use ES modules, even when compiled to CommonJS. TS projects need compatible module resolution settings; composite projects require valid references. TS/JS runtime declarations with effectful static initializers, static blocks, decorators, computed members, evaluated base-class expressions or nonconstant enum initializers are rejected (INITIALIZATION_EFFECTS_UNSUPPORTED). Simple identifier base classes are supported when the move introduces no module cycle. Compiler checks do not prove whole-program behavior equivalence; run application tests. C# keeps global using directives in the source project, plans unconditional required ProjectReference edits and follows the destination namespace convention when the source follows its convention, otherwise retaining the custom namespace unless overridden. A cross-project C# move changes assembly identity. Cycles, inaccessible dependencies, unsupported project rules and new compiler errors are rejected.",
      examples: [
        "plan move-type --project ./tsconfig.json --file ./src/types.ts --type Widget --to ./src/models/Widget.ts",
        "plan move-type --project ./Source/tsconfig.json --root . --file ./Source/types.ts --type Widget --to ./Target/Models/Widget.ts --target-project ./Target/tsconfig.json",
        "plan move-type --project ./Workspace.sln --root . --file ./Source/Types.cs --type Widget --to ./Target/Models/Widget.cs --target-project ./Target/Target.csproj"
      ]
    }
  };
  languageDetails = {
    typescript: {
      rename: { details: "Comments and string literals are excluded. References are resolved within the configured project; external consumers and dynamic references are outside the loaded scope." },
      imports: { description: "Sort imports or explicitly remove unused imports.", details: "Default mode: sort. Sorting retains unused imports and can change module initialization order. Removing an unused value import can remove initialization; bare side-effect imports are retained." },
      format: { description: "Format a file with the TypeScript formatter.", details: "Uses the runner's fixed formatting settings. An already formatted file produces a plan with no changes." },
      "rename-file": { details: "The only top-level type is selected automatically; select explicitly when several exist. Renames the whole file and keeps its extension and other declarations. Compiler-resolved imports and supported project file lists are updated. Existing targets and unsupported case-only renames are rejected." },
      "move-type": { details: "Select a top-level type explicitly when several exist. Other declarations stay in the source; an empty source may be deleted. Missing destination directories are created during apply. Use a --root covering source, destination and callers, and --target-project for a cross-project move. Sources must use ES modules; compatible module resolution and valid composite project references are required. Effectful static initializers, static blocks, decorators, computed members, evaluated bases and nonconstant enum initializers are rejected (INITIALIZATION_EFFECTS_UNSUPPORTED). Simple identifier bases are supported if no new module cycle is introduced. Compiler checks do not prove whole-program behavior equivalence; run application tests." }
    },
    csharp: {
      rename: { required: "--at <line:column> --name <identifier>", details: "Comments and string literals are excluded. Use a .sln and a common --root for callers across projects. External consumers and dynamic references are outside the loaded scope." },
      imports: { description: "Remove unused C# using directives identified by Roslyn.", required: "[--mode remove-unused]", details: "The C# package defaults to remove-unused; sorting is unsupported. Uses Roslyn's built-in compiler diagnostics." },
      format: { description: "Format a C# file with the Roslyn Formatter API.", details: "Uses Roslyn document options. An already formatted file produces a plan with no changes." },
      "rename-file": { details: "The only top-level type is selected automatically; select explicitly when several exist. Renames the whole file and keeps its extension and other declarations. Explicit Compile entries are updated. Existing targets and unsupported case-only renames are rejected." },
      "move-type": { details: "Select a top-level type explicitly when several exist. Other declarations stay in the source; an empty source may be deleted. Missing destination directories are created during apply. Use a --root covering source, destination and callers. Cross-project moves require a loaded target project, normally through a .sln, --target-project and a new destination file. Global using directives stay in the source project. Required ProjectReference edits are unconditional. The destination namespace convention is followed when the source follows its convention; custom namespaces are otherwise retained unless overridden. Moving between projects changes assembly identity. Cycles, inaccessible dependencies, unsupported project rules and new compiler errors are rejected. Run application tests after applying." }
    }
  };
});

// src/core/gc.ts
import { lstat as lstat6, mkdir as mkdir3, readFile as readFile7, readdir as readdir2, rm as rm2, unlink as unlink2 } from "node:fs/promises";
import { resolve as resolve7 } from "node:path";
async function collectJournals(root) {
  const directory = resolve7(root, ".refactor-ai");
  const stat = await lstat6(directory).catch((error) => {
    if (error.code === "ENOENT")
      return;
    throw error;
  });
  if (!stat)
    return { status: "collected", files: [] };
  if (stat.isSymbolicLink())
    throw new Error("SYMLINK_UNSUPPORTED: state directory");
  const lock = resolve7(directory, "apply.lock");
  try {
    await mkdir3(lock);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error("APPLY_LOCKED: inspect .refactor-ai/apply.lock before gc");
    throw error;
  }
  const files = [];
  try {
    for (const name of (await readdir2(directory)).sort()) {
      if (!/^[a-f0-9]{64}\.journal\.json$/.test(name))
        continue;
      const path = resolve7(directory, name);
      if (!(await lstat6(path)).isFile())
        continue;
      let journal;
      try {
        journal = JSON.parse(await readFile7(path, "utf8"));
      } catch {
        continue;
      }
      if (journal.schemaVersion !== 2 || journal.status !== "applied" || journal.planId !== name.slice(0, 64) || !Array.isArray(journal.changes))
        continue;
      await unlink2(path);
      files.push(path);
    }
    return { status: "collected", files };
  } finally {
    await rm2(lock, { recursive: true, force: true });
  }
}
var init_gc = () => {};

// src/cli-core.ts
import { lstat as lstat7, mkdir as mkdir4, realpath as realpath5, writeFile as writeFile3 } from "node:fs/promises";
import { basename as basename2, dirname as dirname5, isAbsolute as isAbsolute3, relative as relative3, resolve as resolve8, sep as sep4 } from "node:path";
function parse(args) {
  const command = args.shift() ?? "help";
  const operation = args[0] && !args[0].startsWith("--") ? args.shift() : undefined;
  const flags = {};
  const allowed = new Set(["project", "file", "exclude", "root", "at", "symbol", "end", "name", "mode", "out", "plan", "to", "target-project", "type", "root-namespace", "from", "map", "only", "mocks", "checker", "verify", "route", "start-routes", "config"]);
  const mappings = [];
  const files = [];
  const excludes = [];
  while (args.length) {
    const argument = args.shift();
    const equals = argument.indexOf("=");
    const key = equals < 0 ? argument : argument.slice(0, equals);
    if (["--keep", "--public"].includes(key) && equals < 0 && flags[key.slice(2)] === undefined) {
      flags[key.slice(2)] = "true";
      continue;
    }
    const value = equals < 0 ? args.shift() : argument.slice(equals + 1);
    if (!key.startsWith("--") || !allowed.has(key.slice(2)) || !value || value.startsWith("--") || flags[key.slice(2)] !== undefined) {
      throw new Error(`INVALID_ARGUMENT: ${key}`);
    }
    if (key === "--exclude") {
      excludes.push(value);
      continue;
    }
    if (key === "--file") {
      files.push(value);
      continue;
    }
    if (key === "--map") {
      mappings.push(value);
      continue;
    }
    flags[key.slice(2)] = value;
  }
  if (excludes.length)
    flags.exclude = excludes.join(`
`);
  if (files.length)
    flags.file = files.join(`
`);
  if (mappings.length)
    flags.map = mappings.join(`
`);
  return { command, operation, flags };
}
function parseMap(value) {
  const map = Object.create(null);
  for (const item of value.split(`
`)) {
    const parts = item.split("=");
    if (parts.length !== 2 || !parts[0] || !parts[1] || Object.hasOwn(map, parts[0]))
      throw new Error(`INVALID_ARGUMENT: --map ${item}`);
    map[parts[0]] = parts[1];
  }
  return map;
}
function required(flags, key) {
  if (!flags[key])
    throw new Error(`INVALID_ARGUMENT: --${key} required`);
  return flags[key];
}
async function canonicalDirectory(path) {
  try {
    return await realpath5(path);
  } catch (error) {
    if (error.code !== "ENOENT")
      throw error;
    return resolve8(await canonicalDirectory(dirname5(path)), basename2(path));
  }
}
async function runCli(args, context) {
  return context.runLog === false ? executeCli(args, context) : logRun(args, () => executeCli(args, context));
}
async function executeCli(args, context) {
  const write = context.write ?? ((text) => {
    process.stdout.write(text);
  });
  const log = (value) => context.write ? write(JSON.stringify(value, null, 2) + `
`) : console.log(JSON.stringify(value, null, 2));
  const setExitCode = (code) => {
    updateRun({ exitCode: code, ...code ? { status: "failed", errorCode: "VALIDATION_FAILED" } : {} });
    (context.setExitCode ?? ((value) => {
      process.exitCode = value;
    }))(code);
  };
  if (helpRequested(args)) {
    write(renderHelp(args, context.invocation, undefined, context.language));
    return;
  }
  const { command, operation, flags } = parse([...args]);
  if (command === "gc") {
    log(await collectJournals(await realpath5(resolve8(flags.root ?? process.cwd()))));
    updateRun({ status: "collected" });
    return;
  }
  const api = createRefactorApi(context);
  if (["preview", "validate", "apply"].includes(command)) {
    const plan = await api.loadPlan(required(flags, "plan"));
    updateRun({ root: plan.request.root, planId: plan.id, checker: plan.checker ?? null, status: command === "apply" ? "applied" : command === "validate" ? "validated" : "previewed" });
    if (command === "preview") {
      write(api.preview(plan) || `No changes.
`);
      return;
    }
    if (command === "apply") {
      log(await api.apply(plan));
      return;
    }
    log(await api.validate(plan));
    if (plan.validation.status !== "passed")
      setExitCode(1);
    return;
  }
  if (command === "capabilities") {
    log(await api.capabilities(required(flags, "project")));
    return;
  }
  if (command !== "plan")
    throw new Error(`INVALID_ARGUMENT: unknown command ${command}`);
  const fileArgs = flags.file?.split(`
`) ?? [];
  const paired = operation === "move-file" && fileArgs.some((file) => file.includes("="));
  if (fileArgs.length > 1 && !paired && operation !== "inline-reexports")
    throw new Error("INVALID_ARGUMENT: repeated --file requires move-file source=destination pairs");
  const moves = paired ? fileArgs.map((item) => {
    const parts = item.split("=");
    if (parts.length !== 2 || !parts[0] || !parts[1] || flags.to)
      throw new Error("INVALID_ARGUMENT: use --file source=destination pairs without --to");
    return { file: parts[0], target: parts[1] };
  }) : undefined;
  if (operation === "port-route" && flags.file !== undefined)
    throw new Error("INVALID_ARGUMENT: port-route selects its Next route with --route");
  if (operation !== "port-route" && [flags.route, flags["start-routes"], flags.config].some((value) => value !== undefined))
    throw new Error("INVALID_ARGUMENT: --route, --start-routes and --config require port-route");
  const plan = await api.plan({
    files: operation === "inline-reexports" && fileArgs.length > 1 ? fileArgs : undefined,
    project: required(flags, "project"),
    file: moves || operation === "inline-reexports" && fileArgs.length > 1 ? undefined : operation === "retarget-import" ? flags.file : operation === "port-route" ? required(flags, "route") : required(flags, "file"),
    moves,
    operation,
    startRoutes: flags["start-routes"],
    config: flags.config,
    exclude: flags.exclude?.split(`
`),
    keep: flags.keep === "true" ? true : undefined,
    root: flags.root,
    at: flags.at,
    symbol: flags.symbol,
    public: flags.public === "true" ? true : undefined,
    end: flags.end,
    name: flags.name,
    checker: flags.checker,
    verify: flags.verify,
    mode: flags.mode,
    target: operation === "retarget-import" ? undefined : flags.to,
    from: flags.from,
    to: operation === "retarget-import" ? flags.to : undefined,
    map: flags.map === undefined ? undefined : parseMap(flags.map),
    only: flags.only?.split(","),
    mocks: flags.mocks,
    targetProject: flags["target-project"],
    typeName: flags.type,
    rootNamespace: flags["root-namespace"]
  });
  const root = plan.request.root;
  updateRun({ root, planId: plan.id, checker: plan.checker ?? null, status: "planned" });
  let output = resolve8(flags.out ?? resolve8(root, ".refactor-ai", `${plan.id}.json`));
  const stateDirectory = resolve8(root, ".refactor-ai");
  const stateStat = await lstat7(stateDirectory).catch((error) => {
    if (error.code === "ENOENT")
      return;
    throw error;
  });
  if (stateStat?.isSymbolicLink())
    throw new Error("SYMLINK_UNSUPPORTED: state directory");
  output = resolve8(await canonicalDirectory(dirname5(output)), basename2(output));
  const within = (directory, path) => {
    const difference = relative3(directory, path);
    return difference !== ".." && !difference.startsWith(`..${sep4}`) && !isAbsolute3(difference);
  };
  if (within(root, output) && !within(stateDirectory, output)) {
    throw new Error("INVALID_ARGUMENT: store plan outside the project or in <root>/.refactor-ai to keep snapshot fresh");
  }
  await mkdir4(dirname5(output), { recursive: true });
  if (await realpath5(dirname5(output)) !== dirname5(output))
    throw new Error("SYMLINK_UNSUPPORTED: plan output directory changed");
  if (dirname5(output) === stateDirectory)
    await ignoreStateDirectory(stateDirectory);
  const outputStat = await lstat7(output).catch((error) => {
    if (error.code === "ENOENT")
      return;
    throw error;
  });
  if (outputStat?.isSymbolicLink())
    throw new Error("SYMLINK_UNSUPPORTED: plan output file");
  await writeFile3(output, JSON.stringify(plan, null, 2) + `
`);
  log({
    status: "planned",
    plan: output,
    id: plan.id,
    backend: plan.backend,
    files: plan.changes.map((c) => c.path),
    validation: plan.validation,
    verify: plan.request.verify ?? "full",
    notes: plan.notes
  });
  if (plan.validation.status !== "passed")
    setExitCode(1);
}
var init_cli_core = __esm(() => {
  init_api();
  init_api();
  init_help();
  init_gc();
  init_run_log();
  init_snapshot();
});

// src/backends/typescript-timing.ts
function timed(phase, run) {
  const emit = process.env.REFACTOR_AI_TIMINGS === "on";
  const start = performance.now();
  if (emit)
    process.stderr.write(JSON.stringify({ phase, event: "start" }) + `
`);
  try {
    return run();
  } finally {
    const ms = Math.round(performance.now() - start);
    recordPhase(phase, ms);
    if (emit)
      process.stderr.write(JSON.stringify({ phase, event: "end", ms }) + `
`);
  }
}
var init_typescript_timing = __esm(() => {
  init_run_log();
});

// src/backends/typescript-diagnostics-cache.ts
import ts from "typescript";
import { randomUUID as randomUUID2 } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname as dirname6, resolve as resolve9 } from "node:path";

class CompilerInputs {
  enabled;
  inputs = new Map;
  values = new Map;
  sys;
  constructor(enabled = process.env.REFACTOR_AI_CACHE === "on") {
    this.enabled = enabled;
    this.sys = { ...ts.sys };
    if (!enabled)
      return;
    for (const method of inputMethods) {
      const original = ts.sys[method];
      if (!original)
        continue;
      this.sys[method] = (...args) => {
        const key = JSON.stringify([method, args]);
        if (this.values.has(key))
          return this.values.get(key);
        const value = original(...args);
        this.inputs.set(key, { method, args: args.map((arg) => Array.isArray(arg) ? [...arg] : arg), digest: inputDigest(method, value) });
        this.values.set(key, value);
        return value;
      };
    }
  }
  snapshot() {
    return [...this.inputs.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, input]) => input);
  }
  changed() {
    return this.snapshot().find((input) => !current(input));
  }
  unchanged() {
    try {
      return this.snapshot().every(current);
    } catch {
      return false;
    }
  }
}
function current(input) {
  if (!input || !inputMethods.includes(input.method) || !Array.isArray(input.args) || typeof input.digest !== "string")
    return false;
  const method = ts.sys[input.method];
  return !!method && inputDigest(input.method, method(...input.args.map((value) => value === null ? undefined : value))) === input.digest;
}
function regularDirectory(path, create) {
  const parent = dirname6(path);
  if (parent !== path && !regularDirectory(parent, create))
    return false;
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    if (error.code !== "ENOENT" || !create)
      return false;
    mkdirSync(path, { mode: 448 });
    return true;
  }
}
function baselineDiagnostics(root, config, program, only, inputs, compute) {
  if (process.env.REFACTOR_AI_CACHE !== "on" || !inputs.enabled)
    return compute();
  const options = { ...program.getCompilerOptions(), configFile: undefined };
  const key = inputHash([
    1,
    ts.version,
    ts.sys.useCaseSensitiveFileNames,
    config,
    options,
    program.getRootFileNames(),
    only ? [...only].sort() : null,
    program.getSourceFiles().map((source) => [source.fileName, inputHash(source.text), source.impliedNodeFormat])
  ]);
  const directory = resolve9(process.env.REFACTOR_AI_CACHE_DIR ?? resolve9(root, ".refactor-ai/cache"));
  const path = resolve9(directory, `${key}.json`);
  try {
    if (regularDirectory(directory, false) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) {
      const entry = JSON.parse(readFileSync(path, "utf8"));
      const { checksum, ...body } = entry;
      if (entry.version === 1 && entry.key === key && checksum === inputHash(body) && Array.isArray(entry.inputs) && entry.inputs.every(current) && Array.isArray(entry.diagnostics) && entry.diagnostics.every((item) => typeof item.file === "string" && typeof item.code === "string" && typeof item.message === "string")) {
        return entry.diagnostics;
      }
    }
  } catch {}
  const diagnostics = compute();
  try {
    const observed = inputs.snapshot();
    if (inputs.unchanged() && regularDirectory(directory, true)) {
      if (!process.env.REFACTOR_AI_CACHE_DIR) {
        try {
          writeFileSync(resolve9(root, ".refactor-ai/.gitignore"), stateIgnoreText, { flag: "wx", mode: 384 });
        } catch (error) {
          if (error.code !== "EEXIST")
            throw error;
          const path = resolve9(root, ".refactor-ai/.gitignore");
          if (!lstatSync(path).isSymbolicLink() && readFileSync(path, "utf8") === `*
`)
            writeFileSync(path, stateIgnoreText);
        }
      }
      const body = { version: 1, key, inputs: observed, diagnostics };
      const temporary = `${path}.${process.pid}.${randomUUID2()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ ...body, checksum: inputHash(body) }), { mode: 384, flag: "wx" });
      renameSync(temporary, path);
    }
  } catch {}
  return diagnostics;
}
var init_typescript_diagnostics_cache = __esm(() => {
  init_read_set();
  init_snapshot();
});

// src/backends/typescript-paths.ts
import { existsSync, readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname7, isAbsolute as isAbsolute4, join, relative as relative4, sep as sep5 } from "node:path";
function portablePath(path, separator = sep5) {
  return path.split(separator).join("/");
}
function isInside(root, path) {
  const difference = relative4(root, path);
  return difference !== ".." && !difference.startsWith(`..${sep5}`) && !isAbsolute4(difference);
}
function workspaceRootHint(root, outside) {
  let current = root;
  for (;; ) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      try {
        if (JSON.parse(readFileSync2(manifest, "utf8")).workspaces && outside.every((path) => isInside(current, path))) {
          return `; these files belong to the workspace at ${current}: rerun with --root ${current}`;
        }
      } catch {}
    }
    const parent = dirname7(current);
    if (parent === current)
      return "; widen --root to a directory containing them";
    current = parent;
  }
}
var init_typescript_paths = () => {};

// src/backends/typescript-vfs.ts
import ts2 from "typescript";
import { existsSync as existsSync2, readdirSync, readFileSync as readFileSync3, realpathSync, statSync } from "node:fs";
import { basename as basename3, dirname as dirname8, relative as relative5, resolve as resolve10, sep as sep6 } from "node:path";
function fail(code, reason) {
  throw new Error(`${code}: ${reason}`);
}
function swapCase(value) {
  return [...value].map((char) => char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()).join("");
}
function detectCaseSensitivity(root) {
  const probe = [root, ...readdirSync(root).map((name) => resolve10(root, name))].find((path) => swapCase(basename3(path)) !== basename3(path));
  if (!probe)
    return ts2.sys.useCaseSensitiveFileNames;
  const swapped = resolve10(dirname8(probe), swapCase(basename3(probe)));
  if (!existsSync2(swapped))
    return true;
  const a = statSync(probe), b = statSync(swapped);
  return !(a.ino === b.ino && a.dev === b.dev);
}
function eolOf(text) {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? `\r
` : `
`;
}
function withEol(text, eol) {
  return text.replace(/\r?\n/g, eol);
}
function specComponents(spec, basePath) {
  const normalized = portablePath(resolve10(basePath, spec));
  const parts = normalized.split("/").filter((component, index) => index === 0 || component !== "");
  if (normalized.startsWith("//"))
    parts[0] = "/";
  return parts;
}
function subPattern(spec, basePath, usage) {
  const { single, double } = matchers[usage];
  const components = specComponents(spec, basePath);
  const last = components[components.length - 1];
  if (usage !== "exclude" && last === "**")
    return;
  if (!/[.*?]/.test(last))
    components.push("**", "*");
  const replace = (match) => match === "*" ? single : match === "?" ? "[^/]" : `\\${match}`;
  let pattern = "";
  let written = false;
  let optional = 0;
  for (let component of components) {
    if (component === "**") {
      pattern += double;
    } else {
      if (usage === "directories") {
        pattern += "(";
        optional += 1;
      }
      if (written)
        pattern += "/";
      if (usage !== "exclude") {
        let componentPattern = "";
        if (component.startsWith("*")) {
          componentPattern += `([^./]${single})?`;
          component = component.slice(1);
        } else if (component.startsWith("?")) {
          componentPattern += "[^./]";
          component = component.slice(1);
        }
        componentPattern += component.replace(/[^\w\s/]/g, replace);
        if (componentPattern !== component)
          pattern += packageFolders;
        pattern += componentPattern;
      } else {
        pattern += component.replace(/[^\w\s/]/g, replace);
      }
    }
    written = true;
  }
  while (optional-- > 0)
    pattern += ")?";
  return pattern;
}
function wildcardRegex(specs, basePath, usage, flags) {
  const patterns = (specs ?? []).map((spec) => subPattern(spec, basePath, usage)).filter((item) => !!item);
  if (!patterns.length)
    return;
  return new RegExp(`^(?:${patterns.map((item) => `(?:${item})`).join("|")})${usage === "exclude" ? "(?:$|/)" : "$"}`, flags);
}
function excludedByPatterns(path, base, patterns) {
  return wildcardRegex(patterns, base, "exclude", ts2.sys.useCaseSensitiveFileNames ? "" : "i")?.test(portablePath(resolve10(path))) ?? false;
}
function includeBasePath(absolute) {
  const wildcard = absolute.search(/[*?]/);
  if (wildcard < 0)
    return basename3(absolute).includes(".") ? dirname8(absolute) : absolute;
  const normalized = portablePath(absolute);
  const end = normalized.lastIndexOf("/", wildcard);
  return end === 2 && /^[A-Za-z]:/.test(normalized) ? normalized.slice(0, 3) : normalized.slice(0, end) || "/";
}
function contentId(text) {
  let id = contentIds.get(text);
  if (id === undefined) {
    if (contentIds.size >= 50000)
      contentIds.clear();
    contentIds.set(text, id = ++nextContentId);
  }
  return id;
}

class VirtualFs {
  root;
  inputs;
  caseSensitive;
  readPaths = new Map;
  disk = new Map;
  diskDirectories = new Map;
  diskDirectoryExists = new Map;
  overlays = new Map;
  generated = new Map;
  ephemeral = new Map;
  keys = new Map;
  virtualDirectoryVersion = -1;
  virtualDirectories = new Set;
  changedDirectories = new Set;
  hiddenDirectories = [];
  suspended = false;
  version = 0;
  constructor(root, inputs = new CompilerInputs(true)) {
    this.root = root;
    this.inputs = inputs;
    this.caseSensitive = detectCaseSensitivity(root);
  }
  key(path) {
    const cached = this.keys.get(path);
    if (cached !== undefined)
      return cached;
    const normalized = resolve10(path);
    const key = this.caseSensitive ? normalized : normalized.toLowerCase();
    this.keys.set(path, key);
    return key;
  }
  samePath(a, b) {
    return this.key(a) === this.key(b);
  }
  contains(directory, path) {
    const parent = this.key(directory), child = this.key(path);
    return child === parent || child.startsWith(parent.endsWith(sep6) ? parent : `${parent}${sep6}`);
  }
  setHiddenDirectories(directories) {
    this.hiddenDirectories = directories.map((directory) => resolve10(directory));
  }
  isHidden(path) {
    return this.hiddenDirectories.some((directory) => this.contains(directory, path));
  }
  original(callback) {
    const previous = this.suspended;
    this.suspended = true;
    this.version += 1;
    try {
      return callback();
    } finally {
      this.suspended = previous;
      this.version += 1;
    }
  }
  isExternal(path) {
    const canonical = this.readPath(path);
    return !isInside(this.root, canonical) || canonical.split(sep6).includes("node_modules");
  }
  readPath(path) {
    path = resolve10(path);
    if (!path.split(sep6).includes("node_modules"))
      return path;
    const cached = this.readPaths.get(path);
    if (cached)
      return cached;
    let ancestor = path;
    while (!existsSync2(ancestor) && dirname8(ancestor) !== ancestor)
      ancestor = dirname8(ancestor);
    let canonical = path;
    try {
      const real = resolve10(this.inputs.sys.realpath?.(ancestor) ?? realpathSync(ancestor), relative5(ancestor, path));
      if (isInside(this.root, real) && !real.split(sep6).includes("node_modules"))
        canonical = real;
    } catch {}
    this.readPaths.set(path, canonical);
    return canonical;
  }
  rawDisk(path) {
    const key = this.key(path);
    if (!this.disk.has(key)) {
      if (this.inputs.enabled) {
        this.inputs.sys.fileExists(path);
        this.inputs.sys.readFile(path);
      }
      let text;
      try {
        if (statSync(path).isFile())
          text = readFileSync3(path, "utf8");
      } catch {
        text = undefined;
      }
      this.disk.set(key, text);
    }
    return this.disk.get(key);
  }
  diskText(path) {
    if (this.isHidden(path))
      return null;
    return this.rawDisk(path) ?? null;
  }
  hasBom(path) {
    path = this.readPath(path);
    const overlay = this.suspended ? undefined : this.overlays.get(this.key(path));
    if (overlay)
      return overlay.bom;
    return this.diskText(path)?.startsWith(BOM) ?? false;
  }
  readFile(path) {
    path = this.readPath(path);
    const key = this.key(path);
    const generated = this.generated.get(key);
    if (generated)
      return generated.text;
    if (this.isHidden(path))
      return;
    const ephemeral = this.suspended ? undefined : this.ephemeral.get(key);
    if (ephemeral)
      return ephemeral.text;
    const overlay = this.suspended ? undefined : this.overlays.get(key);
    if (overlay)
      return overlay.text ?? undefined;
    const text = this.rawDisk(path);
    return text?.startsWith(BOM) ? text.slice(1) : text;
  }
  fileExists(path) {
    return this.readFile(path) !== undefined;
  }
  scriptVersion(path) {
    const text = this.readFile(path);
    return text === undefined ? "absent" : `t${contentId(text)}`;
  }
  write(path, text, bom = this.hasBom(path)) {
    const key = this.key(path);
    const existing = this.overlays.get(key);
    this.overlays.set(key, { path: existing?.path ?? resolve10(path), text: text?.startsWith(BOM) ? text.slice(1) : text, bom });
    this.version += 1;
  }
  writeEphemeral(path, text) {
    const key = this.key(path);
    this.ephemeral.set(key, { path: resolve10(path), text: text.startsWith(BOM) ? text.slice(1) : text });
    this.version += 1;
  }
  ephemeralPaths() {
    return [...this.ephemeral.values()].map((item) => item.path).sort();
  }
  clearGenerated() {
    this.generated.clear();
    this.version += 1;
  }
  writeGenerated(path, text) {
    if (!this.isHidden(path))
      fail("DECLARATION_OUTPUT_UNSUPPORTED", `in-memory build would emit outside a declaration output directory: ${path}`);
    const key = this.key(path);
    this.generated.set(key, { path: resolve10(path), text });
    this.version += 1;
  }
  diskEntries(directory) {
    const key = this.key(directory);
    const cached = this.diskDirectories.get(key);
    if (cached)
      return cached;
    const result = this.readDiskEntries(directory);
    this.diskDirectories.set(key, result);
    return result;
  }
  readDiskEntries(directory) {
    const files = [], directories = [];
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return { files, directories };
    }
    for (const entry of entries) {
      const name = entry.name;
      try {
        const stat = entry.isSymbolicLink() ? statSync(resolve10(directory, name)) : entry;
        if (stat.isFile())
          files.push(name);
        else if (stat.isDirectory())
          directories.push(name);
      } catch {}
    }
    return { files, directories };
  }
  assertStableMetadata() {
    const changed = this.inputs.changed();
    if (changed)
      fail("STALE_PROJECT_INPUTS", `${changed.method} changed during analysis: ${changed.args[0]}${inputQueryDetails(changed)}; compiler inputs include project-discovery reads; retry after those writers/generators settle`);
  }
  virtualPaths() {
    const paths = [...this.generated.values()].map((item) => item.path);
    if (!this.suspended) {
      for (const overlay of this.overlays.values())
        if (overlay.text !== null)
          paths.push(overlay.path);
      for (const item of this.ephemeral.values())
        paths.push(item.path);
    }
    return paths;
  }
  hasVirtualDirectory(path) {
    if (this.virtualDirectoryVersion !== this.version) {
      this.virtualDirectories = new Set;
      this.changedDirectories = new Set;
      const index = (file, directories) => {
        for (let directory = dirname8(file);; directory = dirname8(directory)) {
          const key = this.key(directory);
          if (directories.has(key))
            break;
          directories.add(key);
          if (dirname8(directory) === directory)
            break;
        }
      };
      for (const file of this.virtualPaths())
        index(file, this.virtualDirectories);
      if (!this.suspended)
        for (const item of [...this.overlays.values(), ...this.ephemeral.values()])
          index(item.path, this.changedDirectories);
      this.virtualDirectoryVersion = this.version;
    }
    return this.virtualDirectories.has(this.key(path));
  }
  entries(directory) {
    directory = this.readPath(directory);
    const hidden = this.isHidden(directory);
    const files = new Map;
    const directories = new Map;
    if (!hidden) {
      const disk = this.diskEntries(directory);
      for (const name of disk.files) {
        const path = resolve10(directory, name);
        if (!this.isHidden(path) && this.fileExists(path))
          files.set(this.key(path), name);
      }
      for (const name of disk.directories) {
        const path = resolve10(directory, name);
        if (!this.isHidden(path) || this.directoryExists(path))
          directories.set(this.key(path), name);
      }
    }
    for (const path of this.virtualPaths()) {
      if (!this.contains(directory, path) || this.samePath(directory, path))
        continue;
      const rest = relative5(directory, path).split(sep6);
      const child = resolve10(directory, rest[0]);
      if (rest.length === 1)
        files.set(this.key(child), rest[0]);
      else
        directories.set(this.key(child), rest[0]);
    }
    return { files: [...files.values()], directories: [...directories.values()] };
  }
  directoryExists(path) {
    path = this.readPath(path);
    if (this.inputs.enabled)
      this.inputs.sys.directoryExists(path);
    if (this.hasVirtualDirectory(path))
      return true;
    if (this.isHidden(path))
      return false;
    const key = this.key(path);
    if (!this.diskDirectoryExists.has(key)) {
      let exists = false;
      try {
        exists = statSync(path).isDirectory();
      } catch {}
      this.diskDirectoryExists.set(key, exists);
    }
    return this.diskDirectoryExists.get(key);
  }
  getDirectories(path) {
    this.inputs.sys.getDirectories(path);
    return this.entries(path).directories;
  }
  realpath(path) {
    path = this.readPath(path);
    const key = this.key(path);
    if (this.generated.has(key) || !this.suspended && (this.overlays.has(key) || this.ephemeral.has(key)))
      return resolve10(path);
    try {
      return this.inputs.sys.realpath?.(path) ?? path;
    } catch {
      return path;
    }
  }
  readDirectory(path, extensions, excludes, includes, depth) {
    path = resolve10(path);
    this.inputs.sys.readDirectory(path, extensions, excludes, includes, depth);
    const flags = this.caseSensitive ? "" : "i";
    const includeFiles = includes?.length ? includes.map((spec) => subPattern(spec, path, "files")).map((pattern) => pattern === undefined ? undefined : new RegExp(`^${pattern}$`, flags)) : undefined;
    const includeDirectories = wildcardRegex(includes, path, "directories", flags);
    const exclude = wildcardRegex(excludes, path, "exclude", flags);
    const results = includeFiles ? includeFiles.map(() => []) : [[]];
    const bases = [path];
    for (const base of (includes ?? []).map((spec) => includeBasePath(resolve10(path, spec))).sort()) {
      if (bases.every((existing) => !this.contains(existing, base)))
        bases.push(base);
    }
    const visited = new Set;
    const visit = (directory, remaining) => {
      const key = this.key(this.realpath(directory));
      if (visited.has(key))
        return;
      visited.add(key);
      const { files, directories } = this.entries(directory);
      for (const name of [...files].sort()) {
        const absolute = resolve10(directory, name);
        if (extensions && !extensions.some((extension) => absolute.endsWith(extension)))
          continue;
        const normalized = portablePath(absolute);
        if (exclude?.test(normalized))
          continue;
        if (!includeFiles)
          results[0].push(absolute);
        else {
          const index = includeFiles.findIndex((regex) => regex?.test(normalized));
          if (index !== -1)
            results[index].push(absolute);
        }
      }
      if (remaining !== undefined && --remaining === 0)
        return;
      for (const name of [...directories].sort()) {
        const absolute = resolve10(directory, name);
        const normalized = portablePath(absolute);
        if ((!includeDirectories || includeDirectories.test(normalized)) && !exclude?.test(normalized))
          visit(absolute, remaining);
      }
    };
    for (const base of bases)
      visit(base, depth);
    return results.flat();
  }
  moduleResolutionHost() {
    return {
      fileExists: (path) => this.fileExists(path),
      readFile: (path) => this.readFile(path),
      directoryExists: (path) => this.directoryExists(path),
      getDirectories: (path) => this.getDirectories(path),
      realpath: (path) => this.realpath(path),
      useCaseSensitiveFileNames: this.caseSensitive
    };
  }
  nativeFileSystem() {
    const virtual = (path) => {
      const canonical = this.readPath(path), key = this.key(canonical);
      return this.isHidden(canonical) || this.generated.has(key) || !this.suspended && (this.overlays.has(key) || this.ephemeral.has(key));
    };
    return {
      readFile: (path) => {
        this.inputs.sys.readFile(this.readPath(path));
        return virtual(path) ? this.readFile(path) ?? null : undefined;
      },
      fileExists: (path) => {
        this.inputs.sys.fileExists(this.readPath(path));
        return virtual(path) ? this.fileExists(path) : undefined;
      },
      directoryExists: (path) => {
        this.inputs.sys.directoryExists(this.readPath(path));
        return this.hasVirtualDirectory(this.readPath(path)) ? true : this.isHidden(this.readPath(path)) ? false : undefined;
      },
      getAccessibleEntries: (path) => {
        const canonical = this.readPath(path);
        this.inputs.sys.getDirectories(canonical);
        this.inputs.sys.readDirectory(canonical, undefined, undefined, ["*"], 1);
        const virtual = this.hasVirtualDirectory(canonical);
        return this.isHidden(canonical) || virtual || this.changedDirectories.has(this.key(canonical)) ? this.entries(canonical) : undefined;
      },
      realpath: (path) => {
        this.inputs.sys.realpath?.(this.readPath(path));
        return virtual(path) ? this.readPath(path) : undefined;
      }
    };
  }
  parseConfigHost(onError) {
    return {
      useCaseSensitiveFileNames: this.caseSensitive,
      readDirectory: (path, extensions, excludes, includes, depth) => this.readDirectory(path, extensions, excludes, includes, depth),
      fileExists: (path) => this.fileExists(path),
      readFile: (path) => this.readFile(path),
      getCurrentDirectory: () => this.root,
      onUnRecoverableConfigFileDiagnostic: onError
    };
  }
  changes() {
    const changes = [];
    for (const overlay of this.overlays.values()) {
      const before = this.rawDisk(overlay.path) ?? null;
      const after = overlay.text === null ? null : `${overlay.bom ? BOM : ""}${overlay.text}`;
      if (before === after)
        continue;
      changes.push({ path: overlay.path, before, after });
    }
    return changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  changedPaths() {
    return this.changes().map((change) => change.path);
  }
}
var BOM = "\uFEFF", packageFolders = "(?!(node_modules|bower_components|jspm_packages)(/|$))", matchers, contentIds, nextContentId = 0;
var init_typescript_vfs = __esm(() => {
  init_read_set();
  init_typescript_diagnostics_cache();
  init_typescript_paths();
  init_typescript_paths();
  matchers = {
    files: { single: "([^./]|(\\.(?!min\\.js$))?)*", double: `(/${packageFolders}[^/.][^/]*)*?` },
    directories: { single: "[^/]*", double: `(/${packageFolders}[^/.][^/]*)*?` },
    exclude: { single: "[^/]*", double: "(/.+?)?" }
  };
  contentIds = new Map;
});

// src/backends/typescript-ts7.ts
import { createRequire as createRequire2 } from "node:module";
import { resolve as resolve11 } from "node:path";
function nativeMessage(diagnostic) {
  return [diagnostic.text, ...(diagnostic.messageChain ?? []).map((child) => nativeMessage(child).split(`
`).map((line) => `  ${line}`).join(`
`))].join(`
`);
}
function assertCheckerParity(expected, actual) {
  const keys = (items) => items.map((item) => JSON.stringify([resolve11(item.file), item.code])).sort();
  const reference = keys(expected), native = keys(actual);
  if (JSON.stringify(reference) !== JSON.stringify(native)) {
    fail("CHECKER_MISMATCH", `TS7 7.0.2 disagrees with TypeScript 5.9.3 (file+code); TS5=${JSON.stringify(reference)}; TS7=${JSON.stringify(native)}. Plan rejected; use the default checker to inspect it.`);
  }
}
async function loadTs7Checker(mode = "both") {
  if (process.versions.bun)
    fail("CHECKER_RUNTIME", "TS7's synchronous Go API requires Node.js 22+; run the built CLI/API with node");
  let Constructor;
  try {
    const metadata = createRequire2(import.meta.url)("typescript7/package.json");
    if (metadata.version !== ts7Identity.version)
      fail("CHECKER_VERSION", `expected typescript7 alias npm:typescript@7.0.2, found ${metadata.version}`);
    Constructor = (await import("typescript7/unstable/sync")).API;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CHECKER_VERSION:"))
      throw error;
    fail("CHECKER_UNAVAILABLE", "--checker ts7 requires the separately installed optional peer typescript7@npm:typescript@7.0.2 and its platform binary; no runtime download is performed");
  }
  let session;
  const checker = (input) => timed("diagnostics.ts7", () => {
    let api;
    try {
      api = session?.api ?? new Constructor({ cwd: input.root, fs: input.fs });
      if (session)
        session.api = api;
    } catch (error) {
      fail("CHECKER_UNAVAILABLE", `cannot start the installed TS7 7.0.2 platform binary: ${error instanceof Error ? error.message : error}`);
    }
    try {
      const snapshot = session?.snapshot ?? api.updateSnapshot({ openProjects: session?.configs ?? [input.config] });
      if (session)
        session.snapshot = snapshot;
      const project = snapshot.getProject(input.config);
      if (!project)
        fail("CHECKER_PROJECT", `TS7 did not load ${input.config}`);
      const program = project.program;
      const actual = [];
      const add = (items) => {
        for (const item of items)
          if (item.category === 1)
            actual.push({
              file: item.fileName ? resolve11(item.fileName) : input.config,
              code: `TS${item.code}`,
              message: nativeMessage(item)
            });
      };
      add(program.getConfigFileParsingDiagnostics());
      add(program.getProgramDiagnostics());
      add(program.getGlobalDiagnostics());
      const nativeFiles = new Set(program.getSourceFileNames().map((path) => resolve11(path)));
      const expectedFiles = [...input.files].sort(), actualFiles = [...nativeFiles].filter(input.isUserFile).sort();
      if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
        fail("CHECKER_SOURCE_MISMATCH", `TS7 and TS5 disagree on user source membership in ${input.config}; plan rejected`);
      }
      if (mode === "ts7") {
        const user = (items) => items.filter((item) => !item.fileName || input.isUserFile(resolve11(item.fileName)));
        add(user(program.getSyntacticDiagnostics()));
        add(user(program.getSemanticDiagnostics()));
        if (input.options.declaration || input.options.composite)
          add(user(program.getDeclarationDiagnostics()));
      } else {
        for (const file of input.files) {
          if (input.only && !input.only.has(file))
            continue;
          add(program.getSyntacticDiagnostics(file));
          add(program.getSemanticDiagnostics(file));
          if (input.options.declaration || input.options.composite)
            add(program.getDeclarationDiagnostics(file));
        }
      }
      if (mode === "both") {
        assertCheckerParity(input.expected, actual);
        return input.expected;
      }
      return actual.sort((a, b) => a.file.localeCompare(b.file) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
    } finally {
      if (!session)
        api.close();
    }
  });
  checker.withSession = (configs, run) => {
    if (session)
      fail("CHECKER_SESSION", "native checker sessions must not overlap");
    const view = { configs };
    session = view;
    try {
      return run();
    } finally {
      session = undefined;
      view.api?.close();
    }
  };
  return checker;
}
function compareWorkspaceDiagnostics(checker, vfs, config, options, files, expected, only) {
  return checker({
    root: vfs.root,
    config,
    options,
    files,
    expected,
    only: only && new Set(files.filter((file) => only.has(vfs.key(file)))),
    fs: vfs.nativeFileSystem(),
    isUserFile: (path) => isInside(vfs.root, path) && !portablePath(path).split("/").includes("node_modules") && !vfs.isHidden(path)
  });
}
var ts7Identity, bothIdentity;
var init_typescript_ts7 = __esm(() => {
  init_typescript_vfs();
  init_typescript_timing();
  init_typescript_paths();
  ts7Identity = { name: "ts7", version: "7.0.2" };
  bothIdentity = { name: "both", version: "7.0.2", comparedWith: "typescript@5.9.3" };
});

// src/backends/typescript-workspace.ts
import ts3 from "typescript";
import { statSync as statSync2 } from "node:fs";
import { basename as basename4, dirname as dirname9, relative as relative6, resolve as resolve12 } from "node:path";
function configPathFor(project) {
  let stat;
  try {
    stat = statSync2(project);
  } catch {
    fail("PROJECT_NOT_FOUND", project);
  }
  if (stat.isFile()) {
    if (!configName.test(basename4(project)))
      fail("UNSUPPORTED_PROJECT", "project must name a tsconfig*.json or jsconfig*.json file");
    return resolve12(project);
  }
  if (!stat.isDirectory())
    fail("UNSUPPORTED_PROJECT", "project must be a config file or directory");
  const candidates = ["tsconfig.json", "jsconfig.json"].map((name) => resolve12(project, name)).filter((path) => {
    try {
      return statSync2(path).isFile();
    } catch {
      return false;
    }
  });
  if (candidates.length === 0)
    fail("CONFIG_NOT_FOUND", `no tsconfig.json or jsconfig.json in ${project}`);
  if (candidates.length > 1)
    fail("MULTIPLE_CONFIGS", `both tsconfig.json and jsconfig.json exist in ${project}`);
  return candidates[0];
}
function discoverConfigs(root, sys) {
  return sys.readDirectory(root, [".json"], ["**/node_modules", "**/.*"], ["**/tsconfig*.json", "**/jsconfig*.json"]).filter((path) => configName.test(basename4(path))).sort();
}
function flatten(diagnostic) {
  return ts3.flattenDiagnosticMessageText(diagnostic.messageText, `
`);
}
function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function isDeclarationPath(path) {
  return /\.d(\.[^./]+)?\.[cm]?ts$/.test(path);
}
function scriptKindFor(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx"))
    return ts3.ScriptKind.TSX;
  if (lower.endsWith(".jsx"))
    return ts3.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(lower))
    return ts3.ScriptKind.JS;
  if (lower.endsWith(".json"))
    return ts3.ScriptKind.JSON;
  return ts3.ScriptKind.TS;
}
function isModuleMockCall(node) {
  return ts3.isCallExpression(node) && node.arguments.length >= 1 && ts3.isStringLiteralLike(node.arguments[0]) && ts3.isPropertyAccessExpression(node.expression) && ts3.isIdentifier(node.expression.expression) && mockObjects.has(node.expression.expression.text) && mockMethods.has(node.expression.name.text);
}
function moduleSpecifiers(sourceFile) {
  const cached = specifiersBySource.get(sourceFile);
  if (cached)
    return cached;
  const found = [];
  const seen = new Set;
  const isJs = /\.[cm]?jsx?$/i.test(sourceFile.fileName);
  const visit = (node) => {
    if (seen.has(node))
      return;
    seen.add(node);
    if ((ts3.isImportDeclaration(node) || ts3.isExportDeclaration(node)) && node.moduleSpecifier && ts3.isStringLiteralLike(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier);
    } else if (ts3.isExternalModuleReference(node) && ts3.isStringLiteralLike(node.expression)) {
      found.push(node.expression);
    } else if (ts3.isCallExpression(node) && node.arguments.length >= 1 && ts3.isStringLiteralLike(node.arguments[0]) && (node.expression.kind === ts3.SyntaxKind.ImportKeyword || ts3.isIdentifier(node.expression) && node.expression.text === "require")) {
      found.push(node.arguments[0]);
    } else if (isModuleMockCall(node)) {
      found.push(node.arguments[0]);
    } else if (ts3.isImportTypeNode(node) && ts3.isLiteralTypeNode(node.argument) && ts3.isStringLiteralLike(node.argument.literal)) {
      found.push(node.argument.literal);
    }
    if (isJs)
      for (const doc of ts3.getJSDocCommentsAndTags(node))
        visit(doc);
    ts3.forEachChild(node, visit);
  };
  visit(sourceFile);
  found.sort((a, b) => a.getStart(sourceFile) - b.getStart(sourceFile));
  specifiersBySource.set(sourceFile, found);
  return found;
}
function hasAmbientEffect(source) {
  const visit = (node) => ts3.isModuleDeclaration(node) && (ts3.isStringLiteral(node.name) || (node.flags & ts3.NodeFlags.GlobalAugmentation) !== 0) || !!ts3.forEachChild(node, visit);
  return visit(source);
}
function attachSourceParents(source) {
  const pending = [source];
  let parent;
  const add = (child) => {
    child.parent = parent;
    pending.push(child);
  };
  while (pending.length) {
    parent = pending.pop();
    ts3.forEachChild(parent, add);
    for (const doc of parent.jsDoc ?? [])
      add(doc);
  }
}
function setWorkspaceWarmMode(enabled) {
  warmDocuments = enabled ? new Map : undefined;
}
function sharedDocuments(caseSensitive) {
  if (!warmDocuments)
    return;
  let shared = warmDocuments.get(caseSensitive);
  if (!shared) {
    const base = ts3.createDocumentRegistry(caseSensitive);
    const registry = {
      acquireDocument: base.acquireDocument.bind(base),
      acquireDocumentWithKey: base.acquireDocumentWithKey.bind(base),
      updateDocument: base.updateDocument.bind(base),
      updateDocumentWithKey: base.updateDocumentWithKey.bind(base),
      getKeyForCompilationSettings: base.getKeyForCompilationSettings.bind(base),
      reportStats: base.reportStats.bind(base),
      releaseDocument: () => {},
      releaseDocumentWithKey: () => {}
    };
    warmDocuments.set(caseSensitive, shared = { registry, parented: new WeakSet, sourceFiles: new Map, stubs: new Map });
  }
  return shared;
}

class Workspace {
  root;
  affected;
  nativeChecker;
  checkerMode;
  extraConfigs;
  lightDiscovery;
  vfs;
  participants = new Map;
  order = [];
  sourceConfig;
  targetConfig;
  editOptions;
  service;
  registry;
  registeredDocuments = [];
  parentedSources;
  shared;
  discovered;
  importingConfigs = [];
  layouts = new Map;
  owners = new Map;
  sourceFiles;
  discoveryPrograms = new Map;
  resolutionVersion = -1;
  resolutionCaches = new WeakMap;
  looseConfigs = new Map;
  extendedConfigs;
  constructor(root, sourceConfig, targetConfig, affected = [], nativeChecker, checkerMode = "both", inputs, extraConfigs = [], lightDiscovery = false) {
    this.root = root;
    this.affected = affected;
    this.nativeChecker = nativeChecker;
    this.checkerMode = checkerMode;
    this.extraConfigs = extraConfigs;
    this.lightDiscovery = lightDiscovery;
    this.vfs = new VirtualFs(root, inputs);
    const shared = sharedDocuments(this.vfs.caseSensitive);
    this.shared = !!shared;
    this.registry = shared?.registry ?? ts3.createDocumentRegistry(this.vfs.caseSensitive);
    this.parentedSources = shared?.parented ?? new WeakSet;
    this.sourceFiles = shared?.sourceFiles ?? new Map;
    this.stubs = shared?.stubs ?? new Map;
    this.sourceConfig = sourceConfig;
    this.targetConfig = targetConfig;
    for (const config of [sourceConfig, targetConfig, ...extraConfigs]) {
      if (!isInside(root, config))
        fail("OUTSIDE_ROOT", `project config is outside ${root}: ${config}`);
    }
    this.discovered = discoverConfigs(root, this.vfs.inputs.sys);
    this.loadGraph();
    if (nativeChecker && [...this.participants.values()].some((item) => item.references.length)) {
      fail("CHECKER_UNSUPPORTED", "--checker ts7 does not yet support in-memory project-reference declaration builds; use the default checker");
    }
    this.editOptions = { ...this.participant(sourceConfig).parsed.options, noEmit: true };
    for (const key of [
      "configFile",
      "configFilePath",
      "composite",
      "incremental",
      "tsBuildInfoFile",
      "declaration",
      "declarationMap",
      "emitDeclarationOnly",
      "declarationDir",
      "outDir",
      "rootDir"
    ])
      delete this.editOptions[key];
    this.service = this.languageService(sourceConfig, () => this.editOptions, () => this.unionFiles());
  }
  languageService(config, options, files) {
    const vfs = this.vfs;
    const host = {
      getCompilationSettings: options,
      getScriptFileNames: files,
      getScriptVersion: (fileName) => vfs.scriptVersion(fileName),
      getScriptSnapshot: (fileName) => {
        const text = vfs.readFile(fileName);
        return text === undefined ? undefined : ts3.ScriptSnapshot.fromString(text);
      },
      getScriptKind: (fileName) => scriptKindFor(fileName),
      getCurrentDirectory: () => dirname9(config),
      getDefaultLibFileName: (options) => ts3.getDefaultLibFilePath(options),
      fileExists: (path) => vfs.fileExists(path),
      readFile: (path) => vfs.readFile(path),
      readDirectory: (path, extensions, excludes, includes, depth) => vfs.readDirectory(path, extensions, excludes, includes, depth),
      directoryExists: (path) => vfs.directoryExists(path),
      getDirectories: (path) => vfs.getDirectories(path),
      realpath: (path) => vfs.realpath(path),
      useCaseSensitiveFileNames: () => vfs.caseSensitive,
      getNewLine: () => `
`,
      getProjectVersion: () => String(vfs.version),
      hasInvalidatedResolutions: () => true
    };
    return ts3.createLanguageService(host, this.registry);
  }
  dispose() {
    this.service.dispose();
    for (const item of this.registeredDocuments)
      this.registry.releaseDocument(item.path, item.options, item.kind, item.format);
    this.registeredDocuments.length = 0;
    if (!this.shared) {
      this.sourceFiles.clear();
      this.stubs.clear();
    }
    this.discoveryPrograms.clear();
  }
  participant(config) {
    const found = this.participants.get(this.vfs.key(config));
    if (!found)
      fail("UNHANDLED_PROJECT_GRAPH", `${config} is not part of the loaded project graph`);
    return found;
  }
  parse(configPath, useDisk = false, planned = false) {
    const onError = (diagnostic) => fail("INVALID_CONFIG", `${configPath}: ${flatten(diagnostic)}`);
    const host = useDisk ? { ...this.vfs.inputs.sys, onUnRecoverableConfigFileDiagnostic: onError } : this.vfs.parseConfigHost(onError);
    const parsed = ts3.getParsedCommandLineOfConfigFile(configPath, undefined, host);
    if (!parsed)
      fail("INVALID_CONFIG", `could not parse ${configPath}`);
    const errors = parsed.errors.filter((diagnostic) => diagnostic.category === ts3.DiagnosticCategory.Error);
    if (planned && errors.some((diagnostic) => diagnostic.code === 18003)) {
      fail("PROJECT_WOULD_BE_EMPTY", `${configPath} would no longer include any source file`);
    }
    if (errors.length)
      fail("INVALID_CONFIG", `${configPath}: ${flatten(errors[0])}`);
    return parsed;
  }
  rawReferences(configPath) {
    const result = ts3.readConfigFile(configPath, (path) => this.vfs.readFile(path));
    const references = result.config?.references;
    if (!Array.isArray(references))
      return [];
    return references.map((reference) => typeof reference?.path === "string" ? resolve12(ts3.resolveProjectReferencePath({ path: resolve12(dirname9(configPath), reference.path) })) : undefined).filter((path) => path !== undefined);
  }
  loadGraph() {
    const vfs = this.vfs;
    const seeds = [this.sourceConfig, this.targetConfig, ...this.extraConfigs];
    const affected = new Set(seeds.map((config) => vfs.key(config)));
    const paths = new Map(seeds.map((config) => [vfs.key(config), config]));
    for (const config of this.discovered) {
      if (affected.has(vfs.key(config)) || !this.importsAffected(config, this.affected))
        continue;
      affected.add(vfs.key(config));
      paths.set(vfs.key(config), config);
      this.importingConfigs.push(config);
    }
    const graphDirectories = new Set([...affected].map((key) => vfs.key(dirname9(paths.get(key)))));
    const observers = new Set;
    for (const config of this.discovered) {
      if (affected.has(vfs.key(config)) || editorConfigName.test(basename4(config)) || this.isBaseConfig(config))
        continue;
      if (!graphDirectories.has(vfs.key(dirname9(config))) || !this.listsAny(config, this.affected))
        continue;
      affected.add(vfs.key(config));
      paths.set(vfs.key(config), config);
      observers.add(vfs.key(config));
    }
    const rawReferences = new Map(this.discovered.map((config) => [vfs.key(config), this.rawReferences(config)]));
    let grew = true;
    while (grew) {
      grew = false;
      for (const config of this.discovered) {
        if (affected.has(vfs.key(config)))
          continue;
        if (rawReferences.get(vfs.key(config)).some((reference) => affected.has(vfs.key(reference)))) {
          affected.add(vfs.key(config));
          paths.set(vfs.key(config), config);
          grew = true;
        }
      }
    }
    const diskParsed = new Map;
    const pending = [...affected].map((key) => paths.get(key));
    while (pending.length) {
      const config = pending.shift();
      const key = vfs.key(config);
      if (diskParsed.has(key))
        continue;
      if (!isInside(this.root, config))
        fail("OUTSIDE_ROOT", `referenced project is outside ${this.root}: ${config}`);
      if (!vfs.fileExists(config))
        fail("PROJECT_NOT_FOUND", `referenced project does not exist: ${config}`);
      const parsed = this.parse(config, true);
      diskParsed.set(key, parsed);
      paths.set(key, config);
      for (const reference of parsed.projectReferences ?? [])
        pending.push(resolve12(ts3.resolveProjectReferencePath(reference)));
    }
    for (const [key, parsed] of diskParsed) {
      const configPath = paths.get(key);
      if (parsed.options.outFile)
        fail("UNSUPPORTED_PROJECT", `${configPath}: outFile bundles are not supported`);
      const references = (parsed.projectReferences ?? []).map((reference) => resolve12(ts3.resolveProjectReferencePath(reference)));
      if (references.some((reference) => !diskParsed.has(vfs.key(reference)))) {
        fail("UNHANDLED_PROJECT_GRAPH", `${configPath} references a project that could not be loaded`);
      }
      if ((parsed.projectReferences ?? []).some((reference) => reference.prepend)) {
        fail("UNSUPPORTED_PROJECT", `${configPath}: prepended project references are not supported`);
      }
      this.participants.set(key, { configPath, parsed, references, observer: observers.has(key) });
    }
    const referenced = new Set([...this.participants.values()].flatMap((item) => item.references.map((path) => vfs.key(path))));
    const outputs = [];
    for (const key of referenced) {
      const item = this.participants.get(key);
      const output = item.parsed.options.declarationDir ?? item.parsed.options.outDir;
      if (!output) {
        fail("DECLARATION_OUTPUT_UNSUPPORTED", `${item.configPath} is referenced by another project and must emit declarations to outDir or declarationDir`);
      }
      if (!isInside(this.root, output) || vfs.samePath(output, dirname9(item.configPath)) || vfs.contains(output, dirname9(item.configPath))) {
        fail("DECLARATION_OUTPUT_UNSUPPORTED", `${item.configPath}: declaration output directory must be a dedicated directory inside ${this.root}`);
      }
      item.outputDirectory = resolve12(output);
      outputs.push(item.outputDirectory);
    }
    vfs.setHiddenDirectories(outputs);
    for (const [key, item] of this.participants) {
      const disk = diskParsed.get(key).fileNames.map((path) => vfs.key(path)).sort();
      item.parsed = this.parse(item.configPath);
      const virtual = item.parsed.fileNames.map((path) => vfs.key(path)).sort();
      const inOutputs = item.parsed.fileNames.concat(diskParsed.get(key).fileNames).find((path) => vfs.isHidden(path));
      if (inOutputs)
        fail("DECLARATION_OUTPUT_UNSUPPORTED", `${item.configPath} includes a file inside a declaration output directory: ${inOutputs}`);
      if (!sameValue(disk, virtual)) {
        fail("CONFIG_PATTERNS_UNSUPPORTED", `${item.configPath}: include/exclude patterns could not be reproduced exactly for in-memory planning`);
      }
      const outside = item.parsed.fileNames.find((path) => !isInside(this.root, path));
      if (outside)
        fail("OUTSIDE_ROOT", `${item.configPath} includes ${outside}, outside ${this.root}`);
    }
    const state = new Map;
    const visit = (key, trail) => {
      if (state.get(key) === "done")
        return;
      if (state.get(key) === "visiting")
        fail("UNHANDLED_PROJECT_GRAPH", `project reference cycle: ${[...trail, key].join(" -> ")}`);
      state.set(key, "visiting");
      for (const reference of this.participants.get(key).references)
        visit(vfs.key(reference), [...trail, key]);
      state.set(key, "done");
      this.order.push(key);
    };
    for (const key of [...this.participants.keys()].sort())
      visit(key, []);
    const withFiles = [...this.participants.values()].filter((item) => item.parsed.fileNames.length > 0);
    const first = this.participant(this.sourceConfig);
    for (const item of withFiles) {
      for (const option of sharedOptionKeys) {
        if (!sameValue(item.parsed.options[option], first.parsed.options[option])) {
          fail("PROJECT_OPTIONS_INCOMPATIBLE", `${item.configPath} and ${first.configPath} differ in compiler option '${option}'; cross-project planning requires compatible syntax, emit and extension settings`);
        }
      }
    }
    this.indexOwners();
  }
  indexOwners() {
    this.owners = new Map;
    for (const item of this.participants.values()) {
      if (item.observer)
        continue;
      for (const path of item.parsed.fileNames) {
        const key = this.vfs.key(path);
        this.owners.set(key, [...this.owners.get(key) ?? [], item.configPath]);
      }
    }
  }
  reparse() {
    for (const item of this.participants.values())
      item.parsed = this.parse(item.configPath, false, true);
    this.indexOwners();
    this.vfs.version += 1;
  }
  ownersOf(path) {
    return this.owners.get(this.vfs.key(path)) ?? [];
  }
  isObserver(config) {
    return this.participant(config).observer === true;
  }
  observers() {
    return [...this.participants.values()].filter((item) => item.observer).map((item) => item.configPath).sort();
  }
  references(config) {
    return this.participant(config).references;
  }
  fileNames(config) {
    return this.participant(config).parsed.fileNames.map((path) => resolve12(path));
  }
  unionFiles() {
    const files = new Map;
    for (const item of this.participants.values())
      for (const path of item.parsed.fileNames)
        files.set(this.vfs.key(path), resolve12(path));
    return [...files.values()].sort();
  }
  program() {
    const program = this.service.getProgram();
    if (!program)
      fail("PROGRAM_UNAVAILABLE", "TypeScript could not create a program");
    return program;
  }
  resolveModule(specifier, sourceFile, options) {
    options ??= this.ownersOf(sourceFile.fileName)[0] ? this.participant(this.ownersOf(sourceFile.fileName)[0]).parsed.options : this.editOptions;
    const mode = ts3.getModeForUsageLocation(sourceFile, specifier, options);
    return ts3.resolveModuleName(specifier.text, sourceFile.fileName, options, this.vfs.moduleResolutionHost(), this.resolutionCache(options), undefined, mode).resolvedModule;
  }
  resolutionCache(options) {
    if (this.resolutionVersion !== this.vfs.version) {
      this.resolutionCaches = new WeakMap;
      this.resolutionVersion = this.vfs.version;
    }
    let cache = this.resolutionCaches.get(options);
    if (!cache) {
      cache = ts3.createModuleResolutionCache(this.root, (path) => this.vfs.key(path), options);
      this.resolutionCaches.set(options, cache);
    }
    return cache;
  }
  syntaxFile(path) {
    const impliedNodeFormat = ts3.getImpliedNodeFormatForFile(path, undefined, this.vfs.moduleResolutionHost(), this.editOptions);
    return this.sourceFile(path, { languageVersion: ts3.ScriptTarget.Latest, impliedNodeFormat }, this.editOptions, true);
  }
  looseParse(config) {
    const text = this.vfs.readFile(config);
    const cached = this.looseConfigs.get(this.vfs.key(config));
    if (cached && cached.text === text)
      return cached.parsed;
    let parsed;
    try {
      parsed = ts3.getParsedCommandLineOfConfigFile(config, undefined, this.vfs.parseConfigHost(() => {
        throw new Error("unparseable");
      }));
    } catch {
      parsed = undefined;
    }
    this.looseConfigs.set(this.vfs.key(config), { text, parsed });
    return parsed;
  }
  listsAny(config, paths) {
    if (!paths.length)
      return false;
    const parsed = this.looseParse(config);
    if (!parsed)
      fail("UNHANDLED_PROJECT_GRAPH", `${config} cannot be parsed, so it cannot be shown to be unaffected`);
    const listed = new Set(parsed.fileNames.map((path) => this.vfs.key(path)));
    return paths.some((path) => listed.has(this.vfs.key(path)));
  }
  isBaseConfig(config) {
    if (editorConfigName.test(basename4(config)))
      return false;
    if (!this.extendedConfigs) {
      this.extendedConfigs = new Set;
      for (const candidate of this.discovered) {
        const raw = ts3.readConfigFile(candidate, (path) => this.vfs.diskText(path) ?? undefined).config?.extends;
        for (const entry of Array.isArray(raw) ? raw : [raw]) {
          if (typeof entry !== "string" || !/^\.\.?[\\/]/.test(entry))
            continue;
          const path = resolve12(dirname9(candidate), entry);
          this.extendedConfigs.add(this.vfs.key(/\.json$/i.test(path) ? path : `${path}.json`));
        }
      }
    }
    if (!this.extendedConfigs.has(this.vfs.key(config)))
      return false;
    const own = ts3.readConfigFile(config, (path) => this.vfs.diskText(path) ?? undefined).config;
    return !own || !["files", "include", "references"].some((key) => (key in own));
  }
  importsAffected(config, paths) {
    if (!paths.length)
      return false;
    const parsed = this.looseParse(config);
    if (!parsed)
      fail("UNHANDLED_PROJECT_GRAPH", `${config} cannot be parsed, so it cannot be shown to be unaffected`);
    const listed = new Set(parsed.fileNames.map((path) => this.vfs.key(path)));
    if (!parsed.fileNames.length || paths.some((path) => listed.has(this.vfs.key(path))))
      return false;
    const program = ts3.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
      projectReferences: parsed.projectReferences,
      host: this.compilerHost(config, parsed.options, this.lightDiscovery)
    });
    const wanted = new Set(paths.map((path) => this.vfs.key(path)));
    const imports = program.getSourceFiles().some((sourceFile) => wanted.has(this.vfs.key(sourceFile.fileName)));
    if (imports && this.vfs.version === 0 && !this.lightDiscovery)
      this.discoveryPrograms.set(this.vfs.key(config), program);
    return imports;
  }
  assertNoUnhandledProjects(paths, useOriginal, checkImports = true) {
    const check = () => {
      for (const config of this.discovered) {
        if (this.participants.has(this.vfs.key(config)))
          continue;
        if (!this.isBaseConfig(config)) {
          const parsed = this.looseParse(config);
          if (!parsed)
            fail("UNHANDLED_PROJECT_GRAPH", `${config} cannot be parsed, so it cannot be shown to be unaffected`);
          const included = new Set(parsed.fileNames.map((path) => this.vfs.key(path)));
          const hit = paths.find((path) => included.has(this.vfs.key(path)));
          if (hit && editorConfigName.test(basename4(config))) {
            fail("UNHANDLED_PROJECT_GRAPH", `${config} also includes ${hit} but is not connected to ${this.sourceConfig} by project references`);
          }
          if (hit) {
            fail("UNHANDLED_PROJECT_GRAPH", `${config} also includes ${hit} but is neither a project in the planned graph nor a variant next to one; it would not be updated or validated`);
          }
        }
        if (checkImports && this.importsAffected(config, paths)) {
          fail("UNHANDLED_PROJECT_GRAPH", `${config} imports a changed file (${paths.map((path) => relative6(this.root, path)).join(", ")}) but was not part of the planned project graph`);
        }
      }
    };
    if (useOriginal)
      this.vfs.original(check);
    else
      check();
  }
  sourceFile(fileName, settings, options, syntaxOnly = false) {
    const text = this.vfs.readFile(fileName);
    if (text === undefined)
      return;
    const detail = typeof settings === "object" ? `${settings.languageVersion}|${settings.impliedNodeFormat}|${settings.jsDocParsingMode}` : String(settings);
    const key = `${this.vfs.key(fileName)}|${detail}|${options.moduleDetection}|${options.jsx}|${syntaxOnly}`;
    const versions = this.sourceFiles.get(key) ?? new Map;
    const cached = versions.get(text);
    if (cached)
      return cached;
    const kind = scriptKindFor(fileName);
    const file = syntaxOnly ? ts3.createSourceFile(fileName, text, settings, true, kind) : this.registry.acquireDocument(fileName, options, ts3.ScriptSnapshot.fromString(text), this.vfs.scriptVersion(fileName), kind, settings);
    if (!syntaxOnly && !this.parentedSources.has(file) && isInside(this.root, fileName) && !portablePath(fileName).split("/").includes("node_modules")) {
      attachSourceParents(file);
      this.parentedSources.add(file);
    }
    if (!syntaxOnly)
      this.registeredDocuments.push({ path: fileName, options, kind, format: file.impliedNodeFormat });
    if (versions.size >= 2)
      versions.delete(versions.keys().next().value);
    versions.set(text, file);
    this.sourceFiles.set(key, versions);
    return file;
  }
  stubs;
  externalStub(fileName, settings) {
    const detail = typeof settings === "object" ? `${settings.languageVersion}|${settings.impliedNodeFormat}` : String(settings);
    const key = `${this.vfs.key(fileName)}|${detail}`;
    let stub = this.stubs.get(key);
    if (!stub)
      this.stubs.set(key, stub = ts3.createSourceFile(fileName, "", settings, false, scriptKindFor(fileName)));
    return stub;
  }
  compilerHost(configPath, options, stubExternal = false) {
    const vfs = this.vfs;
    return {
      getSourceFile: (fileName, settings) => stubExternal && vfs.isExternal(fileName) && vfs.fileExists(fileName) ? this.externalStub(fileName, settings) : this.sourceFile(fileName, settings, options),
      getDefaultLibFileName: (options) => ts3.getDefaultLibFilePath(options),
      writeFile: () => {},
      getCurrentDirectory: () => dirname9(configPath),
      getCanonicalFileName: (fileName) => vfs.caseSensitive ? fileName : fileName.toLowerCase(),
      useCaseSensitiveFileNames: () => vfs.caseSensitive,
      getNewLine: () => `
`,
      fileExists: (path) => vfs.fileExists(path),
      readFile: (path) => vfs.readFile(path),
      readDirectory: (path, extensions, excludes, includes, depth) => vfs.readDirectory(path, extensions, excludes, includes, depth),
      directoryExists: (path) => vfs.directoryExists(path),
      getDirectories: (path) => vfs.getDirectories(path),
      realpath: (path) => vfs.realpath(path),
      getParsedCommandLine: (fileName) => this.participants.get(vfs.key(fileName))?.parsed ?? this.looseParse(fileName)
    };
  }
  validationPrograms() {
    return new Map(this.order.map((key) => {
      const item = this.participant(key);
      const discovered = this.discoveryPrograms.get(key);
      this.discoveryPrograms.delete(key);
      const comparable = (options) => ({ ...options, configFile: undefined });
      if (!this.vfs.changes().length && ![...this.participants.values()].some((item) => item.references.length) && discovered && sameValue(discovered.getRootFileNames(), item.parsed.fileNames) && sameValue(comparable(discovered.getCompilerOptions()), comparable(item.parsed.options)))
        return [key, discovered];
      return [key, ts3.createProgram({
        rootNames: item.parsed.fileNames,
        options: item.parsed.options,
        projectReferences: item.parsed.projectReferences,
        host: this.compilerHost(item.configPath, item.parsed.options)
      })];
    }));
  }
  prepareValidation(skipCleanBaseline = false) {
    if (this.nativeChecker && this.checkerMode === "ts7")
      return this.prepareNativeValidation(skipCleanBaseline);
    if ([...this.participants.values()].some((item) => item.references.length)) {
      const before = this.diagnostics();
      return () => ({ before, after: this.diagnostics() });
    }
    const beforePrograms = this.validationPrograms();
    const beforeGraphs = new Map([...beforePrograms].map(([key, program]) => [key, this.validationGraph(program)]));
    for (const [key, program] of beforePrograms) {
      const layout = this.computedOutputRoot(this.participant(key), program);
      if (layout !== undefined)
        this.layouts.set(key, layout);
    }
    return () => {
      const afterPrograms = this.validationPrograms();
      const only = new Map;
      let affected = 0;
      for (const [key, before] of beforePrograms) {
        const after = afterPrograms.get(key);
        const closure = this.validationClosure(before, after, beforeGraphs.get(key), this.validationGraph(after));
        if (closure) {
          only.set(key, closure);
          affected += closure.size;
        }
      }
      const beforeRecords = [], afterRecords = [];
      const afterLayouts = new Map;
      for (const key of this.order) {
        afterRecords.push(this.diagnostics(new Map([[key, afterPrograms.get(key)]]), only));
        for (const [config, layout] of this.layouts)
          afterLayouts.set(config, layout);
        afterPrograms.delete(key);
      }
      if (!skipCleanBaseline || afterRecords.some((records) => records.length)) {
        for (const key of this.order) {
          beforeRecords.push(this.vfs.original(() => this.diagnostics(new Map([[key, beforePrograms.get(key)]]), only, true)));
          beforePrograms.delete(key);
        }
      }
      beforePrograms.clear();
      beforeGraphs.clear();
      this.layouts = afterLayouts;
      const merge = (groups) => {
        const merged = new Map;
        for (const group of groups) {
          const counts = new Map;
          for (const record of group) {
            const key = JSON.stringify(record), count = (counts.get(key) ?? 0) + 1;
            counts.set(key, count);
            if (count > (merged.get(key)?.count ?? 0))
              merged.set(key, { record, count });
          }
        }
        return [...merged.values()].flatMap(({ record, count }) => Array.from({ length: count }, () => record)).sort((a, b) => a.file.localeCompare(b.file) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
      };
      return { before: merge(beforeRecords), after: merge(afterRecords), affected: only.size ? affected : undefined, affectedProjects: only.size };
    };
  }
  prepareNativeValidation(skipCleanBaseline) {
    const original = new Map([...this.participants].map(([key, item]) => [key, item.parsed]));
    for (const [key, layout] of this.outputLayouts())
      this.layouts.set(key, layout);
    return () => {
      const after = this.diagnostics();
      if (skipCleanBaseline && !after.length)
        return { before: [], after };
      const planned = new Map([...this.participants].map(([key, item]) => [key, item.parsed]));
      const layouts = new Map(this.layouts);
      const before = this.vfs.original(() => {
        for (const [key, item] of this.participants)
          item.parsed = original.get(key);
        try {
          return this.diagnostics();
        } finally {
          for (const [key, item] of this.participants)
            item.parsed = planned.get(key);
          this.layouts = layouts;
        }
      });
      return { before, after };
    };
  }
  validationGraph(program) {
    const options = program.getCompilerOptions();
    const host = this.vfs.moduleResolutionHost();
    const cache = ts3.createModuleResolutionCache(this.root, (path) => this.vfs.key(path), options);
    const graph = new Map;
    for (const source of program.getSourceFiles()) {
      if (!this.validationSource(source))
        continue;
      const dependencies = moduleSpecifiers(source).map((specifier) => {
        const mode = program.getModeForUsageLocation(source, specifier);
        const resolved = ts3.resolveModuleName(specifier.text, source.fileName, options, host, cache, undefined, mode).resolvedModule;
        return resolved ? this.vfs.key(resolved.resolvedFileName) : undefined;
      });
      for (const reference of source.referencedFiles)
        dependencies.push(this.vfs.key(resolve12(dirname9(source.fileName), reference.fileName)));
      graph.set(this.vfs.key(source.fileName), dependencies);
    }
    return graph;
  }
  validationSource(source) {
    const path = resolve12(source.fileName);
    if (!isInside(this.root, path)) {
      if (!source.isDeclarationFile)
        fail("PROJECT_SCOPE_INCOMPLETE", `user source outside ${this.root}: ${path}${workspaceRootHint(this.root, [path])}`);
      return false;
    }
    return !portablePath(path).split("/").includes("node_modules") && !this.vfs.isHidden(path);
  }
  validationClosure(before, after, oldGraph, newGraph) {
    const changes = this.vfs.changes();
    const changed = new Set([...changes.map((change) => change.path), ...this.vfs.ephemeralPaths()].map((path) => this.vfs.key(path)));
    const options = (program) => Object.fromEntries(Object.entries(program.getCompilerOptions()).filter(([key]) => key !== "configFile"));
    if (!sameValue(options(before), options(after)))
      return;
    const oldRoots = new Set(before.getRootFileNames().map((path) => this.vfs.key(path)));
    const newRoots = new Set(after.getRootFileNames().map((path) => this.vfs.key(path)));
    if ([...oldRoots, ...newRoots].some((path) => oldRoots.has(path) !== newRoots.has(path) && !changed.has(path)))
      return;
    if (changes.some((change) => configName.test(basename4(change.path))))
      return;
    for (const change of changes.filter((change) => basename4(change.path) === "package.json")) {
      if (change.before === null || change.after === null)
        return;
      const withoutExports = (text) => {
        try {
          const { exports: _exports, ...rest } = JSON.parse(text ?? "{}");
          return rest;
        } catch {
          return;
        }
      };
      const oldShape = withoutExports(change.before), newShape = withoutExports(change.after);
      if (oldShape === undefined || newShape === undefined || !sameValue(oldShape, newShape))
        return;
    }
    const importers = new Map;
    const pending = [...changed];
    for (const graph of [oldGraph, newGraph])
      for (const [file, dependencies] of graph) {
        for (const target of dependencies) {
          if (!target)
            continue;
          const callers = importers.get(target) ?? new Set;
          callers.add(file);
          importers.set(target, callers);
        }
      }
    for (const file of new Set([...oldGraph.keys(), ...newGraph.keys()])) {
      if (!sameValue(oldGraph.get(file), newGraph.get(file)))
        pending.push(file);
    }
    const oldFiles = new Set(before.getSourceFiles().map((source) => this.vfs.key(source.fileName)));
    const newFiles = new Set(after.getSourceFiles().map((source) => this.vfs.key(source.fileName)));
    for (const program of [before, after])
      for (const source of program.getSourceFiles()) {
        const key = this.vfs.key(source.fileName);
        if (!changed.has(key) && oldFiles.has(key) === newFiles.has(key))
          continue;
        if (!/\.json$/i.test(source.fileName) && (changed.has(key) && source.isDeclarationFile || !ts3.isExternalModule(source) || hasAmbientEffect(source)))
          return;
      }
    const closure = new Set;
    while (pending.length) {
      const file = pending.pop();
      if (closure.has(file))
        continue;
      closure.add(file);
      pending.push(...importers.get(file) ?? []);
    }
    return new Set([...closure].filter((file) => oldGraph.has(file) || newGraph.has(file)));
  }
  diagnostics(programs, only, baseline = false, inSession = false) {
    if (this.nativeChecker?.withSession && !inSession) {
      const configs = this.order.filter((key) => !programs || programs.has(key)).map((key) => this.participant(key).configPath);
      return this.nativeChecker.withSession(configs, () => this.diagnostics(programs, only, baseline, true));
    }
    const vfs = this.vfs;
    vfs.clearGenerated();
    this.layouts = new Map;
    const referenced = new Set([...this.participants.values()].flatMap((item) => item.references.map((path) => vfs.key(path))));
    const merged = new Map;
    for (const key of this.order.filter((key) => !programs || programs.has(key))) {
      const item = this.participants.get(key);
      const program = programs?.get(key) ?? ts3.createProgram({
        rootNames: item.parsed.fileNames,
        options: item.parsed.options,
        projectReferences: item.parsed.projectReferences,
        host: this.compilerHost(item.configPath, item.parsed.options)
      });
      const collect = () => {
        const records = [];
        const add = (diagnostic) => {
          if (diagnostic.category !== ts3.DiagnosticCategory.Error)
            return;
          const record = {
            file: diagnostic.file ? resolve12(diagnostic.file.fileName) : item.configPath,
            code: `TS${diagnostic.code}`,
            message: flatten(diagnostic)
          };
          records.push(record);
        };
        program.getOptionsDiagnostics().forEach(add);
        program.getGlobalDiagnostics().forEach(add);
        for (const sourceFile of program.getSourceFiles()) {
          const path = resolve12(sourceFile.fileName);
          if (!isInside(this.root, path)) {
            if (!sourceFile.isDeclarationFile)
              fail("PROJECT_SCOPE_INCOMPLETE", `${item.configPath} uses user source outside ${this.root}: ${path}${workspaceRootHint(this.root, [path])}`);
            continue;
          }
          if (portablePath(path).split("/").includes("node_modules") || vfs.isHidden(path))
            continue;
          if (only?.has(key) && !only.get(key).has(vfs.key(path)))
            continue;
          program.getSyntacticDiagnostics(sourceFile).forEach(add);
          program.getSemanticDiagnostics(sourceFile).forEach(add);
          if (program.getCompilerOptions().declaration || program.getCompilerOptions().composite)
            program.getDeclarationDiagnostics(sourceFile).forEach(add);
        }
        return records;
      };
      let records = this.nativeChecker && this.checkerMode === "ts7" ? [] : baseline && !referenced.size ? baselineDiagnostics(this.root, item.configPath, program, only?.get(key), vfs.inputs, collect) : collect();
      if (this.nativeChecker)
        records = compareWorkspaceDiagnostics(this.nativeChecker, vfs, item.configPath, item.parsed.options, program.getSourceFiles().filter((source) => this.validationSource(source)).map((source) => resolve12(source.fileName)), records, only?.get(key));
      const counts = new Map;
      for (const record of records) {
        const recordKey = `${record.file}\x00${record.code}\x00${record.message}`;
        const entry = counts.get(recordKey) ?? { record, count: 0 };
        entry.count += 1;
        counts.set(recordKey, entry);
      }
      for (const [recordKey, entry] of counts) {
        if ((merged.get(recordKey)?.count ?? 0) < entry.count)
          merged.set(recordKey, entry);
      }
      const layout = this.computedOutputRoot(item, program);
      if (layout !== undefined)
        this.layouts.set(key, layout);
      if (referenced.has(key)) {
        program.emit(undefined, (fileName, text) => {
          if (isDeclarationPath(fileName))
            vfs.writeGenerated(fileName, text);
        }, undefined, true);
      }
    }
    return [...merged.values()].flatMap(({ record, count }) => Array.from({ length: count }, () => record)).sort((a, b) => a.file.localeCompare(b.file) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
  }
  outputLayouts() {
    const layouts = new Map;
    for (const [key, item] of this.participants) {
      const options = item.parsed.options;
      if (options.noEmit || options.rootDir || options.composite || !options.outDir && !options.declarationDir)
        continue;
      const program = ts3.createProgram({ rootNames: item.parsed.fileNames, options, host: this.compilerHost(item.configPath, options) });
      const layout = this.computedOutputRoot(item, program);
      if (layout !== undefined)
        layouts.set(key, layout);
    }
    return layouts;
  }
  computedOutputRoot(item, program) {
    const options = item.parsed.options;
    if (options.noEmit || options.rootDir || options.composite || !options.outDir && !options.declarationDir)
      return;
    const directories = program.getSourceFiles().filter((sourceFile) => !sourceFile.isDeclarationFile && !program.isSourceFileFromExternalLibrary(sourceFile)).filter((sourceFile) => !(options.noEmitForJsFiles && /\.[cm]?jsx?$/i.test(sourceFile.fileName))).filter((sourceFile) => !/\.json$/i.test(sourceFile.fileName) || options.outDir).map((sourceFile) => portablePath(dirname9(resolve12(sourceFile.fileName))).split("/"));
    if (!directories.length)
      return;
    let common = directories[0];
    for (const parts of directories.slice(1)) {
      let length = 0;
      while (length < common.length && length < parts.length && (this.vfs.caseSensitive ? common[length] === parts[length] : common[length].toLowerCase() === parts[length].toLowerCase()))
        length += 1;
      common = common.slice(0, length);
    }
    return common.length === 1 && /^[A-Za-z]:$/.test(common[0]) ? `${common[0]}/` : common.join("/") || "/";
  }
  updateConfigLists(renames, deletions, substitutions = new Map) {
    const vfs = this.vfs;
    for (const item of [...this.participants.values()].sort((a, b) => a.configPath.localeCompare(b.configPath))) {
      const configRenames = [...substitutions.get(vfs.key(item.configPath)) ?? [], ...renames];
      const text = vfs.readFile(item.configPath);
      if (text === undefined)
        continue;
      const json = ts3.parseJsonText(item.configPath, text);
      const object = json.statements[0]?.expression;
      if (!object || !ts3.isObjectLiteralExpression(object))
        continue;
      const directory = dirname9(item.configPath);
      const changes = [];
      for (const property of object.properties) {
        if (!ts3.isPropertyAssignment(property) || !ts3.isStringLiteral(property.name))
          continue;
        if (!["files", "include"].includes(property.name.text) || !ts3.isArrayLiteralExpression(property.initializer))
          continue;
        const elements = property.initializer.elements;
        const removed = new Set;
        elements.forEach((element, index) => {
          if (!ts3.isStringLiteral(element) || /[*?]/.test(element.text))
            return;
          const absolute = resolve12(directory, element.text);
          const start = element.getStart(json);
          const rename = configRenames.find(([from]) => vfs.samePath(from, absolute));
          if (rename) {
            const relativePath = portablePath(relative6(directory, rename[1]));
            const spec = element.text.startsWith("./") && !relativePath.startsWith("../") ? `./${relativePath}` : relativePath;
            const quote = text[start];
            changes.push({ span: { start, length: element.end - start }, newText: `${quote}${JSON.stringify(spec).slice(1, -1)}${quote}` });
          } else if (deletions.some((path) => vfs.samePath(path, absolute))) {
            removed.add(index);
          }
        });
        for (let index = 0;index < elements.length; index++) {
          if (!removed.has(index))
            continue;
          const first = index;
          while (removed.has(index + 1))
            index += 1;
          const all = first === 0 && index === elements.length - 1;
          const start = all ? property.initializer.getStart(json) + 1 : first === 0 ? elements[first].getStart(json) : elements[first - 1].end;
          const end = all ? property.initializer.end - 1 : first === 0 ? elements[index + 1].getStart(json) : elements[index].end;
          changes.push({ span: { start, length: end - start }, newText: "" });
        }
      }
      if (changes.length)
        vfs.write(item.configPath, applyTextChanges(text, changes));
    }
  }
  addToFiles(configPath, path) {
    const text = this.vfs.readFile(configPath);
    const json = ts3.parseJsonText(configPath, text);
    const object = json.statements[0]?.expression;
    if (!object || !ts3.isObjectLiteralExpression(object))
      return false;
    const files = object.properties.find((property) => ts3.isPropertyAssignment(property) && ts3.isStringLiteral(property.name) && property.name.text === "files");
    if (!files || !ts3.isArrayLiteralExpression(files.initializer))
      return false;
    const elements = files.initializer.elements;
    const relativePath = portablePath(relative6(dirname9(configPath), path));
    const dotted = elements.some((element) => ts3.isStringLiteral(element) && element.text.startsWith("./"));
    const literal = JSON.stringify(dotted && !relativePath.startsWith("../") ? `./${relativePath}` : relativePath);
    let change;
    if (elements.length) {
      const last = elements[elements.length - 1];
      const lastStart = last.getStart(json);
      const lineStart = text.lastIndexOf(`
`, lastStart) + 1;
      const multiline = text.slice(elements[0].getStart(json), lastStart).includes(`
`) || text.slice(files.initializer.getStart(json), elements[0].getStart(json)).includes(`
`);
      const indent = text.slice(lineStart, lastStart);
      const separator = multiline && /^\s*$/.test(indent) ? `,${text.includes(`\r
`) ? `\r
` : `
`}${indent}` : ", ";
      change = { span: { start: last.end, length: 0 }, newText: `${separator}${literal}` };
    } else {
      change = { span: { start: files.initializer.getStart(json) + 1, length: 0 }, newText: literal };
    }
    this.vfs.write(configPath, applyTextChanges(text, [change]));
    return true;
  }
}
function applyTextChanges(text, changes) {
  const ordered = changes.map((change, index) => ({ change, index })).sort((a, b) => b.change.span.start - a.change.span.start || b.index - a.index).map(({ change }) => change);
  let boundary = text.length;
  for (const change of ordered) {
    const end = change.span.start + change.span.length;
    if (change.span.start < 0 || end > text.length)
      fail("INVALID_EDIT", "TypeScript returned an out-of-bounds edit");
    if (end > boundary)
      fail("OVERLAPPING_EDITS", "TypeScript returned overlapping edits");
    text = text.slice(0, change.span.start) + change.newText + text.slice(end);
    boundary = change.span.start;
  }
  return text;
}
var baseFormatOptions, configName, editorConfigName, sharedOptionKeys, mockObjects, mockMethods, specifiersBySource, warmDocuments;
var init_typescript_workspace = __esm(() => {
  init_typescript_diagnostics_cache();
  init_typescript_vfs();
  init_typescript_paths();
  init_typescript_ts7();
  baseFormatOptions = {
    indentSize: 2,
    tabSize: 2,
    newLineCharacter: `
`,
    convertTabsToSpaces: true,
    indentStyle: ts3.IndentStyle.Smart,
    insertSpaceAfterCommaDelimiter: true,
    insertSpaceAfterSemicolonInForStatements: true,
    insertSpaceBeforeAndAfterBinaryOperators: true,
    insertSpaceAfterKeywordsInControlFlowStatements: true,
    insertSpaceAfterFunctionKeywordForAnonymousFunctions: false,
    insertSpaceBeforeFunctionParenthesis: false,
    insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
    semicolons: ts3.SemicolonPreference.Insert
  };
  configName = /^(tsconfig|jsconfig)(\..+)?\.json$/;
  editorConfigName = /^(tsconfig|jsconfig)\.json$/;
  sharedOptionKeys = [
    "module",
    "moduleResolution",
    "moduleDetection",
    "allowJs",
    "jsx",
    "jsxImportSource",
    "esModuleInterop",
    "allowSyntheticDefaultImports",
    "resolveJsonModule",
    "rewriteRelativeImportExtensions",
    "allowArbitraryExtensions",
    "verbatimModuleSyntax",
    "preserveSymlinks",
    "experimentalDecorators",
    "typeRoots"
  ];
  mockObjects = new Set(["vi", "vitest", "jest"]);
  mockMethods = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock", "requireActual", "requireMock", "createMockFromModule"]);
  specifiersBySource = new WeakMap;
});

// src/backends/typescript-mock-dedupe.ts
import ts4 from "typescript";
function key(node, source) {
  const scanner = ts4.createScanner(ts4.ScriptTarget.Latest, true, ts4.LanguageVariant.Standard, node.getText(source));
  const tokens = [];
  for (let kind = scanner.scan();kind !== ts4.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    tokens.push([kind, kind === ts4.SyntaxKind.StringLiteral ? scanner.getTokenValue() : scanner.getTokenText()]);
  }
  return JSON.stringify(tokens);
}
function dedupeMappedMocks(file, text, targets) {
  const source = ts4.createSourceFile(file, text, ts4.ScriptTarget.Latest, true);
  const removed = new Set;
  const visit = (node) => {
    if (removed.has(node))
      return;
    if (ts4.isSourceFile(node) || ts4.isBlock(node)) {
      const seen = new Map;
      for (const statement of node.statements) {
        const call = ts4.isExpressionStatement(statement) ? statement.expression : undefined;
        if (!call || !isModuleMockCall(call) || !ts4.isPropertyAccessExpression(call.expression) || !["mock", "doMock"].includes(call.expression.name.text)) {
          seen.clear();
          continue;
        }
        const factory = call.arguments[1];
        if (call.arguments.length > 2 || factory && !ts4.isArrowFunction(factory) && !ts4.isFunctionExpression(factory) && !ts4.isIdentifier(factory)) {
          seen.clear();
          continue;
        }
        if (!targets.has(call.arguments[0].text))
          continue;
        const module = call.arguments[0].text;
        const signature = key(call, source);
        if (seen.get(module) === signature)
          removed.add(statement);
        else
          seen.set(module, signature);
      }
    }
    ts4.forEachChild(node, visit);
  };
  visit(source);
  for (const statement of [...removed].sort((a, b) => b.pos - a.pos)) {
    text = text.slice(0, statement.getStart(source)) + text.slice(statement.end);
  }
  return text;
}
var init_typescript_mock_dedupe = __esm(() => {
  init_typescript_workspace();
});

// src/backends/typescript-package-inputs.ts
import ts5 from "typescript";
import { existsSync as existsSync3 } from "node:fs";
import { dirname as dirname10, resolve as resolve13 } from "node:path";
function packageAt(root, file, sys = ts5.sys) {
  for (let directory = dirname10(file);isInside(root, directory); directory = dirname10(directory)) {
    const path = resolve13(directory, "package.json");
    const text = sys.readFile(path);
    if (text !== undefined) {
      try {
        return { path, directory, json: JSON.parse(text) };
      } catch {
        fail("INVALID_PACKAGE", path);
      }
    }
    if (directory === root)
      break;
  }
  return;
}
function installationHint(root, file) {
  const pkg = packageAt(root, file);
  if (!pkg || existsSync3(resolve13(pkg.directory, "node_modules")))
    return "";
  return `; ${pkg.directory}/node_modules is missing; run the workspace package manager install from ${root}`;
}
var init_typescript_package_inputs = __esm(() => {
  init_typescript_vfs();
});

// src/backends/typescript-retarget-mocks.ts
import ts6 from "typescript";
import { resolve as resolve14 } from "node:path";
function mockCalls(source, name) {
  return moduleSpecifiers(source).filter((specifier) => specifier.text === name && isModuleMockCall(specifier.parent) && ts6.isPropertyAccessExpression(specifier.parent.expression) && ["mock", "doMock"].includes(specifier.parent.expression.name.text)).map((specifier) => specifier.parent);
}
function affectedMockFiles(context, affected, from) {
  if (!affected.length)
    return [];
  const program = context.service.getProgram();
  const files = program.getSourceFiles().filter((source) => isInside(context.root, resolve14(source.fileName)) && !source.fileName.replaceAll("\\", "/").includes("/node_modules/"));
  const callers = new Map;
  const caches = new Map;
  for (const source of files) {
    const options = context.optionsFor?.(source) ?? context.options;
    let cache = caches.get(options);
    if (!cache) {
      cache = ts6.createModuleResolutionCache(context.root, (path) => path, options);
      caches.set(options, cache);
    }
    for (const specifier of moduleSpecifiers(source)) {
      if (isModuleMockCall(specifier.parent) && ts6.isPropertyAccessExpression(specifier.parent.expression) && !["importActual", "importMock", "requireActual", "requireMock"].includes(specifier.parent.expression.name.text))
        continue;
      const mode = ts6.getModeForUsageLocation(source, specifier, options);
      const target = ts6.resolveModuleName(specifier.text, source.fileName, options, context.sys ?? ts6.sys, cache, undefined, mode).resolvedModule;
      if (!target)
        continue;
      const key = resolve14(target.resolvedFileName);
      if (!callers.has(key))
        callers.set(key, new Set);
      callers.get(key).add(resolve14(source.fileName));
    }
  }
  const reached = new Set(affected.map((source) => resolve14(source.fileName)));
  const queue = [...reached];
  for (let index = 0;index < queue.length; index++) {
    for (const caller of callers.get(queue[index]) ?? []) {
      if (reached.has(caller))
        continue;
      reached.add(caller);
      queue.push(caller);
    }
  }
  return files.filter((source) => reached.has(resolve14(source.fileName)) && mockCalls(source, from).length).map((source) => source.fileName).sort();
}
function addParallelMocks(context, files, request) {
  const added = [];
  for (const file of files) {
    const source = context.service.getProgram().getSourceFile(file);
    if (mockCalls(source, request.to).length)
      continue;
    const edits = [];
    for (const call of mockCalls(source, request.from)) {
      const statement = call.parent;
      if (!ts6.isExpressionStatement(statement) || !ts6.isSourceFile(statement.parent) && !ts6.isBlock(statement.parent)) {
        fail("UNSUPPORTED_MOCK_CALL", `${file}: --mocks add requires standalone mock statements in a source file or block; use --mocks report`);
      }
      const specifier = call.arguments[0];
      const options = context.optionsFor?.(source) ?? context.options;
      const mode = ts6.getModeForUsageLocation(source, specifier, options);
      if (!ts6.resolveModuleName(request.to, file, options, context.sys ?? ts6.sys, undefined, undefined, mode).resolvedModule) {
        fail("TARGET_UNRESOLVED", `${file} (${request.to})`);
      }
      const start = call.getStart(source);
      const quote = source.text[specifier.getStart(source)];
      const escaped = JSON.stringify(request.to).slice(1, -1);
      const literal = quote === '"' ? JSON.stringify(request.to) : quote + escaped.replaceAll(quote, (match) => `\\${match}`).replaceAll("${", quote === "`" ? "\\${" : "${") + quote;
      const text = source.text.slice(start, specifier.getStart(source)) + literal + source.text.slice(specifier.end, call.end);
      const indent = source.text.slice(source.text.lastIndexOf(`
`, statement.getStart(source)) + 1, statement.getStart(source)).match(/^[\t ]*/)?.[0] ?? "";
      const tail = source.text.slice(statement.end);
      const trivia = /^(?:[\t ]|\/\*[^]*?\*\/)*(?:\/\/[^\r\n]*)?(?=\r?\n|$)/.exec(tail)?.[0];
      const end = statement.end + (trivia?.length ?? 0);
      const prefix = trivia === undefined && !source.text.slice(statement.getStart(source), statement.end).endsWith(";") ? ";" : "";
      edits.push({ start: end, text: `${prefix}${eolOf(source.text)}${indent}${text};` });
    }
    let text = source.text;
    for (const edit of edits.sort((a, b) => b.start - a.start))
      text = text.slice(0, edit.start) + edit.text + text.slice(edit.start);
    if (edits.length) {
      context.onInsert?.(file, source, edits);
      context.setText(file, text);
      added.push(file);
    }
  }
  return added;
}
var init_typescript_retarget_mocks = __esm(() => {
  init_typescript_vfs();
  init_typescript_workspace();
});

// src/backends/typescript-retarget-import.ts
import ts7 from "typescript";
import { statSync as statSync3 } from "node:fs";
import { resolve as resolve15 } from "node:path";
function identifier(name) {
  const scanner = ts7.createScanner(ts7.ScriptTarget.Latest, false, ts7.LanguageVariant.Standard, name);
  return scanner.scan() === ts7.SyntaxKind.Identifier && scanner.getTokenText() === name && scanner.scan() === ts7.SyntaxKind.EndOfFileToken;
}
function mappedName(request, name) {
  return request?.map && Object.hasOwn(request.map, name) ? request.map[name] : undefined;
}
function validate(request) {
  if (!request.from || !request.to)
    fail("INVALID_REQUEST", "retarget-import requires from and to");
  if (request.from.includes("*") || request.to.includes("*"))
    fail("UNSUPPORTED_SPECIFIER", "retarget-import requires exact specifiers; wildcard prefixes are unsupported");
  if (request.from === request.to)
    fail("INVALID_REQUEST", "from and to must differ");
  if (request.mocks !== undefined && !["report", "add"].includes(request.mocks))
    fail("INVALID_REQUEST", "mocks must be report or add");
  if (request.only && (!Array.isArray(request.only) || !request.only.length || request.only.some((name) => !name))) {
    fail("INVALID_REQUEST", "only must contain pre-map export names");
  }
  for (const [from, to] of Object.entries(request.map ?? {})) {
    if (!identifier(from) || !identifier(to))
      fail("INVALID_NAME", `invalid export mapping ${from}=${to}`);
  }
}
function members(node) {
  if (ts7.isImportDeclaration(node)) {
    const bindings = node.importClause?.namedBindings;
    return bindings && ts7.isNamedImports(bindings) ? bindings.elements : undefined;
  }
  return node.exportClause && ts7.isNamedExports(node.exportClause) ? node.exportClause.elements : undefined;
}
function selections(source, request) {
  const found = [];
  for (const node of source.statements) {
    if (!ts7.isImportDeclaration(node) && !ts7.isExportDeclaration(node) || !node.moduleSpecifier || !ts7.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== request.from)
      continue;
    const list = members(node);
    if (request.only && ts7.isImportDeclaration(node) && (node.importClause?.name || node.importClause?.namedBindings && ts7.isNamespaceImport(node.importClause.namedBindings))) {
      fail("UNSUPPORTED_SELECTION", `${source.fileName}: --only cannot select default or namespace imports`);
    }
    const selected = list?.filter((item) => !request.only || request.only.includes((item.propertyName ?? item.name).text));
    if (request.only && !selected?.length)
      continue;
    found.push({ declaration: node, target: request.to, members: selected });
  }
  return found;
}
function selectedFiles(context, request) {
  const scope = resolve15(request.file);
  if (!isInside(context.root, scope))
    fail("OUTSIDE_ROOT", scope);
  let directory = true;
  if (!request.projectScope) {
    try {
      directory = statSync3(scope).isDirectory();
    } catch {
      fail("FILE_NOT_FOUND", scope);
    }
  }
  const files = context.service.getProgram().getSourceFiles().filter((source) => !context.service.getProgram().isSourceFileDefaultLibrary(source) && !source.fileName.replaceAll("\\", "/").includes("/node_modules/") && isInside(context.root, resolve15(source.fileName)) && (request.projectScope || (directory ? isInside(scope, resolve15(source.fileName)) : resolve15(source.fileName) === scope)));
  if (!directory && !files.length)
    fail("FILE_NOT_IN_PROJECT", scope);
  return files.sort((a, b) => a.fileName.localeCompare(b.fileName));
}
function renameBindings(context, file, request) {
  const renamed = new Set;
  for (;; ) {
    const source = context.service.getProgram().getSourceFile(file);
    const match = selections(source, request).flatMap((selection, index) => (selection.members ?? []).map((member) => ({
      item: member,
      key: `${index}:${members(selection.declaration).indexOf(member)}`
    }))).find(({ item }) => ts7.isImportSpecifier(item) && !item.propertyName && mappedName(request, item.name.text) && mappedName(request, item.name.text) !== item.name.text);
    if (!match)
      return renamed;
    const { item, key } = match;
    renamed.add(key);
    const end = item.name.end;
    context.setText(file, source.text.slice(0, end) + ` as ${item.name.text}` + source.text.slice(end));
    context.rename(file, end + 4, mappedName(request, item.name.text));
  }
}
function replace(text, edits) {
  let boundary = text.length;
  for (const edit of edits.sort((a, b) => b.span.start - a.span.start)) {
    const end = edit.span.start + edit.span.length;
    if (end > boundary)
      fail("OVERLAPPING_EDITS", "retarget-import declarations overlap");
    text = text.slice(0, edit.span.start) + edit.newText + text.slice(end);
    boundary = edit.span.start;
  }
  return text;
}
function memberText(source, list, item, request, collapseAlias = false) {
  const index = list.indexOf(item);
  const limit = list[index + 1]?.pos ?? item.parent.end - 1;
  let raw = source.text.slice(item.pos, limit);
  const edits = [];
  const scanner = ts7.createScanner(ts7.ScriptTarget.Latest, false, ts7.LanguageVariant.Standard, raw);
  while (scanner.scan() !== ts7.SyntaxKind.EndOfFileToken) {
    if (scanner.getToken() === ts7.SyntaxKind.CommaToken)
      edits.push({ span: { start: scanner.getTokenPos(), length: 1 }, newText: "" });
  }
  const imported = item.propertyName ?? item.name;
  const mapped = mappedName(request, imported.text);
  if (mapped && mapped !== imported.text) {
    edits.push({ span: { start: imported.getStart(source) - item.pos, length: imported.end - imported.getStart(source) }, newText: mapped });
    if (collapseAlias && ts7.isImportSpecifier(item) && item.propertyName && item.name.text === mapped) {
      const between = source.text.slice(item.propertyName.end, item.name.end);
      if (!between.includes("/*") && !between.includes("//"))
        edits.push({ span: { start: item.propertyName.end - item.pos, length: item.name.end - item.propertyName.end }, newText: "" });
    }
  }
  raw = replace(raw, edits).trim();
  return raw.includes("//") ? raw + (source.text.includes(`\r
`) ? `\r
` : `
`) : raw;
}
function memberTokens(text) {
  const tokens = [], comments = [];
  const scanner = ts7.createScanner(ts7.ScriptTarget.Latest, false, ts7.LanguageVariant.Standard, text);
  while (scanner.scan() !== ts7.SyntaxKind.EndOfFileToken) {
    const kind = scanner.getToken();
    if (kind === ts7.SyntaxKind.SingleLineCommentTrivia)
      comments.push(scanner.getTokenText() + (text.includes(`\r
`) ? `\r
` : `
`));
    else if (kind === ts7.SyntaxKind.MultiLineCommentTrivia)
      comments.push(scanner.getTokenText() + " ");
    else if (kind > ts7.SyntaxKind.LastTriviaToken)
      tokens.push(scanner.getTokenText());
  }
  return { key: JSON.stringify(tokens), comments: comments.join("") };
}
function mergeMembers(existing, moved) {
  for (const text of moved) {
    const { key, comments } = memberTokens(text);
    const index = existing.findIndex((item) => memberTokens(item).key === key);
    if (index < 0)
      existing.push(text);
    else if (comments)
      existing[index] = comments + existing[index];
  }
}
function namedText(items) {
  return `{ ${items.join(", ")} }`;
}
function typeOnly(node) {
  return ts7.isImportDeclaration(node) ? !!node.importClause?.isTypeOnly : node.isTypeOnly;
}
function attributes(node, source) {
  return node.attributes?.getText(source) ?? "";
}
function outerComments(source, node, named) {
  const start = node.getStart(source), text = node.getText(source);
  const outside = text.slice(0, named.getStart(source) - start) + text.slice(named.end - start);
  return memberTokens(outside).comments;
}
function transformFile(source, request, renamed) {
  const replacements = new Map;
  const additions = new Map;
  const newline = source.text.includes(`\r
`) ? `\r
` : `
`;
  for (const [index, selection] of selections(source, request).entries()) {
    const node = selection.declaration, module = node.moduleSpecifier;
    const list = members(node), chosen = selection.members;
    const quote = source.text[module.getStart(source)];
    const literal = quote + selection.target.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`) + quote;
    const edit = [{ span: { start: module.getStart(source) - node.getStart(source), length: module.getWidth(source) }, newText: literal }];
    if (!list || !chosen?.length) {
      replacements.set(node, replace(node.getText(source), edit));
      continue;
    }
    const remaining = list.filter((item) => !chosen.includes(item));
    const moved = chosen.map((item) => memberText(source, list, item, request, renamed.has(`${index}:${list.indexOf(item)}`)));
    const named = list[0].parent;
    const pureNamed = ts7.isImportDeclaration(node) && !node.importClause?.name;
    const merge = pureNamed ? source.statements.find((other) => ts7.isImportDeclaration(other) && ts7.isStringLiteral(other.moduleSpecifier) && other.moduleSpecifier.text === selection.target && !!other.importClause && (!other.importClause.namedBindings || ts7.isNamedImports(other.importClause.namedBindings)) && !(other.importClause.isTypeOnly && other.importClause.name) && typeOnly(other) === typeOnly(node) && attributes(other, source) === attributes(node, source)) : undefined;
    if (merge) {
      const existing = members(merge) ?? [];
      const texts = additions.get(merge) ?? existing.map((item) => memberText(source, existing, item));
      mergeMembers(texts, moved);
      additions.set(merge, texts);
    }
    if (remaining.length) {
      const original = replace(node.getText(source), [{ span: { start: named.getStart(source) - node.getStart(source), length: named.getWidth(source) }, newText: namedText(remaining.map((item) => memberText(source, list, item))) }]);
      const kind = ts7.isImportDeclaration(node) ? "import" : "export";
      const suffix = source.text.slice(module.end, node.end);
      replacements.set(node, original + (merge ? "" : `${newline}${kind}${typeOnly(node) ? " type" : ""} ${namedText(moved)} from ${literal}${suffix}`));
    } else if (merge)
      replacements.set(node, outerComments(source, node, named));
    else if (!chosen.some((item) => mappedName(request, (item.propertyName ?? item.name).text))) {
      replacements.set(node, replace(node.getText(source), edit));
    } else {
      edit.push({ span: { start: named.getStart(source) - node.getStart(source), length: named.getWidth(source) }, newText: namedText(moved) });
      replacements.set(node, replace(node.getText(source), edit));
    }
  }
  for (const [node, texts] of additions) {
    const named = node.importClause.namedBindings;
    const start = node.getStart(source);
    const span = named ? { start: named.getStart(source) - start, length: named.getWidth(source) } : { start: node.importClause.name.end - start, length: 0 };
    replacements.set(node, replace(node.getText(source), [{ span, newText: (named ? "" : ", ") + namedText(texts) }]));
  }
  const dynamic = request.only ? [] : dynamicSpecifiers(source, request.from).map((specifier) => ({
    span: { start: specifier.getStart(source), length: specifier.getWidth(source) },
    newText: JSON.stringify(request.to)
  }));
  return replace(source.text, [...replacements].map(([node, newText]) => ({ span: { start: node.getStart(source), length: node.getWidth(source) }, newText })).concat(dynamic));
}
function dynamicSpecifiers(source, from) {
  return moduleSpecifiers(source).filter((specifier) => specifier.text === from && ts7.isCallExpression(specifier.parent) && specifier.parent.expression.kind === ts7.SyntaxKind.ImportKeyword);
}
function retargetImports(context, request) {
  validate(request);
  const affected = selectedFiles(context, request).filter((source) => selections(source, request).length || !request.only && dynamicSpecifiers(source, request.from).length);
  const unresolved = [];
  const cache = ts7.createModuleResolutionCache(ts7.sys.getCurrentDirectory(), (path) => path, context.options);
  for (const source of affected) {
    for (const usage of [...selections(source, request).map((selection) => selection.declaration.moduleSpecifier), ...!request.only ? dynamicSpecifiers(source, request.from) : []]) {
      const target = request.to;
      const mode = ts7.getModeForUsageLocation(source, usage, context.options);
      if (!ts7.resolveModuleName(target, source.fileName, context.options, context.sys ?? ts7.sys, cache, undefined, mode).resolvedModule) {
        unresolved.push(`${source.fileName} (${target})`);
      }
    }
  }
  if (unresolved.length)
    fail("TARGET_UNRESOLVED", [...new Set(unresolved)].sort().join(", ") + installationHint(context.root, affected[0].fileName));
  const mocks = affectedMockFiles(context, affected, request.from);
  if (!request.map || Object.keys(request.map).length === 0) {
    const edits = affected.map((source) => [source.fileName, transformFile(source, request, new Set)]);
    for (const [file, text] of edits)
      context.setText(file, text);
  } else {
    for (const source of affected) {
      const renamed = renameBindings(context, source.fileName, request);
      const current = context.service.getProgram().getSourceFile(source.fileName);
      context.setText(source.fileName, transformFile(current, request, renamed));
    }
  }
  const notes = affected.length ? ["Retargeted imports/re-exports; compiler validation does not prove runtime API compatibility."] : ["No matching imports or re-exports; no changes."];
  if (request.mocks === "add") {
    const added = addParallelMocks(context, mocks, request);
    if (added.length)
      notes.push(`Added parallel mocks for ${request.to} in: ${added.join(", ")}. Review factory runtime compatibility.`);
  } else if (mocks.length) {
    notes.push(`Tests mocking ${request.from} import retargeted files: ${mocks.join(", ")}. Review mocks or use --mocks add.`);
  }
  return notes;
}
function moveMapEntries(mappings) {
  return Object.entries(mappings).map(([source, destination]) => {
    const fromHash = source.lastIndexOf("#"), toHash = destination.lastIndexOf("#");
    if (fromHash <= 0 && toHash <= 0)
      return { from: source, to: destination };
    const from = source.slice(0, fromHash), to = destination.slice(0, toHash);
    const imported = source.slice(fromHash + 1), exported = destination.slice(toHash + 1);
    if (fromHash <= 0 || toHash <= 0 || !identifier(imported) || !identifier(exported))
      fail("INVALID_NAME", `use module#Export=module#Export: ${source}=${destination}`);
    return { from, to, imported, exported };
  });
}
function aliasMappedBindings(source, rules) {
  const changes = [];
  for (const statement of source.statements) {
    if (!ts7.isImportDeclaration(statement) && !ts7.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts7.isStringLiteralLike(statement.moduleSpecifier))
      continue;
    const names = new Set(rules.filter((rule) => rule.from === statement.moduleSpecifier.text && rule.imported && rule.imported !== rule.exported).map((rule) => rule.imported));
    for (const item of members(statement) ?? []) {
      if (!item.propertyName && names.has(item.name.text))
        changes.push({ span: { start: item.name.end, length: 0 }, newText: ` as ${item.name.getText(source)}` });
    }
  }
  return replace(source.text, changes);
}
function mapMoveImports(source, mappings, only) {
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings) || Object.entries(mappings).some(([from, to]) => !from || typeof to !== "string" || !to))
    fail("INVALID_REQUEST", "module mappings must contain nonempty from=to strings");
  validate({ operation: "retarget-import", root: "", project: "", file: source.fileName, from: "refactor-ai:source", to: "refactor-ai:target", only });
  const rules = moveMapEntries(mappings);
  let text = aliasMappedBindings(source, rules);
  const pending = [];
  const ordered = [...rules.filter((rule) => rule.imported), ...rules.filter((rule) => !rule.imported)];
  for (const [index, rule] of ordered.entries()) {
    const { from, to, imported, exported } = rule;
    const request = {
      operation: "retarget-import",
      root: "",
      project: "",
      file: source.fileName,
      from,
      to,
      ...imported ? { only: [imported], map: { [imported]: exported } } : { only }
    };
    if (from.includes("*") || to.includes("*"))
      fail("UNSUPPORTED_SPECIFIER", "module mappings require exact specifiers");
    if (from !== to)
      validate(request);
    else if (!imported)
      continue;
    let temporary = `refactor-ai:move-map:${index}`;
    while (text.includes(temporary) || Object.hasOwn(mappings, temporary) || Object.values(mappings).includes(temporary))
      temporary += ":";
    text = transformFile(ts7.createSourceFile(source.fileName, text, ts7.ScriptTarget.Latest, true), { ...request, to: temporary }, new Set);
    pending.push([temporary, to]);
  }
  for (const [from, to] of pending) {
    text = transformFile(ts7.createSourceFile(source.fileName, text, ts7.ScriptTarget.Latest, true), {
      operation: "retarget-import",
      root: "",
      project: "",
      file: source.fileName,
      from,
      to
    }, new Set);
  }
  const current = ts7.createSourceFile(source.fileName, text, ts7.ScriptTarget.Latest, true);
  const mapped = replace(text, moduleSpecifiers(current).filter((specifier) => isModuleMockCall(specifier.parent)).flatMap((specifier) => {
    const targets = new Set(rules.filter((rule) => rule.from === specifier.text).map((rule) => rule.to));
    if (!targets.size)
      return [];
    if (targets.size !== 1)
      fail("UNSUPPORTED_MOCK_MAPPING", `${source.fileName}: ${specifier.text} maps to several modules; prepare separate mocks first`);
    const quote = text[specifier.getStart(current)];
    const name = [...targets][0].replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`).replaceAll("$" + "{", quote === "`" ? "\\$" + "{" : "$" + "{");
    return [{ span: { start: specifier.getStart(current), length: specifier.getWidth(current) }, newText: quote + name + quote }];
  }));
  return mapped === source.text ? mapped : dedupeMappedMocks(source.fileName, mapped, new Set(rules.map((rule) => rule.to)));
}
var init_typescript_retarget_import = __esm(() => {
  init_typescript_mock_dedupe();
  init_typescript_package_inputs();
  init_typescript_paths();
  init_typescript_vfs();
  init_typescript_workspace();
  init_typescript_retarget_mocks();
});

// src/backends/typescript-prechecks.ts
import ts8 from "typescript";
import { resolve as resolve16 } from "node:path";
import { builtinModules } from "node:module";
function parseConfig(config, sys = ts8.sys) {
  const parsed = ts8.getParsedCommandLineOfConfigFile(config, {}, {
    ...sys,
    onUnRecoverableConfigFileDiagnostic: (error) => fail("INVALID_CONFIG", ts8.flattenDiagnosticMessageText(error.messageText, `
`))
  });
  if (!parsed || parsed.errors.length)
    fail("INVALID_CONFIG", `${config}: ${parsed?.errors.map((error) => ts8.flattenDiagnosticMessageText(error.messageText, `
`)).join("; ") ?? "cannot parse"}`);
  return parsed;
}
function checkSharedOptions(first, second, source, target) {
  for (const option of sharedOptionKeys) {
    if (JSON.stringify(first[option]) !== JSON.stringify(second[option])) {
      fail("PROJECT_OPTIONS_INCOMPATIBLE", `${target} and ${source} differ in compiler option '${option}'; use projects with compatible syntax and emit settings`);
    }
  }
}
function moveMappings(root, to, explicit = {}, sys = ts8.sys) {
  const path = resolve16(root, ".refactor-ai/equivalents.json");
  const text = sys.readFile(path);
  const defaults = Object.create(null);
  if (text !== undefined) {
    let equivalents;
    try {
      equivalents = JSON.parse(text);
    } catch {
      fail("INVALID_EQUIVALENTS", path);
    }
    if (!equivalents || Array.isArray(equivalents) || typeof equivalents !== "object" || Object.entries(equivalents).some(([from, to]) => !from || typeof to !== "string" || !to || from.includes("*") || to.includes("*")))
      fail("INVALID_EQUIVALENTS", path);
    const destination = packageAt(root, to, sys);
    for (const [from, name] of Object.entries(equivalents)) {
      if (destination && versionOf(destination.json, name))
        defaults[from] = name;
    }
  }
  return Object.assign(defaults, explicit);
}
function precheckMove(root, sourceConfig, targetConfig, renames, request, sys = ts8.sys) {
  const source = parseConfig(sourceConfig, sys), target = sourceConfig === targetConfig ? source : parseConfig(targetConfig, sys);
  checkSharedOptions(source.options, target.options, sourceConfig, targetConfig);
  const moved = new Set(renames.map(([from]) => from));
  const blockers = [];
  for (const [from, to] of renames) {
    if (!/\.[cm]?[jt]sx?$/.test(from))
      continue;
    const text = sys.readFile(from);
    if (text === undefined)
      fail("FILE_NOT_FOUND", from);
    const originalFile = ts8.createSourceFile(from, text, ts8.ScriptTarget.Latest, true);
    const mapped = mapMoveImports(originalFile, moveMappings(root, to, request?.map, sys), request?.only);
    const file = ts8.createSourceFile(from, mapped, ts8.ScriptTarget.Latest, true);
    file.impliedNodeFormat = ts8.getImpliedNodeFormatForFile(from, undefined, sys, source.options);
    const sourcePackage = packageAt(root, from, sys), destination = packageAt(root, to, sys);
    const specifiers = moduleSpecifiers(file);
    const relocated = ts8.createSourceFile(to, mapped, ts8.ScriptTarget.Latest, true);
    relocated.impliedNodeFormat = ts8.getImpliedNodeFormatForFile(to, undefined, sys, target.options);
    const targetSpecifiers = moduleSpecifiers(relocated);
    for (const [index, specifier] of specifiers.entries()) {
      if (isModuleMockCall(specifier.parent) && ts8.isPropertyAccessExpression(specifier.parent.expression) && ["mock", "doMock", "unmock", "doUnmock"].includes(specifier.parent.expression.name.text))
        continue;
      const name = specifier.text;
      const mode = ts8.getModeForUsageLocation(file, specifier, source.options);
      const original = ts8.resolveModuleName(name, from, source.options, sys, undefined, undefined, mode).resolvedModule;
      if (original && moved.has(resolve16(original.resolvedFileName)))
        continue;
      if (name.startsWith(".") || builtins.has(name) || destination?.json.name && (name === destination.json.name || name.startsWith(`${destination.json.name}/`)))
        continue;
      const alias = Object.keys(source.options.paths ?? {}).some((pattern) => {
        const [prefix, suffix] = pattern.split("*");
        return pattern.includes("*") ? name.startsWith(prefix) && name.endsWith(suffix) : name === pattern;
      });
      const targetMode = ts8.getModeForUsageLocation(relocated, targetSpecifiers[index], target.options);
      if (alias) {
        if (original && !ts8.resolveModuleName(name, to, target.options, sys, undefined, undefined, targetMode).resolvedModule) {
          blockers.push(`MOVE_IMPORT_UNRESOLVED: ${from}: '${name}' cannot resolve from ${to}; unresolved source-project alias imports: ${name}; move its dependency too or retarget the alias before moving${installationHint(root, to)}`);
        }
        continue;
      }
      if (!destination || !sourcePackage || destination.path === sourcePackage.path)
        continue;
      const packageName = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
      const version = versionOf(sourcePackage.json, packageName);
      if ((version || original?.isExternalLibraryImport) && !name.startsWith("#") && !versionOf(destination.json, packageName)) {
        const equivalent = moveMappings(root, to, {}, sys)[packageName];
        const hint = equivalent ? `destination declares ${equivalent}; map ${packageName}=${equivalent}` : version ? `add ${packageName}@${version} to ${destination.path}` : `add '${packageName}' to ${destination.path}`;
        blockers.push(`MISSING_DEPENDENCY: ${destination.path} must declare '${packageName}' (source version ${version ?? "not declared"}); ${hint}${equivalent ? " before moving" : " and install before moving"} ${from}${installationHint(root, to)}`);
        continue;
      }
      if (!ts8.resolveModuleName(name, to, target.options, sys, undefined, undefined, targetMode).resolvedModule) {
        if (original?.isExternalLibraryImport)
          blockers.push(`MOVE_IMPORT_UNRESOLVED: '${name}' cannot resolve from ${to}; install the destination dependencies or fix its package exports${installationHint(root, to)}`);
      }
    }
  }
  if (blockers.length)
    throw new Error([...new Set(blockers)].sort((a, b) => Number(b.startsWith("MOVE_IMPORT_UNRESOLVED")) - Number(a.startsWith("MOVE_IMPORT_UNRESOLVED"))).join("; "));
}
var builtins, dependencyFields, versionOf = (json, name) => dependencyFields.map((field) => json[field]?.[name]).find((value) => typeof value === "string");
var init_typescript_prechecks = __esm(() => {
  init_typescript_package_inputs();
  init_typescript_retarget_import();
  init_typescript_workspace();
  init_typescript_vfs();
  builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
  dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
});

// src/backends/typescript-move-mocks.ts
function prepareMoveMocks(ws, renames, request, notes) {
  const moved = new Set(renames.map(([file]) => ws.vfs.key(file)));
  const groups = new Map;
  for (const [file, target] of renames) {
    for (const { from, to } of moveMapEntries(moveMappings(ws.root, target, request.map, ws.vfs.inputs.sys))) {
      if (from === to)
        continue;
      const key = JSON.stringify([from, to]);
      const group = groups.get(key) ?? { from, to, sources: [] };
      group.sources.push(file);
      groups.set(key, group);
    }
  }
  const context = { sys: ws.vfs.moduleResolutionHost(), service: ws.service, options: ws.editOptions, optionsFor: (source) => {
    const owner = ws.ownersOf(source.fileName)[0];
    return owner ? ws.participant(owner).parsed.options : ws.editOptions;
  }, root: ws.root, setText: (file, text) => ws.vfs.write(file, text) };
  const program = ws.program();
  const pending = [...groups.values()].map((group) => ({
    ...group,
    files: affectedMockFiles(context, group.sources.flatMap((file) => {
      const source = program.getSourceFile(file);
      return source ? [source] : [];
    }), group.from).filter((file) => !moved.has(ws.vfs.key(file)))
  }));
  return (onInsert) => {
    for (const { from, to, files } of pending) {
      if (!files.length)
        continue;
      if (request.mocks === "add") {
        const added = addParallelMocks({ ...context, onInsert }, files, { ...request, from, to });
        if (added.length)
          notes.push(`Added parallel mocks for ${to} in ${added.join(", ")}; review factory runtime compatibility.`);
      } else
        notes.push(`Tests mocking ${from} import moved files: ${files.join(", ")}; review mocks or use --mocks add for ${to}.`);
    }
  };
}
var init_typescript_move_mocks = __esm(() => {
  init_typescript_retarget_import();
  init_typescript_retarget_mocks();
  init_typescript_prechecks();
});

// src/backends/typescript-inline-reexports.ts
import ts9 from "typescript";
import { dirname as dirname11, extname as extname2, relative as relative7, resolve as resolve17, sep as sep7 } from "node:path";

class Origins {
  ws;
  checker;
  constructor(ws) {
    this.ws = ws;
    this.checker = ws.program().getTypeChecker();
  }
  exports(source) {
    const symbol = this.checker.getSymbolAtLocation(source);
    return symbol ? this.checker.getExportsOfModule(symbol) : [];
  }
  actual(symbol) {
    return symbol.flags & ts9.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
  }
  exported(source, name) {
    const symbol = this.exports(source).find((item) => item.name === name);
    if (!symbol)
      fail("REEXPORT_UNRESOLVED", `${source.fileName} has no resolved export '${name}'`);
    return symbol;
  }
  module(source, specifier) {
    const symbol = this.checker.getSymbolAtLocation(specifier);
    const target = symbol?.declarations?.find(ts9.isSourceFile);
    if (!target)
      fail("REEXPORT_UNRESOLVED", `${specifier.text} in ${source.fileName} has no resolved module`);
    return target;
  }
  find(source, name, seen = new Set) {
    const key = `${source.fileName}\x00${name}`;
    if (seen.has(key))
      fail("REEXPORT_CYCLE", `cyclic re-export of '${name}' in ${source.fileName}`);
    const visited = new Set([...seen, key]);
    const symbol = this.exported(source, name);
    const declarations = source.statements.filter(ts9.isExportDeclaration);
    const explicit = declarations.find((item) => item.exportClause && ts9.isNamedExports(item.exportClause) && item.exportClause.elements.some((element) => element.name.text === name));
    if (explicit) {
      if (explicit.attributes)
        fail("REEXPORT_UNSUPPORTED", `re-export attributes in ${source.fileName}`);
      const element = explicit.exportClause.elements.find((item) => item.name.text === name);
      if (!explicit.moduleSpecifier)
        return this.localOrigin(element, visited, explicit.isTypeOnly || element.isTypeOnly);
      if (!ts9.isStringLiteralLike(explicit.moduleSpecifier))
        return;
      return this.follow(source, explicit.moduleSpecifier, (element.propertyName ?? element.name).text, explicit.isTypeOnly || element.isTypeOnly, visited);
    }
    if (this.actual(symbol).declarations?.some((item) => item.getSourceFile() === source))
      return;
    for (const statement of declarations) {
      if (statement.exportClause || !statement.moduleSpecifier || !ts9.isStringLiteralLike(statement.moduleSpecifier) || name === "default")
        continue;
      const target = this.module(source, statement.moduleSpecifier);
      const candidate = this.exports(target).find((item) => item.name === name);
      if (candidate && this.actual(candidate) === this.actual(symbol)) {
        if (statement.attributes)
          fail("REEXPORT_UNSUPPORTED", `re-export attributes in ${source.fileName}`);
        return this.follow(source, statement.moduleSpecifier, name, statement.isTypeOnly, visited);
      }
    }
    return;
  }
  packageBoundary(source, target) {
    const owner = (file) => {
      for (let directory = dirname11(file);isInside(this.ws.root, directory); directory = dirname11(directory)) {
        const text = this.ws.vfs.readFile(resolve17(directory, "package.json"));
        if (text) {
          try {
            return { directory, manifest: JSON.parse(text) };
          } catch {
            fail("INVALID_PACKAGE", `cannot parse ${directory}/package.json`);
          }
        }
        if (directory === dirname11(directory))
          break;
      }
      return;
    };
    const destination = owner(target.fileName);
    if (!destination?.manifest.name || owner(source.fileName)?.directory === destination.directory)
      return false;
    const values = (value) => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(values) : [];
    const entries = destination.manifest.exports !== undefined ? values(destination.manifest.exports) : [destination.manifest.types, destination.manifest.typings, destination.manifest.main, "./index.ts", "./index.js"].flatMap(values);
    const stem = (path) => path.replace(/(?:\.d)?\.[cm]?[jt]sx?$/, "");
    return entries.some((entry) => {
      const parts = stem(resolve17(destination.directory, entry)).split("*");
      const path = stem(target.fileName);
      return parts.length === 1 ? this.ws.vfs.samePath(parts[0], path) : parts.length === 2 && this.ws.vfs.key(path).startsWith(this.ws.vfs.key(parts[0])) && path.endsWith(parts[1]);
    });
  }
  localOrigin(element, seen, typeOnly) {
    const local = this.checker.getExportSpecifierLocalTargetSymbol(element);
    const declaration = local?.declarations?.[0];
    if (!declaration || !ts9.isImportSpecifier(declaration) && !ts9.isImportClause(declaration))
      return;
    const clause = ts9.isImportSpecifier(declaration) ? declaration.parent.parent : declaration;
    const statement = clause.parent;
    if (!ts9.isImportDeclaration(statement) || !ts9.isStringLiteralLike(statement.moduleSpecifier))
      return;
    if (statement.attributes)
      fail("REEXPORT_UNSUPPORTED", `import attributes in ${element.getSourceFile().fileName}`);
    const name = ts9.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : "default";
    return this.follow(element.getSourceFile(), statement.moduleSpecifier, name, typeOnly || clause.isTypeOnly || ts9.isImportSpecifier(declaration) && declaration.isTypeOnly, seen);
  }
  follow(source, specifier, name, typeOnly, seen) {
    const target = this.module(source, specifier);
    this.exported(target, name);
    const next = isRelative(specifier.text) && !this.packageBoundary(source, target) ? this.find(target, name, seen) : undefined;
    return next ? { ...next, typeOnly: typeOnly || next.typeOnly } : { specifier, target, name, typeOnly };
  }
}
function isRelative(specifier) {
  return /^\.\.?\//.test(specifier);
}
function originSpecifier(origin, importer) {
  const original = origin.specifier.text;
  if (!isRelative(original))
    return original;
  const written = original.match(/(?:\.d)?\.[cm]?[jt]sx?$/)?.[0] ?? "";
  const extension = origin.target.fileName.match(/(?:\.d)?\.[cm]?[jt]sx?$/)?.[0] ?? extname2(origin.target.fileName);
  const runtime = { ".ts": ".js", ".tsx": ".js", ".mts": ".mjs", ".cts": ".cjs" };
  const suffix = written === extension ? extension : [".js", ".jsx", ".mjs", ".cjs"].includes(written) ? written === ".jsx" && extension === ".tsx" ? ".jsx" : runtime[extension.replace(/^\.d/, "")] ?? extension : "";
  const target = origin.target.fileName.slice(0, -extension.length) + suffix;
  const path = portablePath(relative7(dirname11(importer.fileName), target));
  return path.startsWith(".") ? path : `./${path}`;
}
function literal(text, quote) {
  const escaped = JSON.stringify(text).slice(1, -1);
  return `${quote}${quote === "'" ? escaped.replace(/'/g, "\\'") : escaped}${quote}`;
}
function bindingName(name) {
  return /^[$\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(name) ? name : JSON.stringify(name);
}
function resolveAs(ws, text, source, usage) {
  const mode = ts9.getModeForUsageLocation(source, usage, ws.editOptions);
  return ts9.resolveModuleName(text, source.fileName, ws.editOptions, ws.vfs.moduleResolutionHost(), undefined, undefined, mode).resolvedModule;
}
function groupsFor(origins, shim, importer, specifier, bindings) {
  const groups = new Map;
  for (const binding of bindings) {
    const origin = origins.find(shim, binding.imported);
    const direct = origin ? originSpecifier(origin, importer) : specifier.text;
    if (origin) {
      const resolved = resolveAs(origins.ws, direct, importer, specifier);
      if (!resolved || !origins.ws.vfs.samePath(resolved.resolvedFileName, origin.target.fileName)) {
        fail("REEXPORT_RESOLUTION_CHANGED", `'${direct}' in ${importer.fileName} does not resolve to ${origin.target.fileName}`);
      }
    }
    const group = groups.get(direct) ?? { specifier: direct, bindings: [] };
    group.bindings.push({ ...binding, imported: origin?.name ?? binding.imported, typeOnly: binding.typeOnly || (origin?.typeOnly ?? false) });
    groups.set(direct, group);
  }
  return [...groups.values()];
}
function renderGroup(group, exporting, typeOnly, quote, suffix) {
  const defaults = exporting ? [] : group.bindings.filter((item) => item.defaultImport && item.imported === "default");
  const named = group.bindings.filter((item) => !defaults.includes(item));
  const allType = typeOnly;
  if (!typeOnly && defaults.some((item) => item.typeOnly)) {
    const typed = defaults.filter((item) => item.typeOnly);
    const remaining = group.bindings.filter((item) => !typed.includes(item));
    return [
      renderGroup({ ...group, bindings: typed }, false, true, quote, suffix),
      ...remaining.length ? [renderGroup({ ...group, bindings: remaining }, false, false, quote, suffix)] : []
    ].join(`
`);
  }
  const names = named.map((item) => `${!allType && item.typeOnly ? "type " : ""}${bindingName(item.imported)}${item.imported === item.local ? "" : ` as ${bindingName(item.local)}`}`);
  if (allType && defaults.length && named.length) {
    return [
      renderGroup({ ...group, bindings: defaults }, exporting, true, quote, suffix),
      renderGroup({ ...group, bindings: named }, exporting, true, quote, suffix)
    ].join(`
`);
  }
  const clause = [...defaults.map((item) => item.local), ...names.length ? [`{ ${names.join(", ")} }`] : []].join(", ");
  return `${exporting ? "export" : "import"} ${allType ? "type " : ""}${clause} from ${literal(group.specifier, quote)}${suffix}`;
}
function pureShim(source) {
  return source.statements.some(ts9.isExportDeclaration) && source.statements.every((item) => ts9.isExportDeclaration(item) && !!item.moduleSpecifier || ts9.isExpressionStatement(item) && ts9.isStringLiteral(item.expression));
}
function singleStar(source) {
  const exports = source.statements.filter(ts9.isExportDeclaration);
  return pureShim(source) && exports.length === 1 && !exports[0].exportClause && !exports[0].isTypeOnly ? exports[0] : undefined;
}
function retargetNamespace(origins, shim, source, specifier) {
  const star = singleStar(shim);
  if (!star || !star.moduleSpecifier || !ts9.isStringLiteralLike(star.moduleSpecifier)) {
    fail("NAMESPACE_IMPORT_UNSUPPORTED", `${source.fileName} imports a namespace from ${shim.fileName}; only pure single-origin export * shims support this`);
  }
  if (star.attributes)
    fail("REEXPORT_UNSUPPORTED", `re-export attributes in ${shim.fileName}`);
  const target = origins.module(shim, star.moduleSpecifier);
  if (origins.exports(target).some((item) => item.name === "default"))
    fail("NAMESPACE_IMPORT_UNSUPPORTED", "origin exports default, which export * excludes");
  const origin = { specifier: star.moduleSpecifier, target, name: "", typeOnly: false };
  const direct = originSpecifier(origin, source);
  const resolved = resolveAs(origins.ws, direct, source, specifier);
  if (!resolved || !origins.ws.vfs.samePath(resolved.resolvedFileName, target.fileName))
    fail("REEXPORT_RESOLUTION_CHANGED", direct);
  const start = specifier.getStart(source);
  return { span: { start, length: specifier.end - start }, newText: literal(direct, source.text[start]) };
}
function rewrite(origins, shim, source, notes) {
  const changes = [];
  for (const statement of source.statements) {
    if (!ts9.isImportDeclaration(statement) && !ts9.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts9.isStringLiteralLike(statement.moduleSpecifier))
      continue;
    const specifier = statement.moduleSpecifier;
    const resolved = origins.ws.resolveModule(specifier, source);
    if (!resolved || !origins.ws.vfs.samePath(resolved.resolvedFileName, shim.fileName))
      continue;
    const exporting = ts9.isExportDeclaration(statement);
    const clause = exporting ? statement.exportClause : statement.importClause;
    if (!exporting && !clause) {
      notes.push(`Kept side-effect import of ${shim.fileName} in ${source.fileName}.`);
      continue;
    }
    if (statement.attributes)
      fail("REEXPORT_UNSUPPORTED", `import/export attributes in ${source.fileName}`);
    if (!exporting && statement.importClause?.namedBindings && ts9.isNamespaceImport(statement.importClause.namedBindings) || exporting && statement.exportClause && ts9.isNamespaceExport(statement.exportClause)) {
      changes.push(retargetNamespace(origins, shim, source, specifier));
      continue;
    }
    const typeOnly = exporting ? statement.isTypeOnly : statement.importClause.isTypeOnly;
    const bindings = [];
    if (!exporting && statement.importClause.name)
      bindings.push({ imported: "default", local: statement.importClause.name.text, typeOnly, defaultImport: true });
    const named = exporting ? statement.exportClause : statement.importClause.namedBindings;
    if (named && (ts9.isNamedExports(named) || ts9.isNamedImports(named))) {
      for (const item of named.elements)
        bindings.push({ imported: (item.propertyName ?? item.name).text, local: item.name.text, typeOnly: typeOnly || item.isTypeOnly });
    } else if (exporting && !named) {
      for (const symbol of origins.exports(shim))
        if (symbol.name !== "default")
          bindings.push({ imported: symbol.name, local: symbol.name, typeOnly: typeOnly || !(origins.actual(symbol).flags & ts9.SymbolFlags.Value) });
    }
    if (!bindings.length)
      continue;
    const groups = groupsFor(origins, shim, source, specifier, bindings);
    if (groups.length === 1 && groups[0].specifier === specifier.text)
      continue;
    const start = statement.getStart(source);
    const quote = source.text[specifier.getStart(source)];
    const suffix = source.text.slice(specifier.end, statement.end);
    const output = groups.map((group) => renderGroup(group, exporting, typeOnly, quote, suffix)).join(`
`).replace(/\n/g, eolOf(source.text));
    changes.push({ span: { start, length: statement.end - start }, newText: output });
  }
  for (const specifier of moduleSpecifiers(source)) {
    if (ts9.isCallExpression(specifier.parent) && specifier.parent.expression.kind === ts9.SyntaxKind.ImportKeyword) {
      const resolved = origins.ws.resolveModule(specifier, source);
      if (!resolved || !origins.ws.vfs.samePath(resolved.resolvedFileName, shim.fileName))
        continue;
      const star = singleStar(shim);
      if (!star || !star.moduleSpecifier || !ts9.isStringLiteralLike(star.moduleSpecifier)) {
        notes.push(`Kept dynamic import of ${shim.fileName}: only pure single-origin export * shims support namespace retargeting.`);
      } else if (origins.exports(origins.module(shim, star.moduleSpecifier)).some((item) => item.name === "default")) {
        notes.push(`Kept dynamic import of ${shim.fileName}: origin exports default, which export * excludes.`);
      } else
        changes.push(retargetNamespace(origins, shim, source, specifier));
      continue;
    }
    if (!isModuleMockCall(specifier.parent))
      continue;
    const resolved = origins.ws.resolveModule(specifier, source);
    if (!resolved || !origins.ws.vfs.samePath(resolved.resolvedFileName, shim.fileName))
      continue;
    const exports = origins.exports(shim);
    const found = exports.map((symbol) => ({ name: symbol.name, origin: origins.find(shim, symbol.name) }));
    const targets = new Set(found.map((item) => item.origin && originSpecifier(item.origin, source)));
    if (!found.length || targets.size !== 1 || targets.has(undefined) || found.some((item) => item.origin.name !== item.name)) {
      notes.push(`Kept mock/actual reference to ${shim.fileName} in ${source.fileName}: split or renamed exports require a runtime adapter.`);
      continue;
    }
    const direct = [...targets][0];
    const target = resolveAs(origins.ws, direct, source, specifier);
    if (!target || !origins.ws.vfs.samePath(target.resolvedFileName, found[0].origin.target.fileName))
      fail("REEXPORT_RESOLUTION_CHANGED", direct);
    changes.push({ span: { start: specifier.getStart(source), length: specifier.getWidth(source) }, newText: literal(direct, source.text[specifier.getStart(source)]) });
    notes.push(`Retargeted mock/actual module ${specifier.text} to ${direct} in ${source.fileName}; review factory runtime compatibility.`);
  }
  return changes;
}
function inlineReexports(ws, file, source, notes, keep = false) {
  if (file.split(sep7).includes("node_modules") || ws.vfs.isHidden(file))
    fail("OUTSIDE_PROJECT", `cannot inline a dependency or build output: ${file}`);
  const origins = new Origins(ws);
  const files = ws.program().getSourceFiles().filter((item) => isInside(ws.root, resolve17(item.fileName)) && !item.fileName.split(sep7).includes("node_modules") && !ws.vfs.isHidden(item.fileName));
  const edits = files.filter((item) => !ws.vfs.samePath(item.fileName, file)).map((item) => ({ source: item, changes: rewrite(origins, source, item, notes) }));
  for (const edit of edits)
    if (edit.changes.length)
      ws.vfs.write(edit.source.fileName, applyTextChanges(edit.source.text, edit.changes));
  const remaining = ws.program().getSourceFiles().filter((item) => isInside(ws.root, resolve17(item.fileName)) && !item.fileName.split(sep7).includes("node_modules") && !ws.vfs.isHidden(item.fileName)).some((item) => moduleSpecifiers(item).some((specifier) => {
    const target = ws.resolveModule(specifier, item);
    return target && ws.vfs.samePath(target.resolvedFileName, file);
  }) || item.referencedFiles.some((reference) => ws.vfs.samePath(resolve17(dirname11(item.fileName), reference.fileName), file)));
  if (!keep && pureShim(source) && !remaining) {
    ws.vfs.write(file, null);
    ws.updateConfigLists([], [file]);
    ws.reparse();
    notes.push(`Deleted unreferenced re-export shim ${file}.`);
    return true;
  }
  notes.push(keep ? `Kept ${file} (--keep).` : `Kept ${file} and its re-exports (${remaining ? "remaining module references" : "local declarations"}).`);
  return false;
}
var init_typescript_inline_reexports = __esm(() => {
  init_typescript_paths();
  init_typescript_vfs();
  init_typescript_workspace();
});

// src/backends/typescript-package-specifiers.ts
import ts10 from "typescript";
import { dirname as dirname12, extname as extname3, relative as relative8, resolve as resolve18 } from "node:path";
function packageFor(ws, file) {
  for (let directory = dirname12(file);isInside(ws.root, directory); directory = dirname12(directory)) {
    const path = resolve18(directory, "package.json");
    const text = ws.vfs.readFile(path);
    if (text !== undefined) {
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        fail("INVALID_PACKAGE", path);
      }
      if (typeof json.name === "string" && json.name)
        return { path, directory, name: json.name, json };
    }
    if (ws.vfs.samePath(directory, ws.root))
      break;
  }
  return;
}
function packageSelfImport(ws, importer, target, specifier) {
  const pkg = packageFor(ws, importer);
  return !!pkg && (specifier === pkg.name || specifier.startsWith(`${pkg.name}/`)) && packageFor(ws, target)?.path === pkg.path;
}
function strings(value) {
  if (typeof value === "string")
    return [value];
  if (Array.isArray(value))
    return value.flatMap(strings);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(strings);
  return [];
}
function exportedPaths(pkg, target) {
  const exports = pkg.json.exports;
  const entries = exports && typeof exports === "object" && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith(".")) ? Object.entries(exports) : [[".", exports]];
  const candidates = [];
  const path = `./${portablePath(relative8(pkg.directory, target))}`;
  for (const [key, value] of entries) {
    if (key !== "." && !key.startsWith("./"))
      continue;
    for (const pattern of strings(value)) {
      if (!pattern.startsWith("./"))
        continue;
      if (!pattern.includes("*") && pattern === path && !key.includes("*"))
        candidates.push(key);
      else if (pattern.split("*").length === 2 && key.split("*").length === 2) {
        const [prefix, suffix] = pattern.split("*");
        if (path.startsWith(prefix) && path.endsWith(suffix) && path.length >= prefix.length + suffix.length) {
          candidates.push(key.replace("*", path.slice(prefix.length, path.length - suffix.length)));
        }
      }
    }
  }
  return [...new Set(candidates)].sort((a, b) => a.length - b.length || a.localeCompare(b));
}
function defaultExportKey(pkg, target) {
  const path = portablePath(relative8(pkg.directory, target));
  const subpath = path.replace(/^src\//, "").slice(0, -extname3(path).length).replace(/(^|\/)index$/, "");
  return subpath ? `./${subpath}` : ".";
}
function anticipatePackageExport(ws, target, specifier) {
  const pkg = packageFor(ws, target);
  if (!pkg)
    return false;
  const keys = exportedPaths(pkg, target);
  const matches = (key) => specifier === pkg.name + (key === "." ? "" : key.slice(1));
  if (keys.some(matches))
    return true;
  if (!matches(defaultExportKey(pkg, target)))
    return false;
  addExport(ws, pkg, target);
  return true;
}
function addExport(ws, pkg, target) {
  const text = ws.vfs.readFile(pkg.path);
  const json = ts10.parseJsonText(pkg.path, text);
  const object = json.statements[0]?.expression;
  if (!object || !ts10.isObjectLiteralExpression(object))
    fail("INVALID_PACKAGE", pkg.path);
  const property = object.properties.find((item) => ts10.isPropertyAssignment(item) && ts10.isStringLiteral(item.name) && item.name.text === "exports");
  if (!property)
    fail("PACKAGE_EXPORTS_REQUIRED", `${pkg.path} has no exports field; declare the package's public surface before moving files into it`);
  if (!ts10.isObjectLiteralExpression(property.initializer) || property.initializer.properties.some((item) => !ts10.isPropertyAssignment(item) || !ts10.isStringLiteral(item.name) || !item.name.text.startsWith("."))) {
    fail("PACKAGE_EXPORTS_UNSUPPORTED", `${pkg.path}: automatic exports require an object of subpath entries`);
  }
  const path = portablePath(relative8(pkg.directory, target));
  if (path.startsWith("../"))
    fail("PACKAGE_EXPORTS_UNSUPPORTED", target);
  const key = defaultExportKey(pkg, target);
  const entries = property.initializer.properties;
  if (entries.some((item) => ts10.isPropertyAssignment(item) && ts10.isStringLiteral(item.name) && item.name.text === key)) {
    fail("PACKAGE_EXPORT_CONFLICT", `${pkg.path}: ${key} already names another target`);
  }
  const literal = `${JSON.stringify(key)}: ${JSON.stringify(`./${path}`)}`;
  const last = entries[entries.length - 1];
  const multiline = text.slice(property.initializer.getStart(json), property.initializer.end).includes(`
`);
  const indentAt = (position) => text.slice(text.lastIndexOf(`
`, position) + 1, position).match(/^[\t ]*/)?.[0] ?? "";
  const indent = last ? indentAt(last.getStart(json)) : indentAt(property.getStart(json)) + (text.match(/\n([\t ]+)"/)?.[1] ?? "  ");
  const start = last?.end ?? property.initializer.getStart(json) + 1;
  const tail = text.slice(start, property.initializer.end - 1);
  const comma = tail.indexOf(",");
  const changes = [];
  if (last && comma >= 0) {
    changes.push({ span: { start: start + comma + 1, length: 0 }, newText: `${multiline ? eolOf(text) + indent : " "}${literal},` });
  } else {
    changes.push({ span: { start, length: 0 }, newText: `${last ? "," : ""}${multiline ? eolOf(text) + indent : last ? " " : ""}${literal}` });
  }
  ws.vfs.write(pkg.path, applyTextChanges(text, changes));
  return key;
}
function packageSpecifier(ws, importer, target, mode) {
  const destination = packageFor(ws, target);
  const source = packageFor(ws, importer);
  if (!destination || source && ws.vfs.samePath(source.path, destination.path))
    return;
  if (!source)
    fail("MISSING_DEPENDENCY", `${importer} has no named package declaring ${destination.name}`);
  const declares = ["dependencies", "devDependencies", "peerDependencies"].some((field) => {
    const value = source.json[field];
    return value && typeof value === "object" && Object.hasOwn(value, destination.name);
  });
  if (!declares)
    fail("MISSING_DEPENDENCY", `${source.path} must declare ${destination.name} in dependencies, devDependencies or peerDependencies (${importer} imports ${target})`);
  const paths = exportedPaths(destination, target);
  const nameFor = (key) => destination.name + (key === "." ? "" : key.slice(1));
  const owner = ws.ownersOf(importer)[0];
  const options = owner ? ws.participant(owner).parsed.options : ws.editOptions;
  const key = paths.find((key) => {
    const resolved = ts10.resolveModuleName(nameFor(key), importer, options, ws.vfs.moduleResolutionHost(), undefined, undefined, mode).resolvedModule;
    return resolved && ws.vfs.samePath(resolved.resolvedFileName, target);
  }) ?? paths[0] ?? addExport(ws, destination, target);
  return nameFor(key);
}
function relativeStyle(ws, target, fallback, cache = new Map) {
  const pkg = packageFor(ws, target);
  if (!pkg)
    return fallback.startsWith(".") ? fallback : "./module";
  const fallbackStyle = fallback.startsWith(".") ? fallback : "./module";
  if (cache.has(pkg.path))
    return cache.get(pkg.path) ?? fallbackStyle;
  let explicit = 0, implicit = 0;
  let sample = "./module";
  for (const file of ws.unionFiles()) {
    if (!isInside(pkg.directory, file) || packageFor(ws, file)?.path !== pkg.path)
      continue;
    const source = ws.syntaxFile(file);
    if (!source)
      continue;
    for (const specifier of moduleSpecifiers(source)) {
      if (!/^\.\.?\//.test(specifier.text))
        continue;
      if (/\.[cm]?[jt]sx?$/.test(specifier.text)) {
        explicit += 1;
        sample = specifier.text;
      } else
        implicit += 1;
    }
  }
  const style = !explicit && !implicit ? null : explicit > implicit ? sample : "./module";
  cache.set(pkg.path, style);
  return style ?? fallbackStyle;
}
var init_typescript_package_specifiers = __esm(() => {
  init_typescript_vfs();
  init_typescript_workspace();
  init_typescript_paths();
});

// src/backends/typescript-suppressions.ts
import { readdirSync as readdirSync2 } from "node:fs";
import { dirname as dirname13, relative as relative9, resolve as resolve19 } from "node:path";
function nearestLedger(ws, file) {
  for (let directory = dirname13(file);isInside(ws.root, directory); directory = dirname13(directory)) {
    const path = resolve19(directory, "eslint-suppressions.json");
    if (ws.vfs.fileExists(path))
      return path;
    if (ws.vfs.samePath(directory, ws.root))
      break;
  }
  return;
}
function newLedger(ws, file) {
  const directory = packageFor(ws, file)?.directory ?? dirname13(ws.targetConfig);
  let names;
  try {
    names = readdirSync2(directory);
  } catch {
    return;
  }
  return names.some((name) => /^eslint\.config\.[cm]?[jt]s$/.test(name) && ws.vfs.fileExists(resolve19(directory, name))) ? resolve19(directory, "eslint-suppressions.json") : undefined;
}
function record(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function readLedger(ws, path) {
  const text = ws.vfs.readFile(path);
  let entries = {};
  try {
    if (text !== undefined)
      entries = JSON.parse(text);
  } catch {
    fail("INVALID_SUPPRESSIONS", path);
  }
  if (!record(entries) || Object.values(entries).some((rules) => !record(rules) || Object.values(rules).some((rule) => !record(rule) || !Number.isSafeInteger(rule.count) || rule.count < 0))) {
    fail("INVALID_SUPPRESSIONS", `${path}: expected file entries containing rule counts`);
  }
  const keys = Object.keys(entries);
  const sorted = [...keys].sort();
  return { entries, sorted: keys.every((key, index) => key === sorted[index]) };
}
function moveSuppressions(ws, renames, notes) {
  const ledgers = new Map;
  const ledger = (path) => {
    if (!ledgers.has(path))
      ledgers.set(path, readLedger(ws, path));
    return ledgers.get(path);
  };
  const transfers = renames.flatMap(([from, to]) => {
    const source = nearestLedger(ws, from);
    if (!source)
      return [];
    const key = portablePath(relative9(dirname13(source), from));
    const entries = ledger(source).entries;
    if (!Object.hasOwn(entries, key))
      return [];
    const destination = nearestLedger(ws, to) ?? newLedger(ws, to);
    if (destination)
      ledger(destination);
    return [{ source, key, rules: entries[key], destination, to }];
  });
  for (const { source, key } of transfers)
    delete ledger(source).entries[key];
  for (const { source, key, rules, destination, to } of transfers) {
    const label = `${portablePath(relative9(ws.root, source))}:${key}`;
    if (!destination) {
      notes.push(`Dropped ESLint suppressions for ${label}; ${portablePath(relative9(ws.root, to))} has no destination ledger or package eslint.config.*; review suppressions.`);
      continue;
    }
    const targetKey = portablePath(relative9(dirname13(destination), to));
    const entries = ledger(destination).entries;
    if (!Object.hasOwn(entries, targetKey))
      Object.defineProperty(entries, targetKey, { value: {}, enumerable: true, configurable: true, writable: true });
    const target = entries[targetKey];
    for (const [rule, value] of Object.entries(rules)) {
      const count = (Object.hasOwn(target, rule) ? target[rule].count : 0) + value.count;
      if (!Number.isSafeInteger(count))
        fail("INVALID_SUPPRESSIONS", `${destination}: count overflow for ${rule}`);
      Object.defineProperty(target, rule, { value: { ...value, count }, enumerable: true, configurable: true, writable: true });
    }
    notes.push(`Moved ESLint suppressions ${label} -> ${portablePath(relative9(ws.root, destination))}:${targetKey}.`);
  }
  const changed = new Set(transfers.flatMap((item) => [item.source, ...item.destination ? [item.destination] : []]));
  for (const path of changed) {
    const { entries, sorted } = ledger(path);
    const ordered = sorted ? Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entries;
    ws.vfs.write(path, JSON.stringify(ordered, null, 2) + `
`);
  }
}
var init_typescript_suppressions = __esm(() => {
  init_typescript_package_specifiers();
  init_typescript_paths();
  init_typescript_vfs();
});

// src/backends/typescript-bindings.ts
import ts11 from "typescript";
function ambientModules(sources) {
  const exact = new Set, patterns = [];
  for (const source of sources) {
    for (const statement of source.statements) {
      if (!ts11.isModuleDeclaration(statement) || !ts11.isStringLiteral(statement.name))
        continue;
      const name = statement.name.text, star = name.indexOf("*");
      if (star < 0)
        exact.add(name);
      else
        patterns.push([name.slice(0, star), name.slice(star + 1)]);
    }
  }
  return (name) => exact.has(name) || patterns.some(([prefix, suffix]) => name.length >= prefix.length + suffix.length && name.startsWith(prefix) && name.endsWith(suffix));
}
function hasModifier(node, kind) {
  return ts11.canHaveModifiers(node) && (ts11.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}
function bindingNames(name, names) {
  if (ts11.isIdentifier(name))
    names.add(name.text);
  else
    for (const element of name.elements)
      if (!ts11.isOmittedExpression(element))
        bindingNames(element.name, names);
}
function exportsOf(state, path, cache, visiting = new Set) {
  const key = state.key(path);
  if (cache.has(key))
    return cache.get(key);
  if (visiting.has(key))
    return new Set;
  const source = /\.(?:[cm]?[jt]sx?)$/i.test(path) ? state.source(path) : undefined;
  if (!source || !ts11.isExternalModule(source) || /\.[cm]?jsx?$/i.test(path) && commonJs.test(source.text)) {
    cache.set(key, undefined);
    return;
  }
  visiting.add(key);
  let names = new Set;
  for (const statement of source.statements) {
    if (ts11.isExportAssignment(statement)) {
      if (statement.isExportEquals) {
        names = undefined;
        break;
      }
      names.add("default");
    } else if (ts11.isExportDeclaration(statement)) {
      if (statement.exportClause && ts11.isNamedExports(statement.exportClause))
        for (const element of statement.exportClause.elements)
          names.add(element.name.text);
      else if (statement.exportClause)
        names.add(statement.exportClause.name.text);
      else if (statement.moduleSpecifier && ts11.isStringLiteralLike(statement.moduleSpecifier)) {
        const target = state.resolve(statement.moduleSpecifier, source);
        const star = target && exportsOf(state, target, cache, visiting);
        if (!star) {
          names = undefined;
          break;
        }
        for (const name of star)
          if (name !== "default")
            names.add(name);
      }
    } else if (hasModifier(statement, ts11.SyntaxKind.ExportKeyword)) {
      if (hasModifier(statement, ts11.SyntaxKind.DefaultKeyword))
        names.add("default");
      else if (ts11.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          bindingNames(declaration.name, names);
      else if ("name" in statement && statement.name && ts11.isIdentifier(statement.name))
        names.add(statement.name.text);
    }
  }
  visiting.delete(key);
  cache.set(key, names);
  return names;
}
function references(source) {
  const found = [];
  const visit = (node) => {
    if (ts11.isImportDeclaration(node) && ts11.isStringLiteralLike(node.moduleSpecifier) && node.importClause) {
      const clause = node.importClause, names = [];
      if (clause.name)
        names.push("default");
      if (clause.namedBindings && ts11.isNamedImports(clause.namedBindings))
        for (const element of clause.namedBindings.elements)
          names.push((element.propertyName ?? element.name).text);
      else if (clause.namedBindings)
        names.push("*");
      found.push({ specifier: node.moduleSpecifier, names });
    } else if (ts11.isExportDeclaration(node) && node.moduleSpecifier && ts11.isStringLiteralLike(node.moduleSpecifier)) {
      const names = node.exportClause && ts11.isNamedExports(node.exportClause) ? node.exportClause.elements.map((element) => (element.propertyName ?? element.name).text) : ["*"];
      found.push({ specifier: node.moduleSpecifier, names });
    } else if (ts11.isImportEqualsDeclaration(node) && ts11.isExternalModuleReference(node.moduleReference) && ts11.isStringLiteralLike(node.moduleReference.expression)) {
      found.push({ specifier: node.moduleReference.expression, names: ["*"] });
    } else if (ts11.isImportTypeNode(node) && ts11.isLiteralTypeNode(node.argument) && ts11.isStringLiteralLike(node.argument.literal)) {
      found.push({ specifier: node.argument.literal, names: ["*"] });
    } else if (ts11.isCallExpression(node) && node.expression.kind === ts11.SyntaxKind.ImportKeyword && node.arguments.length >= 1 && ts11.isStringLiteralLike(node.arguments[0])) {
      found.push({ specifier: node.arguments[0], names: ["*"] });
    }
    ts11.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
function problems(state, path, ambient, cache) {
  const source = state.source(path);
  if (!source)
    return [];
  const found = [];
  const parse = source.parseDiagnostics;
  if (!Array.isArray(parse))
    fail("VERIFY_UNSUPPORTED", "this TypeScript version does not expose parse diagnostics");
  for (const diagnostic of parse) {
    found.push({ file: path, name: `syntax:TS${diagnostic.code}`, message: `TS${diagnostic.code} ${ts11.flattenDiagnosticMessageText(diagnostic.messageText, `
`)}` });
  }
  for (const { specifier, names } of references(source)) {
    const target = state.resolve(specifier, source);
    if (!target) {
      if (!ambient(specifier.text))
        for (const name of names)
          found.push({ file: path, name, message: `'${specifier.text}' does not resolve` });
      continue;
    }
    const exported = names.some((name) => name !== "*") ? exportsOf(state, target, cache) : undefined;
    for (const name of names) {
      if (exported && name !== "*" && !exported.has(name))
        found.push({ file: path, name, message: `'${specifier.text}' (${target}) has no export '${name}'` });
    }
  }
  return found;
}
function assertBindings(planned, original, changed, ambient, origin) {
  const files = changed.filter((path) => /\.[cm]?[jt]sx?$/i.test(path) && !/\.d\.[cm]?ts$/i.test(path));
  const cache = new Map;
  const introduced = [];
  for (const path of files) {
    const after = problems(planned, path, ambient, cache);
    if (!after.length)
      continue;
    const from = origin(path);
    const before = from === undefined ? [] : original((state) => problems(state, from, ambient, new Map));
    const counts = new Map;
    for (const item of before)
      counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
    for (const item of after) {
      const count = counts.get(item.name) ?? 0;
      if (count)
        counts.set(item.name, count - 1);
      else
        introduced.push(item);
    }
  }
  const syntax = introduced.filter((item) => item.name.startsWith("syntax:"));
  if (syntax.length)
    fail("NEW_DIAGNOSTICS", syntax.map((item) => `${item.message} (${item.file})`).join("; "));
  if (introduced.length) {
    fail("BINDINGS_NOT_PRESERVED", `${introduced.map((item) => `${item.file}: ${item.message}`).join("; ")}; --verify bindings checks syntax and import/export bindings of changed files; fix the bindings, or rerun with --verify full when an export is only visible to the type checker (module augmentation)`);
  }
  return files.length;
}
var commonJs;
var init_typescript_bindings = __esm(() => {
  init_typescript_vfs();
  commonJs = /\bmodule\.exports\b|\bexports\.[A-Za-z_$]|@typedef\b|@callback\b/;
});

// src/backends/typescript-port-route-setup.ts
import ts12 from "typescript";
function mergeParamHooks(lines) {
  const groups = new Map;
  const output = [];
  for (const line of lines) {
    const source = ts12.createSourceFile("setup.ts", line, ts12.ScriptTarget.Latest, true);
    const statement = source.statements[0];
    const declaration = statement && ts12.isVariableStatement(statement) && statement.declarationList.declarations.length === 1 ? statement.declarationList.declarations[0] : undefined;
    const call = declaration?.initializer;
    if (!declaration || source.statements.length !== 1 || !ts12.isObjectBindingPattern(declaration.name) || !call || !ts12.isCallExpression(call) || call.arguments.length || !/(?:^|\.)useParams$/.test(call.expression.getText(source)) || declaration.name.elements.some((element) => element.initializer || element.dotDotDotToken) || call.typeArguments?.length && (call.typeArguments.length !== 1 || !ts12.isTypeLiteralNode(call.typeArguments[0]))) {
      output.push(line);
      continue;
    }
    const callee = call.expression.getText(source), typed = !!call.typeArguments?.length;
    const key = `${callee}:${typed}:${statement.declarationList.flags}`;
    const group = groups.get(key) ?? { index: output.length, bindings: [], types: [], callee };
    if (!groups.has(key)) {
      groups.set(key, group);
      output.push(line);
    }
    group.bindings.push(...declaration.name.elements.map((element) => element.getText(source)));
    if (typed)
      group.types.push(...call.typeArguments[0].members.map((member) => member.getText(source).replace(/;?$/, ";")));
    const kind = statement.declarationList.flags & ts12.NodeFlags.Const ? "const" : "let";
    output[group.index] = `${kind} { ${[...new Set(group.bindings)].join(", ")} } = ${callee}${typed ? `<{ ${[...new Set(group.types)].join(" ")} }>` : ""}();`;
  }
  return output;
}
var init_typescript_port_route_setup = () => {};

// src/backends/typescript-port-route-config.ts
import ts13 from "typescript";
import { dirname as dirname14, isAbsolute as isAbsolute5, resolve as resolve20 } from "node:path";
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function invalid(path, field) {
  fail("INVALID_PORT_ROUTE_CONFIG", `${path}: ${field}`);
}
function strings2(path, field, value, fallback) {
  if (value === undefined && fallback)
    return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item))
    invalid(path, `${field} must be an array of non-empty strings`);
  return value;
}
function text(path, field, value, fallback) {
  if (value === undefined && fallback !== undefined)
    return fallback;
  if (typeof value !== "string" || !value)
    invalid(path, `${field} must be a non-empty string`);
  return value;
}
function stringMap(path, field, value) {
  if (value === undefined)
    return {};
  if (!isRecord(value) || Object.entries(value).some(([key, item]) => !key || typeof item !== "string" || !item))
    invalid(path, `${field} must map strings to strings`);
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
function snippet(path, field, value) {
  if (typeof value === "string")
    return { value };
  if (!isRecord(value))
    invalid(path, `${field} must be a string or { imports?, setup?, value }`);
  return {
    ...value.imports !== undefined ? { imports: strings2(path, `${field}.imports`, value.imports) } : {},
    ...value.setup !== undefined ? { setup: strings2(path, `${field}.setup`, value.setup) } : {},
    value: text(path, `${field}.value`, value.value)
  };
}
function pair(path, field, value) {
  if (!isRecord(value))
    invalid(path, `${field} must be { next, start }`);
  return { next: snippet(path, `${field}.next`, value.next), start: snippet(path, `${field}.start`, value.start) };
}
function projectPath(root, path, field, value) {
  if (isAbsolute5(value) || value.split(/[\\/]/).includes(".."))
    invalid(path, `${field} must be relative to the root without '..'`);
  const absolute = resolve20(root, value);
  if (!isInside(root, absolute))
    invalid(path, `${field} is outside ${root}`);
  return absolute;
}
function loadPortRouteConfig(root, path, sys) {
  const source = sys.readFile(path);
  if (source === undefined)
    fail("PORT_ROUTE_CONFIG_NOT_FOUND", path);
  let raw;
  try {
    raw = JSON.parse(source);
  } catch {
    invalid(path, "not valid JSON");
  }
  if (!isRecord(raw) || !isRecord(raw.next) || !isRecord(raw.start) || !isRecord(raw.data) || !isRecord(raw.snippets) || !isRecord(raw.templates)) {
    invalid(path, "next, start, data, snippets and templates objects are required");
  }
  const next = raw.next, start = raw.start, data = raw.data, snippets = raw.snippets, templates = raw.templates;
  if (!isRecord(data.hook))
    invalid(path, "data.hook must be { module, name }");
  const routeTree = start.routeTree;
  if (routeTree !== undefined && !isRecord(routeTree))
    invalid(path, "start.routeTree must be an object");
  const ports = raw.ports === undefined ? {} : raw.ports;
  if (!isRecord(ports))
    invalid(path, "ports must be an object");
  const config = {
    next: {
      appDirectory: projectPath(root, path, "next.appDirectory", text(path, "next.appDirectory", next.appDirectory)),
      exclude: strings2(path, "next.exclude", next.exclude, defaults.exclude),
      serverOnlyModules: strings2(path, "next.serverOnlyModules", next.serverOnlyModules, defaults.serverOnlyModules),
      preloadFunctions: strings2(path, "next.preloadFunctions", next.preloadFunctions),
      adapterFile: text(path, "next.adapterFile", next.adapterFile, defaults.adapterFile),
      imports: strings2(path, "next.imports", next.imports, [])
    },
    start: {
      project: projectPath(root, path, "start.project", text(path, "start.project", start.project)),
      routes: projectPath(root, path, "start.routes", text(path, "start.routes", start.routes)),
      ...routeTree ? { routeTree: {
        generator: text(path, "start.routeTree.generator", routeTree.generator),
        configDirectory: projectPath(root, path, "start.routeTree.configDirectory", text(path, "start.routeTree.configDirectory", routeTree.configDirectory)),
        file: projectPath(root, path, "start.routeTree.file", text(path, "start.routeTree.file", routeTree.file))
      } } : {},
      loaderArgs: strings2(path, "start.loaderArgs", start.loaderArgs, defaults.loaderArgs),
      paramsObject: text(path, "start.paramsObject", start.paramsObject, "params"),
      imports: strings2(path, "start.imports", start.imports, [])
    },
    map: stringMap(path, "map", raw.map),
    translate: stringMap(path, "translate", raw.translate),
    data: {
      hook: { module: text(path, "data.hook.module", data.hook.module), name: text(path, "data.hook.name", data.hook.name) },
      prop: text(path, "data.prop", data.prop),
      type: snippet(path, "data.type", data.type),
      typeArgument: text(path, "data.typeArgument", data.typeArgument, "{{type}}")
    },
    ports: Object.fromEntries(Object.entries(ports).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, value]) => [name, pair(path, `ports.${name}`, value)])),
    ...raw.params !== undefined ? { params: pair(path, "params", raw.params) } : {},
    snippets: {
      nextHookType: snippet(path, "snippets.nextHookType", snippets.nextHookType),
      nextDirectType: snippet(path, "snippets.nextDirectType", snippets.nextDirectType),
      nextData: snippet(path, "snippets.nextData", snippets.nextData),
      startQuery: snippet(path, "snippets.startQuery", snippets.startQuery),
      startPrefetch: text(path, "snippets.startPrefetch", snippets.startPrefetch),
      startData: snippet(path, "snippets.startData", snippets.startData),
      startLoader: snippet(path, "snippets.startLoader", snippets.startLoader),
      ...snippets.startRecordLoader !== undefined ? { startRecordLoader: snippet(path, "snippets.startRecordLoader", snippets.startRecordLoader) } : {},
      ...snippets.startSearchDeps !== undefined ? { startSearchDeps: text(path, "snippets.startSearchDeps", snippets.startSearchDeps) } : {},
      todo: text(path, "snippets.todo", snippets.todo, defaults.todo)
    },
    templates: { nextAdapter: text(path, "templates.nextAdapter", templates.nextAdapter), startRoute: text(path, "templates.startRoute", templates.startRoute) },
    afterApply: strings2(path, "afterApply", raw.afterApply, []),
    ...raw.formatCommand !== undefined ? { formatCommand: strings2(path, "formatCommand", raw.formatCommand) } : {}
  };
  if (config.formatCommand && !config.formatCommand.length)
    invalid(path, "formatCommand must be nonempty");
  for (const [key] of Object.entries(config.ports))
    if (!/^[A-Za-z_$][\w$]*$/.test(key))
      invalid(path, `ports.${key} must name a prop`);
  const template = (field, value) => {
    const file = resolve20(dirname14(path), value);
    if (!isInside(root, file))
      invalid(path, `${field} is outside ${root}`);
    const content = sys.readFile(file);
    if (content === undefined)
      fail("PORT_ROUTE_TEMPLATE_NOT_FOUND", `${file} (${field})`);
    return content;
  };
  return { ...config, path, nextAdapterTemplate: template("templates.nextAdapter", config.templates.nextAdapter), startRouteTemplate: template("templates.startRoute", config.templates.startRoute) };
}
function render(template, values, origin) {
  const lines = template.split(`
`).flatMap((line) => {
    const alone = /^([ \t]*)\{\{(\w+)\}\}[ \t]*(,?)$/.exec(line);
    if (alone) {
      const value = lookup(alone[2]);
      if (!value)
        return [];
      const [first, ...rest] = value.split(`
`);
      return [alone[1] + first, ...rest.map((item) => item ? alone[1] + item : item)].map((item, index, all) => index === all.length - 1 ? item + alone[3] : item);
    }
    const indent = /^[ \t]*/.exec(line)[0];
    return [line.replace(/\{\{(\w+)\}\}/g, (_, key) => lookup(key).replace(/\n(?=.)/g, `
${indent}`))];
  });
  return lines.join(`
`);
  function lookup(key) {
    if (!Object.hasOwn(values, key))
      fail("INVALID_PORT_ROUTE_TEMPLATE", `${origin} uses unknown placeholder {{${key}}}; available: ${Object.keys(values).sort().join(", ")}`);
    return values[key];
  }
}

class ImportSet {
  entries = new Map;
  addText(declarations, origin) {
    for (const declaration of declarations ?? []) {
      const source = ts13.createSourceFile("import.ts", declaration, ts13.ScriptTarget.Latest, true);
      if (!source.statements.length || source.statements.some((statement) => !ts13.isImportDeclaration(statement))) {
        fail("INVALID_PORT_ROUTE_CONFIG", `${origin}: '${declaration}' must contain import declarations only`);
      }
      for (const statement of source.statements)
        this.addDeclaration(statement);
    }
  }
  addDeclaration(statement) {
    const module = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) {
      this.entry(module).sideEffect = true;
      return;
    }
    if (clause.name)
      this.addDefault(module, clause.name.text, clause.isTypeOnly);
    const bindings = clause.namedBindings;
    if (bindings && ts13.isNamespaceImport(bindings))
      this.addNamespace(module, bindings.name.text);
    if (bindings && ts13.isNamedImports(bindings))
      for (const element of bindings.elements) {
        this.addNamed(module, (element.propertyName ?? element.name).text, element.name.text, clause.isTypeOnly || element.isTypeOnly);
      }
  }
  addNamed(module, name, local = name, typeOnly = false) {
    const entry = this.entry(module);
    const existing = entry.named.get(local);
    if (existing && existing.name !== name)
      fail("PORT_ROUTE_IMPORT_CONFLICT", `${local} is imported as both ${existing.name} and ${name} from ${module}`);
    this.assertLocal(local, module);
    entry.named.set(local, { name, ...local !== name ? { alias: local } : {}, typeOnly: existing ? existing.typeOnly && typeOnly : typeOnly });
  }
  addDefault(module, local, typeOnly = false) {
    const entry = this.entry(module);
    if (entry.defaultName && entry.defaultName !== local)
      fail("PORT_ROUTE_IMPORT_CONFLICT", `default import of ${module} named ${entry.defaultName} and ${local}`);
    this.assertLocal(local, module);
    entry.defaultName = local;
    entry.typeOnly = entry.typeOnly && typeOnly;
  }
  addNamespace(module, local) {
    const entry = this.entry(module);
    this.assertLocal(local, module);
    entry.namespace = local;
  }
  locals() {
    const names = new Set;
    for (const entry of this.entries.values()) {
      if (entry.defaultName)
        names.add(entry.defaultName);
      if (entry.namespace)
        names.add(entry.namespace);
      for (const local of entry.named.keys())
        names.add(local);
    }
    return names;
  }
  assertLocal(local, module) {
    for (const [other, entry] of this.entries) {
      if (other === module)
        continue;
      if (entry.defaultName === local || entry.namespace === local || entry.named.has(local)) {
        fail("PORT_ROUTE_IMPORT_CONFLICT", `${local} would be imported from both ${other} and ${module}; rename one of the configured imports`);
      }
    }
  }
  entry(module) {
    let entry = this.entries.get(module);
    if (!entry) {
      entry = { module, typeOnly: true, named: new Map, sideEffect: false };
      this.entries.set(module, entry);
    }
    return entry;
  }
  print(quote = '"') {
    const literal = (module) => `${quote}${module.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`)}${quote}`;
    const lines = [];
    for (const entry of [...this.entries.values()].sort((a, b) => a.module < b.module ? -1 : a.module > b.module ? 1 : 0)) {
      const key = (item) => [item.name.toLowerCase(), item.name, item.alias ?? ""].join("\x00");
      const named = [...entry.named.values()].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
      const allTypes = !entry.defaultName && !entry.namespace && named.length > 0 && named.every((item) => item.typeOnly);
      const specifier = (item) => `${item.typeOnly && !allTypes ? "type " : ""}${item.name}${item.alias ? ` as ${item.alias}` : ""}`;
      if (entry.namespace)
        lines.push(`import ${entry.defaultName ? `${entry.defaultName}, ` : ""}* as ${entry.namespace} from ${literal(entry.module)};`);
      const head = entry.namespace ? undefined : entry.defaultName;
      if (head || named.length) {
        const parts = [head, named.length ? `{ ${named.map(specifier).join(", ")} }` : undefined].filter(Boolean).join(", ");
        lines.push(`import ${allTypes ? "type " : ""}${parts} from ${literal(entry.module)};`);
      }
      if (entry.sideEffect && !head && !named.length && !entry.namespace)
        lines.push(`import ${literal(entry.module)};`);
    }
    return lines.join(`
`);
  }
}
function fill(value, values, origin) {
  return value.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!Object.hasOwn(values, key))
      fail("INVALID_PORT_ROUTE_TEMPLATE", `${origin} uses unknown placeholder {{${key}}}; available: ${Object.keys(values).sort().join(", ")}`);
    return values[key];
  });
}
var defaults;
var init_typescript_port_route_config = __esm(() => {
  init_typescript_vfs();
  defaults = {
    exclude: ["page.tsx", "page.ts", "layout.tsx", "loading.tsx", "error.tsx", "not-found.tsx", "template.tsx", "default.tsx", "route.ts", "**/_hooks/**", "*adapter*"],
    serverOnlyModules: ["server-only"],
    adapterFile: "{{view}}-adapter.tsx",
    loaderArgs: ["context", "location", "params"],
    todo: "(() => { throw new Error({{message}}); })()"
  };
});

// src/backends/typescript-port-route-extract.ts
import ts14 from "typescript";
import { resolve as resolve21 } from "node:path";
function jsxStringExpression(literal) {
  const emitted = ts14.transpileModule(`const value = <element value=${literal} />;`, {
    compilerOptions: { jsx: ts14.JsxEmit.React, target: ts14.ScriptTarget.ESNext },
    fileName: "literal.tsx"
  }).outputText;
  const source = ts14.createSourceFile("literal.js", emitted, ts14.ScriptTarget.Latest, true);
  let result;
  const visit = (node) => {
    if (ts14.isPropertyAssignment(node) && node.name.getText(source) === "value" && ts14.isStringLiteral(node.initializer))
      result = node.initializer.getText(source);
    ts14.forEachChild(node, visit);
  };
  visit(source);
  if (result === undefined)
    fail("PORT_ROUTE_LITERAL", "cannot translate JSX string attribute");
  return result;
}
function dedent(text, source, node) {
  const start = node.getStart(source);
  const indent = /^[ \t]*/.exec(source.text.slice(source.text.lastIndexOf(`
`, start - 1) + 1, start))[0];
  return indent ? text.split(`
`).map((line, index) => index && line.startsWith(indent) ? line.slice(indent.length) : line).join(`
`) : text;
}
function unwrap(node) {
  while (ts14.isParenthesizedExpression(node) || ts14.isAsExpression(node) || ts14.isSatisfiesExpression(node) || ts14.isNonNullExpression(node))
    node = node.expression;
  return node;
}
function wrap(text) {
  const source = ts14.createSourceFile("expression.ts", `(${text})`, ts14.ScriptTarget.Latest, true);
  const statement = source.statements[0];
  const expression = statement && ts14.isExpressionStatement(statement) && ts14.isParenthesizedExpression(statement.expression) ? statement.expression.expression : undefined;
  if (expression && (ts14.isIdentifier(expression) || ts14.isPropertyAccessExpression(expression) || ts14.isElementAccessExpression(expression) || ts14.isCallExpression(expression) || ts14.isObjectLiteralExpression(expression) || ts14.isArrayLiteralExpression(expression) || ts14.isLiteralExpression(expression) || ts14.isParenthesizedExpression(expression) || expression.kind === ts14.SyntaxKind.TrueKeyword || expression.kind === ts14.SyntaxKind.FalseKeyword || expression.kind === ts14.SyntaxKind.NullKeyword))
    return text;
  return `(${text})`;
}

class RouteExtractor {
  ws;
  options;
  checker;
  statements = [];
  emitted = new Map;
  notes = [];
  translations;
  constructor(ws, options) {
    this.ws = ws;
    this.options = options;
    this.checker = ws.program().getTypeChecker();
    this.translations = new Map(Object.entries(options.translate).map(([from, to]) => [normalize(from), to]));
  }
  extract(page) {
    const source = this.ws.program().getSourceFile(page);
    if (!source)
      fail("FILE_NOT_IN_PROJECT", page);
    const component = this.pageComponent(source);
    const scope = { source, fn: component, page: true };
    const preloads = this.preloads(scope);
    const element = this.viewElement(source, component);
    const view = this.view(element, preloads, scope);
    return { page, statements: this.statements, preloads, view, notes: this.notes };
  }
  pageComponent(source) {
    for (const statement of source.statements) {
      if (ts14.isFunctionDeclaration(statement) && statement.body && ts14.getCombinedModifierFlags(statement) & ts14.ModifierFlags.Default)
        return statement;
      if (ts14.isExportAssignment(statement) && !statement.isExportEquals) {
        const symbol = this.checker.getSymbolAtLocation(unwrap(statement.expression));
        const declaration = symbol?.declarations?.[0];
        if (declaration && ts14.isFunctionDeclaration(declaration) && declaration.body)
          return declaration;
        const fn = unwrap(statement.expression);
        if ((ts14.isArrowFunction(fn) || ts14.isFunctionExpression(fn)) && ts14.isBlock(fn.body))
          return fn;
      }
    }
    fail("PORT_ROUTE_UNSUPPORTED_PAGE", `${source.fileName} must default-export a page function with a block body`);
  }
  preloads(scope) {
    const found = [];
    const visit = (node) => {
      if (ts14.isVariableDeclaration(node) && node.initializer) {
        const init = unwrap(node.initializer);
        const awaited = ts14.isAwaitExpression(init) ? unwrap(init.expression) : init;
        if (ts14.isIdentifier(node.name)) {
          const preload = ts14.isCallExpression(awaited) ? this.preloadCall(awaited, scope) : undefined;
          if (preload)
            found.push({ ...preload, variable: node.name.text });
        } else if (ts14.isArrayBindingPattern(node.name) && ts14.isCallExpression(awaited) && awaited.expression.getText(scope.source) === "Promise.all" && awaited.arguments[0] && ts14.isArrayLiteralExpression(unwrap(awaited.arguments[0]))) {
          const elements = unwrap(awaited.arguments[0]).elements;
          node.name.elements.forEach((binding, index) => {
            const element = elements[index] && unwrap(elements[index]);
            if (!element || !ts14.isBindingElement(binding) || !ts14.isIdentifier(binding.name) || !ts14.isCallExpression(element))
              return;
            const preload = this.preloadCall(element, scope);
            if (preload)
              found.push({ ...preload, variable: binding.name.text });
          });
        }
      }
      if (!ts14.isFunctionLike(node) || node === scope.fn)
        ts14.forEachChild(node, visit);
    };
    visit(scope.fn.body);
    const names = found.map((item) => item.variable);
    if (new Set(names).size !== names.length)
      fail("PORT_ROUTE_UNSUPPORTED_PAGE", `preloaded variables must be unique: ${names.join(", ")}`);
    return found;
  }
  preloadCall(call, scope) {
    if (!ts14.isIdentifier(call.expression))
      return;
    const symbol = this.checker.getSymbolAtLocation(call.expression);
    if (this.isPreloadFunction(call.expression, symbol))
      return this.directPreload(call, scope);
    if (!symbol)
      return;
    const target = symbol.flags & ts14.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
    const declaration = target.declarations?.[0];
    const fn = declaration && (ts14.isFunctionDeclaration(declaration) ? declaration : ts14.isVariableDeclaration(declaration) && declaration.initializer && (ts14.isArrowFunction(unwrap(declaration.initializer)) || ts14.isFunctionExpression(unwrap(declaration.initializer))) ? unwrap(declaration.initializer) : undefined);
    if (!fn || !fn.body)
      return;
    const hookSource = fn.getSourceFile();
    if (hookSource.isDeclarationFile || hookSource.fileName.split(/[\\/]/).includes("node_modules"))
      return;
    const returned = this.returnedCall(fn);
    if (!returned || !ts14.isIdentifier(returned.expression) || !this.isPreloadFunction(returned.expression, this.checker.getSymbolAtLocation(returned.expression)))
      return;
    if (!returned.arguments[0])
      fail("PORT_ROUTE_UNSUPPORTED_PAGE", `${returned.expression.text}(...) needs a function reference argument in ${hookSource.fileName}`);
    const name = ts14.isFunctionDeclaration(fn) && fn.name ? fn.name.text : declaration.name.getText(hookSource);
    const hookScope = { source: hookSource, fn, args: new Map, page: false };
    const query = this.attempt(() => this.translate(returned.arguments[0], { ...hookScope, args: undefined }));
    if ("todo" in query)
      fail("PORT_ROUTE_UNSUPPORTED_PAGE", `cannot translate the Convex function reference ${returned.arguments[0].getText(hookSource)} in ${hookSource.fileName}: ${query.todo}`);
    const args = this.attempt(() => {
      fn.parameters.forEach((parameter, index) => {
        if (!ts14.isIdentifier(parameter.name) || parameter.dotDotDotToken)
          throw new Untranslatable(`${name} has a destructured or rest parameter`);
        const argument = call.arguments[index];
        const value = argument ? this.translate(argument, scope) : parameter.initializer ? this.translate(parameter.initializer, { ...hookScope, args: undefined }) : { text: "undefined", imports: [] };
        hookScope.args.set(this.checker.getSymbolAtLocation(parameter.name), value);
      });
      if (call.arguments.length > fn.parameters.length)
        throw new Untranslatable(`${name} receives more arguments than it declares`);
      return returned.arguments[1] ? this.translate(returned.arguments[1], hookScope) : { text: "{}", imports: [] };
    });
    return { query, args, hook: { name, path: resolve21(hookSource.fileName) } };
  }
  isPreloadFunction(callee, symbol) {
    const imported = symbol && this.importBinding(symbol);
    return this.options.preloadFunctions.includes(imported?.imported ?? callee.text);
  }
  directPreload(call, scope) {
    const callee = call.expression.getText(scope.source);
    if (!call.arguments[0])
      fail("PORT_ROUTE_UNSUPPORTED_PAGE", `${callee}(...) needs a function reference argument in ${scope.source.fileName}`);
    const query = this.attempt(() => this.translate(call.arguments[0], scope));
    if ("todo" in query)
      fail("PORT_ROUTE_UNSUPPORTED_PAGE", `cannot translate the Convex function reference ${call.arguments[0].getText(scope.source)}: ${query.todo}`);
    const argument = call.arguments[1];
    return { query, args: argument ? this.attempt(() => this.translate(argument, scope)) : { text: "{}", imports: [] } };
  }
  returnedCall(fn) {
    const body = fn.body;
    let expression;
    if (!ts14.isBlock(body))
      expression = body;
    else {
      const returns = body.statements.filter(ts14.isReturnStatement);
      if (returns.length !== 1 || !returns[0].expression)
        return;
      expression = returns[0].expression;
    }
    let call = unwrap(expression);
    if (ts14.isAwaitExpression(call))
      call = unwrap(call.expression);
    return ts14.isCallExpression(call) ? call : undefined;
  }
  attempt(run) {
    const statements = this.statements.length, emitted = new Map(this.emitted);
    try {
      return run();
    } catch (error) {
      if (!(error instanceof Untranslatable))
        throw error;
      this.statements.length = statements;
      this.emitted.clear();
      for (const [key, value] of emitted)
        this.emitted.set(key, value);
      return { todo: error.message };
    }
  }
  translate(node, scope) {
    const imports = [];
    const text = this.expression(node, scope, imports);
    return { text, imports };
  }
  expression(node, scope, imports) {
    const source = scope.source;
    if (scope.page && ts14.isExpression(node)) {
      const translated = this.translations.get(normalize(node.getText(source)));
      if (translated !== undefined)
        return translated;
    }
    if (ts14.isIdentifier(node))
      return this.identifier(node, scope, imports);
    if (ts14.isShorthandPropertyAssignment(node)) {
      const symbol = this.checker.getShorthandAssignmentValueSymbol(node);
      const value = symbol ? this.reference(node.name, symbol, scope, imports) : this.identifier(node.name, scope, imports);
      return value === node.name.text ? node.name.text : `${node.name.text}: ${value}`;
    }
    if (ts14.isFunctionLike(node) || ts14.isClassLike(node) || ts14.isJsxElement(node) || ts14.isJsxSelfClosingElement(node)) {
      throw new Untranslatable(`${node.getText(source).slice(0, 60)} contains a function, class or JSX value`);
    }
    const start = node.getStart(source);
    let result = "", cursor = start;
    const children = [];
    ts14.forEachChild(node, (child) => {
      children.push(child);
    });
    for (const child of children) {
      if (this.skipChild(node, child))
        continue;
      const childStart = child.getStart(source);
      result += source.text.slice(cursor, childStart) + this.expression(child, scope, imports);
      cursor = child.end;
    }
    return result + source.text.slice(cursor, node.end);
  }
  skipChild(parent, child) {
    if (ts14.isPropertyAccessExpression(parent) && child === parent.name)
      return true;
    if (ts14.isPropertyAssignment(parent) && child === parent.name && !ts14.isComputedPropertyName(child))
      return true;
    if (ts14.isTypeNode(child))
      return true;
    if ((ts14.isMethodDeclaration(parent) || ts14.isGetAccessor(parent) || ts14.isSetAccessor(parent)) && child === parent.name)
      return true;
    return false;
  }
  identifier(node, scope, imports) {
    if (node.text === "undefined")
      return node.text;
    const symbol = this.checker.getSymbolAtLocation(node);
    if (!symbol)
      throw new Untranslatable(`${node.text} has no resolved declaration`);
    return this.reference(node, symbol, scope, imports);
  }
  reference(node, symbol, scope, imports) {
    const substitution = scope.args?.get(symbol);
    if (substitution !== undefined) {
      imports.push(...substitution.imports);
      return wrap(substitution.text);
    }
    const declaration = symbol.declarations?.[0];
    if (!declaration)
      throw new Untranslatable(`${node.text} has no declaration`);
    const file = resolve21(declaration.getSourceFile().fileName);
    if (declaration.getSourceFile().isDeclarationFile && !this.importBinding(symbol))
      return node.text;
    const binding = this.importBinding(symbol);
    if (binding) {
      if (binding.target.kind === "file" && !this.options.isMoved(binding.target.path)) {
        throw new Untranslatable(`${node.text} is imported from ${binding.target.path}, which stays in Next`);
      }
      imports.push(binding);
      return node.text;
    }
    if (file !== resolve21(scope.source.fileName))
      throw new Untranslatable(`${node.text} is declared outside ${scope.source.fileName}`);
    if (ts14.isParameter(declaration) || ts14.isBindingElement(declaration) && this.parameterOf(declaration)) {
      throw new Untranslatable(`${node.text} is a ${scope.page ? "page" : "hook"} parameter without a configured translation`);
    }
    const variable = ts14.isVariableDeclaration(declaration) ? declaration : ts14.isBindingElement(declaration) ? this.variableOf(declaration) : undefined;
    if (!variable || !variable.initializer || !(variable.parent.flags & ts14.NodeFlags.Const)) {
      throw new Untranslatable(`${node.text} is not a const value (${ts14.SyntaxKind[declaration.kind]})`);
    }
    const local = scope.page && this.within(variable, scope.fn);
    if (!local) {
      if (!ts14.isVariableDeclaration(declaration))
        throw new Untranslatable(`${node.text}: module-level destructuring is unsupported`);
      return wrap(this.expression(variable.initializer, { ...scope, page: false, args: scope.args }, imports));
    }
    return this.pageBinding(node, symbol, declaration, variable, scope);
  }
  pageBinding(node, symbol, declaration, variable, scope) {
    const existing = this.emitted.get(symbol);
    if (existing !== undefined)
      return existing;
    const imports = [];
    let name = variable.name, value;
    if (ts14.isArrayBindingPattern(variable.name)) {
      let top = declaration;
      while (top.parent.parent !== variable)
        top = top.parent.parent;
      const initializer = unwrap(variable.initializer);
      const call = ts14.isAwaitExpression(initializer) ? unwrap(initializer.expression) : undefined;
      const list = call && ts14.isCallExpression(call) && call.expression.getText(scope.source) === "Promise.all" && call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
      const item = list && ts14.isArrayLiteralExpression(list) ? list.elements[variable.name.elements.indexOf(top)] : undefined;
      if (!item || ts14.isSpreadElement(item))
        throw new Untranslatable(`${node.text}: only await Promise.all([...]) array destructuring is supported`);
      value = this.translations.get(normalize(`await ${item.getText(scope.source)}`)) ?? `await ${this.expression(item, scope, imports)}`;
      name = top.name;
    } else
      value = this.expression(variable.initializer, scope, imports);
    if (ts14.isIdentifier(name)) {
      this.statements.push({ text: dedent(`const ${node.text} = ${value};`, scope.source, variable), imports });
      this.emitted.set(symbol, node.text);
      return node.text;
    }
    return this.destructured(node, name, value, scope, symbol, imports);
  }
  destructured(node, pattern, value, scope, symbol, imports) {
    if (!ts14.isObjectBindingPattern(pattern))
      throw new Untranslatable(`${node.text}: nested destructuring is unsupported`);
    const element = pattern.elements.find((item) => ts14.isIdentifier(item.name) && item.name.text === node.text);
    if (!element || element.dotDotDotToken || element.initializer)
      throw new Untranslatable(`${node.text}: unsupported destructuring`);
    const property = element.propertyName ? element.propertyName.getText(scope.source) : node.text;
    if (value === this.options.paramsObject && !this.options.params.includes(property)) {
      throw new Untranslatable(`route parameter '${property}' is not a segment of the Start route`);
    }
    if (value !== this.options.paramsObject) {
      let shared = this.emitted.get(pattern);
      if (shared === undefined) {
        shared = "__portRouteValue";
        const reserved = scope.source.text + this.statements.map((statement) => statement.text).join(`
`);
        while (reserved.includes(shared))
          shared += "2";
        this.statements.push({ text: `const ${shared} = ${value};`, imports });
        this.emitted.set(pattern, shared);
      }
      value = shared;
    }
    this.statements.push({ text: `const { ${element.getText(scope.source)} } = ${value};`, imports });
    this.emitted.set(symbol, node.text);
    return node.text;
  }
  parameterOf(element) {
    let current = element;
    while (ts14.isBindingElement(current) || ts14.isObjectBindingPattern(current) || ts14.isArrayBindingPattern(current))
      current = current.parent;
    return ts14.isParameter(current) ? current : undefined;
  }
  variableOf(element) {
    let current = element;
    while (ts14.isBindingElement(current) || ts14.isObjectBindingPattern(current) || ts14.isArrayBindingPattern(current))
      current = current.parent;
    return ts14.isVariableDeclaration(current) ? current : undefined;
  }
  within(node, container) {
    for (let current = node;current; current = current.parent)
      if (current === container)
        return true;
    return false;
  }
  importBinding(symbol) {
    const declaration = symbol.declarations?.[0];
    if (!declaration || !(ts14.isImportSpecifier(declaration) || ts14.isImportClause(declaration) || ts14.isNamespaceImport(declaration)))
      return;
    let statement = declaration;
    while (!ts14.isImportDeclaration(statement))
      statement = statement.parent;
    const specifier = statement.moduleSpecifier;
    const source = statement.getSourceFile();
    const imported = ts14.isImportSpecifier(declaration) ? (declaration.propertyName ?? declaration.name).text : ts14.isImportClause(declaration) ? "default" : "*";
    const local = ts14.isImportSpecifier(declaration) ? declaration.name.text : ts14.isImportClause(declaration) ? declaration.name.text : declaration.name.text;
    const typeOnly = !!statement.importClause?.isTypeOnly || ts14.isImportSpecifier(declaration) && declaration.isTypeOnly;
    const resolved = this.ws.resolveModule(specifier, source);
    const path = resolved && resolve21(resolved.resolvedFileName);
    const workspaceFile = path && !path.split(/[\\/]/).includes("node_modules") && !resolved.isExternalLibraryImport;
    const owner = this.ws.ownersOf(source.fileName)[0];
    const options = owner ? this.ws.participant(owner).parsed.options : this.ws.editOptions;
    const alias = Object.keys(options.paths ?? {}).some((pattern) => {
      const [prefix, suffix] = pattern.split("*");
      return pattern.includes("*") ? specifier.text.startsWith(prefix) && specifier.text.endsWith(suffix) : pattern === specifier.text;
    });
    const fileTarget = workspaceFile && (specifier.text.startsWith(".") || alias);
    return { local, imported, typeOnly, target: fileTarget ? { kind: "file", path } : { kind: "package", module: specifier.text } };
  }
  viewElement(source, component) {
    const returns = [];
    const visit = (node) => {
      if (ts14.isReturnStatement(node) && node.expression)
        returns.push(node);
      if (!ts14.isFunctionLike(node) || node === component)
        ts14.forEachChild(node, visit);
    };
    visit(component.body);
    const candidates = [];
    for (const statement of returns) {
      const walk = (node, wrappers) => {
        const opening = ts14.isJsxElement(node) ? node.openingElement : ts14.isJsxSelfClosingElement(node) ? node : undefined;
        if (opening) {
          const symbol = ts14.isIdentifier(opening.tagName) ? this.checker.getSymbolAtLocation(opening.tagName) : undefined;
          const binding = symbol && this.importBinding(symbol);
          if (binding?.target.kind === "file" && this.options.isMoved(binding.target.path)) {
            candidates.push({ element: opening, full: node, wrappers });
            return;
          }
          if (ts14.isJsxElement(node))
            for (const child of node.children)
              walk(child, [...wrappers, opening.tagName.getText(source)]);
          return;
        }
        if (ts14.isJsxFragment(node)) {
          for (const child of node.children)
            walk(child, [...wrappers, "<>"]);
          return;
        }
        ts14.forEachChild(node, (child) => walk(child, wrappers));
      };
      walk(statement.expression, []);
    }
    if (candidates.length !== 1) {
      fail("PORT_ROUTE_VIEW_NOT_FOUND", `${source.fileName} must render exactly one component imported from a moved module (found ${candidates.length}); move the view into the route directory or split the page`);
    }
    const found = candidates[0];
    if (ts14.isJsxElement(found.full) && found.full.children.some((child) => !ts14.isJsxText(child) || child.getText(source).trim())) {
      fail("PORT_ROUTE_UNSUPPORTED_PAGE", `${found.element.tagName.getText(source)} receives children; pass them as props before porting`);
    }
    return found;
  }
  view(found, preloads, scope) {
    const { element } = found;
    const source = scope.source;
    const symbol = this.checker.getSymbolAtLocation(element.tagName);
    const binding = this.importBinding(symbol);
    const target = this.checker.getAliasedSymbol(symbol);
    const declaration = target.valueDeclaration ?? target.declarations?.[0];
    const component = declaration && (ts14.isFunctionDeclaration(declaration) ? declaration : ts14.isVariableDeclaration(declaration) && declaration.initializer && (ts14.isArrowFunction(unwrap(declaration.initializer)) || ts14.isFunctionExpression(unwrap(declaration.initializer))) ? unwrap(declaration.initializer) : undefined);
    if (!component || binding.target.kind !== "file" || resolve21(component.getSourceFile().fileName) !== binding.target.path) {
      fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${element.tagName.getText(source)} must be a function component declared in its module (re-exports and wrappers such as memo/forwardRef are unsupported)`);
    }
    const attributes = [];
    for (const attribute of element.attributes.properties) {
      if (!ts14.isJsxAttribute(attribute))
        fail("PORT_ROUTE_UNSUPPORTED_PAGE", `spread attributes on ${element.tagName.getText(source)} are unsupported`);
      const name = attribute.name.getText(source);
      const initializer = attribute.initializer;
      const expression = !initializer ? undefined : ts14.isJsxExpression(initializer) ? initializer.expression : initializer;
      const preload = expression && ts14.isIdentifier(unwrap(expression)) ? preloads.find((item) => item.variable === unwrap(expression).text) : undefined;
      if (preload) {
        attributes.push({ name, kind: "preloaded", preload });
        continue;
      }
      const sourceText = !initializer ? "true" : ts14.isStringLiteral(initializer) ? jsxStringExpression(initializer.getText(source)) : expression?.getText(source) ?? "undefined";
      const start = !expression || ts14.isStringLiteral(expression) ? { text: sourceText, imports: [] } : this.attempt(() => this.translate(expression, scope));
      attributes.push({ name, kind: "value", source: sourceText, start });
    }
    const unused = preloads.filter((item) => !attributes.some((attribute) => attribute.preload === item));
    for (const item of unused)
      this.notes.push(`TODO(port-route): ${item.variable} is preloaded but not passed to ${element.tagName.getText(source)}; the Start loader prefetches it without a consumer.`);
    const parameter = component.parameters[0];
    const props = parameter ? this.checker.getPropertiesOfType(this.checker.getTypeAtLocation(parameter)).map((property) => ({
      name: property.name,
      optional: (property.flags & ts14.SymbolFlags.Optional) !== 0
    })).sort((a, b) => a.name < b.name ? -1 : 1) : [];
    for (const wrapper of found.wrappers)
      this.notes.push(`TODO(port-route): the page wraps ${element.tagName.getText(source)} in <${wrapper}>; the generated adapter and Start route render the view without it.`);
    return { tag: element.tagName.getText(source), exported: binding.imported, path: binding.target.path, component, attributes, props, wrappers: found.wrappers };
  }
}
var Untranslatable, normalize = (text) => text.replace(/\s+/g, "");
var init_typescript_port_route_extract = __esm(() => {
  init_typescript_vfs();
  Untranslatable = class Untranslatable extends Error {
  };
});

// src/backends/typescript-port-route.ts
import ts15 from "typescript";
import { spawnSync } from "node:child_process";
import { createRequire as createRequire3 } from "node:module";
import { lstatSync as lstatSync2, readdirSync as readdirSync3, readFileSync as readFileSync4 } from "node:fs";
import { mkdir as mkdir5, mkdtemp, readFile as readFile8, rm as rm3, writeFile as writeFile4 } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename as basename5, dirname as dirname15, extname as extname4, join as join2, relative as relative10, resolve as resolve22 } from "node:path";
import { pathToFileURL } from "node:url";
function pascal(value) {
  return value.split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join("");
}
function camel(value) {
  const name = pascal(value);
  return name ? name[0].toLowerCase() + name.slice(1) : name;
}
function hasPage(directory) {
  return pageNames.some((name) => {
    try {
      return lstatSync2(join2(directory, name)).isFile();
    } catch {
      return false;
    }
  });
}
function preparePortRoute(request, sys) {
  const root = request.root, routeDir = resolve22(request.file);
  if (!request.config)
    fail("INVALID_REQUEST", "port-route requires a configuration");
  if (!request.target)
    fail("INVALID_REQUEST", "port-route requires --to");
  const config = loadPortRouteConfig(root, request.config, sys);
  const page = pageNames.map((name) => join2(routeDir, name)).find((path) => sys.fileExists(path));
  if (!page)
    fail("PORT_ROUTE_PAGE_NOT_FOUND", `${routeDir} has no page.tsx`);
  const appDirectory = config.next.appDirectory;
  if (!isInside(appDirectory, routeDir))
    fail("PORT_ROUTE_OUTSIDE_APP", `${routeDir} is not below next.appDirectory ${appDirectory}`);
  const segments = [], params = [];
  for (const part of portablePath(relative10(appDirectory, routeDir)).split("/").filter(Boolean)) {
    if (/^\(.+\)$/.test(part))
      continue;
    if (/^\[\[?\.\.\./.test(part) || part.startsWith("@") || part.startsWith("_"))
      fail("PORT_ROUTE_UNSUPPORTED_SEGMENT", `${part}: catch-all, parallel and private segments need a hand-written Start route`);
    const dynamic = /^\[([A-Za-z_$][\w$]*)\]$/.exec(part);
    if (dynamic) {
      segments.push(`$${dynamic[1]}`);
      params.push(dynamic[1]);
      continue;
    }
    if (part.includes("[") || part.includes("."))
      fail("PORT_ROUTE_UNSUPPORTED_SEGMENT", `${part} cannot be expressed as a flat TanStack route segment`);
    segments.push(part);
  }
  const kept = [], moves = [];
  let index = false;
  const target = resolve22(request.target);
  const visit = (directory) => {
    for (const entry of readdirSync3(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join2(directory, entry.name);
      if (entry.isSymbolicLink())
        fail("SYMLINK_UNSUPPORTED", path);
      if (entry.isDirectory()) {
        if (hasPage(path) || nestedRoute(path)) {
          index = true;
          kept.push(path);
          continue;
        }
        visit(path);
        continue;
      }
      if (!entry.isFile())
        fail("UNSUPPORTED_FILE", path);
      const excluded = excludedByPatterns(path, routeDir, [...config.next.exclude, ...request.exclude ?? []]);
      if (excluded || serverOnly(path)) {
        kept.push(path);
        continue;
      }
      moves.push([path, join2(target, relative10(routeDir, path))]);
    }
  };
  const nestedRoute = (directory) => readdirSync3(directory, { withFileTypes: true }).some((entry) => entry.isDirectory() && (hasPage(join2(directory, entry.name)) || nestedRoute(join2(directory, entry.name))));
  const serverOnly = (path) => {
    if (!/\.[cm]?[jt]sx?$/.test(path))
      return false;
    const text = sys.readFile(path) ?? "";
    const source = ts15.createSourceFile(path, text, ts15.ScriptTarget.Latest, false);
    return source.statements.some((statement) => ts15.isImportDeclaration(statement) && ts15.isStringLiteral(statement.moduleSpecifier) && config.next.serverOnlyModules.includes(statement.moduleSpecifier.text));
  };
  visit(routeDir);
  if (!moves.length)
    fail("EMPTY_DIRECTORY", `${routeDir} has no client files to move after exclusions`);
  const startRoutes = request.startRoutes ? resolve22(request.startRoutes) : config.start.routes;
  const startConfig = configPathFor(config.start.project);
  const fileName = segments.length ? `${segments.join(".")}${index ? ".index" : ""}.tsx` : "index.tsx";
  const routePath = `/${segments.join("/")}`;
  const routeId = segments.length ? `${routePath}${index ? "/" : ""}` : "/";
  const routeName = pascal([...segments].reverse().find((segment) => !segment.startsWith("$")) ?? "index");
  return {
    config,
    routeDir,
    page,
    segments,
    params,
    index,
    startRoutes,
    startConfig,
    startFile: join2(startRoutes, fileName),
    routeId,
    routePath,
    routeName,
    moves,
    map: { ...config.map, ...request.map ?? {} },
    kept: kept.sort()
  };
}
function relativeSpecifier(from, to) {
  const path = portablePath(relative10(dirname15(from), to)).replace(/\.[cm]?[jt]sx?$/, "").replace(/\/index$/, "");
  return path.startsWith(".") ? path : `./${path}`;
}
function references2(source, name) {
  let count = 0;
  const visit = (node) => {
    if (ts15.isImportDeclaration(node))
      return;
    if (ts15.isIdentifier(node) && node.text === name) {
      const parent = node.parent;
      const named = ts15.isPropertyAccessExpression(parent) && parent.name === node || ts15.isPropertyAssignment(parent) && parent.name === node || ts15.isPropertySignature(parent) && parent.name === node || ts15.isJsxAttribute(parent) || ts15.isBindingElement(parent) && parent.propertyName === node || ts15.isQualifiedName(parent) && parent.right === node || ts15.isMethodDeclaration(parent) && parent.name === node;
      if (!named)
        count += 1;
    }
    ts15.forEachChild(node, visit);
  };
  visit(source);
  return count;
}
function importLocals(source) {
  const locals = new Map;
  for (const statement of source.statements) {
    if (!ts15.isImportDeclaration(statement) || !ts15.isStringLiteral(statement.moduleSpecifier) || !statement.importClause)
      continue;
    const module = statement.moduleSpecifier.text, clause = statement.importClause;
    if (clause.name)
      locals.set(clause.name.text, { statement, node: clause.name, module, imported: "default" });
    const bindings = clause.namedBindings;
    if (bindings && ts15.isNamespaceImport(bindings))
      locals.set(bindings.name.text, { statement, node: bindings, module, imported: "*" });
    if (bindings && ts15.isNamedImports(bindings))
      for (const element of bindings.elements) {
        locals.set(element.name.text, { statement, node: element, module, imported: (element.propertyName ?? element.name).text });
      }
  }
  return locals;
}
function removal(source, statement) {
  const text = source.text;
  const start = statement.getStart(source), lineStart = text.lastIndexOf(`
`, start - 1) + 1;
  const ownLine = !text.slice(lineStart, start).trim();
  const from = ownLine ? lineStart : statement.getFullStart();
  const to = ownLine && text[statement.end] === `
` ? statement.end + 1 : statement.end;
  return { span: { start: from, length: to - from }, newText: "" };
}
function updateImports(path, before, after, add) {
  const original = ts15.createSourceFile(path, before, ts15.ScriptTarget.Latest, true);
  let source = ts15.createSourceFile(path, after, ts15.ScriptTarget.Latest, true);
  const removed = new Set;
  for (const [local, binding] of importLocals(source)) {
    if (references2(original, local) > 0 && references2(source, local) === 0)
      removed.add(binding.node);
  }
  const edits = [];
  for (const statement of source.statements) {
    if (!ts15.isImportDeclaration(statement) || !statement.importClause)
      continue;
    const clause = statement.importClause, bindings = clause.namedBindings;
    const elements = bindings && ts15.isNamedImports(bindings) ? bindings.elements : undefined;
    const keptElements = elements?.filter((element) => !removed.has(element)) ?? [];
    const keepDefault = clause.name && !removed.has(clause.name);
    const keepNamespace = bindings && ts15.isNamespaceImport(bindings) && !removed.has(bindings);
    if (!keepDefault && !keepNamespace && !keptElements.length) {
      if (clause.name || bindings) {
        edits.push(removal(source, statement));
      }
      continue;
    }
    if (elements && keptElements.length !== elements.length) {
      edits.push({ span: { start: bindings.getStart(source), length: bindings.getWidth(source) }, newText: `{ ${keptElements.map((element) => element.getText(source)).join(", ")} }` });
    }
    if (clause.name && !keepDefault)
      fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${path}: cannot remove the unused default import ${clause.name.text} alongside named imports`);
  }
  let text = applyTextChanges(after, edits);
  source = ts15.createSourceFile(path, text, ts15.ScriptTarget.Latest, true);
  const existing = importLocals(source);
  const additions = new ImportSet;
  const printed = ts15.createSourceFile("add.ts", add.print(), ts15.ScriptTarget.Latest, true);
  for (const statement of printed.statements) {
    const module = statement.moduleSpecifier.text;
    const clause = statement.importClause, bindings = clause.namedBindings;
    const wanted = [
      ...clause.name ? [{ local: clause.name.text, add: () => additions.addDefault(module, clause.name.text, clause.isTypeOnly) }] : [],
      ...bindings && ts15.isNamespaceImport(bindings) ? [{ local: bindings.name.text, add: () => additions.addNamespace(module, bindings.name.text) }] : [],
      ...bindings && ts15.isNamedImports(bindings) ? bindings.elements.map((element) => ({
        local: element.name.text,
        add: () => additions.addNamed(module, (element.propertyName ?? element.name).text, element.name.text, clause.isTypeOnly || element.isTypeOnly)
      })) : []
    ];
    for (const binding of wanted) {
      const found = existing.get(binding.local);
      if (found && found.module !== module)
        fail("PORT_ROUTE_IMPORT_CONFLICT", `${path} already binds ${binding.local} from ${found.module}; the data prop type needs it from ${module}`);
      if (!found)
        binding.add();
    }
  }
  const block = additions.print(text.includes("'") && !text.includes('"') ? "'" : '"');
  if (!block)
    return text;
  const imports = source.statements.filter(ts15.isImportDeclaration);
  const anchor = imports.at(-1)?.end ?? (source.statements.find((statement) => !ts15.isExpressionStatement(statement) || !ts15.isStringLiteral(statement.expression))?.getFullStart() ?? 0);
  text = imports.length || anchor ? `${text.slice(0, anchor)}
${block}${text.slice(anchor)}` : `${block}
${text}`;
  return text;
}
function rewriteView(ws, prep, model) {
  const program = ws.program(), checker = program.getTypeChecker();
  const component = model.view.component, viewPath = model.view.path;
  const source = component.getSourceFile();
  const preloaded = model.view.attributes.filter((attribute) => attribute.kind === "preloaded");
  if (!preloaded.length)
    return [];
  const parameter = component.parameters[0];
  if (!parameter)
    fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${model.view.tag} declares no props parameter`);
  const hook = hookSymbol(ws, checker, viewPath, prep.config.data.hook);
  const resolveAlias = (symbol) => symbol && symbol.flags & ts15.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const edits = [];
  const typeImports = new ImportSet;
  const result = [];
  const body = component.body;
  const locals = new Set;
  const collect = (node) => {
    if (ts15.isIdentifier(node))
      locals.add(node.text);
    ts15.forEachChild(node, collect);
  };
  collect(component);
  for (const attribute of preloaded) {
    const base = attribute.name.replace(/^preloaded/i, "") || attribute.name;
    const prop = fill(prep.config.data.prop, { Name: pascal(base) === base ? base : base[0].toUpperCase() + base.slice(1), name: camel(base) }, "data.prop");
    if (model.view.props.some((item) => item.name === prop))
      fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${model.view.tag} already declares ${prop}; choose another data.prop pattern`);
    let reference, dataReference, renamed = false;
    if (ts15.isObjectBindingPattern(parameter.name)) {
      const element = parameter.name.elements.find((item) => (item.propertyName ?? item.name).getText(source) === attribute.name);
      if (!element || !ts15.isIdentifier(element.name) || element.initializer || element.dotDotDotToken)
        fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${model.view.tag} must destructure ${attribute.name} without a default`);
      const symbol = checker.getSymbolAtLocation(element.name);
      const uses = [];
      const visit = (node) => {
        if (ts15.isIdentifier(node) && node !== element.name && checker.getSymbolAtLocation(node) === symbol)
          uses.push(node);
        ts15.forEachChild(node, visit);
      };
      if (body)
        visit(body);
      if (uses.length !== 1)
        fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${attribute.name} must be used exactly once, as the ${prep.config.data.hook.name} argument (found ${uses.length})`);
      reference = uses[0];
      if (element.propertyName) {
        edits.push({ span: { start: element.propertyName.getStart(source), length: element.propertyName.getWidth(source) }, newText: prop });
        dataReference = element.name.text;
      } else {
        renamed = true;
        edits.push({ span: { start: element.name.getStart(source), length: element.name.getWidth(source) }, newText: prop });
        dataReference = prop;
      }
    } else if (ts15.isIdentifier(parameter.name)) {
      const symbol = checker.getSymbolAtLocation(parameter.name);
      const uses = [];
      const visit = (node) => {
        if (ts15.isPropertyAccessExpression(node) && node.name.text === attribute.name && ts15.isIdentifier(node.expression) && checker.getSymbolAtLocation(node.expression) === symbol)
          uses.push(node);
        ts15.forEachChild(node, visit);
      };
      if (body)
        visit(body);
      if (uses.length !== 1)
        fail("PORT_ROUTE_VIEW_UNSUPPORTED", `props.${attribute.name} must be used exactly once, as the ${prep.config.data.hook.name} argument`);
      reference = uses[0];
      dataReference = `${parameter.name.text}.${prop}`;
    } else
      fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${model.view.tag} props must be an identifier or object destructuring`);
    const call = reference.parent;
    if (!ts15.isCallExpression(call) || call.arguments[0] !== reference || resolveAlias(checker.getSymbolAtLocation(call.expression)) !== hook) {
      fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${attribute.name} must be passed directly to ${prep.config.data.hook.name} from ${prep.config.data.hook.module}`);
    }
    const holder = call.parent;
    const declaration = ts15.isVariableDeclaration(holder) ? holder : ts15.isPropertyAccessExpression(holder) && ts15.isVariableDeclaration(holder.parent) && holder.parent.initializer === holder ? holder.parent : undefined;
    const holderLocal = declaration && (ts15.isIdentifier(declaration.name) ? declaration.name.text : ts15.isObjectBindingPattern(declaration.name) && declaration.name.elements.length === 1 && ts15.isIdentifier(declaration.name.elements[0].name) ? declaration.name.elements[0].name.text : undefined);
    if (renamed && locals.has(prop) && holderLocal !== prop)
      fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${prop} already names a binding in ${model.view.tag}`);
    const statement = declaration?.parent.parent;
    const collapse = renamed && holderLocal === prop && statement && ts15.isVariableStatement(statement) && statement.declarationList.declarations.length === 1;
    if (collapse && (ts15.isIdentifier(declaration.name) ? ts15.isPropertyAccessExpression(holder) && holder.name.text === "data" : declaration.name.elements[0].propertyName?.getText(source) === "data")) {
      edits.push(removal(source, statement));
    } else if (ts15.isVariableDeclaration(holder) && holder.initializer === call && ts15.isObjectBindingPattern(holder.name) && holder.name.elements.length === 1 && (holder.name.elements[0].propertyName ?? holder.name.elements[0].name).getText(source) === "data" && ts15.isIdentifier(holder.name.elements[0].name) && !holder.name.elements[0].initializer) {
      const local = holder.name.elements[0].name.text;
      edits.push({ span: { start: holder.getStart(source), length: holder.getWidth(source) }, newText: `${local} = ${dataReference}` });
    } else if (ts15.isPropertyAccessExpression(holder) && holder.expression === call && holder.name.text === "data") {
      edits.push({ span: { start: holder.getStart(source), length: holder.getWidth(source) }, newText: dataReference });
    } else
      fail("PORT_ROUTE_VIEW_UNSUPPORTED", `use \`const { data } = ${prep.config.data.hook.name}(${attribute.name})\` or \`.data\` in ${model.view.tag} before porting`);
    const property = checker.getTypeAtLocation(parameter).getProperty(attribute.name);
    const member = property?.declarations?.[0];
    if (!member || !ts15.isPropertySignature(member) || !member.type || resolve22(member.getSourceFile().fileName) !== resolve22(source.fileName)) {
      fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${attribute.name} must be declared as a property signature in ${source.fileName}`);
    }
    let typeText;
    if (call.typeArguments?.length === 1)
      typeText = fill(prep.config.data.typeArgument, { type: call.typeArguments[0].getText(source) }, "data.typeArgument");
    else {
      typeImports.addText(prep.config.data.type.imports, "data.type.imports");
      for (const item of attribute.preload.query.imports)
        addRef(typeImports, item, () => fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${item.local} is imported from a file; data.type needs package imports`));
      typeText = fill(prep.config.data.type.value, { query: attribute.preload.query.text }, "data.type");
    }
    edits.push({ span: { start: member.name.getStart(source), length: member.name.getWidth(source) }, newText: prop });
    edits.push({ span: { start: member.type.getStart(source), length: member.type.getWidth(source) }, newText: typeText });
    result.push({ attribute: attribute.name, prop, name: camel(base), preload: attribute.preload });
  }
  const before = ws.vfs.readFile(viewPath);
  if (before !== source.text)
    fail("PORT_ROUTE_VIEW_UNSUPPORTED", `${viewPath} changed before the view rewrite`);
  ws.vfs.write(viewPath, updateImports(viewPath, before, applyTextChanges(before, edits), typeImports));
  return result;
}
function hookSymbol(ws, checker, from, hook) {
  const options = ws.ownersOf(from)[0] ? ws.participant(ws.ownersOf(from)[0]).parsed.options : ws.editOptions;
  const resolved = ts15.resolveModuleName(hook.module, from, options, ws.vfs.moduleResolutionHost()).resolvedModule;
  const file = resolved && ws.program().getSourceFile(resolved.resolvedFileName);
  const module = file && checker.getSymbolAtLocation(file);
  const exported = module && checker.getExportsOfModule(module).find((symbol) => symbol.name === hook.name);
  if (!exported)
    fail("PORT_ROUTE_HOOK_NOT_FOUND", `${hook.module} does not export ${hook.name} from ${from}`);
  return exported.flags & ts15.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
}
function addRef(set, item, file) {
  const module = item.target.kind === "package" ? item.target.module : file(item.target.path);
  if (module === undefined)
    return;
  if (item.imported === "default")
    set.addDefault(module, item.local, item.typeOnly);
  else if (item.imported === "*")
    set.addNamespace(module, item.local);
  else
    set.addNamed(module, item.imported, item.local, item.typeOnly);
}

class Builder {
  path;
  imports = new ImportSet;
  setup = [];
  todos = [];
  constructor(path) {
    this.path = path;
  }
  snippet(item, values, origin) {
    this.imports.addText(item.imports?.map((line) => fill(line, values, origin)), origin);
    for (const line of item.setup ?? []) {
      const text = fill(line, values, origin);
      if (!this.setup.includes(text))
        this.setup.push(text);
    }
    return fill(item.value, values, origin);
  }
  todo(config, reason) {
    this.todos.push(reason);
    return fill(config.snippets.todo, { message: JSON.stringify(todoReason(reason)) }, "snippets.todo");
  }
}
function jsx(tag, props) {
  if (!props.length)
    return `<${tag} />`;
  if (props.length === 1)
    return `<${tag} ${props[0][0]}={${props[0][1]}} />`;
  return `<${tag}
${props.map(([name, value]) => `  ${name}={${value}}`).join(`
`)}
/>`;
}
function generatePortRoute(ws, prep, model, dataProps, renames, notes) {
  const moved = new Map(renames.map(([from, to]) => [ws.vfs.key(from), to]));
  const viewTarget = moved.get(ws.vfs.key(model.view.path));
  if (!viewTarget)
    fail("PORT_ROUTE_VIEW_NOT_FOUND", `${model.view.path} is not among the moved files`);
  const config = prep.config;
  const viewModule = basename5(model.view.path, extname4(model.view.path));
  const viewStem = model.view.tag.replace(/(?:View|Client|Content)$/, "").replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z])([A-Z][a-z])/g, "$1-$2").toLowerCase() || viewModule;
  const routeName = prep.segments.at(-1)?.startsWith("$") ? viewStem : prep.segments.at(-1) ?? "index";
  const adapterPath = join2(prep.routeDir, fill(config.next.adapterFile, { view: viewModule, route: routeName }, "next.adapterFile"));
  if (ws.vfs.fileExists(adapterPath))
    fail("TARGET_EXISTS", `${adapterPath}; remove the existing adapter or choose next.adapterFile`);
  if (ws.vfs.fileExists(prep.startFile))
    fail("TARGET_EXISTS", `${prep.startFile} (the route is already ported)`);
  const fileSpecifier = (importer) => (path) => {
    const target = moved.get(ws.vfs.key(path));
    if (!target)
      fail("PORT_ROUTE_UNSUPPORTED_PAGE", `${importer} cannot import ${path}, which stays in Next`);
    return packageSpecifier(ws, importer, target) ?? relativeSpecifier(importer, target);
  };
  const props = model.view.props.map((item) => {
    const data = dataProps.find((entry) => entry.attribute === item.name);
    return data ? { name: data.prop, optional: item.optional } : item;
  });
  const adapter = nextAdapter(ws, prep, model, dataProps, props, adapterPath, viewTarget);
  const start = startRoute(ws, prep, model, dataProps, props, viewTarget, fileSpecifier(prep.startFile));
  for (const file of [adapter, start]) {
    if (config.formatCommand) {
      const [command, ...args] = config.formatCommand.map((argument) => argument.replaceAll("{{file}}", file.path));
      const formatted = spawnSync(command, args, { cwd: ws.root, input: file.text, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
      if (formatted.error || formatted.status !== 0 || !formatted.stdout?.trim())
        fail("PORT_ROUTE_FORMAT_FAILED", `${file.path}: ${formatted.error?.message ?? formatted.stderr?.trim() ?? "formatter returned empty output"}`);
      file.text = formatted.stdout;
    }
    ws.vfs.write(file.path, file.text, false);
    for (const reason of file.todos)
      notes.push(`${todoReason(reason)} (${relative10(ws.root, file.path)})`);
  }
  rewritePage(ws, prep, model, viewTarget, adapterPath);
  ws.reparse();
  for (const [path, config] of [[adapterPath, ws.sourceConfig], [prep.startFile, prep.startConfig]]) {
    const owners = ws.ownersOf(path);
    if (owners.length !== 1 || !ws.vfs.samePath(owners[0], config))
      fail("TARGET_NOT_IN_PROJECT", `${path} must belong to exactly ${config}; owners: ${owners.join(", ") || "none"}`);
  }
  notes.push(`Generated ${relative10(ws.root, adapterPath)} (Next adapter) and ${relative10(ws.root, prep.startFile)} (Start route ${prep.routeId}); ${relative10(ws.root, prep.page)} renders the adapter.`);
  if (prep.kept.length)
    notes.push(`Kept in Next: ${prep.kept.map((path) => relative10(ws.root, path)).join(", ")}.`);
  notes.push("Server-only page logic (authentication, redirects, notFound, metadata) is not translated; confirm the Start layout and loader cover it.");
  if (config.afterApply.length)
    notes.push(`After apply run: ${config.afterApply.join("; ")}.`);
  return [adapter, start];
}
function nextAdapter(ws, prep, model, dataProps, props, path, viewTarget) {
  const config = prep.config, out = new Builder(path);
  out.imports.addText(config.next.imports, "next.imports");
  const local = viewLocal(model.view.tag);
  const viewModule = packageSpecifier(ws, path, viewTarget) ?? relativeSpecifier(path, viewTarget);
  if (model.view.exported === "default")
    out.imports.addDefault(viewModule, local);
  else
    out.imports.addNamed(viewModule, model.view.exported, local);
  const parameters = [], types = [], values = [];
  for (const attribute of model.view.attributes) {
    parameters.push(attribute.name);
    const data = dataProps.find((item) => item.attribute === attribute.name);
    if (data) {
      const preload = data.preload;
      let type;
      if (preload.hook) {
        out.imports.addNamed(relativeSpecifier(path, preload.hook.path), preload.hook.name, preload.hook.name, true);
        type = out.snippet(config.snippets.nextHookType, { hook: preload.hook.name, query: preload.query.text }, "snippets.nextHookType");
      } else {
        for (const item of preload.query.imports)
          addRef(out.imports, { ...item, typeOnly: true }, (file) => relativeSpecifier(path, file));
        type = out.snippet(config.snippets.nextDirectType, { query: preload.query.text }, "snippets.nextDirectType");
      }
      types.push(`${attribute.name}: ${type};`);
      const value = out.snippet(config.snippets.nextData, { name: data.name, prop: attribute.name, query: preload.query.text }, "snippets.nextData");
      values.push([data.prop, value]);
    } else {
      out.imports.addNamed("react", "ComponentProps", "ComponentProps", true);
      const optional = model.view.props.find((item) => item.name === attribute.name)?.optional ? "?" : "";
      types.push(`${attribute.name}${optional}: ComponentProps<typeof ${local}>[${JSON.stringify(attribute.name)}];`);
      values.push([attribute.name, attribute.name]);
    }
  }
  fillPorts(out, prep, props, values, "next");
  const exported = model.view.exported === "default" ? model.view.tag : model.view.exported;
  const text = render(config.nextAdapterTemplate, {
    imports: out.imports.print(),
    name: exported,
    export: model.view.exported === "default" ? "export default function" : "export function",
    params: parameters.length ? `{ ${parameters.join(", ")} }` : "",
    propsType: parameters.length ? `: {
${types.map((line) => `  ${line}`).join(`
`)}
}` : "",
    setup: mergeParamHooks(out.setup).join(`
`),
    todos: out.todos.map((reason) => `// ${todoReason(reason)}`).join(`
`),
    view: jsx(local, values)
  }, config.templates.nextAdapter);
  return { path, text, todos: out.todos };
}
function fillPorts(out, prep, props, values, side) {
  const config = prep.config;
  for (const prop of props) {
    if (values.some(([name]) => name === prop.name))
      continue;
    const port = config.ports[prop.name];
    if (port) {
      values.push([prop.name, out.snippet(port[side], { name: prop.name, path: prep.routePath }, `ports.${prop.name}.${side}`)]);
      continue;
    }
    if (prep.params.includes(prop.name) && config.params) {
      values.push([prop.name, out.snippet(config.params[side], { name: prop.name, path: prep.routePath }, `params.${side}`)]);
      continue;
    }
    if (!prop.optional)
      values.push([prop.name, out.todo(config, `provide required view prop '${prop.name}' (add ports.${prop.name} to port-route.json)`)]);
  }
}
function startRoute(ws, prep, model, dataProps, props, viewTarget, file) {
  const { config, startFile: path } = prep, out = new Builder(path);
  out.imports.addText(config.start.imports, "start.imports");
  const viewModule = packageSpecifier(ws, path, viewTarget) ?? relativeSpecifier(path, viewTarget);
  const local = model.view.exported === "default" ? model.view.tag : model.view.exported;
  if (model.view.exported === "default")
    out.imports.addDefault(viewModule, local);
  else
    out.imports.addNamed(viewModule, model.view.exported, local);
  const add = (translation) => {
    for (const item of translation.imports)
      addRef(out.imports, item, file);
  };
  const queries = [], statements = [], prefetches = [], returns = [];
  const loaderTodos = [];
  for (const statement of model.statements) {
    add(statement);
    statements.push(statement.text);
  }
  const names = new Map;
  const used = new Set;
  for (const preload of model.preloads) {
    const data = dataProps.find((item) => item.preload === preload);
    let name = data?.name ?? camel(preload.variable.replace(/^preloaded/i, "") || preload.query.text.split(".").slice(-2).join(" "));
    while (used.has(name))
      name = `${name}2`;
    used.add(name);
    names.set(preload, name);
    add(preload.query);
    out.imports.addText(config.snippets.startQuery.imports?.map((line) => fill(line, { name, query: preload.query.text }, "snippets.startQuery")), "snippets.startQuery");
    queries.push(fill(config.snippets.startQuery.value, { name, query: preload.query.text }, "snippets.startQuery"));
    let args;
    if ("todo" in preload.args) {
      loaderTodos.push(`translate ${preload.variable} arguments: ${preload.args.todo}`);
      args = fill(config.snippets.todo, { message: JSON.stringify(todoReason(`translate ${preload.variable} arguments`)) }, "snippets.todo");
    } else {
      add(preload.args);
      args = preload.args.text;
    }
    statements.push(`const ${name}Args = ${args};`);
    prefetches.push(fill(config.snippets.startPrefetch, { name, args: `${name}Args`, query: preload.query.text }, "snippets.startPrefetch"));
    returns.push(`${name}Args`);
  }
  const values = [];
  for (const attribute of model.view.attributes) {
    const data = dataProps.find((item) => item.attribute === attribute.name);
    if (data) {
      const name = names.get(data.preload);
      values.push([data.prop, out.snippet(config.snippets.startData, { name, args: `${name}Args`, query: data.preload.query.text }, "snippets.startData")]);
      continue;
    }
    const start = attribute.start;
    const optional = model.view.props.find((item) => item.name === attribute.name)?.optional ?? false;
    if ("todo" in start) {
      if (optional)
        out.todos.push(`translate optional prop '${attribute.name}={${attribute.source}}': ${start.todo}; omitted`);
      else
        values.push([attribute.name, out.todo(config, `translate prop '${attribute.name}={${attribute.source}}': ${start.todo}`)]);
      continue;
    }
    add(start);
    const literal = /^(?:"[^"\n]*"|'[^'\n]*'|-?\d[\d_.]*|true|false|null)$/.test(start.text);
    if (literal)
      values.push([attribute.name, start.text]);
    else {
      let name = start.text;
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
        name = attribute.name;
        const reserved = [...statements, ...out.setup, ...returns, ...out.imports.locals()].join(`
`);
        while (new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`).test(reserved))
          name += "2";
        statements.push(`const ${name} = ${start.text};`);
      }
      if (!returns.includes(name))
        returns.push(name);
      values.push([attribute.name, name]);
    }
  }
  for (const reason of loaderTodos)
    out.todos.push(reason);
  fillPorts(out, prep, props, values, "start");
  const loaderTodo = loaderTodos.map((reason) => `// ${todoReason(reason)}`);
  const body = [...loaderTodo, ...statements].join(`
`);
  const loaderValues = (args) => ({ loaderArgs: args, statements: body, prefetches: prefetches.join(`,
`), returns: returns.join(", "), path: prep.routePath, id: prep.routeId });
  const loaderSnippet = prep.params.length && config.snippets.startRecordLoader ? config.snippets.startRecordLoader : config.snippets.startLoader;
  const needsLoader = !!(statements.length || prefetches.length || returns.length || loaderTodos.length);
  if (needsLoader)
    out.imports.addText(loaderSnippet.imports, "snippets.startLoader");
  const probe = render(loaderSnippet.value, loaderValues(""), "snippets.startLoader");
  const loaderArgs = config.start.loaderArgs.filter((name) => new RegExp(`(?<![\\w$.])${name.replace(/[$]/g, "\\$")}(?![\\w$])`).test(probe));
  const loader = needsLoader ? render(loaderSnippet.value, loaderValues(loaderArgs.length ? `{ ${loaderArgs.join(", ")} }` : ""), "snippets.startLoader").replace(/^[ \t]*await Promise\.all\(\[\s*\]\);?[ \t]*\n/gm, "") : "";
  const component = `${model.view.tag.replace(/(?:View|Client|Content)$/, "")}Page`;
  const localNames = out.imports.locals();
  for (const name of [component, "Route", ...[...names.values()].map((name) => `${name}Query`)]) {
    if (localNames.has(name))
      fail("PORT_ROUTE_NAME_CONFLICT", `${name} is both generated and imported in ${path}`);
  }
  const setup = [...returns.length ? [`const { ${returns.join(", ")} } = Route.useLoaderData();`] : [], ...mergeParamHooks(out.setup)];
  const template = needsLoader ? config.startRouteTemplate : config.startRouteTemplate.replace(/^[ \t]*loader:\s*\{\{loader\}\},?[ \t]*\r?\n/gm, "");
  const text = render(template, {
    imports: out.imports.print(),
    queries: queries.join(`
`),
    id: prep.routeId,
    path: prep.routePath,
    searchDeps: loaderArgs.includes("location") && config.snippets.startSearchDeps ? config.snippets.startSearchDeps : "",
    loader,
    component,
    setup: setup.join(`
`),
    todos: out.todos.filter((reason) => !loaderTodos.includes(reason)).map((reason) => `// ${todoReason(reason)}`).join(`
`),
    view: jsx(local, values)
  }, config.templates.startRoute);
  return { path, text, todos: out.todos };
}
function rewritePage(ws, prep, model, viewTarget, adapterPath) {
  const text = ws.vfs.readFile(prep.page);
  const source = ts15.createSourceFile(prep.page, text, ts15.ScriptTarget.Latest, true);
  const specifier = relativeSpecifier(prep.page, adapterPath);
  const edits = [];
  for (const statement of source.statements) {
    if (!ts15.isImportDeclaration(statement) || !ts15.isStringLiteral(statement.moduleSpecifier) || !statement.importClause)
      continue;
    const resolved = ws.resolveModule(statement.moduleSpecifier, source);
    if (!resolved || !ws.vfs.samePath(resolved.resolvedFileName, viewTarget))
      continue;
    const clause = statement.importClause, bindings = clause.namedBindings;
    const view = model.view.exported === "default" ? clause.name : bindings && ts15.isNamedImports(bindings) ? bindings.elements.find((element) => (element.propertyName ?? element.name).text === model.view.exported) : undefined;
    if (!view)
      continue;
    const quote = text[statement.moduleSpecifier.getStart(source)];
    const others = bindings && ts15.isNamedImports(bindings) ? bindings.elements.filter((element) => element !== view) : [];
    if (!others.length && !(model.view.exported !== "default" && clause.name)) {
      edits.push({ span: { start: statement.moduleSpecifier.getStart(source) + 1, length: statement.moduleSpecifier.getWidth(source) - 2 }, newText: specifier });
    } else {
      const remaining = model.view.exported === "default" ? `{ ${others.map((item) => item.getText(source)).join(", ")} }` : [clause.name?.text, others.length ? `{ ${others.map((item) => item.getText(source)).join(", ")} }` : undefined].filter(Boolean).join(", ");
      edits.push({
        span: { start: statement.getStart(source), length: statement.getWidth(source) },
        newText: `import ${remaining} from ${statement.moduleSpecifier.getText(source)};
import ${model.view.exported === "default" ? view.getText(source) : `{ ${view.getText(source)} }`} from ${quote}${specifier}${quote};`
      });
    }
  }
  if (!edits.length)
    fail("PORT_ROUTE_VIEW_NOT_FOUND", `${prep.page} no longer imports the moved view`);
  ws.vfs.write(prep.page, applyTextChanges(text, edits));
}
async function regenerateRouteTree(ws, prep, generated, notes) {
  const tree = prep.config.start.routeTree;
  if (!tree) {
    notes.push("No start.routeTree configured; the Start route validates against the existing route registration.");
    return;
  }
  const routesRelative = relative10(tree.configDirectory, prep.startRoutes), treeRelative = relative10(tree.configDirectory, tree.file);
  if ([routesRelative, treeRelative].some((path) => path.startsWith("..") || isInside(prep.startRoutes, tree.file)))
    fail("INVALID_PORT_ROUTE_CONFIG", "start.routes and start.routeTree.file must be inside start.routeTree.configDirectory, with the tree outside the routes");
  let entry;
  try {
    entry = createRequire3(join2(tree.configDirectory, "package.json")).resolve(tree.generator);
  } catch {
    fail("PORT_ROUTE_GENERATOR_NOT_FOUND", `${tree.generator} cannot be resolved from ${tree.configDirectory}; install dependencies (bun install)`);
  }
  const generator = await import(pathToFileURL(entry).href);
  const api = generator.Generator ? generator : generator.default;
  if (!api?.Generator || !api.getConfig)
    fail("PORT_ROUTE_GENERATOR_UNSUPPORTED", `${tree.generator} must export Generator and getConfig (TanStack router-generator API)`);
  const scratch = await mkdtemp(join2(tmpdir(), "refactor-ai-route-tree-"));
  try {
    ws.vfs.inputs.sys.readFile(join2(tree.configDirectory, "tsr.config.json"));
    for (const source of ws.vfs.readDirectory(prep.startRoutes, undefined, undefined, ["**/*"])) {
      const target = join2(scratch, routesRelative, relative10(prep.startRoutes, source));
      await mkdir5(dirname15(target), { recursive: true });
      await writeFile4(target, ws.vfs.readFile(source) ?? "");
    }
    const config = api.getConfig({ routesDirectory: join2(scratch, routesRelative), generatedRouteTree: join2(scratch, treeRelative), tmpDir: join2(scratch, ".tmp"), disableLogging: true }, tree.configDirectory);
    await new api.Generator({ config, root: tree.configDirectory }).run();
    const route = await readFile8(join2(scratch, routesRelative, relative10(prep.startRoutes, generated.path)), "utf8");
    if (route !== generated.text)
      fail("PORT_ROUTE_PATH_MISMATCH", `${tree.generator} rewrote ${relative10(ws.root, generated.path)}; its createFileRoute id differs from ${prep.routeId}`);
    const text = readFileSync4(join2(scratch, treeRelative), "utf8");
    ws.vfs.writeEphemeral(tree.file, text);
    ws.reparse();
    notes.push(`Validated with ${relative10(ws.root, tree.file)} regenerated by ${tree.generator}; it is not part of the plan (ignored generator output): regenerate it after apply (dev server or the project's route generation script).`);
  } finally {
    await rm3(scratch, { recursive: true, force: true });
  }
}
var pageNames, todoReason = (text) => `TODO(port-route): ${text}`, viewLocal = (tag) => tag.endsWith("View") ? `${tag}Component` : `${tag}View`, portRouteExtractOptions = (prep, moved, key) => ({
  preloadFunctions: prep.config.next.preloadFunctions,
  translate: prep.config.translate,
  params: prep.params,
  paramsObject: prep.config.start.paramsObject,
  isMoved: (path) => moved.has(key(path))
});
var init_typescript_port_route = __esm(() => {
  init_typescript_port_route_setup();
  init_typescript_port_route_config();
  init_typescript_port_route_extract();
  init_typescript_package_specifiers();
  init_typescript_paths();
  init_typescript_vfs();
  init_typescript_workspace();
  pageNames = ["page.tsx", "page.ts", "page.jsx", "page.js"];
});

// src/backends/typescript-fileops.ts
import ts16 from "typescript";
import { existsSync as existsSync4, lstatSync as lstatSync3, readFileSync as readFileSync5, readdirSync as readdirSync4 } from "node:fs";
import { dirname as dirname16, extname as extname5, isAbsolute as isAbsolute6, relative as relative11, resolve as resolve23, sep as sep8 } from "node:path";
function preferencesFor(ws) {
  let single = 0, double = 0;
  for (const path of userFiles(ws)) {
    const sourceFile = parseFile(ws, path);
    for (const specifier of sourceFile ? moduleSpecifiers(sourceFile) : []) {
      const quote = sourceFile.text[specifier.getStart(sourceFile)];
      if (quote === "'")
        single += 1;
      else if (quote === '"')
        double += 1;
    }
  }
  return { allowTextChangesInNewFiles: true, quotePreference: single > double ? "single" : double > single ? "double" : "auto" };
}
function assertAbsolute(name, value) {
  if (!value || !isAbsolute6(value))
    fail("INVALID_REQUEST", `${name} must be an absolute path`);
  return resolve23(value);
}
function sourceExtension(path) {
  if (/\.d(\.[^./]+)?\.[cm]?ts$/i.test(path))
    fail("UNSUPPORTED_FILE", "declaration files cannot be renamed or moved");
  const extension = extname5(path);
  if (![...tsExtensions, ...jsExtensions].includes(extension))
    fail("UNSUPPORTED_FILE", extension || "file has no extension");
  return extension;
}
function formatFor(text) {
  return { ...baseFormatOptions, newLineCharacter: eolOf(text) };
}
function declaredTypes(sourceFile, isJs) {
  return sourceFile.statements.filter((statement) => {
    if (ts16.isClassDeclaration(statement))
      return statement.name !== undefined;
    return !isJs && (ts16.isInterfaceDeclaration(statement) || ts16.isTypeAliasDeclaration(statement) || ts16.isEnumDeclaration(statement));
  });
}
function namespaceMembers(sourceFile) {
  const names = new Set;
  const visit = (node) => {
    if (ts16.isModuleDeclaration(node)) {
      names.add(node.name.text);
      if (node.body)
        ts16.forEachChild(node.body, visit);
    } else if ((ts16.isClassDeclaration(node) || ts16.isInterfaceDeclaration(node) || ts16.isTypeAliasDeclaration(node) || ts16.isEnumDeclaration(node)) && node.name) {
      names.add(node.name.text);
    } else if (ts16.isModuleBlock(node)) {
      ts16.forEachChild(node, visit);
    }
  };
  for (const statement of sourceFile.statements)
    if (ts16.isModuleDeclaration(statement))
      visit(statement);
  return names;
}
function selectType(context, request) {
  const { sourceFile, isJs } = context;
  const types = declaredTypes(sourceFile, isJs);
  const namespaced = namespaceMembers(sourceFile);
  const named = (name) => types.filter((declaration) => declaration.name?.getText(sourceFile) === name);
  let name = request.typeName;
  if (request.position !== undefined) {
    if (!Number.isInteger(request.position) || request.position < 0 || request.position > sourceFile.text.length) {
      fail("INVALID_RANGE", "position must be a UTF-16 offset within the file");
    }
    const statement = sourceFile.statements.find((item) => item.getStart(sourceFile) <= request.position && request.position <= item.end);
    if (statement && ts16.isModuleDeclaration(statement))
      fail("NAMESPACE_UNSUPPORTED", "types inside TypeScript namespaces are not supported");
    const declaration = types.find((item) => item === statement);
    if (!declaration)
      fail("TYPE_NOT_FOUND", `position does not select a top-level ${isJs ? "class" : "class, interface, type alias or enum"}`);
    const selected = declaration.name.getText(sourceFile);
    if (name !== undefined && name !== selected)
      fail("INVALID_REQUEST", `position selects ${selected} but typeName is ${name}`);
    name = selected;
  }
  if (name === undefined) {
    const names = [...new Set(types.map((declaration) => declaration.name.getText(sourceFile)))];
    if (names.length === 0) {
      if (namespaced.size)
        fail("NAMESPACE_UNSUPPORTED", "the file only declares types inside TypeScript namespaces");
      fail("TYPE_NOT_FOUND", `the file declares no top-level ${isJs ? "named class" : "class, interface, type alias or enum"}`);
    }
    if (names.length > 1)
      fail("AMBIGUOUS_TYPE", `the file declares ${names.join(", ")}; select one with typeName (--type) or position`);
    name = names[0];
  }
  const declarations = named(name);
  if (!declarations.length) {
    if (namespaced.has(name))
      fail("NAMESPACE_UNSUPPORTED", `${name} is declared inside a TypeScript namespace`);
    fail("TYPE_NOT_FOUND", `${name} is not a top-level ${isJs ? "class" : "class, interface, type alias or enum"} in ${context.file}`);
  }
  return { name, declarations };
}
function assertCaseSafe(root, path) {
  let current = root;
  for (const part of relative11(root, path).split(sep8)) {
    let names;
    try {
      names = readdirSync4(current);
    } catch {
      return;
    }
    const next = resolve23(current, part);
    if (!names.includes(part)) {
      if (existsSync4(next)) {
        const actual = names.find((name) => name.toLowerCase() === part.toLowerCase()) ?? "an existing entry";
        fail("CASE_COLLISION", `${next} differs only in case from ${actual}; this volume is case-insensitive and the change could overwrite data`);
      }
      return;
    }
    current = next;
  }
}
function parseFile(ws, path) {
  return ws.syntaxFile(path);
}
function userFiles(ws) {
  return ws.unionFiles().filter((path) => isInside(ws.root, path) && !path.split(sep8).includes("node_modules"));
}
function applyEdits(context, edits, newFile) {
  const { ws } = context;
  for (const edit of [...edits].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    const path = resolve23(edit.fileName);
    if (!isInside(ws.root, path))
      fail("OUTSIDE_ROOT", `TypeScript proposed a change outside ${ws.root}: ${path}`);
    if (path.split(sep8).includes("node_modules") || ws.vfs.isHidden(path))
      fail("OUTSIDE_PROJECT", `TypeScript proposed a change to a dependency or build output: ${path}`);
    const before = ws.vfs.readFile(path);
    if (edit.isNewFile) {
      if (before !== undefined)
        fail("TARGET_EXISTS", path);
      if (!newFile)
        fail("INVALID_EDIT", `unexpected new file ${path}`);
      ws.vfs.write(path, withEol(edit.textChanges.map((change) => change.newText).join(""), newFile.eol), newFile.bom);
      continue;
    }
    if (before === undefined)
      fail("MISSING_FILE", path);
    const eol = eolOf(before);
    ws.vfs.write(path, applyTextChanges(before, edit.textChanges.map((change) => ({ ...change, newText: withEol(change.newText, eol) }))));
  }
}
function membership(ws) {
  return new Map([...ws.participants.values()].map((item) => [item.configPath, ws.fileNames(item.configPath).map((path) => ws.vfs.key(path)).sort()]));
}
function assertMembership(ws, before, renames, deletions, gains) {
  const vfs = ws.vfs;
  const renameMap = new Map(renames.map(([from, to]) => [vfs.key(from), vfs.key(to)]));
  const deleted = new Set(deletions.map((path) => vfs.key(path)));
  for (const [config, files] of before) {
    const expected = files.filter((key) => !deleted.has(key)).map((key) => renameMap.get(key) ?? key);
    const actual = ws.fileNames(config).map((path) => vfs.key(path)).sort();
    for (const gain of gains ? Array.isArray(gains) ? gains : [gains] : []) {
      if (expected.includes(vfs.key(gain.path)))
        continue;
      const must = gain.must.some((item) => vfs.samePath(item, config));
      if (must || gain.may.some((item) => vfs.samePath(item, config)) && actual.includes(vfs.key(gain.path)))
        expected.push(vfs.key(gain.path));
    }
    expected.sort();
    const added = actual.filter((key) => !expected.includes(key));
    const missing = expected.filter((key) => !actual.includes(key));
    if (added.length || missing.length) {
      fail("PROJECT_MEMBERSHIP_CHANGED", `${config} would ${[
        added.length ? `gain ${added.map(describeInputPath).join(", ")}` : "",
        missing.length ? `lose ${missing.map(describeInputPath).join(", ")}` : ""
      ].filter(Boolean).join(" and ")}; adjust include/files patterns or choose another target; if a dev server regenerated these inputs, retry after its generators settle`);
    }
  }
}
function importerMap(ws, paths) {
  const found = new Map(paths.map((path) => [ws.vfs.key(path), []]));
  for (const file of userFiles(ws)) {
    const sourceFile = parseFile(ws, file);
    if (!sourceFile)
      continue;
    for (const specifier of moduleSpecifiers(sourceFile)) {
      const resolved = ws.resolveModule(specifier, sourceFile);
      if (resolved)
        found.get(ws.vfs.key(resolved.resolvedFileName))?.push(ws.vfs.key(file));
    }
    for (const reference of sourceFile.referencedFiles) {
      found.get(ws.vfs.key(resolve23(dirname16(file), reference.fileName)))?.push(ws.vfs.key(file));
    }
  }
  for (const files of found.values())
    files.sort();
  return found;
}
function importers(ws, path) {
  return importerMap(ws, [path]).get(ws.vfs.key(path));
}
function nodeAt(sourceFile, position) {
  let node = sourceFile;
  for (;; ) {
    const child = node.getChildren(sourceFile).find((item) => item.getStart(sourceFile) <= position && position < item.end);
    if (!child)
      return node;
    node = child;
  }
}
function inModuleSyntax(node) {
  for (let current = node;current && !ts16.isSourceFile(current); current = current.parent) {
    if (ts16.isImportSpecifier(current) || ts16.isExportSpecifier(current) || ts16.isImportClause(current) || ts16.isNamespaceImport(current) || ts16.isImportEqualsDeclaration(current))
      return true;
    if (ts16.isStatement(current))
      return false;
  }
  return false;
}
function referenceCounts(ws, file, position, moved) {
  const program = ws.program();
  const counts = new Map;
  for (const symbol of ws.service.findReferences(file, position) ?? []) {
    for (const entry of symbol.references) {
      if (entry.isDefinition)
        continue;
      const sourceFile = program.getSourceFile(entry.fileName);
      if (!sourceFile || inModuleSyntax(nodeAt(sourceFile, entry.textSpan.start)))
        continue;
      const inMoved = moved && ws.vfs.samePath(entry.fileName, file) && entry.textSpan.start >= moved.start && entry.textSpan.start < moved.end;
      const key = ws.vfs.key(inMoved ? moved.to : entry.fileName);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}
function assertSameCounts(before, after, name) {
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changed = keys.filter((key) => (before.get(key) ?? 0) !== (after.get(key) ?? 0));
  if (changed.length) {
    fail("REFERENCES_NOT_PRESERVED", `references to ${name} would no longer bind to it in ${changed.map((key) => `${key} (${before.get(key) ?? 0} -> ${after.get(key) ?? 0})`).join(", ")}`);
  }
}
function usesCommonJs(sourceFile) {
  let found = false;
  const visit = (node) => {
    if (found)
      return;
    if (ts16.isCallExpression(node) && ts16.isIdentifier(node.expression) && node.expression.text === "require")
      found = true;
    else if (ts16.isPropertyAccessExpression(node) && ts16.isIdentifier(node.expression) && (node.expression.text === "module" && node.name.text === "exports" || node.expression.text === "exports"))
      found = true;
    else if (ts16.isExportAssignment(node) && node.isExportEquals)
      found = true;
    else
      ts16.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
function specifierLike(from, to, original, originalTarget) {
  if (!original.startsWith("./") && !original.startsWith("../")) {
    fail("REEXPORT_UNSUPPORTED", `non-relative specifier '${original}' in ${from} cannot be retargeted deterministically`);
  }
  const written = extname5(original);
  const targetExtension = extname5(to);
  if (![...tsExtensions, ...jsExtensions].includes(targetExtension)) {
    const path = portablePath(relative11(dirname16(from), to));
    return path.startsWith(".") ? path : `./${path}`;
  }
  let extension = "";
  if ([...tsExtensions, ...jsExtensions].includes(written)) {
    extension = written === extname5(originalTarget) ? targetExtension : written === ".jsx" && targetExtension === ".tsx" ? ".jsx" : jsEquivalent[targetExtension] ?? targetExtension;
  }
  const path = portablePath(relative11(dirname16(from), to.slice(0, to.length - targetExtension.length))) + extension;
  return path.startsWith(".") ? path : `./${path}`;
}
function updateReexports(context, target, name, exported, sourceDeleted) {
  const { ws, file } = context;
  for (const path of userFiles(ws)) {
    if (ws.vfs.samePath(path, target) || ws.vfs.samePath(path, file))
      continue;
    const sourceFile = parseFile(ws, path);
    if (!sourceFile)
      continue;
    const text = sourceFile.text;
    const eol = eolOf(text);
    const changes = [];
    for (const statement of sourceFile.statements) {
      if (!ts16.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts16.isStringLiteral(statement.moduleSpecifier))
        continue;
      const resolved = ws.resolveModule(statement.moduleSpecifier, sourceFile);
      if (!resolved || !ws.vfs.samePath(resolved.resolvedFileName, file))
        continue;
      const specifierStart = statement.moduleSpecifier.getStart(sourceFile);
      const quote = text[specifierStart];
      const literal = `${quote}${specifierLike(path, target, statement.moduleSpecifier.text, file)}${quote}`;
      const typeOnly = statement.isTypeOnly ? "type " : "";
      if (!statement.exportClause) {
        if (sourceDeleted)
          changes.push({ span: { start: specifierStart, length: statement.moduleSpecifier.end - specifierStart }, newText: literal });
        else if (exported)
          changes.push({ span: { start: statement.end, length: 0 }, newText: `${eol}export ${typeOnly}{ ${name} } from ${literal};` });
      } else if (ts16.isNamespaceExport(statement.exportClause)) {
        if (exported)
          fail("REEXPORT_UNSUPPORTED", `${path} re-exports ${file} as namespace '${statement.exportClause.name.getText(sourceFile)}'; moving ${name} would change that namespace`);
      } else {
        const elements = statement.exportClause.elements;
        const moved = elements.filter((element) => (element.propertyName ?? element.name).text === name);
        if (!moved.length)
          continue;
        const kept = elements.filter((element) => !moved.includes(element));
        const movedDeclaration = `export ${typeOnly}{ ${moved.map((element) => element.getText(sourceFile)).join(", ")} } from ${literal};`;
        if (!kept.length) {
          const start = statement.getStart(sourceFile);
          changes.push({ span: { start, length: statement.end - start }, newText: movedDeclaration });
        } else {
          const start = statement.exportClause.getStart(sourceFile);
          changes.push({ span: { start, length: statement.exportClause.end - start }, newText: `{ ${kept.map((element) => element.getText(sourceFile)).join(", ")} }` });
          changes.push({ span: { start: statement.end, length: 0 }, newText: `${eol}${movedDeclaration}` });
        }
      }
    }
    if (changes.length)
      ws.vfs.write(path, applyTextChanges(text, changes));
  }
}
function moduleEdges(ws, files, owners) {
  const edges = [];
  for (const file of files) {
    const from = owners(file);
    if (!from.length)
      continue;
    const sourceFile = parseFile(ws, file);
    if (!sourceFile)
      continue;
    const options = ws.participant(from[0]).parsed.options;
    for (const specifier of moduleSpecifiers(sourceFile)) {
      const resolved = ws.resolveModule(specifier, sourceFile, options);
      if (!resolved)
        continue;
      const target = resolve23(resolved.resolvedFileName);
      if (!isInside(ws.root, target) || target.split(sep8).includes("node_modules") || ws.vfs.isHidden(target))
        continue;
      edges.push({ file, target, from, to: owners(target) });
    }
  }
  return edges;
}
function accessViolations(ws, files, owners) {
  const violations = new Map;
  const composite = (config) => !!ws.participant(config).parsed.options.composite;
  for (const { file, target, from, to } of moduleEdges(ws, files, owners)) {
    if (to.length === 0) {
      if (/\.d\.[cm]?ts$/.test(target))
        continue;
    } else {
      const reachable = from.some((owner) => to.some((targetOwner) => ws.vfs.samePath(owner, targetOwner) || ws.references(owner).some((reference) => ws.vfs.samePath(reference, targetOwner))));
      if (reachable || ![...from, ...to].some(composite))
        continue;
    }
    const key = `${ws.vfs.key(file)}\x00${ws.vfs.key(target)}`;
    violations.set(key, to.length ? `${file} (${from.join(", ")}) would import ${target} from ${to.join(", ")}, which it does not reference (composite projects require project references)` : `${file} would import ${target}, which belongs to no loaded project`);
  }
  return violations;
}
function projectGraph(ws, files, owners) {
  const graph = new Map;
  const link = (from, to) => {
    if (ws.vfs.samePath(from, to))
      return;
    const targets = graph.get(ws.vfs.key(from)) ?? new Set;
    targets.add(ws.vfs.key(to));
    graph.set(ws.vfs.key(from), targets);
  };
  for (const item of ws.participants.values())
    for (const reference of item.references)
      link(item.configPath, reference);
  for (const edge of moduleEdges(ws, files, owners))
    for (const from of edge.from)
      for (const to of edge.to)
        link(from, to);
  return graph;
}
function introducedCycles(before, after) {
  const reaches = (from, to) => {
    const seen = new Set;
    const pending = [from];
    while (pending.length) {
      const current = pending.pop();
      if (current === to)
        return true;
      if (seen.has(current))
        continue;
      seen.add(current);
      pending.push(...after.get(current) ?? []);
    }
    return false;
  };
  const cycles = [];
  for (const [from, targets] of [...after].sort(([a], [b]) => a.localeCompare(b))) {
    for (const to of [...targets].sort()) {
      if (!before.get(from)?.has(to) && reaches(to, from))
        cycles.push(`${from} -> ${to}`);
    }
  }
  return cycles;
}
function renameFile(context, request) {
  const { ws, file, root } = context;
  if (request.targetProject && !ws.vfs.samePath(configPathFor(assertAbsolute("targetProject", request.targetProject)), ws.sourceConfig)) {
    fail("INVALID_REQUEST", "rename-file keeps the file in its project; targetProject must be omitted");
  }
  const { name } = selectType(context, request);
  const target = resolve23(dirname16(file), `${name}${extname5(file)}`);
  if (request.target !== undefined && assertAbsolute("target", request.target) !== target) {
    fail("INVALID_REQUEST", `rename-file derives its destination from the type name: ${target}`);
  }
  if (target === file) {
    context.notes.push(`${file} already matches ${name}; no changes planned.`);
    return {};
  }
  if (ws.vfs.samePath(target, file)) {
    if (!ws.vfs.caseSensitive) {
      fail("CASE_ONLY_RENAME_UNSUPPORTED", `${file} -> ${target} differs only in case on a case-insensitive volume; rename through an intermediate name`);
    }
  } else {
    if (ws.vfs.fileExists(target) || ws.vfs.directoryExists(target))
      fail("TARGET_EXISTS", target);
    assertCaseSafe(root, target);
  }
  const before = membership(ws);
  const importersBefore = importers(ws, file).map((key) => ws.vfs.samePath(key, file) ? ws.vfs.key(target) : key);
  const text = ws.vfs.readFile(file);
  applyEdits(context, ws.service.getEditsForFileRename(file, target, formatFor(text), preferencesFor(ws)));
  const bom = ws.vfs.hasBom(file);
  const moved = ws.vfs.readFile(file);
  ws.vfs.write(file, null);
  ws.vfs.write(target, moved, bom);
  ws.updateConfigLists([[file, target]], []);
  ws.reparse();
  assertMembership(ws, before, [[file, target]], []);
  const stale = importers(ws, file);
  if (stale.length)
    fail("REFERENCES_NOT_PRESERVED", `imports in ${[...new Set(stale)].join(", ")} still name ${file}`);
  const importersAfter = importers(ws, target);
  if (JSON.stringify(importersAfter) !== JSON.stringify(importersBefore.sort())) {
    fail("REFERENCES_NOT_PRESERVED", `${importersBefore.length} module references resolved to ${file} but ${importersAfter.length} resolve to ${target}`);
  }
  return { renamed: [file, target] };
}
function topLevelNames(sourceFile) {
  const names = new Map;
  for (const statement of sourceFile.statements) {
    if (ts16.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name)
        names.set(clause.name.text, statement);
      if (clause?.namedBindings && ts16.isNamespaceImport(clause.namedBindings))
        names.set(clause.namedBindings.name.text, statement);
      if (clause?.namedBindings && ts16.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements)
          names.set(element.name.text, statement);
      }
    } else if (ts16.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts16.isIdentifier(declaration.name))
          names.set(declaration.name.text, statement);
      }
    } else if ("name" in statement && statement.name && ts16.isIdentifier(statement.name)) {
      names.set(statement.name.text, statement);
    }
  }
  return names;
}
function assertSafeInitialization(declaration) {
  const reject = () => fail("INITIALIZATION_EFFECTS_UNSUPPORTED", "move-type cannot preserve runtime initialization order for this declaration; static effects, computed names, decorators and evaluated base classes are unsupported");
  const constant = (expression) => {
    if (ts16.isParenthesizedExpression(expression) || ts16.isAsExpression(expression) || ts16.isTypeAssertionExpression(expression) || ts16.isSatisfiesExpression(expression))
      return constant(expression.expression);
    if (ts16.isPrefixUnaryExpression(expression))
      return [ts16.SyntaxKind.PlusToken, ts16.SyntaxKind.MinusToken, ts16.SyntaxKind.ExclamationToken, ts16.SyntaxKind.TildeToken].includes(expression.operator) && constant(expression.operand);
    return ts16.isNumericLiteral(expression) || ts16.isStringLiteral(expression) || ts16.isNoSubstitutionTemplateLiteral(expression) || ts16.isBigIntLiteral(expression) || [ts16.SyntaxKind.TrueKeyword, ts16.SyntaxKind.FalseKeyword, ts16.SyntaxKind.NullKeyword].includes(expression.kind);
  };
  if (ts16.isEnumDeclaration(declaration)) {
    if (declaration.members.some((member) => member.initializer && !constant(member.initializer)))
      reject();
  }
  if (!ts16.isClassDeclaration(declaration))
    return;
  if (ts16.getDecorators(declaration)?.length || declaration.heritageClauses?.some((clause) => clause.token === ts16.SyntaxKind.ExtendsKeyword && clause.types.some((type) => !ts16.isIdentifier(type.expression))))
    reject();
  for (const member of declaration.members) {
    if (ts16.canHaveDecorators(member) && ts16.getDecorators(member)?.length || ts16.isClassStaticBlockDeclaration(member) || member.name && ts16.isComputedPropertyName(member.name))
      reject();
    if (ts16.isConstructorDeclaration(member) && member.parameters.some((parameter) => ts16.getDecorators(parameter)?.length))
      reject();
    if (ts16.isPropertyDeclaration(member) && ts16.getModifiers(member)?.some((modifier) => modifier.kind === ts16.SyntaxKind.StaticKeyword) && member.initializer && !constant(member.initializer))
      reject();
  }
}
function importedTarget(ws, binding) {
  const imported = ts16.isImportSpecifier(binding) ? (binding.propertyName ?? binding.name).text : ts16.isImportClause(binding) ? "default" : ts16.isNamespaceImport(binding) ? "*" : undefined;
  if (imported === undefined)
    return;
  let parent = binding;
  while (parent.parent && !ts16.isImportDeclaration(parent))
    parent = parent.parent;
  if (!ts16.isImportDeclaration(parent) || !ts16.isStringLiteralLike(parent.moduleSpecifier))
    return;
  const resolved = ws.resolveModule(parent.moduleSpecifier, parent.getSourceFile());
  return resolved ? `${ws.vfs.key(resolved.resolvedFileName)}\x00${imported}` : undefined;
}
function typeImportTargets(ws, declaration) {
  const checker = ws.program().getTypeChecker();
  const targets = new Set;
  const visit = (node) => {
    if (ts16.isIdentifier(node))
      for (const binding of checker.getSymbolAtLocation(node)?.declarations ?? []) {
        const target = importedTarget(ws, binding);
        if (target)
          targets.add(target);
      }
    if (ts16.isImportTypeNode(node) && ts16.isLiteralTypeNode(node.argument) && ts16.isStringLiteralLike(node.argument.literal)) {
      const resolved = ws.resolveModule(node.argument.literal, node.getSourceFile());
      if (resolved)
        targets.add(`${ws.vfs.key(resolved.resolvedFileName)}\x00import-type:${node.qualifier?.getText() ?? "*"}`);
    }
    ts16.forEachChild(node, visit);
  };
  visit(declaration);
  return targets;
}
function moveType(context, request) {
  const { ws, file, root, sourceFile, isJs } = context;
  const target = assertAbsolute("target", request.target);
  if (!isInside(root, target))
    fail("OUTSIDE_ROOT", `target is outside ${root}`);
  const targetExtension = sourceExtension(target);
  if (!(isJs ? jsExtensions : tsExtensions).includes(targetExtension)) {
    fail("UNSUPPORTED_TARGET", `a ${isJs ? "JavaScript" : "TypeScript"} type must move to a ${isJs ? jsExtensions.join("/") : tsExtensions.join("/")} file`);
  }
  if (ws.vfs.samePath(target, file))
    fail("INVALID_REQUEST", "target must differ from the source file");
  if (!ts16.isExternalModule(sourceFile))
    fail("MODULE_REQUIRED", "move-type requires an ES module source file (with import or export)");
  if (isJs && usesCommonJs(sourceFile))
    fail("COMMONJS_UNSUPPORTED", "CommonJS require/exports are not supported by move-type");
  const { name, declarations } = selectType(context, request);
  if (declarations.length !== 1)
    fail("MERGED_DECLARATION_UNSUPPORTED", `${name} has ${declarations.length} merged declarations`);
  const declaration = declarations[0];
  assertSafeInitialization(declaration);
  const program = ws.program();
  const programSource = program.getSourceFile(file);
  const nameStart = declaration.name.getStart(sourceFile);
  const symbol = program.getTypeChecker().getSymbolAtLocation(nodeAt(programSource, nameStart));
  if (!symbol || (symbol.declarations?.length ?? 0) !== 1) {
    fail("MERGED_DECLARATION_UNSUPPORTED", `${name} merges with other declarations (namespace, interface or global augmentation)`);
  }
  const importedTargets = typeImportTargets(ws, declaration);
  const exported = (ts16.getCombinedModifierFlags(declaration) & ts16.ModifierFlags.Export) !== 0;
  const targetExists = ws.vfs.fileExists(target);
  if (!targetExists && ws.vfs.directoryExists(target))
    fail("TARGET_EXISTS", `${target} is a directory`);
  assertCaseSafe(root, target);
  if (targetExists) {
    const owners = ws.ownersOf(target);
    if (owners.length !== 1 || !ws.vfs.samePath(owners[0], ws.targetConfig)) {
      fail("TARGET_NOT_IN_PROJECT", `${target} must belong to exactly ${ws.targetConfig}; owners: ${owners.join(", ") || "none"}`);
    }
    const targetSource = program.getSourceFile(target);
    if (!ts16.isExternalModule(targetSource))
      fail("MODULE_REQUIRED", `${target} is not an ES module`);
    if (isJs && usesCommonJs(targetSource))
      fail("COMMONJS_UNSUPPORTED", `${target} uses CommonJS`);
    const existing = topLevelNames(targetSource).get(name);
    const importsMoved = existing && ts16.isImportDeclaration(existing) && ts16.isStringLiteral(existing.moduleSpecifier) && ws.vfs.samePath(ws.resolveModule(existing.moduleSpecifier, targetSource)?.resolvedFileName ?? "", file);
    if (existing && !importsMoved)
      fail("TARGET_CONFLICT", `${target} already declares ${name}`);
  }
  const before = membership(ws);
  const beforeOwners = new Map;
  for (const [config, keys] of before) {
    if (ws.isObserver(config))
      continue;
    for (const key of keys)
      beforeOwners.set(key, [...beforeOwners.get(key) ?? [], config]);
  }
  const listedBefore = (config, path) => before.get(config).includes(ws.vfs.key(path));
  const siblings = ws.observers().filter((config) => ws.vfs.samePath(dirname16(config), dirname16(ws.targetConfig)));
  const mirroring = siblings.filter((config) => listedBefore(config, file) && !listedBefore(config, target));
  const statementStart = declaration.getStart(sourceFile);
  const moduleGraph = () => {
    const graph = new Map;
    for (const edge of moduleEdges(ws, userFiles(ws), (path) => ws.ownersOf(path))) {
      const from = ws.vfs.key(edge.file), to = ws.vfs.key(edge.target);
      graph.set(from, new Set([...graph.get(from) ?? [], to]));
    }
    return graph;
  };
  const modulesBefore = ts16.isClassDeclaration(declaration) ? moduleGraph() : undefined;
  const countsBefore = referenceCounts(ws, file, nameStart, { start: declaration.pos, end: declaration.end, to: target });
  const range = { pos: statementStart, end: declaration.end };
  const preferences = preferencesFor(ws);
  const action = ws.service.getApplicableRefactors(file, range, preferences, "invoked", undefined, true).filter((refactor) => refactor.name === "Move to file").flatMap((refactor) => refactor.actions).find((item) => item.name === "Move to file");
  if (!action || action.notApplicableReason)
    fail("REFACTOR_UNAVAILABLE", action?.notApplicableReason ?? `TypeScript cannot move ${name}`);
  const result = ws.service.getEditsForRefactor(file, formatFor(sourceFile.text), range, "Move to file", "Move to file", preferences, { targetFile: target });
  if (!result || result.notApplicableReason || !result.edits.length)
    fail("REFACTOR_UNAVAILABLE", result?.notApplicableReason ?? "TypeScript returned no edits");
  applyEdits(context, result.edits, { eol: eolOf(sourceFile.text), bom: ws.vfs.hasBom(file) });
  if (!ws.vfs.fileExists(target))
    fail("REFACTOR_UNAVAILABLE", "TypeScript did not produce the target file");
  const remaining = parseFile(ws, file);
  const sourceDeleted = remaining.statements.length === 0;
  updateReexports(context, target, name, exported, sourceDeleted);
  if (sourceDeleted) {
    if (remaining.text.trim())
      context.notes.push(`${file} only kept comments after the move and is deleted; its previous content is in the plan.`);
    else
      context.notes.push(`${file} is empty after the move and is deleted.`);
    const stale = importers(ws, file);
    if (stale.length)
      fail("SOURCE_STILL_REFERENCED", `${[...new Set(stale)].join(", ")} still import ${file}, which would be empty after the move`);
    ws.vfs.write(file, null);
  }
  const substitutions = new Map(sourceDeleted ? mirroring.map((config) => [ws.vfs.key(config), [[file, target]]]) : []);
  ws.updateConfigLists([], sourceDeleted ? [file] : [], substitutions);
  ws.reparse();
  const includes = (config) => ws.fileNames(config).some((path) => ws.vfs.samePath(path, target));
  for (const config of [...targetExists ? [] : [ws.targetConfig], ...mirroring]) {
    if (includes(config))
      continue;
    if (!ws.addToFiles(config, target)) {
      fail("TARGET_NOT_IN_PROJECT", `${target} is not matched by the include patterns of ${config}`);
    }
    ws.reparse();
    context.notes.push(`Added ${target} to the files list of ${config}.`);
  }
  assertMembership(ws, before, [], sourceDeleted ? [file] : [], {
    path: target,
    must: [...targetExists ? [] : [ws.targetConfig], ...mirroring],
    may: targetExists ? [] : siblings
  });
  const targetSource = ws.program().getSourceFile(target);
  const movedDeclaration = targetSource && declaredTypes(targetSource, isJs).find((item) => item.name?.getText(targetSource) === name);
  if (!targetSource || !movedDeclaration)
    fail("REFACTOR_UNAVAILABLE", `${name} was not found in ${target} after the move`);
  assertSameCounts(countsBefore, referenceCounts(ws, target, movedDeclaration.name.getStart(targetSource)), name);
  context.verify = () => {
    const actual = typeImportTargets(ws, movedDeclaration);
    for (const dependency of importedTargets) {
      if (!actual.has(dependency))
        fail("REFERENCES_NOT_PRESERVED", `${name} in ${target} no longer imports ${dependency.replace("\x00", " export ")}`);
    }
  };
  const changed = ws.vfs.changes().filter((change) => change.after !== null && !/\.json$/i.test(change.path)).map((change) => change.path);
  const afterViolations = accessViolations(ws, changed, (path) => ws.ownersOf(path));
  const beforeViolations = ws.vfs.original(() => accessViolations(ws, changed.filter((path) => ws.vfs.diskText(path) !== null), (path) => beforeOwners.get(ws.vfs.key(path)) ?? []));
  const introduced = [...afterViolations].filter(([key]) => !beforeViolations.has(key)).map(([, message]) => message);
  if (introduced.length)
    fail("INACCESSIBLE_DEPENDENCY", `${introduced.join("; ")}; add a project reference or move dependencies first`);
  if (ws.vfs.samePath(ws.sourceConfig, ws.targetConfig)) {
    if (modulesBefore && introducedCycles(modulesBefore, moduleGraph()).length) {
      fail("MODULE_DEPENDENCY_CYCLE", "moving this runtime class introduces a module cycle; initialization order cannot be preserved safely");
    }
    return;
  }
  const graphAfter = projectGraph(ws, userFiles(ws), (path) => ws.ownersOf(path));
  const graphBefore = ws.vfs.original(() => projectGraph(ws, userFiles(ws), (path) => beforeOwners.get(ws.vfs.key(path)) ?? []));
  const cycles = introducedCycles(graphBefore, graphAfter);
  if (cycles.length) {
    fail("PROJECT_DEPENDENCY_CYCLE", `the move would make projects depend on each other (${cycles.join("; ")}); move the type's dependencies first or choose another target`);
  }
}
function movePaths(root, file, target, exclude = []) {
  if (!isInside(root, target))
    fail("OUTSIDE_ROOT", `target is outside ${root}`);
  let stat;
  try {
    stat = lstatSync3(file);
  } catch {
    fail("FILE_NOT_FOUND", file);
  }
  if (stat.isSymbolicLink())
    fail("SYMLINK_UNSUPPORTED", file);
  if (stat.isFile()) {
    if (exclude.length)
      fail("INVALID_REQUEST", "--exclude requires directory sources");
    if (extname5(file) !== extname5(target))
      fail("UNSUPPORTED_TARGET", "move-file must retain the file extension");
    return [[file, target]];
  }
  if (!stat.isDirectory())
    fail("UNSUPPORTED_FILE", file);
  if (isInside(file, target) || isInside(target, file))
    fail("INVALID_REQUEST", "source and destination directories must not overlap");
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync4(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve23(directory, entry.name);
      if (excludedByPatterns(path, file, exclude))
        continue;
      if (entry.isSymbolicLink())
        fail("SYMLINK_UNSUPPORTED", path);
      if (entry.isDirectory())
        visit(path);
      else if (entry.isFile())
        paths.push([path, resolve23(target, relative11(file, path))]);
      else
        fail("UNSUPPORTED_FILE", path);
    }
  };
  visit(file);
  if (!paths.length)
    fail("EMPTY_DIRECTORY", `${file} contains no files`);
  return paths;
}
function relocationImports(ws, renames) {
  const moved = new Set(renames.map(([from]) => ws.vfs.key(from)));
  const imports = [];
  for (const file of userFiles(ws)) {
    const source = parseFile(ws, file);
    if (!source)
      continue;
    const owner = ws.ownersOf(file)[0];
    const options = owner ? ws.participant(owner).parsed.options : ws.editOptions;
    moduleSpecifiers(source).forEach((specifier, index) => {
      const resolved = ws.resolveModule(specifier, source, options);
      if (!resolved)
        return;
      const target = resolve23(resolved.resolvedFileName);
      if (!moved.has(ws.vfs.key(file)) && !moved.has(ws.vfs.key(target)))
        return;
      const alias = Object.keys(options.paths ?? {}).some((pattern) => {
        const [prefix, suffix] = pattern.split("*");
        return pattern.includes("*") ? specifier.text.startsWith(prefix) && specifier.text.endsWith(suffix) : pattern === specifier.text;
      });
      imports.push({ file, index, target, original: specifier.text, alias });
    });
  }
  return imports;
}
function reportAssetReferences(ws, renames, notes) {
  const moved = new Map(renames.map(([from, to]) => [ws.vfs.key(from), to]));
  for (const path of userFiles(ws)) {
    if (moved.has(ws.vfs.key(path)))
      continue;
    const source = parseFile(ws, path);
    if (!source)
      continue;
    const visit = (node) => {
      if (ts16.isNewExpression(node) && ts16.isIdentifier(node.expression) && node.expression.text === "URL" && node.arguments?.length === 2 && ts16.isStringLiteralLike(node.arguments[0]) && node.arguments[1].getText(source).replace(/\s/g, "") === "import.meta.url") {
        const target = moved.get(ws.vfs.key(resolve23(dirname16(path), node.arguments[0].text)));
        if (target)
          notes.push(`Review asset URL in ${relative11(ws.root, path)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: new URL(${JSON.stringify(node.arguments[0].text)}, import.meta.url) refers to a moved file; destination ${relative11(ws.root, target)}.`);
      }
      ts16.forEachChild(node, visit);
    };
    visit(source);
  }
}
function moveFile(context, request, renames) {
  const { ws, root, file } = context;
  const target = assertAbsolute("target", request.target);
  const directory = lstatSync3(file).isDirectory();
  if (ws.vfs.samePath(file, target))
    fail("INVALID_REQUEST", "target must differ from the source");
  if (ws.vfs.fileExists(target) || !directory && ws.vfs.directoryExists(target))
    fail("TARGET_EXISTS", target);
  for (const [from, to] of renames) {
    if (ws.vfs.fileExists(to) || ws.vfs.directoryExists(to))
      fail("TARGET_EXISTS", to);
    assertCaseSafe(root, to);
    const bytes = readFileSync5(from);
    if (!Buffer.from(bytes.toString("utf8")).equals(bytes))
      fail("UNSUPPORTED_ENCODING", `${from}: move-file plans require UTF-8 text`);
  }
  reportAssetReferences(ws, renames, context.notes);
  const before = membership(ws);
  const beforeOwners = new Map;
  for (const [config, keys] of before) {
    if (ws.isObserver(config))
      continue;
    for (const key of keys)
      beforeOwners.set(key, [...beforeOwners.get(key) ?? [], config]);
  }
  const graphBefore = projectGraph(ws, userFiles(ws), (path) => ws.ownersOf(path));
  const updateMocks = prepareMoveMocks(ws, renames, request, context.notes);
  for (const [from, to] of renames) {
    const source = parseFile(ws, from);
    if (!source)
      continue;
    const mapped = mapMoveImports(source, moveMappings(root, to, request.map, ws.vfs.inputs.sys));
    if (mapped !== source.text)
      ws.vfs.write(from, mapped);
  }
  const references = userFiles(ws).flatMap((path) => {
    const source = parseFile(ws, path);
    return source?.referencedFiles.map((reference) => ({ file: path, start: reference.pos, length: reference.end - reference.pos, target: resolve23(dirname16(path), reference.fileName) })) ?? [];
  });
  const imports = relocationImports(ws, renames);
  const mapping = new Map(renames.map(([from, to]) => [ws.vfs.key(from), to]));
  const relocated = (path) => mapping.get(ws.vfs.key(path)) ?? path;
  const styleCache = new Map;
  const retargeted = imports.filter((edge) => mapping.has(ws.vfs.key(edge.file)) && edge.original.startsWith(".") || mapping.has(ws.vfs.key(edge.target)) || mapping.has(ws.vfs.key(edge.file)) && packageSelfImport(ws, relocated(edge.file), relocated(edge.target), edge.original));
  const styles = new Map(retargeted.map((edge) => [edge, relativeStyle(ws, relocated(edge.target), edge.original, styleCache)]));
  const pendingImports = userFiles(ws).flatMap((file) => {
    const source = parseFile(ws, file);
    return source ? moduleSpecifiers(source).flatMap((specifier, index) => ws.resolveModule(specifier, source) ? [] : [{ file, index, original: specifier.text }]) : [];
  });
  const beforeImporters = importerMap(ws, renames.flatMap(([from, to]) => [from, to]));
  const expectedImporters = new Map(renames.map(([from, to]) => [
    to,
    [...beforeImporters.get(ws.vfs.key(from)), ...beforeImporters.get(ws.vfs.key(to))].map(relocated).map((path) => ws.vfs.key(path)).sort()
  ]));
  if (!request.moves && !request.exclude?.length)
    applyEdits(context, ws.service.getEditsForFileRename(file, target, formatFor(context.sourceFile.text), preferencesFor(ws)));
  for (const [from, to] of renames) {
    const text = ws.vfs.readFile(from);
    const bom = ws.vfs.hasBom(from);
    ws.vfs.write(from, null);
    ws.vfs.write(to, text, bom);
  }
  const sameProject = ws.vfs.samePath(ws.sourceConfig, ws.targetConfig);
  const directoryRenames = (request.moves ?? [{ file, target }]).filter((move) => !request.exclude?.length && lstatSync3(move.file).isDirectory()).map((move) => [move.file, move.target]);
  const configRenames = [...directoryRenames, ...renames];
  const substitutions = new Map;
  if (!sameProject)
    for (const item of ws.participants.values()) {
      if (ws.vfs.samePath(dirname16(item.configPath), dirname16(ws.targetConfig)))
        substitutions.set(ws.vfs.key(item.configPath), configRenames);
    }
  ws.updateConfigLists(sameProject ? configRenames : [], sameProject ? [] : configRenames.map(([from]) => from), substitutions);
  ws.reparse();
  const sourceRenames = renames.filter(([from]) => [...before.values()].some((files) => files.includes(ws.vfs.key(from))));
  const siblings = ws.observers().filter((config) => ws.vfs.samePath(dirname16(config), dirname16(ws.targetConfig)));
  for (const [, to] of sourceRenames) {
    if (!ws.fileNames(ws.targetConfig).some((path) => ws.vfs.samePath(path, to))) {
      if (!ws.addToFiles(ws.targetConfig, to))
        fail("TARGET_NOT_IN_PROJECT", `${to} is not matched by the include patterns of ${ws.targetConfig}`);
      ws.reparse();
    }
    const owners = ws.ownersOf(to);
    if (owners.length !== 1 || !ws.vfs.samePath(owners[0], ws.targetConfig))
      fail("TARGET_NOT_IN_PROJECT", `${to} must belong to exactly ${ws.targetConfig}; owners: ${owners.join(", ") || "none"}`);
  }
  assertMembership(ws, before, sameProject ? sourceRenames : [], sameProject ? [] : sourceRenames.map(([from]) => from), sameProject ? undefined : sourceRenames.map(([, path]) => ({ path, must: [ws.targetConfig], may: siblings })));
  const changes = new Map;
  for (const edge of retargeted) {
    const from = relocated(edge.file), to = relocated(edge.target);
    const source = parseFile(ws, from);
    const specifier = moduleSpecifiers(source)[edge.index];
    if (!specifier)
      fail("REFERENCES_NOT_PRESERVED", `module specifier disappeared in ${from}`);
    const owner = ws.ownersOf(from)[0];
    const options = owner ? ws.participant(owner).parsed.options : ws.editOptions;
    const bare = mapping.has(ws.vfs.key(edge.target)) || !edge.original.startsWith(".") ? packageSpecifier(ws, from, to, ts16.getModeForUsageLocation(source, specifier, options)) : undefined;
    const style = styles.get(edge);
    const name = bare ?? specifierLike(from, to, style, edge.target);
    const start = specifier.getStart(source) + 1;
    const list = changes.get(from) ?? [];
    list.push({ span: { start, length: specifier.end - start - 1 }, newText: JSON.stringify(name).slice(1, -1) });
    changes.set(from, list);
  }
  if (request.moves || request.exclude?.length)
    for (const reference of references) {
      if (!mapping.has(ws.vfs.key(reference.file)) && !mapping.has(ws.vfs.key(reference.target)))
        continue;
      const from = relocated(reference.file), to = relocated(reference.target);
      const path = portablePath(relative11(dirname16(from), to));
      const edits = changes.get(from) ?? [];
      edits.push({ span: { start: reference.start, length: reference.length }, newText: path.startsWith(".") ? path : `./${path}` });
      changes.set(from, edits);
    }
  for (const [path, edits] of changes)
    ws.vfs.write(path, applyTextChanges(ws.vfs.readFile(path), edits));
  ws.reparse();
  for (const edge of pendingImports) {
    const from = relocated(edge.file), source = parseFile(ws, from);
    const specifier = source && moduleSpecifiers(source)[edge.index];
    if (!source || !specifier || specifier.text !== edge.original)
      continue;
    for (const [, to] of renames)
      if (anticipatePackageExport(ws, to, edge.original)) {
        const owner = ws.ownersOf(from)[0];
        const options = owner ? ws.participant(owner).parsed.options : ws.editOptions;
        packageSpecifier(ws, from, to, ts16.getModeForUsageLocation(source, specifier, options));
        const resolved = ws.resolveModule(specifier, source, options);
        if (!resolved || !ws.vfs.samePath(resolved.resolvedFileName, to))
          fail("REFERENCES_NOT_PRESERVED", `${edge.original} in ${from} must resolve to anticipated destination ${to}`);
      }
  }
  context.aliasHints = imports.filter((edge) => edge.alias && mapping.has(ws.vfs.key(edge.file)) && !mapping.has(ws.vfs.key(edge.target))).filter((edge) => {
    const source = parseFile(ws, relocated(edge.file));
    const specifier = moduleSpecifiers(source)[edge.index];
    return specifier && !ws.resolveModule(specifier, source, ws.participant(ws.targetConfig).parsed.options);
  }).map((edge) => `${edge.original} (${relocated(edge.file)})`);
  const changed = ws.vfs.changes().filter((change) => change.after !== null && /\.[cm]?[jt]sx?$/.test(change.path)).map((change) => change.path);
  const afterViolations = accessViolations(ws, changed, (path) => ws.ownersOf(path));
  const originals = new Map(renames.map(([from, to]) => [ws.vfs.key(to), from]));
  const originalPaths = changed.map((path) => originals.get(ws.vfs.key(path)) ?? path);
  const beforeViolations = ws.vfs.original(() => accessViolations(ws, originalPaths.filter((path) => ws.vfs.diskText(path) !== null), (path) => beforeOwners.get(ws.vfs.key(path)) ?? []));
  const priorKeys = new Set([...beforeViolations.keys()].map((key) => key.split("\x00").map(relocated).map((path) => ws.vfs.key(path)).join("\x00")));
  const introduced = [...afterViolations].filter(([key]) => !priorKeys.has(key)).map(([, message]) => message);
  if (introduced.length)
    fail("INACCESSIBLE_DEPENDENCY", `${introduced.join("; ")}; add a project reference or move dependencies first`);
  const cycles = introducedCycles(graphBefore, projectGraph(ws, userFiles(ws), (path) => ws.ownersOf(path)));
  if (cycles.length)
    fail("PROJECT_DEPENDENCY_CYCLE", `the move introduces project cycles (${cycles.join("; ")}); move dependencies first`);
  context.verify = () => {
    for (const edge of imports) {
      const from = relocated(edge.file), to = relocated(edge.target);
      const source = parseFile(ws, from);
      const specifier = moduleSpecifiers(source)[edge.index];
      const resolved = specifier && ws.resolveModule(specifier, source);
      if (!resolved || !ws.vfs.samePath(resolved.resolvedFileName, to)) {
        fail("REFERENCES_NOT_PRESERVED", `${edge.original} in ${from} must still resolve to ${to}`);
      }
    }
    const additional = new Map(renames.map(([, to]) => [ws.vfs.key(to), []]));
    for (const edge of pendingImports) {
      const from = relocated(edge.file), source = parseFile(ws, from);
      const specifier = source && moduleSpecifiers(source)[edge.index];
      if (!source || !specifier || specifier.text !== edge.original)
        continue;
      const resolved = ws.resolveModule(specifier, source);
      if (resolved)
        additional.get(ws.vfs.key(resolved.resolvedFileName))?.push(ws.vfs.key(from));
    }
    const afterImporters = importerMap(ws, renames.map(([, to]) => to));
    for (const [to, original] of expectedImporters) {
      const expected = [...original, ...additional.get(ws.vfs.key(to))].sort();
      const actual = afterImporters.get(ws.vfs.key(to));
      if (JSON.stringify(expected) !== JSON.stringify(actual))
        fail("REFERENCES_NOT_PRESERVED", `${expected.length} module references expected for ${to}, found ${actual.length}`);
    }
  };
  updateMocks((path, source, edits) => {
    const specifiers = moduleSpecifiers(source);
    const inserted = edits.map((edit) => ({ start: edit.start, count: moduleSpecifiers(ts16.createSourceFile(path, edit.text, ts16.ScriptTarget.Latest, true)).length }));
    for (const edge of [...imports, ...pendingImports]) {
      if (!ws.vfs.samePath(relocated(edge.file), path))
        continue;
      const start = specifiers[edge.index]?.getStart(source);
      if (start !== undefined)
        edge.index += inserted.filter((edit) => edit.start <= start).reduce((sum, edit) => sum + edit.count, 0);
    }
  });
  moveSuppressions(ws, renames, context.notes);
  const summary = request.moves ? ` across ${request.moves.length} pair(s): ${request.moves.map((move) => `${relative11(root, move.file)} -> ${relative11(root, move.target)}`).join(", ")}` : ` from ${relative11(root, file)} to ${relative11(root, target)}`;
  context.notes.push(`Moved ${renames.length} file(s)${summary}; validated source and target project membership.`);
}
function selectedStatement(source, name) {
  const matches = source.statements.filter((statement) => {
    if (!ts16.canHaveModifiers(statement) || ts16.getModifiers(statement)?.some((modifier) => modifier.kind === ts16.SyntaxKind.DefaultKeyword) || !ts16.getModifiers(statement)?.some((modifier) => modifier.kind === ts16.SyntaxKind.ExportKeyword))
      return false;
    if (ts16.isVariableStatement(statement))
      return statement.declarationList.declarations.some((item) => ts16.isIdentifier(item.name) && item.name.text === name);
    return "name" in statement && statement.name && ts16.isIdentifier(statement.name) && statement.name.text === name;
  });
  if (matches.length !== 1)
    fail("UNSUPPORTED_SELECTION", `${source.fileName}: --only requires one exported declaration for '${name}' (merged declarations and re-exports are unsupported)`);
  const statement = matches[0];
  if (ts16.isVariableStatement(statement) && statement.declarationList.declarations.length !== 1)
    fail("UNSUPPORTED_SELECTION", `${name}: split multi-variable declarations before moving`);
  if (ts16.isClassDeclaration(statement) || ts16.isEnumDeclaration(statement))
    assertSafeInitialization(statement);
  if (ts16.isVariableStatement(statement))
    fail("UNSUPPORTED_SELECTION", `${name}: runtime variable initialization requires a whole-file move`);
  return statement;
}
function moveSelected(context, request) {
  const { ws, file, sourceFile, root } = context;
  const target = assertAbsolute("target", request.target);
  if (request.moves || lstatSync3(file).isDirectory())
    fail("UNSUPPORTED_SELECTION", "--only requires one source file; batch whole files separately");
  if (!request.only?.length || new Set(request.only).size !== request.only.length)
    fail("INVALID_REQUEST", "--only requires distinct exported declaration names");
  if (ws.vfs.fileExists(target) || ws.vfs.directoryExists(target))
    fail("TARGET_EXISTS", target);
  assertCaseSafe(root, target);
  const bytes = readFileSync5(file);
  if (!Buffer.from(bytes.toString("utf8")).equals(bytes))
    fail("UNSUPPORTED_ENCODING", `${file}: selected moves require UTF-8 text`);
  const selected = request.only.map((name) => ({ name, statement: selectedStatement(sourceFile, name) })).sort((a, b) => a.statement.pos - b.statement.pos);
  const before = membership(ws);
  const graphBefore = projectGraph(ws, userFiles(ws), (path) => ws.ownersOf(path));
  const mappings = moveMappings(root, target, request.map, ws.vfs.inputs.sys);
  const rules = moveMapEntries(mappings);
  const remapped = sourceFile.statements.filter(ts16.isImportDeclaration).flatMap((statement) => {
    if (!ts16.isStringLiteralLike(statement.moduleSpecifier))
      return [];
    const resolved = ws.resolveModule(statement.moduleSpecifier, sourceFile);
    return resolved ? rules.filter((rule) => rule.from === statement.moduleSpecifier.text).map((rule) => ({ target: ws.vfs.key(resolved.resolvedFileName), imported: rule.imported })) : [];
  });
  const required = selected.map((item) => ({ name: item.name, imports: [...typeImportTargets(ws, item.statement)].filter((dependency) => !remapped.some((rule) => dependency.startsWith(rule.target + "\x00") && (!rule.imported || dependency === rule.target + "\x00" + rule.imported))) }));
  const preferences = preferencesFor(ws);
  const groups = [];
  for (const item of selected) {
    const previous = groups.at(-1)?.at(-1);
    if (previous && sourceFile.statements.indexOf(item.statement) === sourceFile.statements.indexOf(previous.statement) + 1)
      groups.at(-1).push(item);
    else
      groups.push([item]);
  }
  for (const group of groups) {
    const current = ws.program().getSourceFile(file);
    const first = selectedStatement(current, group[0].name), last = selectedStatement(current, group.at(-1).name);
    const range = { pos: first.getStart(current), end: last.end };
    const result = ws.service.getEditsForRefactor(file, formatFor(sourceFile.text), range, "Move to file", "Move to file", preferences, { targetFile: target });
    if (!result || result.notApplicableReason || !result.edits.length)
      fail("REFACTOR_UNAVAILABLE", result?.notApplicableReason ?? `TypeScript cannot move ${group.map((item) => item.name).join(", ")}`);
    applyEdits(context, result.edits, { eol: eolOf(sourceFile.text), bom: ws.vfs.hasBom(file) });
    for (const { name } of group)
      updateReexports(context, target, name, true, false);
  }
  removeSelectedSelfImports(ws, target, new Set(selected.map((item) => item.name)));
  const moved = parseFile(ws, target);
  if (!moved)
    fail("REFACTOR_UNAVAILABLE", "selected declarations did not produce a target file");
  const mapped = mapMoveImports(moved, moveMappings(root, target, request.map, ws.vfs.inputs.sys));
  ws.vfs.write(target, mapped);
  const empty = parseFile(ws, file).statements.length === 0;
  if (empty)
    ws.vfs.write(file, null);
  ws.updateConfigLists([], empty ? [file] : []);
  ws.reparse();
  if (!ws.fileNames(ws.targetConfig).some((path) => ws.vfs.samePath(path, target))) {
    if (!ws.addToFiles(ws.targetConfig, target))
      fail("TARGET_NOT_IN_PROJECT", `${target} is not matched by ${ws.targetConfig}`);
    ws.reparse();
  }
  const siblings = ws.observers().filter((config) => ws.vfs.samePath(dirname16(config), dirname16(ws.targetConfig)));
  assertMembership(ws, before, [], empty ? [file] : [], { path: target, must: [ws.targetConfig], may: siblings });
  normalizeSelectedImports(ws, target);
  ws.reparse();
  const cycles = introducedCycles(graphBefore, projectGraph(ws, userFiles(ws), (path) => ws.ownersOf(path)));
  if (cycles.length)
    fail("PROJECT_DEPENDENCY_CYCLE", `selected declarations still depend on the source project (${cycles.join("; ")}); select their dependencies too or move them first`);
  context.verify = () => {
    for (const { name, imports } of required) {
      const declaration = selectedStatement(ws.program().getSourceFile(target), name);
      const actual = typeImportTargets(ws, declaration);
      for (const dependency of imports)
        if (!actual.has(dependency))
          fail("REFERENCES_NOT_PRESERVED", `${name} no longer imports ${dependency.replace("\x00", " export ")}; map its source alias explicitly or move the dependency too`);
    }
  };
  context.notes.push(`Moved selected declarations ${selected.map((item) => item.name).join(", ")} to ${relative11(root, target)}; unselected declarations stay in ${relative11(root, file)}.`);
}
function removeSelectedSelfImports(ws, target, names) {
  const source = parseFile(ws, target);
  const edits = [];
  for (const statement of source.statements) {
    if (!ts16.isImportDeclaration(statement) || !ts16.isStringLiteralLike(statement.moduleSpecifier))
      continue;
    const resolved = ws.resolveModule(statement.moduleSpecifier, source);
    if (!resolved || !ws.vfs.samePath(resolved.resolvedFileName, target))
      continue;
    const bindings = statement.importClause?.namedBindings;
    if (statement.importClause?.name || !bindings || !ts16.isNamedImports(bindings) || bindings.elements.some((item) => item.propertyName && item.propertyName.text !== item.name.text))
      fail("UNSUPPORTED_SELECTION", "aliased self-import produced by selected move");
    const kept = bindings.elements.filter((item) => !names.has(item.name.text));
    if (!kept.length)
      edits.push({ span: { start: statement.getStart(source), length: statement.getWidth(source) }, newText: "" });
    else
      edits.push({ span: { start: bindings.getStart(source), length: bindings.getWidth(source) }, newText: `{ ${kept.map((item) => item.getText(source)).join(", ")} }` });
  }
  if (edits.length)
    ws.vfs.write(target, applyTextChanges(source.text, edits));
}
function normalizeSelectedImports(ws, target) {
  for (const path of [...new Set([...userFiles(ws), target])]) {
    const source = parseFile(ws, path);
    if (!source)
      continue;
    const edits = [];
    for (const specifier of moduleSpecifiers(source)) {
      const resolved = ws.resolveModule(specifier, source);
      if (!resolved)
        continue;
      const to = resolve23(resolved.resolvedFileName);
      if (!ws.vfs.samePath(to, target) && !(ws.vfs.samePath(path, target) && packageSelfImport(ws, path, to, specifier.text)))
        continue;
      const owner = ws.ownersOf(path)[0];
      const options = owner ? ws.participant(owner).parsed.options : ws.editOptions;
      const bare = packageSpecifier(ws, path, to, ts16.getModeForUsageLocation(source, specifier, options));
      const name = bare ?? specifierLike(path, to, "./module", to);
      edits.push({ span: { start: specifier.getStart(source), length: specifier.getWidth(source) }, newText: JSON.stringify(name) });
    }
    if (edits.length)
      ws.vfs.write(path, applyTextChanges(source.text, edits));
  }
}
function newDiagnostics2(before, after) {
  const key = (item) => `${item.file}\x00${item.code}\x00${item.message}`;
  const counts = new Map;
  for (const item of before)
    counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return after.filter((item) => {
    const count = counts.get(key(item)) ?? 0;
    if (!count)
      return true;
    counts.set(key(item), count - 1);
    return false;
  });
}
function assertLayouts(ws, before, after) {
  for (const [key, layout] of before) {
    const planned = after.get(key);
    if (planned !== undefined && planned !== layout) {
      fail("OUTPUT_LAYOUT_CHANGED", `${ws.participant(key).configPath} has no rootDir and its emitted files would move from mirroring ${layout} to mirroring ${planned}; set rootDir or choose another target`);
    }
  }
}
function prepareBindings(ws) {
  const owners = new Map;
  for (const item of ws.participants.values())
    if (!item.observer) {
      for (const path of item.parsed.fileNames)
        if (!owners.has(ws.vfs.key(path)))
          owners.set(ws.vfs.key(path), item.parsed.options);
    }
  const programFiles = ws.program().getSourceFiles();
  const layouts = ws.outputLayouts();
  const state = (options) => ({
    source: (path) => ws.syntaxFile(path),
    resolve: (specifier, source) => ws.resolveModule(specifier, source, options?.(source.fileName))?.resolvedFileName,
    key: (path) => ws.vfs.key(path)
  });
  return (origins) => {
    const changed = [...ws.vfs.changes().filter((change) => change.after !== null).map((change) => change.path), ...ws.vfs.ephemeralPaths()];
    const ambient = ambientModules([...programFiles, ...changed.map((path) => ws.syntaxFile(path)).filter((source) => !!source)]);
    const original = state((path) => owners.get(ws.vfs.key(path)) ?? ws.editOptions);
    const checked = assertBindings(state(), (run) => ws.vfs.original(() => run(original)), changed, ambient, (path) => origins.get(ws.vfs.key(path)) ?? (ws.vfs.diskText(path) !== null ? path : undefined));
    assertLayouts(ws, layouts, ws.outputLayouts());
    return checked;
  };
}
async function analyzeFileOperation(request) {
  const root = assertAbsolute("root", request.root);
  const file = assertAbsolute("file", request.file);
  if (!isInside(root, file))
    fail("OUTSIDE_ROOT", `file is outside ${root}`);
  const inputs = new CompilerInputs(true);
  const port = request.operation === "port-route" ? preparePortRoute(request, inputs.sys) : undefined;
  const moveRequest = port ? { ...request, operation: "move-file", map: port.map, exclude: undefined, moves: port.moves.map(([from, to]) => ({ file: from, target: to })) } : request;
  const movingFiles = port ? [...port.moves].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) : request.operation === "move-file" ? (request.moves ?? [{ file, target: assertAbsolute("target", request.target) }]).flatMap((move) => movePaths(root, assertAbsolute("file", move.file), assertAbsolute("target", move.target), request.moves && !lstatSync3(move.file).isDirectory() ? [] : request.exclude)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0) : undefined;
  if (movingFiles) {
    const sources = new Set(movingFiles.map(([from]) => from)), targets = new Set(movingFiles.map(([, to]) => to));
    if (sources.size !== movingFiles.length || targets.size !== movingFiles.length || [...targets].some((to) => sources.has(to) || [...targets].some((other) => other !== to && isInside(to, other)))) {
      fail("INVALID_REQUEST", "batch sources/destinations must be unique and must not overlap");
    }
  }
  const extension = movingFiles ? extname5(file) : sourceExtension(file);
  const sourceConfig = configPathFor(assertAbsolute("project", request.project));
  const targetConfig = ["move-type", "move-file", "port-route"].includes(request.operation) && request.targetProject ? configPathFor(assertAbsolute("targetProject", request.targetProject)) : sourceConfig;
  const affected = movingFiles ? movingFiles.map(([from]) => from) : request.files ?? [file];
  if (request.operation === "move-type" && request.target && isAbsolute6(request.target) && existsSync4(request.target))
    affected.push(resolve23(request.target));
  if (!request.only && (movingFiles || sourceConfig !== targetConfig))
    precheckMove(root, sourceConfig, targetConfig, movingFiles ?? [], moveRequest, inputs.sys);
  if (request.verify !== undefined && request.verify !== "bindings")
    fail("INVALID_REQUEST", "verify must be bindings or omitted (full)");
  const bindingsOnly = request.verify === "bindings";
  if (bindingsOnly && request.checker !== undefined)
    fail("INVALID_REQUEST", "checker selects program diagnostics, which verify bindings does not compute");
  const checkerMode = request.checker === "both" ? "both" : "ts7";
  const nativeChecker = request.checker === "ts7" || request.checker === "both" ? await loadTs7Checker(checkerMode) : undefined;
  const ws = timed("workspace.load", () => new Workspace(root, sourceConfig, targetConfig, affected, nativeChecker, checkerMode, inputs, port ? [port.startConfig] : [], bindingsOnly));
  try {
    if (!movingFiles && !ws.vfs.fileExists(file))
      fail("FILE_NOT_FOUND", file);
    const selected = movingFiles ? movingFiles.map(([from]) => from).filter((path) => /\.[cm]?[jt]sx?$/.test(path)) : request.files ?? [file];
    for (const file of selected) {
      const owners = ws.ownersOf(file);
      if (!owners.some((owner) => ws.vfs.samePath(owner, sourceConfig)))
        fail("FILE_NOT_IN_PROJECT", `${file} is not included by ${sourceConfig}`);
      if (owners.length > 1)
        fail("OWNERSHIP_AMBIGUOUS", `${file} is included by several projects: ${owners.join(", ")}`);
    }
    ws.assertNoUnhandledProjects(selected, true, false);
    const sourceFile = timed("workspace.program", () => ws.program().getSourceFile(selected[0] ?? file)) ?? (movingFiles ? ts16.createSourceFile(file, "", ts16.ScriptTarget.Latest) : undefined);
    if (!sourceFile)
      fail("FILE_NOT_IN_PROJECT", file);
    const isJs = jsExtensions.includes(extension);
    const context = { ws, root, file, sourceFile, isJs, notes: [] };
    if (bindingsOnly && [...ws.participants.values()].some((item) => item.references.length)) {
      fail("VERIFY_UNSUPPORTED", "--verify bindings cannot plan across project references: dependents and edits read in-memory declaration builds that require full checking; use --verify full");
    }
    const validate = bindingsOnly ? undefined : timed("workspace.prepare", () => ws.prepareValidation(true));
    const bindings = bindingsOnly ? timed("workspace.bindings-prepare", () => prepareBindings(ws)) : undefined;
    let renamed;
    if (request.operation === "rename-file")
      renamed = renameFile(context, request).renamed;
    else if (request.operation === "move-type")
      moveType(context, request);
    else if (port && movingFiles) {
      const model = timed("port-route.extract", () => new RouteExtractor(ws, portRouteExtractOptions(port, new Set(movingFiles.map(([from]) => ws.vfs.key(from))), (path) => ws.vfs.key(path))).extract(port.page));
      const dataProps = rewriteView(ws, port, model);
      timed("workspace.move", () => moveFile(context, moveRequest, movingFiles));
      context.verify?.();
      context.verify = undefined;
      const [, start] = generatePortRoute(ws, port, model, dataProps, movingFiles, context.notes);
      await regenerateRouteTree(ws, port, start, context.notes);
      context.notes.push(...model.notes);
    } else if (movingFiles && request.only)
      timed("workspace.move", () => moveSelected(context, request));
    else if (movingFiles)
      timed("workspace.move", () => moveFile(context, request, movingFiles));
    else if (request.operation === "inline-reexports") {
      const before = membership(ws);
      const deleted = [];
      for (const path of request.files ?? [file]) {
        const source = ws.program().getSourceFile(path);
        if (!source)
          fail("FILE_NOT_FOUND", path);
        if (timed("workspace.inline", () => inlineReexports(ws, path, source, context.notes, request.keep)))
          deleted.push(path);
      }
      assertMembership(ws, before, [], deleted);
    } else
      fail("UNSUPPORTED_OPERATION", String(request.operation));
    const written = ws.vfs.changes().filter((change) => change.after !== null && !/\.json$/i.test(change.path)).map((change) => change.path);
    if (written.length)
      timed("workspace.external-projects", () => ws.assertNoUnhandledProjects(written, false));
    const renameMap = new Map(((request.only ? [] : movingFiles) ?? (renamed ? [renamed] : [])).map(([from, to]) => [ws.vfs.key(from), to]));
    let diagnosticsBefore = [], diagnosticsAfter = [];
    let validatedFiles, validatedProjects = ws.participants.size;
    if (bindings) {
      context.verify?.();
      context.verify = undefined;
      const origins = new Map([...renameMap].map(([from, to]) => [ws.vfs.key(to), from]));
      if ((request.only || request.operation === "move-type") && request.target && ws.vfs.diskText(request.target) === null)
        origins.set(ws.vfs.key(request.target), file);
      const checked = timed("workspace.bindings", () => {
        try {
          return bindings(origins);
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith("BINDINGS_NOT_PRESERVED"))
            throw error;
          throw new Error(error.message + (context.aliasHints?.length ? `; unresolved source-project alias imports: ${context.aliasHints.join(", ")}; move their dependencies too or replace these aliases` : "") + (port ? `; port-route generated ${relative11(root, port.startFile)} and the Next adapter from ${relative11(root, port.config.path)}: fix its templates, snippets or ports` : ""));
        }
      });
      context.notes.push(`Verified bindings only (--verify bindings): edit prechecks, project membership, reference preservation, syntax and import/export bindings of ${checked} changed file(s); program diagnostics were not computed. Run the project typecheck after apply.`);
    } else {
      if (request.operation !== "move-type" && ![...ws.participants.values()].some((item) => item.references.length)) {
        context.verify?.();
        context.verify = undefined;
        ws.service.cleanupSemanticCache();
      }
      const layoutsBefore = new Map(ws.layouts);
      const validation = timed("workspace.validate", validate);
      ({ after: diagnosticsAfter, affected: validatedFiles, affectedProjects: validatedProjects = ws.participants.size } = validation);
      diagnosticsBefore = movingFiles ? validation.before.map((item) => ({ ...item, file: renameMap.get(ws.vfs.key(item.file)) ?? item.file })) : renamed ? validation.before.map((item) => ws.vfs.samePath(item.file, renamed[0]) ? { ...item, file: renamed[1] } : item) : validation.before;
      if (!diagnosticsAfter.length && ![...ws.participants.values()].some((item) => item.references.length))
        context.notes.push("Skipped baseline diagnostics: the planned affected set has no errors.");
      const introduced = newDiagnostics2(diagnosticsBefore, diagnosticsAfter);
      if (introduced.length)
        fail("NEW_DIAGNOSTICS", introduced.map((item) => `${item.code} ${item.file}: ${item.message}`).join("; ") + (movingFiles ? `; affected consumers: ${[...new Set(introduced.map((item) => relative11(root, item.file)))].join(", ")}; adapt these consumers before moving, or include dependent files in the same --file source=destination batch` : "") + (context.aliasHints?.length ? `; unresolved source-project alias imports: ${context.aliasHints.join(", ")}; move their dependencies too or replace these aliases` : "") + (port ? `; port-route generated ${relative11(root, port.startFile)} and the Next adapter from ${relative11(root, port.config.path)}: fix its templates, snippets or ports for generated-file errors, or prepare the view (props, ports) before porting` : ""));
      context.verify?.();
      assertLayouts(ws, layoutsBefore, ws.layouts);
    }
    for (const config of ws.importingConfigs) {
      context.notes.push(`Included ${relative11(root, config)} because its program imports ${relative11(root, file)} without a project reference.`);
    }
    for (const config of ws.observers()) {
      context.notes.push(`Updated and validated ${relative11(root, config)}, a variant config that also compiles the affected files.`);
    }
    if (bindings) {} else if (request.checker === "ts7")
      context.notes.push(`Validated all user sources across ${ws.participants.size} project(s) with TS7 7.0.2; TS5 graph discovery is not used to restrict native diagnostics.`);
    else if (validatedFiles !== undefined) {
      context.notes.push(`Validated ${validatedFiles} affected file(s) across ${validatedProjects} project(s): the changed files and their transitive importers in the original and planned module graphs.${validatedProjects < ws.participants.size ? ` Fully checked ${ws.participants.size - validatedProjects} other project(s).` : ""}`);
    } else if (ws.participants.size > 1) {
      context.notes.push(`Validated ${ws.participants.size} projects (${[...ws.participants.values()].map((item) => relative11(root, item.configPath)).join(", ")}) with in-memory declaration builds for project references.`);
    }
    if (isJs) {
      context.notes.push("JavaScript analysis is semantic only for references TypeScript can resolve; dynamic imports with computed paths and string-based references are not changed.");
    }
    if (renamed)
      context.notes.push(`Renamed ${relative11(root, renamed[0])} to ${relative11(root, renamed[1])}; the plan deletes the old path and creates the new one.`);
    return {
      readSet: inputs.snapshot(),
      backend: "typescript",
      ...bindings ? {} : { checker: nativeChecker ? checkerMode === "both" ? bothIdentity : ts7Identity : { name: "ts5", version: ts16.version } },
      version: ts16.version,
      changes: ws.vfs.changes(),
      diagnosticsBefore,
      diagnosticsAfter,
      notes: context.notes
    };
  } finally {
    ws.dispose();
  }
}
var fileCapabilities, tsExtensions, jsExtensions, jsEquivalent;
var init_typescript_fileops = __esm(() => {
  init_typescript_move_mocks();
  init_typescript_diagnostics_cache();
  init_typescript_retarget_import();
  init_typescript_timing();
  init_typescript_prechecks();
  init_typescript_inline_reexports();
  init_typescript_ts7();
  init_typescript_vfs();
  init_typescript_workspace();
  init_typescript_package_specifiers();
  init_typescript_suppressions();
  init_typescript_paths();
  init_snapshot();
  init_typescript_bindings();
  init_typescript_port_route();
  fileCapabilities = [
    { operation: "port-route", description: "Port a Next App Router route: move its client view into a feature package and generate the thin Next adapter and TanStack Start route from its preload calls." },
    { operation: "move-file", description: "Move whole TS/JS modules or directories within or between workspace packages, updating imports, exports and project file lists." },
    { operation: "inline-reexports", description: "Inline shim re-exports into workspace callers, deleting unreferenced pure shims unless kept." },
    {
      operation: "rename-file",
      description: "Rename a TS/JS file after its declared type (TS class, interface, type alias or enum; JS class), updating imports in all projects that reference it."
    },
    {
      operation: "move-type",
      description: "Move a top-level TS type or JS class to another file, directory or referenced project, updating imports, re-exports and project file lists."
    }
  ];
  tsExtensions = [".ts", ".tsx", ".mts", ".cts"];
  jsExtensions = [".js", ".jsx", ".mjs", ".cjs"];
  jsEquivalent = { ".ts": ".js", ".tsx": ".js", ".mts": ".mjs", ".cts": ".cjs" };
});

// src/backends/typescript.ts
var exports_typescript = {};
__export(exports_typescript, {
  analyze: () => analyze,
  capabilities: () => capabilities,
  setWarmMode: () => setWarmMode
});
import ts17 from "typescript";
import { statSync as statSync4 } from "node:fs";
import { basename as basename6, dirname as dirname17, extname as extname6, isAbsolute as isAbsolute7, resolve as resolve24 } from "node:path";
function setWarmMode(enabled) {
  warmMode = enabled;
  setWorkspaceWarmMode(enabled);
  if (!enabled) {
    for (const state of warmProjects.values())
      state.service.dispose();
    warmProjects.clear();
  }
}
function fail2(code, reason) {
  throw new Error(`${code}: ${reason}`);
}
function canonical(path) {
  return resolve24(path);
}
function assertAbsolute2(name, value) {
  if (!isAbsolute7(value))
    fail2("INVALID_REQUEST", `${name} must be an absolute path`);
  return canonical(value);
}
function configPathFor2(project) {
  let stat;
  try {
    stat = statSync4(project);
  } catch {
    fail2("PROJECT_NOT_FOUND", project);
  }
  if (stat.isFile()) {
    if (!["tsconfig.json", "jsconfig.json"].includes(basename6(project))) {
      fail2("UNSUPPORTED_PROJECT", "project must name tsconfig.json or jsconfig.json");
    }
    return project;
  }
  if (!stat.isDirectory())
    fail2("UNSUPPORTED_PROJECT", "project must be a config file or directory");
  const candidates = ["tsconfig.json", "jsconfig.json"].map((name) => resolve24(project, name)).filter(ts17.sys.fileExists);
  if (candidates.length === 0)
    fail2("CONFIG_NOT_FOUND", `no tsconfig.json or jsconfig.json in ${project}`);
  if (candidates.length > 1)
    fail2("MULTIPLE_CONFIGS", `both tsconfig.json and jsconfig.json exist in ${project}`);
  return candidates[0];
}
function loadProject(request) {
  const root = assertAbsolute2("root", request.root);
  const project = assertAbsolute2("project", request.project);
  const configPath = configPathFor2(project);
  if (!isInside(root, configPath))
    fail2("OUTSIDE_ROOT", `project config is outside ${root}`);
  const cacheKey = `${root}\x00${configPath}`;
  const warm = warmProjects.get(cacheKey);
  if (warm && warm.inputs.unchanged())
    return warm;
  if (warm) {
    warm.service.dispose();
    warmProjects.delete(cacheKey);
  }
  const inputs = new CompilerInputs(true);
  const parsed = ts17.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...inputs.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      fail2("INVALID_CONFIG", ts17.flattenDiagnosticMessageText(diagnostic.messageText, `
`));
    }
  });
  if (!parsed)
    fail2("INVALID_CONFIG", `could not parse ${configPath}`);
  const configErrors = parsed.errors.filter((diagnostic) => diagnostic.category === ts17.DiagnosticCategory.Error);
  if (configErrors.length)
    fail2("INVALID_CONFIG", ts17.flattenDiagnosticMessageText(configErrors[0].messageText, `
`));
  if (parsed.projectReferences?.length) {
    fail2("PROJECT_REFERENCES_UNSUPPORTED", "project references require more than one configured program");
  }
  const fileNames = parsed.fileNames.map(canonical).sort();
  const overlays = new Map;
  const versions = new Map;
  let projectVersion = 0;
  const host = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => [...new Set([...fileNames, ...overlays.keys()])].sort(),
    getScriptVersion: (fileName) => String(versions.get(canonical(fileName)) ?? 0),
    getScriptSnapshot(fileName) {
      const path = canonical(fileName);
      const text = overlays.get(path) ?? inputs.sys.readFile(path);
      return text === undefined ? undefined : ts17.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => dirname17(configPath),
    getDefaultLibFileName: (options) => ts17.getDefaultLibFilePath(options),
    fileExists: inputs.sys.fileExists,
    readFile: inputs.sys.readFile,
    readDirectory: inputs.sys.readDirectory,
    directoryExists: inputs.sys.directoryExists,
    getDirectories: inputs.sys.getDirectories,
    realpath: inputs.sys.realpath,
    useCaseSensitiveFileNames: () => ts17.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts17.sys.newLine,
    getProjectVersion: () => String(projectVersion)
  };
  const service = ts17.createLanguageService(host, ts17.createDocumentRegistry());
  const state = {
    inputs,
    configPath,
    root,
    fileNames,
    options: parsed.options,
    overlays,
    versions,
    service,
    bumpProjectVersion() {
      projectVersion += 1;
    }
  };
  if (warmMode) {
    if (warmProjects.size >= 4) {
      const [key, oldest] = warmProjects.entries().next().value;
      oldest.service.dispose();
      warmProjects.delete(key);
    }
    warmProjects.set(cacheKey, state);
  }
  return state;
}
function sourceText(state, path) {
  return state.overlays.get(path) ?? state.inputs.sys.readFile(path);
}
function setOverlay(state, path, text) {
  state.overlays.set(path, text);
  state.versions.set(path, (state.versions.get(path) ?? 0) + 1);
  state.bumpProjectVersion();
}
function applyTextChanges2(text, changes) {
  const ordered = changes.map((change, index) => ({ change, index })).sort((a, b) => b.change.span.start - a.change.span.start || b.index - a.index).map(({ change }) => change);
  let boundary = text.length;
  for (const change of ordered) {
    const end = change.span.start + change.span.length;
    if (change.span.start < 0 || end > text.length)
      fail2("INVALID_EDIT", "TypeScript returned an out-of-bounds edit");
    if (end > boundary)
      fail2("OVERLAPPING_EDITS", "TypeScript returned overlapping edits");
    text = text.slice(0, change.span.start) + change.newText + text.slice(end);
    boundary = change.span.start;
  }
  return text;
}
function applyFileEdits(state, edits) {
  for (const edit of [...edits].sort((a, b) => canonical(a.fileName).localeCompare(canonical(b.fileName)))) {
    const path = canonical(edit.fileName);
    if (!isInside(state.root, path))
      fail2("OUTSIDE_ROOT", `TypeScript proposed a change outside ${state.root}: ${path}`);
    const before = sourceText(state, path);
    if (before === undefined && !edit.isNewFile)
      fail2("MISSING_FILE", path);
    setOverlay(state, path, applyTextChanges2(before ?? "", edit.textChanges));
  }
}
function diagnosticRecord(diagnostic, fallback) {
  return {
    file: diagnostic.file ? canonical(diagnostic.file.fileName) : fallback,
    code: `TS${diagnostic.code}`,
    message: ts17.flattenDiagnosticMessageText(diagnostic.messageText, `
`)
  };
}
function diagnostics(state, program, only) {
  const records = [];
  const add = (diagnostic) => {
    if (diagnostic.category !== ts17.DiagnosticCategory.Error)
      return;
    records.push(diagnosticRecord(diagnostic, state.configPath));
  };
  for (const item of program.getOptionsDiagnostics())
    add(item);
  for (const item of program.getGlobalDiagnostics())
    add(item);
  const programFiles = program.getSourceFiles().map((source) => canonical(source.fileName)).filter((path) => isInside(state.root, path) && !path.includes("/node_modules/")) ?? state.fileNames;
  for (const file of [...new Set(programFiles)].filter((path) => !only || only.has(path)).sort()) {
    const source = program.getSourceFile(file);
    for (const item of program.getSyntacticDiagnostics(source))
      add(item);
    for (const item of program.getSemanticDiagnostics(source))
      add(item);
    if (state.options.declaration || state.options.composite)
      for (const item of program.getDeclarationDiagnostics(source))
        add(item);
  }
  return records.sort((a, b) => a.file.localeCompare(b.file) || a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
}
function importersByFile(state, program = state.service.getProgram()) {
  const host = state.inputs.sys;
  const cache = ts17.createModuleResolutionCache(dirname17(state.configPath), (name) => host.useCaseSensitiveFileNames ? name : name.toLowerCase(), state.options);
  const importers = new Map;
  const link = (target, importer) => {
    if (!isInside(state.root, target) || target.includes("/node_modules/"))
      return;
    const set = importers.get(target) ?? new Set;
    set.add(importer);
    importers.set(target, set);
  };
  for (const source of program.getSourceFiles()) {
    const file = canonical(source.fileName);
    if (!isInside(state.root, file) || file.includes("/node_modules/"))
      continue;
    for (const specifier of moduleSpecifiers(source)) {
      const mode = program.getModeForUsageLocation(source, specifier);
      const resolved = ts17.resolveModuleName(specifier.text, file, state.options, host, cache, undefined, mode).resolvedModule;
      if (resolved)
        link(canonical(resolved.resolvedFileName), file);
    }
    for (const reference of source.referencedFiles)
      link(canonical(resolve24(dirname17(file), reference.fileName)), file);
  }
  return importers;
}
function hasGlobalEffect(text, path) {
  const source = ts17.createSourceFile(path, text, ts17.ScriptTarget.Latest, false);
  if (!ts17.isExternalModule(source))
    return true;
  const visit = (node) => ts17.isModuleDeclaration(node) && (ts17.isStringLiteral(node.name) || (node.flags & ts17.NodeFlags.GlobalAugmentation) !== 0) || !!ts17.forEachChild(node, visit);
  return visit(source);
}
function affectedFiles(state, importers, originals) {
  const changed = [...state.overlays.keys()].filter((path) => originals.get(path) !== state.overlays.get(path));
  for (const path of changed) {
    if (!/\.[cm]?[jt]sx?$/i.test(path) || /\.d\.[cm]?ts$/i.test(path))
      return;
    for (const text of [originals.get(path), state.overlays.get(path)])
      if (text !== undefined && hasGlobalEffect(text, path))
        return;
  }
  const affected = new Set;
  const pending = [...changed];
  while (pending.length) {
    const path = pending.pop();
    if (affected.has(path))
      continue;
    affected.add(path);
    pending.push(...importers.get(path) ?? []);
  }
  return affected;
}
function bindingState(state, program) {
  const cache = ts17.createModuleResolutionCache(dirname17(state.configPath), (name) => state.inputs.sys.useCaseSensitiveFileNames ? name : name.toLowerCase(), state.options);
  return {
    source: (path) => program.getSourceFile(path),
    resolve: (specifier, source) => ts17.resolveModuleName(specifier.text, source.fileName, state.options, state.inputs.sys, cache, undefined, program.getModeForUsageLocation(source, specifier)).resolvedModule?.resolvedFileName,
    key: canonical
  };
}
function validatePosition(text, position, label = "position") {
  if (!Number.isInteger(position) || position < 0 || position > text.length) {
    fail2("INVALID_RANGE", `${label} must be a UTF-16 offset within the file`);
  }
  return position;
}
function isValidIdentifier(name, target) {
  const scanner = ts17.createScanner(target, false, ts17.LanguageVariant.Standard, name);
  return scanner.scan() === ts17.SyntaxKind.Identifier && scanner.getTokenText() === name && scanner.scan() === ts17.SyntaxKind.EndOfFileToken;
}
function renameLocationKey(fileName, start, length) {
  return `${canonical(fileName)}\x00${start}\x00${length}`;
}
function mappedRenameLocations(grouped, newName) {
  const mapped = [];
  for (const [fileName, fileLocations] of grouped) {
    let delta = 0;
    const ordered = [...fileLocations].sort((a, b) => a.textSpan.start - b.textSpan.start);
    for (const location of ordered) {
      const prefixLength = location.prefixText?.length ?? 0;
      const replacementLength = prefixLength + newName.length + (location.suffixText?.length ?? 0);
      const item = {
        fileName,
        start: location.textSpan.start + delta + prefixLength,
        length: newName.length
      };
      mapped.push(item);
      delta += replacementLength - location.textSpan.length;
    }
  }
  return mapped;
}
function assertRenameSemantics(state, anchorBefore, grouped, newName, publicName = false) {
  const expected = mappedRenameLocations(grouped, newName);
  let anchor;
  for (const [fileName, fileLocations] of grouped) {
    let delta = 0;
    for (const location of [...fileLocations].sort((a, b) => a.textSpan.start - b.textSpan.start)) {
      const prefixLength = location.prefixText?.length ?? 0;
      if (canonical(anchorBefore.fileName) === fileName && location.textSpan.start === anchorBefore.textSpan.start && location.textSpan.length === anchorBefore.textSpan.length) {
        anchor = { fileName, start: location.textSpan.start + delta + prefixLength, length: newName.length };
      }
      delta += prefixLength + newName.length + (location.suffixText?.length ?? 0) - location.textSpan.length;
    }
  }
  if (!anchor)
    fail2("RENAME_CONFLICT", "could not map the renamed symbol declaration");
  const after = state.service.findRenameLocations(anchor.fileName, anchor.start, false, false, {
    providePrefixAndSuffixTextForRename: !publicName
  });
  const expectedCounts = new Map;
  for (const location of expected) {
    const key = renameLocationKey(location.fileName, location.start, location.length);
    expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
  }
  const actualCounts = new Map;
  for (const location of after ?? []) {
    const key = renameLocationKey(location.fileName, location.textSpan.start, location.textSpan.length);
    actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
  }
  let missing = 0;
  let additional = 0;
  for (const [key, count] of expectedCounts)
    missing += Math.max(0, count - (actualCounts.get(key) ?? 0));
  for (const [key, count] of actualCounts)
    additional += Math.max(0, count - (expectedCounts.get(key) ?? 0));
  if (missing || additional) {
    fail2("RENAME_CONFLICT", `rename changes symbol binding (${missing} missing, ${additional} additional locations)`);
  }
}
function rename2(state, file, request) {
  const text = sourceText(state, file);
  let selectedPosition = request.position;
  if (request.symbol !== undefined) {
    if (request.position !== undefined)
      fail2("INVALID_REQUEST", "symbol and position are mutually exclusive");
    const source = state.service.getProgram().getSourceFile(file);
    const names = [];
    for (const statement of source.statements) {
      if (ts17.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations)
          if (ts17.isIdentifier(declaration.name) && declaration.name.text === request.symbol)
            names.push(declaration.name);
      } else if ((ts17.isFunctionDeclaration(statement) || ts17.isClassDeclaration(statement) || ts17.isInterfaceDeclaration(statement) || ts17.isTypeAliasDeclaration(statement) || ts17.isEnumDeclaration(statement)) && statement.name?.text === request.symbol)
        names.push(statement.name);
    }
    if (names.length !== 1)
      fail2(names.length ? "SYMBOL_AMBIGUOUS" : "SYMBOL_NOT_FOUND", `${request.symbol}: expected one top-level declaration, found ${names.length}`);
    selectedPosition = names[0].getStart(source);
  }
  const position = validatePosition(text, selectedPosition);
  if (!request.newName?.trim())
    fail2("INVALID_REQUEST", "newName is required for rename");
  if (!isValidIdentifier(request.newName, state.options.target ?? ts17.ScriptTarget.Latest)) {
    fail2("INVALID_NAME", `${request.newName} is not a valid identifier`);
  }
  const info = state.service.getRenameInfo(file, position, { providePrefixAndSuffixTextForRename: true });
  if (!info.canRename)
    fail2("RENAME_UNAVAILABLE", info.localizedErrorMessage);
  const locations = state.service.findRenameLocations(file, position, false, false, { providePrefixAndSuffixTextForRename: !request.public });
  if (!locations?.length)
    fail2("RENAME_UNAVAILABLE", "TypeScript found no semantic rename locations");
  const definitions = state.service.getDefinitionAndBoundSpan(file, position)?.definitions ?? [];
  const anchor = definitions.map((definition) => locations.find((location) => canonical(location.fileName) === canonical(definition.fileName) && location.textSpan.start === definition.textSpan.start && location.textSpan.length === definition.textSpan.length)).find((location) => location !== undefined) ?? locations.find((location) => canonical(location.fileName) === file && position >= location.textSpan.start && position <= location.textSpan.start + location.textSpan.length) ?? locations[0];
  const grouped = new Map;
  for (const location of locations) {
    const path = canonical(location.fileName);
    if (!isInside(state.root, path))
      fail2("OUTSIDE_ROOT", `rename location is outside ${state.root}: ${path}`);
    const list = grouped.get(path) ?? [];
    list.push(location);
    grouped.set(path, list);
  }
  applyFileEdits(state, [...grouped].map(([fileName, fileLocations]) => ({
    fileName,
    textChanges: fileLocations.map((location) => ({
      span: location.textSpan,
      newText: `${location.prefixText ?? ""}${request.newName}${location.suffixText ?? ""}`
    }))
  })));
  assertRenameSemantics(state, anchor, grouped, request.newName, request.public);
}
function imports(state, file, request) {
  if (request.mode !== "sort" && request.mode !== "remove-unused") {
    fail2("INVALID_REQUEST", "imports mode must be sort or remove-unused");
  }
  const mode = request.mode === "sort" ? ts17.OrganizeImportsMode.SortAndCombine : ts17.OrganizeImportsMode.RemoveUnused;
  applyFileEdits(state, state.service.organizeImports({ type: "file", fileName: file, mode }, formatOptions, {}));
}
function format(state, file) {
  const text = sourceText(state, file);
  const edits = state.service.getFormattingEditsForDocument(file, formatOptions);
  setOverlay(state, file, applyTextChanges2(text, edits));
}
function extraction(state, file, request) {
  const text = sourceText(state, file);
  const position = validatePosition(text, request.position);
  const end = validatePosition(text, request.end, "end");
  if (end <= position)
    fail2("INVALID_RANGE", "end must be greater than position");
  if (!request.newName?.trim() || !isValidIdentifier(request.newName, state.options.target ?? ts17.ScriptTarget.Latest)) {
    fail2("INVALID_NAME", "newName must be a valid identifier for extraction");
  }
  const range = { pos: position, end };
  const applicable = state.service.getApplicableRefactors(file, range, {}, "invoked", undefined, false);
  const actionName = request.operation === "extract-function" ? "function_scope_0" : "constant_scope_0";
  const selected = applicable.filter((refactor) => refactor.name === "Extract Symbol").flatMap((refactor) => refactor.actions.map((action) => ({ refactor, action }))).find(({ action }) => action.name === actionName && !action.notApplicableReason);
  if (!selected)
    fail2("REFACTOR_UNAVAILABLE", `TypeScript cannot ${request.operation} for the selected range`);
  const result = state.service.getEditsForRefactor(file, formatOptions, range, selected.refactor.name, selected.action.name, {});
  if (!result || result.notApplicableReason)
    fail2("REFACTOR_UNAVAILABLE", result?.notApplicableReason ?? "TypeScript returned no edits");
  applyFileEdits(state, result.edits);
  if (result.renameLocation === undefined)
    fail2("REFACTOR_UNAVAILABLE", "TypeScript did not provide a semantic rename location for the extraction");
  const renameFile = canonical(result.renameFilename ?? file);
  rename2(state, renameFile, { ...request, operation: "rename", file: renameFile, position: result.renameLocation });
}
function changedFiles(state, originals) {
  return [...state.overlays].filter(([path, after]) => originals.get(path) !== after).sort(([a], [b]) => a.localeCompare(b)).map(([path, after]) => ({ path, before: originals.get(path) ?? null, after }));
}
async function analyze(request) {
  if (request.checker !== undefined && !["ts5", "ts7", "both"].includes(request.checker))
    fail2("INVALID_REQUEST", "checker must be ts5, ts7 or both");
  if (request.verify !== undefined && request.verify !== "bindings")
    fail2("INVALID_REQUEST", "verify must be bindings or omitted (full)");
  if (request.verify === "bindings" && request.checker !== undefined)
    fail2("INVALID_REQUEST", "checker selects program diagnostics, which verify bindings does not compute");
  if (request.operation === "rename-file" || request.operation === "move-type" || request.operation === "move-file" || request.operation === "inline-reexports" || request.operation === "port-route")
    return analyzeFileOperation(request);
  if (request.operation === "sync-namespace") {
    fail2("UNSUPPORTED_OPERATION", "sync-namespace is C# only; ES modules have no namespace-to-directory convention");
  }
  const checkerMode = request.checker === "both" ? "both" : "ts7";
  const nativeChecker = request.checker === "ts7" || request.checker === "both" ? await loadTs7Checker(checkerMode) : undefined;
  const state = loadProject(request);
  try {
    const file = assertAbsolute2("file", request.file);
    if (!isInside(state.root, file))
      fail2("OUTSIDE_ROOT", `file is outside ${state.root}`);
    const text = request.operation === "retarget-import" ? "" : sourceText(state, file);
    if (text === undefined)
      fail2("FILE_NOT_FOUND", file);
    const extension = extname6(file).toLowerCase();
    if (request.operation !== "retarget-import" && ![".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(extension)) {
      fail2("UNSUPPORTED_FILE", extension || "file has no extension");
    }
    let program = state.service.getProgram();
    if (!program || request.operation !== "retarget-import" && !program.getSourceFile(file))
      fail2("FILE_NOT_IN_PROJECT", file);
    const outsideUserSources = program.getSourceFiles().filter((source) => !isInside(state.root, canonical(source.fileName)) && !source.isDeclarationFile).map((source) => canonical(source.fileName)).sort();
    if (outsideUserSources.length) {
      fail2("PROJECT_SCOPE_INCOMPLETE", `program contains user source outside ${state.root}: ${outsideUserSources.slice(0, 5).join(", ")}${outsideUserSources.length > 5 ? ` and ${outsideUserSources.length - 5} more` : ""}${workspaceRootHint(state.root, outsideUserSources)}`);
    }
    const bindingsOnly = request.verify === "bindings";
    const importers = bindingsOnly ? new Map : importersByFile(state);
    const originals = new Map;
    for (const path of state.fileNames)
      originals.set(path, sourceText(state, path));
    let operationNotes = [];
    switch (request.operation) {
      case "retarget-import":
        operationNotes = retargetImports({
          sys: state.inputs.sys,
          service: state.service,
          options: state.options,
          root: state.root,
          setText: (path, text) => setOverlay(state, path, text),
          rename: (path, position, newName) => rename2(state, path, { ...request, operation: "rename", file: path, position, newName })
        }, request);
        break;
      case "rename":
        rename2(state, file, request);
        break;
      case "imports":
        imports(state, file, request);
        break;
      case "format":
        format(state, file);
        break;
      case "extract-function":
      case "extract-variable":
        extraction(state, file, request);
        break;
      default:
        fail2("UNSUPPORTED_OPERATION", String(request.operation));
    }
    for (const path of state.overlays.keys())
      if (!originals.has(path))
        originals.set(path, state.inputs.sys.readFile(path));
    let diagnosticsBefore = [], diagnosticsAfter = [];
    let nativeVfs;
    const notes = operationNotes;
    if (bindingsOnly) {
      const planned = state.service.getProgram(), original = program;
      const checked = timed("bindings", () => assertBindings(bindingState(state, planned), (run) => run(bindingState(state, original)), changedFiles(state, originals).map((change) => change.path), ambientModules([...original.getSourceFiles(), ...planned.getSourceFiles()]), (path) => path));
      notes.push(`Verified bindings only (--verify bindings): reference preservation, syntax and import/export bindings of ${checked} changed file(s); program diagnostics were not computed. Run the project typecheck after apply.`);
    } else {
      let afterProgram = state.service.getProgram();
      for (const [target, callers] of importersByFile(state, afterProgram)) {
        importers.set(target, new Set([...importers.get(target) ?? [], ...callers]));
      }
      let affected = affectedFiles(state, importers, originals);
      const beforePaths = new Set(program.getSourceFiles().map((source) => canonical(source.fileName)));
      const afterPaths = new Set(afterProgram.getSourceFiles().map((source) => canonical(source.fileName)));
      for (const source of [...program.getSourceFiles(), ...afterProgram.getSourceFiles()]) {
        const path = canonical(source.fileName);
        if (beforePaths.has(path) !== afterPaths.has(path) && !/\.json$/i.test(path) && hasGlobalEffect(source.text, path))
          affected = undefined;
      }
      diagnosticsAfter = request.checker === "ts7" ? [] : timed("diagnostics.after", () => diagnostics(state, afterProgram, affected));
      nativeVfs = nativeChecker ? new VirtualFs(state.root) : undefined;
      if (nativeChecker && nativeVfs) {
        for (const [path, text] of state.overlays)
          nativeVfs.write(path, text);
        diagnosticsAfter = compareWorkspaceDiagnostics(nativeChecker, nativeVfs, state.configPath, state.options, afterProgram.getSourceFiles().map((source) => canonical(source.fileName)).filter((path) => isInside(state.root, path) && !path.includes("/node_modules/")), diagnosticsAfter, affected);
      }
      if (diagnosticsAfter.length) {
        state.service.cleanupSemanticCache();
        afterProgram = undefined;
      }
      diagnosticsBefore = request.checker !== "ts7" && diagnosticsAfter.length ? timed("diagnostics.before", () => baselineDiagnostics(state.root, state.configPath, program, affected, state.inputs, () => diagnostics(state, program, affected))) : [];
      if (nativeChecker && nativeVfs && diagnosticsAfter.length)
        diagnosticsBefore = nativeVfs.original(() => compareWorkspaceDiagnostics(nativeChecker, nativeVfs, state.configPath, state.options, program.getSourceFiles().map((source) => canonical(source.fileName)).filter((path) => isInside(state.root, path) && !path.includes("/node_modules/")), diagnosticsBefore, affected));
      program = undefined;
      const beforeCounts = new Map;
      for (const item of diagnosticsBefore) {
        const key = `${item.file}\x00${item.code}\x00${item.message}`;
        beforeCounts.set(key, (beforeCounts.get(key) ?? 0) + 1);
      }
      const introduced = diagnosticsAfter.filter((item) => {
        const key = `${item.file}\x00${item.code}\x00${item.message}`;
        const count = beforeCounts.get(key) ?? 0;
        if (count === 0)
          return true;
        beforeCounts.set(key, count - 1);
        return false;
      });
      if (introduced.length)
        fail2("NEW_DIAGNOSTICS", introduced.map((item) => `${item.code} ${item.message}`).join("; "));
      if (!diagnosticsAfter.length)
        notes.push("Skipped baseline diagnostics: the planned affected set has no errors.");
      if (request.checker === "ts7")
        notes.push("Validated all user sources in the configured project with TS7 7.0.2; TS5 graph discovery is not used to restrict native diagnostics.");
      else if (affected)
        notes.push(`Validated ${affected.size} affected file(s): the changed files and their transitive importers.`);
    }
    program = undefined;
    if (request.operation === "imports") {
      notes.push(request.mode === "sort" ? "Sorting imports can reorder module initialization; verify application behavior." : "Removing unused value imports can remove module initialization; bare side-effect imports are retained.");
    }
    if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension) && ["rename", "extract-function", "extract-variable"].includes(request.operation)) {
      notes.push("JavaScript analysis is semantic only for symbols TypeScript can resolve; dynamic properties, reflection, and string-based references are not changed.");
    }
    if (changedFiles(state, originals).length) {
      if (!state.inputs.unchanged())
        fail2("STALE_PROJECT_INPUTS", "a compiler read changed during analysis; retry after writers/generators settle");
      if (nativeVfs)
        timed("inputs.check", () => nativeVfs.assertStableMetadata());
    }
    return {
      readSet: [...state.inputs.snapshot(), ...nativeVfs?.inputs.snapshot() ?? []],
      backend: "typescript",
      ...bindingsOnly ? {} : { checker: nativeChecker ? checkerMode === "both" ? bothIdentity : ts7Identity : { name: "ts5", version: ts17.version } },
      version: ts17.version,
      changes: changedFiles(state, originals),
      diagnosticsBefore,
      diagnosticsAfter,
      notes
    };
  } finally {
    if (warmMode) {
      for (const path of state.overlays.keys())
        state.versions.set(path, (state.versions.get(path) ?? 0) + 1);
      state.overlays.clear();
      state.bumpProjectVersion();
    } else
      state.service.dispose();
  }
}
var capabilities, formatOptions, warmMode = false, warmProjects;
var init_typescript = __esm(() => {
  init_typescript_timing();
  init_typescript_diagnostics_cache();
  init_typescript_fileops();
  init_typescript_workspace();
  init_typescript_retarget_import();
  init_typescript_paths();
  init_typescript_ts7();
  init_typescript_vfs();
  init_typescript_bindings();
  capabilities = [
    { operation: "rename", description: "Rename a TypeScript or JavaScript symbol across its configured project." },
    { operation: "imports", modes: ["sort", "remove-unused"], description: "Sort imports or explicitly remove unused imports." },
    { operation: "format", description: "Format a source file with the TypeScript formatter." },
    { operation: "extract-function", description: "Extract the selected statements or expression to a named function." },
    { operation: "extract-variable", description: "Extract the selected expression to a named variable." },
    { operation: "retarget-import", description: "Retarget imports and re-exports to an API-compatible module, with optional export mapping." },
    ...fileCapabilities
  ];
  formatOptions = {
    indentSize: 2,
    tabSize: 2,
    newLineCharacter: `
`,
    convertTabsToSpaces: true,
    indentStyle: ts17.IndentStyle.Smart,
    insertSpaceAfterCommaDelimiter: true,
    insertSpaceAfterSemicolonInForStatements: true,
    insertSpaceBeforeAndAfterBinaryOperators: true,
    insertSpaceAfterKeywordsInControlFlowStatements: true,
    insertSpaceAfterFunctionKeywordForAnonymousFunctions: false,
    insertSpaceBeforeFunctionParenthesis: false,
    insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
    semicolons: ts17.SemicolonPreference.Insert
  };
  warmProjects = new Map;
});

// src/backends/csharp.ts
import { basename as basename7, dirname as dirname18, isAbsolute as isAbsolute8, join as join3, relative as relative12, resolve as resolve25, sep as sep9 } from "node:path";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
async function analyze2(request, toolkitRoot) {
  validateRequest(request);
  const helper = await findOrBuildHelper(toolkitRoot);
  const { stdout, stderr, exitCode, timedOut } = await runDotnet([helper], JSON.stringify(request));
  if (timedOut) {
    throw new Error("CSHARP_HELPER_TIMEOUT: helper exceeded 120 seconds");
  }
  let response;
  try {
    response = JSON.parse(stdout);
  } catch {
    const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    throw new Error(`CSHARP_HELPER_FAILED: ${detail}`);
  }
  if (response.error) {
    throw new Error(`${response.error.code}: ${response.error.message}`);
  }
  if (exitCode !== 0) {
    const detail = stderr.trim() || `exit code ${exitCode}`;
    throw new Error(`CSHARP_HELPER_FAILED: ${detail}`);
  }
  if (!response.result) {
    const detail = stderr.trim() || `helper exited with code ${exitCode}`;
    throw new Error(`CSHARP_PROTOCOL_ERROR: ${detail}`);
  }
  validateResult(response.result, request.root);
  return response.result;
}
function validateRequest(request) {
  for (const [name, value] of [
    ["project", request.project],
    ["root", request.root],
    ["file", request.file]
  ]) {
    if (!isAbsolute8(value)) {
      throw new Error(`INVALID_REQUEST: ${name} must be an absolute path`);
    }
  }
  ensureWithinRoot(request.root, request.project, "project");
  ensureWithinRoot(request.root, request.file, "file");
  if (request.operation === "rename" && (!Number.isInteger(request.position) || request.position < 0 || !request.newName?.trim())) {
    throw new Error("INVALID_REQUEST: rename requires a non-negative position and newName");
  }
  if (request.operation === "imports" && request.mode !== "remove-unused") {
    throw new Error("UNSUPPORTED_OPERATION: C# supports only imports mode remove-unused");
  }
  if (request.operation === "extract-function" || request.operation === "extract-variable") {
    throw new Error(`UNSUPPORTED_OPERATION: C# operation '${request.operation}' is not supported`);
  }
  if (request.position !== undefined && (!Number.isInteger(request.position) || request.position < 0)) {
    throw new Error("INVALID_REQUEST: position must be a non-negative integer");
  }
  if (request.typeName !== undefined && !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(request.typeName)) {
    throw new Error("INVALID_REQUEST: typeName must be a simple C# identifier");
  }
  if (request.rootNamespace !== undefined && request.rootNamespace !== "" && !/^[\p{L}_][\p{L}\p{N}_]*(\.[\p{L}_][\p{L}\p{N}_]*)*$/u.test(request.rootNamespace)) {
    throw new Error("INVALID_REQUEST: rootNamespace must be a dotted C# namespace");
  }
  if (request.operation === "move-type") {
    if (!request.target || !isAbsolute8(request.target) || !request.target.endsWith(".cs")) {
      throw new Error("INVALID_REQUEST: move-type requires an absolute target .cs file path");
    }
    ensureWithinRoot(request.root, request.target, "target");
    if (request.targetProject !== undefined) {
      if (!isAbsolute8(request.targetProject) || !request.targetProject.toLowerCase().endsWith(".csproj")) {
        throw new Error("INVALID_REQUEST: targetProject must be an absolute .csproj path");
      }
      ensureWithinRoot(request.root, request.targetProject, "targetProject");
    }
  } else if (request.target !== undefined || request.targetProject !== undefined) {
    throw new Error("INVALID_REQUEST: target and targetProject are only valid for move-type");
  }
}
function validateResult(result, root) {
  if (result.backend !== "roslyn" || result.version !== "4.12.0") {
    throw new Error("CSHARP_PROTOCOL_ERROR: unexpected helper identity");
  }
  for (const change of result.changes) {
    if (typeof change.path !== "string" || change.before !== null && typeof change.before !== "string" || change.after !== null && typeof change.after !== "string" || change.before === null && change.after === null) {
      throw new Error("CSHARP_PROTOCOL_ERROR: helper returned a malformed change");
    }
    if (!isAbsolute8(change.path)) {
      throw new Error("CSHARP_PROTOCOL_ERROR: helper returned a relative change path");
    }
    ensureWithinRoot(root, change.path, "changed file");
  }
}
function ensureWithinRoot(root, path, label) {
  const difference = relative12(resolve25(root), resolve25(path));
  if (difference === ".." || difference.startsWith(`..${sep9}`) || isAbsolute8(difference)) {
    throw new Error(`OUTSIDE_ROOT: ${label} is outside root: ${path}`);
  }
}
async function findOrBuildHelper(toolkitRoot) {
  const configured = toolkitRoot ?? process.env.REFACTOR_AI_HOME;
  const directory = dirname18(fileURLToPath(import.meta.url));
  const sourceRoot = configured ? resolve25(configured) : resolve25(directory, basename7(directory) === "backends" && basename7(dirname18(directory)) === "src" ? "../.." : "..");
  const dll = helperDll(sourceRoot);
  if (await exists(dll))
    return dll;
  const project = join3(sourceRoot, "dotnet", "RefactorHelper", "RefactorHelper.csproj");
  if (!await exists(project))
    throw new Error("CSHARP_HELPER_NOT_FOUND: the selected toolkit root has no helper; set REFACTOR_AI_HOME to the package root");
  const { stdout, stderr, exitCode, timedOut } = await runDotnet([
    "build",
    project,
    "-c",
    "Release",
    "--nologo",
    "-p:RestoreLockedMode=true"
  ]);
  if (timedOut)
    throw new Error("CSHARP_HELPER_BUILD_TIMEOUT: build exceeded 120 seconds");
  if (exitCode !== 0) {
    throw new Error(`CSHARP_HELPER_BUILD_FAILED: ${(stderr || stdout).trim()}`);
  }
  return helperDll(sourceRoot);
}
function helperDll(root) {
  return join3(root, "dotnet", "RefactorHelper", "bin", "Release", "net8.0", "RefactorHelper.dll");
}
function processEnv() {
  return { ...process.env, DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1" };
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT")
      return false;
    throw error;
  }
}
function runDotnet(args, input) {
  return new Promise((resolveResult, reject) => {
    const child = spawn("dotnet", args, { stdio: ["pipe", "pipe", "pipe"], env: processEnv() });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 120000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`CSHARP_HELPER_FAILED: ${error.message}`));
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") {
        clearTimeout(timeout);
        child.kill("SIGKILL");
        reject(error);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolveResult({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });
    child.stdin.end(input);
  });
}
var capabilities2;
var init_csharp = __esm(() => {
  capabilities2 = [
    {
      operation: "rename",
      description: "Solution-wide semantic symbol rename using Roslyn."
    },
    {
      operation: "format",
      description: "Document formatting using the public Roslyn Formatter API."
    },
    {
      operation: "imports",
      modes: ["remove-unused"],
      description: "Remove unused imports identified by Roslyn's built-in compiler diagnostics."
    },
    {
      operation: "rename-file",
      description: "Rename a file to match its selected top-level type, updating explicit Compile items."
    },
    {
      operation: "sync-namespace",
      description: "Set a file's namespace from RootNamespace and folders, updating references with Roslyn binding checks."
    },
    {
      operation: "move-type",
      description: "Move a top-level type to a new file in the same or another project, updating namespaces, references and project references."
    }
  ];
});

// src/serve.ts
import { realpathSync as realpathSync2 } from "node:fs";
import { resolve as resolve26 } from "node:path";
import { createInterface } from "node:readline";
async function serve(args, context) {
  if (args.length !== 2 || args[0] !== "--root")
    throw new Error('INVALID_ARGUMENT: serve --root <repo>; send NDJSON {id,args:["plan",...]}');
  const root = realpathSync2(resolve26(args[1]));
  process.chdir(root);
  setWarmMode(true);
  try {
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      let id = null;
      try {
        const request = JSON.parse(line);
        id = request.id ?? null;
        if (!Array.isArray(request.args) || !request.args.every((arg) => typeof arg === "string") || request.args[0] !== "plan") {
          throw new Error("INVALID_REQUEST: serve accepts plan argument arrays only");
        }
        const arguments_ = [...request.args];
        const rootIndex = arguments_.indexOf("--root");
        if (rootIndex >= 0 && realpathSync2(resolve26(arguments_[rootIndex + 1])) !== root)
          throw new Error("OUTSIDE_ROOT: request root differs from server root");
        if (rootIndex < 0)
          arguments_.push("--root", root);
        let output = "", exitCode = 0;
        await runCli(arguments_, { ...context, write: (text) => {
          output += text;
        }, setExitCode: (code) => {
          exitCode = code;
        } });
        process.stdout.write(JSON.stringify({ id, status: exitCode === 0 ? "ok" : "failed", output: JSON.parse(output) }) + `
`);
      } catch (error) {
        process.stdout.write(JSON.stringify({ id, status: "failed", error: error instanceof Error ? error.message : String(error) }) + `
`);
      }
    }
  } finally {
    setWarmMode(false);
  }
}
var init_serve = __esm(() => {
  init_cli_core();
  init_typescript();
});

// src/cli.ts
init_run_log();
init_cli_core();
import { realpathSync as realpathSync3 } from "node:fs";
import { pathToFileURL as pathToFileURL2 } from "node:url";

// src/backends/load.ts
init_languages();
var loadBackend = async (project, toolkitRoot) => {
  if (languageForProject(project) !== "csharp")
    return Promise.resolve().then(() => (init_typescript(), exports_typescript));
  const backend = await Promise.resolve().then(() => (init_csharp(), {}));
  return { capabilities: capabilities2, analyze: (request) => analyze2(request, toolkitRoot) };
};

// src/cli.ts
init_cli_core();
async function main(args, context = {}) {
  if (args[0] === "serve" && !args.includes("--help")) {
    await Promise.resolve().then(() => init_serve());
    const run = () => serve(args.slice(1), { ...context, runLog: undefined, loadBackend });
    return context.runLog === false ? run() : logRun(args, run);
  }
  return runCli(args, { ...context, loadBackend });
}
if (process.argv[1] && import.meta.url === pathToFileURL2(realpathSync3(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(JSON.stringify({ status: "failed", error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}
export {
  main,
  offset
};
