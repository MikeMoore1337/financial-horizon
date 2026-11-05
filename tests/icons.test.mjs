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
  const icon = read('assets/app-icon.svg');
  const sw = read('sw.js');
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.match(icon, /^<svg\s/);
  assert.match(icon, /viewBox="0 0 512 512"/);
  assert.doesNotMatch(icon, /<script|<foreignObject|xlink:href|<image\b|<use[^>]+href="https?:|on[a-z]+\s*=/i);
  assert.ok(manifest.icons.some(i => i.type==='image/svg+xml' && i.src==='./assets/app-icon.svg' && i.sizes==='any'));
  assert.ok(manifest.icons.some(i => i.type==='image/png' && i.purpose.includes('maskable')));
  assert.match(html,/rel="apple-touch-icon"[^>]*icon-192\.png/);
  assert.match(html,/rel="icon" type="image\/svg\+xml"[^>]*app-icon\.svg/);
  assert.match(sw,/assets\/app-icon\.svg/);
  assert.match(sw,/financial-horizon-shell-v2-svg-icons/);
});
