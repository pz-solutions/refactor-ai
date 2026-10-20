# port-route configuration: uber-platform

Copy `port-route.json` and `port-route/` to `<repo>/.refactor-ai/` (the state
directory's generated `.gitignore` keeps both trackable). refactor-ai knows only
Next App Router directories and TanStack flat route files; everything below is
the project's API.

| Field | Meaning |
| --- | --- |
| `next.appDirectory` | Directory whose children are URL segments (`[locale]` stays outside the route). |
| `next.exclude` | Optional globs kept in Next; defaults keep `page`/`layout`/`loading`/`error`/`not-found`/`template`/`default`/`route` files, `**/_hooks/**` and `*adapter*`. Files importing `next.serverOnlyModules` (default `server-only`) and nested route directories also stay. |
| `next.preloadFunctions` | Calls taking `(functionReference, args)`; page hooks returning one are traced. |
| `next.adapterFile` | Generated adapter name; `{{route}}` = last static segment, `{{view}}` = view module name. |
| `start.project`, `start.routes` | Start tsconfig (joins validation) and routes directory. |
| `start.routeTree` | Optional TanStack `@tanstack/router-generator` run in a scratch mirror, validation only. |
| `start.imports`, `next.imports` | Imports every generated file needs. |
| `map` | move-file module maps for the moved files (`--map` wins). |
| `translate` | Page expression (whitespace-insensitive) to loader expression. |
| `data` | The view's preloaded hook and the data prop name/type that replaces each preloaded prop. `typeArgument` wraps an explicit hook type argument. |
| `ports` | View props filled by app hooks (`next`/`start` snippets with `imports`, `setup`, `value`; `{{path}}` = route path). |
| `params` | View props named like a dynamic segment (`{{name}}`). |
| `snippets` | Query factory, prefetch, data hook, loader (`startRecordLoader` for dynamic routes), search deps and the TODO placeholder. |
| `afterApply` | Commands reported after planning (ownership ledger, route tree). |
| `templates` | Adapter and Start route templates, relative to the config (placeholders below). |

Placeholders: adapter `imports export name params propsType setup todos view`;
Start route `imports queries id path searchDeps loader component setup todos view`;
loader snippets `loaderArgs statements prefetches returns path id`.
