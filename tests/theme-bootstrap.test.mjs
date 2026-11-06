import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../styles.css',import.meta.url),'utf8');
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const sw=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
const bootstrap=readFileSync(new URL('../theme-bootstrap.js',import.meta.url),'utf8');

const initialTheme=({stored,systemDark=false,storageBlocked=false}={})=>{
 const root={dataset:{}};
 const themeMeta={content:'#f5f7fc'};
 const storage={getItem(){if(storageBlocked)throw Error('Storage blocked');return stored;}};
 runInNewContext(bootstrap,{
  document:{documentElement:root,getElementById(id){return id==='theme-color'?themeMeta:null;}},
  localStorage:storage,
  window:{matchMedia:()=>({matches:systemDark})},
 });
 return {mode:root.dataset.theme,color:themeMeta.content};
};

test('YFC-style prepaint theme sets dark and light PWA chrome before CSS loads',()=>{
 const script='<script src="./theme-bootstrap.js"></script>';
 assert.ok(html.indexOf(script)>0);
 assert.ok(html.indexOf(script)<html.indexOf('<link rel="stylesheet"'));
 assert.ok(html.indexOf(script)<html.indexOf('<body'));
 assert.doesNotMatch(html,/apple-mobile-web-app-status-bar-style/,'No forced white iOS status bar');
 assert.match(css,/html\{min-width:320px;background:#f5f7fc;color-scheme:light\}/);
 assert.match(css,/html\[data-theme=dark\]\{background:#0e1624;color-scheme:dark\}/);
 assert.match(css,/html\[data-theme=dark\] body\{--bg:#0e1624/);
 assert.match(app,/document.documentElement.dataset.theme=mode;document.body.dataset.theme=mode/);
 assert.match(sw,/'.\/theme-bootstrap.js'/);
});

test('theme bootstrap honors explicit preference and system fallback',()=>{
 assert.deepEqual(initialTheme({stored:'dark'}),{mode:'dark',color:'#0e1624'});
 assert.deepEqual(initialTheme({stored:'light',systemDark:true}),{mode:'light',color:'#f5f7fc'});
 assert.deepEqual(initialTheme({stored:null,systemDark:true}),{mode:'dark',color:'#0e1624'});
 assert.deepEqual(initialTheme({storageBlocked:true}),{mode:'light',color:'#f5f7fc'});
});


test('iOS standalone top chrome samples theme from a real fixed element on both pages',()=>{
 const authHtml=readFileSync(new URL('../account.html',import.meta.url),'utf8');
 const marker='<div class="ios-status-bar-sample" aria-hidden="true"></div>';
 assert.equal(html.split(marker).length-1,1);
 assert.equal(authHtml.split(marker).length-1,1);
 assert.ok(html.indexOf(marker)<html.indexOf('<div class="app-shell">'));
 assert.ok(authHtml.indexOf(marker)<authHtml.indexOf('<main class="auth-layout">'));
 assert.ok(authHtml.indexOf('<script src="./theme-bootstrap.js"></script>')<authHtml.indexOf('<link rel="stylesheet" href="./styles.css">'));
 assert.ok(css.includes('.ios-status-bar-sample{display:none}'));
 assert.ok(css.includes('position:fixed;top:0;left:0;right:0;height:12px;z-index:40;background-color:var(--surface);pointer-events:none'));
 assert.ok(css.includes('--surface:#ffffff'));
 assert.ok(css.includes('html[data-theme=dark] body{--bg:#0e1624;--surface:#172336'));
 assert.doesNotMatch(html,/apple-mobile-web-app-status-bar-style/);
 assert.doesNotMatch(authHtml,/apple-mobile-web-app-status-bar-style/);
});
