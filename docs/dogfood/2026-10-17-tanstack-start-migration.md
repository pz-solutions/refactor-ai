# Dogfood log: uber-platform Next.js → TanStack Start (2026-10-17)

Target: `wooboo/uber-platform` monorepo (Bun workspaces, isolated `node_modules/.bun` linker, TypeScript 6.0.3 + tsgo 7, `moduleResolution: bundler`, ~900 files in `apps/web`). Migration strategy: extract framework-free modules from the Next app (`apps/web`) into the workspace package `@uber-platform/app-features` (explicit per-file `exports`), then render them from TanStack Start (`apps/web-start`).

Each entry: what the migration needed → what refactor-ai did → outcome (fixed / new operation / open).

## Findings

### F1. Snapshot rejected the whole repo because of unrelated symlinks — fixed
- Need: plan any operation with `--root .` in a repo that commits agent-skill symlinks (`.pi/skills/*`).
- Got: `SYMLINK_UNSUPPORTED: .pi/skills/caveman` before analysis.
- Also: the snapshot walked ignored build caches (`.next`, `.wrangler`, `test-results`, …) on every plan/validate/apply.
- Fix (`fix: snapshot monorepos…`): inside Git, fingerprint tracked + unignored files only; record symlinks by link text. Writes through symlinks are still rejected (plan-time `assertRegularPath`, apply-time staleness).

### F2. Monorepo scope needs `--root <repo>` — fixed (hint)
- `plan rename --project apps/web/tsconfig.json` fails with `PROJECT_SCOPE_INCOMPLETE` listing ~100 files from sibling packages (resolved through workspace symlinks). The fix is `--root .`, but the error does not say so.
- Fix: the error names the enclosing workspace (nearest `package.json` with `workspaces`) to pass as `--root`.

### F3. Planning cost on a large project — improved
- `plan rename` on `apps/web` with `--root .`: ~30 s wall, ~44 s CPU. Fine for one-off renames, too slow for a 30-file batch done as 30 plans. Batch operations (directory move) matter more than micro-optimizing.

- Status: single-project operations validate only the affected closure (F7); multi-project file operations too (`perf: validate workspace file-operation closures`, 76 s → 54 s on a cross-package move). A 31-file directory move still takes ~2 min.

### F4. No operation moves a module (functions/components) — new operation `move-file`
- `move-type` only moves class/interface/type/enum declarations; `rename-file` only renames in place after a type. Framework migration moves whole modules, mostly React components, often whole directories, and across workspace packages.
- Required semantics found in practice: importers in other packages must use the package's `exports` subpath (never `../../packages/x/src/...`); a missing export entry must be added; importer packages must declare the dependency; `tsconfig` `paths` aliases (`@/…`) inside moved files must be rewritten or reported.

### F5. Shim modules that only re-export the shared package — new operation `inline-reexports`
- After earlier extractions the Next app kept files like `data-table/items.ts` = `export * from "@uber-platform/app-features/data-table/items"` and `table-print/table-print-button.tsx` mixing a re-export with its own component. They block directory moves (name collisions in the target) and hide the real dependency graph.

### F6. Swapping an API-compatible module (`next-intl` → `use-intl`) — new operation `retarget-import`
- 15 imports in `data-table`, including `NextIntlClientProvider` → `IntlProvider` in tests. Done with `sed`. A `retarget-import` operation (`--from next-intl --to use-intl --map NextIntlClientProvider=IntlProvider`) with type-checked validation would make this safe and repeatable across the remaining ~400 `next-intl` imports.
- Also needed: adding `use-intl` to `apps/web/package.json` first (isolated linker → not resolvable otherwise). The validation step would have caught a missing dependency as a new diagnostic.

### F7. Single-file operations re-typecheck the whole program twice — fixed
- `plan imports --mode sort` on one file of `apps/web`: 37 s wall / 52 s CPU. The engine computes semantic diagnostics for every program file before and after, although only one file changed.
- Proposal: validate the **affected closure** — changed files plus their transitive importers (reverse module graph of the original program) — and fall back to the whole program when a changed file is a script, declares `declare global`/module augmentation, or edits a config. Same guarantee for module code, typically a 10–100× smaller check for leaf files.
- Fix (`perf: validate only the affected closure`): single-project operations check the changed files plus their transitive importers; scripts, `.d.ts`, `declare global` and ambient module declarations fall back to the whole program. uber-platform: imports sort 37 s → 12 s, rename 30 s → 12 s (8 affected files each).

### F8. Cross-project `move-type` rejects monorepo packages with different `paths` — fixed
- Slice agent (profile): `plan move-type … --target-project packages/app-features/tsconfig.json` → `PROJECT_OPTIONS_INCOMPATIBLE: … differ in compiler option 'paths'`. Apps and packages in a monorepo almost always differ in `paths` (`@/*` in the app only). The check should compare the options that affect how the *moved declaration's* imports and its importers resolve, not require identical configs.

- Fix (`perf: validate workspace file-operation closures`): resolution-only options (`paths`, `baseUrl`) may differ; unresolved aliases in the moved declaration fail as `NEW_DIAGNOSTICS`, rebinding to a different declaration as `REFERENCES_NOT_PRESERVED`.

### F9. Rename keeps the old public name behind an alias — open (UX)
- Renaming `ProfileContent` → `ProfileView` produced `export { ProfileView as ProfileContent }` in the barrel; the agent removed the alias by hand. Useful default for libraries, wrong during a migration where all consumers are in the workspace. Proposal: `--public` (rename re-exported names too when every consumer is loaded).

### F10. TypeScript formatter ≠ repository formatter — documented (skills + README recipe)
- Agents ran `vp check --fix` (oxfmt) after every apply; refactor-ai's edits use the TS formatter's style. Proposal: skills tell the agent to run the project's formatter on changed files after `apply`; optionally `--format-command`.

### F11. Positions (`--at line:col`) are error-prone for agents — open (UX)
- Two failed renames before the right one: wrong column hit `useLocale` (`RENAME_UNAVAILABLE`). Proposal: `--symbol <name>` (top-level declaration by name, error if ambiguous) as an alternative to `--at`.

### F12. Slice agents still moved modules by hand
- Profile slice: whole module + function moved into the shared package, next-intl → use-intl, `@/lib/formatters` → relative shared path, package `exports` entry, tests adapted — all manual. `move-file` + `retarget-import` + `inline-reexports` now cover the first three; the next slices must be briefed to use them.

### F13. Index modules exported as `…/index` — fixed
- First real `move-file` (apps/web/src/lib/hooks → app-features/src/shared/data, 61 files) planned `@uber-platform/app-features/shared/data/index`. Index modules now publish the directory key (`./shared/data`, `.` for `src/index`).

### F14. `.refactor-ai/` showed up as untracked in the user's repo — fixed
- The state directory now carries its own `*` `.gitignore`.

### F15. Test mocks name modules by string — fixed
- After the hooks move 21 Vitest cases failed: `vi.doMock("@/lib/hooks", …)` still named the old path, so the mock silently stopped applying. `vi|vitest|jest` `.mock/doMock/unmock/importActual/requireActual/…` first arguments are now module specifiers for every operation. Redoing the move with the fix rewrote all mocks; frontend suite back to green (except F16).

### F16. Retargeting a module leaves tests mocking the old one — fixed
- `next-intl` → `use-intl` in the data table broke 8 tests that `vi.doMock("next-intl", …)`: the code under test now reads `use-intl`. `retarget-import` now reports those loaded test files by default; `--mocks add` clones standalone mock registrations for the new module, with compiler validation and existing-destination deduplication.

### F17. Moves inside a package keep package self-imports — fixed
- After retarget (`@/contexts/organization-context` → `@uber-platform/app-features/shell/organization-context`) and the move into app-features, the moved hooks imported their own package by name. Should become relative (`../../shell/organization-context`) like other same-package imports. Originally fixed by hand; `move-file` now rewrites resolved destination-package self-imports in moved files using the package’s relative extension style.

### F18. Moves must carry lint-suppression ledgers — fixed
- ESLint bulk suppressions (`eslint-suppressions.json`) are keyed by file path per package. Moving `profile-content` into app-features moved 17 suppressed violations into an unsuppressed location; the entry had to be pruned from the Next ledger and re-added to the package ledger by hand. `move-file` now transfers nearest-ledger entries and merges rule counts, retaining JSON ordering. Missing destination ledgers are created only for packages with an ESLint config; otherwise dropped entries require review in plan notes.

### F19. Changed-file gates flag untouched complexity — process
- Fallow's changed-file audit treated two components whose only change was a rewritten import as new findings. Mass import rewrites widen "changed files" for every gate; expect it and keep such moves in dedicated commits.

