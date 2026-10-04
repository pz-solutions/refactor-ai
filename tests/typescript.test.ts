import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { analyze } from "../src/backends/typescript";

const temporaryProjects: string[] = [];

async function project(files: Record<string, string>, compilerOptions: object = {}) {
  const root = await mkdtemp(join(tmpdir(), "refactor-ai-typescript-"));
  temporaryProjects.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
  }
  const config = join(root, "tsconfig.json");
  await writeFile(config, JSON.stringify({ compilerOptions, include: ["src/**/*"] }));
  return { root, config, file: (relativePath: string) => join(root, relativePath) };
}

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("TypeScript backend", () => {
  test("renames a symbol across aliases and shorthand without writing source files", async () => {
    const p = await project({
      "src/model.ts": "export const oldName = 1;\nexport const value = { oldName };\n",
      "src/use.ts": "import { oldName as local } from './model';\nexport { oldName as publicName } from './model';\nconsole.log(local);\n",
    });
    const source = await readFile(p.file("src/model.ts"), "utf8");

    const result = await analyze({
      project: p.config,
      root: p.root,
      file: p.file("src/model.ts"),
      operation: "rename",
      position: source.indexOf("oldName"),
      newName: "newName",
    });

    expect(result.changes).toEqual([
      {
        path: p.file("src/model.ts"),
        before: source,
        after: "export const newName = 1;\nexport const value = { oldName: newName };\n",
      },
      {
        path: p.file("src/use.ts"),
        before: "import { oldName as local } from './model';\nexport { oldName as publicName } from './model';\nconsole.log(local);\n",
        after: "import { newName as local } from './model';\nexport { newName as publicName } from './model';\nconsole.log(local);\n",
      },
    ]);
    expect(await readFile(p.file("src/model.ts"), "utf8")).toBe(source);
    expect(result.backend).toBe("typescript");
    expect(result.version).toBe("5.9.3");
  });

  test("rejects a rename that introduces a same-scope collision", async () => {
    const p = await project({ "src/a.ts": "const first = 1;\nconst second = 2;\nconsole.log(first, second);\n" });
    const source = await readFile(p.file("src/a.ts"), "utf8");

    await expect(analyze({
      project: p.config,
      root: p.root,
      file: p.file("src/a.ts"),
      operation: "rename",
      position: source.indexOf("first"),
      newName: "second",
    })).rejects.toThrow(/^RENAME_CONFLICT:/);
    expect(await readFile(p.file("src/a.ts"), "utf8")).toBe(source);
  });

  test("rejects renaming an outer binding to a shadowing inner name", async () => {
    const source = "const first = 1;\n{ const second = 2; console.log(first, second); }\n";
    const p = await project({ "src/a.ts": source });

    await expect(analyze({
      project: p.config,
      root: p.root,
      file: p.file("src/a.ts"),
      operation: "rename",
      position: source.indexOf("first"),
      newName: "second",
    })).rejects.toThrow(/^RENAME_CONFLICT:/);
    expect(await readFile(p.file("src/a.ts"), "utf8")).toBe(source);
  });

  test("rejects renaming an inner binding when it would capture unrelated uses", async () => {
    const source = "const second = 2;\n{ const first = 1; console.log(first, second); }\n";
    const p = await project({ "src/a.ts": source });

    await expect(analyze({
      project: p.config,
      root: p.root,
      file: p.file("src/a.ts"),
      operation: "rename",
      position: source.indexOf("first"),
      newName: "second",
    })).rejects.toThrow(/^RENAME_CONFLICT:/);
    expect(await readFile(p.file("src/a.ts"), "utf8")).toBe(source);
  });

  test("sorts imports without removing unused bindings or side-effect imports", async () => {
    const source = [
      "import { zebra } from './zebra';",
      "import './setup';",
      "import { alpha } from './alpha';",
      "console.log(alpha);",
      "",
    ].join("\n");
    const p = await project({
      "src/a.ts": source,
      "src/alpha.ts": "export const alpha = 1;\n",
      "src/zebra.ts": "export const zebra = 2;\n",
      "src/setup.ts": "console.log('setup');\n",
    });

    const result = await analyze({
      project: p.config,
      root: p.root,
      file: p.file("src/a.ts"),
      operation: "imports",
      mode: "sort",
    });

    const after = result.changes[0]!.after!;
    expect(after.indexOf("'./alpha'")).toBeLessThan(after.indexOf("'./setup'"));
    expect(after.indexOf("'./setup'")).toBeLessThan(after.indexOf("'./zebra'"));
    expect(after).toContain("{ zebra }");
    expect(after).toContain("import './setup';");
  });

  test("removes only unused imports when explicitly requested and preserves side effects", async () => {
    const source = "import { used, unused } from './values';\nimport './setup';\nconsole.log(used);\n";
    const p = await project({
      "src/a.ts": source,
      "src/values.ts": "export const used = 1; export const unused = 2;\n",
      "src/setup.ts": "console.log('setup');\n",
    });

    const result = await analyze({
      project: p.config,
      root: p.root,
      file: p.file("src/a.ts"),
      operation: "imports",
      mode: "remove-unused",
    });

    expect(result.changes[0]!.after).toBe("import { used } from './values';\nimport './setup';\nconsole.log(used);\n");
    expect(await readFile(p.file("src/a.ts"), "utf8")).toBe(source);
  });

  test("extracts and semantically names a variable at the selected expression", async () => {
    const source = "export function total(base: number) {\n  return base + 10;\n}\n";
    const p = await project({ "src/a.ts": source }, { strict: true });
    const start = source.indexOf("base + 10");

    const result = await analyze({
      project: p.config,
      root: p.root,
      file: p.file("src/a.ts"),
      operation: "extract-variable",
      position: start,
      end: start + "base + 10".length,
      newName: "subtotal",
    });

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.after).toContain("const subtotal = base + 10;");
    expect(result.changes[0]!.after).toContain("return subtotal;");
    expect(await readFile(p.file("src/a.ts"), "utf8")).toBe(source);
  });

  test("extracts and semantically names a function from selected statements", async () => {
    const source = "export function run(value: number) {\n  const doubled = value * 2;\n  console.log(doubled);\n}\n";
    const p = await project({ "src/a.ts": source }, { strict: true });
    const start = source.indexOf("  const doubled");
    const end = source.indexOf("\n}");

    const result = await analyze({
      project: p.config,
      root: p.root,
      file: p.file("src/a.ts"),
      operation: "extract-function",
      position: start,
      end,
      newName: "logDouble",
    });

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.after).toContain("logDouble();");
    expect(result.changes[0]!.after).toContain("function logDouble()");
    expect(result.changes[0]!.after).toContain("const doubled = value * 2;");
    expect(await readFile(p.file("src/a.ts"), "utf8")).toBe(source);
  });

  test("rejects an invalid extraction range before asking for a refactor", async () => {
    const source = "export const value = 1 + 2;\n";
    const p = await project({ "src/a.ts": source });
    const position = source.indexOf("1 + 2");

    await expect(analyze({
      project: p.config,
      root: p.root,
      file: p.file("src/a.ts"),
      operation: "extract-variable",
      position,
      end: position,
      newName: "sum",
    })).rejects.toThrow(/^INVALID_RANGE:/);
    expect(await readFile(p.file("src/a.ts"), "utf8")).toBe(source);
  });

  test("extracts a variable from JavaScript through the pinned extract action", async () => {
    const source = "export function total(base) {\n  return base + 10;\n}\n";
    const p = await project({ "src/a.js": source }, { allowJs: true, checkJs: true, noEmit: true });
    const position = source.indexOf("base + 10");

    const result = await analyze({
      project: p.config,
      root: p.root,
      file: p.file("src/a.js"),
      operation: "extract-variable",
      position,
      end: position + "base + 10".length,
      newName: "subtotal",
    });

    expect(result.changes[0]!.after).toContain("const subtotal = base + 10;");
    expect(result.changes[0]!.after).toContain("return subtotal;");
    expect(result.notes).toHaveLength(1);
    expect(await readFile(p.file("src/a.js"), "utf8")).toBe(source);
  });

  test("formats through the language service and returns a whole-file plan", async () => {
    const source = "export function add(a:number,b:number){return a+b}\n";
    const p = await project({ "src/a.ts": source });

    const result = await analyze({
      project: p.config,
      root: p.root,
      file: p.file("src/a.ts"),
      operation: "format",
    });

    expect(result.changes).toEqual([{
      path: p.file("src/a.ts"),
      before: source,
      after: "export function add(a: number, b: number) { return a + b; }\n",
    }]);
    expect(result.diagnosticsAfter).toEqual([]);
  });

  test("preserves repeated identical diagnostics for multiset validation", async () => {
    const source = "const first: string=1;\nconst second: string=2;\n";
    const p = await project({ "src/a.ts": source }, { strict: true });

    const result = await analyze({
      project: p.config,
      root: p.root,
      file: p.file("src/a.ts"),
      operation: "format",
    });

    expect(result.diagnosticsBefore.filter((item) => item.code === "TS2322")).toHaveLength(2);
    expect(result.diagnosticsAfter.filter((item) => item.code === "TS2322")).toHaveLength(2);
  });

  test("rejects projects that import ordinary user source from outside root", async () => {
    const container = await mkdtemp(join(tmpdir(), "refactor-ai-typescript-scope-"));
    temporaryProjects.push(container);
    const root = join(container, "project");
    const source = "import { shared } from '../../shared';\nconsole.log(shared);\n";
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(container, "shared.ts"), "export const shared = 1;\n");
    await writeFile(join(root, "src/a.ts"), source);
    const config = join(root, "tsconfig.json");
    await writeFile(config, JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*"] }));

    await expect(analyze({
      project: config,
      root,
      file: join(root, "src/a.ts"),
      operation: "format",
    })).rejects.toThrow(/^PROJECT_SCOPE_INCOMPLETE:/);
    expect(await readFile(join(root, "src/a.ts"), "utf8")).toBe(source);
  });

  test("allows declaration dependencies outside root", async () => {
    const container = await mkdtemp(join(tmpdir(), "refactor-ai-typescript-declaration-"));
    temporaryProjects.push(container);
    const root = join(container, "project");
    const source = "import { shared } from '../../shared';\nconsole.log(shared);\n";
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(container, "shared.d.ts"), "export declare const shared: number;\n");
    await writeFile(join(root, "src/a.ts"), source);
    const config = join(root, "tsconfig.json");
    await writeFile(config, JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*"] }));

    const result = await analyze({
      project: config,
      root,
      file: join(root, "src/a.ts"),
      operation: "format",
    });

    expect(result.changes).toEqual([]);
    expect(result.diagnosticsAfter).toEqual([]);
  });

  test("loads JavaScript from a JSONC config and reports the dynamic-language limitation", async () => {
    const p = await project({
      "src/a.js": "/** @type {number} */\nexport const count = 1;\nconsole.log(count);\n",
    }, { allowJs: true, checkJs: true, noEmit: true });
    await writeFile(p.config, "{\n  // JavaScript project\n  \"compilerOptions\": { \"allowJs\": true, \"checkJs\": true, \"noEmit\": true },\n  \"include\": [\"src/**/*\"],\n}\n");
    const source = await readFile(p.file("src/a.js"), "utf8");

    const result = await analyze({
      project: p.config,
      root: p.root,
      file: p.file("src/a.js"),
      operation: "rename",
      position: source.indexOf("count"),
      newName: "total",
    });

    expect(result.changes[0]!.after).toContain("export const total = 1;");
    expect(result.changes[0]!.after).toContain("console.log(total);");
    expect(result.notes).toHaveLength(1);
  });
});
