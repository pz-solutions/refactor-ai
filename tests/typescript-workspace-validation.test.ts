import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { Workspace } from "../src/backends/typescript-workspace";

const roots: string[] = [];
const options = { strict: true, target: "es2022", module: "esnext", moduleResolution: "bundler", skipLibCheck: true };
const config = (extra: object = {}) => JSON.stringify({ compilerOptions: options, include: ["src"], ...extra });

async function workspace(files: Record<string, string> = {}, source = "tsconfig.json", target = source, affected: string[] = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-validation-")));
  roots.push(root);
  for (const [path, text] of Object.entries({
    "tsconfig.json": config(),
    "src/leaf.ts": "export const value = 1;\n",
    "src/middle.ts": 'export { value } from "./leaf";\n',
    "src/caller.ts": 'import { value } from "./middle";\nexport const number: number = value;\n',
    "src/unrelated.ts": 'export const broken: number = "existing error";\n',
    ...files,
  })) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return new Workspace(root, join(root, source), join(root, target), affected.map((path) => join(root, path)));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("workspace closure checks two-hop importers and excludes unrelated existing errors", async () => {
  const ws = await workspace();
  try {
    const validate = ws.prepareValidation();
    ws.vfs.write(join(ws.root, "src/leaf.ts"), 'export const value = "broken";\n');
    const result = validate();
    expect(result.affected).toBe(3);
    expect(result.before).toEqual([]);
    expect(result.after.map((item) => [item.file, item.code])).toEqual([[join(ws.root, "src/caller.ts"), "TS2322"]]);
  } finally { ws.dispose(); }
});

test("comparison mode skips the original baseline only after every planned project is clean", async () => {
  const ws = await workspace({ "src/leaf.ts": 'export const value = "old error";\n' });
  try {
    const validate = ws.prepareValidation(true);
    ws.vfs.write(join(ws.root, "src/leaf.ts"), "export const value = 1;\n");
    const result = validate();
    expect(result.before).toEqual([]);
    expect(result.after).toEqual([]);
    expect(result.affected).toBe(3);
  } finally { ws.dispose(); }
});

test("each participant and observer checks its own two-hop closure and merges duplicate diagnostics", async () => {
  const ws = await workspace({
    "Source/tsconfig.json": config(),
    "Source/src/leaf.ts": "export const value = 1;\n",
    "Source/src/unrelated.ts": 'export const broken: number = "existing error";\n',
    "Target/tsconfig.json": config(),
    "Source/tsconfig.build.json": config(),
    "Target/src/middle.ts": 'export { value } from "../../Source/src/leaf";\n',
    "Target/src/caller.ts": 'import { value } from "./middle";\nexport const number: number = value;\n',
    "Target/src/unrelated.ts": 'export const broken: number = "existing error";\n',
  }, "Source/tsconfig.json", "Target/tsconfig.json", ["Source/src/leaf.ts"]);
  try {
    const validate = ws.prepareValidation();
    ws.vfs.write(join(ws.root, "Source/src/leaf.ts"), 'export const value = "broken";\n');
    const result = validate();
    expect(ws.participants.size).toBe(3);
    expect(ws.observers()).toEqual([join(ws.root, "Source/tsconfig.build.json")]);
    expect(result.affected).toBe(5);
    expect(result.before).toEqual([]);
    expect(result.after.map((item) => [item.file, item.code])).toEqual([[join(ws.root, "Target/src/caller.ts"), "TS2322"]]);
  } finally { ws.dispose(); }
});

test("workspace closure includes newly resolved importers and deleted-and-recreated paths", async () => {
  const ws = await workspace({ "src/leaf.ts": 'export { value } from "./created";\n' });
  try {
    const validate = ws.prepareValidation();
    ws.vfs.write(join(ws.root, "src/created.ts"), 'export const value = "broken";\n');
    ws.vfs.write(join(ws.root, "src/middle.ts"), null);
    ws.vfs.write(join(ws.root, "src/middle.ts"), 'export { value } from "./created";\n');
    ws.reparse();
    const result = validate();
    expect(result.affected).toBe(4);
    expect(result.before.map((item) => item.code)).toEqual(["TS2307"]);
    expect(result.after.map((item) => [item.file, item.code])).toEqual([[join(ws.root, "src/caller.ts"), "TS2322"]]);
  } finally { ws.dispose(); }
});

for (const [path, before, after] of [
  ["src/globals.ts", "interface Global { value: number }\n", "interface Global { value: string }\n"],
  ["src/globals.d.ts", "export interface Global { value: number }\n", "export interface Global { value: string }\n"],
  ["src/globals.ts", "export {}; declare global { interface Global { value: number } }\n", "export {}; declare global { interface Global { value: string } }\n"],
  ["src/globals.ts", 'export {}; declare module "./leaf" { interface RareGlobalShape { value: number } }\n', 'export {}; declare module "./leaf" { interface RareGlobalShape { value: string } }\n'],
  ["tsconfig.json", config(), config({ compilerOptions: { ...options, strict: false } })],
  ["package.json", '{"type":"module"}', '{"type":"commonjs"}'],
] as const) {
  test(`workspace validation falls back for ${path}: ${before.slice(0, 35)}`, async () => {
    const ws = await workspace({ [path]: before });
    try {
      const validate = ws.prepareValidation();
      ws.vfs.write(join(ws.root, path), after);
      ws.reparse();
      const result = validate();
      expect(result.affected).toBeUndefined();
      expect(result.before.some((item) => item.file.endsWith("unrelated.ts"))).toBe(true);
    } finally { ws.dispose(); }
  });
}

test("removing a global augmentation still checks files without import edges", async () => {
  const ws = await workspace({
    "src/globals.ts": "export {}; declare global { interface Global { value: number } }\n",
    "src/unrelated.ts": "export const value: Global = { value: 1 };\n",
  });
  try {
    const validate = ws.prepareValidation();
    ws.vfs.write(join(ws.root, "src/globals.ts"), "export {};\n");
    const result = validate();
    expect(result.affected).toBeUndefined();
    expect(result.before).toEqual([]);
    expect(result.after.some((item) => item.code === "TS2304" && item.file.endsWith("unrelated.ts"))).toBe(true);
  } finally { ws.dispose(); }
});

test("newly imported dependency augmentations trigger full checks outside the user module graph", async () => {
  const ws = await workspace({
    "node_modules/dependency/package.json": '{"types":"index.d.ts"}',
    "node_modules/dependency/index.d.ts": "export {}; declare global { interface RareGlobalShape { value: number } }\n",
    "src/unrelated.ts": "export const value: RareGlobalShape = { value: 1 };\n",
  });
  try {
    const validate = ws.prepareValidation();
    ws.vfs.write(join(ws.root, "src/leaf.ts"), 'import "dependency"; export const value = 1;\n');
    const result = validate();
    expect(result.affected).toBeUndefined();
    expect(result.before.some((item) => item.code === "TS2304" && item.file.endsWith("unrelated.ts"))).toBe(true);
    expect(result.after).toEqual([]);
  } finally { ws.dispose(); }
});

test("new JSON modules stay within the importer closure", async () => {
  const ws = await workspace({
    "tsconfig.json": config({ compilerOptions: { ...options, resolveJsonModule: true } }),
    "src/leaf.ts": 'import data from "./value.json"; export const value = data.value;\n',
  });
  try {
    const validate = ws.prepareValidation();
    ws.vfs.write(join(ws.root, "src/value.json"), '{"value":"broken"}');
    ws.reparse();
    const result = validate();
    expect(result.affected).toBe(4);
    expect(result.before.map((item) => item.code)).toEqual(["TS2307"]);
    expect(result.after.map((item) => [item.file, item.code])).toEqual([[join(ws.root, "src/caller.ts"), "TS2322"]]);
  } finally { ws.dispose(); }
});

test("package exports changes seed unchanged importers whose resolution changes", async () => {
  const ws = await workspace({
    "package.json": JSON.stringify({ name: "self", type: "module", exports: { "./value": "./src/leaf.ts" } }),
    "src/middle.ts": 'export { value } from "self/value";\n',
    "src/alternate.ts": 'export const value = "broken";\n',
  });
  try {
    const validate = ws.prepareValidation();
    ws.vfs.write(join(ws.root, "package.json"), JSON.stringify({ name: "self", type: "module", exports: { "./value": "./src/alternate.ts" } }));
    const result = validate();
    expect(result.affected).toBe(2);
    expect(result.before).toEqual([]);
    expect(result.after.map((item) => [item.file, item.code])).toEqual([[join(ws.root, "src/caller.ts"), "TS2322"]]);
  } finally { ws.dispose(); }
});

test("project references retain full checks and in-memory declaration emission", async () => {
  const ws = await workspace({
    "tsconfig.json": config({ compilerOptions: { ...options, composite: true, outDir: "./dist" }, references: [{ path: "./lib" }] }),
    "lib/tsconfig.json": config({ compilerOptions: { ...options, composite: true, outDir: "./dist" } }),
    "lib/src/value.ts": "export const value = 1;\n",
    "src/leaf.ts": 'export { value } from "../lib/src/value";\n',
  });
  try {
    const validate = ws.prepareValidation();
    ws.vfs.write(join(ws.root, "lib/src/value.ts"), 'export const value = "broken";\n');
    const result = validate();
    expect(result.affected).toBeUndefined();
    expect(result.before.some((item) => item.file.endsWith("unrelated.ts"))).toBe(true);
    expect(result.after.some((item) => item.code === "TS2322" && item.file.endsWith("caller.ts"))).toBe(true);
    expect(ws.vfs.readFile(join(ws.root, "lib/dist/src/value.d.ts"))).toContain('"broken"');
  } finally { ws.dispose(); }
});

test("shared module resolution invalidates negative lookups and original/planned package exports", async () => {
  const ws = await workspace({
    "package.json": '{"name":"self","type":"module","exports":{"./value":"./src/leaf.ts"}}',
    "src/middle.ts": 'export { value } from "self/value"; export { created } from "./new/created";',
    "src/alternate.ts": 'export const value = "alternate";',
  });
  try {
    const source = ws.syntaxFile(join(ws.root, "src/middle.ts"))!;
    const literals = source.statements.filter(ts.isExportDeclaration).map(statement => statement.moduleSpecifier as ts.StringLiteral);
    const target = (index: number) => ws.resolveModule(literals[index]!, source)?.resolvedFileName;
    expect(target(0)).toBe(join(ws.root, "src/leaf.ts"));
    expect(target(1)).toBeUndefined();
    ws.vfs.write(join(ws.root, "src/new/created.ts"), "export const created = 1;");
    ws.vfs.write(join(ws.root, "package.json"), '{"name":"self","type":"module","exports":{"./value":"./src/alternate.ts"}}');
    expect(target(0)).toBe(join(ws.root, "src/alternate.ts"));
    expect(target(1)).toBe(join(ws.root, "src/new/created.ts"));
    ws.vfs.original(() => {
      expect(target(0)).toBe(join(ws.root, "src/leaf.ts"));
      expect(target(1)).toBeUndefined();
    });
    expect(target(0)).toBe(join(ws.root, "src/alternate.ts"));
    expect(target(1)).toBe(join(ws.root, "src/new/created.ts"));
  } finally { ws.dispose(); }
});

test("syntax caches preserve original/planned text and cannot override forced compiler module detection", async () => {
  const ws = await workspace({ "tsconfig.json": config({ compilerOptions: { ...options, moduleDetection: "force" } }),
    "src/global.ts": "interface PrivateShape { value: number }" });
  try {
    const file = join(ws.root, "src/global.ts");
    const original = ws.syntaxFile(file)!;
    expect(ts.isExternalModule(original)).toBe(false);
    ws.reparse();
    const validate = ws.prepareValidation();
    ws.vfs.write(file, "interface PrivateShape { value: string }");
    const planned = ws.syntaxFile(file)!;
    expect(planned).not.toBe(original);
    const result = validate();
    expect(result.affected).toBe(1);
    expect(ws.syntaxFile(file)).toBe(planned);
    expect(ws.vfs.original(() => ws.syntaxFile(file))).toBe(original);
  } finally { ws.dispose(); }
});

test("cached directories reject an ignored generated root appearing during analysis", async () => {
  const ws = await workspace({ ".gitignore": "src/generated/\n" });
  try {
    const validate = ws.prepareValidation(true);
    // The planner does not write this input; it represents a concurrent generator.
    await mkdir(join(ws.root, "src/generated"));
    await writeFile(join(ws.root, "src/generated/routeTree.gen.ts"), "export {}; declare global { interface Generated { value: string } }");
    ws.vfs.write(join(ws.root, "src/leaf.ts"), "export const value = 2;");
    validate();
    expect(() => ws.vfs.assertStableMetadata()).toThrow("STALE_PROJECT_INPUTS: readDirectory changed");
  } finally { ws.dispose(); }
});

test("cached negative directory probes reject concurrent creation without rejecting virtual directories", async () => {
  const ws = await workspace();
  try {
    const path = join(ws.root, "missing");
    expect(ws.vfs.directoryExists(path)).toBe(false);
    ws.vfs.write(join(path, "virtual.ts"), "export const value = 1;");
    expect(ws.vfs.directoryExists(path)).toBe(true);
    expect(() => ws.vfs.assertStableMetadata()).not.toThrow();
    await mkdir(path);
    expect(() => ws.vfs.assertStableMetadata()).toThrow("STALE_PROJECT_INPUTS");
  } finally { ws.dispose(); }
});

test("registry documents keep parents before binding when participants use different target buckets", async () => {
  const ws = await workspace({
    "Source/tsconfig.json": config(),
    "Source/src/value.ts": "export const value = 1;",
    "Target/tsconfig.json": config({ compilerOptions: { ...options, target: "es2017" } }),
    "Target/src/use.ts": 'import { value } from "../../Source/src/value"; export const n: number = value;',
  }, "Source/tsconfig.json", "Source/tsconfig.json", ["Source/src/value.ts"]);
  try {
    ws.program(); // The editing service binds only its own target's registry bucket.
    const validate = ws.prepareValidation();
    ws.vfs.write(join(ws.root, "Source/src/value.ts"), 'export const value = "bad";');
    const result = validate();
    expect(result.before).toEqual([]);
    expect(result.after.map(item => [item.file, item.code])).toEqual([[join(ws.root, "Target/src/use.ts"), "TS2322"]]);
  } finally { ws.dispose(); }
});
