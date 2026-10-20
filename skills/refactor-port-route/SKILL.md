---
name: refactor-port-route
description: Port a Next.js App Router route to TanStack Start in one validated plan - move its client view into a feature package, generate the thin Next adapter and the Start route from the page's preload calls using project templates.
---

Resolve `<skill-root>` to the directory containing this installed `SKILL.md`. Run `node "<skill-root>/scripts/refactor.mjs" plan port-route --help` for inputs, rejected shapes and examples.

The project owns every API-specific choice in `<root>/.refactor-ai/port-route.json` and its templates (ports, query helpers, import paths, adapter/route file shapes, route-tree generator, post-apply commands). Start from `examples/port-route/uber-platform` in the refactor-ai repository when the project has none. Never hand-write the generated files from this skill; fix the configuration or prepare the view and replan.

1. Prepare the view so it is framework-free, as for `move-file`: replace Next-only hooks/components (`next/navigation`, app `Link`, app adapters) with props or ports the configuration can fill (`ports.<prop>`, `params`), declare missing destination dependencies, and extract shared types with `move-file --only`. Preloaded props must be consumed directly by the data hook: `const { data } = usePreloaded(preloadedX)` or `usePreloaded(preloadedX).data` in the rendered component. The plan reports blockers before loading programs (`MOVE_IMPORT_UNRESOLVED`, `MISSING_DEPENDENCY`) or as `PORT_ROUTE_*` errors naming the shape to change.
2. Plan with the workspace root and the TS7 checker when the repository typechecks with TS7:
   `node "<skill-root>/scripts/refactor.mjs" plan port-route --project apps/web/tsconfig.json --target-project packages/app-features/tsconfig.json --root . --route 'apps/web/src/app/[locale]/dashboard/<route>' --to packages/app-features/src/<area> --checker ts7 --out /tmp/<route>.json`
   Keep extra files in Next with repeated `--exclude <glob>`; add module maps with `--map`.
3. Read every `TODO(port-route)` note: untranslatable loader arguments and required props become typechecking placeholders that throw at runtime; optional untranslatable props are omitted. Resolve them (configure `translate`/ports, or edit the generated route after apply) before shipping.
4. `preview`, `validate`, then `apply` the exact plan. Run the configuration's `afterApply` commands (for example ownership/ledger generation and route-tree generation); the regenerated route tree used for validation is not written by the plan.
5. Review server-only page logic (auth, redirects, `notFound`, metadata), route inventories and ownership tests, then run the project's formatter, linter, typecheck, unit tests and E2E for both apps.
