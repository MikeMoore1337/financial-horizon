// INACTIVE #34/#67/#68 contract-shape guard. Never imported by the running PWA.
// A matching HTTP-shaped ACK/delta is NOT proof of an authenticated server,
// a trusted finance snapshot, a canonical request fingerprint, or a safe cutover.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const kinds = new Set(['upsert', 'tombstone', 'ledger_posted']);
const integer = n => Number.isSafeInteger(n) && n >= 0;
const keys = (value, expected) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === expected.length &&
  expected.every(key => Object.hasOwn(value, key));
const eventKeys = ['revision', 'ordinal', 'kind', 'entity_id', 'entity_revision', 'payload'];

// The API carries JSON objects. Comparison is independent of property ordering
// and rejects unexpected nesting or non-JSON values rather than serializing
// a client-side surrogate for the server's Python canonical request digest.
function jsonEqual(a, b, depth = 0) {
  if (depth > 16 || a === undefined || b === undefined) return false;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return a === b && (typeof a !== 'number' || Number.isFinite(a));
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length <= 2048 && a.length === b.length &&
      a.every((value, index) => jsonEqual(value, b[index], depth + 1));
  }
  const ak = Object.keys(a);
  return ak.length <= 128 && ak.length === Object.keys(b).length &&
    ak.every(key => Object.hasOwn(b, key) && jsonEqual(a[key], b[key], depth + 1));
}

function validEvent(event) {
  return keys(event, eventKeys) && integer(event.revision) && event.revision > 0 &&
    integer(event.ordinal) && kinds.has(event.kind) &&
    typeof event.entity_id === 'string' && uuid.test(event.entity_id) &&
    integer(event.entity_revision) && event.entity_revision > 0 &&
    event.payload !== null && typeof event.payload === 'object' &&
    !Array.isArray(event.payload);
}

// The comparison deliberately returns no "applied" proof. Only #67 authenticated
// session/receipt + trusted complete finance-state verification followed by #68
// atomic IDB persistence may create a durable applied proof.
export function checkV1AckDeltaShape(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return 'RECOVERY_HOLD';
  }
  const { startCursor, pages, ack, mutationId } = input;
  if (!integer(startCursor) || typeof mutationId !== 'string' || !uuid.test(mutationId) ||
      !Array.isArray(pages) || pages.length < 1 || pages.length > 32 ||
      !keys(ack, ['schema_version', 'client_mutation_id', 'revision', 'replayed', 'changes']) ||
      ack.schema_version !== 1 || ack.client_mutation_id !== mutationId ||
      !integer(ack.revision) || ack.revision <= startCursor ||
      typeof ack.replayed !== 'boolean' ||
      !Array.isArray(ack.changes) || ack.changes.length < 1 ||
      ack.changes.length > 2000) return 'RECOVERY_HOLD';

  let expected = startCursor;
  let pinnedHead;
  let matchedEvents = null;
  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    if (!keys(page, ['schema_version', 'from_revision', 'to_revision',
                     'next_since_revision', 'has_more', 'changes']) ||
        page.schema_version !== 1 || page.from_revision !== expected ||
        !integer(page.to_revision) || !integer(page.next_since_revision) ||
        page.next_since_revision < expected ||
        page.to_revision < page.next_since_revision ||
        typeof page.has_more !== 'boolean' ||
        page.has_more !== (page.next_since_revision < page.to_revision) ||
        !Array.isArray(page.changes) || page.changes.length > 2000 ||
        (pinnedHead !== undefined && page.to_revision !== pinnedHead)) {
      return 'RECOVERY_HOLD';
    }
    pinnedHead = page.to_revision;
    if ((page.has_more && p === pages.length - 1) ||
        (!page.has_more && p !== pages.length - 1) ||
        (page.next_since_revision > expected && page.changes.length === 0) ||
        (page.next_since_revision === expected && page.changes.length !== 0) ||
        (page.has_more && page.next_since_revision === expected)) {
      return 'RECOVERY_HOLD';
    }

    let currentRevision = expected;
    let ordinal = 0;
    let group = [];
    for (const event of page.changes) {
      if (!validEvent(event) || event.revision <= expected ||
          event.revision < currentRevision ||
          event.revision > currentRevision + 1) return 'RECOVERY_HOLD';
      if (event.revision === currentRevision + 1) {
        // A page must start each committed revision at ordinal 0. Revisions
        // are never split between pages or skipped by an incomplete cursor.
        if (currentRevision > expected && currentRevision === ack.revision) {
          if (matchedEvents !== null) return 'RECOVERY_HOLD';
          matchedEvents = group;
        }
        currentRevision++;
        ordinal = 0;
        group = [];
      }
      if (event.revision !== currentRevision || event.ordinal !== ordinal) {
        return 'RECOVERY_HOLD';
      }
      ordinal++;
      group.push(event);
    }
    if (currentRevision !== page.next_since_revision) return 'RECOVERY_HOLD';
    if (group.length && currentRevision === ack.revision) {
      if (matchedEvents !== null) return 'RECOVERY_HOLD';
      matchedEvents = group;
    }
    expected = page.next_since_revision;
  }
  if (expected !== pinnedHead || ack.revision > expected || matchedEvents === null ||
      matchedEvents.length !== ack.changes.length) return 'RECOVERY_HOLD';
  for (let i = 0; i < matchedEvents.length; i++) {
    const change = ack.changes[i];
    if (!validEvent(change) || change.revision !== ack.revision ||
        change.ordinal !== i || !jsonEqual(change, matchedEvents[i])) {
      return 'RECOVERY_HOLD';
    }
  }
  return 'MATCHED_STRUCTURALLY';
}
