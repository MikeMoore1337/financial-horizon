import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function backupImplementation(path,next){
 const app=readFileSync(new URL(path,import.meta.url),'utf8');
 const start=app.indexOf('async function performBackup(password){');
 const end=app.indexOf('\nasync function '+next+'(',start);
 assert.ok(start>=0&&end>start);
 return app.slice(start,end);
}
const implementations=[
 ['modern',backupImplementation('../app.js','performVerifyBackup')],
 ['legacy',backupImplementation('../legacy/app.js','performRestore')],
];

function harness(implementation,withLegacyGuard=true){
 let generation=1,release,notifyStarted;
 const started=new Promise(resolve=>{notifyStarted=resolve;});
 const pendingEncryption=new Promise(resolve=>{release=resolve;});
 const events=[];
 const ctx={
  readState:async()=>({synthetic:'private'}),
  captureStateScope:()=>{
   const captured=generation;
   return ()=>{if(captured!==generation)throw Error('профиль изменён');};
  },
  encryptBackup:async()=>{notifyStarted();return pendingEncryption;},
  URL:{createObjectURL:()=>{events.push('url');return 'blob:synthetic';},revokeObjectURL(){}},
  Blob:class {},
  document:{createElement:()=>({click(){events.push('download');}})},
  today:()=> '2026-11-23',setTimeout:()=>{},toast:()=>events.push('toast'),
 };
 ctx.legacyStorage=withLegacyGuard?{captureStateScope:ctx.captureStateScope}:{};
 const run=()=>runInNewContext(implementation+'\nperformBackup("synthetic passphrase")',ctx);
 return {run,started,release,events,revoke(){generation++;}};
}

for(const [name,implementation] of implementations){
test(name+' backup completion cannot download previous scope after revocation or reselection',async()=>{
 const h=harness(implementation),pending=h.run();
 await h.started;
 h.revoke();
 h.release('synthetic ciphertext');
 await assert.rejects(pending,/профиль изменён/);
 assert.deepEqual(h.events,[]);
});

test(name+' backup completion downloads when its scope is still current',async()=>{
 const h=harness(implementation),pending=h.run();
 await h.started;
 h.release('synthetic ciphertext');
 await pending;
 assert.deepEqual(h.events,['url','download','toast']);
});
}

test('legacy backup fails closed if an old cached storage lacks the scope lease',async()=>{
 const h=harness(implementations[1][1],false);
 await assert.rejects(h.run(),/Обновите приложение/);
 assert.deepEqual(h.events,[]);
});
