import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const {runNamedValidation}=await import(pathToFileURL(path.resolve('kit/eval/live/process.mjs')));
for(let repeat=1;repeat<=2;repeat++) {
 const name=`pi-eval-integrity-validator-${Date.now()}`;
 const result=runNamedValidation({name,timeoutMs:1000,args:['--network','none','--user','10001:10001','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','128m','--cpus','1','--pids-limit','32','--entrypoint','node','fleet-capability-pi-agent:local','-e','setInterval(() => {}, 1000)']});
 const after=spawnSync('docker',['inspect',name],{encoding:'utf8',timeout:5000});
 assert.equal(result.error?.code,'ETIMEDOUT');
 assert.equal(after.status,1);
 assert.match(after.stderr,/no such object/i);
 console.log(JSON.stringify({repeat,name,validatorError:result.error.code,removed:true,modelCalls:0}));
}
