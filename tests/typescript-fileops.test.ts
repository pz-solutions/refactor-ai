import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { analyze, capabilities } from "../src/backends/typescript";
import type { FileChange, RefactorRequest } from "../src/types";

const roots: string[] = [];

async function workspace(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-fileops-")));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
  }
  return { root, path: (relativePath: string) => join(root, relativePath) };
}

async function listing(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else result[path] = await readFile(path, "utf8");
    }
  };
  await visit(root);
  return result;
}

function byPath(changes: FileChange[], path: string): FileChange | undefined {
  return changes.find((change) => change.path === path);
}

const tsconfig = (extra: object = {}) => JSON.stringify({ compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler", target: "es2022" }, include: ["src"], ...extra }, null, 2);
const caseInsensitive = existsSync(tmpdir().toUpperCase()) && existsSync(tmpdir().toLowerCase());

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("TypeScript file operations", () => {
  for (const extension of ["ts", "js"]) {
    test(`move-type rejects initialization effects in ${extension} classes without writes`, async () => {
      const w = await workspace({
        [extension === "ts" ? "tsconfig.json" : "jsconfig.json"]: tsconfig({ compilerOptions: { target: "es2022", module: "commonjs", allowJs: extension === "js", checkJs: extension === "js" } }),
        [`src/types.${extension}`]: `export function mark(value${extension === "ts" ? ": string" : ""}) { console.log(value); return value; }\nexport class First { static value = mark("first"); }\nexport class Payload { static value = mark("payload"); }\nexport class Last { static value = mark("last"); }\n`,
      });
      const before = await listing(w.root);
      await expect(analyze({ project: w.path(extension === "ts" ? "tsconfig.json" : "jsconfig.json"), root: w.root,
        file: w.path(`src/types.${extension}`), operation: "move-type", typeName: "Payload", target: w.path(`src/Payload.${extension}`) }))
        .rejects.toThrow("INITIALIZATION_EFFECTS_UNSUPPORTED");
      expect(await listing(w.root)).toEqual(before);
    });
  }

  for (const declaration of ["export class Payload { static { console.log('init'); } }", "@decorate\nexport class Payload {}", "export class Payload extends factory() {}", "export enum Payload { Value = compute() }"]) {
    test(`move-type rejects runtime declaration effects: ${declaration}`, async () => {
      const w = await workspace({ "tsconfig.json": tsconfig(), "src/types.ts": `declare function decorate(value: any): any;\ndeclare function factory(): any;\ndeclare function compute(): number;\n${declaration}\n` });
      await expect(analyze({ project: w.path("tsconfig.json"), root: w.root, file: w.path("src/types.ts"), operation: "move-type", typeName: "Payload", target: w.path("src/Payload.ts") }))
        .rejects.toThrow("INITIALIZATION_EFFECTS_UNSUPPORTED");
    });
  }

  test("move-type rejects new runtime module cycles within one project", async () => {
    const w = await workspace({ "tsconfig.json": tsconfig(), "src/types.ts": "export class Base { value(): number { return new Payload().value(); } }\nexport class Payload extends Base {}\n" });
    await expect(analyze({ project: w.path("tsconfig.json"), root: w.root, file: w.path("src/types.ts"), operation: "move-type", typeName: "Payload", target: w.path("src/Payload.ts") }))
      .rejects.toThrow("MODULE_DEPENDENCY_CYCLE");
    expect(existsSync(w.path("src/Payload.ts"))).toBe(false);
  });

  test("advertises rename-file and move-type but not the C#-only sync-namespace", async () => {
    const operations = capabilities.map((capability) => capability.operation);
    expect(operations).toContain("rename-file");
    expect(operations).toContain("move-type");
    expect(operations).not.toContain("sync-namespace");
    const w = await workspace({ "tsconfig.json": tsconfig(), "src/a.ts": "export class A {}\n" });
    await expect(analyze({ project: w.path("tsconfig.json"), root: w.root, file: w.path("src/a.ts"), operation: "sync-namespace" }))
      .rejects.toThrow(/^UNSUPPORTED_OPERATION:/);
  });

  test("rename-file names the file after its type and updates every import without touching disk", async () => {
    const w = await workspace({
      "tsconfig.json": tsconfig(),
      "src/component.ts": "// widget\nexport class Widget {\n  size = 1;\n}\n",
      "src/use.ts": "import { Widget } from './component';\nexport const w = new Widget();\n",
      "src/nested/deep.ts": "import type { Widget } from '../component.js';\nexport type T = Widget;\nexport const lazy = () => import('../component');\n",
    });
    const disk = await listing(w.root);
    const result = await analyze({ project: w.path("tsconfig.json"), root: w.root, file: w.path("src/component.ts"), operation: "rename-file" });

    expect(result.changes).toEqual([
      { path: w.path("src/Widget.ts"), before: null, after: "// widget\nexport class Widget {\n  size = 1;\n}\n" },
      { path: w.path("src/component.ts"), before: "// widget\nexport class Widget {\n  size = 1;\n}\n", after: null },
      {
        path: w.path("src/nested/deep.ts"),
        before: disk[w.path("src/nested/deep.ts")]!,
        after: "import type { Widget } from '../Widget.js';\nexport type T = Widget;\nexport const lazy = () => import('../Widget.js');\n",
      },
      { path: w.path("src/use.ts"), before: disk[w.path("src/use.ts")]!, after: "import { Widget } from './Widget';\nexport const w = new Widget();\n" },
    ]);
    expect(await listing(w.root)).toEqual(disk);
  });

  test("rename-file requires a selection when several types are declared and keeps the extension", async () => {
    const source = "export interface Shape { area(): number }\nexport type Unit = 'cm';\nexport enum Kind { A }\n";
    const w = await workspace({ "tsconfig.json": tsconfig(), "src/defs.tsx": source });
    const request: RefactorRequest = { project: w.path("tsconfig.json"), root: w.root, file: w.path("src/defs.tsx"), operation: "rename-file" };
    await expect(analyze(request)).rejects.toThrow(/^AMBIGUOUS_TYPE: .*Shape, Unit, Kind/);
    const byName = await analyze({ ...request, typeName: "Kind" });
    expect(byName.changes.map((change) => [change.path, change.before === null, change.after === null])).toEqual([
      [w.path("src/Kind.tsx"), true, false],
      [w.path("src/defs.tsx"), false, true],
    ]);
    const byPosition = await analyze({ ...request, position: source.indexOf("Unit") });
    expect(byPosition.changes[0]!.path).toBe(w.path("src/Unit.tsx"));
  });

  test("rename-file preserves BOM and CRLF in moved and edited files", async () => {
    const w = await workspace({
      "tsconfig.json": tsconfig(),
      "src/model.ts": "﻿export class Account {\r\n  id = 1;\r\n}\r\n",
      "src/use.ts": "﻿import { Account } from './model';\r\nexport const a = new Account();\r\n",
    });
    const result = await analyze({ project: w.path("tsconfig.json"), root: w.root, file: w.path("src/model.ts"), operation: "rename-file" });
    expect(byPath(result.changes, w.path("src/Account.ts"))!.after).toBe("﻿export class Account {\r\n  id = 1;\r\n}\r\n");
    expect(byPath(result.changes, w.path("src/use.ts"))).toEqual({
      path: w.path("src/use.ts"),
      before: "﻿import { Account } from './model';\r\nexport const a = new Account();\r\n",
      after: "﻿import { Account } from './Account';\r\nexport const a = new Account();\r\n",
    });
  });

  test("rename-file updates literal files lists in the project config", async () => {
    const config = '{\n  "compilerOptions": { "strict": true },\n  // explicit list\n  "files": ["./src/model.ts", "./src/use.ts"]\n}\n';
    const w = await workspace({
      "tsconfig.json": config,
      "src/model.ts": "export class Order {}\n",
      "src/use.ts": "import { Order } from './model';\nexport const o = new Order();\n",
    });
    const result = await analyze({ project: w.path("tsconfig.json"), root: w.root, file: w.path("src/model.ts"), operation: "rename-file" });
    expect(byPath(result.changes, w.path("tsconfig.json"))!.after).toBe(config.replace("./src/model.ts", "./src/Order.ts"));
  });

  test("rename-file refuses existing targets, namespaces and case-only renames on case-insensitive volumes", async () => {
    const w = await workspace({
      "tsconfig.json": tsconfig(),
      "src/a.ts": "export class Taken {}\n",
      "src/Taken.ts": "export const other = 1;\n",
      "src/ns.ts": "export namespace Geometry { export class Point {} }\n",
      "src/point.ts": "export class Point {}\n",
    });
    const request = (file: string, extra: Partial<RefactorRequest> = {}): RefactorRequest => ({
      project: w.path("tsconfig.json"), root: w.root, file: w.path(file), operation: "rename-file", ...extra,
    });
    await expect(analyze(request("src/a.ts"))).rejects.toThrow(/^TARGET_EXISTS:/);
    await expect(analyze(request("src/ns.ts"))).rejects.toThrow(/^NAMESPACE_UNSUPPORTED:/);
    await expect(analyze(request("src/ns.ts", { typeName: "Point" }))).rejects.toThrow(/^NAMESPACE_UNSUPPORTED:/);
    if (caseInsensitive) {
      await expect(analyze(request("src/point.ts"))).rejects.toThrow(/^CASE_ONLY_RENAME_UNSUPPORTED:/);
    } else {
      const result = await analyze(request("src/point.ts"));
      expect(result.changes.map((change) => change.path)).toEqual([w.path("src/Point.ts"), w.path("src/point.ts")]);
    }
    expect(await readFile(w.path("src/point.ts"), "utf8")).toBe("export class Point {}\n");
  });

  test("rename-file renames a JavaScript class module", async () => {
    const w = await workspace({
      "jsconfig.json": JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", checkJs: true }, include: ["src"] }),
      "src/util.js": "export class Formatter {\n  format(value) { return String(value); }\n}\n",
      "src/main.js": "import { Formatter } from './util.js';\nconsole.log(new Formatter().format(1));\n",
    });
    const result = await analyze({ project: w.path("jsconfig.json"), root: w.root, file: w.path("src/util.js"), operation: "rename-file" });
    expect(byPath(result.changes, w.path("src/Formatter.js"))!.before).toBeNull();
    expect(byPath(result.changes, w.path("src/main.js"))!.after).toBe("import { Formatter } from './Formatter.js';\nconsole.log(new Formatter().format(1));\n");
    expect(result.notes.join("\n")).toContain("JavaScript analysis");
  });

  test("move-type moves only the selected type to a new directory and updates imports and re-exports", async () => {
    const source = [
      "import { Base } from './base';",
      "",
      "/** A shape. */",
      "export class Circle extends Base {",
      "  constructor(readonly radius: number) { super(); }",
      "}",
      "",
      "export interface Square { side: number }",
      "",
      "export function area(circle: Circle): number {",
      "  return circle.radius ** 2;",
      "}",
      "",
    ].join("\n");
    const w = await workspace({
      "tsconfig.json": tsconfig(),
      "src/shapes.ts": source,
      "src/base.ts": "export class Base {}\n",
      "src/use.ts": "import { Circle, Square } from './shapes';\nexport const c = new Circle(1);\nexport const s: Square = { side: 1 };\n",
      "src/index.ts": "export { Circle, area } from './shapes';\n",
      "src/consumer.ts": "import { Circle } from './index';\nexport const r = new Circle(2).radius;\n",
    });
    const disk = await listing(w.root);
    const result = await analyze({
      project: w.path("tsconfig.json"), root: w.root, file: w.path("src/shapes.ts"), operation: "move-type",
      typeName: "Circle", target: w.path("src/geometry/Circle.ts"),
    });
    const created = byPath(result.changes, w.path("src/geometry/Circle.ts"))!;
    expect(created.before).toBeNull();
    expect(created.after).toContain("/** A shape. */");
    expect(created.after).toContain("export class Circle extends Base {");
    expect(created.after).toContain("from '../base'");
    const shapes = byPath(result.changes, w.path("src/shapes.ts"))!.after!;
    expect(shapes).toContain("export interface Square { side: number }");
    expect(shapes).toContain("export function area(circle: Circle)");
    expect(shapes).toContain("import { Circle } from './geometry/Circle';");
    expect(shapes).not.toContain("class Circle");
    const use = byPath(result.changes, w.path("src/use.ts"))!.after!;
    expect(use).toContain("import { Square } from './shapes';");
    expect(use).toContain("import { Circle } from './geometry/Circle';");
    expect(byPath(result.changes, w.path("src/index.ts"))!.after).toBe("export { area } from './shapes';\nexport { Circle } from './geometry/Circle';\n");
    expect(byPath(result.changes, w.path("src/consumer.ts"))).toBeUndefined();
    expect(result.diagnosticsAfter).toEqual([]);
    expect(await listing(w.root)).toEqual(disk);
  });

  test("move-type deletes an emptied source file and retargets star re-exports", async () => {
    const w = await workspace({
      "tsconfig.json": tsconfig(),
      "src/old.ts": "export type Id = string;\n",
      "src/barrel.ts": "export * from './old';\n",
      "src/use.ts": "import type { Id } from './barrel';\nexport const id: Id = 'x';\n",
    });
    const result = await analyze({
      project: w.path("tsconfig.json"), root: w.root, file: w.path("src/old.ts"), operation: "move-type", target: w.path("src/types/Id.ts"),
    });
    expect(byPath(result.changes, w.path("src/old.ts"))!.after).toBeNull();
    expect(byPath(result.changes, w.path("src/barrel.ts"))!.after).toBe("export * from './types/Id';\n");
    expect(byPath(result.changes, w.path("src/types/Id.ts"))!.after).toContain("export type Id = string;");
  });

  test("move-type moves a JavaScript class between files and leaves the other class", async () => {
    const w = await workspace({
      "jsconfig.json": JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", checkJs: true }, include: ["src"] }),
      "src/shapes.js": "export class Circle {\n  constructor(r) { this.r = r; }\n}\n\nexport class Square {\n  constructor(s) { this.s = s; }\n}\n",
      "src/main.js": "import { Circle, Square } from './shapes.js';\nconsole.log(new Circle(1).r, new Square(2).s);\n",
    });
    const result = await analyze({
      project: w.path("jsconfig.json"), root: w.root, file: w.path("src/shapes.js"), operation: "move-type",
      typeName: "Square", target: w.path("src/Square.js"),
    });
    const shapes = byPath(result.changes, w.path("src/shapes.js"))!.after!;
    expect(shapes.trimEnd()).toBe("export class Circle {\n  constructor(r) { this.r = r; }\n}");
    expect(byPath(result.changes, w.path("src/Square.js"))!.after).toContain("export class Square {");
    const main = byPath(result.changes, w.path("src/main.js"))!.after!;
    expect(main).toContain("import { Circle } from './shapes.js';");
    expect(main).toContain("from './Square.js';");
  });

  test("move-type rejects conflicting targets, merged declarations, wrong languages and targets outside the project", async () => {
    const w = await workspace({
      "tsconfig.json": tsconfig(),
      "src/a.ts": "export class Moved {}\nexport interface Merged { a: 1 }\nexport interface Merged { b: 2 }\nexport class Other {}\n",
      "src/b.ts": "export const Moved = 1;\n",
      "scripts/tool.ts": "",
    });
    const request = (extra: Partial<RefactorRequest>): RefactorRequest => ({
      project: w.path("tsconfig.json"), root: w.root, file: w.path("src/a.ts"), operation: "move-type", typeName: "Moved", ...extra,
    });
    await expect(analyze(request({ target: w.path("src/b.ts") }))).rejects.toThrow(/^TARGET_CONFLICT:/);
    await expect(analyze(request({ typeName: "Merged", target: w.path("src/m.ts") }))).rejects.toThrow(/^MERGED_DECLARATION_UNSUPPORTED:/);
    await expect(analyze(request({ target: w.path("src/m.js") }))).rejects.toThrow(/^UNSUPPORTED_TARGET:/);
    await expect(analyze(request({ target: w.path("scripts/Moved.ts") }))).rejects.toThrow(/^TARGET_NOT_IN_PROJECT:/);
    await expect(analyze(request({ typeName: undefined, target: w.path("src/x.ts") }))).rejects.toThrow(/^AMBIGUOUS_TYPE:/);
    await expect(analyze(request({ target: undefined }))).rejects.toThrow(/^INVALID_REQUEST:/);
  });

  test("move-type adds new files to an explicit files list", async () => {
    const config = JSON.stringify({ compilerOptions: { strict: true }, files: ["src/a.ts"] }, null, 2);
    const w = await workspace({ "tsconfig.json": config, "src/a.ts": "export class A {}\nexport class B extends A {}\n" });
    const result = await analyze({
      project: w.path("tsconfig.json"), root: w.root, file: w.path("src/a.ts"), operation: "move-type", typeName: "B", target: w.path("src/B.ts"),
    });
    expect(JSON.parse(byPath(result.changes, w.path("tsconfig.json"))!.after!).files).toEqual(["src/a.ts", "src/B.ts"]);
  });
});

describe("TypeScript cross-project moves", () => {
  const core = (extra: object = {}) => JSON.stringify({
    compilerOptions: { composite: true, strict: true, module: "esnext", moduleResolution: "bundler", target: "es2022", rootDir: "src", outDir: "dist", ...extra },
    include: ["src"],
  }, null, 2);
  const app = JSON.stringify({
    compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler", target: "es2022", noEmit: true },
    include: ["src"],
    references: [{ path: "../core" }],
  }, null, 2);

  async function monorepo(files: Record<string, string> = {}) {
    return workspace({
      "packages/core/tsconfig.json": core(),
      "packages/core/src/currency.ts": "export class Money {\n  constructor(readonly cents: number) {}\n}\n",
      "packages/app/tsconfig.json": app,
      "packages/app/src/models.ts": [
        "import { Money } from '../../core/src/currency';",
        "",
        "export interface Price {",
        "  amount: Money;",
        "}",
        "",
        "export class Cart {",
        "  items: Price[] = [];",
        "}",
        "",
      ].join("\n"),
      "packages/app/src/main.ts": "import { Cart, type Price } from './models';\nimport { Money } from '../../core/src/currency';\nconst p: Price = { amount: new Money(1) };\nnew Cart().items.push(p);\n",
      ...files,
    });
  }

  test("moves a type from a consumer project into its referenced project and validates both with in-memory builds", async () => {
    const w = await monorepo();
    const disk = await listing(w.root);
    const result = await analyze({
      project: w.path("packages/app/tsconfig.json"), root: w.root, file: w.path("packages/app/src/models.ts"), operation: "move-type",
      typeName: "Price", target: w.path("packages/core/src/Price.ts"), targetProject: w.path("packages/core/tsconfig.json"),
    });
    const created = byPath(result.changes, w.path("packages/core/src/Price.ts"))!;
    expect(created.before).toBeNull();
    expect(created.after).toContain("import { Money } from './currency';");
    expect(created.after).toContain("export interface Price {");
    const models = byPath(result.changes, w.path("packages/app/src/models.ts"))!.after!;
    expect(models).toContain("import { Price } from '../../core/src/Price';");
    expect(models).not.toContain("interface Price");
    expect(models).toContain("export class Cart {");
    const main = byPath(result.changes, w.path("packages/app/src/main.ts"))!.after!;
    expect(main).toContain("from '../../core/src/Price'");
    expect(result.diagnosticsBefore).toEqual([]);
    expect(result.diagnosticsAfter).toEqual([]);
    expect(result.notes.join("\n")).toContain("in-memory declaration builds");
    expect(await listing(w.root)).toEqual(disk);
    expect(existsSync(w.path("packages/core/dist"))).toBe(false);
  });

  test("updates consumers in dependent projects when a referenced project's file is renamed", async () => {
    const w = await monorepo();
    const result = await analyze({
      project: w.path("packages/core/tsconfig.json"), root: w.root, file: w.path("packages/core/src/currency.ts"), operation: "rename-file",
    });
    expect(result.changes.map((change) => change.path)).toEqual([
      w.path("packages/app/src/main.ts"),
      w.path("packages/app/src/models.ts"),
      w.path("packages/core/src/Money.ts"),
      w.path("packages/core/src/currency.ts"),
    ].sort());
    expect(byPath(result.changes, w.path("packages/app/src/main.ts"))!.after).toContain("from '../../core/src/Money'");
  });

  test("rejects a move whose moved code would depend on the source project", async () => {
    const w = await monorepo();
    await expect(analyze({
      project: w.path("packages/app/tsconfig.json"), root: w.root, file: w.path("packages/app/src/models.ts"), operation: "move-type",
      typeName: "Cart", target: w.path("packages/core/src/Cart.ts"), targetProject: w.path("packages/core/tsconfig.json"),
    })).rejects.toThrow(/^INACCESSIBLE_DEPENDENCY: .*Cart\.ts.*models\.ts/);
  });

  test("rejects moving a used type into a project the consumer does not reference", async () => {
    const w = await monorepo({ "packages/core/src/format.ts": "import { Money } from './currency';\nexport const format = (money: Money) => (money.cents / 100).toFixed(2);\n" });
    await expect(analyze({
      project: w.path("packages/core/tsconfig.json"), root: w.root, file: w.path("packages/core/src/currency.ts"), operation: "move-type",
      typeName: "Money", target: w.path("packages/app/src/Money.ts"), targetProject: w.path("packages/app/tsconfig.json"),
    })).rejects.toThrow(/^INACCESSIBLE_DEPENDENCY:/);
    await expect(analyze({
      project: w.path("packages/core/tsconfig.json"), root: w.root, file: w.path("packages/core/src/format.ts"), operation: "move-type",
      target: w.path("packages/app/src/format.ts"), targetProject: w.path("packages/app/tsconfig.json"),
    })).rejects.toThrow(/^TYPE_NOT_FOUND:/);
  });

  test("rejects a move that would leave a project without files", async () => {
    const w = await workspace({
      "a/tsconfig.json": tsconfig(),
      "a/src/only.ts": "export interface Only { a: number }\n",
      "b/tsconfig.json": tsconfig(),
      "b/src/b.ts": "export const b = 1;\n",
    });
    await expect(analyze({
      project: w.path("a/tsconfig.json"), root: w.root, file: w.path("a/src/only.ts"), operation: "move-type",
      target: w.path("b/src/Only.ts"), targetProject: w.path("b/tsconfig.json"),
    })).rejects.toThrow(/^PROJECT_WOULD_BE_EMPTY:/);
  });

  test("rejects referenced projects without a dedicated declaration output directory", async () => {
    const w = await monorepo({ "packages/core/tsconfig.json": JSON.stringify({ compilerOptions: { composite: true }, include: ["src"] }) });
    await expect(analyze({
      project: w.path("packages/app/tsconfig.json"), root: w.root, file: w.path("packages/app/src/models.ts"), operation: "move-type",
      typeName: "Price", target: w.path("packages/core/src/Price.ts"), targetProject: w.path("packages/core/tsconfig.json"),
    })).rejects.toThrow(/^DECLARATION_OUTPUT_UNSUPPORTED:/);
  });

  test("rejects projects with incompatible module resolution and unconnected overlapping configs", async () => {
    const incompatible = await monorepo({ "packages/core/tsconfig.json": core({ moduleResolution: "node10", module: "commonjs" }) });
    await expect(analyze({
      project: incompatible.path("packages/app/tsconfig.json"), root: incompatible.root, file: incompatible.path("packages/app/src/models.ts"),
      operation: "move-type", typeName: "Price", target: incompatible.path("packages/core/src/Price.ts"),
      targetProject: incompatible.path("packages/core/tsconfig.json"),
    })).rejects.toThrow(/^PROJECT_OPTIONS_INCOMPATIBLE:/);

    const overlapping = await monorepo({ "tsconfig.json": JSON.stringify({ include: ["packages/*/src"] }) });
    await expect(analyze({
      project: overlapping.path("packages/core/tsconfig.json"), root: overlapping.root, file: overlapping.path("packages/core/src/currency.ts"),
      operation: "rename-file",
    })).rejects.toThrow(/^UNHANDLED_PROJECT_GRAPH:/);
  });
});

describe("TypeScript projects connected only by imports", () => {
  const tsc = resolve(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "typescript", "bin", "tsc");
  const plain = (extra: object = {}) => JSON.stringify({
    compilerOptions: { strict: true, module: "commonjs", target: "es2022", rootDir: "..", ...extra },
    include: ["**/*.ts"],
  });

  function run(args: string[], cwd: string): string {
    const result = spawnSync("node", args, { cwd, encoding: "utf8", timeout: 120_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`node ${args.join(" ")} failed: ${result.stdout}${result.stderr}`);
    return result.stdout;
  }

  async function apply(changes: FileChange[]) {
    for (const change of changes) {
      expect(await readFile(change.path, "utf8").catch(() => null)).toBe(change.before);
      if (change.after === null) await unlink(change.path);
      else {
        await mkdir(dirname(change.path), { recursive: true });
        await writeFile(change.path, change.after);
      }
    }
  }

  async function sourceAndTarget(source: object = {}, target: object = {}, types = "export class Widget { static value = 5; }\nexport class Other { static value = 2; }\n") {
    return workspace({
      "package.json": '{"type":"commonjs"}\n',
      "Source/tsconfig.json": plain({ outDir: "../dist/source", ...source }),
      "Source/types.ts": types,
      "Source/caller.ts": 'import { Widget, Other } from "./types";\nconsole.log(Widget.value + Other.value);\n',
      "Target/tsconfig.json": plain({ outDir: "../dist/target", ...target }),
      "Target/placeholder.ts": "export const placeholder = true;\n",
    });
  }

  test("moves a type into a plain project without references; both projects compile and the caller runs", async () => {
    const w = await sourceAndTarget();
    const disk = await listing(w.root);
    const result = await analyze({
      project: w.path("Source/tsconfig.json"), root: w.root, file: w.path("Source/types.ts"), operation: "move-type",
      typeName: "Widget", target: w.path("Target/Models/Widget.ts"), targetProject: w.path("Target/tsconfig.json"),
    });
    expect(await listing(w.root)).toEqual(disk);
    expect(result.changes.map((change) => change.path)).toEqual([w.path("Source/caller.ts"), w.path("Source/types.ts"), w.path("Target/Models/Widget.ts")]);
    expect(byPath(result.changes, w.path("Source/caller.ts"))!.after).toContain('import { Widget } from "../Target/Models/Widget";');
    expect(byPath(result.changes, w.path("Source/types.ts"))!.after).toBe("export class Other { static value = 2; }\n");
    expect(result.diagnosticsAfter).toEqual([]);

    await apply(result.changes);
    run([tsc, "--project", w.path("Source/tsconfig.json")], w.root);
    run([tsc, "--project", w.path("Target/tsconfig.json")], w.root);
    expect(run([w.path("dist/source/Source/caller.js")], w.root).trim()).toBe("7");
  });

  for (const source of [{ paths: { "@/*": ["./*"] } }, { paths: { "@/*": ["./*"] }, baseUrl: "." }]) {
    test(`move-type allows project-local resolution ${JSON.stringify(source)}`, async () => {
      const w = await sourceAndTarget(source);
      const result = await analyze({
        project: w.path("Source/tsconfig.json"), root: w.root, file: w.path("Source/types.ts"), operation: "move-type",
        typeName: "Widget", target: w.path("Target/Widget.ts"), targetProject: w.path("Target/tsconfig.json"),
      });
      expect(result.diagnosticsAfter).toEqual([]);
      expect(result.notes.join("\n")).toContain("affected file(s) across 2 project(s)");
      await apply(result.changes);
      run([tsc, "--project", w.path("Source/tsconfig.json")], w.root);
      run([tsc, "--project", w.path("Target/tsconfig.json")], w.root);
    });
  }

  for (const target of [{ jsx: "preserve" }, { module: "esnext" }, { moduleResolution: "bundler", module: "esnext" }, { allowImportingTsExtensions: true, noEmit: true }]) {
    test(`move-type rejects incompatible syntax or extension rules ${JSON.stringify(target)}`, async () => {
      const w = await sourceAndTarget({}, target);
      await expect(analyze({
        project: w.path("Source/tsconfig.json"), root: w.root, file: w.path("Source/types.ts"), operation: "move-type",
        typeName: "Widget", target: w.path("Target/Widget.ts"), targetProject: w.path("Target/tsconfig.json"),
      })).rejects.toThrow(/^PROJECT_OPTIONS_INCOMPATIBLE:/);
    });
  }

  test("move-type rejects aliases that resolve to a different compatible declaration in the target", async () => {
    const paths = { paths: { "@/*": ["./*"] } };
    const w = await sourceAndTarget(paths, paths,
      'import type { Dependency } from "@/dependency";\nexport interface Widget { value: Dependency }\nexport class Other { static value = 2; }\n');
    for (const project of ["Source", "Target"]) await writeFile(w.path(`${project}/dependency.ts`), "export interface Dependency { value: number }\n");
    await writeFile(w.path("Source/caller.ts"), "export {};\n");
    await expect(analyze({
      project: w.path("Source/tsconfig.json"), root: w.root, file: w.path("Source/types.ts"), operation: "move-type",
      typeName: "Widget", target: w.path("Target/Widget.ts"), targetProject: w.path("Target/tsconfig.json"),
    })).rejects.toThrow(/^REFERENCES_NOT_PRESERVED:/);
  });

  test("move-type reports target alias resolution failures as new diagnostics", async () => {
    const w = await sourceAndTarget({ paths: { "@/*": ["./*"] } }, {},
      'import type { Dependency } from "@/dependency";\nexport interface Widget { value: Dependency }\nexport class Other { static value = 2; }\n');
    await writeFile(w.path("Source/dependency.ts"), "export interface Dependency { value: number }\n");
    await writeFile(w.path("Source/caller.ts"), "export {};\n");
    await expect(analyze({
      project: w.path("Source/tsconfig.json"), root: w.root, file: w.path("Source/types.ts"), operation: "move-type",
      typeName: "Widget", target: w.path("Target/Widget.ts"), targetProject: w.path("Target/tsconfig.json"),
    })).rejects.toThrow(/^NEW_DIAGNOSTICS: .*TS2307/);
  });

  test("still rejects plain-project moves that need references, close a cycle, break rootDir or shift outputs", async () => {
    const request = (w: Awaited<ReturnType<typeof sourceAndTarget>>, typeName = "Widget"): RefactorRequest => ({
      project: w.path("Source/tsconfig.json"), root: w.root, file: w.path("Source/types.ts"), operation: "move-type",
      typeName, target: w.path(`Target/Models/${typeName}.ts`), targetProject: w.path("Target/tsconfig.json"),
    });
    const composite = await sourceAndTarget({}, { composite: true, rootDir: "." });
    await expect(analyze(request(composite))).rejects.toThrow(/^INACCESSIBLE_DEPENDENCY: .*caller\.ts.*composite projects require project references/);

    const cyclic = await sourceAndTarget({}, {}, "export class Other { static value = 2; }\nexport class Widget { value() { return Other.value + 3; } }\n");
    await expect(analyze(request(cyclic))).rejects.toThrow(/^PROJECT_DEPENDENCY_CYCLE: .*source\/tsconfig\.json -> .*target\/tsconfig\.json/i);

    const narrowRoot = await sourceAndTarget({ rootDir: "." });
    await expect(analyze(request(narrowRoot))).rejects.toThrow(/^NEW_DIAGNOSTICS: TS6059 /);

    const computedRoot = await sourceAndTarget({ rootDir: undefined });
    await expect(analyze(request(computedRoot))).rejects.toThrow(/^OUTPUT_LAYOUT_CHANGED: .*Source\/tsconfig\.json/);
    for (const w of [composite, cyclic, narrowRoot, computedRoot]) expect(await readFile(w.path("Source/types.ts"), "utf8")).toContain("class Widget");
  });

  async function library(files: Record<string, string> = {}) {
    return workspace({
      "package.json": '{"type":"commonjs"}\n',
      "lib/tsconfig.json": plain({ outDir: "../dist/lib" }).replace('"**/*.ts"', '"src"'),
      "lib/src/types.ts": "export class Widget { static value = 5; }\nexport class Other { static value = 2; }\n",
      "lib/src/use.ts": 'import { Other } from "./types";\nexport const other = Other.value;\n',
      "app/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "commonjs", target: "es2022", rootDir: "..", outDir: "../dist/app" }, files: ["main.ts"] }),
      "app/main.ts": 'import { Widget, Other } from "../lib/src/types";\nconsole.log(Widget.value + Other.value);\n',
      ...files,
    });
  }

  test("rename-file updates a disconnected project whose only root imports the renamed file", async () => {
    const w = await library({ "lib/src/types.ts": "export class Widget { static value = 5; }\nexport const Other = { value: 2 };\n" });
    const result = await analyze({ project: w.path("lib/tsconfig.json"), root: w.root, file: w.path("lib/src/types.ts"), operation: "rename-file" });
    expect(byPath(result.changes, w.path("app/main.ts"))!.after).toBe('import { Widget, Other } from "../lib/src/Widget";\nconsole.log(Widget.value + Other.value);\n');
    expect(result.notes.join("\n")).toContain("Included app/tsconfig.json because its program imports lib/src/types.ts");

    await apply(result.changes);
    run([tsc, "--project", w.path("lib/tsconfig.json")], w.root);
    run([tsc, "--project", w.path("app/tsconfig.json")], w.root);
    expect(run([w.path("dist/app/app/main.js")], w.root).trim()).toBe("7");
  });

  test("move-type updates a disconnected caller and rejects one it cannot plan for", async () => {
    const w = await library();
    const result = await analyze({
      project: w.path("lib/tsconfig.json"), root: w.root, file: w.path("lib/src/types.ts"), operation: "move-type",
      typeName: "Widget", target: w.path("lib/src/models/Widget.ts"),
    });
    const main = byPath(result.changes, w.path("app/main.ts"))!.after!;
    expect(main).toContain('import { Other } from "../lib/src/types";');
    expect(main).toContain('import { Widget } from "../lib/src/models/Widget";');
    await apply(result.changes);
    run([tsc, "--project", w.path("app/tsconfig.json")], w.root);
    expect(run([w.path("dist/app/app/main.js")], w.root).trim()).toBe("7");

    const incompatible = await library({
      "app/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "nodenext", target: "es2022" }, files: ["main.ts"] }),
    });
    await expect(analyze({
      project: incompatible.path("lib/tsconfig.json"), root: incompatible.root, file: incompatible.path("lib/src/types.ts"), operation: "move-type",
      typeName: "Widget", target: incompatible.path("lib/src/models/Widget.ts"),
    })).rejects.toThrow(/^PROJECT_OPTIONS_INCOMPATIBLE: .*app\/tsconfig\.json/);
    await expect(analyze({
      project: incompatible.path("lib/tsconfig.json"), root: incompatible.root, file: incompatible.path("lib/src/types.ts"), operation: "rename-file", typeName: "Other",
    })).rejects.toThrow(/^PROJECT_OPTIONS_INCOMPATIBLE:/);
  });
});

describe("TypeScript variant configs", () => {
  const tsc = resolve(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "typescript", "bin", "tsc");
  const options = { strict: true, module: "commonjs", target: "es2022" };

  async function apply(changes: FileChange[]) {
    for (const change of changes) {
      expect(await readFile(change.path, "utf8").catch(() => null)).toBe(change.before);
      if (change.after === null) await unlink(change.path);
      else {
        await mkdir(dirname(change.path), { recursive: true });
        await writeFile(change.path, change.after);
      }
    }
  }

  function build(config: string, cwd: string) {
    const result = spawnSync("node", [tsc, "--project", config], { cwd, encoding: "utf8", timeout: 120_000 });
    expect(`${result.stdout}${result.stderr}`).toBe("");
    expect(result.status).toBe(0);
  }

  async function project(files: Record<string, string | undefined> = {}) {
    const all: Record<string, string | undefined> = {
      "package.json": '{"type":"commonjs"}\n',
      "tsconfig.base.json": JSON.stringify({ compilerOptions: options }),
      "tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions: { noEmit: true }, include: ["**/*.ts"] }),
      "tsconfig.build.json": JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { noEmit: false, outDir: "dist", rootDir: "." }, files: ["Wrong.ts"], include: [] }, null, 2),
      "Wrong.ts": "export class Widget { static value = 7; }\n",
      "caller.ts": 'import { Widget } from "./Wrong";\nconsole.log(Widget.value);\n',
      ...files,
    };
    return workspace(Object.fromEntries(Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== undefined)));
  }

  test("rename-file updates a named build config whose files list names the renamed file", async () => {
    const w = await project();
    const result = await analyze({ project: w.path("tsconfig.json"), root: w.root, file: w.path("Wrong.ts"), operation: "rename-file" });
    expect(JSON.parse(byPath(result.changes, w.path("tsconfig.build.json"))!.after!).files).toEqual(["Widget.ts"]);
    expect(byPath(result.changes, w.path("caller.ts"))!.after).toContain('from "./Widget"');
    expect(byPath(result.changes, w.path("tsconfig.base.json"))).toBeUndefined();
    expect(result.notes.join("\n")).toContain("Updated and validated tsconfig.build.json");
    await apply(result.changes);
    build(w.path("tsconfig.json"), w.root);
    build(w.path("tsconfig.build.json"), w.root);
  });

  test("move-type of a sole type retargets a named build config's files list to the new file", async () => {
    const w = await project();
    const result = await analyze({
      project: w.path("tsconfig.json"), root: w.root, file: w.path("Wrong.ts"), operation: "move-type",
      typeName: "Widget", target: w.path("models/Widget.ts"),
    });
    expect(byPath(result.changes, w.path("Wrong.ts"))!.after).toBeNull();
    expect(JSON.parse(byPath(result.changes, w.path("tsconfig.build.json"))!.after!).files).toEqual(["models/Widget.ts"]);
    expect(byPath(result.changes, w.path("tsconfig.json"))).toBeUndefined();
    await apply(result.changes);
    build(w.path("tsconfig.json"), w.root);
    build(w.path("tsconfig.build.json"), w.root);
  });

  test("move-type adds a kept source's new sibling file to a build config that lists the source", async () => {
    const w = await project({ "Wrong.ts": "export class Widget { static value = 7; }\nexport class Other {}\n" });
    const result = await analyze({
      project: w.path("tsconfig.json"), root: w.root, file: w.path("Wrong.ts"), operation: "move-type",
      typeName: "Widget", target: w.path("models/Widget.ts"),
    });
    expect(JSON.parse(byPath(result.changes, w.path("tsconfig.build.json"))!.after!).files).toEqual(["Wrong.ts", "models/Widget.ts"]);
    await apply(result.changes);
    build(w.path("tsconfig.build.json"), w.root);
  });

  test("validates variants that compile the file through include and rejects ones it cannot plan for", async () => {
    const included = await project({
      "tsconfig.build.json": JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { noEmit: false, outDir: "dist", rootDir: "." }, exclude: ["dist"] }),
    });
    const result = await analyze({ project: included.path("tsconfig.json"), root: included.root, file: included.path("Wrong.ts"), operation: "rename-file" });
    expect(result.notes.join("\n")).toContain("Updated and validated tsconfig.build.json");
    await apply(result.changes);
    build(included.path("tsconfig.build.json"), included.root);

    const incompatible = await project({
      "tsconfig.build.json": JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { module: "esnext", moduleResolution: "bundler" }, include: ["*.ts"] }),
    });
    await expect(analyze({ project: incompatible.path("tsconfig.json"), root: incompatible.root, file: incompatible.path("Wrong.ts"), operation: "rename-file" }))
      .rejects.toThrow(/^PROJECT_OPTIONS_INCOMPATIBLE: .*tsconfig\.build\.json/);

    const elsewhere = await project({
      "tsconfig.build.json": undefined,
      "build/tsconfig.release.json": JSON.stringify({ extends: "../tsconfig.json", files: ["../Wrong.ts"], include: [] }),
    });
    await expect(analyze({ project: elsewhere.path("tsconfig.json"), root: elsewhere.root, file: elsewhere.path("Wrong.ts"), operation: "rename-file" }))
      .rejects.toThrow(/^UNHANDLED_PROJECT_GRAPH: .*tsconfig\.release\.json/);
  });
});
