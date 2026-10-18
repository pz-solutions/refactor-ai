import ts from "typescript";
import { installationHint } from "./typescript-prechecks";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { RefactorRequest } from "../types";
import { isInside } from "./typescript-paths";
import { fail } from "./typescript-vfs";
import { addParallelMocks, affectedMockFiles } from "./typescript-retarget-mocks";

type Declaration = ts.ImportDeclaration | ts.ExportDeclaration;
type Member = ts.ImportSpecifier | ts.ExportSpecifier;
interface Context {
  service: ts.LanguageService;
  options: ts.CompilerOptions;
  root: string;
  setText(file: string, text: string): void;
  rename(file: string, position: number, name: string): void;
}
interface Selection { declaration: Declaration; target: string; members?: readonly Member[]; }

function identifier(name: string): boolean {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, name);
  return scanner.scan() === ts.SyntaxKind.Identifier && scanner.getTokenText() === name
    && scanner.scan() === ts.SyntaxKind.EndOfFileToken;
}

function mappedName(request: RefactorRequest | undefined, name: string): string | undefined {
  return request?.map && Object.hasOwn(request.map, name) ? request.map[name] : undefined;
}

function validate(request: RefactorRequest): void {
  if (!request.from || !request.to) fail("INVALID_REQUEST", "retarget-import requires from and to");
  if (request.from.includes("*") || request.to.includes("*")) fail("UNSUPPORTED_SPECIFIER", "retarget-import requires exact specifiers; wildcard prefixes are unsupported");
  if (request.from === request.to) fail("INVALID_REQUEST", "from and to must differ");
  if (request.mocks !== undefined && !["report", "add"].includes(request.mocks)) fail("INVALID_REQUEST", "mocks must be report or add");
  if (request.only && (!Array.isArray(request.only) || !request.only.length || request.only.some(name => !name))) {
    fail("INVALID_REQUEST", "only must contain pre-map export names");
  }
  for (const [from, to] of Object.entries(request.map ?? {})) {
    if (!identifier(from) || !identifier(to)) fail("INVALID_NAME", `invalid export mapping ${from}=${to}`);
  }
}

function members(node: Declaration): readonly Member[] | undefined {
  if (ts.isImportDeclaration(node)) {
    const bindings = node.importClause?.namedBindings;
    return bindings && ts.isNamedImports(bindings) ? bindings.elements : undefined;
  }
  return node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : undefined;
}

function selections(source: ts.SourceFile, request: RefactorRequest): Selection[] {
  const found: Selection[] = [];
  for (const node of source.statements) {
    if ((!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) || !node.moduleSpecifier
      || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== request.from) continue;
    const list = members(node);
    if (request.only && ts.isImportDeclaration(node) && (node.importClause?.name || (node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)))) {
      fail("UNSUPPORTED_SELECTION", `${source.fileName}: --only cannot select default or namespace imports`);
    }
    const selected = list?.filter(item => !request.only || request.only.includes((item.propertyName ?? item.name).text));
    if (request.only && !selected?.length) continue;
    found.push({ declaration: node, target: request.to!, members: selected });
  }
  return found;
}

