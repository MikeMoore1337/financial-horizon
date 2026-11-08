import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// Isolated synthetic IndexedDB. Neither app.js nor storage.js imports this module.
const toJS = path => ts.transpileModule(
  readFileSync(new URL(path, import.meta.url), 'utf8'),
  {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}},
).outputText;
const vaultJS = toJS('../../src/security/local-vault.ts');
const vaultUrl = '/__e2e_atomic_vault__.js';
const sessionJS = toJS('../../src/security/local-budget-session.ts')
  .replace(/['"]\.\/local-vault\.ts['"]/g, JSON.stringify(vaultUrl));
const atomicJS = toJS('../../src/security/protected-atomic-candidate.ts')
  .replace(/['"]\.\/local-vault\.ts['"]/g, JSON.stringify(vaultUrl));

test('native IDB atomic encrypted offline snapshot, outbox, CAS, restart and tampering', async ({page, context}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const scripts = new Map([
    [vaultUrl, vaultJS],
    ['/__e2e_atomic_session__.js', sessionJS],
    ['/__e2e_atomic_store__.js', atomicJS],
  ]);
  await context.route('**/__e2e_atomic_*.js', route => route.fulfill({
    status:200, contentType:'text/javascript',
    body:scripts.get(new URL(route.request().url()).pathname),
    headers:{'Cache-Control':'no-store'},
  }));
  await page.goto('/__e2e__/ready');
  const original = await page.evaluate(async () => {
    const mod = await import('/__e2e_atomic_store__.js');
    const {LocalBudgetSession} = await import('/__e2e_atomic_session__.js');
    const scope = 'guest:atomic-browser-qa';
    const passphrase = 'independent offline atomic test phrase 2026';
    const data = {
      snapshot:{version:2, revision:13, title:'SENSITIVE_ATOMIC_TITLE', amountCents:123456789},
      outbox:[{id:'SENSITIVE_PENDING_PAYMENT', amountCents:123450}],
      conflicts:[{reason:'PRIVATE_CONFLICT_DESCRIPTION'}],
    };
    const created = await mod.createAtomicEncryptedCandidate(scope, passphrase, data, 2);
    const keyset = await mod.getAtomicEncryptedKeyset(scope);
    const session = new LocalBudgetSession();
    session.selectScope(scope);
    await session.unlock(keyset, {passphrase});
    const original = await mod.readAtomicEncryptedCandidate(scope, session);
    const updated = {...data, outbox:[...data.outbox, {id:'EXTRA_PENDING', amountCents:1}]};
    const epoch = await mod.compareAndSwapAtomicEncryptedCandidate(scope, session, 0, 2, updated);
    let conflict = false;
    try {await mod.compareAndSwapAtomicEncryptedCandidate(scope, session, 0, 2, data);}
    catch {conflict = true;}
    const db = await new Promise((resolve,reject) => {
      const request = indexedDB.open(mod.ATOMIC_ENCRYPTED_DB,1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const persisted = await new Promise((resolve,reject) => {
      const tx = db.transaction(['keysets','bundles'], 'readonly');
      const one = tx.objectStore('keysets').getAll();
      const two = tx.objectStore('bundles').getAll();
      tx.oncomplete = () => resolve(JSON.stringify([one.result, two.result]));
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    session.logout();
    const blocked = session.state === 'unselected';
    return {
      correct:original.snapshot.amountCents === 123456789,
      epoch, conflict, blocked,
      noPlaintext:!['SENSITIVE_ATOMIC_TITLE','SENSITIVE_PENDING_PAYMENT',
        'PRIVATE_CONFLICT_DESCRIPTION','EXTRA_PENDING','123456789',passphrase,created.recoveryKey]
        .some(secret => persisted.includes(secret)),
    };
  });
  expect(original).toEqual({correct:true, epoch:1, conflict:true, blocked:true, noPlaintext:true});

  // A genuine second tab shares the browser's native IDB but not the first
  // tab's in-memory vault. Both start from epoch 1 and try different payments.
  const secondTab = await context.newPage();
  secondTab.on('pageerror', error => errors.push(error.message));
  await secondTab.goto('/__e2e__/ready');
  // A two-phase barrier proves both tabs read the same committed epoch
  // and independently prepare different outboxes BEFORE either tab can write.
  const prepareInTab = (tab, id) => tab.evaluate(async ({id}) => {
    const db = await import('/__e2e_atomic_store__.js');
    const {LocalBudgetSession} = await import('/__e2e_atomic_session__.js');
    const scope = 'guest:atomic-browser-qa';
    const keyset = await db.getAtomicEncryptedKeyset(scope);
    const session = new LocalBudgetSession();
    session.selectScope(scope);
    await session.unlock(keyset, {passphrase:'independent offline atomic test phrase 2026'});
    const current = await db.readAtomicEncryptedCandidate(scope, session);
    globalThis.__atomicPrepared = {
      scope,
      session,
      expectedEpoch:current.epoch,
      changed:{
        snapshot:current.snapshot,
        outbox:[...current.outbox, {id, amountCents:123}],
        conflicts:current.conflicts,
      },
    };
    return {epoch:current.epoch, queue:current.outbox.length};
  }, {id});
  const prepared = await Promise.all([
    prepareInTab(page, 'TAB_ONE_PAYMENT'),
    prepareInTab(secondTab, 'TAB_TWO_PAYMENT'),
  ]);
  expect(prepared).toEqual([{epoch:1, queue:2}, {epoch:1, queue:2}]);

  // Both prepared updates now contend in the native IndexedDB write queue;
  // the losing tab must receive a CAS failure, never silent last-write-wins.
  const commitInTab = tab => tab.evaluate(async () => {
    const db = await import('/__e2e_atomic_store__.js');
    const prepared = globalThis.__atomicPrepared;
    try {
      await db.compareAndSwapAtomicEncryptedCandidate(
        prepared.scope, prepared.session, prepared.expectedEpoch, 2, prepared.changed);
      return {status:'written'};
    } catch (error) {
      return {status:'rejected', reason:String(error.message)};
    } finally {
      prepared.session.logout();
      delete globalThis.__atomicPrepared;
    }
  });
  const competing = await Promise.all([commitInTab(page), commitInTab(secondTab)]);
  expect(competing.filter(x => x.status === 'written')).toHaveLength(1);
  expect(competing.filter(x => x.status === 'rejected')).toHaveLength(1);
  expect(competing.find(x => x.status === 'rejected').reason).toContain('другой вкладке');

  const afterRace = await page.evaluate(async () => {
    const db = await import('/__e2e_atomic_store__.js');
    const {LocalBudgetSession} = await import('/__e2e_atomic_session__.js');
    const scope = 'guest:atomic-browser-qa';
    const session = new LocalBudgetSession();
    session.selectScope(scope);
    await session.unlock(await db.getAtomicEncryptedKeyset(scope),
      {passphrase:'independent offline atomic test phrase 2026'});
    try {
      const value = await db.readAtomicEncryptedCandidate(scope, session);
      return {epoch:value.epoch, queue:value.outbox.length, tabPayments:value.outbox
        .filter(x => x.id === 'TAB_ONE_PAYMENT' || x.id === 'TAB_TWO_PAYMENT').length};
    } finally {session.logout();}
  });
  expect(afterRace).toEqual({epoch:2, queue:3, tabPayments:1});
  await secondTab.close();

  await page.reload();
  await page.evaluate(async () => {
    globalThis.__atomic = await import('/__e2e_atomic_store__.js');
    globalThis.__atomicSession = await import('/__e2e_atomic_session__.js');
  });
  await context.setOffline(true);
  try {
    const reopened = await page.evaluate(async () => {
      const scope = 'guest:atomic-browser-qa';
      const keyset = await globalThis.__atomic.getAtomicEncryptedKeyset(scope);
      const session = new globalThis.__atomicSession.LocalBudgetSession();
      session.selectScope(scope);
      let wrongDenied = false;
      try {await session.unlock(keyset,{passphrase:'incorrect local offline phrase 2026'});}
      catch {wrongDenied = session.state === 'locked';}
      await session.unlock(keyset,{passphrase:'independent offline atomic test phrase 2026'});
      const data = await globalThis.__atomic.readAtomicEncryptedCandidate(scope,session);
      // A metadata mutation must fail before any untrusted plaintext can be displayed.
      const db = await new Promise((resolve,reject) => {
        const r = indexedDB.open(globalThis.__atomic.ATOMIC_ENCRYPTED_DB,1);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      await new Promise((resolve,reject) => {
        const tx = db.transaction('bundles','readwrite');
        const store = tx.objectStore('bundles');
        const req = store.get(scope);
        req.onsuccess = () => {
          const row = req.result;
          row.conflicts.revision++;
          store.put(row,scope);
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      let tamperDenied = false;
      try {await globalThis.__atomic.readAtomicEncryptedCandidate(scope,session);}
      catch {tamperDenied = true;}
      session.logout();
      return {
        offline:!navigator.onLine,
        wrongDenied, tamperDenied,
        epoch:data.epoch, queue:data.outbox.length,
        amount:data.snapshot.amountCents,
        locked:session.state === 'unselected',
      };
    });
    expect(reopened).toEqual({offline:true, wrongDenied:true, tamperDenied:true,
      epoch:2, queue:3, amount:123456789, locked:true});
  } finally {await context.setOffline(false);}
  expect(errors).toEqual([]);
});
