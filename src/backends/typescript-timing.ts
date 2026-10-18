/** Opt-in stderr telemetry; never part of a deterministic plan or its ID. */
export function timed<T>(phase: string, run: () => T): T {
  if (process.env.REFACTOR_AI_TIMINGS !== "on") return run();
  const start = performance.now();
  process.stderr.write(JSON.stringify({ phase, event: "start" }) + "\n");
  try { return run(); }
  finally { process.stderr.write(JSON.stringify({ phase, event: "end", ms: Math.round(performance.now() - start) }) + "\n"); }
}
