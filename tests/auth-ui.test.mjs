import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {allowedProviderIds, providerHref, providerLabel} from '../auth-ui.js';

const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');

test('only the four permitted independent OAuth providers have fixed start URLs',()=>{
 const ids=allowedProviderIds({enabled:true,providers:['vk','telegram','fake','google','yandex']});
 assert.deepEqual(ids,['telegram','google','yandex','vk']);
 assert.deepEqual(allowedProviderIds({enabled:false,providers:['google']}),[]);
 assert.deepEqual(allowedProviderIds(null),[]);
 for(const provider of ids){
  assert.ok(providerLabel(provider));
  assert.equal(providerHref(provider),'./api/auth/oauth/'+provider+'/start');
 }
 assert.throws(()=>providerHref('yfc'));
 assert.throws(()=>providerHref('https://example.com'));
});

test('current email account and protected ledger do not activate the staged OAuth module',()=>{
 const html=read('index.html'),account=read('account.html');
 const app=read('app.js'),sw=read('sw.js');
 assert.match(html,/<meta name="fh-email-auth" content="disabled">/);
 assert.doesNotMatch(html,/fh-cloud-auth" content="enabled"/);
 assert.doesNotMatch(account,/data-provider=|oauth\/telegram\/start|oauth\/google\/start/);
 assert.doesNotMatch(app,/from ['"]\.\/auth-ui\.js['"]/);
 assert.doesNotMatch(sw,/'\.\/auth-ui\.js'/);
 assert.match(app,/await emailSession\.refresh\(\)/);
 assert.match(sw,/financial-horizon-shell-/);
});


test('OAuth-only account with null email retains account scope and logs out through shared API',async()=>{
 const {createEmailSession}=await import('../auth-session.js');
 const urls=[];
 const session=createEmailSession(async (url,options={})=>{
  urls.push([url,options.method??'GET']);
  if(url.endsWith('/me'))return {ok:true,json:async()=>({
    authenticated:true,user:{id:'f'.repeat(32),email:null}
  })};
  if(url.endsWith('/logout'))return {ok:true,json:async()=>({ok:true})};
  throw Error('Unexpected auth request');
 });
 assert.equal(await session.refresh(),true);
 assert.equal(session.userId,'f'.repeat(32));
 assert.equal(session.email,null);
 assert.equal(await session.logout(),true);
 assert.equal(session.userId,null);
 assert.ok(urls.some(([url,method])=>url.endsWith('/api/auth/email/logout')&&method==='POST'));
});
