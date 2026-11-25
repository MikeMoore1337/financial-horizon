import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../legacy/app.js',import.meta.url),'utf8');
function slice(begin,end){
 const a=source.indexOf(begin),b=source.indexOf(end,a);
 assert.ok(a>=0&&b>a,'legacy entry section missing: '+begin);
 return source.slice(a,b);
}
const handler=slice('function revokeDisplayedLedger(){','\nconst hasData=')+
 '\n'+slice('async function refreshEmailSession(){','\nasync function logoutEmailAccount(){')+
 '\n'+slice('async function logoutEmailAccount(){','\nfunction pageHead(');

function runtime({refreshResult=true,logoutResult=true,logoutError=null}={}){
 const events=[],owner='a'.repeat(32);
 const state={entries:[{id:'secret',title:'PRIVATE_OLD_PWA',amountCents:12345}]};
 const emailSession={
  busy:false,email:'owner@example.invalid',userId:owner,
  async refresh(){events.push('session-refresh');return refreshResult;},
  async logout(){
   events.push('server-logout');
   if(logoutError)throw logoutError;
   if(logoutResult){this.email=null;this.userId=null;}
   return logoutResult;
  },
 };
 const ctx={
  Error,guestMode:false,busy:false,activeUserId:owner,
  emailSession,sessionValidation:null,
  state,restoreFile:{name:'encrypted-backup'},pendingExcelImport:{name:'sheet'},
  scheduleLoanId:'private-loan-id',lastDialogActivator:{id:'private-dialog'},
  GUEST_MODE_KEY:'fh-guest-session-v2',
  legacyStorage:{revokeStateScope:()=>events.push('scope-revoked')},
  $:selector=>{
   assert.equal(selector,'#main');
   return {replaceChildren:()=>events.push('main-cleared')};
  },
  document:{querySelectorAll:selector=>{
   assert.equal(selector,'dialog');
   return [{open:true,close:()=>events.push('dialog-closed'),
    replaceChildren:()=>events.push('dialog-cleared')}];
  }},
  authBroadcast:{postMessage:x=>events.push('broadcast:'+x.type)},
  sessionStorage:{removeItem:key=>events.push('session-removed:'+key)},
  window:{location:{replace:path=>events.push('redirect:'+path)}},
  toast:(message,type)=>events.push('toast:'+type+':'+message),
  syncAccountControls:()=>events.push('controls-synced'),
 };
 const handlers=runInNewContext(handler+'\n({revokeDisplayedLedger,refreshEmailSession,logoutEmailAccount})',ctx);
 return {events,ctx,emailSession,handlers};
}

test('legacy logout revokes old IDB scope before wiping modal finance and redirecting',async()=>{
 const x=runtime();await x.handlers.logoutEmailAccount();
 const e=x.events;
 assert.ok(e.indexOf('server-logout')>=0);
 assert.ok(e.indexOf('scope-revoked')>e.indexOf('server-logout'));
 assert.ok(e.indexOf('scope-revoked')<e.indexOf('main-cleared'));
 assert.ok(e.indexOf('main-cleared')<e.indexOf('redirect:./account.html'));
 assert.ok(e.indexOf('dialog-cleared')<e.indexOf('redirect:./account.html'));
 assert.ok(e.includes('broadcast:logout'));
 for(const name of ['state','restoreFile','pendingExcelImport','scheduleLoanId','lastDialogActivator'])
  assert.equal(x.ctx[name],null,name+' must be cleared');
});

test('legacy failed refresh or changed identity clears financial memory before redirect',async()=>{
 for(const result of [false,true]){
  const x=runtime({refreshResult:result});
  if(result)x.emailSession.userId='b'.repeat(32);
  assert.equal(await x.handlers.refreshEmailSession(),false);
  const e=x.events;
  assert.ok(e.indexOf('scope-revoked')<e.indexOf('main-cleared'));
  assert.ok(e.indexOf('dialog-cleared')<e.indexOf('redirect:./account.html'));
  assert.equal(x.ctx.state,null);
 }
});

test('verified session remains usable, and failed logout does not revoke valid data',async()=>{
 const ok=runtime();
 assert.equal(await ok.handlers.refreshEmailSession(),true);
 assert.equal(ok.ctx.state.entries[0].title,'PRIVATE_OLD_PWA');
 assert.deepEqual(ok.events,['session-refresh','controls-synced']);
 const failed=runtime({logoutError:Error('Сервер недоступен')});
 await failed.handlers.logoutEmailAccount();
 assert.equal(failed.ctx.state.entries.length,1);
 assert.equal(failed.events.includes('scope-revoked'),false);
 assert.equal(failed.events.some(x=>x.startsWith('redirect:')),false);
 assert.ok(failed.events.some(x=>x.startsWith('toast:error:')));
});

test('legacy compatibility entry uses namespace import and blocks missing hook in account mode',()=>{
 assert.match(source,/import \* as legacyStorage from '\.\/storage\.js\?rev=auth-scopes-v18'/);
 assert.match(source,/if\(typeof legacyStorage\.revokeStateScope!==\'function\'\)/);
 assert.match(source,/if\(event\.data\?\.type==='logout'&&event\.data\.userId===activeUserId\)\{\s*revokeDisplayedLedger\(\)/);
 assert.match(source,/channel\.onmessage=async\(\)=>\{if\(!state\)return;/);
 const pageshow=slice("window.addEventListener('pageshow',","\n try{channel=");
 assert.ok(pageshow.indexOf('revokeDisplayedLedger()')>=0);
 assert.ok(pageshow.indexOf('revokeDisplayedLedger()')<pageshow.indexOf("window.location.replace('./')"));
});
