import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadavg } from "node:os";

const [rootArg, cliArg, variant, outArg] = process.argv.slice(2);
if (!rootArg || !cliArg || !["single", "batch"].includes(variant) || !outArg) throw new Error("Usage: node scripts/bench-r4.mjs /tmp/ra-target <cli> single|batch <output>");
const root = realpathSync(rootArg), cli = realpathSync(cliArg), output = outArg;
if (!root.startsWith("/tmp/")) throw new Error("Only disposable /tmp worktrees may be used: single mode applies and restores plans there");
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();
if (!git("rev-parse", "HEAD").startsWith("9f66b9dc")) throw new Error("Expected pre-events commit 9f66b9dc");
const names = ["event-search-params.ts", "events-client.helpers.ts", "events-table-row.helpers.ts", "events-table-row.tsx", "events-table.columns.tsx", "event-edit-dialog.tsx", "events-client.sections.tsx", "events-client.tsx", "events-client.helpers.test.ts", "events-table-row.helpers.test.ts", "events-table-row.test.tsx", "events-table.columns.test.tsx", "events-client.test.tsx"];
const source = "apps/web/src/app/[locale]/dashboard/events/", destination = "packages/app-features/src/events/";
const digest = text => createHash("sha256").update(text).digest("hex");
mkdirSync(output, { recursive: true });
const preparedFiles = [...names.map(name => source + name), source + "_hooks/preload-events.ts", source + "page.tsx", source + "events-adapter.tsx", destination + "types.ts", "packages/app-features/package.json"];
const preparedInputHash = digest(JSON.stringify(preparedFiles.sort().map(path => [path, digest(readFileSync(join(root, path)))])));
const report = { preparedInputHash, mode: "Cold Node processes, TS7, cache off, OS cache retained; serial historical move order vs atomic batch; plans applied/restored only in disposable /tmp for single mode", root, commit: git("rev-parse", "HEAD"), node: process.version, cliHash: digest(readFileSync(cli)), variant, samples: [] };
function run(args, label) {
  const start = performance.now(), machineLoad = loadavg();
  const result = spawnSync("node", [cli, ...args], { cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 32e6, env: { ...process.env, REFACTOR_AI_CACHE: "off", REFACTOR_AI_TIMINGS: "on" } });
  const ms = Math.round(performance.now() - start);
  writeFileSync(join(output, label + ".stdout"), result.stdout ?? "");
  writeFileSync(join(output, label + ".stderr"), result.stderr ?? "");
  if (result.status !== 0) throw new Error(`${label}: ${result.stderr || result.error?.message}`);
  return { ms, machineLoad };
}
const common = ["plan", "move-file", "--project", "apps/web/tsconfig.json", "--root", root, "--target-project", "packages/app-features/tsconfig.json", "--map", "next-intl=use-intl", "--checker", "ts7"];
for (let iteration = 1; iteration <= 3; iteration++) {
  const status = git("status", "--porcelain"), originals = new Map(), applied = [], sample = { iteration, statusBefore: status, plans: [] };
  try {
    const moves = variant === "batch" ? [names] : names.map(name => [name]);
    for (const [index, files] of moves.entries()) {
      const label = `${variant}-${iteration}-${index}`, path = join(output, label + ".json");
      const args = variant === "batch" ? files.flatMap(name => ["--file", `${source + name}=${destination + name}`]) : ["--file", source + files[0], "--to", destination + files[0]];
      const timing = run([...common, ...args, "--out", path], label);
      const plan = JSON.parse(readFileSync(path, "utf8"));
      if (plan.validation.status !== "passed") throw new Error(`${label}: failed validation`);
      const phases = {};
      for (const line of readFileSync(join(output, label + ".stderr"), "utf8").split("\n")) try { const item = JSON.parse(line); if (item.event === "end") phases[item.phase] = (phases[item.phase] ?? 0) + item.ms; } catch {}
      sample.plans.push({ ...timing, id: plan.id, editHash: digest(JSON.stringify(plan.changes)), readCount: plan.readSet?.length, checker: plan.checker, changes: plan.changes.length, validation: plan.validation, phases });
      if (variant === "single") {
        for (const change of plan.changes) if (!originals.has(change.path)) originals.set(change.path, change.before);
        run(["apply", "--plan", path], label + "-apply");
        applied.push(path);
      }
      console.log(`${label}: ${timing.ms}ms passed`);
    }
    sample.ms = sample.plans.reduce((sum, plan) => sum + plan.ms, 0);
    sample.finalContents = Object.fromEntries([...originals].sort(([a], [b]) => a.localeCompare(b)).map(([path]) => [path, existsSync(path) ? digest(readFileSync(path)) : null]));
  } finally {
    // Restore exact pre-run bytes without git reset/clean or changes outside /tmp.
    for (const [path, text] of originals) {
      if (text === null) rmSync(path, { force: true });
      else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
    }
    sample.statusAfter = git("status", "--porcelain");
    if (sample.statusAfter !== status) throw new Error("Fixture status changed after restoration");
    report.samples.push(sample);
    writeFileSync(join(output, "summary.json"), JSON.stringify(report, null, 2) + "\n");
  }
}
