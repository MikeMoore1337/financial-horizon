import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Native IndexedDB only, two tabs, synthetic account scopes. Never access the
// real financial-horizon-browser-v1 or any private HTTP finance endpoint.
const candidate = readFileSync(
  new URL('../../src/security/offline-ack-replay-candidate.js', import.meta.url), 'utf8'
);
const scopeA = 'account:' + 'a'.repeat(32);
const scopeB = 'account:' + 'b'.repeat(32);
const settledId = '00000000-0000-4000-8000-0000000000a1';
const pendingId = '00000000-0000-4000-8000-0000000000a2';
const conflictId = '00000000-0000-4000-8000-0000000000a3';
const foreignId = '00000000-0000-4000-8000-0000000000b1';
const fpA = 'a'.repeat(64);
const fpB = 'b'.repeat(64);
const epochA = 'c'.repeat(32);
const epochB = 'd'.repeat(32);

async function apply(page, name, ack, abortImmediately = false) {
  return page.evaluate(async ({ name, ack, abortImmediately }) => {
    const { reconcileVerifiedReplay } = await import('/__e2e_fh_ack_candidate__.js');
    const request = indexedDB.open(name, 1);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const controller = new AbortController();
      const result = reconcileVerifiedReplay(db, ack, controller.signal);
      if (abortImmediately) controller.abort();
      return await result;
    } finally { db.close(); }
  }, { name, ack, abortImmediately });
}

async function snapshot(page, name) {
  return page.evaluate(async ({ name, scopeA, scopeB, settledId, pendingId, conflictId, foreignId }) => {
    const request = indexedDB.open(name, 1);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(['meta', 'outbox'], 'readonly');
        const entries = [
          ['metaA', tx.objectStore('meta').get(scopeA)],
          ['metaB', tx.objectStore('meta').get(scopeB)],
          ['settle', tx.objectStore('outbox').get([scopeA, settledId])],
          ['pending', tx.objectStore('outbox').get([scopeA, pendingId])],
          ['conflict', tx.objectStore('outbox').get([scopeA, conflictId])],
          ['foreign', tx.objectStore('outbox').get([scopeB, foreignId])],
        ];
        const result = {};
        for (const [key, read] of entries) {
          read.onsuccess = () => { result[key] = read.result ?? null; };
        }
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error || Error('snapshot transaction aborted'));
        tx.onerror = () => reject(tx.error || Error('snapshot transaction failed'));
      });
    } finally { db.close(); }
  }, { name, scopeA, scopeB, settledId, pendingId, conflictId, foreignId });
}

async function patchFixture(page, name, storeName, key, patch) {
  await page.evaluate(async ({ name, storeName, key, patch }) => {
    const request = indexedDB.open(name, 1);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction([storeName], 'readwrite');
        const store = tx.objectStore(storeName);
        const get = store.get(key);
        get.onsuccess = () => {
          if (!get.result) { tx.abort(); return; }
          store.put({ ...get.result, ...patch }, key);
        };
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error || Error('fixture mutation aborted'));
      });
    } finally { db.close(); }
  }, { name, storeName, key, patch });
}

