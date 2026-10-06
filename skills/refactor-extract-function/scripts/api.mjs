// scripts/skill-api.ts
import { dirname as dirname5, join as join3, resolve as resolve6 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// src/api.ts
import { readFile as readFile4, realpath as realpath3 } from "node:fs/promises";
import { dirname as dirname3, resolve as resolve4 } from "node:path";

// src/core/apply.ts
import { lstat as lstat3, mkdir, open, readFile as readFile3, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname as dirname2, resolve as resolve3 } from "node:path";
import { randomUUID } from "node:crypto";

// src/core/plan.ts
import { lstat as lstat2, readFile as readFile2, realpath as realpath2 } from "node:fs/promises";
import { relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";
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
class LineDiff extends Diff {
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
}
var lineDiff = new LineDiff;
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
// src/core/snapshot.ts
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
var excluded = new Set([".git", "node_modules", "bin", "obj", "dist", ".refactor-ai"]);
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
async function assertRegularPath(root, file, allowMissing = false) {
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
    if (i === parts.length - 1 && !stat.isFile())
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
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (excluded.has(entry.name))
        continue;
      const file = resolve(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`SYMLINK_UNSUPPORTED: ${file}`);
      if (entry.isDirectory())
        await walk(file);
      else if (entry.isFile())
        files[relative(root, file)] = sha256(await readFile(file));
    }
  }
  await walk(root);
  return { files, hash: sha256(JSON.stringify(files)) };
}

