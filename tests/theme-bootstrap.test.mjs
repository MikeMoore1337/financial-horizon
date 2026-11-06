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