### Coordinator lessons (for the migration skills)
- Ground every slice brief in the source: the `/dashboard/invitations` brief described an accept/decline page from the route name; the route only redirects to `/dashboard/settings/invitations`. The implementer correctly stopped.
- Build the CLI (`bun run build`) before integration tests that execute `dist/`; stale `dist` produced two false failures after merging branches.
- Throughput: `move-file` on 900-file app: ~110 s per plan (two full program checks in the multi-project path; F7's affected-closure validation is single-project only so far).

### F20. `inline-reexports` keeps shims reachable through dynamic `import()` — open
- `data-table/preferences.ts` (`export * from "@uber-platform/app-features/data-table/preferences"`) stayed because two tests do `await import("@/components/data-table/preferences")`. For a pure single-origin `export *` shim, a dynamic import of the shim is equivalent to a dynamic import of the origin; the operation could retarget it (the namespace object differs only if the origin has a default export, which `export *` drops).

### F21. `TARGET_UNRESOLVED` in a fresh worktree without `node_modules` — open (hint)
- Two slice agents hit `TARGET_UNRESOLVED … (use-intl)` in freshly created worktrees; the cause was a missing `bun install`, not the specifier. When the destination does not resolve and the importer's package has no `node_modules`, say so.

### F22. Moving into a package that lacks a third-party dependency — open (hint)
- Data-table move: the only blocker was `TS2307 Cannot find module 'use-debounce'` in the destination package. `move-file` could list third-party imports of moved files that the destination `package.json` does not declare, with the source package's version, before the expensive validation.

### F23. Lint configuration does not move with the code — process
- Moved components carried `eslint-disable shadcn/no-restyle` directives that became "unused" because app-features had no `components.json`, so the shadcn rules silently ignored every UI import there (since the first extraction). Adding the config restored identical lint coverage. Recipe now says to compare the destination's lint setup.

### F24. `UNHANDLED_PROJECT_GRAPH` when another app imports the moved files — open
- MCP slice: `apps/web-start` already imported the shared module being moved, but was not part of the planned project graph; the agent had to shelve its new Start files to make the plan pass. Workspace packages that depend on the destination (or import changed files) should be discovered and validated automatically, or accepted via `--include-project`.

### Outcome of the day
- uber-platform `feat/tanstack-start-migration`: 6 routes served by Start at parity (properties list/new, profile, settings/invitations, settings/integrations/mcp, invitations redirect); hooks layer, data table, invitation/owner/tenant/MCP hooks moved into app-features by `move-file`; 8 shims removed by `inline-reexports`; framework imports retargeted by `retarget-import`.
- Tool runs on the real repo: ~25 plans; failures were all genuine (missing dependency, missing install, stale snapshot from concurrent edits, out-of-graph project) except F13/F15/F17 which were fixed the same day.

### F25. `allowImportingTsExtensions` rejected an unrelated within-package move — fixed
- A formatter move within app-features rejected an importing Start project because only Start enabled `allowImportingTsExtensions`. No extension-bearing import needed to change.
- This flag governs whether a participant accepts `.ts` specifiers; it does not require a common editing setting. Each participant's diagnostics remain authoritative. Tests accept the harmless mismatch and reject a move introducing a new TS5097 in the destination.
- Source/destination syntax/emit incompatibilities are now checked from parsed configs before constructing a Workspace. Discovered participants still require graph discovery before their compatibility can be decided.

### F26. Relocation blockers were diagnosed only after expensive semantic checks — fixed (F21/F22)
- Disk-only move prechecks resolve moved-file imports at the destination. Unavailable unmoved aliases fail `MOVE_IMPORT_UNRESOLVED`; missing destination dependencies fail `MISSING_DEPENDENCY`, including source versions. Missing installations include the package path and install advice. Multiple blockers are reported together.
- Aliases between moved files, relative imports and destination self-imports remain eligible for the engine's rewrites. Existing unresolved/ambient imports defer to compiler validation. A resolver success does not bypass semantic or binding checks.
- `retarget-import` also includes an installation hint when an unresolved target's importing package has no `node_modules`.

### F27. Clean plans do not need an original diagnostic baseline — fixed
- Validate the planned affected closure first. If it contains no errors, it cannot introduce an error: skip the original baseline and record that fact in notes (`diagnosticsBefore: []`). If it has errors, compare against the original multiset, preserving repeated identical diagnostics.
- Single-project validation retains the original Program instead of restoring overlays and rebuilding the LanguageService. Both original and planned module graphs feed the affected closure. Newly reached ambient dependencies trigger a full check, including files without import edges. Options/global/declaration diagnostics remain checked.
- Project-reference declaration builds retain full before/after checks. Tests cover errors introduced two re-export hops away, new ambient effects, unchanged existing errors, config/global fallbacks and clean comparison mode.

### F28. Holding workspace checkers simultaneously exhausted the default Node heap — fixed; one approach rejected
- Removing F25's false rejection exposed a valid three-project move that needs substantially more checking than the old early failure.
- Reusing a LanguageService for each validation project was rejected: `getProgram()` eagerly initializes a checker, so both versions of all participants approached/exceeded the default 4 GB heap. Two exploratory runs aborted around 111–116 s; they are not final timings.
- Keep one editing LanguageService/DocumentRegistry. Validation shares parsed SourceFiles, uses plain Programs for graph discovery and checks/releases participants sequentially; the edit service's semantic cache is released after binding verification when no project references need it. Baselines are built only if planned errors require comparison.

### F29. Persistent baseline diagnostics require complete invalidation — implemented, opt-in
- `REFACTOR_AI_CACHE=on` stores original-baseline diagnostics under `.refactor-ai/cache`; `REFACTOR_AI_CACHE_DIR` supports an external directory. Cache keys cover pinned compiler/options, roots, selected files, source and dependency contents, and module formats.
- Every hit replays recorded compiler filesystem inputs: contents, negative existence probes, directory membership and realpaths, including inputs outside the root. Unstable inputs prevent persistence. Corrupt, missing or unavailable caches are misses; directory symlinks are ignored. Planned diagnostics are never cached.
- Staleness tests cover dependency changes reaching a two-hop consumer, source/config options, package manifests, previously missing paths, new type directories and corrupt entries. Cache remains off by default: clean plans skip baselines, while hashing and replaying inputs costs time.

### F30. Optional warm planning — implemented for single-project operations
- Author CLI `serve --root <repo>` accepts sequential NDJSON plan requests on stdin and replies on stdout; EOF disposes programs. It retains up to four LanguageServices and invalidates them by content hashes plus the complete compiler input trace. Plans keep normal snapshot, output and validation rules.
- `bench:warm` measures five distinct rename plans in one process without applying. Tests cover deterministic repeated plans, dependency/config/new-root invalidation, malformed requests, root confinement and error recovery. Workspace operations still construct fresh workspaces.

### F31. Native diagnostics: Microsoft TS7 and Theo's Rust port — spike
- Investigated actual current packages: Microsoft `typescript@7.0.2`, Theo `tsc-rs@0.7.0` (targets TS7.1 dev), and its matching Go nightly. The old `@typescript/native-preview` tag is not current TS7. Theo's project is `pingdotgg/ts-rust`, distinct from `tsz`.
- Both published JS APIs passed virtual two-hop re-export, file-create/delete and package-exports invalidation probes. Rust requires `ensurePrograms: true` when updating dirty snapshots. These are redesigned, unstable APIs; retain TS5.9 edit production and a differential correctness gate before accepting native validation.
- Rust `--fast` is excluded because upstream documents diagnostic differences/nondeterminism. No native runtime dependency or authoritative checker switch was added. See [primary-source investigation and reproducible probes](../research/2026-10-18-native-checkers.md).

### F32. Unmapped retargets rebuilt the editing program after every file — fixed
- The cross-package formatter retarget still spent ~70–77 s after the validation shortcut. The operation called `renameBindings` and reloaded the Program per file even when no export map existed.
- Without `--map`, prepare all text transformations against the original immutable SourceFiles, then install the overlays as one batch. Mapped operations retain sequential semantic renaming. Existing retarget/mapping/mock tests cover both paths; final validation still checks the full affected closure.

### F33. Full-suite prerequisites were not installed in the benchmark environment — verification setup
- The machine had a .NET host but no SDK. Installed official .NET SDK 8.0.426 under `/tmp/refactor-ai-dotnet`, with temporary CLI-home/NuGet directories for tests; no system installation or main-checkout changes.
- Installed npm 11 under `/tmp/refactor-ai-test-tools` for the existing packaging tests. System npm 12.0.2 returns a package-keyed object for `npm pack --json`; those tests assume npm 11's array. Supporting both response shapes remains a packaging-test follow-up, separate from this performance change.

### F34. Slice agents abandoned refactor-ai after repeated relocation failures — key outcome; partially addressed
- Live users slice: moving `apps/web/src/components/invitations/link-user-search.ts` to `packages/app-features/src/users/link-user-search.ts` repeatedly hit missing installation/dependency diagnostics, Next-generated project membership changes, and stale snapshots. The agent gave up and moved files manually. Owners also moved view/columns manually; exact commands and errors are not yet available. Treat successful tool-assisted completion versus abandonment as the primary dogfood metric, with latency and rejection reasons explaining it. No successful retry of these slices has been observed yet.
- F26 now handles a declared source dependency even when neither installation resolves it. The error says `add fuse.js@<source version> to <destination>/package.json`, followed by workspace-install advice. A regression test uses an unresolved `fuse.js` import and source version `^7.1.0`; this fails without constructing a Program. Existing unknown/ambient imports still defer to the checker.
- Missing destination installation with an installed source remains an early resolver check. An absent local `node_modules` is an actionable hint, not by itself proof of failure: hoisted or ambient dependencies can be valid. Do not reject every package without that directory.

### F35. Dev-server generated inputs caused membership and snapshot races — actionable errors; safe relaxation queued
- Reported writers: `next-env.d.ts`, TanStack `routeTree.gen.ts`, `.next/`, and `convex/_generated`. A running Next server regenerated `next-env.d.ts` during analysis, causing `PROJECT_MEMBERSHIP_CHANGED`; long 30–40 s checks also increased the opportunity for `STALE_SNAPSHOT`.
- Stale-analysis and stale-apply errors now enumerate added/removed/changed paths. Known generated path patterns are marked `[generated candidate]`. Membership errors use the same labels and mention dev-server generators. A regression test proves an edited `next-env.d.ts` is both identified and still rejected. The labels are hints, not permission to ignore inputs.
- Snapshot collection already omits ignored, untracked Git output such as an ignored `.next/`; tracked and unignored files remain guarded. A file outside one config's roots may still supply ambient types, resolution metadata or inputs to another workspace project. Automatically ignoring generated files or accepting a fresh snapshot after checking older content would be unsafe.
- Queued: capture a complete semantic/read dependency set and original/planned affected closure, distinguish external membership churn from intended root edits, then retry/re-snapshot only after proving changed inputs cannot affect validation, bindings or apply safety. No broad exclusion or automatic acceptance was shipped. Shorter analysis and F26 reduce exposure, but the concurrent-generation race remains open.

## Performance measurements (2026-10-18)

Read-only target: `/home/wooboo/.t3/worktrees/uber-platform/t3-2595fe92`, commit `836bbf32`. CLI baseline: `8fc4a63`. Node 22.23.2, Bun 1.4.0, pinned checker 5.9.3. Fresh Node processes; OS caches retained; two repetitions, median below. Machine shared with other agents running builds/E2E, so timing variation is substantial. Some verification overlapped the later cold runs. Do not interpret small changes as speedups or regressions. Plans/reports/cache experiments used `/tmp`; target sources and main refactor-ai checkout were never changed.

| Scenario | Original ms | After validation changes ms | Final ms | Result |
| --- | ---: | ---: | ---: | --- |
| Rename shared formatter | 15,448 | 19,904 | 19,904 | Validated; noisy cold comparison |
| Cross-package move with app alias | 67,601 | 1,745 | 1,745 | Fails early with both alias and dependency advice |
| Move formatter within app-features | 25,469 | 117,078 | 117,078 | Original falsely rejected; final generates valid plan across three projects |
| Retarget formatter imports across packages | 70,901 | 73,251 | 30,250 | F32 batching pays; both final runs validated |
| Inline formatter re-export shim | 128,420 | 181,821 | 181,821 | Both valid; cold comparison inconclusive under changing load |

An additional consecutive old/new rename control, one run each after the full suite,
was **19,771 → 10,281 ms**. Keep this separate from the initial medians; it supports
the clean-baseline shortcut without hiding the noisy earlier results. Unmapped
retarget samples after batching: **32,519 / 27,980 ms** (vs 76,774 / 69,727 ms at the
validation-only step). No speedup is claimed for making the previously rejected
within-package move succeed.

A second consecutive old/new control for inline-reexports was **152,686 → 152,508
ms** (one run each). This is effectively unchanged; baseline skipping did not
produce an end-to-end gain for that operation. Keep the initial noisy medians in
the table rather than replacing them with this later single sample.

Opt-in phase telemetry (`REFACTOR_AI_TIMINGS=on`, stderr only) is stored in the raw
results. At the validation-only step, the within-package move spent 54,075 / 64,992 ms
in validation, 13,935–17,036 ms loading its workspace, and 14,479 / 20,391 ms in move
edits. Inline validation took 47,982 / 60,487 ms; graph/operation work still matters.
No whole-program baseline was computed for these clean planned sets.

Five distinct rename plans through the shipped stdio server, without apply:
**14,842 / 11,966 / 11,352 / 9,420 / 11,584 ms**. First call includes cold startup;
later median is **11,468 ms**. This is bounded single-project warming, not a promise
of subsecond plans. Cache is off by default and was off for these target runs:
all planned sets were clean, so baseline-cache hits would provide no benefit.

Full native CLI check of `packages/app-features/tsconfig.json`, two fresh runs each,
`--noEmit --incremental false --composite false --pretty false --extendedDiagnostics`:

| Checker | Mean ms | Sampled peak RSS MiB | Error count |
| --- | ---: | ---: | ---: |
| TypeScript 5.9.3, JavaScript | 18,893 | 849 | 0 |
| Microsoft TypeScript 7.0.2, Go | 3,465 | 986 | 0 |
| Microsoft 7.1 dev matching Rust's pin | 3,026 | 898 | 0 |
| Theo `tsc-rs` 0.7.0, Rust | 1,393 | 585 | 0 |

RSS is approximate, sampled from Linux `/proc` every 25 ms. Native CLI gains do
not include the TS5.9 editing engine or snapshot work. Rust's fair comparison is
the matching Go nightly (~2.17×), not a different compiler release.

Five actual validated rename plans were then supplied as overlays to each native
API session, checking all program/config/global/syntactic/semantic diagnostics and
asserting that each changed source contains its planned text. No source was applied:

| Native API | Initial full baseline ms | Five full planned-check times ms |
| --- | ---: | --- |
| Go 7.0.2 | 4,186 | 3,567 / 3,503 / 3,107 / 3,444 / 3,448 |
| Rust 0.7.0 | 1,681 | 1,811 / 1,928 / 1,911 / 1,732 / 1,837 |

Every check returned zero errors. These times exclude edit generation and the
normal refactor-ai snapshot checks, so they are **diagnostic feasibility**, not
end-to-end plan latency. Negative virtual-fixture probes additionally verify
two-hop errors, deletion/creation and package exports changes. Native checkers
remain optional experiments: broad diagnostic equivalence to pinned TS5.9 and
multi-project declaration builds are not established. No `--checker` production
switch or native dependency was shipped.

Raw samples: [baseline](perf-2026-10-18/baseline.json),
[validation step](perf-2026-10-18/validation-step.json),
[retarget batch](perf-2026-10-18/retarget-batch.json),
[warm plans](perf-2026-10-18/warm.json),
[native CLI](perf-2026-10-18/native-full.json),
[Go overlays](perf-2026-10-18/native-overlays-go.json),
[Rust overlays](perf-2026-10-18/native-overlays-rust.json),
[rename control before](perf-2026-10-18/rename-control-before.json),
[rename control after](perf-2026-10-18/rename-control-after.json),
[inline control before](perf-2026-10-18/inline-control-before.json),
[inline control after](perf-2026-10-18/inline-control-after.json).

Verification: `bun run typecheck`, `bun test` (**266 passed, 0 failed**, 1,290 assertions) with the
temporary .NET8/npm11 toolchain described in F33, and `bun run build` passed.
Generated skill bundles are committed separately from source/tests/docs.

Follow-ups: native checker adapter with explicit compiler-version policy and
differential negative tests; real cross-package overlays/project-reference emits;
workspace graph/inline profiling; bounded cache eviction; npm12 pack-test output
compatibility. F9/F11/F20 UX changes and new project-selection flags were not added.
Concurrent generated-input handling and a successful users/owners retry remain
open (F34/F35); no abandonment-rate improvement is claimed without that evidence.

## Performance round 2 (2026-10-18)

### F36. Overlay directory existence scanned every edit for every module lookup — fixed

`node --cpu-prof` on a valid in-package formatter move at `19f86ab` attributed
13.8 s inclusive sampled time to `VirtualFs.directoryExists`, 9.9 s to its repeated
containment checks, and 16.0 s self sampled time to GC (69.0 s profiled process). Each
lookup allocated all virtual paths, then normalized and compared them against
the directory. A move edits many importers, making this proportional to edits ×
resolution probes. Index virtual ancestor directories once per overlay version;
cache normalized paths and immutable per-plan disk directory metadata. Ordinary
directory enumeration uses Dirents, statting symlinks only. Original/planned
views, generated declaration changes, creations and deletions invalidate the
virtual index. Before accepting a plan, replay cached directory membership and
existence against disk, including ignored generator inputs. A mismatch fails with
`STALE_PROJECT_INPUTS`; regression tests cover ignored generated roots and cached
negative probes. Snapshot/membership checks remain strict; this does not relax F35.

### F37. File operations repeatedly parsed sources and resolved identical modules — fixed

The same move profile attributed 8.3 s inclusive sampled time to workspace module
resolution and 4.3 s to compiler source construction. Workspace resolution now
shares a `ModuleResolutionCache` per compiler-options object and overlay version,
preserving usage-location resolution mode. Any overlay/config/generated-output
transition (including entering/leaving the original view) replaces the caches.
Syntax consumers retain original and planned parses by text/context; immutable
module-specifier walks are memoized by SourceFile. Compiler parses remain separate
from syntax-only parses, preserving forced module detection. The workspace still
has one editing LanguageService/DocumentRegistry shared by all participants;
compiler hosts acquire parsed documents from that same registry. Discovery
Programs are reused only when roots/options are identical, there are no edits
and no project-reference outputs. Validation uses sequential plain Programs,
avoiding F28's eager-checker memory regression.

### F38. Native checker selection is explicit and auditable — implemented, opt-in

`--checker ts7` / API `checker: "ts7"` uses only Microsoft Go 7.0.2 for diagnostic
passes of the planned in-memory filesystem. Edits, graph discovery and closure
analysis remain on pinned TS5.9.3. The exact npm alias
`typescript7: npm:typescript@7.0.2` is a development dependency and optional peer
in TS-capable distributions. No runtime installer or download fallback exists.
Node 22+ is required for the native sync IPC API; Bun cannot expose its pipe file
descriptors. Project-reference declaration builds fail explicitly in native mode.

`--checker both` audits TS5+TS7 on every selected pass, comparing file+error code
with multiplicity. Any disagreement rejects the plan with `CHECKER_MISMATCH`.
Both native modes verify exact user-source membership against the TS5 graph and
preserve options/config/global/syntax/semantic/declaration checks. Every TS plan
records checker identity/version; audit plans also record their TS5 reference.
TS7-only diagnostics are not a claim of semantic equivalence to 5.9.3 outside the
corpus. The coordinator explicitly authorized this distinction: uber-platform's
own app-features typecheck already uses TS7; project checks still run after apply.
TS7-only mode checks all user sources in each participant with batched API
calls, rather than trusting a closure derived from another compiler version.
Default remains TS5.9.3.

The differential corpus covers two-hop re-export breakage, create/delete/missing
roots, package exports switching, path aliases, JSX props, declaration merging,
`satisfies`, generic inference and ambient augmentation. It executes both audit
and native-only passes. Actual rename/move/inline/retarget plans run in both modes.
A real TS7/TS5 ES5-option incompatibility and injected missing/duplicate diagnostics
prove audit mismatches reject plan creation. Native API processes always close in
`finally`; they never write the target tree.

F35 safe relaxation remains deferred: these profiles did not establish a complete
read-set proof for accepting concurrent generated-input churn.

Round 2 reproduction (run from the perf worktree):

```sh
# Build a separate baseline without switching or modifying the main checkout.
mkdir -p dist/r2-baseline-src
git archive 19f86ab src | tar -x -C dist/r2-baseline-src
bun build dist/r2-baseline-src/src/cli.ts --target node --format esm \
  --external typescript --outfile dist/cli-before-r2.js
bun run typecheck
bun run build
PATH=/tmp/refactor-ai-test-tools/node_modules/.bin:/tmp/refactor-ai-dotnet:$PATH \
  npm_execpath=/tmp/refactor-ai-test-tools/node_modules/npm/bin/npm-cli.js \
  DOTNET_ROOT=/tmp/refactor-ai-dotnet DOTNET_CLI_HOME=/tmp/refactor-ai-dotnet-home \
  NUGET_PACKAGES=/tmp/refactor-ai-nuget bun test --timeout 60000
bun scripts/bench-r2.ts /home/wooboo/.t3/worktrees/uber-platform/t3-2595fe92 \
  dist/cli-before-r2.js dist/cli.js /tmp/refactor-r2-verified-paired
```

The benchmark alternates baseline/default/ts7/both within each repetition, runs
three repetitions per scenario, disables persistent caches, retains OS caches and
never applies a plan. Reports include binary hashes, target commit, per-plan
snapshot/edit hashes, phase timings and load averages. Raw plans/stdout/stderr stay
under `/tmp`; the compact report and CPU profile summaries are committed alongside
this log. Large `.cpuprofile` files remain under `/tmp/refactor-r2-profile`.

Verification setup notes: a focused run hit an existing 5 s test timeout under
concurrent E2E load. The first full run passed 289 tests but its packed-npm test
selected system npm12 despite PATH; `npmCli()` prefers `npm_execpath` and standard
installation locations. Explicitly setting `npm_execpath` to npm11 is required.
No packaging assertions were weakened. The first inline CPU capture rejected with
`REEXPORT_UNRESOLVED` after 14.3 s; exclude that rejection from successful-plan
speed comparisons. A later intermediate inline capture successfully planned in
46.5 s; its operation itself took 1.37 s. These individual profiled runs establish
hotspots, not the paired latency results below.

### F39 — shared registry requires parent links before graph queries

A real in-package formatter move exposed a regression missed by the initial small
fixtures: DocumentRegistry parses without node parents. The editing language
service binds its own option bucket, but another participant with a different
`target` can still have an unbound source. Calling `getModeForUsageLocation` on
that source crashed with an undefined `node.kind` during validation preparation.
Compiler-host user sources now acquire parent links once per source object,
including JSDoc children, before graph queries. A regression fixture uses two
participants with different language targets and checks the downstream TS2322;
this retains shared registry reuse without depending on lazy checker binding.

### F40 — queued: move and import adaptation in one plan

Owner-detail evidence: nine plans in
`/home/wooboo/.t3/worktrees/uber-platform/t3-f29f750b/test-results/owner-detail-refactor-log.md`.
The 0.630 s / 0.820 s alias prechecks and 0.547 s dependency precheck confirm the
round-one fail-fast improvement. They still leave migration agents without a
workable next action. After this performance round, add repeatable move-file
module mappings (`--map from=to`) applied inside the same moved-file overlay,
with the same module matching rules as retarget-import. Examples: app alias to
package import, form-dialog alias to relative package import, next-intl to
use-intl, routing import to an injected port. Distinguish module mappings from
retarget-import's existing exported-name mappings in the public API.

For MISSING_DEPENDENCY, consider explicit repository-maintained equivalents in
`.refactor-ai/equivalents.json`, e.g. `{"next-intl":"use-intl"}`. Suggest a declared
equivalent only from that configuration; do not infer API compatibility or advise
adding a framework dependency to a deliberately framework-free package. Mapping,
resolution and normal planned diagnostics must still succeed. This is queued,
not implemented in round two.

### F41 — queued: empty apply and proven read-set staleness

The owner-integration retarget took 8.080 s, produced no changes and passed
validation, but apply rejected changes to `e2e/app/people/owner-detail.spec.ts`,
`e2e/app/people/owners.spec.ts` and `e2e/route-coverage.ts` with STALE_SNAPSHOT.
An empty plan should apply successfully. For nonempty plans, replace the blanket
project snapshot only after recording a complete read set: edited files,
validation contents, config/package resolution inputs, failed probes and directory
membership that affects roots/module resolution. Unrelated test edits should not
invalidate a plan. This also supplies the proof needed for F35; do not simply
exclude generated directories or tests. Queued after the current goal.

### F42 — queued: owner-return-url cold move remains slow

The same owner-detail log records 54.810 s for the in-package move
`owners/owner-return-url.ts` → `shared/dashboard-return-url.ts`, touching six files
and validating 31 affected files across app-features/web/web-start. Its apply was
then invalidated by an independently changed owner-detail source. Keep this real
migration as a follow-up benchmark in addition to the formatter scenario used in
round two. Do not count fast rejected plans as completed migrations.

### F43 — first slice completed with zero manual moves

The coordinator reports user-detail as the first slice whose complete move used
refactor-ai: seven successful plan/preview/apply cycles, all applied, with zero
manual moves. Evidence:
`/home/wooboo/.t3/worktrees/uber-platform/t3-150b40ca/test-results/user-detail/refactor-ai.log`.
The successful sequence prepared imports in the SOURCE directory before moving:
next-intl → use-intl (11.976 s), form-dialog alias → shared package export
(11.523 s), breadcrumb alias → shared package export (18.142 s), and
`../users-content` → package import (19.541 s after one failed attempt). Then the
hook, controls and detail moves all applied. The log also records a useful
0.561 s unresolved-alias precheck rejection; it is not one of the seven completed
cycles.

Completion is a positive result even though planning remains slow: the three
successful move plans took 155.186 / 60.850 / 66.108 s on the coordinator's
round-one distribution. Their previews took 0.423 / 0.357 / 0.356 s and applies
0.773 / 0.709 / 0.699 s. Across all seven cycles preview/apply medians were
0.359 / 0.709 s (ranges 0.311–0.496 / 0.554–1.157 s). These observational slice
runs are not controlled round-two before/after measurements. They strengthen F40:
a combined mapping+move plan can eliminate repeated preparation cycles. The
move-file skill now teaches the proven source-retarget-then-move recipe,
destination dependency checks and post-apply project verification.

### F44 — benchmark rejection is not a latency win

The final move series' third repetition encountered concurrent work in the target.
TS7 rejected directory membership churn under `packages/app-features/src` with
STALE_PROJECT_INPUTS after 64.577 s; the following audit failed INVALID_PACKAGE in
2.053 s because `packages/app-features/package.json` had Git conflict markers.
The preceding baseline/default plans had completed in 190.066 / 112.255 s. Retain
all four records, but exclude this incomplete pair from successful paired medians.
The next inline baseline was interrupted after 19.832 s when the merge conflict
was detected; it is not a completed latency sample. Benchmarks were stopped, the
read-only target left untouched, and isolated fixture tests run while its writers
settled. This is direct evidence that the metadata freshness guard catches real
changes; it is not a TS7 parity failure or grounds for weakening F35.

Round-two verification of the final engine: `bun run typecheck` and
`bun run build` passed; the full `.NET8`/npm11 run passed **295/295 tests** across
19 files (1,390 assertions, 334.85 s on the shared machine). This includes 24
native tests: ten differential corpus entries in both modes, eight actual
operation/mode combinations, two cross-package/symlink moves, two defensive plan
metadata mutation cases, and two explicit mismatch rejection cases. The native
corpus is green for the supported fixtures; the intentional ES5 configuration
incompatibility remains a verified rejection in audit mode, not a compatibility
claim. The final fixture baseline for JSX is valid before its planned prop error.
The move skill's focused documentation edit also passes `quick_validate.py`.

### F45 — remaining latency is cold graph/edit setup and diagnostics

The final successful move series has three complete baseline/default/ts7/both
repetitions, identical snapshots and identical edit hashes throughout. Its default
TS5 median is 62.994 s versus baseline 99.416 s; TS7-only is 40.454 s, audit 72.319 s.
Median move-edit work is 14.202 → 3.012 s; workspace discovery is 10.976 → 9.109 s;
validation is 49.021 → 40.394 s. New timing boundaries also expose 4.984 s for the
editing service program. TS7-only validation takes 17.783 s, including 16.183 s in
three native diagnostic sessions. Per-phase medians do not add up exactly to the
median complete process.

The virtual-directory/resolution/parse work has materially improved; the target
of reliably sub-30 s moves has not been reached on this machine. Native checking
still leaves TS5 editing and exact graph discovery, and native-only mode checks
all user sources in each participant. Potential follow-ups are cheaper exact
participant discovery and sharing a native session across projects within one
immutable filesystem view; either needs its own lifetime/invalidation proof and
paired measurements. Follow-ups must preserve exact graph membership, snapshot
invalidation between filesystem views and input freshness.

During the final inline series, repetition two's baseline rejected after 140.379 s
with three TS2307s in tenant-detail for the concurrently removed invitation
components. Subsequent new-engine plans were clean on the next target snapshot:
100 planned changes in repetition one became 97 after the source migration.
The target advanced from 95ff838d to 8e1f5cf4. Retain the rejection, exclude that
incomplete repetition from paired medians, and run a replacement complete pair.
The valid comparison requires snapshot/edit equality within each repetition;
source changes between repetitions are recorded rather than treated as
nondeterministic planner output.

### Final paired results and recommendation

Seconds: median (min–max), three **complete successful** pairs per scenario,
cache off, cold Node 22.23.2 processes, OS cache retained, no apply.

| Scenario | R1 TS5 | R2 TS5 default | R2 TS7 only | R2 both audit |
| --- | --- | --- | --- | --- |
| rename | 18.5 (12.5–19.1) | 15.8 (10.0–16.8) | 12.0 (10.0–16.6) | 28.0 (18.3–30.7) |
| retarget-import | 30.3 (24.1–32.1) | 27.3 (22.8–32.2) | 18.8 (16.6–21.3) | 40.3 (32.8–40.7) |
| inline-reexports | 126.0 (123.0–151.4) | 27.5 (24.8–35.3) | 19.8 (17.5–24.8) | 34.8 (33.3–38.2) |
| move-file | 99.4 (88.5–106.6) | 63.0 (55.5–63.4) | 40.5 (35.0–45.1) | 72.3 (64.0–84.4) |

All four variants in each selected repetition have identical snapshot and edit
hashes. Rename/retarget use the earlier R2 binary before the workspace parent-link
repair; those operations do not use Workspace, and the later defensive metadata
copy does not change CLI serialization. Move uses the final binary and one fixed
snapshot for all 12 plans. Inline uses successful main repetitions 1 and 3 plus
the replacement repetition: the migration changed its scope from 100 to 97 files
between repetitions. The rejected main repetition 2 is excluded in full. The
paired comparisons within each repetition remain identical-input comparisons;
these shared-machine measurements do not isolate all effects of system load.

[Compact reports, selected pair identities and phase medians](perf-r2-2026-10-18/README.md)
include every rejection separately; [summary.json](perf-r2-2026-10-18/summary.json)
and [standalone results table](perf-r2-2026-10-18/results.html) are derived from the
selected successful pairs. Large profiles and full plan/stdout/stderr files stay
under the documented `/tmp/refactor-r2-*` paths.

The largest end-to-end improvement is inline: 126.0 → 27.5 s with default TS5
(4.6×), or 19.8 s native-only (6.3×). Move improves 99.4 → 63.0 s default (1.6×),
or 40.5 s native (2.5×); its edit phase is 4.7× faster. The ~10 s typical / ~30 s
move targets are **not reliably met**. Native inline reaches the ~30 s target in
all three selected runs, but move and typical rename still need work.

Recommendation: use explicit `--checker ts7` on uber-platform, whose own package
check already uses TS7, and use `--checker both` for audits. Keep the shipped
default TS5.9.3. The modern differential corpus and actual supported-operation
audits are green, but rename latency ranges overlap, one native rename pair was
slower, ES5 options have a verified compiler-version disagreement, and native
project-reference declaration builds remain unsupported. This evidence does not
justify automatic TS7 selection whenever installed; reassess after those limits
and the remaining cold graph/session costs are addressed. tsc-rs remains research.

Queued follow-up work is F40 mapping/equivalents, F41 empty-apply/read-set
staleness and F42 the owner-return-url scenario; F43 records the first zero-manual-
move slice and the source-retarget-then-move skill recipe. F35 remains deferred
until a complete read-set proof is available.

## Performance round 3 (2026-10-18)

### F46 — prepare compatible imports and move in one plan

`move-file --map from=to` now accepts repeatable exact **module** mappings in the
CLI and a `map` object in the API. It transforms only the moved files' static
imports/re-exports before relocation checks and reference preservation. It reuses
retarget-import's declaration transform, including `--only` original export names,
splitting, comments, type-only imports and explicit local/public aliases. Mappings
are simultaneous: swaps/chains do not cascade. Other files receive only the normal
move's caller rewrites. Export/binding renames and runtime adapters still need
source preparation; a module map does not establish API/runtime equivalence.

Root `.refactor-ai/equivalents.json`, e.g. `{"next-intl":"use-intl"}`, supplies
default maps only when the destination manifest declares the alternative. Explicit
maps override defaults. Missing-dependency errors suggest the declared equivalent
(`destination declares use-intl; map next-intl=use-intl`) rather than adding the
framework package. A partial `--only` can leave an unmapped binding and receive
this hint. Undeclared alternatives do not become defaults; genuine dependencies
such as sonner still need declaration/installation or an API-compatible mapping.
Malformed configuration and unsupported selections fail before program loading.
The absent/present equivalents file is itself a recorded input.

### F47 — read-set freshness, including genuinely empty apply

New TS plans use schema 3. `snapshot` holds edit preconditions, while `readSet`
records deterministic compiler filesystem observations: file contents, configs,
package manifests, negative file/directory probes, symlink resolution and relevant
matching directory queries. Discovery uses a config-name glob instead of treating
every directory entry under the workspace as a compiler input. Native callbacks
also record their disk reads even when Go performs the actual read. Cached disk
observations are immutable within one analysis and replayed before plan creation
and application. VFS overlays/generated declarations are not mistaken for disk
changes. Imported libraries and ignored generator inputs remain protected.

Unrelated files outside the recorded reads may change, appear or disappear,
including between backend analysis and plan serialization. Such changes also no
longer change a new plan's ID. Tests prove that changed transitive importers,
configs, dependencies, new importers, generator roots and negative lookups still
invalidate; late destination/case collisions and symlink replacements still fail.
All graph-discovery/compiler sources remain inputs: this does **not** promise that
an arbitrary test inside a loaded TS program can change safely. Empty plans skip
freshness checks even after config changes/source deletion. Legacy schema 1/2 and
backends without observed reads (including Roslyn) retain conservative whole-root
freshness for nonempty plans; they are not silently weakened.

### F48 — native validation lifetime and move overhead

TS7-only mode already checks every user source, so constructing TS5 before/after
validation graphs did not narrow native diagnostics. It now builds original
validation programs only when a diagnostic baseline or output-layout proof needs
them. A clean move skips that work. Native participants in one diagnostics call
share a session/snapshot opened with all their configs; it closes in `finally`
before edits, original-baseline checking or a later validation call. Programs from
different VFS views never share a native session. TS5 membership comparison,
full native diagnostics, audit parity and project-reference rejection remain.

Read tracking initially increased latency (a pilot took 34.2 s). Avoiding repeated
compiler filesystem queries, replaying metadata once per guard and omitting the
unused whole-root **after** snapshot recovered that overhead. String-input hashing
avoids JSON-escaping full source text. Pilot samples are not the final benchmark.
The final paired series below uses no concurrent tests started by this agent.

### F49 — reproducible round-three measurements

The runner is `scripts/bench-r3.mjs`. It records three sequential r2/r3 pairs for
an in-package formatter move and a cross-package KSeF forwarding-module move.
Both are current files in the read-only target; the original KSeF implementation
has already migrated, so the cross-package scenario explicitly moves its remaining
app forwarding module. These are not measurements of the historical full owner
slice. Every sample records target commit/status, binary hashes, checker identity,
validation, edit hash, read count, load averages and phase times. Full plans and
stderr/stdout stay under `/tmp/refactor-r3-final-bench`; compact records belong in
`docs/dogfood/perf-r3-2026-10-18/`. Plans are never applied to uber-platform.

```sh
node scripts/bench-r3.mjs \
  /home/wooboo/.t3/worktrees/uber-platform/t3-2595fe92 \
  /tmp/refactor-r3-baseline/cli.mjs "$PWD/dist/cli.js" \
  /tmp/refactor-r3-final-bench
```

The r2 CLI is copied from the untouched 780dd67 distribution before rebuilding
this worktree; its optional dependencies resolve through a temporary symlink to
this worktree's node_modules. New schema-3 snapshots intentionally differ in scope
from r2. Compare exact edit hashes and successful validation, not snapshot hashes
across schemas. Each variant must also be deterministic across all repetitions on
the same target state. Rejected plans are retained and never counted as speed wins.

### F50 — real owner-detail plan and the changed target state

The historical log's source app component is now an adapter; the implementation
and invitation files have already moved into app-features. Restoring those files
would violate this round's read-only-target constraint. The actual current
owner-detail implementation nevertheless produces a successful **single** move
plan with repeated module mappings, caller/export rewrites and suppression-ledger
transfer, validated across three projects, with zero source writes:

```sh
cd /home/wooboo/.t3/worktrees/uber-platform/t3-2595fe92
node /home/wooboo/.t3/worktrees/refactor-ai/perf/dist/cli.js plan move-file \
  --project packages/app-features/tsconfig.json --root . \
  --file packages/app-features/src/owners/owner-detail-client.tsx \
  --to packages/app-features/src/owners/detail/owner-detail-client.tsx \
  --map '../shared/convex-hooks/owner=@uber-platform/app-features/shared/convex-hooks/owner' \
  --map '../shell/organization-context=@uber-platform/app-features/shell/organization-context' \
  --checker ts7 --out /tmp/refactor-r3-owner-detail-map.json
```

Result: `planned`, validation `passed`, seven changes, three projects, 64,667
recorded reads, plan ID
`ba5193c86c07c990cdab7413ee01fae35c95a83c3df11f0a19250178bc458a9e`.
The two mapped self-package imports normalize to `../../shared/convex-hooks/owner`
and `../../shell/organization-context` at the new path. This demonstrates the
current file's combined map/move workflow, not a replay of the original app-to-
package extraction. App-only routing and notification ports in that original
slice still require real adapters; map does not invent them. No apply was run.

### Final round-three results and verification

Seconds, median (min–max), **three successful pairs per scenario**, TS7 only,
Node 22.23.3, cold processes, persistent cache off, OS cache retained:

| Scenario | R2 on current target | R3 | Delta |
| --- | --- | --- | --- |
| In-package formatter move | 28.85 (28.22–29.11) | 28.56 (28.34–29.09) | −0.29 s (−1.0%) |
| Cross-package KSeF forwarding module | 25.48 (21.66–25.74) | 28.06 (27.56–33.76) | +2.58 s (+10.1%) |

Both requested medians meet 30 s. This is **not** an across-the-board latency win:
the additional read-set guarantees cost time, and cross-package regresses in the
paired current-target series. One cross-package run exceeds 30 s. The historical
40.45 s R2 formatter median is background, not the control for this series: the
fresh R2 control already takes 28.85 s under current machine/toolchain conditions.
Do not attribute the full historical reduction to this patch.

All 12 plans passed, exact edit hashes match across variants, and each variant's
three repeated plan IDs match. The target stays clean at
`8e1f5cf4f7afa8ab8ea2549f3556a497d56e2a47` throughout. New read counts are 64,648
(in-package) and 62,965 (cross-package); this remains sizeable plan metadata.
Phase medians expose the tradeoff: in-package native diagnostics 10.19 → 9.67 s,
validation 11.59 → 10.76 s, preparation 0.75 → 0 s, but metadata guarding
0.04 → 0.76 s. Cross-package discovery 5.53 → 6.78 s and validation
9.48 → 11.29 s offset preparation 1.42 → 0 s. Phase medians need not sum to the
complete-process median; shared-machine load and GC remain material.

Verification: `bun run typecheck`, `bun run build` and the complete
`.NET8`/npm11 `bun test --timeout 60000` pass: **310/310 tests**, 1,435 assertions,
20 files, 251.53 s. The temporary toolchain uses .NET 8.0.426 and npm 11.21.1,
with `npm_execpath` explicitly set as in round two. The move skill passes
`quick_validate.py`; `git diff --check` is clean. No tests were weakened to hide
schema changes: legacy schema tests remain, while new TS plans explicitly expect
schema 3. Installed skills and npm package relocation tests verify compiler lookup
from their own runtime, without bundling TypeScript into the lightweight skill API
wrapper or adding a TS dependency to C# packages.

Remaining scope: runtime adapters/export-binding renames still require preparation;
read files inside a loaded TS program remain freshness inputs even when their
diagnostics are outside the affected closure; Roslyn and legacy nonempty plans
retain whole-root freshness; 30 s is a measured median, not a bound on every move.
Large read sets and cold discovery/editing remain optimization opportunities.

Separate successful `--cpu-prof` captures for both scenarios are summarized in
[profiles.json](perf-r3-2026-10-18/profiles.json); full 23–25 MB profiles stay in
`/tmp/refactor-r3-profile`. They reproduce the same plan IDs as the paired series.
Profiled wall times are 28.59 / 22.43 s and are **excluded** from the table. The
Node main-thread samples show native blocking IPC in `read` (8.19 / 5.52 s), GC
(4.12 / 3.45 s), TS scanning (0.90 / 0.76 s), path canonicalization and hashing.
They do not measure native Go CPU. Cold parsing, retained graph/checker memory and
resolution IO remain the useful next targets; source-parent correctness and
filesystem-view boundaries still constrain sharing. A final rebuild preserves the
exact CLI binary hash used in the measurements.

## Round four — events and utility-readings migration friction

### F51 — atomic batch moves and directory exclusions

R3 repeated project discovery, union-program construction and native validation
for every events file. R4 accepts repeatable `--file source=destination` pairs
(API `moves: [{ file, target }]`) and canonicalizes them before one workspace
analysis. Interdependent files move as a set: project-cycle checks inspect the
final graph rather than intermediate states. Directory `--exclude` uses the
existing tsconfig glob matcher, relative to each source directory. Excluded Next
pages, preload hooks and adapters stay in place and their imports still update.
Explicit source/destination collisions and overlaps are rejected. Batch movement
preserves relative imports, JSON resources, triple-slash references and source
file permissions. The normal membership, package-export, reference and diagnostic
guards still apply.

```sh
export PATH=/usr/local/bin:$PATH
node dist/cli.js plan move-file --project apps/web/tsconfig.json --root . \
  --file 'apps/web/src/app/[locale]/dashboard/events/event-search-params.ts=packages/app-features/src/events/event-search-params.ts' \
  --file 'apps/web/src/app/[locale]/dashboard/events/events-client.helpers.ts=packages/app-features/src/events/events-client.helpers.ts' \
  --target-project packages/app-features/tsconfig.json --map next-intl=use-intl \
  --checker ts7 --out /tmp/events-batch.json

node dist/cli.js plan move-file --project apps/web/tsconfig.json --root . \
  --file 'apps/web/src/app/[locale]/dashboard/events' \
  --to packages/app-features/src/events --exclude page.tsx \
  --exclude '**/_hooks/**' --exclude '*adapter*' \
  --target-project packages/app-features/tsconfig.json --map next-intl=use-intl \
  --checker ts7 --out /tmp/events-directory.json
```

These commands assume runtime ports/types have been prepared, as in the real
slice. Exclusions cannot make a client component independent of an excluded
server module that it still imports. Run in the disposable target described in
F57, not in an active migration worktree.

### F52 — declaration selection copies the selected dependencies

The r3 help's `move-file --only` described import-binding filtering, while the
slice used it to extract `TenancyEventFilters`, `TenancyEventsPage` and
`TenancyEvent`. R4 gives this operation the intended declaration-selection
meaning: compiler `Move to file` refactors move selected exported declarations,
copy necessary imports and update semantic callers. Contiguous selections move
together; nonadjacent selections reuse the same analysis and destination. A
compiler-generated self-import from an earlier selection is removed. The
unselected preload function and its framework-only import stay in the source.
Required imported symbols are checked for preservation, so a same-spelled alias
in the destination cannot silently rebind a selected declaration.

```sh
export PATH=/usr/local/bin:$PATH
node dist/cli.js plan move-file --project apps/web/tsconfig.json --root . \
  --file 'apps/web/src/app/[locale]/dashboard/events/_hooks/preload-events.ts' \
  --to packages/app-features/src/events/types.ts \
  --target-project packages/app-features/tsconfig.json \
  --only TenancyEventFilters,TenancyEventsPage,TenancyEvent \
  --checker ts7 --out /tmp/events-types.json
```

Supported selections: exported types/interfaces, functions and safe classes/enums.
Runtime variables, merged declarations, default exports and re-export selections
require preparation. Selection currently takes one file and a new destination;
whole-file batches remain separate. For the old r3 mapping-only `--only` behavior,
run `retarget-import --only` before moving. This is an intentional CLI/API behavior
change, documented in help and the TS move skill.

### F53 — E2E stale inputs are discovery reads, not a whole-root fallback

Events failed on `readFile .../e2e/app/properties/dashboard-events.spec.ts`.
Utility-readings supplies the same proof for both operations:

- `inline-reexports`: `readFile .../e2e/app/properties/utility-readings.spec.ts`.
- `_components` move: `readFile .../e2e/utility-readings.spec.ts`.
- `_lib` apply: `readDirectory .../<root>` changed; the log does not include that
  query's arguments, so it cannot establish which matching path was added/removed.

These are **STALE_PROJECT_INPUTS**, not STALE_SNAPSHOT. Both paths use
`analyzeFileOperation`, return `inputs.snapshot()` and create schema-3 plans.
`Workspace.loadGraph` calls `importsAffected` for other configs. The root
uber-platform tsconfig includes `e2e/**/*`; its discovery program reads those
specs to prove whether they import moved/changed modules. Discovery reads join
the exact read set even when that project never joins native validation.
Content edits may change its imports, ambient declarations or project inclusion;
discarding those reads would invalidate that proof. The read-set guard worked as
designed. No unsafe narrowing was made.

A regression now covers discovery-only project reads becoming stale, alongside
the existing test proving unread E2E content does not affect plan identity or
freshness. Stale messages now explain discovery inputs and print directory query
arguments. Serialize writers to those inputs during mechanical operations.

```sh
export PATH=/usr/local/bin:$PATH
bun test tests/read-set.test.ts --test-name-pattern 'discovery-only|unread content'
```

### F54 — references to a future destination are valid expectations

Previously module-reference counts included only callers resolving to the source.
A pre-existing adapter import of the destination was unresolved, so resolving it
after a move looked like a new unexplained reference. R4 records original
unresolved edges and admits an additional expected caller only when its unchanged
specifier now resolves to a moved destination. Existing resolved edges still
must bind to their original relocated target; arbitrary count increases remain
rejected. A future package import also publishes the anticipated destination export when no resolved source caller exists yet.

```sh
export PATH=/usr/local/bin:$PATH
bun test tests/typescript-move-file.test.ts --test-name-pattern 'pre-existing unresolved destination|future destination'
```

For the real slice, an adapter may already import
`@uber-platform/app-features/events/events-client` before the batch publishes that
path. No temporary source-path rewrite is required.

### F55 — mocks follow moved APIs and deleted transparent shims

`inline-reexports` retargets vi.mock, vi.doMock and vi.importActual (and the other
recognized Vitest/Jest module calls) before removing a transparent single-origin
shim. It retains shims when their renamed or split exports require a runtime
adapter, and explains why. `move-file --map` rewrites module literals in moved
tests, including nested actual imports; transformations are simultaneous.
Factories remain unchanged. Unmoved transitive consumers get a mock report;
`--mocks add` keeps original registrations and clones registrations for the
mapped module. These resolutions use the tracked filesystem/overlay view.

```sh
export PATH=/usr/local/bin:$PATH
bun test tests/typescript-inline-reexports.test.ts --test-name-pattern 'retargets mock|retains shims'
bun test tests/typescript-move-file.test.ts --test-name-pattern 'move mappings retarget|mocks add'
```

### F56 — state configuration, consumer hints and named-import maps

Generated `.refactor-ai/.gitignore` is now `*`, `!equivalents.json`, `!.gitignore`.
CLI/apply and the diagnostics cache upgrade the exact legacy generated `*\n`
content; custom ignore contents are preserved and symlinks are not followed.
`equivalents.json` remains eligible for version control. NEW_DIAGNOSTICS move
errors list affected consumer paths and suggest adapting them first or batching
dependencies. Package dependency hints also name the importing and imported path.

Optional goal 7 is included: `--map 'next-intl#NextIntlClientProvider=use-intl#IntlProvider'`
can accompany `--map next-intl=use-intl`. Named imports/re-exports target the new
export while retaining their local/public names through explicit aliases. JSX
and shadowed local references therefore keep their original binding. The rule
applies to moved test files too. Mock factories still need runtime API review;
export mapping does not rewrite arbitrary object keys or actual-module accesses.

```sh
export PATH=/usr/local/bin:$PATH
bun test tests/snapshot.test.ts --test-name-pattern 'generated state ignore'
bun test tests/typescript-move-file.test.ts --test-name-pattern 'named module maps|participant validation'
```

### F57 — reproducible events benchmark and limits of the comparison

The disposable worktree `/tmp/ra-target` starts at
`9f66b9dc4c2177cf7141b67984849d89a11688f2`, with `bun install` there. Active
uber-platform worktrees and the coordinator's refactor-ai checkout are untouched.
`prepare-r4-events.py` reconstructs all 13 original pre-move source texts from the
recorded events previews, reverses already-moved intra-slice imports, and stages
the actual type split and Next adapter from events commit `67b19ec8`. The column
test's provider name is corrected to `IntlProvider`, as in the final slice. These
runtime preparations are required for a valid framework boundary; this is not a
claim that an unprepared whole Next route can move unchanged.

`bench-r4.mjs` runs three full single-plan sequences with the unchanged 59f05a8
runtime and three atomic batches with R4. Single mode applies plans **only in the
disposable /tmp worktree**, then restores exact pre-run contents. Batch mode
never applies. Plan latency excludes apply; stdout, stderr, complete plans,
phase timings, checker identity, CLI hashes, load averages, read counts and
fixture statuses are retained. Each successful run must leave the same fixture
status. No performance sample uses a failed plan.

```sh
export PATH=/usr/local/bin:$PATH
# Run from the implementation checkout; create /tmp/ra-target at 9f66b9dc first.
python3 scripts/prepare-r4-events.py /tmp/ra-target \
  /home/wooboo/.t3/worktrees/uber-platform/t3-791f7838/.scratch/events/refactor.log
node scripts/bench-r4.mjs /tmp/ra-target /tmp/refactor-r4-baseline/cli.mjs single /tmp/ra-r4-singles
node scripts/bench-r4.mjs /tmp/ra-target "$PWD/dist/cli.js" batch /tmp/ra-r4-batches
```

The original events log records 45 commands / 558.850 s, including rejected plans,
previews and applies. Its successful 13-plan sum is historical context, not the
same-machine control above. R4 does not claim to make every one-file plan faster;
the benefit is avoiding twelve repeated analyses.


### Final round-four measurements

Seconds; three complete runs each, Node v24.22.0, Bun 1.4.3, TS7 7.0.2,
cold processes, persistent cache off, OS cache retained. Single controls ran
first, then batches; these are sequential series, not interleaved pairs. No agent
tests ran during the recorded series. Load averages are in the compact report.

| Run | R3: sum of 13 single plans | R4: one 13-file batch |
| --- | ---: | ---: |
| 1 | 276.485 | 20.305 |
| 2 | 265.848 | 20.264 |
| 3 | 254.915 | 19.735 |
| Median | 265.848 | 20.264 |

Median reduction **92.38%**, **13.12×**; every batch is below 60 s.
All 42 plans pass. The three batch IDs and exact edit hashes match; each records
51,351 compiler observations and 29 changes. All three single
sequences produce identical final bytes. Their changed-path sets match the batch,
and 28/29 file contents are byte-identical. Only package.json differs: sequential
moves publish helper entries needed by their intermediate source-project callers;
the batch only publishes its required entry points. This is intentional public-
surface reduction, not a missing import rewrite. The historical events 13-plan
sum was 442.933 s; it is excluded from the controlled comparison.

Compact evidence: [summary.json](perf-r4-2026-10-19/summary.json). Full plans and
logs remain in `/tmp/ra-r4-singles` and `/tmp/ra-r4-final-batches`; earlier pilots
are excluded. Both series leave the prepared /tmp fixture's status unchanged.


The original `--only` failure is also replayed on a separate **clean**
`/tmp/ra-only-target` at 9f66b9dc, with its own `bun install`: the unchanged R3
CLI rejects `@/lib/preload-authenticated`; the final R4 CLI passes with zero
after-diagnostics, retaining the preload function and copying only the selected
types/imports. No plan is applied, and Git status stays clean. Raw evidence:
`/tmp/ra-r4-only-before.log`, `/tmp/ra-r4-only-after.log` and the after plan.

A further real directory plan excludes `page.tsx`, `**/_hooks/**` and `*adapter*`,
while the retained Next adapter already imports the **future destination**. It
moves exactly the same 13 files, publishes the anticipated view export, and
passes native validation with zero diagnostics. It is never applied; the
adapter's temporary fixture edit is restored. Full plan/log:
`/tmp/ra-r4-directory-future.json` and `.log`. These repros are excluded from
performance samples.

The [interactive report](perf-r4-2026-10-19/results.html) includes the table,
demo commands and remaining boundaries.


Verification: `bun run typecheck`, `bun run test --timeout 60000` and
`bun run build` pass: **326/326 tests**, 1,491 assertions, 20 files, 239.81 s.
The new machine needed a temporary user-local .NET **8.0.426**, installed at
`/tmp/ra-dotnet8`; npm **11.19.1** was selected explicitly with `npm_execpath`.
The TS move skill passes `quick_validate.py`; `git diff --check` is clean.
The final rebuilt CLI SHA256 matches the one measured in all three final batches.
Re-running the committed preparation script preserves the prepared fixture status;
the separate declaration-repro worktree remains clean. Generated skill runtimes,
SDK declarations and copied API docs belong in a separate commit from sources.
No push or apply to an active user worktree was performed.

## Round five — verification modes and warm workspace serve (2026-10-22, UP-207)

Retro data: successful wave 4–9 plans had a 31 s median; 12 of 21 rejections
arrived after 8–43 s of full validation, and agents re-ran `check-types` anyway.

### F58 — `--verify bindings` separates editing from program diagnostics

`plan --verify full|bindings` (API `verify`). `full` stays the default and is
unchanged: full plans carry no `verify` field, and the new CLI reproduces the
r4 CLI's full plan IDs byte-for-byte in every paired run below. `bindings`
(TS/JS) still runs every precheck (graph discovery and membership, ownership,
dependency/alias prechecks, access/cycle/output-layout checks, case/encoding),
the operation's reference preservation (rename binding identity, moved import
edges and importer multisets, moved-type references/imports, inline re-export
resolution) and read-set freshness. It adds a checker-free check of each changed
file: syntax errors, and import/export bindings — every specifier resolves with
the owning project's options or an ambient `declare module`, and every named
import/re-export names a syntactic export of the resolved module (following
`export *`). Problems already in the original file are not attributed; for
`move-type`/`--only` a new target is compared with its source file.

