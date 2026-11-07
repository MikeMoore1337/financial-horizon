import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(ROOT, 'dist');
const LEGACY_FILES = [
  'app.js',
  'account.js',
  'account.css',
  'styles.css',
  'auth-session.js',
  'backup.js',
  'excel-import.js',
  'finance.js',
  'ledger-operations.js',
  'schedule.js',
  'state-migrations.js',
  'storage.js',
  'theme-bootstrap.js',
  'manifest.webmanifest',
];

// Keep the previous unbundled assets available for already-open tabs and old
// installed service workers during the transition. New pages use Vite bundles.
async function copyLegacyShell() {
  for (const file of LEGACY_FILES) {
    const source =
      file === 'state-migrations.js'
        ? 'legacy/state-migrations.js'
        : file === 'app.js'
          ? 'legacy/app.js'
          : file;
    await copyFile(join(ROOT, source), join(OUTPUT, file));
  }
  for (const file of await walk(join(ROOT, 'assets'))) {
    if (!/\.(?:svg|png|ico|webp)$/i.test(file)) continue;
    const target = join(OUTPUT, relative(ROOT, file));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file, target);
  }
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

// Preserve the existing installed PWA identity and scope. Vite would otherwise
// move a relative manifest under /assets/built/, breaking its start_url/icons.
async function keepStableManifestUrl() {
  const index = join(OUTPUT, 'index.html');
  const html = await readFile(index, 'utf8');
  const normalized = html.replace(
    /(<link rel="manifest" href=")[^"]+(")/,
    '$1/manifest.webmanifest$2',
  );
  if (normalized === html) throw new Error('Missing manifest link in built entry point');
  await writeFile(index, normalized);
  for (const path of await walk(join(OUTPUT, 'assets', 'built'))) {
    if (path.endsWith('.webmanifest')) await unlink(path);
  }
}

async function writeHashedServiceWorker() {
  const distFiles = await walk(join(OUTPUT, 'assets', 'built'));
  const emitted = distFiles
    .filter((file) => /\.(?:js|css|webmanifest|svg|png|ico|webp)$/i.test(file))
    .map((file) => './' + relative(OUTPUT, file).split(sep).join('/'))
    .sort();
  if (
    !emitted.some((file) => file.endsWith('.js')) ||
    !emitted.some((file) => file.endsWith('.css'))
  ) {
    throw new Error('Vite did not emit the expected JS/CSS bundles');
  }

  const source = await readFile(join(ROOT, 'sw.js'), 'utf8');
  const oldAssetList = source.match(/^const ASSETS=\[[^\n]*\];/m)?.[0];
  const oldCache = source.match(/^const CACHE='[^']+';/m)?.[0];
  if (!oldAssetList || !oldCache) throw new Error('Unexpected legacy Service Worker format');

  const icons = [...oldAssetList.matchAll(/'\.\/assets\/[^']+'/g)].map((match) =>
    match[0].slice(1, -1),
  );
  const assets = [
    ...new Set([
      './',
      './index.html',
      './account.html',
      './manifest.webmanifest',
      './theme-bootstrap.js?rev=ios27-chrome-v17',
      ...icons,
      ...emitted,
    ]),
  ];

  const hash = createHash('sha256');
  for (const asset of assets) {
    const file = asset === './' ? 'index.html' : asset.slice(2).split('?')[0];
    const content = await readFile(join(OUTPUT, file));
    hash.update(asset);
    hash.update(content);
  }
  const version = 'financial-horizon-shell-vite-' + hash.digest('hex').slice(0, 20);
  const output = source
    .replace(oldCache, "const CACHE='" + version + "';")
    .replace(oldAssetList, 'const ASSETS=' + JSON.stringify(assets) + ';');
  // No API request or credentials are included in the offline precache.
  await writeFile(join(OUTPUT, 'sw.js'), output);
}

export default defineConfig({
  base: '/',
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets/built',
    sourcemap: false,
    rollupOptions: {
      input: {
        index: resolve(ROOT, 'index.html'),
        account: resolve(ROOT, 'account.html'),
      },
    },
  },
  plugins: [
    react(),
    {
      name: 'financial-horizon-compatible-pwa-shell',
      apply: 'build',
      async closeBundle() {
        await copyLegacyShell();
        await keepStableManifestUrl();
        await writeHashedServiceWorker();
      },
    },
  ],
});
