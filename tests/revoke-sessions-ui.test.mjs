import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const get=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const account=get('account.js');
const first=account.indexOf('async function logoutOthers(){');
const last=account.indexOf('\nasync function logout(){',first);
assert.ok(first>=0&&last>first,'Account must implement logoutOthers');
const fn=account.slice(first,last);

function invoke({hidden=false,status=200,result={ok:true}}={}){
 const calls=[],messages=[],button={disabled:false,hidden};
 const context={
  Error,$:selector=>selector==='#auth-logout-others'?button:null,
  request:async(path,body)=>{
   calls.push({path,body});
   if(status!==200)throw Error(status===401?'Сеанс истёк':'Сервер недоступен');
   return result;
  },
  feedback:(message,kind)=>messages.push({message,kind})
 };
 const run=()=>runInNewContext(fn+'\nlogoutOthers()',context);
 return {run,calls,messages,button};
}

test('authenticated account page revokes other devices through the protected endpoint',async()=>{
 const x=invoke();
 await x.run();
 assert.equal(x.calls.length,1);
 assert.equal(x.calls[0].path,'logout-others');
 assert.equal(JSON.stringify(x.calls[0].body),'{}');
 assert.match(x.messages[0].message,/остались в аккаунте/);
 assert.equal(x.messages[0].kind,'success');
 assert.equal(x.button.disabled,false);
});
test('invisible and disabled controls must not send revocation requests',async()=>{
 const x=invoke({hidden:true});
 await x.run();
 assert.deepEqual(x.calls,[]);
 assert.deepEqual(x.messages,[]);
});
test('server errors or unconfirmed responses cannot be shown as successful logout',async()=>{
 for(const options of [{status:401},{status:503},{result:{ok:false}}]){
  const x=invoke(options);
  await x.run();
  assert.equal(x.calls.length,1);
  assert.equal(x.messages[0].kind,'error');
  assert.equal(x.button.disabled,false);
 }
});
test('server-advertised capability gates the account action and leaves settings unchanged',()=>{
 const html=get('account.html'),app=get('app.js'),index=get('index.html');
 const sw=get('sw.js'),css=get('account.css');
 assert.match(account,/config\.capabilities\?\.revoke_other_sessions!==true/);
 assert.ok(account.includes('$("#auth-logout-others")'));
 assert.match(html,/id="auth-logout-others" hidden/);
 assert.match(html,/id="session-panel" hidden/);
 assert.match(css,/\.session-actions \[hidden\]\{display:none\}/);
 assert.doesNotMatch(app,/async function revokeOtherEmailSessions/);
 assert.doesNotMatch(app,/id="account-session" hidden/);
 assert.match(index,/id="account-entry-toolbar"/);
 assert.match(sw,/financial-horizon-shell-v26-a11y/);
 assert.ok(sw.includes("'./app.js?rev=auth-theme-v26'"));
 assert.ok(sw.includes("'./account.js?rev=auth-theme-v25'"));
});
