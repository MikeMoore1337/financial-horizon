import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// Standalone, synthetic Web Crypto test. No production app or legacy storage import.
const asJS = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022},
}).outputText;
const vaultJS = asJS('../../src/security/local-vault.ts');
const sessionJS = asJS('../../src/security/local-budget-session.ts')
  .replace(/['"]\.\/local-vault\.ts['"]/g, "'/__e2e_budget_vault__.js'");

test('local unlock remains locked after reload; offline unlock and account isolation', async ({page, context}) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/__e2e_budget_vault__.js', route => route.fulfill({
    status: 200, contentType: 'text/javascript', body: vaultJS,
    headers: {'Cache-Control': 'no-store'},
  }));
  await page.route('**/__e2e_budget_session__.js', route => route.fulfill({
    status: 200, contentType: 'text/javascript', body: sessionJS,
    headers: {'Cache-Control': 'no-store'},
  }));
  await page.goto('/__e2e__/ready');
  const first = await page.evaluate(async () => {
    const {createLocalKeyset} = await import('/__e2e_budget_vault__.js');
    const {LocalBudgetSession} = await import('/__e2e_budget_session__.js');
    const scope = 'guest:browser-qa';
    const {keyset, recoveryKey, vault} = await createLocalKeyset(scope, 'independent local test phrase 2026');
    vault.lock();
    const session = new LocalBudgetSession();
    session.selectScope(scope);
    await session.unlock(keyset, {passphrase: 'independent local test phrase 2026'});
    const ctx = {kind: 'snapshot', recordId: 'state', schemaVersion: 2, revision: 5};
    const encrypted = await session.encrypt({title: 'UNIQUE_PRIVATE_FINANCE_TITLE', amountCents: 123456789}, ctx);
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('fh-local-session-e2e', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('sealed');
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('sealed', 'readwrite');
      tx.objectStore('sealed').put({keyset, encrypted}, 'state');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close(); session.logout();
    let blocked = false;
    try { await session.decrypt(encrypted, ctx); } catch { blocked = true; }
    const persisted = JSON.stringify({keyset, encrypted});
    return {state: session.state, blocked, noPlaintext: !persisted.includes('UNIQUE_PRIVATE_FINANCE_TITLE') &&
      !persisted.includes('123456789') && !persisted.includes(recoveryKey)};
  });
  expect(first).toEqual({state: 'unselected', blocked: true, noPlaintext: true});

  await page.reload();
  // JS modules are already loaded before taking the browser offline.
  await page.evaluate(async () => { globalThis.__qaSession = await import('/__e2e_budget_session__.js'); });
  await context.setOffline(true);
  try {
    const second = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open('fh-local-session-e2e', 1);
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
      const stored = await new Promise((resolve, reject) => {
        const tx = db.transaction('sealed', 'readonly');
        const req = tx.objectStore('sealed').get('state');
        tx.oncomplete = () => resolve(req.result); tx.onerror = () => reject(tx.error);
      });
      db.close();
      const session = new globalThis.__qaSession.LocalBudgetSession();
      const initiallyLocked = session.state === 'unselected';
      session.selectScope('guest:browser-qa');
      await session.unlock(stored.keyset, {passphrase: 'independent local test phrase 2026'});
      const plain = await session.decrypt(stored.encrypted, {
        kind: 'snapshot', recordId: 'state', schemaVersion: 2, revision: 5,
      });
      session.selectScope('guest:other-account');
      let isolated = false;
      try { await session.unlock(stored.keyset, {passphrase: 'independent local test phrase 2026'}); }
      catch { isolated = true; }
      return {offline: !navigator.onLine, initiallyLocked, sum: plain.amountCents,
        isolated, locked: session.state === 'locked'};
    });
    expect(second).toEqual({offline: true, initiallyLocked: true, sum: 123456789,
      isolated: true, locked: true});
  } finally {
    await context.setOffline(false);
  }
  expect(errors).toEqual([]);
});
