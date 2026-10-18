---
name: refactor-move-file
description: Move whole TypeScript or JavaScript modules or directories within or between workspace packages, updating imports, package exports and project file lists with compiler tooling.
---

Resolve `<skill-root>` to the directory containing this installed `SKILL.md`. Run `node "<skill-root>/scripts/refactor.mjs" plan move-file --help` for required inputs, options, supported languages, limitations and examples. The launcher's `--help` lists all commands and the plan workflow; help requires no project or dependency installation.

Use the deterministic runner to plan, preview, validate and apply the same plan within the user's authorized request. Set `--root` to cover source, destination and callers; use `--target-project` across projects. Review planned package exports alongside source edits. Report conflicts, missing package dependencies and unresolved alias imports as runner errors; source edits must come from the engine. Replan when the snapshot changes.

For multi-step refactorings, consider a custom script using the [importable API](scripts/API.md).

For workspace migrations, stop dev servers and let generators settle before planning. Use `--checker ts7` when the repository typechecks with TS7; the default remains TS5.

1. Prefer one `move-file` plan with repeatable exact module mappings, for example `--map @/lib/convex-hooks=@scope/features/hooks --map next-intl=use-intl`. Mappings affect only moved files’ imports/re-exports. `--only Name,Name` selects original named exports and splits declarations using retarget-import semantics; default/namespace imports require it absent. Root `.refactor-ai/equivalents.json` (for example `{"next-intl":"use-intl"}`) supplies defaults only for alternatives the destination declares; explicit mappings win. Use alternatives only when their APIs fit the call sites: compiler validation does not prove runtime compatibility.
2. If preparation needs export/binding renames or runtime adapters, retarget aliases first in the source project (`plan retarget-import --file <source-dir>`), preview/apply, then move. Move shared dependencies before their consumers. Preview package exports and caller rewrites alongside the moved imports before applying.
3. Run the destination’s typecheck and affected application tests. Missing dependencies and unresolved aliases identify preparation still needed; fix and replan.

New TS plans record compiler reads, including configs, dependencies and negative resolution probes. Unrelated files outside that read set can change; changes to read inputs or edited paths require replanning. Empty plans apply successfully despite other changes. Legacy plans and backends without read tracking retain whole-root freshness.

In a monorepo set `--root` to the workspace root. After `apply`, run the project's own formatter and linter on the changed files; the engine formats with the TypeScript formatter.
