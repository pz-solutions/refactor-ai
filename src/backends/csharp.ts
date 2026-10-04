import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { BackendResult, Capability, RefactorRequest } from "../types.ts";

export const capabilities: Capability[] = [
  {
    operation: "rename",
    description: "Solution-wide semantic symbol rename using Roslyn.",
  },
  {
    operation: "format",
    description: "Document formatting using the public Roslyn Formatter API.",
  },
  {
    operation: "imports",
    modes: ["remove-unused"],
    description: "Remove unused imports identified by Roslyn's built-in compiler diagnostics.",
  },
  {
    operation: "rename-file",
    description: "Rename a file to match its selected top-level type, updating explicit Compile items.",
  },
  {
    operation: "sync-namespace",
    description: "Set a file's namespace from RootNamespace and folders, updating references with Roslyn binding checks.",
  },
  {
    operation: "move-type",
    description: "Move a top-level type to a new file in the same or another project, updating namespaces, references and project references.",
  },
];

interface HelperError {
  code: string;
  message: string;
}

interface HelperResponse {
  result?: BackendResult;
  error?: HelperError;
}

export async function analyze(request: RefactorRequest): Promise<BackendResult> {
  validateRequest(request);
  const helper = await findOrBuildHelper();
  const { stdout, stderr, exitCode, timedOut } = await runDotnet([helper], JSON.stringify(request));
  if (timedOut) {
    throw new Error("CSHARP_HELPER_TIMEOUT: helper exceeded 120 seconds");
  }

  let response: HelperResponse;
  try {
    response = JSON.parse(stdout) as HelperResponse;
  } catch {
    const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    throw new Error(`CSHARP_HELPER_FAILED: ${detail}`);
  }

  if (response.error) {
    throw new Error(`${response.error.code}: ${response.error.message}`);
  }
  if (exitCode !== 0) {
    const detail = stderr.trim() || `exit code ${exitCode}`;
    throw new Error(`CSHARP_HELPER_FAILED: ${detail}`);
  }
  if (!response.result) {
    const detail = stderr.trim() || `helper exited with code ${exitCode}`;
    throw new Error(`CSHARP_PROTOCOL_ERROR: ${detail}`);
  }

  validateResult(response.result, request.root);
  return response.result;
}

function validateRequest(request: RefactorRequest): void {
  for (const [name, value] of [
    ["project", request.project],
    ["root", request.root],
    ["file", request.file],
  ] as const) {
    if (!isAbsolute(value)) {
      throw new Error(`INVALID_REQUEST: ${name} must be an absolute path`);
    }
  }

  ensureWithinRoot(request.root, request.project, "project");
  ensureWithinRoot(request.root, request.file, "file");

  if (request.operation === "rename" &&
      (!Number.isInteger(request.position) || request.position! < 0 || !request.newName?.trim())) {
    throw new Error("INVALID_REQUEST: rename requires a non-negative position and newName");
  }
  if (request.operation === "imports" && request.mode !== "remove-unused") {
    throw new Error("UNSUPPORTED_OPERATION: C# supports only imports mode remove-unused");
  }
  if (request.operation === "extract-function" || request.operation === "extract-variable") {
    throw new Error(`UNSUPPORTED_OPERATION: C# operation '${request.operation}' is not supported`);
  }
  if (request.position !== undefined && (!Number.isInteger(request.position) || request.position < 0)) {
    throw new Error("INVALID_REQUEST: position must be a non-negative integer");
  }
  if (request.typeName !== undefined && !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(request.typeName)) {
    throw new Error("INVALID_REQUEST: typeName must be a simple C# identifier");
  }
  if (request.rootNamespace !== undefined && request.rootNamespace !== "" &&
      !/^[\p{L}_][\p{L}\p{N}_]*(\.[\p{L}_][\p{L}\p{N}_]*)*$/u.test(request.rootNamespace)) {
    throw new Error("INVALID_REQUEST: rootNamespace must be a dotted C# namespace");
  }
  if (request.operation === "move-type") {
    if (!request.target || !isAbsolute(request.target) || !request.target.endsWith(".cs")) {
      throw new Error("INVALID_REQUEST: move-type requires an absolute target .cs file path");
    }
    ensureWithinRoot(request.root, request.target, "target");
    if (request.targetProject !== undefined) {
      if (!isAbsolute(request.targetProject) || !request.targetProject.toLowerCase().endsWith(".csproj")) {
        throw new Error("INVALID_REQUEST: targetProject must be an absolute .csproj path");
      }
      ensureWithinRoot(request.root, request.targetProject, "targetProject");
    }
  } else if (request.target !== undefined || request.targetProject !== undefined) {
    throw new Error("INVALID_REQUEST: target and targetProject are only valid for move-type");
  }
}

