// INACTIVE #34/#68 design candidate. Not imported by the PWA or its sync engine.
// The caller must supply an authenticated account scope and a revocable session signal.
// Store "applied" evidence is trusted ONLY if #68 writes it atomically with verified
// contiguous deltas, cursor and local financial state in the same native IDB transaction.
const accountScope = /^account:[a-f0-9]{32}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;

export function reconcileVerifiedReplay(db, ack, signal) {
  if (!db || !ack || !accountScope.test(ack.scope) ||
      !uuid.test(ack.mutationId) || !digest.test(ack.fingerprint) ||
      !Number.isSafeInteger(ack.generation) || ack.generation < 1 ||
      !Number.isSafeInteger(ack.revision) || ack.revision < 0) {
    return Promise.reject(new TypeError('Invalid replay reconciliation inputs'));
  }
  if (signal?.aborted) return Promise.resolve('RECOVERY_HOLD');
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(['meta', 'outbox', 'applied'], 'readwrite'); }
    catch (error) { reject(error); return; }

    let outcome = 'RECOVERY_HOLD';
    const abort = () => { try { tx.abort(); } catch { /* transaction already finished */ } };
    const hold = () => { outcome = 'RECOVERY_HOLD'; abort(); };
    const cleanup = () => signal?.removeEventListener('abort', abort);
    tx.oncomplete = () => { cleanup(); resolve(outcome); };
    tx.onabort = () => {
      cleanup();
      if (tx.error) reject(tx.error);
      else resolve('RECOVERY_HOLD');
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { hold(); return; }

    const meta = tx.objectStore('meta').get(ack.scope);
    meta.onsuccess = () => {
      const current = meta.result;
      if (!current || current.scope !== ack.scope ||
          current.generation !== ack.generation ||
          !Number.isSafeInteger(current.cursor) ||
          current.cursor < 0 || ack.revision > current.cursor) {
        hold(); return;
      }
      const key = [ack.scope, ack.mutationId];
      const proof = tx.objectStore('applied').get(key);
      proof.onsuccess = () => {
        const record = proof.result;
        if (!record || record.scope !== ack.scope ||
            record.mutationId !== ack.mutationId ||
            record.fingerprint !== ack.fingerprint ||
            record.revision !== ack.revision ||
            record.applied !== true) {
          hold(); return;
        }
        const queued = tx.objectStore('outbox').get(key);
        queued.onsuccess = () => {
          const entry = queued.result;
          if (!entry) { outcome = 'ALREADY_SETTLED'; return; }
          if (entry.scope !== ack.scope || entry.mutationId !== ack.mutationId ||
              entry.fingerprint !== ack.fingerprint ||
              !['pending', 'sending'].includes(entry.status)) {
            hold(); return;
          }
          // Cursor, epoch, other pending/sending/conflict entries and other
          // account scopes are never overwritten by an old replay receipt.
          tx.objectStore('outbox').delete(key);
          outcome = 'ACKED';
        };
      };
    };
  });
}
