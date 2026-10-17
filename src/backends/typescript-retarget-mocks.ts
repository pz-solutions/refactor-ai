import ts from "typescript";
import { resolve } from "node:path";
import type { RefactorRequest } from "../types";
import { eolOf, fail, isInside } from "./typescript-vfs";
import { isModuleMockCall, moduleSpecifiers } from "./typescript-workspace";

interface Context {
  service: ts.LanguageService;
  options: ts.CompilerOptions;
  root: string;
  setText(file: string, text: string): void;
}

function mockCalls(source: ts.SourceFile, name: string): ts.CallExpression[] {
  return moduleSpecifiers(source).filter(specifier => specifier.text === name && isModuleMockCall(specifier.parent)
    && ts.isPropertyAccessExpression(specifier.parent.expression)
    && ["mock", "doMock"].includes(specifier.parent.expression.name.text)).map(specifier => specifier.parent as ts.CallExpression);
}

/** Reverse resolved imports, excluding registrations; test-runner actual/mock imports still load modules. */
export function affectedMockFiles(context: Context, affected: ts.SourceFile[], from: string): string[] {
  if (!affected.length) return [];
  const program = context.service.getProgram()!;
  const files = program.getSourceFiles().filter(source => isInside(context.root, resolve(source.fileName))
    && !source.fileName.replaceAll("\\", "/").includes("/node_modules/"));
  const callers = new Map<string, Set<string>>();
  const cache = ts.createModuleResolutionCache(context.root, path => path, context.options);
  for (const source of files) {
    for (const specifier of moduleSpecifiers(source)) {
      if (isModuleMockCall(specifier.parent) && ts.isPropertyAccessExpression(specifier.parent.expression)
        && !["importActual", "importMock", "requireActual", "requireMock"].includes(specifier.parent.expression.name.text)) continue;
      const mode = ts.getModeForUsageLocation(source, specifier, context.options);
      const target = ts.resolveModuleName(specifier.text, source.fileName, context.options, ts.sys, cache, undefined, mode).resolvedModule;
      if (!target) continue;
      const key = resolve(target.resolvedFileName);
      if (!callers.has(key)) callers.set(key, new Set());
      callers.get(key)!.add(resolve(source.fileName));
    }
  }
  const reached = new Set(affected.map(source => resolve(source.fileName)));
  const queue = [...reached];
  for (let index = 0; index < queue.length; index++) {
    for (const caller of callers.get(queue[index]!) ?? []) {
      if (reached.has(caller)) continue;
      reached.add(caller);
      queue.push(caller);
    }
  }
  return files.filter(source => reached.has(resolve(source.fileName)) && mockCalls(source, from).length)
    .map(source => source.fileName).sort();
}

/** Clone standalone registrations using the same callee and argument text; expression-valued calls fail closed. */
export function addParallelMocks(context: Context, files: string[], request: RefactorRequest): string[] {
  const added: string[] = [];
  for (const file of files) {
    const source = context.service.getProgram()!.getSourceFile(file)!;
    if (mockCalls(source, request.to!).length) continue;
    const edits: { start: number; text: string }[] = [];
    for (const call of mockCalls(source, request.from!)) {
      const statement = call.parent;
      if (!ts.isExpressionStatement(statement) || (!ts.isSourceFile(statement.parent) && !ts.isBlock(statement.parent))) {
        fail("UNSUPPORTED_MOCK_CALL", `${file}: --mocks add requires standalone mock statements in a source file or block; use --mocks report`);
      }
      const specifier = call.arguments[0] as ts.StringLiteralLike;
      const mode = ts.getModeForUsageLocation(source, specifier, context.options);
      if (!ts.resolveModuleName(request.to!, file, context.options, ts.sys, undefined, undefined, mode).resolvedModule) {
        fail("TARGET_UNRESOLVED", `${file} (${request.to})`);
      }
      const start = call.getStart(source);
      const quote = source.text[specifier.getStart(source)]!;
      const escaped = JSON.stringify(request.to!).slice(1, -1);
      const literal = quote === '"' ? JSON.stringify(request.to!) : quote + escaped.replaceAll(quote, match => `\\${match}`)
        .replaceAll("${", quote === "`" ? "\\${" : "${") + quote;
      const text = source.text.slice(start, specifier.getStart(source)) + literal + source.text.slice(specifier.end, call.end);
      const indent = source.text.slice(source.text.lastIndexOf("\n", statement.getStart(source)) + 1, statement.getStart(source)).match(/^[\t ]*/)?.[0] ?? "";
      // Terminate semicolon-free originals as well, retaining trailing comments on their original line.
      const tail = source.text.slice(statement.end);
      const trivia = /^(?:[\t ]|\/\*[^]*?\*\/)*(?:\/\/[^\r\n]*)?(?=\r?\n|$)/.exec(tail)?.[0];
      const end = statement.end + (trivia?.length ?? 0);
      const prefix = trivia === undefined && !source.text.slice(statement.getStart(source), statement.end).endsWith(";") ? ";" : "";
      edits.push({ start: end, text: `${prefix}${eolOf(source.text)}${indent}${text};` });
    }
    let text = source.text;
    for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.start);
    if (edits.length) { context.setText(file, text); added.push(file); }
  }
  return added;
}
