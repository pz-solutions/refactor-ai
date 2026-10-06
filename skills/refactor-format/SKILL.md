---
name: refactor-format
description: Format a TypeScript, JavaScript or C# source file deterministically with the TypeScript or Roslyn formatter.
---

Resolve `<skill-root>` to the directory containing this installed `SKILL.md`. Run `node "<skill-root>/scripts/refactor.mjs" plan format --help` for required inputs, options, supported languages, limitations and examples. The launcher's `--help` lists all commands and the plan workflow; help requires no project or dependency installation.

Use the deterministic runner to plan, preview, validate and apply the same plan within the user's authorized request. Report conflicts and unsupported cases as runner errors; source edits must come from the engine. Replan when the snapshot changes.

For multi-step refactorings, consider a custom script using the [importable API](scripts/API.md).
