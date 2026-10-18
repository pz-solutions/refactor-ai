import { afterEach, expect, test } from "bun:test";
import ts from "typescript";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { baselineDiagnostics, CompilerInputs } from "../src/backends/typescript-diagnostics-cache";
import { analyze } from "../src/backends/typescript";

const roots: string[] = [];
const previousCache = process.env.REFACTOR_AI_CACHE;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousCache === undefined) delete process.env.REFACTOR_AI_CACHE;
  else process.env.REFACTOR_AI_CACHE = previousCache;
});

function fixture() {
  process.env.REFACTOR_AI_CACHE = "on";
  const root = mkdtempSync(join(tmpdir(), "rai-cache-")); roots.push(root);
  const write = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  write("src/leaf.ts", 'export { value } from "dependency";\n');
  write("src/middle.ts", 'export { value } from "./leaf";\n');
  write("src/caller.ts", 'import { value } from "./middle"; export const n: number = value;\n');
  write("node_modules/dependency/package.json", '{"types":"index.d.ts"}');
  write("node_modules/dependency/index.d.ts", 'export const value: number;\n');
  let computations = 0;
  const check = (strict = true) => {
    const inputs = new CompilerInputs();
    const options = { noEmit: true, strict, skipLibCheck: true, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };
    const host = ts.createCompilerHost(options);
    for (const method of ["readFile", "fileExists", "directoryExists", "getDirectories", "readDirectory", "realpath"] as const) {
      (host as any)[method] = inputs.sys[method];
    }
    const program = ts.createProgram([join(root, "src/caller.ts")], options, host);
    return baselineDiagnostics(root, join(root, "tsconfig.json"), program, undefined, inputs, () => {
      computations++;
      // Exercise a negative resolution probe and automatic type directory membership.
      inputs.sys.fileExists(join(root, "node_modules/missing/index.d.ts"));
      inputs.sys.getDirectories(join(root, "node_modules"));
      return ts.getPreEmitDiagnostics(program).filter(item => item.category === ts.DiagnosticCategory.Error).map(item => ({
        file: item.file?.fileName ?? root, code: `TS${item.code}`, message: ts.flattenDiagnosticMessageText(item.messageText, "\n"),
      }));
    });
  };
  return { root, write, check, computations: () => computations };
}

test("persistent baseline hits across fresh programs, invalidates content through two re-exports", () => {
  const f = fixture();
  expect(f.check()).toEqual([]); expect(f.check()).toEqual([]); expect(f.computations()).toBe(1);
  f.write("node_modules/dependency/index.d.ts", "export const value: string;\n");
  expect(f.check().some(item => item.code === "TS2322" && item.file.endsWith("caller.ts"))).toBe(true);
  expect(f.computations()).toBe(2);
  f.write("src/caller.ts", 'import { value } from "./middle"; export const n: string = value;\n');
  expect(f.check()).toEqual([]); expect(f.computations()).toBe(3);
});

test("compiler options, manifests, negative lookups and directory membership invalidate", () => {
  const f = fixture(); f.check(); f.check(false); expect(f.computations()).toBe(2);
  f.write("node_modules/dependency/package.json", '{"types":"index.d.ts","type":"module"}');
  f.check(); expect(f.computations()).toBe(3);
  f.write("node_modules/missing/index.d.ts", "export {};\n");
  f.check(); expect(f.computations()).toBe(4);
  mkdirSync(join(f.root, "node_modules/new-types"));
  f.check(); expect(f.computations()).toBe(5);
});

test("malformed and corrupted cache entries are misses", () => {
  const f = fixture(); f.check();
  const cache = join(f.root, ".refactor-ai/cache");
  const path = join(cache, readdirSync(cache)[0]!);
  writeFileSync(path, "{}"); f.check(); expect(f.computations()).toBe(2);
  writeFileSync(path, "not json"); f.check(); expect(f.computations()).toBe(3);
});

test("a cache directory symlink is ignored without writes through it", () => {
  const f = fixture(); const elsewhere = mkdtempSync(join(tmpdir(), "rai-cache-link-")); roots.push(elsewhere);
  symlinkSync(elsewhere, join(f.root, ".refactor-ai"));
  f.check(); f.check();
  expect(f.computations()).toBe(2); expect(readdirSync(elsewhere)).toEqual([]);
});

test("a cached baseline never suppresses a new planned error two re-exports away", async () => {
  const f = fixture();
  f.write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, module: "esnext", moduleResolution: "bundler" }, include: ["src"] }));
  f.write("src/leaf.ts", 'export {value} from "dependency";export const broken:number="existing";\n');
  f.write("node_modules/changed/package.json", '{"types":"index.d.ts"}');
  f.write("node_modules/changed/index.d.ts", 'export const value: string;\n');
  const request = { root: f.root, project: join(f.root, "tsconfig.json"), file: join(f.root, "src/leaf.ts") };
  const first = await analyze({ ...request, operation: "format" });
  const second = await analyze({ ...request, operation: "format" });
  expect(second).toEqual(first);
  expect(first.diagnosticsBefore.map(item => item.code)).toEqual(["TS2322"]);
  expect(readdirSync(join(f.root, ".refactor-ai/cache")).length).toBeGreaterThan(0);
  await expect(analyze({ ...request, operation: "retarget-import", from: "dependency", to: "changed" })).rejects.toThrow(/NEW_DIAGNOSTICS: TS2322/);
});
