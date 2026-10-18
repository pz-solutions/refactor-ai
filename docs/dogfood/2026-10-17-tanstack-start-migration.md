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