function validateResult(result: BackendResult, root: string): void {
  if (result.backend !== "roslyn" || result.version !== "4.12.0") {
    throw new Error("CSHARP_PROTOCOL_ERROR: unexpected helper identity");
  }
  for (const change of result.changes) {
    if (typeof change.path !== "string" ||
        (change.before !== null && typeof change.before !== "string") ||
        (change.after !== null && typeof change.after !== "string") ||
        (change.before === null && change.after === null)) {
      throw new Error("CSHARP_PROTOCOL_ERROR: helper returned a malformed change");
    }
    if (!isAbsolute(change.path)) {
      throw new Error("CSHARP_PROTOCOL_ERROR: helper returned a relative change path");
    }
    ensureWithinRoot(root, change.path, "changed file");
  }
}

function ensureWithinRoot(root: string, path: string, label: string): void {
  const difference = relative(resolve(root), resolve(path));
  if (difference === ".." || difference.startsWith(`..${sep}`) || isAbsolute(difference)) {
    throw new Error(`OUTSIDE_ROOT: ${label} is outside root: ${path}`);
  }
}

async function findOrBuildHelper(): Promise<string> {
  // The target project's cwd is never a source of executable toolkit code.
  const configured = process.env.REFACTOR_AI_HOME;
  const directory = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = configured ? resolve(configured) : resolve(directory,
    basename(directory) === "backends" && basename(dirname(directory)) === "src" ? "../.." : "..");
  const dll = helperDll(sourceRoot);
  if (await exists(dll)) return dll;
  const project = join(sourceRoot, "dotnet", "RefactorHelper", "RefactorHelper.csproj");
  if (!await exists(project)) throw new Error("CSHARP_HELPER_NOT_FOUND: the selected toolkit root has no helper; set REFACTOR_AI_HOME to the package root");
  const { stdout, stderr, exitCode, timedOut } = await runDotnet([
    "build", project, "-c", "Release", "--nologo", "-p:RestoreLockedMode=true",
  ]);
  if (timedOut) throw new Error("CSHARP_HELPER_BUILD_TIMEOUT: build exceeded 120 seconds");
  if (exitCode !== 0) {
    throw new Error(`CSHARP_HELPER_BUILD_FAILED: ${(stderr || stdout).trim()}`);
  }
  return helperDll(sourceRoot);
}

function helperDll(root: string): string {
  return join(root, "dotnet", "RefactorHelper", "bin", "Release", "net8.0", "RefactorHelper.dll");
}

function processEnv(): Record<string, string | undefined> {
  return { ...process.env, DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1" };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function runDotnet(args: string[], input?: string): Promise<{
  stdout: string; stderr: string; exitCode: number; timedOut: boolean;
}> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("dotnet", args, { stdio: ["pipe", "pipe", "pipe"], env: processEnv() });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 120_000);
    child.on("error", error => {
      clearTimeout(timeout);
      reject(new Error(`CSHARP_HELPER_FAILED: ${error.message}`));
    });
    child.stdin.on("error", error => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
        clearTimeout(timeout);
        child.kill("SIGKILL");
        reject(error);
      }
    });
    child.on("close", code => {
      clearTimeout(timeout);
      resolveResult({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });
    child.stdin.end(input);
  });
}
