import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2).filter(arg => arg !== "--");
const option = (name: string) => { const index = args.indexOf(`--${name}`); return index < 0 ? undefined : args[index + 1]; };
if (!option("root")) throw new Error("bench-warm --root <repo> [--runs 5] [--json /tmp/warm.json]");
const root = resolve(option("root")!), runs = Number(option("runs") ?? 5);
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
const directory = mkdtempSync(resolve(tmpdir(), "rai-warm-"));
const server = spawn("node", [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "serve", "--root", root], {
  stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, REFACTOR_AI_CACHE: process.env.REFACTOR_AI_CACHE ?? "off", REFACTOR_AI_CACHE_DIR: resolve(directory, "cache") },
});
const lines = createInterface({ input: server.stdout })[Symbol.asyncIterator]();
const samples = [];
try {
  for (let run = 0; run < runs; run++) {
    const start = performance.now();
    server.stdin.write(JSON.stringify({ id: run, args: ["plan", "rename", "--project", "packages/app-features/tsconfig.json", "--file", "packages/app-features/src/shared/formatters.ts", "--at", "19:17", "--name", `mapLocale${run}`, "--out", resolve(directory, `${run}.json`)] }) + "\n");
    const response = await lines.next();
    if (response.done) throw new Error("server exited without a response");
    const result = JSON.parse(response.value);
    const sample = { plan: run + 1, ms: Math.round(performance.now() - start), status: result.status, error: result.error };
    samples.push(sample); console.log(JSON.stringify(sample));
  }
} finally { server.stdin.end(); }
await new Promise<void>((resolve, reject) => { server.on("exit", code => code === 0 ? resolve() : reject(new Error(`server exit ${code}`))); server.on("error", reject); });
if (option("json")) writeFileSync(resolve(option("json")!), JSON.stringify({ root, mode: "warm LanguageService, sequential distinct rename plans, no apply", samples }, null, 2) + "\n");
