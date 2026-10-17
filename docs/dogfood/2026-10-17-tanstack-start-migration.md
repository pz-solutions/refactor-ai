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
- Proposal: when out-of-root files come from workspace packages, suggest the workspace root (nearest `package.json` with `workspaces`) in the error.

### F3. Planning cost on a large project — open (perf)
- `plan rename` on `apps/web` with `--root .`: ~30 s wall, ~44 s CPU. Fine for one-off renames, too slow for a 30-file batch done as 30 plans. Batch operations (directory move) matter more than micro-optimizing.

### F4. No operation moves a module (functions/components) — new operation `move-file`
- `move-type` only moves class/interface/type/enum declarations; `rename-file` only renames in place after a type. Framework migration moves whole modules, mostly React components, often whole directories, and across workspace packages.
- Required semantics found in practice: importers in other packages must use the package's `exports` subpath (never `../../packages/x/src/...`); a missing export entry must be added; importer packages must declare the dependency; `tsconfig` `paths` aliases (`@/…`) inside moved files must be rewritten or reported.

### F5. Shim modules that only re-export the shared package — new operation `inline-reexports`
- After earlier extractions the Next app kept files like `data-table/items.ts` = `export * from "@uber-platform/app-features/data-table/items"` and `table-print/table-print-button.tsx` mixing a re-export with its own component. They block directory moves (name collisions in the target) and hide the real dependency graph.

### F6. Swapping an API-compatible module (`next-intl` → `use-intl`) — open (candidate operation)
- 15 imports in `data-table`, including `NextIntlClientProvider` → `IntlProvider` in tests. Done with `sed`. A `retarget-import` operation (`--from next-intl --to use-intl --map NextIntlClientProvider=IntlProvider`) with type-checked validation would make this safe and repeatable across the remaining ~400 `next-intl` imports.
- Also needed: adding `use-intl` to `apps/web/package.json` first (isolated linker → not resolvable otherwise). The validation step would have caught a missing dependency as a new diagnostic.

### F7. Single-file operations re-typecheck the whole program twice — fixed
- `plan imports --mode sort` on one file of `apps/web`: 37 s wall / 52 s CPU. The engine computes semantic diagnostics for every program file before and after, although only one file changed.
- Proposal: validate the **affected closure** — changed files plus their transitive importers (reverse module graph of the original program) — and fall back to the whole program when a changed file is a script, declares `declare global`/module augmentation, or edits a config. Same guarantee for module code, typically a 10–100× smaller check for leaf files.
- Fix (`perf: validate only the affected closure`): single-project operations check the changed files plus their transitive importers; scripts, `.d.ts`, `declare global` and ambient module declarations fall back to the whole program. uber-platform: imports sort 37 s → 12 s, rename 30 s → 12 s (8 affected files each).

### F8. Cross-project `move-type` rejects monorepo packages with different `paths` — open (blocker)
- Slice agent (profile): `plan move-type … --target-project packages/app-features/tsconfig.json` → `PROJECT_OPTIONS_INCOMPATIBLE: … differ in compiler option 'paths'`. Apps and packages in a monorepo almost always differ in `paths` (`@/*` in the app only). The check should compare the options that affect how the *moved declaration's* imports and its importers resolve, not require identical configs.

### F9. Rename keeps the old public name behind an alias — open (UX)
- Renaming `ProfileContent` → `ProfileView` produced `export { ProfileView as ProfileContent }` in the barrel; the agent removed the alias by hand. Useful default for libraries, wrong during a migration where all consumers are in the workspace. Proposal: `--public` (rename re-exported names too when every consumer is loaded).

### F10. TypeScript formatter ≠ repository formatter — open (docs/hook)
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
