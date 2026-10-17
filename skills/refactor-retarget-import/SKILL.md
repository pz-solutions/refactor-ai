---
name: refactor-retarget-import
description: Retarget TypeScript or JavaScript imports and re-exports to an API-compatible module, with optional export mapping and partial binding selection.
---

Resolve `<skill-root>` to the directory containing this installed `SKILL.md`. Run `node "<skill-root>/scripts/refactor.mjs" plan retarget-import --help` for required inputs, scope, mapping rules, limitations and examples (including next-intl to use-intl). The launcher's `--help` lists the plan workflow; help requires no project or dependency installation.

Use the deterministic runner to plan, preview, validate and apply the same plan within the user's authorized request. Review mapped local binding/JSX renames, declaration splits and destination merges in the preview. Confirm runtime API compatibility through application tests. Report conflicts and unsupported cases as runner errors; source edits must come from the engine. Replan when the snapshot changes.

For multi-step refactorings, consider a custom script using the [importable API](scripts/API.md).
