"""Recreate historical pre-move events inputs in a disposable 9f66b9dc worktree.

Usage: python3 scripts/prepare-r4-events.py /tmp/ra-target /path/to/events/refactor.log
Requires the recorded events commit 67b19ec8 in the target Git object database.
Only /tmp targets are accepted. Existing prepared destinations must be restored
by bench-r4 before invoking this script again.
"""
from pathlib import Path
import subprocess,re,json,sys
root=Path(sys.argv[1]).resolve()
if not str(root).startswith('/tmp/'): raise Exception('Use a disposable /tmp worktree')
if not subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).startswith('9f66b9dc'): raise Exception('Expected 9f66b9dc')
log=Path(sys.argv[2]).read_text()
names=['event-search-params.ts','events-client.helpers.ts','events-table-row.helpers.ts','events-table-row.tsx','events-table.columns.tsx','event-edit-dialog.tsx','events-client.sections.tsx','events-client.tsx','events-client.helpers.test.ts','events-table-row.helpers.test.ts','events-table-row.test.tsx','events-table.columns.test.tsx','events-client.test.tsx']
base='apps/web/src/app/[locale]/dashboard/events/'
inputs={}
for name in names:
 path=base+name
 pattern=re.compile(r'^--- a/'+re.escape(path)+r'[^\n]*\n\+\+\+ /dev/null[^\n]*\n@@ -1,(\d+) \+0,0 @@\n',re.M)
 match=pattern.search(log)
 if not match: raise Exception(path)
 lines=log[match.end():].splitlines()[:int(match[1])]
 assert all(line.startswith('-') for line in lines),(path,lines[-1])
 text='\n'.join(line[1:] for line in lines)+'\n'
 # These inputs were captured immediately before each sequential move. Restore
 # their already-moved internal dependencies so the batch starts as one slice.
 for other in names:
  text=text.replace('@uber-platform/app-features/events/'+other.rsplit('.',1)[0], './'+other.rsplit('.',1)[0])
 if name == 'events-table.columns.test.tsx': text=text.replace('NextIntlClientProvider','IntlProvider')
 inputs[path]=text
for path,text in inputs.items():
 (root/path).write_text(text)
def blob(path): return subprocess.check_output(['git','show','67b19ec8:'+path],cwd=root,text=True)
for path in [base+'_hooks/preload-events.ts',base+'events-adapter.tsx',base+'page.tsx','packages/app-features/src/events/types.ts']:
 text=blob(path)
 for other in names:
  text=text.replace('@uber-platform/app-features/events/'+other.rsplit('.',1)[0], './'+other.rsplit('.',1)[0] if not path.endswith('preload-events.ts') else '../'+other.rsplit('.',1)[0])
 (root/path).parent.mkdir(parents=True,exist_ok=True); (root/path).write_text(text)
p=root/'packages/app-features/package.json'; j=json.loads(p.read_text()); j['exports']['./events/types']='./src/events/types.ts';p.write_text(json.dumps(j,indent=2)+'\n')

print('Prepared 13 historical pre-move inputs plus the actual type split and Next adapter; base',subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip())
