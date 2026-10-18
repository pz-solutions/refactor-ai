// Native sync IPC uses Node file descriptors; exercise it in the supported Node runtime.
import { join } from "node:path";
import { Workspace } from "../../src/backends/typescript-workspace";
import { loadTs7Checker } from "../../src/backends/typescript-ts7";
import { createRefactorApi } from "../../src/api";
import { loadBackend } from "../../src/backends/load";
const input = JSON.parse(process.argv[2]!);
if (input.operation) {
  const api = createRefactorApi({ loadBackend });
  const plan = await api.plan(input);
  if (input.mutateChecker) {
    plan.checker!.version = "mutated by caller";
    process.stdout.write(JSON.stringify(await api.plan(input)));
  } else
  process.stdout.write(JSON.stringify(plan));
} else {
  const { root, changes } = input;
  const mode = input.checker === "ts7" ? "ts7" : "both";
  const checker = await loadTs7Checker(mode);
  let compared = 0;
  const ws = new Workspace(root, join(root, "tsconfig.json"), join(root, "tsconfig.json"), [], input => { compared++; return checker(input); }, mode);
  try {
    const validate = ws.prepareValidation();
    for (const [path, text] of Object.entries(changes)) ws.vfs.write(join(root, path), text as string | null);
    ws.reparse();
    process.stdout.write(JSON.stringify({ ...validate(), compared }));
  } finally { ws.dispose(); }
}
