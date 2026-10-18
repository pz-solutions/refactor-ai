# Round-three measurement artifacts

See [F46–F50 and the final results](../2026-10-17-tanstack-start-migration.md#performance-round-3-2026-10-18)
for behavior, safety boundaries, commands and remaining gaps.

- `paired.json`: all 12 successful cold-process TS7 samples, three sequential r2/r3 pairs per scenario. Includes target status/commit, binary hashes, checker/validation, exact edit hash, deterministic plan IDs, load and phase timings. Full plans and stdout/stderr stay in `/tmp/refactor-r3-final-bench`.
- `summary.json`: derived medians, ranges, raw sample times and phase medians. Assertions require all plans to pass, clean unchanged target state, equal edits across variants, and identical plan IDs across each variant's three repetitions. Schema-3 snapshot scope intentionally differs from R2.
- `results.html`: standalone table derived from the summary.

The cross-package file is the current KSeF forwarding shim; the original
implementation has already migrated. These measurements are not a replay of the
historical owner-detail/KSeF extraction. Cross-package R3 regresses versus its
fresh R2 control, despite both R3 medians meeting the 30 s target. One sample is
33.76 s. Historical R2 timings are not substituted for the faster fresh control.

The real current owner-detail demo is `/tmp/refactor-r3-owner-detail-map.json`,
with its command and limitations recorded under F50. Nothing was applied to the
target, and the coordinator's refactor-ai checkout was never modified.

`profiles.json` summarizes two additional successful CPU-profiled plans, with
identical IDs to the corresponding R3 benchmark. Full profiles remain in
`/tmp/refactor-r3-profile`; their timings are excluded from the paired medians.
Node main-thread blocking IPC samples do not account for native Go CPU.
