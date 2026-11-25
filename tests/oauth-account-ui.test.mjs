import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mountAccountOAuth} from '../auth-ui.js';

function fakeNode(tag='section'){
 return {
  tag,children:[],attrs:{},dataset:{},hidden:false,isConnected:true,
  className:'',textContent:'',href:'',src:'',alt:'',
  append(...elements){this.children.push(...elements);},
  replaceChildren(...elements){this.children=[...elements];},
  setAttribute(key,value){this.attrs[key]=value;}
 };
}

function fakeScreen(mode='login'){
 const buttons=fakeNode('div');
 const root=fakeNode('section');
 root.hidden=true;
 root.querySelector=selector=>selector==='#oauth-options'?buttons:null;
 const documentRef={
  createElement:tag=>fakeNode(tag),
  createDocumentFragment:()=>fakeNode('fragment'),
  querySelector:selector=>selector==='.auth-modes [data-mode="login"]'
   ?{getAttribute:key=>key==='aria-current'?(mode==='login'?'page':'false'):null}
   :null
 };
 return {root,buttons,documentRef};
}

function responses({enabled=true,providers=['vk','telegram','google','yandex','not-real'],
                   authenticated=false,status=200,fail=false}={}){
 const calls=[];
 const fetcher=async(url,options)=>{
  calls.push({url,options});
  if(fail)throw Error('network offline');
  if(url.includes('providers')){
   return {ok:status===200,status,json:async()=>({enabled,providers})};
  }
  if(url.includes('/email/me')){
   return {ok:true,json:async()=>({authenticated,user:authenticated?{id:'f'.repeat(32),email:null}:null})};
  }
  throw Error('unexpected API request');
 };
 return {fetcher,calls};
}

test('approved design C renders email before the initially hidden OAuth section',()=>{
 const html=readFileSync(new URL('../account.html',import.meta.url),'utf8');
 const form=html.indexOf('<form id="auth-form"');
 const section=html.indexOf('<section id="oauth-login"');
 assert.ok(form>=0 && section>form);
 assert.match(html,/<section id="oauth-login"[^>]*hidden>/);
 assert.match(html,/<script type="module" src="\.\/account-oauth\.js\?rev=oauth-brand-originals-v1"><\/script>/);
 const css=readFileSync(new URL('../account.css',import.meta.url),'utf8');
 assert.match(css,/#oauth-login\[hidden\]\{display:none\}/);
 assert.match(css,/\.oauth-provider-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
 assert.match(css,/\.oauth-provider-grid>\.oauth-provider-link:last-child:nth-child\(odd\)\{grid-column:1\/-1\}/);
 assert.match(css,/@media\(max-width:770px\)\{[\s\S]*\.oauth-provider-grid\{grid-template-columns:1fr/);
});

test('only authorized, signed-out providers appear in fixed approved visual order',async()=>{
 const screen=fakeScreen();
 const mock=responses();
 assert.equal(await mountAccountOAuth(screen.root,{fetcher:mock.fetcher,documentRef:screen.documentRef}),true);
 assert.equal(screen.root.hidden,false);
 assert.equal(screen.root.dataset.ready,'true');
 const anchors=screen.buttons.children[0].children;
 assert.deepEqual(anchors.map(a=>a.href),[
  './api/auth/oauth/google/start',
  './api/auth/oauth/yandex/start',
  './api/auth/oauth/vk/start',
  './api/auth/oauth/telegram/start'
 ]);
 assert.deepEqual(anchors.map(a=>a.children[1].textContent),[
  'Войти через Google','Войти через Яндекс ID',
  'Войти через VK ID','Войти через Telegram'
 ]);
 assert.deepEqual(anchors.map(a=>a.children[0].src),[
  './assets/providers/google.svg',
  './assets/providers/yandex.webp','./assets/providers/vk.svg',
  './assets/providers/telegram.svg'
 ]);
 assert.equal(anchors.some(a=>a.href.includes('/telegram/')),true);
 for(const a of anchors){
  assert.equal(a.tag,'a');
  assert.equal(a.children[0].alt,'');
  assert.equal(a.children[2].attrs['aria-hidden'],'true');
 }
 assert.equal(mock.calls.length,2);
 for(const call of mock.calls){
  assert.equal(call.options.credentials,'same-origin');
  assert.equal(call.options.cache,'no-store');
 }
});

test('Telegram is hidden unless server explicitly advertises and enables it',async()=>{
 const screen=fakeScreen();
 const mock=responses({providers:['google','yandex','vk']});
 assert.equal(await mountAccountOAuth(screen.root,{fetcher:mock.fetcher,documentRef:screen.documentRef}),true);
 const links=screen.buttons.children[0].children.map(a=>a.href);
 assert.deepEqual(links,[
  './api/auth/oauth/google/start',
  './api/auth/oauth/yandex/start',
  './api/auth/oauth/vk/start'
 ]);
 assert.ok(!links.some(link=>link.includes('/telegram/')));
});

test('disabled OAuth cannot expose login links or call current-session API',async()=>{
 const screen=fakeScreen();
 const mock=responses({enabled:false,providers:['google']});
 assert.equal(await mountAccountOAuth(screen.root,{fetcher:mock.fetcher,documentRef:screen.documentRef}),false);
 assert.equal(screen.root.hidden,true);
 assert.equal(screen.root.dataset.ready,'false');
 assert.equal(screen.buttons.children.length,0);
 assert.equal(mock.calls.length,1);
});

test('signed-in accounts, offline server and non-login flows never show OAuth login',async()=>{
 for(const situation of [
  {mode:'login',props:{authenticated:true}},
  {mode:'login',props:{fail:true}},
  {mode:'login',props:{status:404}},
  {mode:'register',props:{enabled:true,providers:['google']}}
 ]){
  const screen=fakeScreen(situation.mode);
  const mock=responses(situation.props);
  const shown=await mountAccountOAuth(screen.root,{fetcher:mock.fetcher,documentRef:screen.documentRef});
  assert.equal(shown,false);
  assert.equal(screen.root.hidden,true);
  if(situation.props.authenticated||situation.props.fail||situation.props.status===404){
   assert.equal(screen.buttons.children.length,0);
  }
 }
});

test('disconnected OAuth container never initiates requests',async()=>{
 const screen=fakeScreen();
 screen.root.isConnected=false;
 const mock=responses();
 assert.equal(await mountAccountOAuth(screen.root,{fetcher:mock.fetcher,documentRef:screen.documentRef}),false);
 assert.equal(mock.calls.length,0);
});
