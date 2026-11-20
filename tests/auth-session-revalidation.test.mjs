import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const start=source.indexOf('async function refreshEmailSession(){');
const end=source.indexOf('\nasync function logoutEmailAccount(){',start);
assert.ok(start>0&&end>start);
const revokeStart=source.indexOf('function revokeDisplayedLedger(){');
const revokeEnd=source.indexOf('\nconst hasData=',revokeStart);
assert.ok(revokeStart>=0&&revokeEnd>revokeStart);
const handler=source.slice(revokeStart,revokeEnd)+'\n'+source.slice(start,end);
function setup(refresh){
 const events=[],user='a'.repeat(32);
 const session={busy:false,userId:user,email:'qa@example.invalid',refresh};
 const ctx={guestMode:false,activeUserId:user,sessionValidation:null,emailSession:session,
  state:{entries:[{title:'local'}]},
  restoreFile:{synthetic:'backup'},pendingExcelImport:{synthetic:'import'},
  cloudImportFile:{synthetic:'backup'},pendingCloudImport:{synthetic:'plaintext'},
  cloudImportController:null,
  scheduleLoanId:'synthetic-id',lastDialogActivator:{synthetic:'modal'},
  revokeStateScope:()=>events.push('scope-revoked'),
  document:{querySelectorAll(selector){
   assert.equal(selector,'dialog');
   return [{open:true,close:()=>events.push('dialog-closed'),
    replaceChildren:()=>events.push('dialog-cleared')}];
  }},
  screenRoot:{unmount:()=>events.push('react-unmount')},
  navRoots:{unmount:()=>events.push('nav-unmount')},
  $:()=>({replaceChildren:()=>events.push('ledger-cleared')}),
  window:{location:{replace:url=>events.push(url)}},
  syncAccountControls:()=>events.push('sync')};
 return {check:runInNewContext(handler+'\nrefreshEmailSession',ctx),ctx,events};
}
test('revalidation is single-flight while two browser events overlap',async()=>{
 let release,calls=0;
 const s=setup(()=>{calls++;return new Promise(resolve=>{release=resolve;});});
 const a=s.check(),b=s.check();
 assert.equal(calls,1);
 release(true);
 assert.deepEqual(await Promise.all([a,b]),[true,true]);
 assert.deepEqual(s.events,['sync']);
 assert.notEqual(s.ctx.state,null);
 const again=s.check();
 assert.equal(calls,2);
 release(true);
 assert.equal(await again,true);
});
test('expired session hides the old account ledger and opens login',async()=>{
 const s=setup(async()=>false);
 assert.equal(await s.check(),false);
 assert.equal(s.ctx.state,null);
 assert.equal(s.ctx.screenRoot,null);
 assert.equal(s.ctx.navRoots,null);
  assert.equal(s.ctx.cloudImportFile,null);
  assert.equal(s.ctx.pendingCloudImport,null);
 assert.deepEqual(s.events,['scope-revoked','react-unmount','nav-unmount','ledger-cleared','dialog-closed','dialog-cleared','./account.html']);
});
test('a different account cannot re-use previous account data',async()=>{
 const s=setup(async()=>true);s.ctx.emailSession.userId='b'.repeat(32);
 assert.equal(await s.check(),false);
 assert.equal(s.ctx.state,null);
 assert.equal(s.ctx.screenRoot,null);
 assert.equal(s.ctx.navRoots,null);
 assert.deepEqual(s.events,['scope-revoked','react-unmount','nav-unmount','ledger-cleared','dialog-closed','dialog-cleared','./account.html']);
});
test('guest mode and pending logout must not run a session check',async()=>{
 const s=setup(async()=>{throw Error('Must not run');});
 s.ctx.guestMode=true;assert.equal(await s.check(),true);
 s.ctx.guestMode=false;s.ctx.emailSession.busy=true;
 assert.equal(await s.check(),true);
});
test('focus, visibility and restored pages trigger validated refresh',()=>{
 assert.match(source,/addEventListener\('focus',/);
 assert.match(source,/addEventListener\('visibilitychange',/);
 assert.match(source,/if\(!await refreshEmailSession\(\)\)return;/);
});
