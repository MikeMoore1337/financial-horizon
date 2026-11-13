import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const app=read('app.js');
const settings=read('src/react/Settings.tsx');
const css=read('styles.css');
const html=read('index.html');

test('React Settings avoids duplicated account/theme controls and retains header access',()=>{
 assert.match(settings,/export function Settings\(/);
 assert.doesNotMatch(settings,/id="account-entry"|id="account-session"|id="account-logout-settings"|data-action="theme"|<h2>Оформление|<h2>Аккаунт/);
 assert.match(html,/id="account-logout-toolbar"[^>]*data-action="account-logout"/);
 assert.match(html,/id="theme-toggle"/);
 assert.doesNotMatch(settings,/Hermes VPS|MikeMoore|Вариант А|YFC/);
 assert.doesNotMatch(settings,/dangerouslySetInnerHTML|innerHTML/);
});

test('seven default Settings cards remain; optional finance card requires reviewed opt-in',()=>{
 for(const id of ['security','backup','import','categories','archive','history','install'])
  assert.ok(settings.includes('<SettingsCard id="'+id+'"'),id);
 const cards=[...settings.matchAll(/<SettingsCard id="([^"]+)"/g)].map(x=>x[1]);
 assert.equal(cards.filter(id=>id!=='finance-accounts').length,7);
 assert.equal(cards.filter(id=>id==='finance-accounts').length,1);
 assert.match(settings,/\{showFinanceAccounts && \(/);
 assert.match(html,/<meta name="fh-finance-accounts" content="enabled">/);
 assert.match(html,/<meta name="fh-finance-import" content="disabled">/);
 assert.ok(settings.includes('settings-install'));
 assert.ok(css.includes('.settings-grid{display:grid;'));
 assert.ok(css.includes('grid-template-columns:repeat(2,minmax(0,1fr))'));
 assert.ok(css.includes('.settings-install{grid-column:1/-1}'));
 assert.ok(css.includes('.settings-grid{grid-template-columns:1fr}'));
 for(const symbol of ['shield','sheet','tag','archive','database','smartphone'])
  assert.ok(html.includes('id="ico-'+symbol+'"'),symbol);
});

test('actions, account-safe status, category form and activity log remain available',()=>{
 for(const name of ['persist','backup','restore','excel-import','sample','clear','install','edit-category','delete-category','restore-item'])
  assert.ok(settings.includes('data-action="'+name+'"'),name);
 assert.match(settings,/id="storage-status"/);
 assert.match(settings,/role="status"/);
 assert.match(settings,/id="category-form"/);
 assert.match(settings,/<details className="settings-history">/);
 assert.match(settings,/\{item\.title\}/);
 assert.match(settings,/\{item\.description\}/);
 for(const view of ['calendar','overview','obligations','loans','settings'])
  assert.match(app,new RegExp("screenRoot\\.render\\(\\{view:'"+view+"'"),'React must render '+view+' on navigation');
 assert.match(app,/storageMessage:storageStatusMessage/);
 assert.match(app,/async function renderStorageStatus\(\)/);
 assert.doesNotMatch(app,/\$\('#storage-status'\)\.textContent\s*=/,
   'React exclusively owns the storage status DOM node');
 assert.match(app,/if\(form\.isConnected\)form\.reset\(\)/);
});

test('original PWA shell and revisioned assets remain compatible with older installations',()=>{
 const sw=read('sw.js'),account=read('account.html');
 for(const resource of ['styles.css?rev=auth-theme-v28','app.js?rev=auth-theme-v26']){
  assert.ok(sw.includes(resource),resource);
  assert.ok(html.includes(resource),resource);
 }
 assert.ok(account.includes('styles.css?rev=auth-theme-v28'));
 assert.ok(sw.includes('financial-horizon-shell-v25-theme-auth'));
});

test('approved primary button palettes in light/dark remain unchanged',()=>{
 assert.match(settings,/className="button-primary" data-action="backup"/);
 assert.match(settings,/className="button-primary" type="submit">\s*Добавить/);
 assert.doesNotMatch(settings,/settings-cta|settings-highlight/);
 assert.doesNotMatch(css,/--settings-highlight|\.settings-grid \.settings-cta/);
 assert.match(css,/\.button-primary\{background:var\(--accent\);color:var\(--onaccent\);border:1px solid transparent\}/);
 assert.match(css,/body\[data-theme=dark\][^\n]*--accent:#6c9dff;[^\n]*--onaccent:#081625/);
 assert.match(css,/body\{margin:0;[^\n]*--accent:#3078fa;[^\n]*--onaccent:#fff/);
});
