import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const html=read('index.html');
const account=read('account.html');
const css=read('styles.css');
const app=read('app.js');
const sw=read('sw.js');
const bootstrap=read('theme-bootstrap.js');
const revision='ios27-chrome-v17';
const cache='financial-horizon-shell-v25-theme-auth';

const initialTheme=({stored,systemDark=false,storageBlocked=false}={})=>{
 const root={dataset:{}};
 const themeMeta={content:'#ffffff'};
 const storage={getItem(){if(storageBlocked)throw Error('Storage blocked');return stored;}};
 runInNewContext(bootstrap,{
  document:{documentElement:root,getElementById(id){return id==='theme-color'?themeMeta:null;}},
  localStorage:storage,
  window:{matchMedia:()=>({matches:systemDark})},
 });
 return {mode:root.dataset.theme,color:themeMeta.content};
};

test('theme is established before first CSS paint on ledger and account',()=>{
 const earlyScript='<script src="./theme-bootstrap.js?rev='+revision+'"></script>';
 for(const page of [html,account]){
  assert.ok(page.indexOf(earlyScript)>0);
  assert.ok(page.indexOf(earlyScript)<page.indexOf('<link rel="stylesheet"'));
  assert.ok(page.indexOf(earlyScript)<page.indexOf('<body'));
  assert.match(page,/<meta name="theme-color" content="#ffffff" id="theme-color">/);
  assert.doesNotMatch(page,/apple-mobile-web-app-status-bar-style/);
 }
 assert.match(css,/html\{min-width:320px;background:#ffffff;color-scheme:light\}/);
 assert.match(css,/html\[data-theme=dark\]\{background:#172336;color-scheme:dark\}/);
 assert.match(css,/html\[data-theme=dark\] body\{--bg:#0e1624;--surface:#172336/);
});

test('saved preference and system fallback determine correct iOS theme color',()=>{
 assert.deepEqual(initialTheme({stored:'dark'}),{mode:'dark',color:'#172336'});
 assert.deepEqual(initialTheme({stored:'light',systemDark:true}),{mode:'light',color:'#ffffff'});
 assert.deepEqual(initialTheme({stored:null,systemDark:true}),{mode:'dark',color:'#172336'});
 assert.deepEqual(initialTheme({storageBlocked:true}),{mode:'light',color:'#ffffff'});
 assert.match(app,/document.documentElement.dataset.theme=mode;document.body.dataset.theme=mode/);
 assert.ok(app.includes("$('#theme-color').content=mode==='dark'?'#172336':'#ffffff'"));
});

test('iOS status bar is themed without a fixed element that covers the toolbar',()=>{
 for(const page of [html,account]){
  assert.doesNotMatch(page,/ios-status-bar-sample/);
 }
 assert.doesNotMatch(css,/ios-status-bar-sample/);
 assert.match(css,/\.toolbar\{height:65px;position:sticky;top:0;z-index:10;/);
 assert.match(css,/@media\(max-width:760px\)\{\.sidebar\{display:none\}body\{--fh-dock-bottom:/);
 assert.ok(css.includes('.toolbar{height:58px;padding:0 16px;top:0}'));
 assert.ok(html.includes('<nav class="bottom-nav"'));
});


test('live theme toggles repeatedly sync root, body and iOS status bar meta',()=>{
 const fn=app.match(/^function themeSet\(mode\)\{[^\n]+\}/m)?.[0];
 assert.ok(fn,'themeSet should remain available');
 const root={dataset:{}},body={dataset:{}},meta={content:'#ffffff'};
 const toggle={innerHTML:'',setAttribute(name,value){this[name]=value;}};
 const stored={};
 const context={document:{documentElement:root,body,querySelector(selector){return selector==='#theme-color'?meta:selector==='#theme-toggle'?toggle:null;}},localStorage:{setItem(k,v){stored[k]=v;}}};
 runInNewContext("const $ = sel => document.querySelector(sel); const svg = name => name; "+fn+"; this.applyTheme = themeSet;",context);
 for(const [mode,color] of [['dark','#172336'],['light','#ffffff'],['dark','#172336'],['light','#ffffff']]){
  context.applyTheme(mode);
  assert.equal(root.dataset.theme,mode);
  assert.equal(body.dataset.theme,mode);
  assert.equal(meta.content,color);
  assert.equal(stored['fh-theme'],mode);
  assert.equal(toggle['aria-label'],mode==='dark'?'Включить светлую тему':'Включить тёмную тему');
 }
});

test('iOS status bar can sample an opaque theme surface without any top overlay',()=>{
 assert.match(css, /@supports \(-webkit-touch-callout:none\)\{@media\(max-width:760px\)\{\.toolbar\{background:var\(--surface\);-webkit-backdrop-filter:none;backdrop-filter:none\}\}\}/);
 assert.match(css, /body\[data-theme=dark\],html\[data-theme=dark\] body\{[^\n]*--surface:#172336/);
 assert.match(css, /body\{[^\n]*--surface:#ffffff/);
 assert.match(css, /\.bottom-nav\{position:fixed;z-index:20;/);
});

test('both PWA pages use revisioned assets, consistent with offline precache',()=>{
 const sheet='./styles.css?rev=auth-theme-v26';
 const preload='./theme-bootstrap.js?rev='+revision;
 const application='./app.js?rev=auth-theme-v25';
 for(const page of [html,account]){
  assert.ok(page.includes('<link rel="stylesheet" href="'+sheet+'">'));
  assert.ok(page.includes('<script src="'+preload+'"></script>'));
 }
 assert.ok(html.includes('<script type="module" src="'+application+'"></script>'));
 assert.ok(sw.includes("const CACHE='"+cache+"'"));
 for(const path of [sheet,preload,application]) {
  assert.ok(sw.includes("'"+path+"'"),'SW precache missing '+path);
 }
 assert.ok(!sw.includes("'./styles.css'"));
 assert.ok(sw.includes("'./auth-session.js?rev=auth-scopes-v18'"),'Preserve logout workflow');
});
