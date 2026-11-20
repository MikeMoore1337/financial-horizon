import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {allowedProviderIds, providerHref, providerLabel} from '../auth-ui.js';

const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');

test('all four approved OAuth providers have fixed start URLs',()=>{
 const ids=allowedProviderIds({enabled:true,providers:['vk','telegram','fake','google','yandex']});
 assert.deepEqual(ids,['google','yandex','vk','telegram']);
 assert.equal(providerHref('telegram'),'./api/auth/oauth/telegram/start');
 assert.equal(providerLabel('telegram'),'Войти через Telegram');
 assert.deepEqual(allowedProviderIds({enabled:false,providers:['google']}),[]);
 assert.deepEqual(allowedProviderIds({enabled:true,providers:['telegram']}),['telegram']);
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
 assert.match(account,/<section id="oauth-login"[^>]*hidden>/);
 assert.match(account,/account-oauth\.js\?rev=oauth-brand-originals-v1/);
 assert.match(account,/id="auth-form"[\s\S]*id="oauth-login"/);
 assert.doesNotMatch(app,/from ['"]\.\/auth-ui\.js['"]/);
 assert.match(sw,/'\.\/auth-ui\.js\?rev=oauth-brand-originals-v1'/);
 assert.match(sw,/'\.\/account-oauth\.js\?rev=oauth-brand-originals-v1'/);
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

test('OAuth-only accounts are authorized by stable user ID even without email',()=>{
 const main=read('app.js');
 assert.match(main,/const signedIn=Boolean\(emailSession\.userId\)/);
 assert.match(main,/if\(!verified\|\|emailSession\.userId!==activeUserId\)\{/);
 assert.match(main,/if\(busy\|\|!emailSession\.userId\|\|emailSession\.busy\)return;/);
 assert.doesNotMatch(main,/if\(!verified\|\|emailSession\.userId!==activeUserId\|\|!emailSession\.email\)/);
 assert.doesNotMatch(main,/const signedIn=Boolean\(emailSession\.email\)/);
});

test('OAuth callback clears only guest-mode choice before selecting the account scope',()=>{
 const main=read('app.js');
 const start=main.indexOf("url.searchParams.get('auth')==='success'");
 const clear=main.indexOf("sessionStorage.removeItem(GUEST_MODE_KEY)",start);
 const select=main.indexOf("guestMode=sessionStorage.getItem(GUEST_MODE_KEY)",start);
 assert.ok(start>0 && clear>start && select>clear);
 assert.match(main,/url\.searchParams\.delete\('auth'\)/);
 assert.match(main,/await selectStateScope\(activeUserId\)/);
});