function selectedFiles(context: Context, request: RefactorRequest): ts.SourceFile[] {
  const scope = resolve(request.file);
  if (!isInside(context.root, scope)) fail("OUTSIDE_ROOT", scope);
  let directory = true;
  if (!request.projectScope) {
    try { directory = statSync(scope).isDirectory(); } catch { fail("FILE_NOT_FOUND", scope); }
  }
  const files = context.service.getProgram()!.getSourceFiles().filter(source =>
    !context.service.getProgram()!.isSourceFileDefaultLibrary(source)
    && !source.fileName.replaceAll("\\", "/").includes("/node_modules/")
    && isInside(context.root, resolve(source.fileName))
    && (request.projectScope || (directory ? isInside(scope, resolve(source.fileName)) : resolve(source.fileName) === scope)));
  if (!directory && !files.length) fail("FILE_NOT_IN_PROJECT", scope);
  return files.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

/** Add an explicit alias before asking TS to rename, so the upstream export stays intact. */
function renameBindings(context: Context, file: string, request: RefactorRequest): Set<string> {
  const renamed = new Set<string>();
  for (;;) {
    const source = context.service.getProgram()!.getSourceFile(file)!;
    const match = selections(source, request).flatMap((selection, index) => (selection.members ?? []).map(member => ({
      item: member, key: `${index}:${members(selection.declaration)!.indexOf(member)}`,
    }))).find(({ item }) => ts.isImportSpecifier(item) && !item.propertyName && mappedName(request, item.name.text)
      && mappedName(request, item.name.text) !== item.name.text);
    if (!match) return renamed;
    const { item, key } = match;
    renamed.add(key);
    const end = item.name.end;
    context.setText(file, source.text.slice(0, end) + ` as ${item.name.text}` + source.text.slice(end));
    context.rename(file, end + 4, mappedName(request, item.name.text)!);
    // rename leaves `Old as New`; it will be collapsed while retargeting.
  }
}

function replace(text: string, edits: ts.TextChange[]): string {
  let boundary = text.length;
  for (const edit of edits.sort((a, b) => b.span.start - a.span.start)) {
    const end = edit.span.start + edit.span.length;
    if (end > boundary) fail("OVERLAPPING_EDITS", "retarget-import declarations overlap");
    text = text.slice(0, edit.span.start) + edit.newText + text.slice(end);
    boundary = edit.span.start;
  }
  return text;
}

/** Keep member trivia (including comments) attached to that member when splitting. */
function memberText(source: ts.SourceFile, list: readonly Member[], item: Member, request?: RefactorRequest, collapseAlias = false): string {
  const index = list.indexOf(item);
  const limit = list[index + 1]?.pos ?? item.parent.end - 1;
  let raw = source.text.slice(item.pos, limit);
  const edits: ts.TextChange[] = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, raw);
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    if (scanner.getToken() === ts.SyntaxKind.CommaToken) edits.push({ span: { start: scanner.getTokenPos(), length: 1 }, newText: "" });
  }
  const imported = item.propertyName ?? item.name;
  const mapped = mappedName(request, imported.text);
  if (mapped && mapped !== imported.text) {
    edits.push({ span: { start: imported.getStart(source) - item.pos, length: imported.end - imported.getStart(source) }, newText: mapped });
    // Preserve explicit local and public re-export aliases. A local binding renamed above
    // has the same name as its new export and no longer needs an alias.
    if (collapseAlias && ts.isImportSpecifier(item) && item.propertyName && item.name.text === mapped) {
      const between = source.text.slice(item.propertyName.end, item.name.end);
      if (!between.includes("/*") && !between.includes("//")) edits.push({ span: { start: item.propertyName.end - item.pos, length: item.name.end - item.propertyName.end }, newText: "" });
    }
  }
  raw = replace(raw, edits).trim();
  return raw.includes("//") ? raw + (source.text.includes("\r\n") ? "\r\n" : "\n") : raw;
}

function memberTokens(text: string): { key: string; comments: string } {
  const tokens: string[] = [], comments: string[] = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    const kind = scanner.getToken();
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia) comments.push(scanner.getTokenText() + (text.includes("\r\n") ? "\r\n" : "\n"));
    else if (kind === ts.SyntaxKind.MultiLineCommentTrivia) comments.push(scanner.getTokenText() + " ");
    else if (kind > ts.SyntaxKind.LastTriviaToken) tokens.push(scanner.getTokenText());
  }
  return { key: JSON.stringify(tokens), comments: comments.join("") };
}

function mergeMembers(existing: string[], moved: string[]): void {
  for (const text of moved) {
    const { key, comments } = memberTokens(text);
    const index = existing.findIndex(item => memberTokens(item).key === key);
    if (index < 0) existing.push(text);
    else if (comments) existing[index] = comments + existing[index];
  }
}

function namedText(items: string[]): string { return `{ ${items.join(", ")} }`; }
function typeOnly(node: Declaration): boolean { return ts.isImportDeclaration(node) ? !!node.importClause?.isTypeOnly : node.isTypeOnly; }
function attributes(node: Declaration, source: ts.SourceFile): string { return node.attributes?.getText(source) ?? ""; }

function outerComments(source: ts.SourceFile, node: Declaration, named: ts.Node): string {
  const start = node.getStart(source), text = node.getText(source);
  const outside = text.slice(0, named.getStart(source) - start) + text.slice(named.end - start);
  return memberTokens(outside).comments;
}

