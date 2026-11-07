import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const source=readFileSync(new URL("../account.js",import.meta.url),"utf8");

function element(name){
 return {
  name,hidden:false,disabled:false,required:false,value:"",textContent:"",
  dataset:{},events:{},nodes:[],attrs:{},
  addEventListener(type,callback){this.events[type]=callback;},
  setAttribute(name,value){this.attrs[name]=value;},
  replaceChildren(...children){this.nodes=[...children];this.textContent=children.map(x=>x.textContent).join(" ");},
  append(child){this.nodes.push(child);this.textContent=this.nodes.map(x=>x.textContent).join(" ");},
 };
}

async function boot({initialSignedIn=false,sessionReadable=true,hash="",search="",supportsChange=false,supportsOthers=false}={}){
 const selectors=[
  "#auth-feedback","#auth-submit","#form-heading","#form-description",
  "#email-label","#email","#password-label","#password","#oauth-login",
  "#turnstile-container","#session-panel","#auth-form",
  ".auth-modes",".auth-actions",".auth-actions [data-mode=\"resend\"]",".auth-actions [data-mode=\"reset\"]",
  "#session-email","#auth-logout","#auth-logout-others","#change-email-panel","#change-email-form",
  "#change-email","#change-email-password","#change-email-challenge","#change-email-submit"
 ];
 const elements=Object.fromEntries(selectors.map(s=>[s,element(s)]));
 const buttons=["login","register","reset","resend"].map(value=>{
  const item=element("mode-"+value);
  item.dataset.mode=value;
  return item;
 });
 const calls=[],navigation=[],historyCalls=[];
 let signedIn=initialSignedIn,email="user@example.com";
 const fetch=async (url,options={})=>{
  calls.push({url,options});
  if(url.endsWith("/config"))return {ok:true,json:async()=>({enabled:true,sitekey:"test-site-key",capabilities:{email_change:supportsChange,revoke_other_sessions:supportsOthers}})};
  if(url.endsWith("/me"))return {
   ok:true,json:async()=>sessionReadable&&signedIn
    ?{authenticated:true,user:{email,id:"a".repeat(32)}}
    :{authenticated:false,user:null}
  };
  if(url.endsWith("/login")||url.endsWith("/verify")) {
   signedIn=true;
   return {ok:true,json:async()=>({authenticated:true})};
  }
  if(url.endsWith("/reset/request"))return {ok:true,json:async()=>({message:"Generic response"})};
  if(url.endsWith("/reset/confirm"))return {ok:true,json:async()=>({message:"Updated"})};
  if(url.endsWith("/logout-others"))return {ok:true,json:async()=>({ok:true})};
  if(url.endsWith("/change/request"))return {ok:true,json:async()=>({message:"Generic"})};
  if(url.endsWith("/change/confirm")){
   email="new@example.com";
   return {ok:true,json:async()=>({ok:true,authenticated:true})};
  }
  if(url.endsWith("/logout")){signedIn=false;return {ok:true,json:async()=>({ok:true})};}
  throw Error("Unexpected request "+url);
 };
 const document={
  querySelector(selector){
   if(!elements[selector])throw Error("Unknown selector "+selector);
   return elements[selector];
  },
  querySelectorAll(selector){
   if(selector!=="[data-mode]")throw Error("Unexpected querySelectorAll");
   return buttons;
  },
  createElement:element,
  head:{append(){}}
 };
 const location={
  hash,pathname:"/account.html",search,
  assign(url){navigation.push(url);}
 };
 const window={
  addEventListener(type,callback){(this.__events??={})[type]=callback;},
  turnstile:{
   render(_place,settings){settings.callback("simulated-challenge");return "widget";},
   remove(){},reset(){}
  }
 };
 const context=vm.createContext({
  document,location,window,fetch,
  localStorage:{getItem:()=>null},
  history:{replaceState(...args){historyCalls.push(args);}},
  URLSearchParams
 });
 vm.runInContext(source,context,{filename:"account.js"});
 await new Promise(resolve=>setImmediate(resolve));
 return {
  elements,buttons,calls,navigation,historyCalls,
  changeMode:async name=>{
   const button=buttons.find(b=>b.dataset.mode===name);
   button.events.click();
   await new Promise(resolve=>setImmediate(resolve));
  },
  submit:async()=>elements["#auth-form"].events.submit({preventDefault(){}}),
  changeEmail:async()=>elements["#change-email-form"].events.submit({preventDefault(){}}),
  triggerHash:async hash=>{location.hash=hash;window.__events.hashchange();await new Promise(resolve=>setImmediate(resolve));}
 };
}

