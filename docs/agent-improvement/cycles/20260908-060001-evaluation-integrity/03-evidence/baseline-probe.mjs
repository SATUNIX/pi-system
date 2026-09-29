import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=fs.readFileSync('kit/eval/live/run.mjs','utf8');
const start=source.indexOf('    if (name.startsWith("cyber"))');
const cyber=source.slice(start,source.indexOf('    if (name === "verify-failure") {',start));
const rows=[['anonymous','101',401],['anonymous','202',401],['alice','101',200],['bob','202',200],['alice','202',200],['bob','101',200]].map(([user,id,status])=>({method:'GET',user,path:'/invoices/'+id,status}));
for(let repeat=1;repeat<=2;repeat++){
 const base={name:'cyber',passed:true,targetLogFile:'target',priorTargetRequests:0,workspace:'workspace',dir:'case',path:{join:(...p)=>p.join('/')},writeJson:()=>{}};
 const probe={...base,fs:{existsSync:()=>true,readFileSync:()=>rows.map(JSON.stringify).join('\n')}};vm.runInNewContext(cyber,probe);assert.equal(probe.passed,true);
 const control={...base,fs:{existsSync:()=>true,readFileSync:()=>rows.slice(1).map(JSON.stringify).join('\n')}};vm.runInNewContext(cyber,control);assert.equal(control.passed,false);
 const missing={...base,fs:{readFileSync:()=>{const e=new Error('missing target evidence');e.code='ENOENT';throw e}}};assert.throws(()=>vm.runInNewContext(cyber,missing),{code:'ENOENT'});
 console.log(JSON.stringify({repeat,emptyExistingReport:'false_pass',incompleteMatrix:'fails_control',missingTargetLog:'uncaught_ENOENT'}));
}
assert.ok(source.indexOf('const validation = spawnSync')<source.indexOf('durationMs: Date.now() - started'));
assert.ok(source.includes('usage: ends.map((event) => event.message.usage)'));
console.log('Timing includes host validation; usage stores completed-message array without totals/completeness.');
