import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const get=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const app=get('app.js');
const start=app.indexOf('async function logoutEmailAccount(){');
const end=app.indexOf('\nfunction pageHead(',start);
assert.ok(start>=0&&end>start,'Logout handler must be present in app.js');
const revokeStart=app.indexOf('function revokeDisplayedLedger(){');
const revokeEnd=app.indexOf('\nconst hasData=',revokeStart);
assert.ok(revokeStart>=0&&revokeEnd>revokeStart);
const handler=app.slice(revokeStart,revokeEnd)+'\n'+app.slice(start,end);

function invoke({email='test@example.com',userId=email?'a'.repeat(32):null,logout,initialBusy=false}={}){
 const events=[];
 const session={
  email,userId,busy:initialBusy,
  async logout(){
   events.push('logout-request');
   return logout?logout(session):true;
  }
 };
 const ctx={
  Error, // Match the browser realm for instanceof Error in the handler.
  busy:false,
  activeUserId:'a'.repeat(32),
  authBroadcast:null,
  restoreFile:{synthetic:'private'},pendingExcelImport:{synthetic:'private'},
   cloudImportFile:{synthetic:'backup'},pendingCloudImport:{synthetic:'plaintext'},
   cloudImportController:{abort:()=>events.push('import-aborted')},
  scheduleLoanId:'private-loan',lastDialogActivator:{synthetic:'private'},
  revokeStateScope:()=>events.push('scope-revoked'),
  document:{querySelectorAll(selector){
   assert.equal(selector,'dialog');
   return [{open:true,close:()=>events.push('dialog-closed'),
    replaceChildren:()=>events.push('dialog-cleared')}];
  }},
  screenRoot:{unmount:()=>events.push('react-unmount')},
  navRoots:{unmount:()=>events.push('nav-unmount')},
  $:()=>({replaceChildren:()=>events.push('ledger-cleared')}),
  GUEST_MODE_KEY:'fh-guest-session-v2',
  sessionStorage:{removeItem:key=>events.push('storage-remove:'+key)},
  emailSession:session,
  syncAccountControls:()=>events.push('sync'),
  render:()=>events.push('render'),
  window:{location:{replace:url=>events.push('redirect:'+url)}},
  toast:(message,status)=>events.push('toast:'+String(status||'success')+':'+message)
 };
 const run=()=>runInNewContext(handler+'\nlogoutEmailAccount()',ctx);
 return {run,session,events};
}

test('successful logout returns to the login page after server confirmation',async()=>{
 const ui=invoke({logout:async session=>{session.email=null;session.userId=null;return true;}});
 await ui.run();
 assert.equal(ui.session.email,null);
 assert.equal(ui.session.userId,null);
 assert.equal(ui.events.filter(x=>x==='logout-request').length,1);
 assert.equal(ui.events.filter(x=>x==='redirect:./account.html').length,1);
 assert.ok(ui.events.indexOf('logout-request')<ui.events.indexOf('redirect:./account.html'));
 assert.ok(ui.events.indexOf('react-unmount')>ui.events.indexOf('logout-request'));
 assert.ok(ui.events.includes('scope-revoked'));
  assert.ok(ui.events.includes('import-aborted'));
 assert.ok(ui.events.indexOf('scope-revoked')<ui.events.indexOf('ledger-cleared'));
 assert.ok(ui.events.includes('dialog-closed'));
 assert.ok(ui.events.includes('dialog-cleared'));
 assert.ok(ui.events.indexOf('dialog-cleared')<ui.events.indexOf('redirect:./account.html'));
 assert.ok(ui.events.indexOf('react-unmount')<ui.events.indexOf('redirect:./account.html'));
 assert.ok(ui.events.indexOf('nav-unmount')<ui.events.indexOf('redirect:./account.html'));
 assert.ok(ui.events.indexOf('ledger-cleared')<ui.events.indexOf('redirect:./account.html'));
 assert.ok(!ui.events.includes('render'),'Do not leave user on the ledger after logout');
});

test('OAuth-only account without email can log out',async()=>{
 const ui=invoke({email:null,userId:'a'.repeat(32),logout:async session=>{session.userId=null;return true;}});
 await ui.run();
 assert.equal(ui.session.userId,null);
 assert.ok(ui.events.includes('logout-request'));
 assert.ok(ui.events.includes('scope-revoked'));
 assert.ok(ui.events.includes('dialog-cleared'));
 assert.ok(ui.events.includes('nav-unmount'));
 assert.ok(ui.events.includes('redirect:./account.html'));
});

test('failed logout keeps ledger open and shows an error',async()=>{
 const ui=invoke({logout:async()=>{throw Error('Сервер недоступен');}});
 await ui.run();
 assert.equal(ui.session.email,'test@example.com');
 assert.ok(ui.events.some(x=>x.includes('toast:error:Сервер недоступен')));
 assert.equal(ui.events.filter(x=>x.startsWith('redirect:')).length,0);
 assert.ok(!ui.events.includes('scope-revoked'),'failed logout must keep the scope selected');
});

test('no session and pending logout cannot trigger a redirect',async()=>{
 const guest=invoke({email:null});
 await guest.run();
 assert.deepEqual(guest.events,[]);
 const pending=invoke({initialBusy:true});
 await pending.run();
 assert.deepEqual(pending.events,[]);
});

test('logout redirect waits for success and ignores a non-success result',async()=>{
 let resolveLogout;
 const ui=invoke({logout:()=>new Promise(resolve=>{resolveLogout=resolve;})});
 const running=ui.run();
 assert.equal(ui.events.filter(x=>x.startsWith('redirect:')).length,0);
 resolveLogout(false);
 await running;
 assert.equal(ui.events.filter(x=>x.startsWith('redirect:')).length,0);
});

test('PWA loads revisioned application code, including offline, without opening registration',()=>{
 const html=get('index.html'),sw=get('sw.js');
 const script='./app.js?rev=auth-theme-v26';
 assert.ok(html.includes('<script type="module" src="'+script+'"></script>'));
 assert.ok(sw.includes("'"+script+"'"));
 assert.ok(!sw.includes("'./app.js'"),'Stale unrevisioned app.js must not enter precache');
 assert.ok(sw.includes("const CACHE='financial-horizon-shell-v25-theme-auth'"));
 assert.ok(html.includes('<meta name="fh-email-auth" content="disabled">'));
});
