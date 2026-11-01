# Round-two measurement artifacts

The parent [dogfood log](../2026-10-17-tanstack-start-migration.md#performance-round-2-2026-10-18)
contains findings, commands, verification and the final median/range table.
Reports retain all statuses; successful latency summaries require both exit 0 and
`validation.status: passed`. Rejections are never treated as speed improvements.

- `profiles.json`: sampled CPU summaries from the baseline and intermediate
  optimizations. One initial inline profile rejected; the successful intermediate
  inline profile is separate. Profile overhead is included, so these are hotspot
  evidence rather than the paired benchmark table.
- `pre-parent-fix-paired.json`: the first 40 paired samples. Rename/retarget use
  the regular backend and are unaffected by the later workspace parent-link fix;
  their three repetitions supply those two rows of the final table. Workspace
  inline results are superseded, and move failures document the caught regression.
- `interrupted-move.json`: final engine, series interrupted by a concurrent merge
  in the read-only target. Two repetitions succeeded; repetition three encountered
  directory churn and a conflicted package manifest. Fresh measurements supersede
  the entire series.
- `interrupted-inline.json`: explicitly interrupted baseline during that merge;
  not a completed latency sample.

The final workspace series use the same engine binary, fresh cold processes,
cache off and three sequential baseline/default/ts7/both repetitions per scenario.
Each report records Node version, target commit at series start, binary hashes,
per-plan snapshot/edit hashes, validation/checker identity, load and phase times.
Compact committed reports omit repeated notes and replace file lists with counts;
complete plans/stdout/stderr remain in the corresponding `/tmp/refactor-r2-*`
folders. Every plan is read-only analysis of uber-platform; none was applied.

- `paired-move.json`: final successful workspace move series (12 plans); all
  snapshots and edits match. It supplies the move row in the final table.
- `paired-inline-main.json` and `paired-inline-replacement.json`: final inline
  series plus one replacement pair. Summary selects main runs 1 and 3 and the
  replacement run; main run 2's rejected baseline is excluded together with its
  otherwise successful newer variants.
- `summary.json`: selected pair identities and per-variant median/range/samples,
  including phase medians. Each selected pair asserts successful validation and
  exact snapshot/edit equality across its four variants.
- `results.html`: standalone derived median/range table.
