import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};
if (args.includes("--help") || !option("root")) {
  console.log("bun run bench -- --root <uber-platform> [--runs 3] [--json /tmp/bench.json] [--scenario rename] [--cli dist/cli.js]");
  process.exit(args.includes("--help") ? 0 : 1);
}
const root = resolve(option("root")!);
const runs = Number(option("runs") ?? 3);
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
const cli = resolve(option("cli") ?? fileURLToPath(new URL("../dist/cli.js", import.meta.url)));
const output = mkdtempSync(resolve(tmpdir(), "refactor-ai-bench-"));
const shared = "packages/app-features/tsconfig.json";
const web = "apps/web/tsconfig.json";
export const scenarios = [
  { name: "rename", args: ["rename", "--project", shared, "--file", "packages/app-features/src/shared/formatters.ts", "--at", "19:17", "--name", "mapLocaleX"] },
  { name: "move-alias", args: ["move-file", "--project", web, "--file", "apps/web/src/app/[locale]/dashboard/users/users-table.cells.tsx", "--to", "packages/app-features/src/users/users-table.cells.tsx", "--target-project", shared] },
  { name: "move-internal", args: ["move-file", "--project", shared, "--file", "packages/app-features/src/shared/formatters.ts", "--to", "packages/app-features/src/shared/fmt/formatters.ts"] },
  { name: "retarget-import", args: ["retarget-import", "--project", web, "--from", "@/lib/formatters", "--to", "@uber-platform/app-features/shared/formatters"] },
  { name: "inline-reexports", args: ["inline-reexports", "--project", web, "--file", "apps/web/src/lib/formatters.ts"] },
];
const results = [];
for (const scenario of scenarios.filter((item) => !option("scenario") || item.name === option("scenario"))) {
  const samples = [];
  for (let run = 0; run < runs; run++) {
    const planPath = resolve(output, `${scenario.name}-${run}.json`);
    const start = performance.now();
    const result = spawnSync(process.execPath.endsWith("bun") ? "node" : process.execPath,
      [cli, "plan", ...scenario.args, "--root", root, "--out", planPath],
      { cwd: root, env: { ...process.env, REFACTOR_AI_CACHE: process.env.REFACTOR_AI_CACHE ?? "off", REFACTOR_AI_TIMINGS: "on", REFACTOR_AI_CACHE_DIR: process.env.REFACTOR_AI_CACHE_DIR ?? resolve(output, "cache") }, encoding: "utf8", timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });
    const ms = Math.round(performance.now() - start);
    const phases: Record<string, number> = {};
    const errors: string[] = [];
    for (const line of result.stderr.trim().split("\n")) {
      if (!line) continue;
      try {
        const value = JSON.parse(line);
        if (value.phase) { if (value.event === "end") phases[value.phase] = (phases[value.phase] ?? 0) + value.ms; }
        else errors.push(line);
      } catch { errors.push(line); }
    }
    const error = result.error?.message ?? errors.join("\n");
    let notes: string[] = [];
    if (result.status === 0) notes = JSON.parse(readFileSync(planPath, "utf8")).notes;
    const sample = { ms, status: result.status, outcome: error || "planned", phases, notes };
    samples.push(sample);
    console.error(`${scenario.name} ${run + 1}/${runs}: ${ms} ms ${error.split("\n")[0] || "planned"}`);
  }
  const times = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  results.push({ scenario: scenario.name, medianMs: Math.round((times[Math.floor((times.length - 1) / 2)]! + times[Math.ceil((times.length - 1) / 2)]!) / 2), minMs: times[0], maxMs: times.at(-1), samples });
}
console.table(results.map(({ samples, ...result }) => ({ ...result, outcome: samples[0]?.status === 0 ? "planned" : (() => { try { return JSON.parse(samples[0]!.outcome).error.split(":")[0]; } catch { return samples[0]?.outcome.slice(0, 60); } })() })));
const report = { root, cli, runs, mode: "cold process, OS filesystem cache retained", results };
if (option("json")) writeFileSync(resolve(option("json")!), JSON.stringify(report, null, 2) + "\n");
