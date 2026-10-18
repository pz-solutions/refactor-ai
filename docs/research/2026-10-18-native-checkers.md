# Native diagnostic checkers for refactor-ai

Research/probe date: 2026-10-18. Scope: replacing the expensive diagnostic pass, retaining the pinned TypeScript 5.9.3 engine for deterministic refactoring edits. No production dependency or checker option added. The benchmark repository was read only. All downloaded packages and executable probes live under `/tmp/refactor-ai-native-checkers/`.

## Recommendation

**Prototype an explicit native diagnostics adapter, first Microsoft TypeScript 7, then Theo's Rust port. Keep 5.9.3 as the correctness gate until differential tests establish the supported compiler/configuration contract.** Both native implementations can validate in-memory plans without applying them to disk. This recommendation follows from the local probes below; neither the probe nor an upstream compatibility claim establishes diagnostic equivalence to 5.9.3 across the heavy generic types in the target monorepo.

Theo's compiler is [`pingdotgg/ts-rust`](https://github.com/pingdotgg/ts-rust), published as **`tsc-rs`**, authored by Theo Browne; it is not `tsz`, SWC, or the Rust-to-TypeScript binding generator `ts-rs`. [Published package metadata](https://registry.npmjs.org/tsc-rs/0.7.0).

## Versions matter

| Candidate | Exact package investigated | Executable version | Role |
| --- | --- | --- | --- |
| Microsoft native stable | `typescript@7.0.2` | `Version 7.0.2` | Main practical candidate |
| Microsoft native matching Rust | `typescript@7.1.0-dev.20261008.1` | `Version 7.1.0-dev` | Fair Rust/Go compatibility comparison |
| Theo Rust | `tsc-rs@0.7.0` | `Version 7.1.0-dev` | Optional second implementation |
| Old native preview | `@typescript/native-preview@7.0.0-dev.20260707.2` | July preview | Historical comparison only |

