import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const get=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');

test('ledger validates authenticated identity before reading any user records',()=>{
 const app=get('app.js');
 const begin=app.indexOf('async function init(){');
 const init=app.slice(begin);
 const gate=init.indexOf('await emailSession.refresh()');
 const reject=init.indexOf('window.location.replace');
 const scope=init.indexOf('await selectStateScope(activeUserId)');
 const read=init.indexOf('state=await readState()');
 assert.ok(begin>=0&&gate>=0&&reject>gate&&scope>reject&&read>scope);
 assert.match(init,/if\(!verified\|\|!emailSession\.userId\)/);
 assert.match(app,/state=null;\s*window\.location\.replace\('\.\/account\.html'\)/);
 assert.match(app,/authBroadcast\.onmessage/);
});

test('login clears explicit guest mode, logout returns to auth without erasing finance data',()=>{
 const page=get('account.html'),js=get('account.js'),app=get('app.js');
 assert.match(page,/href="\.\/\?guest=1">Продолжить без регистрации/);
 assert.match(js,/sessionStorage\.removeItem\('fh-guest-session-v2'\)/);
 assert.match(js,/location\.assign\("\.\/"\)/);
 assert.match(app,/window\.location\.replace\('\.\/account\.html'\)/);
 assert.doesNotMatch(app,/indexedDB\.deleteDatabase/);
 assert.doesNotMatch(js,/indexedDB\.deleteDatabase/);
});

test('auth API is never intercepted by the PWA cache; account route has its own offline fallback',()=>{
 const sw=get('sw.js');
 assert.match(sw,/url\.pathname\.startsWith\('\/api\/'\)/);
 assert.match(sw,/pathname\.endsWith\('\/account\.html'\)\?'\.\/account\.html':'\.\/index\.html'/);
 assert.match(sw,/financial-horizon-shell-v20-auth-sessions/);
 assert.match(sw,/'\.\/storage\.js\?rev=auth-scopes-v18'/);
 assert.match(sw,/'\.\/auth-session\.js\?rev=auth-scopes-v18'/);
 assert.match(sw,/'\.\/account\.js\?rev=auth-sessions-v20'/);
});
