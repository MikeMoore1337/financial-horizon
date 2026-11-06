import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const start=source.indexOf('async function refreshEmailSession(){');
const end=source.indexOf('\nasync function logoutEmailAccount(){',start);
assert.ok(start>0&&end>start);
const handler=source.slice(start,end);
function setup(refresh){
 const events=[],user='a'.repeat(32);
 const session={busy:false,userId:user,email:'qa@example.invalid',refresh};
 const ctx={guestMode:false,activeUserId:user,sessionValidation:null,emailSession:session,
  state:{entries:[{title:'local'}]},window:{location:{replace:url=>events.push(url)}},
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
 assert.deepEqual(s.events,['./account.html']);
});
test('a different account cannot re-use previous account data',async()=>{
 const s=setup(async()=>true);s.ctx.emailSession.userId='b'.repeat(32);
 assert.equal(await s.check(),false);
 assert.equal(s.ctx.state,null);
 assert.deepEqual(s.events,['./account.html']);
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
