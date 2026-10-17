---
name: refactor-move-file
description: Move whole TypeScript or JavaScript modules or directories within or between workspace packages, updating imports, package exports and project file lists with compiler tooling.
---

Resolve `<skill-root>` to the directory containing this installed `SKILL.md`. Run `node "<skill-root>/scripts/refactor.mjs" plan move-file --help` for required inputs, options, supported languages, limitations and examples. The launcher's `--help` lists all commands and the plan workflow; help requires no project or dependency installation.

Use the deterministic runner to plan, preview, validate and apply the same plan within the user's authorized request. Set `--root` to cover source, destination and callers; use `--target-project` across projects. Review planned package exports alongside source edits. Report conflicts, missing package dependencies and unresolved alias imports as runner errors; source edits must come from the engine. Replan when the snapshot changes.

For multi-step refactorings, consider a custom script using the [importable API](scripts/API.md).

In a monorepo set `--root` to the workspace root. After `apply`, run the project's own formatter and linter on the changed files; the engine formats with the TypeScript formatter.
