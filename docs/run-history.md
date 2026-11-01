# CLI run history

Every CLI invocation (author runner, npm packages and skill launchers) appends one
JSON object plus a newline to `<root>/.refactor-ai/runs.jsonl`. The stdio server logs
its invocation and each executed CLI request. API calls do not log.

`REFACTOR_AI_RUN_LOG=off` disables logging, including directory creation. Logging is
best effort: an unwritable/missing root or redirected state path cannot change the
command outcome. The state directory remains Git-ignored. Records are local; no
network telemetry is sent. Concurrent invocations append independently.

Root selection: explicit `--root`, otherwise the project config's directory,
otherwise the invocation cwd. A loaded plan supplies its own root for preview,
validate and apply. Help and malformed arguments use the available flag hints.

Schema version 1:

```ts
{
  schemaVersion: 1;
  startedAt: string;             // ISO-8601 UTC
  command: string;               // plan, apply, preview, validate, help, gc, ...
  op: string;                    // plan operation, otherwise command
  argv: string[];                // original CLI arguments, excluding node/runner
  cwd: string;                   // invocation working directory
  root: string;                  // canonical history root
  wallMs: number;                // rounded elapsed ms, excludes final history write
  phases: { phase: string; ms: number }[];
  status: string;                // ok, planned, previewed, validated, applied, collected, failed
  exitCode: number;              // 0 or 1
  errorCode: string | null;      // e.g. INVALID_ARGUMENT, NEW_DIAGNOSTICS
  planId: string | null;
  cli: { version: string; sha256: string | null };
  checker: { name: "ts5" | "ts7" | "both"; version: string; comparedWith?: string } | null;
}
```

`phases` contains the same completed phase measurements emitted by
`REFACTOR_AI_TIMINGS=on`; history captures them even when stderr timings are off.
Nested phases overlap, so their durations should not be summed as wall time.
Commands failing before analysis may have no phases, plan ID or checker identity.
`cli.sha256` identifies the executing runner module (the logger's source module
when executing unbundled source); version comes from the author package manifest.

`gc --root <root>` deletes only schema-2 journals marked `applied`, with a matching
plan ID and filename. It refuses an existing apply lock and preserves failed,
interrupted, malformed and symlink journals. It does not truncate run history or
delete plans.