Versions and exports were fetched from the owner-published npm registry metadata: [stable TS](https://registry.npmjs.org/typescript/7.0.2), [pinned nightly](https://registry.npmjs.org/typescript/7.1.0-dev.20261008.1), [Rust](https://registry.npmjs.org/tsc-rs/0.7.0), [preview](https://registry.npmjs.org/@typescript/native-preview/7.0.0-dev.20260707.2). On the probe date `typescript` latest was 7.0.2, Rust latest 0.7.0, preview latest the July build. Do not equate `native-preview@latest` with current TS7.

Microsoft moved native development back to the original TypeScript repository and archived the staging repository. [Microsoft staging README](https://github.com/microsoft/typescript-go/blob/main/README.md). Rust 0.7.0 targets the October 8 Microsoft revision `fed0bf24149f`, corresponding to the nightly above; Rust's `--version` identifies its TypeScript target, not its npm release. [Tagged upstream pin](https://github.com/pingdotgg/ts-rust/blob/v0.7.0/UPSTREAM.md), [tagged package README](https://github.com/pingdotgg/ts-rust/blob/v0.7.0/npm/tsc-rs-readme.md).

## API feasibility

These are separate-process clients with redesigned APIs, not drop-in replacements for `import ts from "typescript"` in this repository. Both packages export `./unstable/sync`, `./unstable/async`, `./unstable/fs`, and an AST interface. The stable Go client exposes `API.updateSnapshot`, projects, per-file `getSyntacticDiagnostics` / `getSemanticDiagnostics`, program/global/config diagnostics, and `collectTiming`. Its `getProgramDiagnostics()` is the relevant program/options method; it does not use the legacy `getOptionsDiagnostics()` name. [Published Go API declarations](https://unpkg.com/typescript@7.0.2/dist/api/sync/api.d.ts), [API process options](https://unpkg.com/typescript@7.0.2/dist/api/options.d.ts).

Go 7.0.2 filesystem callbacks distinguish present text, `null` (missing), and `undefined` (delegate to disk). `fileExists`, directory listings, and path callbacks support virtual new directories/files; simply overriding existing source reads is insufficient for moves. Snapshot updates accept explicit changed/created/deleted files or `invalidateAll`. [Go FS declarations](https://unpkg.com/typescript@7.0.2/dist/api/fs.d.ts), [Go snapshot protocol](https://unpkg.com/typescript@7.0.2/dist/api/proto.d.ts).

Rust 0.7.0 has the newer `API.createSnapshot` / `snapshot.update` API. Request filesystem helpers build a complete filesystem, a complete filesystem with read-only compiler libraries mounted, or a layer containing changed files and removed paths. `ensurePrograms: true` requests rebuilding dirty project programs before inspecting them. These contracts differ from stable Go 7.0.2, so a shared adapter must account for version-specific behavior. [Rust FS helpers](https://unpkg.com/tsc-rs@0.7.0/dist/api/fs.d.ts), [Rust snapshot protocol](https://unpkg.com/tsc-rs@0.7.0/dist/api/proto.generated.d.ts), [upstream request-FS regression tests](https://github.com/pingdotgg/ts-rust/blob/v0.7.0/crates/ts_goport/tests/go_baselines/project_lsp/api_session_requestfilesystem_test.rs).

Both clients can keep a process/session alive and load multiple projects. That is a promising warm-mode seam, but content-hash validation, affected-file closure, snapshot disposal and invalidation still belong to the adapter. A native process alone does not prove those policies correct.

The inspected JS APIs do not expose the legacy LanguageService rename/refactor edit methods used by refactor-ai (`findRenameLocations`, `getEditsForRefactor`, `getEditsForFileRename`). Rust has a native language server, but that is a separate integration surface; its presence does not make the existing adapter portable. Keep edit production on 5.9.3 during the diagnostic spike. Go 7.0.2's `Emitter` exposes node printing, whereas Rust 0.7.0's `Program` additionally supports declaration-output capture; project-reference declaration builds need a separate compatibility probe. [Go API declarations](https://unpkg.com/typescript@7.0.2/dist/api/sync/api.d.ts), [Rust API declarations](https://unpkg.com/tsc-rs@0.7.0/dist/api/sync/api.d.ts).

## Executed in-memory correctness probe

Script: `scripts/probe-native-checkers.mjs`. Verified outputs: `/tmp/refactor-ai-native-checkers/probe-go-checked.json`, `probe-rust-checked.json`, `probe-go-nightly-checked.json`, and `probe-old-preview-checked.json`. All four downloaded versions passed the assertions. A temporary virtual project contains `a.ts → b.ts` re-export → `c.ts`, plus a package whose `exports` switches between two declaration files. No fixture file is written to its virtual project path.

| Update in same API process | Go 7.0.2 | Rust 0.7.0 |
| --- | --- | --- |
| Baseline: exported number assigned to number | No errors | No errors |
| Change only `a.ts` export to string; ask diagnostics for two-hop `c.ts` | TS2322 in `c.ts` | TS2322 in `c.ts` |
| Delete `a.ts`, create `new.ts`, update re-export | No errors; old source absent | No errors; old source absent |
| Change only dependency package `exports` from number to string declaration | TS2322 in unchanged `pkg.ts` | TS2322 in unchanged `pkg.ts` |

At every stage assertions compare the union of requested importer diagnostics with the full semantic diagnostic set, require zero global/program/config/syntactic errors, and verify the exact source-file set. Source text is also checked after moves. This proves the narrow fixture, not arbitrary closure correctness.

Two integration pitfalls were reproduced and resolved:

- The original exploratory probe inspected semantic diagnostics but did not assert global diagnostics. After a move it returned **global TS6053** for deleted `a.ts`, despite semantic diagnostics being empty and `getSourceFile(a.ts)` being absent. The previous claim that this probe fully validated the move was incomplete. `invalidateAll` alone was insufficient to refresh the configured project's `include` roots in this fixture.
- Correct updates use **explicit changed/created/deleted notifications**. Stable Go accepts these in `fileChanges`. Rust and the matching Microsoft nightly also require `ensurePrograms:true` and a **request filesystem layer with `removedPaths` tombstones**, retaining the base filesystem and explicitly masking deletions. Replacing the full filesystem while updating an existing snapshot retained a stale deleted root in this experiment. Supplying a new filesystem without `ensurePrograms` also returned an unchanged program. These are observed API integration requirements, not a claim that arbitrary filesystem replacement is safe.

No synthetic tsconfig content edits or file writes were needed. The corrected probe passes the global and exact-source-list assertions on stable Go, matching Go nightly, Rust, and the old preview. Upstream's request filesystem tests show layers and explicit deletion masks: [tagged request-FS tests](https://github.com/pingdotgg/ts-rust/blob/v0.7.0/crates/ts_goport/tests/go_baselines/project_lsp/api_session_requestfilesystem_test.rs). Production adapters must keep program/options/global/config checks as well as semantic checks.

Reproduce from this worktree:

```sh
node scripts/probe-native-checkers.mjs /tmp/refactor-ai-native-checkers/typescript-7.0.2/package
node scripts/probe-native-checkers.mjs /tmp/refactor-ai-native-checkers/tsc-rs-0.7.0/package
```

Go probe: mutable FS callbacks plus `api.updateSnapshot({fileChanges:{changed,created,deleted}})`. Rust/newer Go probe: initial `createSnapshot` with `createFileSystemWithLib`, then `snapshot.update({ensurePrograms:true,fileNotifications:{changed,created,deleted},fileSystem:createFileSystemLayer(changedEntries,{removedPaths:deleted})})`. New snapshots remain available until session close; production must dispose unused ones.

## Benchmark setup

Tarballs and their Linux x64 platform packages were downloaded directly from npm and extracted under `/tmp`; **no install lifecycle scripts ran**. Executables were checked with `--version`. The target worktree did not contain an installed `@typescript/native-preview` package at the inspected paths; its lockfile only mentioned the package as an optional Vite peer.

Direct binaries, avoiding Node launcher overhead:

```text
/tmp/refactor-ai-native-checkers/typescript-7.0.2/package/node_modules/@typescript/typescript-linux-x64/lib/tsc
/tmp/refactor-ai-native-checkers/typescript-7.1.0-dev.20261008.1/package/node_modules/@typescript/typescript-linux-x64/lib/tsc
/tmp/refactor-ai-native-checkers/tsc-rs-0.7.0/package/node_modules/@tsc-rs/linux-x64/lib/tsc
/tmp/refactor-ai-native-checkers/typescript-native-preview-7.0.0-dev.20260707.2/package/node_modules/@typescript/native-preview-linux-x64/lib/tsgo
```

Safe diagnostic command from the read-only benchmark root:

```sh
<binary> -p packages/app-features/tsconfig.json \
  --noEmit --incremental false --composite false --pretty false --extendedDiagnostics
```

Run the same command for all candidates, capture exit status and complete sorted diagnostic records, and record memory. Compare Rust against its pinned Go nightly to separate port divergence from compiler-version changes. Compare both against 5.9.3 separately. Whole-project CLI speed does not establish plan latency: an actual plan also loads the 5.9.3 editing engine, fingerprints inputs, builds both graphs and validates planned overlays. Real-root timings are owned by the coordinator and intentionally not run concurrently with their baseline.

## Local measurements on the real monorepo

Read-only app-features project, two fresh CLI runs each: pinned JS TS5.9.3
**18,893 ms**, stable Go TS7.0.2 **3,465 ms**, matching Go7.1 nightly **3,026 ms**,
Rust0.7.0 **1,393 ms** (means). Every full check returned zero errors. Sampled peak
RSS: **849 / 986 / 898 / 585 MiB**, respectively. Rust was ~2.17× faster than its
matching Go nightly in this experiment. This is local evidence, not an upstream
performance claim or a guarantee for other projects.

`scripts/bench-native-plans.mjs` also validated five real TS5.9-produced rename
plans as native overlays, without applying them. It checks program/config/global,
syntactic and full semantic diagnostics and asserts exact planned source text.
Go: baseline **4,186 ms**, planned checks **3,567 / 3,503 / 3,107 / 3,444 / 3,448 ms**.
Rust: baseline **1,681 ms**, planned checks **1,811 / 1,928 / 1,911 / 1,732 / 1,837 ms**.
All returned zero errors. These times exclude TS5.9 edit production and refactor-ai
snapshot work; do not present them as complete plan latency. The real overlay
spike deliberately supports existing-file rename plans only; the separate
negative fixture covers moves and exports invalidation.

Full commands, raw samples, noisy cold-plan results and limitations are recorded
in the [dogfood measurement log](../dogfood/2026-10-17-tanstack-start-migration.md#performance-measurements-2026-10-18).

## Correctness limits and follow-ups

Rust's tagged README describes early-release status and known monorepo/build-order differences. Its default mode is the appropriate experiment: `--fast` changes checker allocation and enables optimizations with documented diagnostic differences around recursive types and instantiation limits; work stealing can introduce run-to-run changes. Those modes conflict with this task's deterministic, no-missed-diagnostic requirement. [Rust status, fast-mode caveats and known problems](https://github.com/pingdotgg/ts-rust/blob/v0.7.0/README.md#status).

The README's self-reported benchmark gains and passing upstream tests are reasons to measure, not evidence that 5.9.3 diagnostics are preserved. In particular the Rust pin documents a newer inference change; a compiler-version migration is a semantic change. [Pinned upstream explanation](https://github.com/pingdotgg/ts-rust/blob/v0.7.0/UPSTREAM.md).

Before making native validation authoritative:

1. Compare full before/after diagnostic sets against pinned 5.9.3 for every supported operation and the heavy-generics target; record version-specific differences explicitly.
2. Add transitive re-export, ambient/global augmentation, declaration-file, package `exports`/`typesVersions`, config inheritance, deleted/new directory and project-reference declaration tests.
3. Measure cold overlay plans and five successive plans, with semantic diagnostics restricted by the same safe closure policy. Measure IPC/FS callback time using `collectTiming`.
4. Verify content changes and resolved dependency changes invalidate snapshots; dispose retired snapshots. Test file-system layers and real node_modules/symlink resolution in the actual monorepo.
5. Preserve compiler version, checker identity and validation mode in cache keys and plan metadata. Unsupported configurations or parity failures must fall back to the pinned checker, not silently accept fewer errors.
