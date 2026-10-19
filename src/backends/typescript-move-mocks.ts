import type ts from "typescript";
import { moveMapEntries } from "./typescript-retarget-import";
import type { RefactorRequest } from "../types";
import { addParallelMocks, affectedMockFiles, type MockInsertions } from "./typescript-retarget-mocks";
import { moveMappings } from "./typescript-prechecks";
import type { Workspace } from "./typescript-workspace";

/** Keep original mocks for unmoved consumers; optionally register the mapped API too. */
export function prepareMoveMocks(ws: Workspace, renames: [string, string][], request: RefactorRequest, notes: string[]): (onInsert?: MockInsertions) => void {
  const moved = new Set(renames.map(([file]) => ws.vfs.key(file)));
  const groups = new Map<string, { from: string; to: string; sources: string[] }>();
  for (const [file, target] of renames) {
    for (const { from, to } of moveMapEntries(moveMappings(ws.root, target, request.map, ws.vfs.inputs.sys))) {
      if (from === to) continue;
      const key = JSON.stringify([from, to]);
      const group = groups.get(key) ?? { from, to, sources: [] };
      group.sources.push(file);
      groups.set(key, group);
    }
  }
  const context = { sys: ws.vfs.moduleResolutionHost(), service: ws.service, options: ws.editOptions, optionsFor: (source: ts.SourceFile) => { const owner = ws.ownersOf(source.fileName)[0]; return owner ? ws.participant(owner).parsed.options : ws.editOptions; }, root: ws.root, setText: (file: string, text: string) => ws.vfs.write(file, text) };
  const program = ws.program();
  const pending = [...groups.values()].map(group => ({ ...group,
    files: affectedMockFiles(context, group.sources.flatMap(file => { const source = program.getSourceFile(file); return source ? [source] : []; }), group.from)
      .filter(file => !moved.has(ws.vfs.key(file))),
  }));
  return onInsert => {
    for (const { from, to, files } of pending) {
      if (!files.length) continue;
      if (request.mocks === "add") {
        const added = addParallelMocks({ ...context, onInsert }, files, { ...request, from, to });
        if (added.length) notes.push(`Added parallel mocks for ${to} in ${added.join(", ")}; review factory runtime compatibility.`);
      } else notes.push(`Tests mocking ${from} import moved files: ${files.join(", ")}; review mocks or use --mocks add for ${to}.`);
    }
  };
}
