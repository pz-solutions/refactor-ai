import { recordPhase } from "../run-log";
/** Opt-in stderr telemetry; never part of a deterministic plan or its ID. */
export function timed<T>(phase: string, run: () => T): T {
  const emit = process.env.REFACTOR_AI_TIMINGS === "on";
  const start = performance.now();
  if (emit) process.stderr.write(JSON.stringify({ phase, event: "start" }) + "\n");
  try { return run(); }
  finally {
    const ms = Math.round(performance.now() - start);
    recordPhase(phase, ms);
    if (emit) process.stderr.write(JSON.stringify({ phase, event: "end", ms }) + "\n");
  }
}