It deliberately does **not** report type errors (tests: a mapped module whose
`a` became a string passes bindings and fails full with TS2322), declaration/
options/global diagnostics, or effects on unchanged files. Unprovable exports
(`export =`, CommonJS, scripts) are accepted; augmentation-only exports are
reported (use full). Project references fail `VERIFY_UNSUPPORTED`. Plans record
`request.verify: "bindings"`, no diagnostics and no `checker`; `validate`/`apply`
return `verify` and apply adds a typecheck reminder. A `none` mode was not added:
every operation's edits are semantic, and the binding check costs 0.01–0.15 s.

### F59 — committable repository defaults

`<root>/.refactor-ai/config.json`, e.g. `{"verify":"bindings","checker":"ts7"}`,
applies to TS plans; explicit options win, the configured checker applies only to
full verification, explicit `--checker` with bindings is rejected, unknown keys
fail `INVALID_REPO_CONFIG`. The generated state `.gitignore` keeps it tracked.

### F60 — where bindings time goes (cold)

Profiling the bindings formatter move (14.8 s first cut) showed graph discovery
(6.5 s) dominated: discovery programs parsed ~28 M chars of dependency `.d.ts`
per config. In bindings mode they only decide user-file reachability and are
never checked, so dependency/library declarations are empty stubs (a dependency
declaration cannot reach a user file except via a workspace-package symlink,
which canonicalization keeps inside root). Same project graph and edits; load
6.4 → 2.0 s. The backend's end-of-analysis read-set replay duplicated
`createPlan`'s later replay of the same entries and was removed (both modes,
0.7–0.9 s); `relativeStyle` reuses cached syntax parses. Remaining cold bindings
phases (in-package medians): editing LanguageService program 3.4 s (parse incl.
dependency declarations, resolution, checker init/binding), move edits 2.1 s,
discovery 2.0 s, external-project check 0.1 s, binding check 0.14 s; ~1.7 s is
process start, read-set replay (63 k reads) and plan serialization.

