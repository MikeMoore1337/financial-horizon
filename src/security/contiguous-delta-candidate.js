// INACTIVE #34/#68 native-IDB persistence candidate. No production imports.
// The caller must authenticate and verify the complete contiguous server delta
// and its resulting finance state BEFORE invoking this function.
// This module does not verify HTTP, server signatures, the financial schema,
// encryption, legacy-writer fencing, or the truth of the injected state.
const scopePattern = /^account:[a-f0-9]{32}$/;
const epochPattern = /^[a-f0-9]{32}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^[a-f0-9]{64}$/;

export function persistContiguousDeltaCandidate(db, input, signal) {
  const { scope, epoch, generation, expectedCursor, revisions, financeState } = input || {};
  if (!db || !scopePattern.test(scope) || !epochPattern.test(epoch) ||
      !Number.isSafeInteger(generation) || generation < 1 ||
      !Number.isSafeInteger(expectedCursor) || expectedCursor < 0 ||
      !Array.isArray(revisions) || revisions.length < 1 || revisions.length > 128 ||
      !signal || typeof signal.aborted !== 'boolean' ||
      typeof signal.addEventListener !== 'function' ||
      typeof signal.removeEventListener !== 'function') {
    return Promise.reject(new TypeError('Invalid delta candidate inputs'));
  }

  const commands = [];
  const seen = new Set();
  for (let index = 0; index < revisions.length; index++) {
    const part = revisions[index];
    if (!part || !Number.isSafeInteger(part.revision) ||
        part.revision !== expectedCursor + index + 1 ||
        !Array.isArray(part.commands) || part.commands.length > 128) {
      return Promise.reject(new TypeError('Noncontiguous or invalid delta revision'));
    }
    for (const item of part.commands) {
      if (!item || !uuidPattern.test(item.mutationId) ||
          !digestPattern.test(item.fingerprint) || seen.has(item.mutationId)) {
        return Promise.reject(new TypeError('Invalid or duplicated mutation proof'));
      }
      seen.add(item.mutationId);
      commands.push({ mutationId: item.mutationId,
        fingerprint: item.fingerprint, revision: part.revision });
    }
  }
  const nextCursor = expectedCursor + revisions.length;
  if (!Number.isSafeInteger(nextCursor) || !financeState ||
      typeof financeState !== 'object' || Array.isArray(financeState) ||
      financeState.scope !== scope || financeState.epoch !== epoch ||
      financeState.generation !== generation ||
      financeState.revision !== nextCursor) {
    return Promise.reject(new TypeError('Invalid resulting finance state'));
  }

  // Clone before the first async IndexedDB request. Mutable network objects
  // cannot change their persisted values during asynchronous callbacks.
  let frozenState;
  try { frozenState = structuredClone(financeState); }
  catch (error) { return Promise.reject(error); }
  if (signal.aborted) return Promise.resolve('RECOVERY_HOLD');

  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(['meta', 'finance', 'applied', 'outbox'], 'readwrite'); }
    catch (error) { reject(error); return; }
    let outcome = 'RECOVERY_HOLD';
    const abort = () => { try { tx.abort(); } catch { /* already finished */ } };
    const hold = () => { outcome = 'RECOVERY_HOLD'; abort(); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    tx.oncomplete = () => { cleanup(); resolve(outcome); };
    tx.onabort = () => {
      cleanup();
      if (tx.error) reject(tx.error);
      else resolve('RECOVERY_HOLD');
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { hold(); return; }

    const metaStore = tx.objectStore('meta');
    const financeStore = tx.objectStore('finance');
    const proofStore = tx.objectStore('applied');
    const outboxStore = tx.objectStore('outbox');
    const meta = metaStore.get(scope);
    meta.onsuccess = () => {
      const old = meta.result;
      if (!old || old.scope !== scope || old.epoch !== epoch ||
          old.generation !== generation || old.cursor !== expectedCursor) {
        hold(); return;
      }
      const currentFinance = financeStore.get(scope);
      currentFinance.onsuccess = () => {
        const current = currentFinance.result;
        if (!current || current.scope !== scope ||
            current.epoch !== epoch || current.generation !== generation ||
            current.revision !== expectedCursor) {
          hold(); return;
        }
        checkCommand(0);
      };
    };

    function checkCommand(index) {
      if (index === commands.length) {
        // These four stores commit together or all abort. No outbox deletion
        // occurs: ACK settlement is a separate strict CAS operation.
        metaStore.put({ scope, epoch, generation, cursor: nextCursor }, scope);
        financeStore.put(frozenState, scope);
        for (const item of commands) {
          proofStore.put({ scope, epoch, generation, mutationId: item.mutationId,
            fingerprint: item.fingerprint, revision: item.revision, applied: true },
          [scope, item.mutationId]);
        }
        outcome = 'APPLIED';
        return;
      }
      const item = commands[index];
      const key = [scope, item.mutationId];
      const proof = proofStore.get(key);
      proof.onsuccess = () => {
        // A pre-existing proof for a future revision is evidence of a broken
        // atomic-commit invariant. Never rewrite it into an apparent success.
        if (proof.result !== undefined) { hold(); return; }
        const queued = outboxStore.get(key);
        queued.onsuccess = () => {
          const row = queued.result;
          if (row && (row.scope !== scope || row.mutationId !== item.mutationId ||
              row.generation !== generation || row.epoch !== epoch ||
              row.fingerprint !== item.fingerprint ||
              !['pending', 'sending', 'conflict'].includes(row.status))) {
            hold(); return;
          }
          checkCommand(index + 1);
        };
      };
    }
  });
}
