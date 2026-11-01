import ts from "typescript";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRefactorApi } from "../src/api";
import { loadBackend } from "../src/backends/load";
import { ImportSet, render } from "../src/backends/typescript-port-route-config";
import { runCli } from "../src/cli-core";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const options = { strict: true, target: "es2022", module: "esnext", moduleResolution: "bundler", jsx: "preserve", skipLibCheck: true, noEmit: true };
const config = (extra: object = {}, include = ["src", "../../types"]) => JSON.stringify({ compilerOptions: { ...options, ...extra }, include }, null, 2);
const route = "apps/web/src/app/[locale]/items/[code]";

/** A Next app, a feature package and a Start app sharing a fake data layer, mirroring uber-platform's shape. */
const base: Record<string, string> = {
  "package.json": '{"private":true,"workspaces":["apps/*","packages/*"]}',
  "types/jsx.d.ts": "declare namespace JSX { interface IntrinsicElements { [name: string]: any } interface Element {} }\n",
  "packages/data/package.json": '{"name":"@scope/data","exports":{".":"./src/index.ts"}}',
  "packages/data/tsconfig.json": config(),
  "packages/data/src/index.ts": [
    "export interface Ref<A, R> { __args?: A; __result?: R }",
    "export type FunctionArgs<F> = F extends Ref<infer A, unknown> ? A : never;",
    "export type FunctionReturnType<F> = F extends Ref<unknown, infer R> ? R : never;",
    "export interface Preloaded<F> { __ref: F }",
    "const ref = <A, R>(): Ref<A, R> => ({});",
    "export const api = { items: { list: ref<{ year?: number }, string[]>(), get: ref<{ code: string }, { name: string } | null>() } };",
    "export async function preloadQuery<F>(fn: F, _args: FunctionArgs<F>): Promise<Preloaded<F>> { return { __ref: fn }; }",
    "export function usePreloaded<F>(_preloaded: Preloaded<F>): { data: FunctionReturnType<F> | undefined } { return { data: undefined }; }",
    "export function queryOptions<F>(fn: F, args: FunctionArgs<F>) { return { fn, args }; }",
    "export function useQueryData<T>(_options: T): unknown { return undefined; }",
    "",
  ].join("\n"),
  "packages/feature/package.json": '{\n  "name": "@scope/feature",\n  "dependencies": { "@scope/data": "workspace:*" },\n  "exports": {\n    "./*": "./src/*.tsx"\n  }\n}\n',
  "packages/feature/tsconfig.json": config(),
  "packages/feature/src/existing.tsx": "export const existing = 1;\n",
  "apps/web/package.json": '{"name":"@scope/web","dependencies":{"@scope/feature":"workspace:*","@scope/data":"workspace:*"}}',
  "apps/web/tsconfig.json": config({ paths: { "@/*": ["./src/*"] } }),
  "apps/web/src/server/clock.ts": "export async function getNow() { return new Date(); }\nexport async function session() { return { user: 'u' }; }\n",
  "apps/web/src/adapters/nav.ts": "export function useNav() { return 'next-nav'; }\n",
  [`${route}/_hooks/preload-item.ts`]: 'import { api, preloadQuery } from "@scope/data";\nexport async function preloadItem(code: string) {\n  return preloadQuery(api.items.get, { code });\n}\n',
  [`${route}/page.tsx`]: [
    'import { api, preloadQuery } from "@scope/data";',
    'import { getNow } from "@/server/clock";',
    'import { preloadItem } from "./_hooks/preload-item";',
    'import { ItemView } from "./item-view";',
    "",
    "export default async function ItemPage({ params }: { params: Promise<{ locale: string; code: string }> }) {",
    "  const { code } = await params;",
    "  const now = await getNow();",
    "  const [preloadedItem, preloadedList] = await Promise.all([",
    "    preloadItem(code),",
    "    preloadQuery(api.items.list, { year: now.getFullYear() }),",
    "  ]);",
    '  let mode = "view";',
    "  return <ItemView preloadedItem={preloadedItem} preloadedList={preloadedList} title=\"Item\" mode={mode} />;",
    "}",
    "",
  ].join("\n"),
  [`${route}/item-view.tsx`]: [
    'import { usePreloaded, type Preloaded } from "@scope/data";',
    'import type { api } from "@scope/data";',
    'import { label } from "./label";',
    "",
    "interface ItemViewProps {",
    "  preloadedItem: Preloaded<typeof api.items.get>;",
    "  preloadedList: Preloaded<typeof api.items.list>;",
    "  title: string;",
    "  mode?: string;",
    "  code: string;",
    "  nav: string;",
    "}",
    "",
    "export function ItemView({ preloadedItem, preloadedList, title, mode, code, nav }: ItemViewProps) {",
    "  const { data: item } = usePreloaded(preloadedItem);",
    "  const list = usePreloaded<string[]>(preloadedList).data;",
    "  return <div>{title}{mode}{code}{nav}{label(item?.name)}{list?.length}</div>;",
    "}",
    "",
  ].join("\n"),
  [`${route}/label.ts`]: "export const label = (value?: string) => value ?? '-';\n",
  [`${route}/edit/page.tsx`]: "export default function EditPage() { return <div />; }\n",
  "node_modules/react/package.json": '{"name":"react","types":"index.d.ts"}',
  "node_modules/react/index.d.ts": "export type ComponentProps<T> = T extends (props: infer P) => unknown ? P : never;\n",
  "apps/start/package.json": '{"name":"@scope/start","dependencies":{"@scope/feature":"workspace:*","@scope/data":"workspace:*"}}',
  "apps/start/tsconfig.json": config(),
  "apps/start/src/router.ts": [
    "export function createFileRoute(_id: string) {",
    "  return (options: { loader?: (input: any) => unknown; component: () => unknown }) => ({ options, useLoaderData: (): any => ({}), useParams: (): any => ({}) });",
    "}",
    "",
  ].join("\n"),
  "apps/start/src/routes/__root.tsx": "export const root = 1;\n",
  "apps/start/node_modules/fake-route-generator/package.json": '{"name":"fake-route-generator","main":"index.mjs"}',
  "apps/start/node_modules/fake-route-generator/index.mjs": [
    'import { readdirSync, writeFileSync } from "node:fs";',
    "export function getConfig(inline) { return { ...inline }; }",
    "export class Generator {",
    "  constructor({ config }) { this.config = config; }",
    "  async run() {",
    "    const files = readdirSync(this.config.routesDirectory).sort();",
    "    writeFileSync(this.config.generatedRouteTree, `export const routeFiles = ${JSON.stringify(files)};\\n`);",
    "  }",
    "}",
    "",
  ].join("\n"),
  ".refactor-ai/port-route.json": JSON.stringify({
    next: { appDirectory: "apps/web/src/app/[locale]", preloadFunctions: ["preloadQuery"], adapterFile: "{{route}}-adapter.tsx" },
    start: {
      project: "apps/start/tsconfig.json", routes: "apps/start/src/routes",
      routeTree: { generator: "fake-route-generator", configDirectory: "apps/start", file: "apps/start/src/routeTree.gen.ts" },
      imports: ['import { createFileRoute } from "../router";'],
    },
    translate: { "await params": "params", "await getNow()": "context.now" },
    data: { hook: { module: "@scope/data", name: "usePreloaded" }, prop: "initial{{Name}}",
      type: { imports: ['import type { FunctionReturnType } from "@scope/data";'], value: "FunctionReturnType<typeof {{query}}> | undefined" }, typeArgument: "{{type}} | undefined" },
    ports: { nav: { next: { imports: ['import { useNav } from "@/adapters/nav";'], setup: ["const nav = useNav();"], value: "nav" }, start: { value: '"start-nav"' } } },
    params: { next: { value: '"{{name}}-from-next"' }, start: { setup: ["const { {{name}} } = Route.useParams();"], value: "{{name}}" } },
    snippets: {
      nextHookType: "Awaited<ReturnType<typeof {{hook}}>>",
      nextDirectType: { imports: ['import type { Preloaded } from "@scope/data";'], value: "Preloaded<typeof {{query}}>" },
      nextData: { imports: ['import { usePreloaded } from "@scope/data";'], setup: ["const {{name}} = usePreloaded({{prop}}).data;"], value: "{{name}}" },
      startQuery: { imports: ['import { queryOptions } from "@scope/data";', 'import type { FunctionArgs } from "@scope/data";'], value: "const {{name}}Query = (args: FunctionArgs<typeof {{query}}>) => queryOptions({{query}}, args);" },
      startPrefetch: "context.prefetch({{name}}Query({{args}}))",
      startData: { imports: ['import { useQueryData } from "@scope/data";'], setup: ["const {{name}} = useQueryData({{name}}Query({{args}})) as any;"], value: "{{name}}" },
      startLoader: "async ({{loaderArgs}}) => {\n  {{statements}}\n  await Promise.all([\n    {{prefetches}},\n  ]);\n  return { {{returns}} };\n}",
    },
    afterApply: ["regenerate routes"],
    templates: { nextAdapter: "port-route/next-adapter.tsx.tpl", startRoute: "port-route/start-route.tsx.tpl" },
  }, null, 2),
  ".refactor-ai/port-route/next-adapter.tsx.tpl": '"use client";\n\n{{imports}}\n\n{{export}} {{name}}({{params}}{{propsType}}) {\n  {{setup}}\n  {{todos}}\n  return (\n    {{view}}\n  );\n}\n',
  ".refactor-ai/port-route/start-route.tsx.tpl": '{{imports}}\n\n{{queries}}\n\nexport const Route = createFileRoute("{{id}}")({\n  {{searchDeps}}\n  loader: {{loader}},\n  component: {{component}},\n});\n\nfunction {{component}}() {\n  {{setup}}\n  {{todos}}\n  return (\n    <main>\n      {{view}}\n    </main>\n  );\n}\n',
};