test("successful login confirms session and opens the ledger",async()=>{
 const page=await boot();
 page.elements["#email"].value="user@example.com";
 page.elements["#password"].value="long-enough-password";
 await page.submit();
 assert.deepEqual(page.navigation,["./"]);
 assert.equal(page.elements["#session-panel"].hidden,false);
 assert.ok(page.calls.some(call=>call.url.endsWith("/login")));
 assert.ok(page.calls.some(call=>call.url.endsWith("/me")));
});

test("login does not navigate when the session cookie cannot be confirmed",async()=>{
 const page=await boot({sessionReadable:false});
 page.elements["#email"].value="user@example.com";
 page.elements["#password"].value="long-enough-password";
 await page.submit();
 assert.deepEqual(page.navigation,[]);
 assert.equal(page.elements["#auth-feedback"].dataset.status,"error");
 assert.match(page.elements["#auth-feedback"].textContent,/не подтвердил сессию/);
});

test("password recovery shows clear next steps without confirming an account",async()=>{
 const page=await boot();
 await page.changeMode("reset");
 page.elements["#email"].value="user@example.com";
 await page.submit();
 assert.deepEqual(page.navigation,[]);
 assert.equal(page.elements["#auth-feedback"].dataset.status,"success");
 assert.match(page.elements["#auth-feedback"].textContent,/Запрос принят/);
 assert.match(page.elements["#auth-feedback"].textContent,/Входящие/);
 assert.match(page.elements["#auth-feedback"].textContent,/Спам/);
 assert.match(page.elements["#auth-feedback"].textContent,/Если с этим адресом связан аккаунт/);
 assert.equal(page.elements['.auth-actions [data-mode="resend"]'].hidden,true);
 const req=page.calls.find(call=>call.url.endsWith("/reset/request"));
 assert.ok(req);
 assert.equal(JSON.parse(req.options.body).challenge,"simulated-challenge");
});

test("signed-in account page uses the correct heading without unwanted navigation",async()=>{
 const page=await boot({initialSignedIn:true});
 assert.equal(page.elements["#form-heading"].textContent,"Аккаунт");
 assert.equal(page.elements["#auth-form"].hidden,true);
 assert.equal(page.elements[".auth-actions"].hidden,true);
 assert.deepEqual(page.navigation,[]);
});

test("email verification strips the fragment and opens the ledger after session validation",async()=>{
 const page=await boot({hash:"#verify-email="+("A".repeat(48))});
 assert.equal(page.historyCalls.length,1);
 page.elements["#password"].value="long-enough-password";
 await page.submit();
 assert.deepEqual(page.navigation,["./"]);
 assert.ok(page.calls.some(call=>call.url.endsWith("/verify")));
});

test("password reset confirmation returns to login without navigating",async()=>{
 const page=await boot({hash:"#reset-password="+("A".repeat(48))});
 page.elements["#password"].value="long-enough-password";
 await page.submit();
 assert.deepEqual(page.navigation,[]);
 assert.match(page.elements["#auth-feedback"].textContent,/Пароль изменён/);
 assert.equal(page.elements["#form-heading"].textContent,"Войти по email");
});

