import ts from "typescript";
import { isModuleMockCall } from "./typescript-workspace";

function key(node: ts.Node, source: ts.SourceFile): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, node.getText(source));
  const tokens: unknown[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    tokens.push([kind, kind === ts.SyntaxKind.StringLiteral ? scanner.getTokenValue() : scanner.getTokenText()]);
  }
  return JSON.stringify(tokens);
}

/** Collapse identical mapped registrations only within an uninterrupted run of mocks. */
export function dedupeMappedMocks(file: string, text: string, targets: Set<string>): string {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const removed = new Set<ts.Statement>();
  const visit = (node: ts.Node) => {
    if (removed.has(node as ts.Statement)) return;
    if (ts.isSourceFile(node) || ts.isBlock(node)) {
      const seen = new Map<string, string>();
      for (const statement of node.statements) {
        const call = ts.isExpressionStatement(statement) ? statement.expression : undefined;
        if (!call || !isModuleMockCall(call) || !ts.isPropertyAccessExpression(call.expression)
          || !["mock", "doMock"].includes(call.expression.name.text)) { seen.clear(); continue; }
        const factory = call.arguments[1];
        if (call.arguments.length > 2 || (factory && !ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory) && !ts.isIdentifier(factory))) { seen.clear(); continue; }
        if (!targets.has((call.arguments[0] as ts.StringLiteralLike).text)) continue;
        const module = (call.arguments[0] as ts.StringLiteralLike).text;
        const signature = key(call, source);
        if (seen.get(module) === signature) removed.add(statement);
        else seen.set(module, signature);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const statement of [...removed].sort((a, b) => b.pos - a.pos)) {
    // Keep leading/trailing comments where they were, even when dropping a call.
    text = text.slice(0, statement.getStart(source)) + text.slice(statement.end);
  }
  return text;
}
