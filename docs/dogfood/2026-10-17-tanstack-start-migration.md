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
