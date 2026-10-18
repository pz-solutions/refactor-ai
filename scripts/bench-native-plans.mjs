// Optional spike: validate existing edit-only plans in native in-memory sessions.
// No analyzed source/config file is written. Install the checker separately.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2] || !process.argv[3]) {
  throw new Error('Usage: node scripts/bench-native-plans.mjs <unpacked-checker-package> <directory-of-rename-plans>');
}
const pkg = resolve(process.argv[2]), directory = resolve(process.argv[3]);
const plans = readdirSync(directory).filter(name => /^\d+\.json$/.test(name)).sort((a, b) => Number.parseInt(a) - Number.parseInt(b))
  .map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')));
assert.ok(plans.length, 'No numbered plans found');
const { root, project } = plans[0].request;
for (const plan of plans) {
  assert.equal(plan.request.root, root);
  assert.equal(plan.request.project, project);
  assert.equal(plan.request.operation, 'rename');
  for (const change of plan.changes) assert.equal(readFileSync(change.path, "utf8"), change.before, `Plan source changed: ${change.path}`);
  assert.ok(plan.changes.every(change => change.before !== null && change.after !== null), 'Only edits to existing files are supported by this spike');
}
const { API } = await import(pathToFileURL(join(pkg, 'dist/api/sync/api.js')));
const fs = await import(pathToFileURL(join(pkg, 'dist/api/fs.js')));
const requestFs = typeof fs.createFileSystemLayer === 'function';
let overlays = new Map();
const api = new API({ cwd: root, collectTiming: true, ...(!requestFs ? { fs: {
  readFile: path => overlays.has(path) ? overlays.get(path) : undefined,
  fileExists: path => overlays.has(path) ? true : undefined,
} } : {}) });
const samples = [];
let snapshot;
function check(current, expected = new Map()) {
  const program = (requestFs ? current.getConfiguredProject(project) : current.getProject(project)).program;
  assert.ok(program.getSourceFile(plans[0].request.file), "Selected source missing from native program");
  for (const [path, text] of expected) assert.equal(program.getSourceFile(path)?.text, text.replace(/^\uFEFF/, ""), `Stale native overlay: ${path}`);
  return [...program.getConfigFileParsingDiagnostics(), ...program.getProgramDiagnostics(), ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
    .map(item => ({ file: item.fileName, code: item.code, message: item.text ?? item.messageText }));
}
try {
  const start = performance.now();
  snapshot = requestFs ? api.createSnapshot({ openProjects: [project] }) : api.updateSnapshot({ openProjects: [project] });
  const before = check(snapshot);
  assert.deepEqual(before, [], 'This spike expects the measured project baseline to be clean');
  samples.push({ stage: 'baseline', ms: Math.round(performance.now() - start), diagnostics: before.length });
  for (const [index, plan] of plans.entries()) {
    const start = performance.now();
    const changed = new Set([...overlays.keys(), ...plan.changes.map(change => change.path)]);
    overlays = new Map(plan.changes.map(change => [change.path, change.after]));
    // Each plan starts from disk, not from the preceding plan's virtual result.
    const entries = [...changed].map(path => [path, overlays.get(path) ?? readFileSync(path, 'utf8')]);
    snapshot = requestFs ? snapshot.update({ ensurePrograms: true, fileNotifications: { changed: [...changed] }, fileSystem: fs.createFileSystemLayer(entries) })
      : api.updateSnapshot({ fileChanges: { changed: [...changed] } });
    const diagnostics = check(snapshot, overlays);
    assert.deepEqual(diagnostics, [], `Native checker rejected validated rename plan ${index + 1}`);
    samples.push({ stage: `plan ${index + 1}`, ms: Math.round(performance.now() - start), diagnostics: diagnostics.length, files: overlays.size });
  }
  console.log(JSON.stringify({ checker: basename(resolve(pkg, '..')), root, project, mode: 'full native diagnostics over real edit-only plans; disk unchanged', samples, timing: api.getTimingInfo() }, null, 2));
} finally { api.close(); }
