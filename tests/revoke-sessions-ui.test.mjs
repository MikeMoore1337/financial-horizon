import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const get=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const app=get('app.js');
const a=app.indexOf('async function revokeOtherEmailSessions(){');
const b=app.indexOf('\nfunction pageHead(',a);
assert.ok(a>=0&&b>a);
const fn=app.slice(a,b);

function invoke({signedIn=true,guestMode=false,status=200,result={ok:true}}={}){
 const requests=[],messages=[];
 const button={disabled:false,isConnected:true};
 const ctx={
  Error,guestMode,emailSession:{email:signedIn?'qa@example.invalid':null,busy:false},
  $:name=>name==='#account-logout-others'?button:null,
  toast:(message,kind)=>messages.push({message,kind}),
  fetch:async(url,options)=>{
   requests.push({url,options});
   return {ok:status>=200&&status<300,status,json:async()=>result};
  }
 };
 const run=()=>runInNewContext(fn+'\nrevokeOtherEmailSessions()',ctx);
 return {run,requests,messages,button};
}

test('authenticated browser may revoke other sessions without logging out itself',async()=>{
 const ui=invoke();
 await ui.run();
 assert.equal(ui.requests.length,1);
 assert.equal(ui.requests[0].url,'./api/auth/email/logout-others');
 assert.equal(ui.requests[0].options.method,'POST');
 assert.equal(ui.requests[0].options.credentials,'same-origin');
 assert.equal(ui.requests[0].options.cache,'no-store');
 assert.equal(ui.button.disabled,false);
 assert.match(ui.messages[0].message,/Текущий сеанс сохранён/);
 assert.equal(ui.messages[0].kind,undefined);
});
test('guest or unauthenticated browser never sends revocation request',async()=>{
 for(const args of [{guestMode:true},{signedIn:false}]){
  const ui=invoke(args);
  await ui.run();
  assert.deepEqual(ui.requests,[]);
 }
});
test('failed request does not masquerade as success or clear current session',async()=>{
 for(const args of [{status:401},{status:503},{result:{ok:false}}]){
  const ui=invoke(args);
  await ui.run();
  assert.equal(ui.requests.length,1);
  assert.equal(ui.messages[0].kind,'error');
  assert.equal(ui.button.disabled,false);
 }
});
test('buttons exist only inside the authenticated account panel',()=>{
 const html=get('account.html'),sw=get('sw.js');
 assert.match(app,/id="account-session" hidden/);
 assert.match(app,/id="account-logout-others" data-action="account-logout-others"/);
 assert.match(app,/if\(type==='account-logout-others'\)/);
 assert.match(html,/id="session-panel" hidden/);
 assert.match(html,/id="auth-logout-others"/);
 assert.match(html,/Выйти на других устройствах/);
 assert.match(sw,/financial-horizon-shell-v20-auth-sessions/);
 assert.ok(sw.includes("'./app.js?rev=auth-sessions-v20'"));
 assert.ok(sw.includes("'./account.js?rev=auth-sessions-v20'"));
});
