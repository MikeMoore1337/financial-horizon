import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Browser-level contract-shape regression only. Never touches the real PWA's
// IndexedDB, Service Worker, auth cookie, production API or feature flags.
const source = readFileSync(
  new URL('../../src/security/finance-v1-ack-delta-shape-guard.js', import.meta.url),
  'utf8'
);

test('v1 partial-page trap and replay ACK mismatch hold in Chromium and WebKit', async ({ page, context }) => {
  await context.route('**/__e2e_fh_v1_guard__.js', route => route.fulfill({
    status: 200, contentType: 'text/javascript', body: source,
    headers: { 'Cache-Control': 'no-store' },
  }));
  await page.goto('/__e2e__/ready');
  const check = async (mode) => page.evaluate(async ({ mode }) => {
    const { checkV1AckDeltaShape } = await import('/__e2e_fh_v1_guard__.js');
    const mutationId = '00000000-0000-4000-8000-0000000000a1';
    const entity_id = '00000000-0000-4000-8000-0000000000b1';
    const e = revision => ({ revision, ordinal: 0, kind: 'upsert',
      entity_id, entity_revision: 1, payload: { amount_minor: 100 } });
    const b = {
      startCursor: 3, mutationId,
      pages: [
        { schema_version: 1, from_revision: 3, to_revision: 5,
          next_since_revision: 4, has_more: true, changes: [e(4)] },
        { schema_version: 1, from_revision: 4, to_revision: 5,
          next_since_revision: 5, has_more: false, changes: [e(5)] },
      ],
      ack: { schema_version: 1, client_mutation_id: mutationId,
        revision: 4, replayed: true, changes: [e(4)] },
    };
    if (mode === 'truncated') b.pages.pop();
    if (mode === 'high-watermark') {
      b.pages[0].has_more = false;
      b.pages[0].next_since_revision = b.pages[0].to_revision;
      b.pages.pop();
    }
    if (mode === 'stale-cursor-event') b.pages[0].changes.unshift(e(3));
    if (mode === 'wrong-ack') b.ack.changes[0].payload.amount_minor = 101;
    if (mode === 'non-json-later') b.pages[1].changes[0].payload = { forged: Infinity };
    if (mode === 'date-in-ack') {
      b.ack.changes[0].payload = { forged: new Date(0) };
      b.pages[0].changes[0].payload = { forged: new Date(0) };
    }

    if (mode === 'foreign-uuid') {
      b.ack.client_mutation_id = '00000000-0000-4000-8000-0000000000ff';
    }
    if (['unsafe-integer-precision', 'fractional-precision', 'underflow-precision',
         'max-safe-fractional-precision'].includes(mode)) {
      const raw = JSON.stringify(b);
      const token = '"amount_minor":100';
      const variants = {
        'unsafe-integer-precision': ['9007199254740992', '9007199254740993'],
        'fractional-precision': ['100', '100.000000000000001'],
        'underflow-precision': ['0', '1e-400'],
        'max-safe-fractional-precision': ['9007199254740991', '9007199254740991.1'],
      };
      const [delta, ack] = variants[mode];
      const first = raw.replace(token, '"amount_minor":' + delta);
      const last = first.lastIndexOf(token);
      if (last < 0) throw new Error('missing ACK amount fixture');
      return checkV1AckDeltaShape(first.slice(0, last) +
        '"amount_minor":' + ack + first.slice(last + token.length));
    }
    // Only a raw JSON string can cross the verification boundary. Non-JSON
    // in-memory inputs must fail closed rather than be lossy-stringified.
    if (mode === 'non-json-later' || mode === 'date-in-ack') return checkV1AckDeltaShape(b);
    return checkV1AckDeltaShape(JSON.stringify(b));
  }, { mode });
  expect(await check('complete')).toBe('MATCHED_STRUCTURALLY');
  for (const mode of ['truncated', 'high-watermark', 'stale-cursor-event', 'wrong-ack', 'foreign-uuid', 'non-json-later', 'date-in-ack', 'unsafe-integer-precision',
                     'fractional-precision', 'underflow-precision',
                     'max-safe-fractional-precision']) {
    expect(await check(mode)).toBe('RECOVERY_HOLD');
  }
  await page.reload();
  expect(await check('truncated')).toBe('RECOVERY_HOLD');
  expect(await check('complete')).toBe('MATCHED_STRUCTURALLY');
});

