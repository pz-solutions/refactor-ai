import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import { renderHelp } from "../src/help";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ra-retro-cli-")));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler" }, include: ["src"] }));
  await writeFile(join(root, "src/a.ts"), "export const a = 1;");
  await writeFile(join(root, "src/b.ts"), "export const b = 2;");
  return root;
}
const quiet = { write: (_text: string) => {}, setExitCode: (_code: number) => {} };

test("retro: accepts equals-form move pairs and writes successful and failed run records", async () => {
  const root = await fixture();
  const args = ["plan", "move-file", `--project=${root}/tsconfig.json`, `--root=${root}`, `--file=${root}/src/a.ts=${root}/src/ui/a.ts`];
  await main(args, quiet);
  await expect(main(["plan", "rename", "--root", root, "--bad", "x"], quiet)).rejects.toThrow("INVALID_ARGUMENT");
  const records = (await readFile(join(root, ".refactor-ai/runs.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({ schemaVersion: 1, op: "move-file", argv: args, status: "planned", exitCode: 0 });
  expect(records[0].planId).toBeString();
  expect(records[0].wallMs).toBeGreaterThanOrEqual(0);
  expect(records[0].phases.length).toBeGreaterThan(0);
  expect(records[0].cli.version).toBeString();
  expect(records[0].checker.name).toBe("ts5");
  expect(records[1]).toMatchObject({ status: "failed", exitCode: 1, errorCode: "INVALID_ARGUMENT" });
});

test("retro: inline-reexports batches shims with shared callers into one plan", async () => {
  const root = await fixture();
  await writeFile(join(root, "src/shim-a.ts"), 'export * from "./a";');
  await writeFile(join(root, "src/shim-b.ts"), 'export * from "./b";');
  await writeFile(join(root, "src/use.ts"), 'import { a } from "./shim-a"; import { b } from "./shim-b"; export const value = a + b;');
  const out = join(root, ".refactor-ai/batch.json");
  const args = ["plan", "inline-reexports", "--project", join(root, "tsconfig.json"), "--out", out];
  await main([...args, "--file", join(root, "src/shim-a.ts"), "--file", join(root, "src/shim-b.ts")], quiet);
  const plan = JSON.parse(await readFile(out, "utf8"));
  expect(plan.validation.status).toBe("passed");
  expect(plan.changes.filter((change: { after: unknown }) => change.after === null)).toHaveLength(2);
  expect(plan.changes.find((change: { path: string }) => change.path.endsWith("/use.ts")).after).not.toContain("shim-");
  await main([...args, "--file", join(root, "src/shim-b.ts"), "--file", join(root, "src/shim-a.ts")], quiet);
  expect(JSON.parse(await readFile(out, "utf8")).id).toBe(plan.id);
});

test("retro: top-level help is a compact operation index", () => {
  const help = renderHelp([]);
  expect(help.split(/\s+/).length).toBeLessThan(400);
  expect(help).toContain("inline-reexports");
  expect(help).toContain("--help");
});


test("retro: rename selects a top-level symbol and propagates a public name through barrels", async () => {
  const root = await fixture();
  await writeFile(join(root, "src/barrel.ts"), 'export { a } from "./a";');
  await writeFile(join(root, "src/use.ts"), 'import { a } from "./barrel"; export const result = a;');
  const out = join(root, ".refactor-ai/rename.json");
  await main(["plan", "rename", "--project", join(root, "tsconfig.json"), "--file", join(root, "src/a.ts"), "--symbol", "a", "--name", "renamed", "--public", "--out", out], quiet);
  const plan = JSON.parse(await readFile(out, "utf8"));
  expect(plan.validation.status).toBe("passed");
  expect(plan.changes.find((change: { path: string }) => change.path.endsWith("barrel.ts")).after).toContain('export { renamed }');
  expect(plan.changes.find((change: { path: string }) => change.path.endsWith("use.ts")).after).toContain('import { renamed }');
});


test("retro: gc removes only completed journals and refuses an active apply lock", async () => {
  const root = await fixture(), state = join(root, ".refactor-ai");
  await mkdir(state);
  const applied = "a".repeat(64), failed = "b".repeat(64);
  await writeFile(join(state, `${applied}.journal.json`), JSON.stringify({ schemaVersion: 2, planId: applied, status: "applied", changes: [] }));
  await writeFile(join(state, `${failed}.journal.json`), JSON.stringify({ schemaVersion: 2, planId: failed, status: "recovery-needed", changes: [] }));
  await main(["gc", "--root", root], quiet);
  await expect(readFile(join(state, `${applied}.journal.json`))).rejects.toThrow();
  expect(JSON.parse(await readFile(join(state, `${failed}.journal.json`), "utf8")).status).toBe("recovery-needed");
  await mkdir(join(state, "apply.lock"));
  await expect(main(["gc", "--root", root], quiet)).rejects.toThrow("APPLY_LOCKED");
});

test("retro: run history covers help/preview/validate/apply, opt-out and concurrent invocations", async () => {
  const root = await fixture(), plan = join(root, ".refactor-ai/plan.json");
  await main(["plan", "rename", "--project", join(root, "tsconfig.json"), "--file", join(root, "src/a.ts"), "--symbol", "a", "--name", "renamed", "--out", plan], quiet);
  await Promise.all(["preview", "validate"].map(command => main([command, "--plan", plan], quiet)));
  await main(["apply", "--plan", plan], quiet);
  await expect(main(["validate", "--plan", plan], quiet)).rejects.toThrow("STALE_SNAPSHOT");
  const history = join(root, ".refactor-ai/runs.jsonl");
  const lines = (await readFile(history, "utf8")).trim().split("\n");
  expect(lines.map(line => JSON.parse(line).status).sort()).toEqual(["applied", "failed", "planned", "previewed", "validated"]);
  expect(new Set(lines.map(line => JSON.parse(line).planId)).size).toBe(1);
  const cli = join(import.meta.dir, "../src/cli.ts");
  const help = Bun.spawnSync([process.execPath, cli, "--help"], { cwd: root });
  expect(help.exitCode).toBe(0);
  expect(JSON.parse((await readFile(history, "utf8")).trim().split("\n").at(-1)!)).toMatchObject({ op: "help", cwd: root, status: "ok" });
  const before = await readFile(history, "utf8");
  const disabled = Bun.spawnSync([process.execPath, cli, "--help"], { cwd: root, env: { ...process.env, REFACTOR_AI_RUN_LOG: "off" } });
  expect(disabled.exitCode).toBe(0);
  expect(await readFile(history, "utf8")).toBe(before);
  await rm(join(root, ".refactor-ai"), { recursive: true });
  await writeFile(join(root, ".refactor-ai"), "unwritable state directory");
  await expect(main(["capabilities", "--project", join(root, "tsconfig.json")], quiet)).resolves.toBeUndefined();
});

test("retro: symbol selection rejects missing or ambiguous names and positional combinations", async () => {
  const root = await fixture();
  const args = ["plan", "rename", "--project", join(root, "tsconfig.json"), "--file", join(root, "src/a.ts"), "--name", "renamed"];
  await expect(main([...args, "--symbol", "missing"], quiet)).rejects.toThrow("SYMBOL_NOT_FOUND");
  await expect(main([...args, "--symbol", "a", "--at", "1:14"], quiet)).rejects.toThrow("INVALID_ARGUMENT");
  await writeFile(join(root, "src/a.ts"), "export interface Duplicate {} export class Duplicate {}");
  await expect(main([...args, "--symbol", "Duplicate"], quiet)).rejects.toThrow("SYMBOL_AMBIGUOUS");
});
