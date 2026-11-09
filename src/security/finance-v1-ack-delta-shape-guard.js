// INACTIVE #34/#67/#68 contract-shape guard. Never imported by the running PWA.
// A matching HTTP-shaped ACK/delta is NOT proof of an authenticated server,
// a trusted finance snapshot, a canonical request fingerprint, or a safe cutover.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const kinds = new Set(['upsert', 'tombstone', 'ledger_posted']);
const integer = n => Number.isSafeInteger(n) && n >= 0;
// Reject getters, symbols and inherited fields before accessing untrusted envelopes.
const ownNames = v => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return null;
  const names = Reflect.ownKeys(v);
  if (names.length > 128 || names.some(n => typeof n !== 'string')) return null;
  for (const n of names) {
    const d = Object.getOwnPropertyDescriptor(v, n);
    if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) return null;
  }
  return names;
};
const keys = (v, expected) => {
  const names = ownNames(v);
  return names !== null && names.length === expected.length &&
    expected.every(n => Object.hasOwn(v, n));
};
const denseArray = (a, max) => {
  if (!Array.isArray(a) || Object.getPrototypeOf(a) !== Array.prototype ||
      a.length > max || Reflect.ownKeys(a).length !== a.length + 1) return false;
  for (let i = 0; i < a.length; i++) {
    const d = Object.getOwnPropertyDescriptor(a, String(i));
    if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) return false;
  }
  return true;
};
const eventKeys = ['revision', 'ordinal', 'kind', 'entity_id', 'entity_revision', 'payload'];

// Parsed JSON cannot contain cycles or aliases. Reject both, sharing a work
// budget across every event and comparison to avoid exponential DAG expansion.
function isJsonValue(v, budget, depth = 0) {
  if (depth > 16 || --budget.remaining < 0) return false;
  if (v === null) return true;
  // Fail closed on large wire integers: distinct JSON literals can round to
  // the same IEEE-754 Number and falsely satisfy ACK/delta equality.
  if (typeof v === 'number') return Number.isFinite(v) &&
    (!Number.isInteger(v) || Number.isSafeInteger(v));
  if (typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v !== 'object' || budget.seen.has(v)) return false;
  budget.seen.add(v);
  if (Array.isArray(v)) {
    if (!denseArray(v, 2048)) return false;
    for (let i = 0; i < v.length; i++) {
      if (!isJsonValue(v[i], budget, depth + 1)) return false;
    }
    return true;
  }
  const names = ownNames(v);
  if (names === null) return false;
  for (const n of names) if (!isJsonValue(v[n], budget, depth + 1)) return false;
  return true;
}

// Never dispatch .every() or an iterator supplied by an untrusted object.
function jsonEqual(a, b, budget, depth = 0) {
  if (depth > 16 || --budget.remaining < 0 || a === undefined || b === undefined) return false;
  if (a === null || b === null) return a === null && b === null;
  if (typeof a !== 'object' || typeof b !== 'object') {
    if (typeof a !== typeof b) return false;
    if (typeof a === 'number') return Number.isFinite(a) && a === b;
    if (typeof a === 'string' || typeof a === 'boolean') return a === b;
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (!denseArray(a, 2048) || !denseArray(b, 2048) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonEqual(a[i], b[i], budget, depth + 1)) return false;
    }
    return true;
  }
  const an = ownNames(a), bn = ownNames(b);
  if (an === null || bn === null || an.length !== bn.length) return false;
  for (const n of an) {
    if (!Object.hasOwn(b, n) || !jsonEqual(a[n], b[n], budget, depth + 1)) return false;
  }
  return true;
}

function validEvent(event, budget) {
  return keys(event, eventKeys) && integer(event.revision) && event.revision > 0 &&
    integer(event.ordinal) && kinds.has(event.kind) &&
    typeof event.entity_id === 'string' && uuid.test(event.entity_id) &&
    integer(event.entity_revision) && event.entity_revision > 0 &&
    event.payload !== null && typeof event.payload === 'object' &&
    !Array.isArray(event.payload) && isJsonValue(event.payload, budget);
}

// The comparison deliberately returns no "applied" proof. Only #67 authenticated
// session/receipt + trusted complete finance-state verification followed by #68
// atomic IDB persistence may create a durable applied proof.
function checkV1AckDeltaShapeInner(input = {}) {
  const budget = { remaining: 30000, seen: new WeakSet() };
  if (!keys(input, ['startCursor', 'pages', 'ack', 'mutationId'])) {
    return 'RECOVERY_HOLD';
  }
  const { startCursor, pages, ack, mutationId } = input;
  if (!integer(startCursor) || typeof mutationId !== 'string' || !uuid.test(mutationId) ||
      !denseArray(pages, 32) || pages.length < 1 ||
      !keys(ack, ['schema_version', 'client_mutation_id', 'revision', 'replayed', 'changes']) ||
      ack.schema_version !== 1 || ack.client_mutation_id !== mutationId ||
      !integer(ack.revision) || ack.revision <= startCursor ||
      typeof ack.replayed !== 'boolean' ||
      !denseArray(ack.changes, 2000) || ack.changes.length < 1) return 'RECOVERY_HOLD';

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
        !denseArray(page.changes, 2000) ||
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
    for (let j = 0; j < page.changes.length; j++) {
      const event = page.changes[j];
      if (!validEvent(event, budget) || event.revision <= expected ||
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
    if (!validEvent(change, budget) || change.revision !== ack.revision ||
        change.ordinal !== i || !jsonEqual(change, matchedEvents[i], budget)) {
      return 'RECOVERY_HOLD';
    }
  }
  return 'MATCHED_STRUCTURALLY';
}

// Security boundary: accept only raw JSON text from a transport or another
// trusted serialization boundary. An arbitrary JS object can contain Proxy
// traps that lie about validated fields or mutate between two reads. There is
// no cross-browser, side-effect-free Proxy detection for arbitrary objects.
// Never JSON.stringify an untrusted object and pass that text here: the
// conversion itself could execute getters. The contract accepts wire JSON.
// JSON.parse rounds some distinct finite wire number tokens to the same
// IEEE-754 value (100 vs 100.000000000000001, 0 vs 1e-400). Validate every
// number token before parse. Non-canonical but valid JSON holds by design:
// this isolated guard favors an explicit recovery over a false ACK match.
function canonicalNumberTokens(text) {
  let quoted = false, escaped = false;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      i++;
      continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let end = i + 1;
      while (end < text.length) {
        const c = text[end];
        if ((c >= '0' && c <= '9') || c === '.' || c === 'e' ||
            c === 'E' || c === '+' || c === '-') end++;
        else break;
      }
      const token = text.slice(i, end);
      const num = Number(token);
      if (!Number.isFinite(num) || JSON.stringify(num) !== token) return false;
      i = end;
      continue;
    }
    i++;
  }
  return !quoted;
}

const inertJsonParse = JSON.parse;
const MAX_INPUT_CODE_UNITS = 2_000_000;

export function checkV1AckDeltaShape(rawJson) {
  if (typeof rawJson !== 'string' || rawJson.length === 0 ||
      rawJson.length > MAX_INPUT_CODE_UNITS) return 'RECOVERY_HOLD';
  try {
    // JSON.parse returns fresh, ordinary data without Proxy, accessors,
    // aliases or arbitrary prototypes; no input object is read twice.
    if (!canonicalNumberTokens(rawJson)) return 'RECOVERY_HOLD';
    return checkV1AckDeltaShapeInner(inertJsonParse(rawJson));
  } catch {
    return 'RECOVERY_HOLD';
  }
}
