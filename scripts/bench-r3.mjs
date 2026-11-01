import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadavg } from 'node:os';
const [root, before, after, output] = process.argv.slice(2);
if (!root || !before || !after || !output) throw new Error('Usage: node scripts/bench-r3.mjs <target-root> <r2-cli> <r3-cli> <output-dir>');
mkdirSync(output,{recursive:true});
const digest = x => createHash('sha256').update(x).digest('hex');
const command = (...args) => spawnSync('git',args,{cwd:root,encoding:'utf8'}).stdout.trim();
const cases = [
 {name:'in-package',args:['--project','packages/app-features/tsconfig.json','--file','packages/app-features/src/shared/formatters.ts','--to','packages/app-features/src/shared/fmt/formatters.ts']},
 {name:'cross-package',args:['--project','apps/web/tsconfig.json','--file','apps/web/src/app/api/ksef/_lib/credential-crypto.ts','--to','packages/app-features/src/server/ksef/r3-credential-crypto.ts','--target-project','packages/app-features/tsconfig.json']}
];
const report = { mode:'cold Node processes, ts7, cache off, OS cache retained, paired sequential runs, no apply',root,node:process.version, beforeHash:digest(readFileSync(before)),afterHash:digest(readFileSync(after)),samples:[] };
for(const scenario of cases) for(let run=1;run<=3;run++) for(const [variant,cli] of [['r2',before],['r3',after]]) {
 const name=`${scenario.name}-${run}-${variant}`, plan=`${output}/${name}.json`;
 const commit=command('rev-parse','HEAD'), statusBefore=command('status','--porcelain'), machineLoad=loadavg(), start=performance.now();
 const result=spawnSync('node',[cli,'plan','move-file',...scenario.args,'--root',root,'--checker','ts7','--out',plan],{cwd:root,encoding:'utf8',timeout:240000,maxBuffer:32e6,env:{...process.env,REFACTOR_AI_CACHE:'off',REFACTOR_AI_TIMINGS:'on'}});
 const ms=Math.round(performance.now()-start), phases={};
 writeFileSync(`${output}/${name}.stderr`,result.stderr??'');writeFileSync(`${output}/${name}.stdout`,result.stdout??'');
 for(const line of (result.stderr??'').split('\n'))try{const j=JSON.parse(line);if(j.event==='end')phases[j.phase]=(phases[j.phase]??0)+j.ms;}catch{}
 let outcome;try{const p=JSON.parse(readFileSync(plan,'utf8'));outcome={snapshotHash:p.snapshot.hash,editHash:digest(JSON.stringify(p.changes)),id:p.id,validation:p.validation,checker:p.checker,files:p.changes.length,readSet:p.readSet?.length,notes:p.notes};}catch{outcome={error:result.stderr??result.error?.message};}
 report.samples.push({scenario:scenario.name,run,variant,ms,status:result.status,commit,statusBefore,statusAfter:command('status','--porcelain'),machineLoad,phases,outcome});
 writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2)+'\n');console.log(`${name}: ${ms}ms status=${result.status}`);
}
