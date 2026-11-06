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

async function boot({initialSignedIn=false,sessionReadable=true,hash=""}={}){
 const selectors=[
  "#auth-feedback","#auth-submit","#form-heading","#form-description",
  "#email-label","#email","#password-label","#password",
  "#turnstile-container","#session-panel","#auth-form",
  ".auth-modes",".auth-actions",".auth-actions [data-mode=\"resend\"]",
  "#session-email","#auth-logout","#auth-logout-others"
 ];
 const elements=Object.fromEntries(selectors.map(s=>[s,element(s)]));
 const buttons=["login","register","reset","resend"].map(value=>{
  const item=element("mode-"+value);
  item.dataset.mode=value;
  return item;
 });
 const calls=[],navigation=[],historyCalls=[];
 let signedIn=initialSignedIn;
 const fetch=async (url,options={})=>{
  calls.push({url,options});
  if(url.endsWith("/config"))return {ok:true,json:async()=>({enabled:true,sitekey:"test-site-key"})};
  if(url.endsWith("/me"))return {
   ok:true,json:async()=>sessionReadable&&signedIn
    ?{authenticated:true,user:{email:"user@example.com"}}
    :{authenticated:false,user:null}
  };
  if(url.endsWith("/login")||url.endsWith("/verify")) {
   signedIn=true;
   return {ok:true,json:async()=>({authenticated:true})};
  }
  if(url.endsWith("/reset/request"))return {ok:true,json:async()=>({message:"Generic response"})};
  if(url.endsWith("/reset/confirm"))return {ok:true,json:async()=>({message:"Updated"})};
  if(url.endsWith("/logout-others"))return {ok:true,json:async()=>({ok:true})};
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
  hash,pathname:"/account.html",search:"",
  assign(url){navigation.push(url);}
 };
 const window={
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
  submit:async()=>elements["#auth-form"].events.submit({preventDefault(){}})
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

test("revoking other sessions keeps the current account page authenticated",async()=>{
 const page=await boot({initialSignedIn:true});
 await page.elements["#auth-logout-others"].events.click();
 const posts=page.calls.filter(call=>call.url.endsWith("/logout-others"));
 assert.equal(posts.length,1);
 assert.equal(posts[0].options.method,"POST");
 assert.equal(posts[0].options.credentials,"same-origin");
 assert.equal(page.elements["#session-panel"].hidden,false);
 assert.equal(page.elements["#auth-feedback"].dataset.status,"success");
 assert.deepEqual(page.navigation,[]);
});
