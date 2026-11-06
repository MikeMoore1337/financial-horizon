import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const app=read('app.js');
const css=read('styles.css');
const html=read('index.html');
const start=app.indexOf('function renderSettings()');
const settings=app.slice(start,app.indexOf('function openDialog(',start));

test('settings omit duplicate account/theme controls but retain header controls',()=>{
 assert.ok(settings.startsWith('function renderSettings()'));
 assert.doesNotMatch(settings,/id="account-entry"|id="account-session"|id="account-session-email"|id="account-logout-settings"|data-action="theme"|<h2>Оформление<\/h2>|<h2>Аккаунт<\/h2>/);
 assert.match(html,/id="account-logout-toolbar"[^>]*data-action="account-logout"/);
 assert.match(html,/id="theme-toggle"/);
 assert.doesNotMatch(settings,/Hermes VPS|MikeMoore|Вариант А|YFC/);
});

test('reference composition is six cards in three rows plus full-width installation',()=>{
 for(const id of ['security','backup','import','categories','archive','history','install'])
  assert.ok(settings.includes('data-settings-card="'+id+'"'),id);
 assert.equal((settings.match(/class="surface settings-card(?:\s|")/g)||[]).length,7);
 assert.ok(css.includes('.settings-grid{--settings-highlight:#b8ff66;'));
 assert.ok(css.includes('grid-template-columns:repeat(2,minmax(0,1fr))'));
 assert.ok(css.includes('.settings-install{grid-column:1/-1}'));
 assert.ok(css.includes('.settings-grid{grid-template-columns:1fr}'));
 for (const symbol of ['shield','sheet','tag','archive','database','smartphone'])
  assert.ok(html.includes('id="ico-'+symbol+'"'),symbol);
});

test('actions, local persistence feedback and activity log stay available',()=>{
 for (const name of ['persist','backup','restore','excel-import','sample','clear','install','edit-category','delete-category','restore-item']) {
  assert.ok(settings.includes("action('"+name+"'") || settings.includes('data-action="'+name+'"'),name);
 }
 assert.ok(settings.includes('id="storage-status"'));
 assert.ok(settings.includes('id="category-form"'));
 assert.ok(settings.includes('<details class="settings-history">'));
 assert.match(settings,/escapeHtml\(x\.title\)/);
 assert.match(settings,/escapeHtml\(x\.description\)/);
 assert.match(app,/syncAccountControls\(\);if\(ui\.view==='settings'\)void renderStorageStatus\(\)/);
});

test('versioned app shell is consistent across both PWA pages',()=>{
 const sw=read('sw.js');
 const account=read('account.html');
 for(const p of ['styles.css?rev=auth-ui-v23','app.js?rev=auth-ui-v23']) {
  assert.ok(sw.includes(p),p);
  assert.ok(html.includes(p),p);
 }
 assert.ok(account.includes('styles.css?rev=auth-ui-v23'));
 assert.ok(sw.includes('financial-horizon-shell-v23-auth-ui'));
});
