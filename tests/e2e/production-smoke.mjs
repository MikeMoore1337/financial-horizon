#!/usr/bin/env node
// Production smoke: read-only GET, no cookies, no customer records or analytics.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const [site, commit, ...options] = process.argv.slice(2);
if (!site || !/^[0-9a-f]{40}$/.test(commit || '')) {
  console.error('Usage: node tests/e2e/production-smoke.mjs https://your-app.example <main-commit-sha> [--health=/healthz]');
  process.exit(2);
}
let origin;
try { origin = new URL(site); } catch { console.error('Invalid origin'); process.exit(2); }
if (origin.protocol !== 'https:' || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) {
  console.error('Only an exact HTTPS origin is allowed');
  process.exit(2);
}
const health = options.find(value => value.startsWith('--health='))?.slice(9);
if (options.some(value => !value.startsWith('--health=')) ||
    (health && (!/^\/[a-zA-Z0-9/_-]+$/.test(health) || health.startsWith('//')))) {
  console.error('Invalid health endpoint/options');
  process.exit(2);
}
function gitContent(file) {
  return execFileSync('git', ['show', commit + ':' + file], {maxBuffer: 12_000_000});
}
function linkedAsset(document, filename) {
  const escaped = filename.replaceAll('.', '\\.');
  const found = document.match(new RegExp('(?:href|src)="\\./(' + escaped + '\\?rev=[^"]+)"'));
  if (!found) throw Error('Missing revisioned reference for ' + filename);
  return '/' + found[1];
}
function importedAsset(module, filename) {
  const escaped = filename.replaceAll('.', '\\.');
  const found = module.match(new RegExp("from ['\"]\\./(" + escaped + "\\?rev=[^'\"]+)['\"]"));
  if (!found) throw Error('Missing versioned import for ' + filename);
  return '/' + found[1];
}
const home = gitContent('index.html').toString('utf8');
const account = gitContent('account.html').toString('utf8');
const app = gitContent('app.js').toString('utf8');
const files = [
  ['index.html', '/'],
  ['app.js', linkedAsset(home, 'app.js')],
  ['storage.js', importedAsset(app, 'storage.js')],
  ['account.html', '/account.html'],
  ['account.js', linkedAsset(account, 'account.js')],
  ['sw.js', '/sw.js'],
  ['manifest.webmanifest', '/manifest.webmanifest'],
  ['styles.css', linkedAsset(home, 'styles.css')],
];
const sha256 = value => createHash('sha256').update(value).digest('hex');
async function get(path) {
  const url = new URL(path, origin);
  const response = await fetch(url, {
    method: 'GET', redirect: 'error',
    headers: {'Cache-Control': 'no-cache', 'Pragma': 'no-cache', Accept: '*/*'},
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw Error(path + ': HTTP ' + response.status);
  return response;
}
let failures = 0;
for (const [file, path] of files) {
  try {
    const expected = gitContent(file);
    const delivered = Buffer.from(await (await get(path)).arrayBuffer());
    if (sha256(expected) !== sha256(delivered)) {
      throw Error('Deployed bytes differ from commit ' + commit);
    }
    console.log('PASS ' + file + ' sha256=' + sha256(delivered).slice(0, 16));
  } catch (error) {
    failures++;
    console.error('FAIL ' + file + ': ' + error.message);
  }
}
try {
  const configuration = await (await get('/api/auth/email/config')).json();
  if (typeof configuration.enabled !== 'boolean' || configuration.email_only !== true)
    throw Error('Unexpected public auth API response');
  console.log('PASS GET /api/auth/email/config; registration=' + (configuration.enabled ? 'enabled' : 'disabled'));
} catch (error) {
  failures++;
  console.error('FAIL public authentication health: ' + error.message);
}
if (health) {
  try { await get(health); console.log('PASS GET ' + health); }
  catch (error) { failures++; console.error('FAIL health: ' + error.message); }
}
console.log('Main commit: ' + commit);
console.log('Compared assets: ' + files.length + ', failures: ' + failures);
console.log('Deployment revision and rollback must be independently verified from production deployment evidence.');
if (failures) process.exitCode = 1;
