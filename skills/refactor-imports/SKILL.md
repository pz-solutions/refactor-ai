---
name: refactor-imports
description: Sort TypeScript or JavaScript imports, or remove unused TS/JS imports and C# using directives with existing compiler tooling.
---

Resolve `<skill-root>` to the directory containing this installed `SKILL.md`. Run `node "<skill-root>/scripts/refactor.mjs" plan imports --help` for required inputs, options, supported languages, limitations and examples. The launcher's `--help` lists all commands and the plan workflow; help requires no project or dependency installation.

Use the deterministic runner to plan, preview, validate and apply the same plan within the user's authorized request. Report conflicts and unsupported cases as runner errors; source edits must come from the engine. Replan when the snapshot changes.

For multi-step refactorings, consider a custom script using the [importable API](scripts/API.md).

In a monorepo set `--root` to the workspace root. After `apply`, run the project's own formatter and linter on the changed files; the engine formats with the TypeScript formatter.