test('replayed old ACK cannot regress cursor or cross account/generation after reload', async ({ page, context }) => {
  const oldTab = await context.newPage();
  const name = 'fh-e2e-ack-replay-' + test.info().project.name + '-' + Date.now();
  await context.route('**/__e2e_fh_ack_candidate__.js', route => route.fulfill({
    status: 200, contentType: 'text/javascript', body: candidate,
    headers: { 'Cache-Control': 'no-store' },
  }));
  await page.goto('/__e2e__/ready');
  await oldTab.goto('/__e2e__/ready');

  try {
    await page.evaluate(async ({ name, scopeA, scopeB, settledId, pendingId, conflictId, foreignId, fpA, fpB, epochA, epochB }) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        for (const store of ['meta', 'outbox', 'applied']) {
          request.result.createObjectStore(store);
        }
      };
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['meta', 'outbox', 'applied'], 'readwrite');
          const meta = tx.objectStore('meta');
          const outbox = tx.objectStore('outbox');
          const applied = tx.objectStore('applied');
          meta.put({ scope: scopeA, generation: 4, epoch: epochA, cursor: 7 }, scopeA);
          meta.put({ scope: scopeB, generation: 2, epoch: epochB, cursor: 3 }, scopeB);
          const add = (scope, mutationId, fingerprint, status) =>
            outbox.put({ scope, mutationId, fingerprint, status,
              generation: scope === scopeA ? 4 : 2,
              epoch: scope === scopeA ? epochA : epochB,
            }, [scope, mutationId]);
          add(scopeA, settledId, fpA, 'sending');
          add(scopeA, pendingId, fpB, 'pending');
          add(scopeA, conflictId, fpB, 'conflict');
          add(scopeB, foreignId, fpA, 'pending');
          // Trusted applied proof would have to be recorded along with the
          // corresponding contiguous delta+finance+cursor transaction by #68.
          applied.put({
            scope: scopeA, mutationId: settledId, fingerprint: fpA,
            revision: 6, applied: true, generation: 4, epoch: epochA,
          }, [scopeA, settledId]);
          applied.put({
            scope: scopeA, mutationId: pendingId, fingerprint: fpB,
            revision: 7, applied: false, generation: 4, epoch: epochA,
          }, [scopeA, pendingId]);
          tx.oncomplete = resolve;
          tx.onabort = () => reject(tx.error || Error('fixture aborted'));
          tx.onerror = () => reject(tx.error || Error('fixture failed'));
        });
      } finally { db.close(); }
    }, { name, scopeA, scopeB, settledId, pendingId, conflictId, foreignId, fpA, fpB, epochA, epochB });

    const ack = { scope: scopeA, generation: 4, epoch: epochA,
      mutationId: settledId, fingerprint: fpA, revision: 6 };
    const baseline = await snapshot(page, name);
    expect(baseline.metaA.cursor).toBe(7);
    expect(baseline.metaB.cursor).toBe(3);

    // A cached page with a stale generation, a forged or newer ACK, and an
    // aborting logout may not acknowledge or delete the unsent operation.
    expect(await apply(oldTab, name, { ...ack, generation: 3 })).toBe('RECOVERY_HOLD');
    expect(await apply(oldTab, name, { ...ack, epoch: epochB })).toBe('RECOVERY_HOLD');
    expect(await apply(page, name, { ...ack, fingerprint: fpB })).toBe('RECOVERY_HOLD');
    expect(await apply(page, name, { ...ack, revision: 8 })).toBe('RECOVERY_HOLD');
    expect(await apply(page, name, { ...ack, scope: scopeB, generation: 2 })).toBe('RECOVERY_HOLD');
    expect(await apply(page, name, {
      ...ack, mutationId: pendingId, fingerprint: fpB, revision: 7,
    })).toBe('RECOVERY_HOLD');
    // A previous generation's applied proof or requeued command must not
    // be settled, even when UUID/fingerprint/revision/cursor still match.
    const key = [scopeA, settledId];
    await patchFixture(page, name, 'applied', key, { generation: 3 });
    expect(await apply(oldTab, name, ack)).toBe('RECOVERY_HOLD');
    await patchFixture(page, name, 'applied', key, { generation: 4 });
    await patchFixture(page, name, 'applied', key, { epoch: epochB });
    expect(await apply(page, name, ack)).toBe('RECOVERY_HOLD');
    await patchFixture(page, name, 'applied', key, { epoch: epochA });
    await patchFixture(page, name, 'outbox', key, { generation: 3 });
    expect(await apply(oldTab, name, ack)).toBe('RECOVERY_HOLD');
    await patchFixture(page, name, 'outbox', key, { generation: 4 });
    await patchFixture(page, name, 'outbox', key, { epoch: epochB });
    expect(await apply(page, name, ack)).toBe('RECOVERY_HOLD');
    await patchFixture(page, name, 'outbox', key, { epoch: epochA });
    expect(await apply(page, name, ack, true)).toBe('RECOVERY_HOLD');
    expect(await snapshot(page, name)).toEqual(baseline);

    // Simulate lost HTTP reply/local commit and a browser reload: pending
    // remains until the same verified replay receipt is reconciled.
    await page.reload();
    expect(await snapshot(page, name)).toEqual(baseline);
    expect(await apply(page, name, ack)).toBe('ACKED');
    expect(await apply(page, name, ack)).toBe('ALREADY_SETTLED');

    const after = await snapshot(page, name);
    expect(after.metaA).toEqual(baseline.metaA); // cursor 7 never becomes 6
    expect(after.metaB).toEqual(baseline.metaB);
    expect(after.settle).toBeNull();
    expect(after.pending).toEqual(baseline.pending);
    expect(after.conflict).toEqual(baseline.conflict);
    expect(after.foreign).toEqual(baseline.foreign);
  } finally {
    await oldTab.close().catch(() => {});
    await page.evaluate(async name => {
      await new Promise(resolve => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = resolve;
        request.onerror = resolve;
        request.onblocked = resolve;
      });
    }, name).catch(() => {});
  }
});
