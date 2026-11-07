#!/usr/bin/env node
// Read-only postdeploy verification against an exact Vite build; no cookies or financial data.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const [site,commit,...options]=process.argv.slice(2);
if(!site||!/^[0-9a-f]{40}$/.test(commit||'')){
 console.error('Usage: node tests/e2e/production-smoke.mjs https://your-app.example <main-commit-sha> [--health=/healthz]');
 process.exit(2);
}
let origin;
try{origin=new URL(site);}catch{console.error('Invalid HTTPS origin');process.exit(2);}
if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash){
 console.error('Only an exact HTTPS origin is allowed');process.exit(2);
}
const health=options.find(value=>value.startsWith('--health='))?.slice(9);
if(options.some(value=>!value.startsWith('--health='))||
 (health&&(!/^\/[a-zA-Z0-9/_-]+$/.test(health)||health.startsWith('//')))){
 console.error('Invalid health endpoint/options');process.exit(2);
}

const root=fileURLToPath(new URL('../../',import.meta.url));
const dist=join(root,'dist');
const sha256=value=>createHash('sha256').update(value).digest('hex');
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
if(head!==commit){
 console.error('FAIL: checkout SHA differs from requested production SHA:',head);
 process.exit(2);
}
if(!existsSync(join(dist,'index.html'))||!existsSync(join(dist,'sw.js'))){
 console.error('FAIL: missing production dist; run npm ci && npm run build at the exact SHA');
 process.exit(2);
}

function assets(dir){
 return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
  const path=join(dir,entry.name);
  if(entry.isDirectory())return assets(path);
  if(!entry.isFile())throw Error('Unexpected non-regular artifact: '+entry.name);
  return [relative(dist,path).split(sep).join('/')];
 });
}
const paths=assets(dist).sort();
if(paths.length<10||paths.some(name=>name.startsWith('.')||name.includes('/.'))){
 console.error('FAIL: unsafe or incomplete dist');process.exit(2);
}
const home=readFileSync(join(dist,'index.html'),'utf8');
const account=readFileSync(join(dist,'account.html'),'utf8');
if(!/assets\/built\/[^"']+\.js/.test(home)||!/assets\/built\/[^"']+\.css/.test(home)||
 !/assets\/built\/[^"']+\.js/.test(account)||!/assets\/built\/[^"']+\.css/.test(account)||
 !home.includes('href="/manifest.webmanifest"')){
 console.error('FAIL: HTML does not reference Vite bundles or stable PWA manifest');
 process.exit(2);
}
const worker=readFileSync(join(dist,'sw.js'),'utf8');
if(!worker.includes("url.pathname.startsWith('/api/')")||
 !/financial-horizon-shell-vite-[0-9a-f]{20}/.test(worker)){
 console.error('FAIL: unexpected generated Service Worker or API cache policy');
 process.exit(2);
}
const manifest=JSON.parse(readFileSync(join(dist,'manifest.webmanifest'),'utf8'));
if(manifest.id!=='./'||manifest.scope!=='./'||manifest.start_url!=='./'){
 console.error('FAIL: installed PWA identity or scope changed');process.exit(2);
}

async function get(path){
 const url=new URL(path,origin);
 const response=await fetch(url,{
  method:'GET',redirect:'error',headers:{'Cache-Control':'no-cache','Pragma':'no-cache'},
  signal:AbortSignal.timeout(15000)
 });
 if(!response.ok)throw Error(path+': HTTP '+response.status);
 return response;
}
const headers=new Map();
let failures=0,checked=0;
for(let offset=0;offset<paths.length;offset+=6){
 const results=await Promise.all(paths.slice(offset,offset+6).map(async name=>{
  const path='/'+name;
  try{
   const response=await get(path);
   const expected=sha256(readFileSync(join(dist,...name.split('/'))));
   const actual=sha256(Buffer.from(await response.arrayBuffer()));
   if(expected!==actual)throw Error('bytes differ from clean checkout build '+commit);
   return {name,response};
  }catch(error){return {name,error};}
 }));
 for(const result of results){
  if(result.error){
   failures++;console.error('FAIL '+result.name+': '+result.error.message);
  }else{
   checked++;headers.set(result.name,result.response.headers);
  }
 }
}
try{
 const response=await get('/');
 const delivered=Buffer.from(await response.arrayBuffer());
 if(sha256(delivered)!==sha256(readFileSync(join(dist,'index.html'))))
  throw Error('root response differs from built index.html');
 if(!response.headers.get('content-security-policy')?.includes("script-src 'self'"))
  throw Error('missing restrictive CSP for ledger');
 console.log('PASS root/HTTPS/CSP');
}catch(error){failures++;console.error('FAIL ledger: '+error.message);}
for(const file of ['index.html','account.html','sw.js','manifest.webmanifest']){
 try{
  const responseHeaders=headers.get(file);
  const caching=responseHeaders?.get('cache-control')||'';
  if(!caching.includes('no-store')&&!caching.includes('no-cache'))
   throw Error('missing Cache-Control: no-store/no-cache; stale HTML can load deleted hashed bundles');
  if(file==='account.html'&&!responseHeaders.get('content-security-policy')?.includes("script-src 'self'"))
   throw Error('account CSP missing');
  console.log('PASS '+file+' revalidated HTML/SW cache policy');
 }catch(error){failures++;console.error('FAIL '+file+' headers: '+error.message);}
}
try{
 const configuration=await (await get('/api/auth/email/config')).json();
 if(typeof configuration.enabled!=='boolean'||configuration.email_only!==true)
  throw Error('Unexpected public auth API response');
 console.log('PASS public auth config; enabled='+configuration.enabled);
}catch(error){failures++;console.error('FAIL auth config: '+error.message);}
if(health){
 try{await get(health);console.log('PASS GET '+health);}
 catch(error){failures++;console.error('FAIL health: '+error.message);}
}
console.log('Verified checkout SHA:',commit);
console.log('Compared built static assets:',checked,'of',paths.length,'failures:',failures);
console.log('Live browser IndexedDB, SW activation and rollback checks must be recorded separately.');
if(failures)process.exitCode=1;