### F61 — warm `serve` for workspace operations

Workspace plans in `serve` share parsed documents across plans. Script versions
are now content identities and the shared DocumentRegistry is pinned, so a
retained parse is reused only for identical text. Each plan still re-reads and
records every compiler input (fresh `CompilerInputs`), so warm read sets — and
plan IDs — equal cold ones: 30/30 warm/cold pairs below are identical. Tests
replay new importers, a new importing config, a same-length text change and a
config exclude between warm plans, comparing each with a fresh CLI process, in
both modes. Mutation check: per-plan version counters with the shared registry
(naive sharing) fail both tests. Resolution (~1.5 s per warm plan) is not
cached across plans, to keep read sets exact.

### Final round-five measurements

Seconds, median (min–max), 3 runs each, cold Node v24.22.0 processes unless
serve, cache off, OS cache retained, variant order rotated per run, no apply.
Load average (1 min) 0.83–3.29 (uber) and 1.20–1.51 (R4). All 87 plans
passed; no rejected plan is counted. Edit hashes match across all variants.

| Scenario | r4 full (932b444, ts7) | full (ts7) | bindings |
| --- | ---: | ---: | ---: |
| In-package formatter move (129 files) | 24.83 (24.55–25.48) | 23.30 (23.10–23.40) | **9.49** (9.45–9.57) |
| Cross-package `workos-request-origin` | 23.32 (23.19–23.45) | 22.09 (22.03–22.18) | **8.37** (8.31–8.39) |
| R4 events 13-file batch (/tmp fixture) | 17.46 (17.37–17.49) | 16.48 (16.47–16.53) | **6.47** (6.46–6.52) |

