import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Synthetic native IndexedDB only. No real finance database, network API or
// financial-horizon-browser-v1 access. Both source modules are inactive.
const candidate = readFileSync(
  new URL('../../src/security/contiguous-delta-candidate.js', import.meta.url), 'utf8'
);
const replay = readFileSync(
  new URL('../../src/security/offline-ack-replay-candidate.js', import.meta.url), 'utf8'
);
const scopeA = 'account:' + 'a'.repeat(32);
const scopeB = 'account:' + 'b'.repeat(32);
const epochA = 'c'.repeat(32);
const epochB = 'd'.repeat(32);
const idA = '00000000-0000-4000-8000-0000000000a1';
const idPending = '00000000-0000-4000-8000-0000000000a2';
const idConflict = '00000000-0000-4000-8000-0000000000a3';
const idForeign = '00000000-0000-4000-8000-0000000000b1';
const fpA = 'a'.repeat(64);
const fpB = 'b'.repeat(64);

async function withDatabase(page, name, operation, payload) {
  return page.evaluate(async ({ name, operation, payload }) => {
    const req = indexedDB.open(name, 1);
    const db = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      if (operation === 'delta') {
        const { persistContiguousDeltaCandidate } =
          await import('/__e2e_fh_contiguous_candidate__.js');
        const controller = new AbortController();
        const result = persistContiguousDeltaCandidate(db, payload.batch, controller.signal);
        if (payload.abortImmediately) controller.abort();
        return await result;
      }
      if (operation === 'ack') {
        const { reconcileVerifiedReplay } = await import('/__e2e_fh_ack_candidate__.js');
        return await reconcileVerifiedReplay(db, payload.ack, new AbortController().signal);
      }
      if (operation === 'snapshot') {
        const keys = [
          ['metaA', 'meta', scopeA],
          ['metaB', 'meta', scopeB],
          ['financeA', 'finance', scopeA],
          ['financeB', 'finance', scopeB],
          ['appliedA', 'applied', [scopeA, idA]],
          ['outboxA', 'outbox', [scopeA, idA]],
          ['pending', 'outbox', [scopeA, idPending]],
          ['conflict', 'outbox', [scopeA, idConflict]],
          ['foreign', 'outbox', [scopeB, idForeign]],
        ];
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(['meta', 'finance', 'applied', 'outbox'], 'readonly');
          const result = {};
          for (const [label, store, key] of keys) {
            const r = tx.objectStore(store).get(key);
            r.onsuccess = () => { result[label] = r.result ?? null; };
          }
          tx.oncomplete = () => resolve(result);
          tx.onabort = () => reject(tx.error || Error('snapshot aborted'));
        });
      }
      if (operation === 'patch') {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['outbox'], 'readwrite');
          const store = tx.objectStore('outbox');
          const req = store.get([scopeA, idA]);
          req.onsuccess = () => {
            store.put({ ...req.result, fingerprint: payload.fingerprint }, [scopeA, idA]);
          };
          tx.oncomplete = resolve;
          tx.onabort = () => reject(tx.error || Error('patch aborted'));
        });
        return 'PATCHED';
      }
      throw Error('unknown synthetic operation');
    } finally { db.close(); }
  }, { name, operation, payload });
}

