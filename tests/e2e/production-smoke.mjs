#!/usr/bin/env node
// Read-only production smoke. Never sends credentials or changes user data.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const [site, commit, ...options] = process.argv.slice(2);
if (!site || !commit || !/^[0-9a-f]{40}$/.test(commit)) {
 console.error('Usage: node tests/e2e/production-smoke.mjs https://your-app.example <40-char-main-sha> [--health=/healthz]');
 process.exit(2);
}
const origin = new URL(site);
if (origin.protocol !== 'https:' || origin.username || origin.password ||
    origin.pathname !== '/' || origin.search || origin.hash) {
 console.error('Specify an exact HTTPS production origin without userinfo or paths');
 process.exit(2);
}
const requestedHealth=options.find(x=>x.startsWith('--health='));
const health=requestedHealth?.slice('--health='.length);
if (health && (!/^\/[a-zA-Z0-9/_-]+$/.test(health) || health.startsWith('//'))) {
 console.error('Invalid health endpoint');
 process.exit(2);
}
const files=[
 ['index.html','/'],['app.js','/app.js?rev=auth-theme-v25'],
 ['storage.js','/storage.js?rev=auth-scopes-v18'],
 ['account.html','/account.html'],
 ['account.js','/account.js?rev=auth-theme-v25'],
 ['sw.js','/sw.js'],['manifest.webmanifest','/manifest.webmanifest'],
 ['styles.css','/styles.css?rev=auth-theme-v25'],
];
const hash=data=>createHash('sha256').update(data).digest('hex');
async function get(path){
 const url=new URL(path,origin);
 const response=await fetch(url,{method:'GET',redirect:'error',
  headers:{'Cache-Control':'no-cache','Pragma':'no-cache','Accept':'*/*'},
  signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw Error(path+': HTTP '+response.status);
 return response;
}
let errors=0;
for(const [source,path] of files){
 try{
  const expected=execFileSync('git',['show',commit+':'+source],{maxBuffer:10_000_000});
  const bytes=Buffer.from(await (await get(path)).arrayBuffer());
  if(hash(expected)!==hash(bytes))throw Error('Content differs from commit '+commit);
  console.log('PASS '+source+' sha256='+hash(bytes).slice(0,16));
 }catch(error){
  errors++;
  console.error('FAIL '+source+': '+error.message);
 }
}
try{
 const result=await (await get('/api/auth/email/config')).json();
 if(typeof result.enabled!=='boolean'||result.email_only!==true)throw Error('Unexpected auth config');
 console.log('PASS GET /api/auth/email/config (public availability, no session)');
}catch(error){
 errors++;console.error('FAIL auth API: '+error.message);
}
if(health){
 try{
  await get(health);
  console.log('PASS GET '+health);
 }catch(error){errors++;console.error('FAIL health check: '+error.message);}
}
console.log('Expected source commit: '+commit);
console.log('Read-only assets checked: '+files.length+', failures: '+errors);
console.log('Deployment SHA and rollback must be confirmed from deployment receipt separately.');
if(errors)process.exitCode=1;
