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
    if (mode === 'foreign-uuid') {
      b.ack.client_mutation_id = '00000000-0000-4000-8000-0000000000ff';
    }
    return checkV1AckDeltaShape(b);
  }, { mode });
  expect(await check('complete')).toBe('MATCHED_STRUCTURALLY');
  for (const mode of ['truncated', 'high-watermark', 'stale-cursor-event', 'wrong-ack', 'foreign-uuid']) {
    expect(await check(mode)).toBe('RECOVERY_HOLD');
  }
  await page.reload();
  expect(await check('truncated')).toBe('RECOVERY_HOLD');
  expect(await check('complete')).toBe('MATCHED_STRUCTURALLY');
});
