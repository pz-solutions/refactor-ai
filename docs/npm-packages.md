# npm CLI packages

The npm distribution complements self-contained agent skills. It uses the same TypeScript Language Service/Roslyn engines, plan schemas, snapshots and apply workflow. Build tools generate JavaScript ESM packages; users do not need Bun or the source repository.

## Packages and executables

| Default npm package | Executable (`bin`) | Planning command |
| --- | --- | --- |
| `@refactor-ai/cli` | `refactor-ai` | `plan <operation>` |
| `@refactor-ai/ts-rename` | `refactor-ts-rename` | `plan` |
| `@refactor-ai/ts-imports` | `refactor-ts-imports` | `plan` |
| `@refactor-ai/ts-format` | `refactor-ts-format` | `plan` |
| `@refactor-ai/ts-extract-function` | `refactor-ts-extract-function` | `plan` |
| `@refactor-ai/ts-extract-variable` | `refactor-ts-extract-variable` | `plan` |
| `@refactor-ai/ts-rename-file` | `refactor-ts-rename-file` | `plan` |
| `@refactor-ai/ts-move-type` | `refactor-ts-move-type` | `plan` |
| `@refactor-ai/csharp-rename` | `refactor-csharp-rename` | `plan` |
| `@refactor-ai/csharp-imports` | `refactor-csharp-imports` | `plan` |
| `@refactor-ai/csharp-format` | `refactor-csharp-format` | `plan` |
| `@refactor-ai/csharp-rename-file` | `refactor-csharp-rename-file` | `plan` |
| `@refactor-ai/csharp-sync-namespace` | `refactor-csharp-sync-namespace` | `plan` |
| `@refactor-ai/csharp-move-type` | `refactor-csharp-move-type` | `plan` |

Each package has one `bin`, so npx can infer its executable from the package name. A scoped package uses the same executable name. Operation packages insert their operation into `plan`, report that operation in `capabilities` when supported by the backend, and reject attempts to plan another operation. They retain `preview`, `validate` and `apply`, which operate on the exact saved plan rather than recomputing a transformation.

No package name or scope has been reserved or published by the build process. Use names you own. The registry decides whether a name/version is available.

TS packages support TypeScript and JavaScript through the TypeScript Language Service. They contain no C# backend or .NET helper. npm installs their pinned TypeScript dependency automatically. C# packages contain the Roslyn adapter and locked helper sources, with no TypeScript npm dependency. They require the .NET 8 SDK and build the helper on first C# use. The aggregate `cli` contains both adapters for multi-language projects.

Language packages reject foreign project configurations and foreign saved plans before invoking a compiler or writing sources. Their help and examples describe only the supported language. C# imports default to `remove-unused`; TS/JS imports default to `sort`. The language-neutral aggregate keeps the original explicit C# `--mode remove-unused` convention.

## Programmatic imports

Each package exports `createRefactor` from its package root with TypeScript declarations, alongside its `bin`. Imports do not execute CLI commands. See [the programmatic interface](api.md) for methods, requirements and automation examples. Language and operation restrictions match the CLI, and plan/apply protections share the same implementation.

## Build and inspect

From the author checkout:

```sh
bun install --frozen-lockfile
bun run package:npm --help
bun run package:npm
```

The default output is `dist/npm/<unscoped-package-name>/`. The default scope is `@refactor-ai`, producing names such as `@refactor-ai/ts-rename`. `--scope another-org` overrides it; `--out ./release/npm` selects another output directory. Managed package directories are regenerated, so keep hand-written content elsewhere. Output cannot replace the checkout or its ancestors, including through a symlink alias.

The root `package.json` stays private. Generated package manifests omit `private`, declare `bin`, `engines.node >=22`, explicit `files` allowlists and public `publishConfig`. TS/JS and aggregate packages declare a pinned TypeScript dependency; C# packages have no npm runtime dependencies. The diff implementation is bundled with its license notice. C# packages include helper `.cs` sources, `.csproj` and NuGet lockfile, excluding local `bin`, `obj` and caches. All TS/JS packages omit the C# helper. Package directories are independent and have no internal npm package dependency or publication order.

```sh
npm pack ./dist/npm/ts-rename --dry-run
npm pack ./dist/npm/ts-rename --pack-destination /tmp
npx --yes file:/tmp/refactor-ai-ts-rename-0.1.3.tgz --help
```

The `file:` prefix makes a local tarball a package specification. An equivalent explicit-package invocation is:

