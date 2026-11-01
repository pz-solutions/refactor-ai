import ts from "typescript";

/** Merge the configured per-param destructuring snippets into one hook call. */
export function mergeParamHooks(lines: string[]): string[] {
  const groups = new Map<string, { index: number; bindings: string[]; types: string[]; callee: string }>();
  const output: string[] = [];
  for (const line of lines) {
    const source = ts.createSourceFile("setup.ts", line, ts.ScriptTarget.Latest, true);
    const statement = source.statements[0];
    const declaration = statement && ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1 ? statement.declarationList.declarations[0] : undefined;
    const call = declaration?.initializer;
    if (!declaration || source.statements.length !== 1 || !ts.isObjectBindingPattern(declaration.name) || !call || !ts.isCallExpression(call)
      || call.arguments.length || !/(?:^|\.)useParams$/.test(call.expression.getText(source))
      || declaration.name.elements.some(element => element.initializer || element.dotDotDotToken)
      || (call.typeArguments?.length && (call.typeArguments.length !== 1 || !ts.isTypeLiteralNode(call.typeArguments[0]!)))) {
      output.push(line); continue;
    }
    const callee = call.expression.getText(source), typed = !!call.typeArguments?.length;
    const key = `${callee}:${typed}:${(statement as ts.VariableStatement).declarationList.flags}`;
    const group = groups.get(key) ?? { index: output.length, bindings: [], types: [], callee };
    if (!groups.has(key)) { groups.set(key, group); output.push(line); }
    group.bindings.push(...declaration.name.elements.map(element => element.getText(source)));
    if (typed) group.types.push(...(call.typeArguments![0] as ts.TypeLiteralNode).members.map(member => member.getText(source).replace(/;?$/, ";")));
    const kind = (statement as ts.VariableStatement).declarationList.flags & ts.NodeFlags.Const ? "const" : "let";
    output[group.index] = `${kind} { ${[...new Set(group.bindings)].join(", ")} } = ${callee}${typed ? `<{ ${[...new Set(group.types)].join(" ")} }>` : ""}();`;
  }
  return output;
}
