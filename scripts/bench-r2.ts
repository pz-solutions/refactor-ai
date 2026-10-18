import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadavg } from "node:os";

// Paired sequential runs; outputs are outside the target, which is never applied to.
const [rootArg, beforeArg, afterArg, outputArg, filter, runsArg] = process.argv.slice(2);
if (!rootArg || !beforeArg || !afterArg || !outputArg) throw new Error("Usage: bun scripts/bench-r2.ts <root> <before-cli> <after-cli> <output-dir> [scenario] [runs]");
const runs = Number(runsArg ?? 3);
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("runs must be a positive integer");
const root = resolve(rootArg), before = resolve(beforeArg), after = resolve(afterArg), output = resolve(outputArg);
mkdirSync(output, { recursive: true });
const shared = "packages/app-features/tsconfig.json", web = "apps/web/tsconfig.json";
const scenarios = [
  { name: "rename", args: ["rename", "--project", shared, "--file", "packages/app-features/src/shared/formatters.ts", "--at", "19:17", "--name", "mapLocaleR2"] },
  { name: "retarget", args: ["retarget-import", "--project", web, "--from", "@/lib/formatters", "--to", "@uber-platform/app-features/shared/formatters"] },
  { name: "inline", args: ["inline-reexports", "--project", web, "--file", "apps/web/src/lib/formatters.ts"] },
  { name: "move", args: ["move-file", "--project", shared, "--file", "packages/app-features/src/shared/formatters.ts", "--to", "packages/app-features/src/shared/fmt/formatters.ts"] },
];
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const provenance = { node: spawnSync("node", ["--version"], { encoding: "utf8" }).stdout.trim(), targetCommit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(), beforeHash: digest(readFileSync(before)), afterHash: digest(readFileSync(after)) };
const samples: object[] = [];
for (const scenario of scenarios.filter(s => !filter || s.name === filter)) for (let run = 1; run <= runs; run++) {
  for (const variant of ["before", "after", "ts7", "both"] as const) {
    const name = `${scenario.name}-${run}-${variant}`, plan = resolve(output, `${name}.json`);
    rmSync(plan, { force: true });
    const machineLoad = loadavg();
    const start = performance.now();
    const result = spawnSync("node", [variant === "before" ? before : after, "plan", ...scenario.args,
      ...(variant === "ts7" || variant === "both" ? ["--checker", variant] : []), "--root", root, "--out", plan],
      { cwd: root, encoding: "utf8", env: { ...process.env, REFACTOR_AI_CACHE: "off", REFACTOR_AI_TIMINGS: "on" }, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    const ms = Math.round(performance.now() - start);
    writeFileSync(resolve(output, `${name}.stderr`), result.stderr ?? "");
    writeFileSync(resolve(output, `${name}.stdout`), result.stdout ?? "");
    let outcome: unknown;
    try { const p = JSON.parse(readFileSync(plan, "utf8")); outcome = { snapshotHash: p.snapshot.hash, editHash: digest(JSON.stringify(p.changes)), validation: p.validation, notes: p.notes, checker: p.checker, files: p.changes.map((c: {path: string}) => c.path) }; }
    catch { outcome = result.error?.message ?? result.stderr?.trim().split("\n").at(-1); }
    const phases: Record<string, number> = {};
    for (const line of (result.stderr ?? "").split("\n")) try { const p = JSON.parse(line); if (p.event === "end") phases[p.phase] = (phases[p.phase] ?? 0) + p.ms; } catch { /* non-JSON errors */ }
    samples.push({ scenario: scenario.name, run, variant, ms, status: result.status, machineLoad, phases, outcome });
    writeFileSync(resolve(output, "report.json"), JSON.stringify({ root, before, after, ...provenance, mode: "paired cold processes; OS cache retained; cache off; no apply", samples }, null, 2) + "\n");
    console.log(`${name}: ${ms}ms status=${result.status}`);
  }
}