test('inactive shape guard rejects forged ACK, iterator and exponential alias graph in Chromium/WebKit', async ({ page, context }) => {
  await context.route('**/__e2e_fh_v1_guard__.js', route => route.fulfill({
    status: 200, contentType: 'text/javascript', body: source,
    headers: { 'Cache-Control': 'no-store' },
  }));
  await page.goto('/__e2e__/ready');
  const decisions = await page.evaluate(async () => {
    const { checkV1AckDeltaShape: guard } = await import('/__e2e_fh_v1_guard__.js');
    const mutationId = '00000000-0000-4000-8000-0000000000a1';
    const entity_id = '00000000-0000-4000-8000-0000000000b1';
    const e = (revision, amount) => ({ revision, ordinal: 0, kind: 'upsert',
      entity_id, entity_revision: 1, payload: { values: [amount] } });
    const fixture = () => ({
      startCursor: 3, mutationId,
      pages: [
        { schema_version: 1, from_revision: 3, to_revision: 5,
          next_since_revision: 4, has_more: true, changes: [e(4, 1)] },
        { schema_version: 1, from_revision: 4, to_revision: 5,
          next_since_revision: 5, has_more: false, changes: [e(5, 2)] },
      ],
      ack: { schema_version: 1, client_mutation_id: mutationId, revision: 4,
        replayed: true, changes: [e(4, 1)] },
    });
    const good = guard(JSON.stringify(fixture()));
    const altered = fixture();
    altered.ack.changes[0].payload.values[0] = 999;
    const alteredWireDecision = guard(JSON.stringify(altered));
    const forged = fixture();
    const forgedValues = forged.ack.changes[0].payload.values;
    forgedValues[0] = 999;
    Object.setPrototypeOf(forgedValues, { every: () => true });
    const forgedDecision = guard(forged);
    const accessor = fixture();
    Object.defineProperty(accessor.ack, 'revision', {
      enumerable: true, get() { throw new Error('untrusted accessor'); },
    });
    const accessorDecision = guard(accessor);
    const iterator = fixture();
    Object.defineProperty(iterator.pages[0].changes, Symbol.iterator, {
      value: function* () { yield e(4, 1); },
    });
    const iteratorDecision = guard(iterator);
    const sparse = fixture();
    sparse.ack.changes = new Array(1);
    const sparseDecision = guard(sparse);
    const graph = fixture();
    let child = { amount_minor: 1 };
    for (let depth = 0; depth < 12; depth++) {
      const parent = {};
      for (let k = 0; k < 8; k++) parent['ref' + k] = child;
      child = parent;
    }
    graph.pages[1].changes[0].payload = child;
    const graphDecision = guard(graph);
    let traps = 0;
    const proxy = new Proxy(fixture(), {
      get() { traps++; throw new Error('untrusted proxy get'); },
      getPrototypeOf() { traps++; throw new Error('untrusted proxy prototype'); },
    });
    const proxyDecision = guard(proxy);
    return [good, alteredWireDecision, forgedDecision, accessorDecision, iteratorDecision,
      sparseDecision, graphDecision, proxyDecision, traps];
  });
  expect(decisions).toEqual([
    'MATCHED_STRUCTURALLY', 'RECOVERY_HOLD', 'RECOVERY_HOLD',
    'RECOVERY_HOLD', 'RECOVERY_HOLD', 'RECOVERY_HOLD',
    'RECOVERY_HOLD', 'RECOVERY_HOLD', 0,
  ]);
  await page.reload();
  expect(await page.evaluate(async () => {
    const { checkV1AckDeltaShape } = await import('/__e2e_fh_v1_guard__.js');
    return checkV1AckDeltaShape(null);
  })).toBe('RECOVERY_HOLD');
});
