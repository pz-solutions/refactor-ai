---
name: refactor-move-file
description: Move TypeScript or JavaScript modules as an atomic batch or directory, or extract selected exported declarations, updating callers, package exports and project file lists.
---

Resolve `<skill-root>` to the directory containing this installed `SKILL.md`. Run `node "<skill-root>/scripts/refactor.mjs" plan move-file --help` for required inputs, options, supported languages, limitations and examples. The launcher's `--help` lists all commands and the plan workflow; help requires no project or dependency installation.

Use the deterministic runner to plan, preview, validate and apply the same plan within the user's authorized request. Set `--root` to cover source, destination and callers; use `--target-project` across projects. Review planned package exports alongside source edits. Report conflicts, missing package dependencies and unresolved alias imports as runner errors; source edits must come from the engine. Replan when the snapshot changes.

For multi-step refactorings, consider a custom script using the [importable API](scripts/API.md).

For workspace migrations, use `--checker ts7` when the repository typechecks with TS7; the default remains TS5. Serialize writes to compiler inputs during planning/apply, including E2E files read during project discovery.

1. Prepare runtime ports and framework adapters, then batch mutually importing files in one analysis: repeat `--file src/a.ts=packages/features/src/a.ts --file src/b.ts=packages/features/src/b.ts` without `--to`. Pair order does not matter. For a mixed directory, use `--file src/route --to packages/features/src/route --exclude page.tsx --exclude '**/_hooks/**' --exclude '*adapter*'`. Exclusion globs are relative to each source directory; review retained adapters’ rewritten imports.
2. Combine relocation with exact module maps such as `--map @/lib/convex-hooks=@scope/features/hooks --map next-intl=use-intl`. Renamed imports use `--map 'next-intl#NextIntlClientProvider=use-intl#IntlProvider'` alongside the module map; the engine preserves local/public names through aliases. Moved test mock/actual specifiers follow module maps, keeping factory text unchanged. Review factory API names; `--mocks add` copies registrations in unmoved consumers while preserving their original mocks.
3. Extract types needed by shared modules before the batch: `--file src/route/_hooks/preload.ts --to packages/features/src/types.ts --only Filters,Page,Event`. Only selected exported declarations and required imports move. Unselected preload code stays. Variables with runtime initialization, merged declarations and re-exports require preparation. For the old r3 import-binding selection behavior, use `retarget-import --only` before moving.
4. Preview package exports, caller rewrites and suppression transfers. Run destination typecheck and affected application tests after apply. Missing dependencies, consumer diagnostics and unresolved aliases identify preparation still needed; fix and replan.

Root `.refactor-ai/equivalents.json` supplies default module maps only for alternatives declared by the destination; explicit maps win. Use alternatives whose APIs fit the call sites. Generated state ignores keep this file trackable. Compiler validation does not prove runtime compatibility.

New TS plans record compiler reads, including configs, dependencies and negative resolution probes. Unrelated files outside that read set can change; changes to read inputs or edited paths require replanning. Empty plans apply successfully despite other changes. Legacy plans and backends without read tracking retain whole-root freshness.

In a monorepo set `--root` to the workspace root. After `apply`, run the project's own formatter and linter on the changed files; the engine formats with the TypeScript formatter.
