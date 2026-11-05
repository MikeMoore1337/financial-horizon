import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root = new URL('../', import.meta.url);
const file = relative => readFileSync(new URL(relative, root));
const source = relative => file(relative).toString('utf8');

test('approved brand SVGs retain recognizable source identity and no external resources', () => {
  const files=['logo-light.svg','logo-dark.svg','logo-compact-light.svg','logo-compact-dark.svg','symbol.svg','favicon.svg','pwa-maskable.svg'];
  for(const name of files) {
    const svg=source('assets/brand/'+name);
    assert.match(svg, /^<svg\s/);
    assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.doesNotMatch(svg, /<script\b|<foreignObject\b|<image\b|xlink:href|onload\s*=|href="https?:/i);
    assert.ok(svg.includes('#3078FA') || svg.includes('#328DF8') || svg.includes('#59BDFF'),name);
  }
  assert.match(source('assets/brand/logo-compact-light.svg'), /Финансовый/);
  assert.match(source('assets/brand/logo-compact-dark.svg'), /Личная бухгалтерия/);
});

test('approved mark and readable product name appear in desktop sidebar', () => {
  const html=source('index.html');
  const css=source('styles.css');
  assert.match(html, /class="brand-mark" aria-hidden="true"><img src="\.\/assets\/brand\/symbol\.svg" alt=""/);
  assert.match(html, /<strong>Финансовый<br>горизонт<\/strong>/);
  assert.match(html, /class="brand-sub">Личная бухгалтерия<\/span>/);
  assert.match(css, /\.brand-mark img\{display:block;width:40px;height:40px\}/);
});

test('PNG and ICO delivery files contain correct header and dimensions', () => {
  for (const [name,width,height] of [
    ['favicon-16.png',16,16],['favicon-32.png',32,32],['favicon-48.png',48,48],['favicon-64.png',64,64],
    ['pwa-192.png',192,192],['pwa-512.png',512,512],['pwa-maskable-512.png',512,512],['apple-touch-icon-180.png',180,180]
  ]){
    const png=file('assets/brand/'+name);
    assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a',name);
    assert.equal(png.readUInt32BE(16),width,name);
    assert.equal(png.readUInt32BE(20),height,name);
  }
  const ico=file('assets/brand/favicon.ico');
  assert.equal(ico.readUInt16LE(2),1);
  assert.equal(ico.readUInt16LE(4),4);
});

test('favicon, PWA manifest and offline precache reference approved brand files', () => {
  const html=source('index.html');
  const manifest=JSON.parse(source('manifest.webmanifest'));
  const sw=source('sw.js');
  assert.match(html,/rel="icon" type="image\/svg\+xml" href="\.\/assets\/brand\/favicon\.svg"/);
  assert.match(html,/rel="apple-touch-icon" sizes="180x180" href="\.\/assets\/brand\/apple-touch-icon-180\.png"/);
  assert.equal(manifest.icons.length,4);
  const names=manifest.icons.map(x=>x.src);
  assert.ok(names.includes('./assets/brand/symbol.svg'));
  assert.ok(names.includes('./assets/brand/pwa-192.png'));
  assert.ok(names.includes('./assets/brand/pwa-512.png'));
  assert.ok(manifest.icons.some(x=>x.purpose==='maskable'&&x.src==='./assets/brand/pwa-maskable-512.png'));
  for(const icon of manifest.icons) {
    assert.ok(existsSync(fileURLToPath(new URL(icon.src,root))));
    assert.ok(sw.includes(icon.src));
  }
  assert.match(sw,/financial-horizon-shell-v4-approved-brand-20261105/);
  assert.doesNotMatch(sw,/Расходы\.xlsx|user-finance-records/i);
});