test("verified account can request change of email with fresh challenge and current password",async()=>{
 const page=await boot({initialSignedIn:true,supportsChange:true});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(page.elements["#change-email-panel"].hidden,false);
 page.elements["#change-email"].value="new@example.com";
 page.elements["#change-email-password"].value="current-password-is-secret";
 await page.changeEmail();
 const req=page.calls.find(call=>call.url.endsWith("/change/request"));
 assert.ok(req);
 assert.equal(req.options.credentials,"same-origin");
 assert.deepEqual(JSON.parse(req.options.body),{
  email:"new@example.com",password:"current-password-is-secret",challenge:"simulated-challenge"
 });
 assert.equal(page.elements["#change-email-password"].value,"");
 assert.match(page.elements["#auth-feedback"].textContent,/Проверьте новый email/);
 assert.deepEqual(page.navigation,[]);
});

test("already signed-in user confirms change from fragment and stays authenticated",async()=>{
 const page=await boot({initialSignedIn:true,supportsChange:true,hash:"#confirm-email-change="+("N".repeat(48))});
 assert.equal(page.historyCalls.length,1);
 assert.ok(page.calls.some(call=>call.url.endsWith("/change/confirm")));
 assert.equal(page.elements["#session-panel"].hidden,false);
 assert.match(page.elements["#session-email"].textContent,/new@example.com/);
 assert.match(page.elements["#auth-feedback"].textContent,/Email изменён/);
 assert.deepEqual(page.navigation,[]);
});

test("signed-out confirmation link waits for login to apply matching token",async()=>{
 const page=await boot({supportsChange:true,hash:"#confirm-email-change="+("R".repeat(48))});
 assert.equal(page.elements["#auth-form"].hidden,false);
 assert.match(page.elements["#auth-feedback"].textContent,/сначала войдите/);
 assert.ok(!page.calls.some(call=>call.url.endsWith("/change/confirm")));
 page.elements["#email"].value="user@example.com";
 page.elements["#password"].value="long-enough-password";
 await page.submit();
 assert.ok(page.calls.some(call=>call.url.endsWith("/change/confirm")));
 assert.deepEqual(page.navigation,[]);
 assert.equal(page.elements["#session-panel"].hidden,false);
 assert.match(page.elements["#session-email"].textContent,/new@example.com/);
});

test("email-change controls are hidden until the backend advertises support",async()=>{
 const page=await boot({initialSignedIn:true,supportsChange:false});
 assert.equal(page.elements["#change-email-panel"].hidden,true);
 assert.ok(!page.calls.some(call=>call.url.endsWith("/change/request")));
});

test("OAuth callback failures show Russian-only actionable feedback and clear query",async()=>{
 for(const [status,expected] of [
  ["failed",/Не удалось войти через выбранный сервис/],
  ["denied",/Вход отменён/],
 ]){
  const page=await boot({search:"?oauth="+status+"&other=keep"});
  assert.equal(page.elements["#auth-feedback"].dataset.status,"error");
  assert.match(page.elements["#auth-feedback"].textContent,expected);
  assert.ok(page.historyCalls.some(args=>args[2]==="/account.html?other=keep"));
  assert.deepEqual(page.navigation,[]);
 }
});

test("successful OAuth linking confirms status without exposing provider tokens",async()=>{
 const page=await boot({initialSignedIn:true,search:"?oauth=linked"});
 assert.equal(page.elements["#auth-feedback"].dataset.status,"success");
 assert.match(page.elements["#auth-feedback"].textContent,/Новый способ входа привязан/);
 assert.ok(page.historyCalls.some(args=>args[2]==="/account.html"));
 assert.equal(page.elements["#session-panel"].hidden,false);
});

test('OAuth choices are only visible during the initial login mode',async()=>{
 const page=await boot();
 const oauth=page.elements['#oauth-login'];
 oauth.dataset.ready='true';
 oauth.hidden=false;
 await page.changeMode('register');
 assert.equal(oauth.hidden,true);
 await page.changeMode('reset');
 assert.equal(oauth.hidden,true);
 await page.changeMode('login');
 assert.equal(oauth.hidden,false);
 assert.equal(page.elements['.auth-actions [data-mode="resend"]'].hidden,true);
 assert.equal(page.elements['.auth-actions [data-mode="reset"]'].hidden,false);
});
