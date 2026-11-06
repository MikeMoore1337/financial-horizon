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
 assert.doesNotMatch(app,/id="account-entry" hidden/);
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
 assert.match(sw,/financial-horizon-shell-v23-auth-ui/);
 for(const file of ['account.html','account.css?rev=auth-ui-v23','account.js?rev=auth-ui-v23']){
   assert.ok(sw.includes("'./"+file+"'"),file);
 }
 assert.doesNotMatch(sw,/auth\.sqlite|email_session|token=|SMTP_PASSWORD/);
});

test('Turnstile failures offer actionable feedback and do not poison retries',()=>{
 const js=get('account.js');
 assert.match(js,/activeScript=activeScript\.catch\(error=>\{activeScript=null/);
 assert.match(js,/s\.onerror=\(\)=>\{s\.remove\(\);reject/);
 for(const callback of ['expired-callback','timeout-callback','error-callback']){
  assert.ok(js.includes('"'+callback+'"'),callback);
 }
 assert.match(js,/Не удалось пройти защитную проверку/);
 assert.match(js,/Срок защитной проверки истёк/);
 assert.match(js,/Проверка не завершена/);
});

test('signed-in ledger exposes accessible logout controls with a vendored Lucide SVG',()=>{
 const main=get('index.html'),app=get('app.js'),css=get('styles.css'),sw=get('sw.js');
 const icon=get('assets/icons/log-out.svg'),license=get('assets/icons/LICENSE');
 assert.match(main,/id="account-logout-toolbar"[^>]*data-action="account-logout"[^>]*hidden/);
 assert.match(main,/aria-label="Выйти из аккаунта"/);
 assert.doesNotMatch(app,/id="account-session" hidden/);
 assert.doesNotMatch(app,/id="account-logout-settings" data-action="account-logout"/);
 assert.match(app,/await logoutEmailAccount\(\)/);
 assert.match(app,/toolbarButton\.hidden=!signedIn/);
 assert.match(app,/'#account-entry-toolbar'\)\.hidden=!signedIn/);
 assert.match(main,/id="account-entry-toolbar"[^>]*aria-label="Управление аккаунтом"/);
 assert.match(css,/mask:url\('\.\/assets\/icons\/user-round\.svg'\)/);
 assert.match(sw,/'\.\/assets\/icons\/user-round\.svg'/);
 const user=get('assets/icons/user-round.svg');
 assert.match(user,/stroke="currentColor"/);
 assert.match(user,/<circle cx="12" cy="8" r="5"/);
 assert.match(app,/syncAccountControls\(\)/);
 assert.match(css,/\.toolbar-logout\[hidden\][^{]*\{display:none\}/);
 assert.match(css,/mask:url\('\.\/assets\/icons\/log-out\.svg'\)/);
 assert.match(sw,/'\.\/auth-session\.js\?rev=auth-scopes-v18'/);
 assert.match(sw,/'\.\/assets\/icons\/log-out\.svg'/);
 assert.match(icon,/stroke="currentColor"/);
 assert.match(icon,/<path d="m16 17 5-5-5-5"/);
 assert.match(license,/MIT License/);
});
