import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2).filter(arg => arg !== "--");
const option = (name: string) => { const index = args.indexOf(`--${name}`); return index < 0 ? undefined : args[index + 1]; };
if (!option("root")) throw new Error("bench-checkers --root <repo> [--project config] [--runs 2] [--tsgo binary] [--rust binary] [--peer binary] [--json /tmp/results.json]");
const root = resolve(option("root")!), runs = Number(option("runs") ?? 2);
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
const directory = mkdtempSync(resolve(tmpdir(), "rai-checkers-"));
const project = option("project") ?? "packages/app-features/tsconfig.json";
const checkers = [
  { name: "ts-5.9.3", command: "node", args: [fileURLToPath(new URL("../node_modules/typescript/lib/tsc.js", import.meta.url))] },
  ...["tsgo", "peer", "rust"].filter(name => option(name)).map(name => ({ name, command: option(name)!, args: [] as string[] })),
];
async function runChecker(command: string, commandArgs: string[]) {
  const child = spawn(command, commandArgs, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", maxRssKb = 0;
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  // Linux /proc sampling avoids a dependency on GNU time. RSS is approximate.
  const sample = setInterval(() => {
    try { maxRssKb = Math.max(maxRssKb, Number(readFileSync(`/proc/${child.pid}/status`, "utf8").match(/VmHWM:\s+(\d+)/)?.[1] ?? 0)); }
    catch { /* The process may have exited between samples. */ }
  }, 25);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 240_000);
  try {
    const status = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    return { stdout, stderr, status, maxRssKb };
  } finally { clearInterval(sample); clearTimeout(timeout); }
}

const results = [];
for (const checker of checkers) {
  const samples = [];
  for (let run = 0; run < runs; run++) {
    const start = performance.now();
    const result = await runChecker(checker.command, [...checker.args, "-p", project,
      "--noEmit", "--incremental", "false", "--composite", "false", "--pretty", "false", "--extendedDiagnostics"]);
    const ms = Math.round(performance.now() - start);
    const diagnostics = result.stdout.split("\n").filter(line => /error TS\d+:/.test(line)).sort();
    const log = resolve(directory, `${checker.name}-${run}.txt`);
    writeFileSync(log, result.stdout + result.stderr);
    const sample = { ms, status: result.status, diagnostics, maxRssKb: result.maxRssKb, log };
    samples.push(sample); console.error(`${checker.name} ${run + 1}/${runs}: ${ms} ms, ${diagnostics.length} diagnostics, ${sample.maxRssKb} KB RSS`);
  }
  results.push({ checker: checker.name, samples });
}
console.table(results.map(({ checker, samples }) => ({ checker, ms: Math.round(samples.reduce((sum, item) => sum + item.ms, 0) / samples.length), diagnostics: samples[0]?.diagnostics.length, sampledRssMb: Math.round(Math.max(...samples.map(item => item.maxRssKb)) / 1024) })));
if (option("json")) writeFileSync(resolve(option("json")!), JSON.stringify({ root, project, runs, results }, null, 2) + "\n");
