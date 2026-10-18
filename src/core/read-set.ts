import { createRequire } from "node:module";
import { createHash } from "node:crypto";

export const inputMethods = ["readFile", "fileExists", "directoryExists", "getDirectories", "readDirectory", "realpath"] as const;
export interface ReadSetEntry { method: typeof inputMethods[number]; args: any[]; digest: string; }
export const inputHash = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? `string:${value}` : JSON.stringify(value) ?? "undefined").digest("hex");

export function assertReadSetShape(inputs: ReadSetEntry[]): void {
  if (!Array.isArray(inputs) || inputs.some(input => !input || !inputMethods.includes(input.method)
    || !Array.isArray(input.args) || typeof input.args[0] !== "string" || !/^[a-f0-9]{64}$/.test(input.digest))) {
    throw new Error("INVALID_PLAN: malformed read set");
  }
}

/** Loaded only for plans that recorded TypeScript inputs; C# has no TS dependency. */
export async function assertReadSetFresh(inputs: ReadSetEntry[], compilerBase?: string): Promise<void> {
  assertReadSetShape(inputs);
  if (!inputs.length) return;
  const load = createRequire(compilerBase ?? import.meta.url);
  const ts = load("typescript") as typeof import("typescript");
  for (const input of inputs) {
    const method = ts.sys[input.method];
    if (!method || inputHash((method as Function)(...input.args.map(value => value === null ? undefined : value))) !== input.digest) {
      throw new Error(`STALE_PROJECT_INPUTS: ${input.method} changed: ${input.args[0]}; create a new plan after writers/generators settle`);
    }
  }
}
