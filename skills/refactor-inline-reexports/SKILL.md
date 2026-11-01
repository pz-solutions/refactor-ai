---
name: refactor-inline-reexports
description: Inline TypeScript or JavaScript shim re-exports into workspace callers through compiler-resolved origins, preserving public package entries.
---

Resolve `<skill-root>` to the directory containing this installed `SKILL.md`. Run `node "<skill-root>/scripts/refactor.mjs" plan inline-reexports --help` for inputs, options, limitations and examples. Help works before dependency installation.

Plan, preview, validate and apply the same plan within the user's authorized request. Use `--root` to include workspace callers; use `--keep` to retain a pure shim. Mixed modules retain their re-exports. Check application behavior when bypassing module initialization or directives such as `"use client"`; compiler diagnostics cannot verify these effects or external consumers.

Report unsupported cases as runner errors; source edits must come from the engine. Replan when the snapshot changes. For sequential automation use the [importable API](scripts/API.md).

In a monorepo set `--root` to the workspace root. After `apply`, run the project's own formatter and linter on the changed files; the engine formats with the TypeScript formatter.