Five distinct `packages/app-features/src/shared` moves per session (formatters,
business-clock, effective-date, search-params, token-scope), three sessions,
each paired with the same five plans in cold processes:

| Mode | Plan 1 | Plans 2–5 (n=12) |
| --- | ---: | ---: |
| bindings, cold | 9.49 | 9.09 (8.98–9.75) |
| bindings, serve | 9.23 | **4.33** (4.25–4.45) |
| full ts7, cold | 23.19 | 22.85 (22.66–23.06) |
| full ts7, serve | 22.76 | 15.56 (15.26–15.77) |

Targets (UP-207): move-file bindings ≤ 10 s cold — met (9.49 / 8.37 s); ≤ 5 s in
serve — met (4.33 s). Warm bindings phases: discovery 0.67, editing program 1.18,
move 1.17, binding check 0.01 s, plus ~1.2 s replay/serialization. Full warm
saves discovery and parsing (−7.3 s) but keeps 9.7 s of TS7 validation.
Bindings plans record 5–16 % fewer reads (stubbed discovery declarations).

The uber target (`t3-2595fe92`) started at b586fc5c; another agent committed
0e499840 (refactor-ai pin) at 12:51 during the series. Each scenario/variant
still produced a single plan ID across all runs and status stayed clean, so no
recorded input changed. The R4 fixture is a local clone at 9f66b9dc under /tmp,
prepared by `prepare-r4-events.py`; batches are never applied.

