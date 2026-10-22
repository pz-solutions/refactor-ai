import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { applyPlan } from "./core/apply.ts";
import { assertFresh, assertPlanShape, createPlan, loadPlan, preview, type Plan } from "./core/plan.ts";
import { languageForProject, languageOperations } from "./languages.ts";
import type { Capability, Operation, RefactorRequest } from "./types.ts";
import { RefactorContext } from "./refactor-context.ts";
import { readRepoConfig } from "./core/repo-config.ts";

export type { Plan } from "./core/plan.ts";
export type { Capability, Diagnostic, FileChange, Operation } from "./types.ts";

export interface PlanOptions {
  /** Diagnostics checker for full verification; defaults to .refactor-ai/config.json, then TS5. */
  checker?: "ts5" | "ts7" | "both";
  /**
   * full (default): program diagnostics. bindings (TypeScript): edits, prechecks,
   * reference preservation and changed files' syntax/import bindings only; run
   * the project typecheck after apply. Defaults to .refactor-ai/config.json.
   */
  verify?: "full" | "bindings";
  project: string;
  file?: string;
  /** Atomic file/directory moves; mutually exclusive with file/target in the public API. */
  moves?: { file: string; target: string }[];
  /** TS-style globs relative to each moved directory; excluded adapters remain. */
  exclude?: string[];
  /** Defaults to the project configuration's directory. Must cover all changed files. */
  root?: string;
  /** Required for the aggregate API; operation packages select their own operation. */
  operation?: Operation;
  /** Exact source/destination module specifiers for retarget-import. */
  from?: string;
  to?: string;
  /** retarget-import: export names; move-file: module or module#Export mappings. */
  map?: Record<string, string>;
  /** retarget-import: imported export names; move-file: declarations to extract. */
  only?: string[];
  /** Report affected external test mocks (default), or add parallel mapped mocks. */
  mocks?: "report" | "add";
  /** A 1-based UTF-16 line:column string or a zero-based UTF-16 offset. */
  at?: string | number;
  /** Exclusive extraction end, using the same coordinates as at. */
  end?: string | number;
  name?: string;
  mode?: "sort" | "remove-unused";
  /** Keep an inlined re-export shim; valid only for inline-reexports. */
  keep?: boolean;
  target?: string;
  targetProject?: string;
  typeName?: string;
  rootNamespace?: string;
  /** port-route: TanStack Start routes directory (defaults to the config's start.routes). */
  startRoutes?: string;
  /** port-route: project configuration (defaults to <root>/.refactor-ai/port-route.json). */
  config?: string;
}

export interface ValidationResult {
  status: "validated" | "failed";
  validation: Plan["validation"];
  id: string;
  verify: "full" | "bindings";
}

export interface ApplyResult {
  status: "applied";
  files: string[];
  journal: string | null;
  /** Present for --verify bindings plans: program diagnostics were not computed. */
  verify?: "bindings";
  next?: string;
}

export interface RefactorApi {
  /** Compute changes without writing sources or a plan file. Failed diagnostics remain in the plan. */
  plan(options: PlanOptions): Promise<Plan>;
  preview(plan: Plan): string;
  /** Check integrity, snapshot freshness and stored compiler diagnostics; does not run project tests. */
  validate(plan: Plan): Promise<ValidationResult>;
  /** Apply exactly this plan with the shared snapshot, lock and journal protections. */
  apply(plan: Plan): Promise<ApplyResult>;
  loadPlan(path: string): Promise<Plan>;
  capabilities(project: string): Promise<Capability[]>;
}

export function offset(text: string, point: string): number {
  const match = /^(\d+):(\d+)$/.exec(point);
  if (!match) throw new Error(`INVALID_POSITION: ${point}`);
  const line = Number(match[1]), column = Number(match[2]);
  const lines = text.split("\n");
  if (line < 1 || line > lines.length || column < 1 || column > lines[line - 1].replace(/\r$/, "").length + 1) {
    throw new Error(`INVALID_POSITION: ${point}`);
  }
  return lines.slice(0, line - 1).reduce((total, item) => total + item.length + 1, 0) + column - 1;
}

/** Bindings plans skip program diagnostics; the project's own typecheck must run after apply. */
const bindingsReminder = "Plan verified bindings only (--verify bindings): program diagnostics were not computed. Run the project's typecheck (e.g. tsc --noEmit / tsgo, or the repo's check-types) before committing.";

