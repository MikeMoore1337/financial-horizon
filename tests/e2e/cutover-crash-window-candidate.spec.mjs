import { test, expect } from '@playwright/test';

// Design-only, synthetic failure experiment. Never touch financial-horizon-browser-v1.
// A candidate written BEFORE an old writer is fenced cannot be committed after a crash/reload.
test('stale staged candidate is detectably different after blocked old writer and reload', async ({ page, context }) => {
  const old = await context.newPage();
  const suffix = test.info().project.name + '-' + Date.now();
  const source = 'fh-e2e-cutover-source-' + suffix;
  const candidate = 'fh-e2e-cutover-candidate-' + suffix;
  await page.goto('/__e2e__/ready');
  await old.goto('/__e2e__/ready');

  try {
    await old.evaluate(async (name) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('finance');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      window.__fhSyntheticOld = db;
      // A cached legacy writer is allowed to ignore versionchange.
      db.onversionchange = () => { window.__fhSyntheticVersionChange = true; };
      await new Promise((resolve, reject) => {
        const tx = db.transaction('finance', 'readwrite');
        tx.objectStore('finance').put({
          revision: 1,
          outbox: [
            { id: 'pending-1', state: 'pending' },
            { id: 'sending-1', state: 'sending' },
            { id: 'conflict-1', state: 'conflict' },
          ],
        }, 'account-A');
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error || Error('seed aborted'));
        tx.onerror = () => reject(tx.error);
      });
    }, source);

    const staged = await page.evaluate(async ({ source, candidate }) => {
      const openSource = indexedDB.open(source, 1);
      const sourceDb = await new Promise((resolve, reject) => {
        openSource.onsuccess = () => resolve(openSource.result);
        openSource.onerror = () => reject(openSource.error);
      });
      const snapshot = await new Promise((resolve, reject) => {
        const tx = sourceDb.transaction('finance', 'readonly');
        const request = tx.objectStore('finance').get('account-A');
        let result;
        request.onsuccess = () => { result = request.result; };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
      });
      sourceDb.close();
      const openCandidate = indexedDB.open(candidate, 1);
      openCandidate.onupgradeneeded = () => {
        openCandidate.result.createObjectStore('snapshot');
        openCandidate.result.createObjectStore('journal');
      };
      const candidateDb = await new Promise((resolve, reject) => {
        openCandidate.onsuccess = () => resolve(openCandidate.result);
        openCandidate.onerror = () => reject(openCandidate.error);
      });
      await new Promise((resolve, reject) => {
        const tx = candidateDb.transaction(['snapshot', 'journal'], 'readwrite');
        tx.objectStore('snapshot').put(snapshot, 'account-A');
        tx.objectStore('journal').put(
          { phase: 'CANDIDATE_STAGED', legacyRevision: snapshot.revision }, 'account-A');
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
      });
      candidateDb.close();
      return snapshot;
    }, { source, candidate });
    expect(staged.outbox.map((op) => [op.id, op.state])).toEqual([
      ['pending-1', 'pending'], ['sending-1', 'sending'], ['conflict-1', 'conflict'],
    ]);

    await page.evaluate((name) => {
      window.__fhSyntheticBarrier = { blocked: false, done: false, upgraded: false, error: null };
      const request = indexedDB.open(name, 2);
      request.onblocked = () => { window.__fhSyntheticBarrier.blocked = true; };
      request.onupgradeneeded = () => { window.__fhSyntheticBarrier.upgraded = true; };
      request.onerror = () => {
        window.__fhSyntheticBarrier.error = request.error?.name || 'UnknownError';
        window.__fhSyntheticBarrier.done = true;
      };
      request.onsuccess = () => {
        request.result.close();
        window.__fhSyntheticBarrier.done = true;
      };
    }, source);
    await expect.poll(() => page.evaluate(() => window.__fhSyntheticBarrier?.blocked)).toBe(true);
    expect(await old.evaluate(() => window.__fhSyntheticVersionChange)).toBe(true);
    expect(await page.evaluate(() => window.__fhSyntheticBarrier.upgraded)).toBe(false);

    // A v1 handle writes a NEW pending operation after candidate verification.
    await old.evaluate(async () => {
      const db = window.__fhSyntheticOld;
      await new Promise((resolve, reject) => {
        const tx = db.transaction('finance', 'readwrite');
        const store = tx.objectStore('finance');
        const request = store.get('account-A');
        request.onsuccess = () => {
          const row = request.result;
          row.revision += 1;
          row.outbox.push({ id: 'pending-after-stage', state: 'pending' });
          store.put(row, 'account-A');
        };
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    await expect.poll(() => page.evaluate(() => window.__fhSyntheticBarrier?.done)).toBe(true);
    expect(await page.evaluate(() => window.__fhSyntheticBarrier)).toEqual({
      blocked: true, done: true, upgraded: true, error: null,
    });

    // Browser reload destroys in-memory assumptions; both IndexedDBs persist separately.
    await page.reload();
    const recovered = await page.evaluate(async ({ source, candidate }) => {
      const get = async (name, version, storeName) => {
        const request = indexedDB.open(name, version);
        const db = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          return await new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            const read = tx.objectStore(storeName).get('account-A');
            let result;
            read.onsuccess = () => { result = read.result; };
            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(tx.error);
            tx.onerror = () => reject(tx.error);
          });
        } finally { db.close(); }
      };
      return {
        source: await get(source, 2, 'finance'),
        candidate: await get(candidate, 1, 'snapshot'),
        journal: await get(candidate, 1, 'journal'),
      };
    }, { source, candidate });
    expect(recovered.source.revision).toBe(2);
    expect(recovered.candidate.revision).toBe(1);
    expect(recovered.source.outbox.map((op) => [op.id, op.state])).toEqual([
      ['pending-1', 'pending'], ['sending-1', 'sending'], ['conflict-1', 'conflict'],
      ['pending-after-stage', 'pending'],
    ]);
    expect(recovered.candidate.outbox).toEqual(staged.outbox);
    expect(recovered.journal).toEqual({ phase: 'CANDIDATE_STAGED', legacyRevision: 1 });
    // Any final-revision/contents check MUST refuse this candidate; no commit marker exists.
    expect(recovered.source).not.toEqual(recovered.candidate);
  } finally {
    await old.evaluate(() => window.__fhSyntheticOld?.close()).catch(() => {});
    await old.close().catch(() => {});
    await page.evaluate(async (names) => {
      for (const name of names) {
        await new Promise((resolve) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve();
          request.onerror = () => resolve();
          request.onblocked = () => resolve();
        });
      }
    }, [source, candidate]).catch(() => {});
  }
});
