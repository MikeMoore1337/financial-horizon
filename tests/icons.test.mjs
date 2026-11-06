import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('all interface SVG icon references exist in sprite', () => {
  const html = read('index.html');
  const app = read('app.js');
  const names = new Set([...html.matchAll(/<symbol\s+id="(ico-[a-z-]+)"/g)].map(m => m[1]));
  const direct = [...html.matchAll(/href="#(ico-[a-z-]+)"/g)].map(m => m[1]);
  const dynamic = [...app.matchAll(/svg\(['"]([a-z-]+)['"]\)/g)].map(m => 'ico-' + m[1]);
  for (const name of [...direct,...dynamic]) assert.ok(names.has(name), 'Unknown symbol ' + name);
  assert.ok(names.has('ico-close'));
  assert.ok(!html.includes('>✕</button>'), 'Close buttons should use SVG');
  assert.ok(!app.includes('✎</button>') && !app.includes('×</button>'), 'Category actions should use SVG');
  assert.ok(!app.includes("action('prev-month','‹'"), 'Month controls should use SVG');
  assert.match(html, /aria-label="Закрыть"/);
});

test('SVG PWA icon and compatible PNG fallback are local', () => {
  const html = read('index.html');
  const icon = read('assets/brand/symbol.svg');
  const sw = read('sw.js');
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.match(icon, /^<svg\s/);
  assert.match(icon, /viewBox="0 0 512 512"/);
  assert.doesNotMatch(icon, /<script|<foreignObject|xlink:href|<image\b|<use[^>]+href="https?:|on[a-z]+\s*=/i);
  assert.ok(manifest.icons.some(i => i.type==='image/svg+xml' && i.src==='./assets/brand/symbol.svg' && i.sizes==='any'));
  assert.ok(manifest.icons.some(i => i.type==='image/png' && i.src==='./assets/brand/pwa-maskable-512.png' && i.purpose.includes('maskable')));
  assert.match(html,/rel="apple-touch-icon"[^>]*apple-touch-icon-180\.png/);
  assert.match(html,/rel="icon" type="image\/svg\+xml"[^>]*brand\/favicon\.svg/);
  assert.match(sw,/assets\/brand\/favicon\.svg/);
  assert.match(sw,/financial-horizon-shell-v12-ios-chrome-yfc/);
});

test('settings is a gear and dark-theme action has a crescent with a star', () => {
  const html = read('index.html');
  const app = read('app.js');
  const symbol = name => html.match(new RegExp('<symbol id="ico-' + name + '"[^>]*>([\\s\\S]*?)<\\/symbol>'))?.[1];
  const settings = symbol('settings');
  const moon = symbol('moon');
  assert.ok(settings, 'Settings symbol is missing');
  assert.ok(moon, 'Moon symbol is missing');
  assert.match(settings, /<circle\b/);
  assert.match(settings, /<path\b/);
  assert.doesNotMatch(settings, /M12 2v2/, 'Settings must not look like a sun');
  assert.equal((moon.match(/<path\b/g) || []).length, 2, 'Moon should include a separate sparkle');
  assert.equal((html.match(/href="#ico-settings"/g) || []).length, 2, 'Desktop and mobile navigation must share the symbol');
  assert.match(app, /mode==='dark'\?'sun':'moon'/, 'Theme toggle behavior must stay unchanged');
  assert.match(app, /Включить тёмную тему/);
});
