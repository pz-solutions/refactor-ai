# port-route dogfood — uber-platform, 2026-10-20

Disposable worktree of uber-platform at `7bfc6208` (the coordinator moved the
target from `2363acf8`; at `7bfc6208` Start ownership is derived from route
files by `bun run ledger:generate` and app-features exposes browser modules
through a `./*` export, so the generated plans edit neither ownership lists
nor package exports). Configuration: `examples/port-route/uber-platform`.
Checker: `--checker ts7`; all user sources of apps/web, packages/app-features
and apps/web-start validated in every plan.

## `/dashboard/properties/[code]/units` (detail route)

Hand preparation (before the plan, 17 added and 7 removed lines): the view took `code` and
`navigation: FeatureNavigation` props instead of `useParams`,
`@/i18n/routing` `Link` and `useDashboardNavigation` (Link threaded to the
row component), and app-features declared `sonner`. Without it the plan
stops before program loading with `MOVE_IMPORT_UNRESOLVED` (`@/i18n/routing`,
`@/adapters/dashboard-navigation`) and `MISSING_DEPENDENCY` (`next`, `sonner`).

Plan (31 s wall, passed, no TODOs) generated:

- moved `units-content.tsx` (+ ESLint suppressions) to
  `packages/app-features/src/properties/units`, with `preloadedProperty`
  rewritten to `initialProperty: Doc<"properties"> | null | undefined`
  and `Preloaded`/`FunctionReference`/`usePreloaded` imports removed;
- `units-adapter.tsx` (22 lines): server preload kept, `usePreloaded` data,
  `navigation` and `code` ports; `page.tsx` imports it;
- `dashboard.properties.$code.units.tsx` (44 lines): `preloadDashboardRecord`
  loader prefetching `api.properties.getByCode` with `{ code }` from
  `params` (traced through `../_hooks/preload-property`), `useDashboardQuery`
  data, `useAppNavigation`, `Route.useParams()`.

After apply + `bun run ledger:generate`: `check-types` green in
apps/web-start (including `routes:generate`), apps/web and app-features; the
ledger marks the route ported.

## `/dashboard/financials/invoices` (list route)

Hand preparation: `InvoiceFilters` extracted with
`move-file --only InvoiceFilters` (one refactor-ai plan); about 40 added and 30 removed lines in five view
files (`search` and `navigation` props instead of `next/navigation` and
`@/i18n/routing`, `Link` threaded into columns/row actions, `usePreloaded`
hoisted from a helper into the component, `ReadonlyURLSearchParams` dropped);
the two component test files (1 324 lines) that render the view with Next
mocks were removed in the demo — a real port rewrites them. Config map
`@/contexts/organization-context` → `@uber-platform/app-features/shell/organization-context`.

Plan (24 s, passed) generated: 10 moved files with import rewrites, a
27-line adapter (`search` port via `replaceUrlSearchParams`, `navigation`,
`ksefEnvironment` passthrough), `page.tsx` rewired, and
`dashboard.financials.invoices.index.tsx` (51 lines; `.index` because `[id]`
and `new` are nested routes) whose loader translates
`await getServerBusinessNow()` → `context.businessNow` and
`await searchParams` → `new URLSearchParams(location.searchStr)`, copies the
page's `parseInvoiceFilters(...)` call with its app-features import, adds
`loaderDeps`, and prefetches `api.invoices.list`.

TODO left: `ksefEnvironment` (a `let` assigned in `try`/`catch` from
`process.env`) — optional, so omitted in Start with a `TODO(port-route)`
comment and plan note.

After apply: `check-types` green in all three projects. Inventory tests fail
as they do for hand ports until updated: `app-route-ownership.test.ts`
(`/dashboard/properties/new/units` sample now matches `$code`) and
`scripts/e2e-coverage.test.ts` (Start-served invoices needs Start specs).

## Hand work removed

Per port, the plan replaces: the batch move command and its maps, the
view's preloaded→data contract change, writing the adapter, rewiring the page,
writing the Start route (query factories, loader translation, loader deps,
record-loader wrapper, ports, params), and route-tree regeneration for
validation. Remaining hand work: making the view framework-free (ports),
tests that mock Next, TODOs, inventories/E2E, and parity checks.
