# GitHub Actions

The workflows target `wooboo/refactor-ai`; npm packages use `@pz-solutions`. They are local workflow definitions until committed and pushed to GitHub. Creating these files does not change repository settings, configure npm accounts or publish packages.

## CI

`.github/workflows/ci.yml` runs on branch pushes, pull requests and manual dispatch. `publish.yml` also calls it as a reusable verification workflow for a release tag.

The `CI / Build, test and pack` job uses Ubuntu 24.04, Node 22, Bun 1.4.2 and .NET 8. It installs the SDK into a separate runner directory so temporary test projects use .NET 8 rather than a newer preinstalled SDK. Action references are pinned to verified commit SHAs. Dependency installation uses `bun.lock` and the helper's NuGet lockfile; package-manager caches are disabled.

`CI / Windows Node CLI and distributions` builds the same JavaScript resources on Windows 2022 and exercises TS/JS plan/preview/validate/apply for every implemented operation, including extraction, nested destinations, explicit files lists, include/exclude globs and cross-project re-exports. It also runs an independently copied skill and an actual packed npm executable through Node/npm exec. This job covers TS/JS portability; it does not claim to validate Windows ACL preservation or C# on Windows. Both jobs must pass before the publishing job starts.

The job runs TypeScript checking, a locked Roslyn build, Node builds, regression tests, independent skill installation tests, packed npm integration tests and the behavior-preserving demo. It then packs all nine generated npm packages and records SHA-512 integrity values in `release.json`.

Successful runs upload two artifacts:

| Artifact | Content |
| --- | --- |
| `npm-packages` | Nine `.tgz` archives, `release.json` and the built Node release runner `release.mjs` |
| `refactor-skills` | Eight self-contained skill directories, excluding dependency and build caches |

Artifacts are retained for 14 days. A failed verification prevents publication. CI only has read access to repository contents and does not receive npm credentials.

To reproduce the checks locally:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build:csharp
bun run build
bun test
bun test ./tests/skills-install.integration.ts
bun run test:npm
node dist/demo.js
node dist/npm-release.mjs pack
```

## Publication

`.github/workflows/publish.yml` triggers on pushed `v*` tags. Its publishing job runs only for tags in `wooboo/refactor-ai`, after verification passes. It downloads `npm-packages` from that same workflow run and publishes those archives without rebuilding them. Repository write access is unnecessary.

All nine packages follow a **fixed common version** sourced from the private author `package.json`. CI checks a release tag against that version while packing, before uploading release artifacts; the publisher checks it again. Local real publication also requires an explicit matching `--ref`. Packages must have the expected scope and repository metadata. All archive hashes are checked before registry access. Stable versions use the npm `latest` tag; prereleases use `next`.

Before publishing, it queries each exact version. Identical existing archives are skipped. For an incomplete release, it also checks every package's distribution tags before the first upload. A stable release cannot move `latest` backwards; a prerelease cannot move `next` backwards or precede an existing `latest`. Comparison follows SemVer, so `beta.10` is newer than `beta.9`. An existing version with different content, a malformed response or a registry/network error aborts preflight. Only an npm `E404` is interpreted as a missing version/channel. Publication of nine packages is sequential and cannot be atomic; a retry with identical artifacts resumes missing packages. A completed release retry performs no uploads or tag changes, even when a newer release exists.

The workflow serializes publishers with its concurrency group. Registry checks are not a transaction against publishers outside this workflow; use this workflow as the single release path rather than publishing concurrently by hand. Dry runs do not query registry state, so they validate packaging, not availability or advancement of distribution tags.

The publishing job uses Node 22 and npm 11.5.1, grants `id-token: write`, and authenticates through npm Trusted Publishing without an `NPM_TOKEN` secret. OIDC support requires Node 22.14+ and npm 11.5.1+. Configure a Trusted Publisher separately for each package; GitHub-hosted runners are supported. [npm Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/)

## One-time setup

For this project's initial release, create the packages through an authenticated manual publication before configuring their npm package settings. Download the `npm-packages` artifact from a successful CI run and extract it into a directory outside a target project:

```sh
npm login
node /absolute/path/to/npm-packages/release.mjs publish \
  --artifacts /absolute/path/to/npm-packages --ref v0.1.0 --dry-run
