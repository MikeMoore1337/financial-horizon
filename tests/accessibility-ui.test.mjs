import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read=name=>readFileSync(new URL('../'+name,import.meta.url),'utf8');
const html=read('index.html');
const account=read('account.html');
const app=read('app.js');
const css=read('styles.css');
const sw=read('sw.js');

test('approved #44 accessible add action has an explicit Russian name at every width',()=>{
 assert.match(html,/id="top-add" aria-label="Добавить запись"/);
 assert.match(html,/toolbar-add" id="top-add"[^>]*><svg aria-hidden="true" focusable="false">/);
});

test('approved #44 tablet view reuses existing editable mobile rows without clipping the table',()=>{
 assert.match(css,/@media\(min-width:761px\) and \(max-width:1150px\)/);
 assert.match(css,/\.records-table\{display:none\}/);
 assert.match(css,/\.records-mobile\{display:block\}/);
 assert.match(css,/\.record-mobile-row>div:nth-child\(2\)\{min-width:0;flex:1\}/);
 assert.match(css,/\.record-mobile-actions\{display:flex;gap:4px;/);
 assert.doesNotMatch(css,/overflow-x:hidden/);
});

test('approved #44 light palette has distinct contrast adjustments without changing dark mode',()=>{
 assert.match(css,/body\[data-theme=light\]\{--accent:#2870eb;--green:#0d8461\}/);
 assert.match(css,/body\[data-theme=light\] \.bottom-nav button:not\(\.active\)\{color:#41536c\}/);
 assert.match(css,/body\[data-theme=dark\],html\[data-theme=dark\] body\{[^\n]*--accent:#6c9dff;[^\n]*--onaccent:#081625/);
});

test('approved #44 XLSX preview lists have keyboard focus and accessible region names',()=>{
 for(const type of ['items','warnings']){
  assert.match(html,new RegExp('id="excel-import-'+type+'-heading"'));
  assert.match(html,new RegExp('id="excel-import-'+type+'" tabindex="0" role="region" aria-labelledby="excel-import-'+type+'-heading"'));
 }
 assert.match(css,/#excel-import-items:focus-visible,#excel-import-warnings:focus-visible\{outline:3px solid var\(--accent-deep\)/);
});

test('approved #44 calendar date exposes visible label, full date and selected state',()=>{
 assert.match(app,/aria-labelledby="calendar-day-number-/);
 assert.match(app,/aria-describedby="calendar-day-description-/);
 assert.match(app,/aria-pressed="/);
 assert.match(app,/id="calendar-day-summary-/);
 assert.match(app,/class="visually-hidden" id="calendar-day-description-/);
 assert.match(app,/document\.querySelector\('\.cal-day\.selected'\)\?\.focus\(\{preventScroll:true\}\)/);
 assert.doesNotMatch(app,/data-date="\$\{d\}" aria-label=/);
});

test('approved #44 Turnstile and change-email challenge use valid labelled ARIA groups',()=>{
 assert.match(account,/id="turnstile-container" role="group" aria-label="Защитная проверка"/);
 assert.match(account,/id="change-email-challenge" role="group" aria-label="Проверка смены адреса"/);
});

test('approved #44 PWA revisions atomically include accessibility markup and style changes',()=>{
 const sheet='./styles.css?rev=auth-theme-v28';
 const application='./app.js?rev=auth-theme-v26';
 for(const page of [html,account])assert.ok(page.includes(sheet));
 assert.ok(html.includes(application));
 assert.ok(sw.includes("'"+sheet+"'"));
 assert.ok(sw.includes("'"+application+"'"));
 assert.match(sw,/const CACHE='financial-horizon-shell-v25-theme-auth'/);
 assert.match(sw,/const ACTIVE_CACHE=CACHE\+'-schema-v2'/);
});


test('dialog focus returns to its originating action in WebKit and Chromium',()=>{
 assert.match(app,/lastDialogActivator/);
 assert.match(app,/dlg\.addEventListener\('close'/);
 assert.match(app,/opener\.focus\(\{preventScroll:true\}\)/);
});

test('long unbroken financial labels wrap in record cards and table cells',()=>{
 assert.match(css,/\.record-mobile-row strong,\.record-mobile-row small,\.records-table \.record-title,\.records-table \.record-sub\{overflow-wrap:anywhere\}/);
});

test('long loan names wrap inside credit cards and detail headings',()=>{
 assert.match(css,/\.loan-card \.title,\.loan-detail h2\{min-width:0;overflow-wrap:anywhere\}/);
});