test('contiguous state+cursor+proof commit is atomic, scoped and preserves outbox across reload', async ({ page, context }) => {
  const staleTab = await context.newPage();
  const name = 'fh-e2e-contiguous-' + test.info().project.name + '-' + Date.now();
  await context.route('**/__e2e_fh_contiguous_candidate__.js', route => route.fulfill({
    status: 200, contentType: 'text/javascript', body: candidate,
    headers: { 'Cache-Control': 'no-store' },
  }));
  await context.route('**/__e2e_fh_ack_candidate__.js', route => route.fulfill({
    status: 200, contentType: 'text/javascript', body: replay,
    headers: { 'Cache-Control': 'no-store' },
  }));
  await page.goto('/__e2e__/ready');
  await staleTab.goto('/__e2e__/ready');
  try {
    await page.evaluate(async ({ name, scopeA, scopeB, epochA, epochB,
      idA, idPending, idConflict, idForeign, fpA, fpB }) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        for (const store of ['meta', 'finance', 'applied', 'outbox']) {
          request.result.createObjectStore(store);
        }
      };
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['meta', 'finance', 'outbox'], 'readwrite');
          tx.objectStore('meta').put(
            { scope: scopeA, epoch: epochA, generation: 4, cursor: 5 }, scopeA
          );
          tx.objectStore('meta').put(
            { scope: scopeB, epoch: epochB, generation: 9, cursor: 3 }, scopeB
          );
          tx.objectStore('finance').put(
            { scope: scopeA, epoch: epochA, generation: 4, revision: 5, synthetic: 'before' },
            scopeA
          );
          tx.objectStore('finance').put(
            { scope: scopeB, epoch: epochB, generation: 9, revision: 3, synthetic: 'foreign' },
            scopeB
          );
          const outbox = tx.objectStore('outbox');
          const add = (scope, epoch, generation, id, fingerprint, status) =>
            outbox.put({ scope, epoch, generation, mutationId: id, fingerprint, status },
              [scope, id]);
          add(scopeA, epochA, 4, idA, fpA, 'sending');
          add(scopeA, epochA, 4, idPending, fpB, 'pending');
          add(scopeA, epochA, 4, idConflict, fpB, 'conflict');
          add(scopeB, epochB, 9, idForeign, fpA, 'pending');
          tx.oncomplete = resolve;
          tx.onabort = () => reject(tx.error || Error('seed aborted'));
        });
      } finally { db.close(); }
    }, { name, scopeA, scopeB, epochA, epochB,
      idA, idPending, idConflict, idForeign, fpA, fpB });

    const batch = {
      scope: scopeA, epoch: epochA, generation: 4, expectedCursor: 5,
      revisions: [
        { revision: 6, commands: [{ mutationId: idA, fingerprint: fpA }] },
        { revision: 7, commands: [] }, // Server revisions can include no local command.
      ],
      financeState: {
        scope: scopeA, epoch: epochA, generation: 4, revision: 7, synthetic: 'after',
      },
    };
    const baseline = await withDatabase(page, name, 'snapshot');
    expect(baseline.appliedA).toBeNull();

    // A stale tab, unexpected cursor, or changed queued fingerprint must
    // never persist *any* of the new finance state, cursor or proof.
    expect(await withDatabase(staleTab, name, 'delta', {
      batch: { ...batch, epoch: epochB },
    })).toBe('RECOVERY_HOLD');
    expect(await withDatabase(page, name, 'delta', {
      batch: { ...batch, expectedCursor: 4 },
    })).toBe('RECOVERY_HOLD');
    await withDatabase(page, name, 'patch', { fingerprint: fpB });
    expect(await withDatabase(page, name, 'delta', { batch })).toBe('RECOVERY_HOLD');
    await withDatabase(page, name, 'patch', { fingerprint: fpA });
    expect(await withDatabase(page, name, 'delta', {
      batch, abortImmediately: true,
    })).toBe('RECOVERY_HOLD');
    expect(await withDatabase(page, name, 'snapshot')).toEqual(baseline);

    // The synthetic upstream verifier is outside this primitive's scope.
    // An injected state is not proof of a genuine authenticated server delta.
    expect(await withDatabase(page, name, 'delta', { batch })).toBe('APPLIED');
    const applied = await withDatabase(page, name, 'snapshot');
    expect(applied.metaA.cursor).toBe(7);
    expect(applied.financeA).toEqual(batch.financeState);
    expect(applied.appliedA).toEqual({
      scope: scopeA, epoch: epochA, generation: 4, mutationId: idA,
      fingerprint: fpA, revision: 6, applied: true,
    });
    for (const field of ['metaB', 'financeB', 'outboxA', 'pending', 'conflict', 'foreign']) {
      expect(applied[field]).toEqual(baseline[field]);
    }
    expect(await withDatabase(staleTab, name, 'delta', { batch }))
      .toBe('RECOVERY_HOLD');

    await page.reload();
    expect(await withDatabase(page, name, 'snapshot')).toEqual(applied);
    // The previously merged inactive replay-ACK primitive is now given
    // genuine *atomic local persistence* evidence by this synthetic writer.
    const ack = { scope: scopeA, epoch: epochA, generation: 4,
      mutationId: idA, fingerprint: fpA, revision: 6 };
    expect(await withDatabase(page, name, 'ack', { ack })).toBe('ACKED');
    const settled = await withDatabase(page, name, 'snapshot');
    expect(settled.outboxA).toBeNull();
    expect(settled.metaA.cursor).toBe(7);
    for (const field of ['metaB', 'financeB', 'pending', 'conflict', 'foreign']) {
      expect(settled[field]).toEqual(baseline[field]);
    }
  } finally {
    await staleTab.close().catch(() => {});
    await page.evaluate(async dbName => {
      await new Promise(resolve => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = resolve;
        request.onerror = resolve;
        request.onblocked = resolve;
      });
    }, name).catch(() => {});
  }
});