node /absolute/path/to/npm-packages/release.mjs publish \
  --artifacts /absolute/path/to/npm-packages --ref v0.1.0
```

Use the artifact's actual version. These commands are instructions for the publisher; repository builds and tests never execute a real publication.

In GitHub, create an environment named `npm`. In each of the nine packages' npm Settings, add a GitHub Actions Trusted Publisher with these exact values:

| npm field | Value |
| --- | --- |
| Organization or user | `wooboo` |
| Repository | `refactor-ai` |
| Workflow filename | `publish.yml` |
| Environment name | `npm` |
| Allowed action | Enable direct `npm publish` |

The GitHub account is `wooboo`; the npm organization is `pz-solutions`. npm's workflow field takes the filename, without `.github/workflows/`. New publisher configurations may default to staged publication, so direct publication must be enabled for this workflow. [npm publisher configuration](https://docs.npmjs.com/trusted-publishers/)

Generated manifests inherit `repository.url` from the root `package.json`. That URL must match the GitHub repository. npm automatically adds provenance for trusted publication from public repositories to public packages; private repositories do not produce provenance. [npm provenance behavior](https://docs.npmjs.com/trusted-publishers/)

## Release a version

Build the version CLI once, then choose the release increment. It updates only the root `package.json`, rejects invalid or non-increasing versions, and prints the exact Git and npm tags. It never commits, tags or publishes:

```sh
bun run build
bun run version:packages --help
bun run version:packages minor --dry-run
bun run version:packages minor
bun run package:npm
node dist/npm-release.mjs pack --ref v0.2.0
node dist/npm-release.mjs publish --ref v0.2.0 --dry-run
```

The example assumes the current version is `0.1.0`. Review and commit the resulting version change together with all release sources and workflow files, then create and push the **printed** Git tag:

```sh
git tag v0.2.0
git push origin v0.2.0
```

Before version 1.0, use `patch` for compatible changes and `minor` for breaking changes. Starting with 1.0, use `patch` for fixes, `minor` for compatible features and `major` for breaking changes. Version selection is explicit; the CLI does not infer compatibility from a diff. Canonical SemVer is required, without a leading `v` in `package.json`, leading zeroes or build metadata. `bun.lock` does not store the root version and needs no version-only update.

For example, these alternative commands prepare a beta series from `0.1.0`, advance it, then promote it to stable:

```sh
bun run version:packages preminor --preid beta  # 0.2.0-beta.0
bun run version:packages prerelease --preid beta  # 0.2.0-beta.1
bun run version:packages patch  # 0.2.0
```

Publish and tag each selected release separately after rebuilding, verifying and committing it. An exact version is also accepted, for example `bun run version:packages 1.0.0-rc.1`. Beta/RC releases use `next` and stable releases use `latest`. Generated manifests declare the same channel in `publishConfig.tag`, so direct publication of a beta package also defaults to `next`. The author checkout remains private in npm; only generated packages are published.

The workflow also supports manual dispatch with a `dry_run` boolean, defaulting to true. Select the version tag as the dispatch ref. Dispatch on a branch performs verification but skips the publishing job. Dry run validates hashes and runs npm publication dry runs without querying existing versions or uploading packages.

For local publication inspection:

```sh
node dist/npm-release.mjs --help
node dist/npm-release.mjs pack --ref v0.2.0
node dist/npm-release.mjs publish --ref v0.2.0 --dry-run
```

## Retry a partial release

Rerun the failed `Publish npm` workflow on the same tag and source commit. The archive content must remain identical; unchanged published versions are skipped. If source or package metadata changes, create a new version instead of reusing an existing registry version. An existing version with different content is deliberately rejected.

The publication concurrency group queues releases and does not cancel an in-progress publisher. Branch CI replaces older runs for the same workflow/ref. Renaming the publishing workflow, changing the GitHub repository or changing the job's environment requires updating npm's Trusted Publisher configuration.