```sh
npx --yes --package=/tmp/refactor-ai-ts-rename-0.1.3.tgz refactor-ts-rename --help
```

To install a packed package as a development tool in a target project:

```sh
npm install --save-dev /tmp/refactor-ai-ts-rename-0.1.3.tgz
npx --no-install refactor-ts-rename --help
```

`bun run test:npm` builds and packs all fourteen packages in a temporary workspace, invokes their inferred binaries through npx, checks scoped names and operation restrictions, and executes plan/preview/validate/apply on copied TS, JS and C# projects. It also verifies that C# can build its packaged helper with no source-checkout lookup. Tests require network access for initial npm/NuGet downloads and .NET SDK for C#.

## Use after publication

```sh
npx @refactor-ai/cli --help
npx @refactor-ai/cli plan move-type --help
npx @refactor-ai/ts-rename --help
npx @refactor-ai/ts-rename plan --project ./tsconfig.json --file ./src.ts --at 1:14 --name newName
```

Replace paths and positions with your project's values. Read the plan path from the planning response and use it unchanged:

```sh
npx @refactor-ai/ts-rename preview --plan ./path/to/plan.json
npx @refactor-ai/ts-rename validate --plan ./path/to/plan.json
npx @refactor-ai/ts-rename apply --plan ./path/to/plan.json
```

For repeatable automation, pin the version, for example `npx @refactor-ai/ts-rename@0.1.3 --help`, or install the package locally with a lockfile. Full language support, flags, limitations, examples and error behavior are in each executable's `--help`.

Consumers require Node.js 22+ and npm. For TS/JS and aggregate packages, npm installs the pinned TypeScript runtime dependency. There are no `install`, `postinstall` or `prepare` scripts. C# additionally requires .NET 8 SDK in PATH, the target project's SDK/workloads and restored dependencies. On first C# execution, the Node runner builds bundled helper sources with locked NuGet restore in its own npm package directory. Initial restore needs network access and that package/cache directory must be writable. Later runs reuse the helper. `--help` does not build the helper or load a project; npx may still download the package before launching it.

## Publish

For automatic tagged releases, see [GitHub Actions setup and publication](github-actions.md). The repository includes CI verification and a separate OIDC publishing workflow for all fourteen packages.

The distribution scope changed from `@pz-solutions` to `@refactor-ai`. The complete CLI is `@refactor-ai/cli`; language tools use `ts-` or `csharp-` names and matching executable prefixes. Previously published language-neutral packages remain separate registry entries. npm treats the new scoped names as separate packages: they require an initial publication and their own Trusted Publisher connections. The GitHub repository remains `pz-solutions/refactor-ai`.

The default organization scope is `@refactor-ai`. All fourteen generated manifests use one common version from the author `package.json`. Run `bun run version:packages --help` after building to choose a SemVer increment, prepare a beta/RC release or preview a bump with `--dry-run`. Stable packages declare `publishConfig.tag: latest`; prereleases declare `next`.

For the default organization, use the verified release runner so version/ref matching, registry integrity and distribution-tag advancement are checked before uploading:

```sh
bun run build
bun run version:packages patch --dry-run
# Select and commit the intended version before creating its Git tag.
bun run test:npm
bun run package:npm
npm login
node dist/npm-release.mjs pack --ref v0.1.3
node dist/npm-release.mjs publish --ref v0.1.3 --dry-run
node dist/npm-release.mjs publish --ref v0.1.3
```

Replace `v0.1.3` with the selected version's Git tag. The release runner targets the fourteen `@refactor-ai` packages and refuses partial releases that would move `latest` or `next` backwards. Identical already-published versions are skipped; different content requires a new version. See the [release procedure](github-actions.md#release-a-version) for increments, prerelease promotion and retries.

Use `--scope` to generate packages for another organization. The integration tests regenerate the default scope; regenerate any custom release afterwards. Individual packages can still be published with `npm publish ./dist/npm/ts-rename --access public`, but direct npm publication bypasses the runner's cross-package/version checks. A dry run inspects publication content and does not reserve a registry name/version or check channel advancement. npm account permissions and registry authentication remain the publisher's responsibility. Builds and tests never publish packages or change registry state.

References: npm's [`bin` documentation](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#bin), [`npm exec` / npx executable inference](https://docs.npmjs.com/cli/v10/commands/npm-exec), and [`npm publish`](https://docs.npmjs.com/cli/v10/commands/npm-publish).
