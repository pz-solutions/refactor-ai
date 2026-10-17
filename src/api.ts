import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { applyPlan } from "./core/apply.ts";
import { assertFresh, assertPlanShape, createPlan, loadPlan, preview, type Plan } from "./core/plan.ts";
import { languageForProject, languageOperations } from "./languages.ts";
import type { Capability, Operation, RefactorRequest } from "./types.ts";
import { RefactorContext } from "./refactor-context.ts";

export type { Plan } from "./core/plan.ts";
export type { Capability, Diagnostic, FileChange, Operation } from "./types.ts";

export interface PlanOptions {
  project: string;
  file?: string;
  /** Defaults to the project configuration's directory. Must cover all changed files. */
  root?: string;
  /** Required for the aggregate API; operation packages select their own operation. */
  operation?: Operation;
  /** Exact source/destination module specifiers for retarget-import. */
  from?: string;
  to?: string;
  map?: Record<string, string>;
  only?: string[];
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
}

export interface ValidationResult {
  status: "validated" | "failed";
  validation: Plan["validation"];
  id: string;
}

export interface ApplyResult {
  status: "applied";
  files: string[];
  journal: string | null;
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
  return {
    async plan(options) {
      const { project, request }: { project: string; request: RefactorRequest; } = await resolveRequest();
      const engine = await context.loadBackend(project, context.toolkitRoot);
      return createPlan(request, engine.analyze);

      async function resolveRequest() {
        const operation = options.operation ?? context.operation;
        if (!operation || !Object.values(languageOperations).some(items => items.includes(operation))) throw new Error(`UNSUPPORTED: ${operation}`);
        if (context.operation && operation !== context.operation) throw new Error(`UNSUPPORTED: this tool only supports ${context.operation}`);
        assertLanguage(options.project);
        if (options.targetProject) assertLanguage(options.targetProject);
        if (options.mode !== undefined && !["sort", "remove-unused"].includes(options.mode)) throw new Error("INVALID_ARGUMENT: mode sort|remove-unused");
        if (["move-type", "move-file"].includes(operation) && !options.target) throw new Error(`INVALID_ARGUMENT: target required for ${operation}`);
        if ((options.target !== undefined || options.targetProject !== undefined) && !["move-type", "move-file"].includes(operation)) {
          throw new Error("INVALID_ARGUMENT: target and targetProject require move-type or move-file");
        }
        if (options.keep !== undefined && (operation !== "inline-reexports" || typeof options.keep !== "boolean")) throw new Error("INVALID_ARGUMENT: keep requires inline-reexports and a boolean");
        if (operation === "retarget-import" && (!options.from || !options.to)) throw new Error("INVALID_ARGUMENT: from and to required for retarget-import");
        if (operation !== "retarget-import" && [options.from, options.to, options.map, options.only].some(value => value !== undefined)) {
          throw new Error("INVALID_ARGUMENT: from, to, map and only require retarget-import");
        }
        if (!options.file && operation !== "retarget-import") throw new Error("INVALID_ARGUMENT: file required");
        const project = await realpath(resolve(options.project));
        const file = await realpath(resolve(options.file ?? dirname(project)));
        const root = await realpath(resolve(options.root ?? dirname(project)));
        const text = operation !== "retarget-import" && (options.at !== undefined || options.end !== undefined) ? await readFile(file, "utf8") : "";
        const position = (point: string | number): number => {
          if (typeof point === "string") return offset(text, point);
          if (!Number.isInteger(point) || point < 0 || point > text.length) throw new Error(`INVALID_POSITION: ${point}`);
          return point;
        };
        const request: RefactorRequest = {
          project, root, file, operation,
          ...(options.keep !== undefined ? { keep: options.keep } : {}),
          ...(operation === "retarget-import" ? { from: options.from, to: options.to,
            ...(options.map ? { map: options.map } : {}), ...(options.only ? { only: options.only } : {}),
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
      await assertFresh(plan);
      return { status: plan.validation.status === "passed" ? "validated" : "failed", validation: plan.validation, id: plan.id };
    },
    async apply(plan) { checkPlan(plan); return applyPlan(plan); },
    async loadPlan(path) { const plan = await loadPlan(resolve(path)); checkPlan(plan); return plan; },
    async capabilities(project) {
      assertLanguage(project);
      const engine = await context.loadBackend(await realpath(resolve(project)), context.toolkitRoot);
      return engine.capabilities.filter(item => !context.operation || item.operation === context.operation).map(item => ({ ...item, ...(item.modes ? { modes: [...item.modes] } : {}) }));
    },
  };
}
