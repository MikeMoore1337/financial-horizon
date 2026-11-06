import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const get=(name)=>readFileSync(new URL('../'+name,import.meta.url),'utf8');

test('account page is independent, free and disabled by default',()=>{
 const page=get('account.html'), main=get('index.html'), app=get('app.js');
 assert.match(page,/<html lang="ru">/);
 assert.match(page,/Продолжить без регистрации/);
 assert.match(page,/Регистрация/);
 assert.match(page,/type="email"/);
 assert.match(page,/autocomplete="new-password"|type="password"/);
 assert.doesNotMatch(page,/yfc|your-fitness-coach/i);
 assert.match(main,/<meta name="fh-email-auth" content="disabled">/);
 assert.match(app,/id="account-entry" hidden/);
});

test('email page strips sensitive confirmation fragment before fetching Turnstile',()=>{
 const js=get('account.js');
 assert.match(js,/history.replaceState/);
 assert.match(js,/location.hash/);
 assert.match(js,/const VALID_TOKEN=/);
 assert.match(js,/api\/auth\/email\/config/);
 assert.match(js,/cloud|challengeReady|turnstile/);
 assert.match(js,/cache:'no-store'/);
 assert.match(js,/credentials:"same-origin"/);
 assert.doesNotMatch(js, /localStorage\.setItem\([^,]*(token|password)/i);
 assert.doesNotMatch(js,/https?:\/\/.*(google|yandex|vk|telegram)/);
});

test('password is not requested on email-only registration and CSS honors hidden fields',()=>{
 const js=get('account.js'),css=get('account.css');
 assert.match(js,/const needsPassword=\["login","verify","reset-confirm"\]/);
 assert.match(js,/const needsEmail=!\["verify","reset-confirm"\]/);
 assert.match(css,/\.auth-label\[hidden\]\{display:none\}/);
 assert.match(css,/@media\(max-width:770px\)/);
});

test('service worker caches only app assets and includes account UI for offline support',()=>{
 const sw=get('sw.js');
 assert.match(sw,/financial-horizon-shell-v9-ios-dock-lowered/);
 for(const file of ['account.html','account.css','account.js']){
   assert.ok(sw.includes("'./"+file+"'"),file);
 }
 assert.doesNotMatch(sw,/auth\.sqlite|email_session|token=|SMTP_PASSWORD/);
});
