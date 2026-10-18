import assert from 'node:assert/strict';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) {
  throw new Error('Usage: node scripts/probe-native-checkers.mjs <unpacked-package-directory>');
}
const pkg = resolve(process.argv[2]);
const checker = basename(resolve(pkg, '..'));
const { API } = await import(pathToFileURL(`${pkg}/dist/api/sync/api.js`));
const fsAPI = await import(pathToFileURL(`${pkg}/dist/api/fs.js`));
// Microsoft nightly and Rust use request filesystems; stable Go uses callbacks.
const requestFs = typeof fsAPI.createFileSystemWithLib === 'function';
const cwd = '/tmp/refactor-ai-virtual';
const f = name => `${cwd}/${name}`;
const files = {
  [f('tsconfig.json')]: JSON.stringify({
    compilerOptions: {
      strict: true, noEmit: true, module: 'esnext', moduleResolution: 'bundler',
      target: 'es2022', skipLibCheck: true,
    },
    include: ['*.ts'],
  }),
  [f('a.ts')]: 'export const value = 1;\n',
  [f('b.ts')]: "export { value } from './a';\n",
  [f('c.ts')]: "import { value } from './b'; const n: number = value;\n",
  [f('pkg.ts')]: "import { val } from 'virtual-pkg'; const n: number = val;\n",
  [f('node_modules/virtual-pkg/package.json')]: JSON.stringify({
    name: 'virtual-pkg', type: 'module', exports: './one.d.ts',
  }),
  [f('node_modules/virtual-pkg/one.d.ts')]: 'export declare const val: number;\n',
  [f('node_modules/virtual-pkg/two.d.ts')]: 'export declare const val: string;\n',
};
let virtual = requestFs ? undefined : fsAPI.createVirtualFileSystem(files);
// Keep callbacks stable, but delegate each invocation to the current filesystem.
const callbacks = Object.fromEntries(
  ['readFile', 'fileExists', 'directoryExists', 'getAccessibleEntries', 'realpath']
    .map(name => [name, (...args) => virtual[name](...args)]),
);
const api = new API({ cwd, ...(!requestFs ? { fs: callbacks } : {}), collectTiming: true });
const result = [];
let snapshot;

function nextSnapshot(changes) {
  if (!requestFs) {
    virtual = fsAPI.createVirtualFileSystem(files);
    return api.updateSnapshot(snapshot
      ? { fileChanges: changes }
      : { openProjects: [f('tsconfig.json')] });
  }
  if (!snapshot) {
    return api.createSnapshot({
      openProjects: [f('tsconfig.json')],
      fileSystem: fsAPI.createFileSystemWithLib(Object.entries(files)),
    });
  }
  // The layer explicitly masks deleted files inherited from the base snapshot.
  const changedFiles = [...(changes.changed ?? []), ...(changes.created ?? [])];
  return snapshot.update({
    ensurePrograms: true,
    fileNotifications: changes,
    fileSystem: fsAPI.createFileSystemLayer(
      changedFiles.map(path => [path, files[path]]),
      { removedPaths: changes.deleted },
    ),
  });
}

function records(diagnostics) {
  return diagnostics.map(item => ({
    code: item.code,
    file: item.fileName?.replace(`${cwd}/`, ''),
    message: item.text ?? item.messageText,
  }));
}

function step(name, changes = {}) {
  const next = nextSnapshot(changes);
  const project = requestFs
    ? next.getConfiguredProject(f('tsconfig.json'))
    : next.getProject(f('tsconfig.json'));
  const p = project.program;
  const actual = {
    name,
    aText: p.getSourceFile(f('a.ts'))?.text,
    bText: p.getSourceFile(f('b.ts'))?.text,
    files: p.getSourceFileNames().filter(path => !path.includes('lib.')),
    c: records(p.getSemanticDiagnostics(f('c.ts'))),
    pkg: records(p.getSemanticDiagnostics(f('pkg.ts'))),
    all: records(p.getSemanticDiagnostics()),
    globals: records(p.getGlobalDiagnostics()),
    program: records(p.getProgramDiagnostics()),
    config: records(p.getConfigFileParsingDiagnostics()),
    syntax: records(p.getSyntacticDiagnostics()),
  };
  result.push(actual);
  const packageChanged = name === 'package exports resolution changed';
  const moved = name === 'create-delete-move' || packageChanged;
  const expected = name === 'changed source, two-hop importer'
    ? [['c.ts', 2322]] : packageChanged ? [['pkg.ts', 2322]] : [];
  assert.deepEqual(actual.all.map(item => [item.file, item.code]), expected);
  for (const kind of ['globals', 'program', 'config', 'syntax']) {
    assert.deepEqual(actual[kind], [], `${name}: unexpected ${kind} diagnostics`);
  }
  assert.deepEqual([...actual.files].sort(), [
    moved ? 'new.ts' : 'a.ts', 'b.ts', 'c.ts', 'pkg.ts',
    `node_modules/virtual-pkg/${packageChanged ? 'two' : 'one'}.d.ts`,
  ].map(f).sort());
  assert.deepEqual(
    [...actual.c, ...actual.pkg].sort((a, b) => a.file.localeCompare(b.file)),
    actual.all,
  );
  if (moved) {
    assert.equal(actual.aText, undefined);
    assert.match(actual.bText, /new/);
  }
  snapshot = next;
}

try {
  step('before');
  files[f('a.ts')] = 'export const value = "bad";\n';
  step('changed source, two-hop importer', { changed: [f('a.ts')] });
  delete files[f('a.ts')];
  files[f('new.ts')] = 'export const value = 1;\n';
  files[f('b.ts')] = "export { value } from './new';\n";
  step('create-delete-move', {
    changed: [f('b.ts')], created: [f('new.ts')], deleted: [f('a.ts')],
  });
  files[f('node_modules/virtual-pkg/package.json')] = JSON.stringify({
    name: 'virtual-pkg', type: 'module', exports: './two.d.ts',
  });
  step('package exports resolution changed', {
    changed: [f('node_modules/virtual-pkg/package.json')],
  });
  console.log(JSON.stringify({ checker, result, timing: api.getTimingInfo() }, null, 2));
} finally {
  api.close();
}