// src/core/plan.ts
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
        return resolve2(root, file);
    }
  }
  return;
}
function assertPlanShape(plan) {
  if (plan?.schemaVersion !== 1 && plan?.schemaVersion !== 2 || !plan.request || typeof plan.request.root !== "string" || !Array.isArray(plan.changes) || !plan.snapshot || !plan.validation || !Array.isArray(plan.diagnosticsBefore) || !Array.isArray(plan.diagnosticsAfter)) {
    throw new Error("INVALID_PLAN: unsupported or malformed plan");
  }
  if (plan.id !== planId(plan))
    throw new Error("INVALID_PLAN: plan integrity check failed");
  if (plan.snapshot.hash !== sha256(JSON.stringify(plan.snapshot.files)))
    throw new Error("INVALID_PLAN: invalid snapshot");
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
  const root = await realpath2(request.root);
  const result = { ...request, root, project: await realpath2(request.project), file: await realpath2(request.file) };
  await assertRegularPath(root, result.project);
  await assertRegularPath(root, result.file);
  if (request.targetProject !== undefined) {
    result.targetProject = await realpath2(request.targetProject);
    await assertRegularPath(root, result.targetProject);
  }
  if (request.target !== undefined) {
    result.target = inside(root, await canonicalMissing(request.target));
    await assertRegularPath(root, result.target, true);
  }
  return result;
}
var fileId = (stat) => `${stat.dev}:${stat.ino}`;
async function createPlan(request, analyze) {
  request = await canonicalRequest(request);
  const root = request.root;
  const before = await snapshot(root);
  const result = await analyze(request);
  if ((await snapshot(root)).hash !== before.hash)
    throw new Error("STALE_SNAPSHOT: project changed during analysis");
  const seen = new Set;
  const changes = [];
  for (const change of result.changes) {
    const kind = changeKind(change);
    const path = inside(root, kind === "create" ? await canonicalMissing(change.path) : await realpath2(change.path));
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
      deleted.add(fileId(await lstat2(change.path)));
  for (const change of changes) {
    if (change.before !== null)
      continue;
    await assertRegularPath(root, change.path, true);
    const existing = await lstat2(change.path).catch((error) => {
      if (error.code === "ENOENT")
        return null;
      throw error;
    });
    if (existing && !deleted.has(fileId(existing)))
      throw new Error(`TARGET_EXISTS: ${change.path}`);
  }
  changes.sort(byPath);
  const fileModes = {};
  const createdMode = ["move-type", "rename-file"].includes(request.operation) ? (await lstat2(request.file)).mode & 511 : 384;
  for (const change of changes) {
    const beforeMode = change.before === null ? null : (await lstat2(change.path)).mode & 511;
    fileModes[change.path] = { before: beforeMode, after: change.after === null ? null : beforeMode ?? createdMode };
  }
  const conflict = caseConflict(root, before.files, changes);
  if (conflict)
    throw new Error(`CASE_CONFLICT: ${conflict} differs only by case from another path`);
  const added = newDiagnostics(result.diagnosticsBefore, result.diagnosticsAfter);
  const body = {
    schemaVersion: changes.some((c) => c.before === null || c.after === null) ? 2 : 1,
    request,
    backend: result.backend,
    backendVersion: result.version,
    snapshot: before,
    changes,
    fileModes,
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
    plan = JSON.parse(await readFile2(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("INVALID_PLAN: plan is not valid JSON");
    throw error;
  }
  assertPlanShape(plan);
  return plan;
}
async function assertFresh(plan) {
  if (plan.id !== planId(plan))
    throw new Error("INVALID_PLAN: plan integrity check failed");
  if (await realpath2(plan.request.root) !== plan.request.root)
    throw new Error("INVALID_PLAN: noncanonical root");
  if ((await snapshot(plan.request.root)).hash !== plan.snapshot.hash)
    throw new Error("STALE_SNAPSHOT: project changed; create a new plan");
  for (const [path, modes] of Object.entries(plan.fileModes ?? {})) {
    if (modes.before !== null && ((await lstat2(path)).mode & 511) !== modes.before) {
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

// src/core/apply.ts
async function readOrNull(path) {
  return readFile3(path).catch((error) => {
    if (error.code === "ENOENT")
      return null;
    throw error;
  });
}
var sameContent = (current, expected) => expected === null ? current === null : current !== null && sha256(current) === sha256(expected);
async function atomicWrite(path, content, mode, expectedContent) {
  const temporary = resolve3(dirname2(path), `.refactor-write-${randomUUID()}`);
  try {
    const handle = await open(temporary, "wx", 384);
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
      await mkdir(directory);
      created.push(directory);
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
      const existing = await lstat3(directory);
      if (existing.isSymbolicLink() || !existing.isDirectory())
        throw new Error(`NOT_A_DIRECTORY: ${directory}`);
    }
  }
}
var fileId2 = (s) => `${s.dev}:${s.ino}`;
async function order(plan) {
  const steps = plan.changes.map((change) => ({ change, kind: changeKind(change) }));
  const deleted = new Set;
  for (const step of steps)
    if (step.kind === "delete")
      deleted.add(fileId2(await lstat3(step.change.path)));
  const aliases = new Set;
  for (const step of steps) {
    if (step.kind !== "create")
      continue;
    const existing = await lstat3(step.change.path).catch((error) => {
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
async function applyPlan(plan) {
  assertPlanShape(plan);
  if (plan.validation.status !== "passed" || newDiagnostics(plan.diagnosticsBefore, plan.diagnosticsAfter).length) {
    throw new Error("VALIDATION_FAILED: plan adds compiler errors");
  }
  const root = plan.request.root;
  const stateDirectory = resolve3(root, ".refactor-ai");
  await mkdir(stateDirectory, { recursive: true });
  if ((await lstat3(stateDirectory)).isSymbolicLink())
    throw new Error("SYMLINK_UNSUPPORTED: state directory");
  const lock = resolve3(stateDirectory, "apply.lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error("APPLY_LOCKED: another apply or interrupted transaction; inspect .refactor-ai/apply.lock");
    throw error;
  }
  const journalPath = resolve3(stateDirectory, `${plan.id}.journal.json`);
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
    await assertFresh(plan);
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
      await writeFile(journalPath, JSON.stringify(journal, null, 2) + `
`).catch(() => {});
    }
    if (recoveryNeeded)
      throw new Error(`RECOVERY_NEEDED: inspect ${journalPath}; ${String(error)}`);
    throw error;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

// src/languages.ts
import { extname } from "node:path";
var languageOperations = {
  typescript: ["rename", "imports", "format", "extract-function", "extract-variable", "rename-file", "move-type"],
  csharp: ["rename", "imports", "format", "rename-file", "sync-namespace", "move-type"]
};
function languageForProject(project) {
  const extension = extname(project).toLowerCase();
  if (extension === ".csproj" || extension === ".sln")
    return "csharp";
  if (extension === ".json")
    return "typescript";
  throw new Error("UNSUPPORTED_PROJECT: use tsconfig/jsconfig.json, .csproj or .sln");
}

// src/api.ts
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
  return {
    async plan(options) {
      const { project, request } = await resolveRequest();
      const engine = await context.loadBackend(project, context.toolkitRoot);
      return createPlan(request, engine.analyze);
      async function resolveRequest() {
        const operation = options.operation ?? context.operation;
        if (!operation || !Object.values(languageOperations).some((items) => items.includes(operation)))
          throw new Error(`UNSUPPORTED: ${operation}`);
        if (context.operation && operation !== context.operation)
          throw new Error(`UNSUPPORTED: this tool only supports ${context.operation}`);
        assertLanguage(options.project);
        if (options.targetProject)
          assertLanguage(options.targetProject);
        if (options.mode !== undefined && !["sort", "remove-unused"].includes(options.mode))
          throw new Error("INVALID_ARGUMENT: mode sort|remove-unused");
        if (operation === "move-type" && !options.target)
          throw new Error("INVALID_ARGUMENT: target required for move-type");
        if ((options.target !== undefined || options.targetProject !== undefined) && operation !== "move-type") {
          throw new Error("INVALID_ARGUMENT: target and targetProject require move-type");
        }
        const project = await realpath3(resolve4(options.project));
        const file = await realpath3(resolve4(options.file));
        const root = await realpath3(resolve4(options.root ?? dirname3(project)));
        const text = await readFile4(file, "utf8");
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
          ...options.at !== undefined ? { position: position(options.at) } : {},
          ...options.end !== undefined ? { end: position(options.end) } : {},
          ...options.name !== undefined ? { newName: options.name } : {},
          ...operation === "imports" ? { mode: options.mode ?? (context.language === "csharp" ? "remove-unused" : "sort") } : {},
          ...options.target !== undefined ? { target: resolve4(options.target) } : {},
          ...options.targetProject !== undefined ? { targetProject: await realpath3(resolve4(options.targetProject)) } : {},
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
      await assertFresh(plan);
      return { status: plan.validation.status === "passed" ? "validated" : "failed", validation: plan.validation, id: plan.id };
    },
    async apply(plan) {
      checkPlan(plan);
      return applyPlan(plan);
    },
    async loadPlan(path) {
      const plan = await loadPlan(resolve4(path));
      checkPlan(plan);
      return plan;
    },
    async capabilities(project) {
      assertLanguage(project);
      const engine = await context.loadBackend(await realpath3(resolve4(project)), context.toolkitRoot);
      return engine.capabilities.filter((item) => !context.operation || item.operation === context.operation).map((item) => ({ ...item, ...item.modes ? { modes: [...item.modes] } : {} }));
    }
  };
}

// src/runtime/skill.ts
import { existsSync as existsSync2, readFileSync } from "node:fs";
import { mkdir as mkdir2, rm as rm2 } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join as join2 } from "node:path";

// src/runtime/npm.ts
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname as dirname4, join, resolve as resolve5 } from "node:path";
function npmCli() {
  const executableDirectory = dirname4(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    resolve5(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ...(process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, process.platform === "win32" ? "npm.cmd" : "npm"))
  ];
  for (const candidate of candidates) {
    if (!candidate)
      continue;
    try {
      let path = realpathSync(candidate);
      if (path.endsWith(".cmd"))
        path = join(dirname4(path), "node_modules", "npm", "bin", "npm-cli.js");
      if (path.endsWith("npm-cli.js") && existsSync(path))
        return path;
    } catch {}
  }
  throw new Error("NPM_NOT_FOUND: npm is required; install Node.js with npm");
}

// src/runtime/skill.ts
async function ensureSkillRuntime(skillRoot, quiet = false) {
  const runtime = join2(skillRoot, "assets", "runtime");
  const ready = () => {
    try {
      const manifest = JSON.parse(readFileSync(join2(runtime, "node_modules", "typescript", "package.json"), "utf8"));
      return manifest.version === "5.9.3" && existsSync2(join2(runtime, "node_modules", "typescript", "lib", "typescript.js"));
    } catch {
      return false;
    }
  };
  if (ready())
    return;
  const lock = join2(runtime, ".setup.lock");
  try {
    await mkdir2(lock);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`SKILL_SETUP_BUSY: another setup is running; after an interrupted setup inspect ${lock}`);
    throw error;
  }
  try {
    if (ready())
      return;
    if (!quiet)
      process.stderr.write(`Installing the skill's locked TypeScript runtime dependency...
`);
    const result = spawnSync(process.execPath, [npmCli(), "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: runtime,
      stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", process.stderr, process.stderr],
      timeout: 180000,
      encoding: "utf8"
    });
    if (result.error)
      throw new Error(`SKILL_SETUP_FAILED: ${result.error.message}`);
    if (result.status !== 0 || !ready())
      throw new Error(`SKILL_SETUP_FAILED: npm ci did not install the locked runtime dependency${quiet ? `
${result.stderr || result.stdout}` : ""}`);
  } finally {
    await rm2(lock, { recursive: true, force: true });
  }
}

// scripts/skill-api.ts
async function createInstalledRefactor(moduleUrl, operation) {
  const skillRoot = resolve6(dirname5(fileURLToPath(moduleUrl)), "..");
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("UNSUPPORTED_RUNTIME: Node.js 22+ is required");
  await ensureSkillRuntime(skillRoot, true);
  const { loadBackend } = await import(pathToFileURL(join3(skillRoot, "assets", "runtime", "api.mjs")).href);
  return createRefactorApi({
    loadBackend,
    operation,
    language: operation.startsWith("extract-") ? "typescript" : operation === "sync-namespace" ? "csharp" : undefined,
    toolkitRoot: join3(skillRoot, "assets")
  });
}

// dist/skill-api-entry.ts
var createRefactor = () => createInstalledRefactor(import.meta.url, "extract-function");
export {
  createRefactor
};