/** Internal binding shared by CLI, installed skills and language-specific npm packages. */
export function createRefactorApi(context: RefactorContext): RefactorApi {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("UNSUPPORTED_RUNTIME: Node.js 22+ is required");
  function assertLanguage(project: string, backend?: string): void {
    if (context.language && (languageForProject(project) !== context.language ||
      (backend !== undefined && backend !== (context.language === "typescript" ? "typescript" : "roslyn")))) {
      throw new Error(`UNSUPPORTED_LANGUAGE: this tool only supports ${context.language === "typescript" ? "TypeScript/JavaScript" : "C#"}`);
    }
  }
  function checkPlan(plan: Plan): void {
    assertPlanShape(plan);
    assertLanguage(plan.request.project, plan.backend);
  }
  const compilerBase = context.toolkitRoot ? resolve(context.toolkitRoot, "runtime/package.json") : undefined;
  return {
    async plan(options) {
      const { project, request }: { project: string; request: RefactorRequest; } = await resolveRequest();
      const engine = await context.loadBackend(project, context.toolkitRoot);
      return createPlan(request, engine.analyze, compilerBase);

      async function resolveRequest() {
        const operation = options.operation ?? context.operation;
        if (!operation || !Object.values(languageOperations).some(items => items.includes(operation))) throw new Error(`UNSUPPORTED: ${operation}`);
        if (context.operation && operation !== context.operation) throw new Error(`UNSUPPORTED: this tool only supports ${context.operation}`);
        assertLanguage(options.project);
        if (options.checker !== undefined && (!["ts5", "ts7", "both"].includes(options.checker) || languageForProject(options.project) !== "typescript")) throw new Error("INVALID_ARGUMENT: checker ts5|ts7|both requires TypeScript/JavaScript");
        if (options.verify !== undefined && !["full", "bindings"].includes(options.verify)) throw new Error("INVALID_ARGUMENT: verify full|bindings");
        if (options.verify === "bindings" && languageForProject(options.project) !== "typescript") throw new Error("INVALID_ARGUMENT: verify bindings requires TypeScript/JavaScript");
        if (options.verify === "bindings" && options.checker !== undefined) throw new Error("INVALID_ARGUMENT: checker selects program diagnostics, which verify bindings does not compute");
        if (options.targetProject) assertLanguage(options.targetProject);
        if (options.mode !== undefined && !["sort", "remove-unused"].includes(options.mode)) throw new Error("INVALID_ARGUMENT: mode sort|remove-unused");
        if (["move-type", "move-file", "port-route"].includes(operation) && !options.target && !options.moves?.length) throw new Error(`INVALID_ARGUMENT: target required for ${operation}`);
        if ((options.target !== undefined || options.targetProject !== undefined) && !["move-type", "move-file", "port-route"].includes(operation)) {
          throw new Error("INVALID_ARGUMENT: target and targetProject require move-type, move-file or port-route");
        }
        if (operation === "port-route" && (!options.targetProject || options.moves || options.only || options.mocks !== undefined)) {
          throw new Error("INVALID_ARGUMENT: port-route requires --route, --to and --target-project; moves, only and mocks are unsupported");
        }
        if ((options.startRoutes !== undefined || options.config !== undefined) && operation !== "port-route") throw new Error("INVALID_ARGUMENT: startRoutes and config require port-route");
        if (options.keep !== undefined && (operation !== "inline-reexports" || typeof options.keep !== "boolean")) throw new Error("INVALID_ARGUMENT: keep requires inline-reexports and a boolean");
        if (operation === "retarget-import" && (!options.from || !options.to)) throw new Error("INVALID_ARGUMENT: from and to required for retarget-import");
        if (operation !== "retarget-import" && [options.from, options.to].some(value => value !== undefined)) {
          throw new Error("INVALID_ARGUMENT: from and to require retarget-import");
        }
        if (!["retarget-import", "move-file", "port-route"].includes(operation) && [options.map, options.only].some(value => value !== undefined)) throw new Error("INVALID_ARGUMENT: map and only require retarget-import, move-file or port-route");
        if (operation === "move-file" && languageForProject(options.project) !== "typescript" && (options.map || options.only)) throw new Error("INVALID_ARGUMENT: move-file mappings require TypeScript/JavaScript");
        if (options.mocks !== undefined && (!["retarget-import", "move-file"].includes(operation) || languageForProject(options.project) !== "typescript")) throw new Error("INVALID_ARGUMENT: mocks requires TypeScript retarget-import or move-file");
        if (options.mocks !== undefined && !["report", "add"].includes(options.mocks)) throw new Error("INVALID_ARGUMENT: mocks report|add");
        if (options.exclude !== undefined && (!["move-file", "port-route"].includes(operation) || languageForProject(options.project) !== "typescript" || options.only
          || !Array.isArray(options.exclude) || options.exclude.some(pattern => typeof pattern !== "string" || !pattern || pattern.startsWith("!") || /^(?:[A-Za-z]:|[\\/])/.test(pattern) || pattern.split(/[\\/]/).includes("..")))) {
          throw new Error("INVALID_ARGUMENT: exclude requires relative move-file directory globs without --only");
        }
        if (options.moves !== undefined && (operation !== "move-file" || languageForProject(options.project) !== "typescript"
          || !Array.isArray(options.moves) || !options.moves.length || options.file !== undefined || options.target !== undefined
          || options.moves.some(move => !move || typeof move.file !== "string" || !move.file || typeof move.target !== "string" || !move.target))) {
          throw new Error("INVALID_ARGUMENT: moves requires TypeScript move-file pairs, without file/target");
        }
        if (!options.file && !options.moves?.length && operation !== "retarget-import") throw new Error("INVALID_ARGUMENT: file required");
        const project = await realpath(resolve(options.project));
        const file = await realpath(resolve(options.file ?? options.moves?.[0]?.file ?? dirname(project)));
        const root = await realpath(resolve(options.root ?? dirname(project)));
        // Repository defaults apply to TypeScript plans; explicit options win.
        const defaults = languageForProject(options.project) === "typescript" ? await readRepoConfig(root) : {};
        const verify = options.verify ?? defaults.verify ?? "full";
        const checker = options.checker ?? (verify === "full" ? defaults.checker : undefined);
        const text = operation !== "retarget-import" && (options.at !== undefined || options.end !== undefined) ? await readFile(file, "utf8") : "";
        const position = (point: string | number): number => {
          if (typeof point === "string") return offset(text, point);
          if (!Number.isInteger(point) || point < 0 || point > text.length) throw new Error(`INVALID_POSITION: ${point}`);
          return point;
        };
        const request: RefactorRequest = {
          project, root, file, operation,
          ...(options.moves ? { moves: options.moves.map(move => ({ file: resolve(move.file), target: resolve(move.target) })), target: resolve(options.moves[0]!.target) } : {}),
          ...(options.exclude ? { exclude: [...new Set(options.exclude)].sort() } : {}),
          ...(checker !== undefined ? { checker } : {}),
          ...(verify === "bindings" ? { verify } : {}),
          ...(options.keep !== undefined ? { keep: options.keep } : {}),
          ...(operation === "move-file" ? { ...(options.mocks ? { mocks: options.mocks } : {}), ...(options.map ? { map: options.map } : {}), ...(options.only ? { only: options.only } : {}) } : {}),
          ...(operation === "port-route" ? { ...(options.map ? { map: options.map } : {}),
            ...(options.startRoutes !== undefined ? { startRoutes: resolve(options.startRoutes) } : {}),
            config: resolve(options.config ?? resolve(root, ".refactor-ai/port-route.json")) } : {}),
          ...(operation === "retarget-import" ? { from: options.from, to: options.to,
            ...(options.map ? { map: options.map } : {}), ...(options.only ? { only: options.only } : {}),
            ...(options.mocks !== undefined ? { mocks: options.mocks } : {}),
            ...(!options.file ? { projectScope: true } : {}) } : {}),
          ...(options.at !== undefined ? { position: position(options.at) } : {}),
          ...(options.end !== undefined ? { end: position(options.end) } : {}),
          ...(options.name !== undefined ? { newName: options.name } : {}),
          ...(operation === "imports" ? { mode: options.mode ?? (context.language === "csharp" ? "remove-unused" : "sort") } : {}),
          ...(options.target !== undefined ? { target: resolve(options.target) } : {}),
          ...(options.targetProject !== undefined ? { targetProject: await realpath(resolve(options.targetProject)) } : {}),
          ...(options.typeName !== undefined ? { typeName: options.typeName } : {}),
          ...(options.rootNamespace !== undefined ? { rootNamespace: options.rootNamespace } : {}),
        };
        return { project, request };
      }
    },
    preview(plan) { checkPlan(plan); return preview(plan); },
    async validate(plan) {
      checkPlan(plan);
      await assertFresh(plan, compilerBase);
      return { status: plan.validation.status === "passed" ? "validated" : "failed", validation: plan.validation, id: plan.id, verify: plan.request.verify ?? "full" };
    },
    async apply(plan) {
      checkPlan(plan);
      const result = await applyPlan(plan, compilerBase);
      return plan.request.verify === "bindings" ? { ...result, verify: "bindings", next: bindingsReminder } : result;
    },
    async loadPlan(path) { const plan = await loadPlan(resolve(path)); checkPlan(plan); return plan; },
    async capabilities(project) {
      assertLanguage(project);
      const engine = await context.loadBackend(await realpath(resolve(project)), context.toolkitRoot);
      return engine.capabilities.filter(item => !context.operation || item.operation === context.operation).map(item => ({ ...item, ...(item.modes ? { modes: [...item.modes] } : {}) }));
    },
  };
}