```sh
export PATH=/usr/local/bin:$PATH
node scripts/bench-verify.mjs /home/wooboo/.t3/worktrees/uber-platform/t3-2595fe92 \
  /tmp/ra-verify/baseline-cli.mjs /tmp/ra-verify/new-cli.mjs /tmp/ra-verify/bench-uber uber 3
node scripts/bench-verify.mjs /tmp/ra-target /tmp/ra-verify/baseline-cli.mjs \
  /tmp/ra-verify/new-cli.mjs /tmp/ra-verify/bench-r4 r4 3
```

Compact evidence: [summary.json](perf-verify-2026-10-22/summary.json); full plans
and phase traces stay under `/tmp/ra-verify`. The measured CLI is 3b9086e6…; the
final CLI adds bindings-failure hints and move-type/`--only` origin attribution
and reproduces the measured in/cross-package plan IDs in both modes.

Not done: F24 (`--include-project`). Importing configs of moved files are already
discovered automatically; configs importing other rewritten files still fail
`UNHANDLED_PROJECT_GRAPH` in both modes, and admitting them needs participant
changes beyond this round.

Verification: `bun run typecheck`, `bun run build` and the complete
`bun run test --timeout 60000` pass: **349/349 tests**, 1,640 assertions, 23
files, 229.20 s, with user-local .NET 8.0.426 at `/tmp/ra-dotnet8` and npm
11.19.1 via `npm_execpath`. New: `tests/verify-modes.test.ts` (11) and
`tests/serve-workspace.test.ts` (3). No push; no apply to uber-platform.
