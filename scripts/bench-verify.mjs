// Paired --verify benchmark: baseline full vs new full vs new bindings (cold processes),
// and cold vs serve for five sequential plans. Plans are never applied.
// node scripts/bench-verify.mjs <target-root> <baseline-cli> <new-cli> <output-dir> [uber|r4] [runs]
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";

const [root, baseline, current, output, suite = "uber", runsArg = "3"] = process.argv.slice(2);
if (!root || !baseline || !current || !output) throw new Error("Usage: node scripts/bench-verify.mjs <target-root> <baseline-cli> <new-cli> <output-dir> [uber|r4] [runs]");
const runs = Number(runsArg);
mkdirSync(output, { recursive: true });
const digest = value => createHash("sha256").update(value).digest("hex");
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout.trim();
const env = { ...process.env, REFACTOR_AI_CACHE: "off", REFACTOR_AI_TIMINGS: "on" };

const events = ["event-search-params.ts", "events-client.helpers.ts", "events-table-row.helpers.ts", "events-table-row.tsx", "events-table.columns.tsx", "event-edit-dialog.tsx", "events-client.sections.tsx", "events-client.tsx", "events-client.helpers.test.ts", "events-table-row.helpers.test.ts", "events-table-row.test.tsx", "events-table.columns.test.tsx", "events-client.test.tsx"];
const scenarios = suite === "r4" ? [
  { name: "events-batch", args: ["--project", "apps/web/tsconfig.json", "--target-project", "packages/app-features/tsconfig.json", "--map", "next-intl=use-intl",
    ...events.flatMap(name => ["--file", `apps/web/src/app/[locale]/dashboard/events/${name}=packages/app-features/src/events/${name}`])] },
] : [
  { name: "in-package", args: ["--project", "packages/app-features/tsconfig.json", "--file", "packages/app-features/src/shared/formatters.ts", "--to", "packages/app-features/src/shared/fmt/formatters.ts"] },
  { name: "cross-package", args: ["--project", "apps/web/tsconfig.json", "--target-project", "packages/app-features/tsconfig.json", "--file", "apps/web/src/lib/workos-request-origin.ts", "--to", "packages/app-features/src/server/workos-request-origin.ts"] },
];
const serveFiles = ["formatters", "business-clock", "effective-date", "search-params", "token-scope"];
const serveArgs = serveFiles.map(name => ["--project", "packages/app-features/tsconfig.json", "--file", `packages/app-features/src/shared/${name}.ts`, "--to", `packages/app-features/src/shared/moved/${name}.ts`]);
const variants = {
  "base-full": { cli: baseline, flags: ["--checker", "ts7"] },
  full: { cli: current, flags: ["--verify", "full", "--checker", "ts7"] },
  bindings: { cli: current, flags: ["--verify", "bindings"] },
};

function phasesOf(text) {
  const plans = [];
  for (const line of text.split("\n")) {
    let item; try { item = JSON.parse(line); } catch { continue; }
    if (item.phase === "workspace.load" && item.event === "start") plans.push({});
    if (item.event === "end" && plans.length) plans.at(-1)[item.phase] = (plans.at(-1)[item.phase] ?? 0) + item.ms;
  }
  return plans;
}

function outcome(path) {
  try {
    const plan = JSON.parse(readFileSync(path, "utf8"));
    return { id: plan.id, editHash: digest(JSON.stringify(plan.changes)), files: plan.changes.length, readCount: plan.readSet?.length, verify: plan.request.verify ?? "full", checker: plan.checker, validation: plan.validation };
  } catch { return undefined; }
}

const report = { suite, root, commit: git("rev-parse", "HEAD"), node: process.version, baselineHash: digest(readFileSync(baseline)), currentHash: digest(readFileSync(current)),
  mode: "cold Node processes unless serve; cache off; OS cache retained; variant order rotates per run; no apply", cold: [], serve: [] };
const save = () => writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");

function cold(scenario, run, variant, args) {
  const name = `${scenario}-${run}-${variant}`, plan = join(output, `${name}.json`), statusBefore = git("status", "--porcelain"), loadBefore = loadavg();
  const start = performance.now();
  const result = spawnSync("node", [variants[variant].cli, "plan", "move-file", ...args, "--root", root, ...variants[variant].flags, "--out", plan], { cwd: root, encoding: "utf8", timeout: 300_000, maxBuffer: 64e6, env });
  const ms = Math.round(performance.now() - start);
  writeFileSync(join(output, `${name}.stderr`), result.stderr ?? "");
  const sample = { scenario, run, variant, ms, status: result.status, loadBefore, loadAfter: loadavg(), statusBefore, statusAfter: git("status", "--porcelain"),
    phases: phasesOf(result.stderr ?? "")[0], outcome: result.status === 0 ? outcome(plan) : undefined, error: result.status === 0 ? undefined : (result.stdout + result.stderr).slice(-2000) };
  report.cold.push(sample); save();
  console.log(`${name}: ${ms} ms status=${result.status}`);
  return sample;
}

function serve(session, variant) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [variants[variant].cli, "serve", "--root", root], { cwd: root, stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "", stderr = "", index = 0, start = 0;
    const loadBefore = loadavg(), samples = [];
    const send = () => {
      const plan = join(output, `serve-${variant}-${session}-${index}.json`);
      start = performance.now();
      child.stdin.write(JSON.stringify({ id: index, args: ["plan", "move-file", ...serveArgs[index], ...variants[variant].flags, "--out", plan] }) + "\n");
    };
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.stdout.on("data", chunk => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
        const response = JSON.parse(line), ms = Math.round(performance.now() - start);
        samples.push({ plan: index + 1, ms, status: response.status, outcome: response.status === "ok" ? outcome(join(output, `serve-${variant}-${session}-${index}.json`)) : undefined, error: response.error });
        console.log(`serve-${variant}-${session} plan ${index + 1}: ${ms} ms ${response.status}`);
        if (++index < serveArgs.length) send(); else child.stdin.end();
      }
    });
    child.on("error", reject);
    child.on("exit", code => {
      writeFileSync(join(output, `serve-${variant}-${session}.stderr`), stderr);
      const phases = phasesOf(stderr);
      samples.forEach((sample, i) => { sample.phases = phases[i]; });
      report.serve.push({ session, variant, mode: "serve", exit: code, loadBefore, loadAfter: loadavg(), samples }); save();
      resolve();
    });
    send();
  });
}

function coldSeries(session, variant) {
  const loadBefore = loadavg(), samples = [];
  serveArgs.forEach((args, index) => {
    const sample = cold(`serve-cold-${index + 1}`, session, variant, args);
    samples.push({ plan: index + 1, ms: sample.ms, status: sample.status === 0 ? "ok" : "failed", outcome: sample.outcome, phases: sample.phases });
  });
  report.serve.push({ session, variant, mode: "cold", loadBefore, loadAfter: loadavg(), samples }); save();
}

const order = Object.keys(variants);
for (let run = 1; run <= runs; run++) {
  const rotated = [...order.slice((run - 1) % order.length), ...order.slice(0, (run - 1) % order.length)];
  for (const scenario of scenarios) for (const variant of rotated) cold(scenario.name, run, variant, scenario.args);
}
if (suite === "uber") {
  for (let session = 1; session <= runs; session++) {
    for (const variant of session % 2 ? ["bindings", "full"] : ["full", "bindings"]) {
      await serve(session, variant);
      coldSeries(session, variant);
    }
  }
}
save();