async function workspace(overrides: Record<string, string | null> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "refactor-ai-port-route-")));
  roots.push(root);
  for (const [file, contents] of Object.entries({ ...base, ...overrides })) {
    if (contents === null) continue;
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), contents);
  }
  await mkdir(join(root, "node_modules/@scope"), { recursive: true });
  for (const name of ["data", "feature"]) await symlink(`../../packages/${name}`, join(root, "node_modules/@scope", name), "dir");
  return { root, path: (file: string) => join(root, file) };
}

function request(w: Awaited<ReturnType<typeof workspace>>, extra: object = {}) {
  return {
    operation: "port-route" as const, root: w.root, project: w.path("apps/web/tsconfig.json"), targetProject: w.path("packages/feature/tsconfig.json"),
    file: w.path(route), target: w.path("packages/feature/src/items"), ...extra,
  };
}
const after = (plan: { changes: { path: string; after: string | null }[] }, path: string) => plan.changes.find(change => change.path === path)?.after;

describe("port-route", () => {
  for (const [literal, expected] of [
    [String.raw`"A &amp; B &#65; &#x42; &quot; \n C:\temp"`, String.raw`A & B A B " \n C:\temp`],
    ["'single &apos; quote'", "single ' quote"],
    ['"first\n  second\tline"', "first\n  second\tline"],
    ['""', ""],
  ]) test(`preserves JSX attribute value ${JSON.stringify(literal)} in Start routes`, async () => {
    const w = await workspace({
      [`${route}/page.tsx`]: base[`${route}/page.tsx`]!.replace('title="Item"', `title=${literal}`),
    });
    const plan = await createRefactorApi({ loadBackend }).plan(request(w));
    expect(plan.validation.status).toBe("passed");
    const start = after(plan, w.path("apps/start/src/routes/items.$code.index.tsx"))!;
    const emitted = ts.transpileModule(start, { fileName: "route.tsx", compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ESNext } }).outputText;
    const source = ts.createSourceFile("route.js", emitted, ts.ScriptTarget.Latest, true);
    const titles: string[] = [];
    const strings = new Map<string, string>();
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteral(node.initializer)) strings.set(node.name.text, node.initializer.text);
      ts.forEachChild(node, collect);
    };
    collect(source);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === "title" && ts.isCallExpression(node.parent.parent)) {
        if (ts.isStringLiteral(node.initializer)) titles.push(node.initializer.text);
        else if (ts.isIdentifier(node.initializer)) titles.push(strings.get(node.initializer.text)!);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(titles).toEqual([expected!]);
  });

  test("retro: parameter snippets share one hook call and generated files use a configured formatter", async () => {
    const nested = `${route}/[unitCode]`;
    const configured = JSON.parse(base[".refactor-ai/port-route.json"]!);
    configured.params.next = { setup: ["const { {{name}} } = useParams<{ {{name}}: string }>();"], imports: ['import { useParams } from "next/navigation";'], value: "{{name}}" };
    configured.formatCommand = [process.execPath, "-e", 'process.stdout.write("// formatted " + process.argv[1].split("/").at(-1) + "\\n" + require("node:fs").readFileSync(0, "utf8"))', "{{file}}"];
    const w = await workspace({
      ".refactor-ai/port-route.json": JSON.stringify(configured),
      "node_modules/next/package.json": '{"name":"next","exports":{"./navigation":"./navigation.d.ts"}}',
      "node_modules/next/navigation.d.ts": 'export function useParams<T>(): T;',
      [`${nested}/page.tsx`]: 'import { UnitView } from "./unit-view"; export default function Page() { return <UnitView />; }',
      [`${nested}/unit-view.tsx`]: 'export function UnitView({ code, unitCode }: { code: string; unitCode: string }) { return <div>{code}{unitCode}</div>; }',
    });
    const api = createRefactorApi({ loadBackend });
    const plan = await api.plan(request(w, { file: w.path(nested) }));
    expect(plan.validation.status).toBe("passed");
    const adapter = after(plan, w.path(`${nested}/unit-adapter.tsx`))!;
    const start = after(plan, w.path("apps/start/src/routes/items.$code.$unitCode.tsx"))!;
    expect(adapter.match(/useParams</g)).toHaveLength(1);
    expect(adapter).toContain("const { code, unitCode }");
    expect(adapter).toContain("code: string; unitCode: string;");
    expect(start.match(/Route.useParams\(\)/g)).toHaveLength(1);
    expect(adapter).toStartWith("// formatted unit-adapter.tsx\n");
    expect(start).toStartWith("// formatted items.$code.$unitCode.tsx\n");
    await expect(readFile(w.path(`${nested}/unit-adapter.tsx`))).rejects.toThrow();
    expect((await api.plan(request(w, { file: w.path(nested) }))).id).toBe(plan.id);
    configured.formatCommand = [process.execPath, "-e", "process.exit(1)"];
    await writeFile(w.path(".refactor-ai/port-route.json"), JSON.stringify(configured));
    await expect(api.plan(request(w, { file: w.path(nested) }))).rejects.toThrow("PORT_ROUTE_FORMAT_FAILED");
  });

  test("retro: no-preload pages omit loaders and use the view name for dynamic routes", async () => {
    const w = await workspace({
      [`${route}/page.tsx`]: 'import { ItemView } from "./item-view"; export default function Page() { return <ItemView title="Item" />; }',
      [`${route}/item-view.tsx`]: 'export function ItemView({ title, code }: { title: string; code: string }) { return <div>{title}{code}</div>; }',
    });
    const plan = await createRefactorApi({ loadBackend }).plan(request(w));
    expect(plan.validation.status).toBe("passed");
    const start = after(plan, w.path("apps/start/src/routes/items.$code.index.tsx"))!;
    expect(start).not.toContain("loader:");
    expect(start).not.toContain("Promise.all([])");
    expect(start).toContain("function ItemPage()");
    expect(after(plan, w.path(`${route}/item-adapter.tsx`))).toBeString();
  });

  test("requires an explicit translation for effectful helper-local consts", async () => {
    const w = await workspace({
      "packages/data/src/index.ts": base["packages/data/src/index.ts"] + '\nexport async function getSnapshot() { return { code: "a", revision: "b" }; }',
      [`${route}/_hooks/preload-item.ts`]: 'import { api, preloadQuery, getSnapshot } from "@scope/data"; export async function preloadItem(_code: string) { const snapshot = await getSnapshot(); return preloadQuery(api.items.get, { code: snapshot.code + snapshot.revision }); }',
    });
    const plan = await createRefactorApi({ loadBackend }).plan(request(w));
    expect(plan.notes.some(note => note.includes("TODO(port-route)") && note.includes("helper-local initializer"))).toBe(true);
    const start = after(plan, w.path("apps/start/src/routes/items.$code.index.tsx"))!;
    expect(start).toContain("TODO(port-route): translate preloadedItem arguments");
    expect(start).not.toContain("getSnapshot()");
  });

  for (const [argument, expected] of [["", "fallback"], ["undefined", "fallback"], ['"given"', "given"], ["null", null]] as const) test(`preserves a helper default for ${argument}`, async () => {
    const w = await workspace({
      "packages/data/src/index.ts": base["packages/data/src/index.ts"]!.replace("ref<{ code: string }", "ref<{ code: string | null }"),
      [`${route}/page.tsx`]: base[`${route}/page.tsx`]!.replace("preloadItem(code)", `preloadItem(${argument})`),
      [`${route}/_hooks/preload-item.ts`]: 'import { api, preloadQuery } from "@scope/data"; export async function preloadItem(code: string | null = "fallback") { return preloadQuery(api.items.get, { code }); }',
    });
    const plan = await createRefactorApi({ loadBackend }).plan(request(w));
    expect(plan.validation.status).toBe("passed");
    const start = after(plan, w.path("apps/start/src/routes/items.$code.index.tsx"))!;
    const output = ts.transpileModule(start, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React }, fileName: "route.tsx" }).outputText;
    const exports: any = {};
    new Function("require", "exports", output)((module: string) => {
      if (module === "../router") return { createFileRoute: () => (options: unknown) => ({ options }) };
      if (module === "@scope/data") return { api: { items: { get: {}, list: {} } }, queryOptions: () => ({}) };
      return { ItemView: () => null };
    }, exports);
    const result = await exports.Route.options.loader({ context: { now: new Date(), prefetch: async () => {} }, params: { code: "route" } });
    expect(result.itemArgs.code).toBe(expected);
  });

  test("requires explicit translation when a supplied helper default argument may be undefined", async () => {
    const w = await workspace({
      "packages/data/src/index.ts": base["packages/data/src/index.ts"]!.replace("ref<{ code: string }", "ref<{ code?: string }") + '\nexport function getCode(): string | undefined { return undefined; }',
      [`${route}/page.tsx`]: 'import { getCode } from "@scope/data";\n' + base[`${route}/page.tsx`]!.replace("preloadItem(code)", "preloadItem(getCode())"),
      [`${route}/_hooks/preload-item.ts`]: 'import { api, preloadQuery } from "@scope/data"; export async function preloadItem(code = "fallback") { return preloadQuery(api.items.get, { code }); }',
    });
    const plan = await createRefactorApi({ loadBackend }).plan(request(w));
    expect(plan.notes.some(note => note.includes("TODO(port-route)") && note.includes("default parameter"))).toBe(true);
  });

  test("evaluates a shared destructuring initializer only once in the Start loader", async () => {
    const w = await workspace({
      "packages/data/src/index.ts": base["packages/data/src/index.ts"] + '\nexport async function getSnapshot() { return { a: 1, b: 2 }; }',
      [`${route}/page.tsx`]: 'import { getSnapshot } from "@scope/data"; import { ItemView } from "./item-view"; export default async function Page() { const { a, b } = await getSnapshot(); return <ItemView a={a} b={b} />; }',
      [`${route}/item-view.tsx`]: 'export function ItemView({ a, b }: { a: number; b: number }) { return <div>{a}{b}</div>; }',
    });
    const plan = await createRefactorApi({ loadBackend }).plan(request(w));
    expect(plan.validation.status).toBe("passed");
    const start = after(plan, w.path("apps/start/src/routes/items.$code.index.tsx"))!;
    const output = ts.transpileModule(start, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React }, fileName: "route.tsx" }).outputText;
    let calls = 0;
    const exports: any = {};
    new Function("require", "exports", output)((module: string) => {
      if (module === "../router") return { createFileRoute: () => (options: unknown) => ({ options }) };
      if (module === "@scope/data") return { getSnapshot: async () => { calls++; return { a: calls, b: calls }; } };
      return { ItemView: () => null };
    }, exports);
    const result = await exports.Route.options.loader({});
    expect(calls).toBe(1);
    expect(result).toMatchObject({ a: 1, b: 1 });
  });

  test("retro: translated props reuse existing loader bindings", async () => {
    const w = await workspace({
      [`${route}/page.tsx`]: 'import { ItemView } from "./item-view"; export default function Page() { const scope = "items"; return <ItemView scope={scope} />; }',
      [`${route}/item-view.tsx`]: 'export function ItemView({ scope }: { scope: string }) { return <div>{scope}</div>; }',
    });
    const plan = await createRefactorApi({ loadBackend }).plan(request(w));
    expect(plan.validation.status).toBe("passed");
    const start = after(plan, w.path("apps/start/src/routes/items.$code.index.tsx"))!;
    expect(start.match(/const scope\s*=/g)).toHaveLength(1);
    expect(start).not.toContain("Promise.all([])");
  });

  test("moves the view, generates adapter and Start route, rewires the page and applies", async () => {
    const w = await workspace();
    const api = createRefactorApi({ loadBackend });
    const plan = await api.plan(request(w));
    expect(plan.validation).toEqual({ status: "passed", newDiagnostics: [] });
    expect((await api.plan(request(w))).id).toBe(plan.id);
    const view = after(plan, w.path("packages/feature/src/items/item-view.tsx"))!;
    expect(view.startsWith('import type { api } from "@scope/data";\nimport { label } from "./label";\nimport type { FunctionReturnType } from "@scope/data";\n\n')).toBe(true);
    expect(view).toContain("initialItem: FunctionReturnType<typeof api.items.get> | undefined;");
    expect(view).toContain("initialList: string[] | undefined;");
    expect(view).toContain("const item = initialItem;");
    expect(view).toContain("const list = initialList;");
    expect(view).not.toContain("usePreloaded");
    expect(view).not.toContain("Preloaded");
    expect(view).toContain('import type { FunctionReturnType } from "@scope/data";');
    expect(after(plan, w.path(`${route}/item-view.tsx`))).toBeNull();
    expect(after(plan, w.path(`${route}/page.tsx`))).toContain('import { ItemView } from "./item-adapter";');
    const adapter = after(plan, w.path(`${route}/item-adapter.tsx`))!;
    expect(adapter).toBe([
      '"use client";',
      "",
      'import type { preloadItem } from "./_hooks/preload-item";',
      'import { useNav } from "@/adapters/nav";',
      'import { type api, type Preloaded, usePreloaded } from "@scope/data";',
      'import { ItemView as ItemViewComponent } from "@scope/feature/items/item-view";',
      'import type { ComponentProps } from "react";',
      "",
      "export function ItemView({ preloadedItem, preloadedList, title, mode }: {",
      "  preloadedItem: Awaited<ReturnType<typeof preloadItem>>;",
      "  preloadedList: Preloaded<typeof api.items.list>;",
      '  title: ComponentProps<typeof ItemViewComponent>["title"];',
      '  mode?: ComponentProps<typeof ItemViewComponent>["mode"];',
      "}) {",
      "  const item = usePreloaded(preloadedItem).data;",
      "  const list = usePreloaded(preloadedList).data;",
      "  const nav = useNav();",
      "  return (",
      "    <ItemViewComponent",
      "      initialItem={item}",
      "      initialList={list}",
      "      title={title}",
      "      mode={mode}",
      '      code={"code-from-next"}',
      "      nav={nav}",
      "    />",
      "  );",
      "}",
      "",
    ].join("\n"));
    // Nested Next routes make this a TanStack index route.
    const start = after(plan, w.path("apps/start/src/routes/items.$code.index.tsx"))!;
    expect(start).toContain('export const Route = createFileRoute("/items/$code/")({');
    expect(start).toContain("  loader: async ({ context, params }) => {\n    const { code } = params;\n    const now = context.now;\n    const itemArgs = { code };\n    const listArgs = { year: now.getFullYear() };");
    expect(start).toContain("      context.prefetch(itemQuery(itemArgs)),\n      context.prefetch(listQuery(listArgs)),\n    ]);\n    return { itemArgs, listArgs };");
    expect(start).toContain('const itemQuery = (args: FunctionArgs<typeof api.items.get>) => queryOptions(api.items.get, args);');
    expect(start).toContain("// TODO(port-route): translate optional prop 'mode={mode}': mode is not a const value");
    expect(start).toContain('title={"Item"}');
    expect(start).toContain('nav={"start-nav"}');
    expect(start).toContain("const { code } = Route.useParams();");
    expect(start).toContain('import { ItemView } from "@scope/feature/items/item-view";');
    expect(plan.changes.some(change => change.path.endsWith("routeTree.gen.ts"))).toBe(false);
    expect(plan.notes.some(note => note.startsWith("Validated with apps/start/src/routeTree.gen.ts regenerated by fake-route-generator"))).toBe(true);
    expect(plan.notes).toContain("After apply run: regenerate routes.");
    expect(plan.notes.some(note => note.includes("Kept in Next:") && note.includes(`${route}/edit`) && note.includes("_hooks/preload-item.ts"))).toBe(true);
    await api.apply(plan);
    expect(existsSync(w.path("apps/start/src/routeTree.gen.ts"))).toBe(false);
    expect(await readFile(w.path("apps/start/src/routes/items.$code.index.tsx"), "utf8")).toBe(start);
  });

  test("untranslatable preload arguments become a typechecking TODO in the loader", async () => {
    const w = await workspace({
      [`${route}/_hooks/preload-item.ts`]: 'import { api, preloadQuery } from "@scope/data";\nimport { session } from "@/server/clock";\nexport async function preloadItem(code: string) {\n  const user = (await session()).user;\n  return preloadQuery(api.items.get, { code: code + user });\n}\n',
    });
    const plan = await createRefactorApi({ loadBackend }).plan(request(w));
    expect(plan.validation.status).toBe("passed");
    const start = after(plan, w.path("apps/start/src/routes/items.$code.index.tsx"))!;
    expect(start).toContain("// TODO(port-route): translate preloadedItem arguments: session is imported from");
    expect(start).toContain('const itemArgs = (() => { throw new Error("TODO(port-route): translate preloadedItem arguments"); })();');
    expect(plan.notes.some(note => note.startsWith("TODO(port-route): translate preloadedItem arguments"))).toBe(true);
  });

  test("Next-only page imports are never copied into the Start route", async () => {
    const w = await workspace({ ".refactor-ai/port-route.json": base[".refactor-ai/port-route.json"]!.replace('"await getNow()": "context.now"', '"await params": "params"') });
    const plan = await createRefactorApi({ loadBackend }).plan(request(w));
    const start = after(plan, w.path("apps/start/src/routes/items.$code.index.tsx"))!;
    expect(start).not.toContain("@/server/clock");
    expect(start).toContain("TODO(port-route): translate preloadedList arguments: getNow is imported from");
    expect(plan.validation.status).toBe("passed");
  });

  test("rejects views that use a preloaded prop beyond the data hook", async () => {
    const w = await workspace({
      [`${route}/item-view.tsx`]: base[`${route}/item-view.tsx`]!.replace("{list?.length}", "{list?.length}{String(preloadedItem)}"),
    });
    await expect(createRefactorApi({ loadBackend }).plan(request(w))).rejects.toThrow("PORT_ROUTE_VIEW_UNSUPPORTED: preloadedItem must be used exactly once");
  });

  test("rejects catch-all segments, missing pages and missing configuration", async () => {
    const w = await workspace({ "apps/web/src/app/[locale]/docs/[...slug]/page.tsx": "export default function Page() { return null; }\n", "apps/web/src/app/[locale]/docs/[...slug]/view.tsx": "export const v = 1;\n" });
    const api = createRefactorApi({ loadBackend });
    await expect(api.plan(request(w, { file: w.path("apps/web/src/app/[locale]/docs/[...slug]"), target: w.path("packages/feature/src/docs") }))).rejects.toThrow("PORT_ROUTE_UNSUPPORTED_SEGMENT");
    await expect(api.plan(request(w, { file: w.path("apps/web/src/server") }))).rejects.toThrow("PORT_ROUTE_PAGE_NOT_FOUND");
    await expect(api.plan(request(w, { config: w.path(".refactor-ai/missing.json") }))).rejects.toThrow("PORT_ROUTE_CONFIG_NOT_FOUND");
  });

  test("new compiler errors in generated files reject the plan with a port-route hint", async () => {
    const w = await workspace({ "apps/start/src/router.ts": "export function createFileRoute(_id: \"/other\") { return (options: object) => ({ options, useLoaderData: (): any => ({}), useParams: (): any => ({}) }); }\n" });
    await expect(createRefactorApi({ loadBackend }).plan(request(w))).rejects.toThrow(/NEW_DIAGNOSTICS: .*items\.\$code\.index\.tsx.*port-route generated/);
  });

  test("CLI plans with --route and validates the TS7 checker path", async () => {
    const w = await workspace();
    let output = "";
    await runCli(["plan", "port-route", "--project", w.path("apps/web/tsconfig.json"), "--target-project", w.path("packages/feature/tsconfig.json"), "--root", w.root,
      "--route", w.path(route), "--to", w.path("packages/feature/src/items"), "--out", join(w.root, ".refactor-ai", "plan.json")], { loadBackend, write: text => { output += text; } });
    expect(JSON.parse(output).validation.status).toBe("passed");
    await expect(runCli(["plan", "port-route", "--project", w.path("apps/web/tsconfig.json"), "--file", w.path(route)], { loadBackend, write: () => {} })).rejects.toThrow("--route");
    const runner = resolve(import.meta.dir, "../dist/test-ts7.mjs");
    const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, "helpers/ts7-runner.ts")], target: "node", external: ["typescript", "typescript7"] });
    if (!built.success) throw new Error(built.logs.join("\n"));
    await Bun.write(runner, built.outputs[0]);
    const native = spawnSync("node", [runner, JSON.stringify({ ...request(w), checker: "ts7", config: w.path(".refactor-ai/port-route.json") })], { encoding: "utf8", timeout: 60_000 });
    expect(native.stderr.replace(/.*Warning.*\n?|.*--trace-warnings.*\n?/g, "")).toBe("");
    const plan = JSON.parse(native.stdout);
    expect(plan.validation.status).toBe("passed");
    expect(plan.checker.name).toBe("ts7");
  }, 120_000);
});

describe("port-route templates", () => {
  test("placeholders keep indentation, drop empty lines and reject unknown names", () => {
    expect(render("a\n  {{body}},\n  x: {{inline}}\n  {{empty}}\nz", { body: "one\ntwo", inline: "f(\n  1)", empty: "" }, "t")).toBe("a\n  one\n  two,\n  x: f(\n    1)\nz");
    expect(() => render("{{missing}}", {}, "template.tpl")).toThrow("INVALID_PORT_ROUTE_TEMPLATE: template.tpl uses unknown placeholder {{missing}}");
  });

  test("import sets merge, sort and reject conflicting locals", () => {
    const set = new ImportSet();
    set.addText(['import { b, type T } from "m";', 'import { a } from "m";', 'import type { U } from "./local";'], "test");
    set.addNamed("m", "b");
    expect(set.print()).toBe('import type { U } from "./local";\nimport { a, b, type T } from "m";');
    expect(() => set.addNamed("other", "a")).toThrow("PORT_ROUTE_IMPORT_CONFLICT");
  });
});