function transformFile(source: ts.SourceFile, request: RefactorRequest, renamed: Set<string>): string {
  const replacements = new Map<Declaration, string>();
  const additions = new Map<ts.ImportDeclaration, string[]>();
  const newline = source.text.includes("\r\n") ? "\r\n" : "\n";
  for (const [index, selection] of selections(source, request).entries()) {
    const node = selection.declaration, module = node.moduleSpecifier!;
    const list = members(node), chosen = selection.members;
    const quote = source.text[module.getStart(source)];
    const literal = quote + selection.target.replaceAll("\\", "\\\\").replaceAll(quote!, `\\${quote}`) + quote;
    const edit: ts.TextChange[] = [{ span: { start: module.getStart(source) - node.getStart(source), length: module.getWidth(source) }, newText: literal }];
    if (!list || !chosen?.length) {
      replacements.set(node, replace(node.getText(source), edit));
      continue;
    }
    const remaining = list.filter(item => !chosen.includes(item));
    const moved = chosen.map(item => memberText(source, list, item, request, renamed.has(`${index}:${list.indexOf(item)}`)));
    const named = list[0]!.parent;
    const pureNamed = ts.isImportDeclaration(node) && !node.importClause?.name;
    const merge = pureNamed ? source.statements.find((other): other is ts.ImportDeclaration =>
      ts.isImportDeclaration(other) && ts.isStringLiteral(other.moduleSpecifier) && other.moduleSpecifier.text === selection.target
      && !!other.importClause && (!other.importClause.namedBindings || ts.isNamedImports(other.importClause.namedBindings))
      && !(other.importClause.isTypeOnly && other.importClause.name)
      && typeOnly(other) === typeOnly(node) && attributes(other, source) === attributes(node, source)) : undefined;
    if (merge) {
      const existing = members(merge) ?? [];
      const texts = additions.get(merge) ?? existing.map(item => memberText(source, existing, item));
      mergeMembers(texts, moved);
      additions.set(merge, texts);
    }
    if (remaining.length) {
      const original = replace(node.getText(source), [{ span: { start: named.getStart(source) - node.getStart(source), length: named.getWidth(source) }, newText: namedText(remaining.map(item => memberText(source, list, item))) }]);
      const kind = ts.isImportDeclaration(node) ? "import" : "export";
      const suffix = source.text.slice(module.end, node.end);
      replacements.set(node, original + (merge ? "" : `${newline}${kind}${typeOnly(node) ? " type" : ""} ${namedText(moved)} from ${literal}${suffix}`));
    } else if (merge) replacements.set(node, outerComments(source, node, named));
    else if (!chosen.some(item => mappedName(request, (item.propertyName ?? item.name).text))) {
      replacements.set(node, replace(node.getText(source), edit));
    } else {
      edit.push({ span: { start: named.getStart(source) - node.getStart(source), length: named.getWidth(source) }, newText: namedText(moved) });
      replacements.set(node, replace(node.getText(source), edit));
    }
  }
  for (const [node, texts] of additions) {
    const named = node.importClause!.namedBindings;
    const start = node.getStart(source);
    const span = named ? { start: named.getStart(source) - start, length: named.getWidth(source) }
      : { start: node.importClause!.name!.end - start, length: 0 };
    replacements.set(node, replace(node.getText(source), [{ span, newText: (named ? "" : ", ") + namedText(texts) }]));
  }
  return replace(source.text, [...replacements].map(([node, newText]) => ({ span: { start: node.getStart(source), length: node.getWidth(source) }, newText })));
}

export function retargetImports(context: Context, request: RefactorRequest): string[] {
  validate(request);
  const affected = selectedFiles(context, request).filter(source => selections(source, request).length);
  const unresolved: string[] = [];
  const cache = ts.createModuleResolutionCache(ts.sys.getCurrentDirectory(), path => path, context.options);
  for (const source of affected) {
    for (const { declaration, target } of selections(source, request)) {
      const mode = ts.getModeForUsageLocation(source, declaration.moduleSpecifier! as ts.StringLiteral, context.options);
      if (!ts.resolveModuleName(target, source.fileName, context.options, ts.sys, cache, undefined, mode).resolvedModule) {
        unresolved.push(`${source.fileName} (${target})`);
      }
    }
  }
  if (unresolved.length) fail("TARGET_UNRESOLVED", [...new Set(unresolved)].sort().join(", ") + installationHint(context.root, affected[0]!.fileName));
  const mocks = affectedMockFiles(context, affected, request.from!);
  if (!request.map || Object.keys(request.map).length === 0) {
    // No binding can change another selected file. Prepare every text from the
    // original immutable sources before invalidating the service once per batch.
    const edits = affected.map(source => [source.fileName, transformFile(source, request, new Set())] as const);
    for (const [file, text] of edits) context.setText(file, text);
  } else {
    for (const source of affected) {
      const renamed = renameBindings(context, source.fileName, request);
      const current = context.service.getProgram()!.getSourceFile(source.fileName)!;
      context.setText(source.fileName, transformFile(current, request, renamed));
    }
  }
  const notes = affected.length ? ["Retargeted imports/re-exports; compiler validation does not prove runtime API compatibility."]
    : ["No matching imports or re-exports; no changes."];
  if (request.mocks === "add") {
    const added = addParallelMocks(context, mocks, request);
    if (added.length) notes.push(`Added parallel mocks for ${request.to} in: ${added.join(", ")}. Review factory runtime compatibility.`);
  } else if (mocks.length) {
    notes.push(`Tests mocking ${request.from} import retargeted files: ${mocks.join(", ")}. Review mocks or use --mocks add.`);
  }
  return notes;
}
