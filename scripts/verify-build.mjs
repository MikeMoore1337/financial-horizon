import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../dist/', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const emitted = readdirSync(new URL('assets/built/', root));
const scripts = emitted.filter((name) => /^[\w.-]+-[\w-]+\.js$/.test(name));
const styles = emitted.filter((name) => /^[\w.-]+-[\w-]+\.css$/.test(name));

assert.ok(scripts.length > 0, 'Missing hashed JavaScript assets');
assert.ok(styles.length > 0, 'Missing hashed CSS assets');

for (const page of ['index.html', 'account.html']) {
  const html = read(page);
  assert.match(html, /assets\/built\/[^"']+\.js/, page + ' must load bundled JavaScript');
  assert.match(html, /assets\/built\/[^"']+\.css/, page + ' must load bundled CSS');
  assert.doesNotMatch(html, /type="module"\s+src="\.\/(?:app|account)\.js/, 'raw entry leaked');
  assert.doesNotMatch(
    html,
    /<script(?:\s[^>]*)?>(?!\s*<\/script>)[^<]+<\/script>/i,
    'CSP forbids inline scripts',
  );
  assert.match(html, /theme-bootstrap\.js\?rev=ios27-chrome-v17/, 'Theme must start before CSS');
}
assert.match(read('index.html'), /rel="manifest" href="\/manifest\.webmanifest"/);
assert.equal(
  emitted.some((name) => name.endsWith('.webmanifest')),
  false,
);
const sw = read('sw.js');
for (const file of emitted.filter((name) =>
  /\.(?:js|css|webmanifest|svg|png|ico|webp)$/.test(name),
)) {
  assert.ok(sw.includes('./assets/built/' + file), 'Precache missing ' + file);
}
assert.match(sw, /financial-horizon-shell-vite-[0-9a-f]{20}/);
assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)/);
assert.ok(sw.includes('caches.open(ACTIVE_CACHE).then(cache=>cache.match(request))'));
assert.ok(read('sw.js') !== readFileSync(new URL('../sw.js', import.meta.url), 'utf8'));
for (const file of ['manifest.webmanifest', 'theme-bootstrap.js', 'finance.js']) {
  assert.ok(existsSync(new URL(file, root)), 'Legacy compatibility missing ' + file);
}
for (const file of ['backend', '.env', '.github', 'tests', '.vite']) {
  assert.equal(existsSync(new URL(file, root)), false, 'Private source exposed: ' + file);
}
assert.equal(
  read('app.js'),
  readFileSync(new URL('../legacy/app.js', import.meta.url), 'utf8'),
  'Old PWA entry must remain functional',
);
assert.doesNotMatch(
  read('app.js'),
  /src\/react\/|react-dom/,
  'Legacy entry cannot load TSX or React',
);
assert.ok(
  scripts.some((name) => read('assets/built/' + name).includes('react')),
  'React must be bundled in the Vite entry',
);
console.log('PASS: Vite React/multi-page/CSP/hashed JS+CSS/PWA legacy/build privacy');
