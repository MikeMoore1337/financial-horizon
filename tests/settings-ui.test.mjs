import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const app=read('app.js');
const css=read('styles.css');
const page=read('index.html');
const importer=read('excel-import.js');
const begin=app.indexOf('function renderSettings()');
const settings=app.slice(begin,app.indexOf('function openDialog(',begin));

test('settings hide developer infrastructure and internal design names',()=>{
 assert.ok(settings.startsWith('function renderSettings()'));
 assert.doesNotMatch(settings,/Hermes|VPS|YFC|MikeMoore|Вариант А|«Кредитная нагрузка»|«Зарплата»|«Аванс»/i);
 assert.doesNotMatch(importer,/Формат таблицы не распознан: ожидаются/);
 assert.ok(settings.includes('Финансовые записи хранятся в этом браузере и не передаются на сервер'));
 assert.ok(settings.includes('Цветовая тема'));
});

test('settings use compact independent columns with one-column layout on narrow screens',()=>{
 assert.equal((settings.match(/class="settings-column"/g)||[]).length,2);
 assert.ok(css.includes('.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}'));
 assert.ok(css.includes('.settings-column{min-width:0;display:flex;flex-direction:column;gap:14px}'));
 assert.ok(css.includes('.settings-grid{grid-template-columns:1fr}'));
 assert.ok(css.includes('.settings-install{margin-top:14px;padding:18px 20px}'));
});

test('settings controls and cache-busted assets are preserved',()=>{
 for(const marker of ['id="account-entry"','id="account-session"','id="account-logout-settings"','id="storage-status"','id="category-form"','id="account-session-email"',"action('persist'","action('backup'","action('restore'","action('excel-import'","action('sample'","action('clear'","action('install'"]){
  assert.ok(settings.includes(marker),'Missing '+marker);
 }
 assert.ok(settings.includes('data-action="theme" data-theme="light"'));
 assert.ok(settings.includes('data-action="theme" data-theme="dark"'));
 const sw=read('sw.js');
 for(const path of ['styles.css?rev=settings-compact-v19','app.js?rev=settings-compact-v19']){
  assert.ok(page.includes(path),'Missing '+path+' in page');
  assert.ok(sw.includes(path),'Missing '+path+' in cache');
 }
 assert.ok(sw.includes('financial-horizon-shell-v19-settings-layout'));
});
