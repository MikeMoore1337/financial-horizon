import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function restoreImplementation(path,next){
 const app=readFileSync(new URL(path,import.meta.url),'utf8');
 const start=app.indexOf('async function performRestore(password){');
 const end=app.indexOf('\n'+next,start);
 assert.ok(start>=0&&end>start);
 return app.slice(start,end);
}
const implementations=[
 ['modern',restoreImplementation('../app.js','// Owner-only')],
 ['legacy',restoreImplementation('../legacy/app.js','async function onFormSubmit(')],
];

function harness(implementation,withLegacyGuard=true){
 let generation=1,releaseDecrypt,notifyDecrypt,releaseConfirm,notifyConfirm;
 const decryptStarted=new Promise(resolve=>{notifyDecrypt=resolve;});
 const decryptGate=new Promise(resolve=>{releaseDecrypt=resolve;});
 const confirmStarted=new Promise(resolve=>{notifyConfirm=resolve;});
 const confirmGate=new Promise(resolve=>{releaseConfirm=resolve;});
 const events=[];
 const ctx={
  state:{revision:0},restoreFile:{text:async()=> 'synthetic backup'},
  captureStateScope:()=>{
   const captured=generation;
   return ()=>{if(captured!==generation)throw Error('профиль изменён');};
  },
  decryptBackup:async()=>{notifyDecrypt();return decryptGate;},
  requireConfirm:async()=>{events.push('confirm');notifyConfirm();return confirmGate;},
  mutate:async()=>events.push('mutate'),
 };
 ctx.legacyStorage=withLegacyGuard?{captureStateScope:ctx.captureStateScope}:{};
 return {
  run:()=>runInNewContext(implementation+'\nperformRestore("synthetic passphrase")',ctx),
  decryptStarted,confirmStarted,events,
  releaseDecrypt:()=>releaseDecrypt({revision:0}),
  releaseConfirm:()=>releaseConfirm(true),
  revoke:()=>{generation++;},
 };
}

for(const [name,implementation] of implementations){
 test(name+' restore never opens confirmation after profile changes during decryption',async()=>{
  const h=harness(implementation),pending=h.run();
  await h.decryptStarted;h.revoke();h.releaseDecrypt();h.releaseConfirm();
  await assert.rejects(pending,/профиль изменён/);
  assert.deepEqual(h.events,[]);
 });
 test(name+' restore never writes after profile changes during confirmation',async()=>{
  const h=harness(implementation),pending=h.run();
  await h.decryptStarted;h.releaseDecrypt();await h.confirmStarted;
  h.revoke();h.releaseConfirm();
  await assert.rejects(pending,/профиль изменён/);
  assert.deepEqual(h.events,['confirm']);
 });
 test(name+' restore continues only in its original profile',async()=>{
  const h=harness(implementation),pending=h.run();
  await h.decryptStarted;h.releaseDecrypt();await h.confirmStarted;h.releaseConfirm();
  await pending;
  assert.deepEqual(h.events,['confirm','mutate']);
 });
}
test('legacy restore refuses an old cached storage without the scope lease',async()=>{
 const h=harness(implementations[1][1],false);
 const pending=h.run();h.releaseDecrypt();h.releaseConfirm();
 await assert.rejects(pending,/Обновите приложение/);
 assert.deepEqual(h.events,[]);
});

test('backup verification cannot publish an old result after same-account reselection',async()=>{
 const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
 const start=app.indexOf('async function performVerifyBackup(password){');
 const end=app.indexOf('\nasync function performRestore(',start);
 assert.ok(start>=0&&end>start);
 let generation=1,release,notifyStarted;
 const started=new Promise(resolve=>{notifyStarted=resolve;});
 const gate=new Promise(resolve=>{release=resolve;});
 const status={textContent:''};
 const ctx={
  verifyBackupFile:{text:async()=> 'synthetic backup'},
  captureStateScope:()=>{const lease=generation;return ()=>{if(lease!==generation)throw Error('профиль изменён');};},
  activeUserId:'a'.repeat(32),guestMode:false,state:{revision:1},
  readState:async()=>({revision:1}),
  verifySavedFinancialBackupReadOnly:async()=>{notifyStarted();return gate;},
  $:()=>status,
 };
 const pending=runInNewContext(app.slice(start,end)+'\nperformVerifyBackup("synthetic passphrase")',ctx);
 await started;generation++;
 release({recordCounts:{entries:1,loans:0,settlements:0,loanPayments:0},matchesCurrent:true});
 await assert.rejects(pending,/профиль изменён/);
 assert.equal(status.textContent,'');
});

test('legacy confirmation resolves false when revoked and closed externally',async()=>{
 const app=readFileSync(new URL('../legacy/app.js',import.meta.url),'utf8');
 const start=app.indexOf('function requireConfirm(title,text){');
 const end=app.indexOf('\nasync function handleAction(',start);
 assert.ok(start>=0&&end>start);
 let onClose;
 const dialog={open:false,addEventListener(type,fn){if(type==='close')onClose=fn;},
  removeEventListener(type,fn){if(type==='close'&&onClose===fn)onClose=null;},
  showModal(){this.open=true;},close(){this.open=false;onClose?.();}};
 const items={'#confirmation-dialog':dialog,'#confirmation-title':{},'#confirmation-text':{},
  '#confirm-yes':{},'#confirm-cancel':{}};
 const pending=runInNewContext(app.slice(start,end)+'\nrequireConfirm("synthetic", "synthetic")',
  {$:selector=>items[selector]});
 dialog.close();
 assert.equal(await pending,false);
});

test('an earlier delayed close event cannot cancel a newly opened legacy confirmation',async()=>{
 const app=readFileSync(new URL('../legacy/app.js',import.meta.url),'utf8');
 const start=app.indexOf('function requireConfirm(title,text){');
 const end=app.indexOf('\nasync function handleAction(',start);
 const listeners=new Set(),events=[];
 const dialog={open:false,
  addEventListener(type,fn){if(type==='close')listeners.add(fn);},
  removeEventListener(type,fn){if(type==='close')listeners.delete(fn);},
  showModal(){this.open=true;},
  close(){this.open=false;events.push(()=>{for(const listener of [...listeners])listener();});},
 };
 const yes={},items={'#confirmation-dialog':dialog,'#confirmation-title':{},'#confirmation-text':{},
  '#confirm-yes':yes,'#confirm-cancel':{}};
 const create=runInNewContext(app.slice(start,end)+'\nrequireConfirm',{$:selector=>items[selector]});
 const first=create('one','one');yes.onclick();assert.equal(await first,true);
 const second=create('two','two');events.shift()();
 assert.equal(dialog.open,true,'old close event must not close the new dialog');
 yes.onclick();assert.equal(await second,true);
});
