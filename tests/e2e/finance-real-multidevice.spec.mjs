import {randomUUID} from 'node:crypto';
import {test, expect} from '@playwright/test';
import {ORIGIN, observe, loginViaUi, view, logoutViaUi} from './helpers.mjs';

const month = '2026-11-12';
async function state(context) {
  const response = await context.request.get(ORIGIN + '/api/finance/v1/state?limit_entities=5000');
  expect(response.status(), 'Only the signed-in owner may read the live SQL snapshot').toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');
  return {
    revision: (await response.json()).revision,
    body: await response.json(),
    etag: response.headers()['etag'],
  };
}
async function submit(context, snapshot, action, payload, versions = {}, version = 2) {
  const mutation = randomUUID();
  const response = await context.request.post(ORIGIN + '/api/finance/v' + version + '/commands', {
    headers: {
      'Origin': ORIGIN, 'Content-Type': 'application/json',
      'If-Match': snapshot.etag, 'Idempotency-Key': mutation,
    },
    data: {
      schema_version: version, client_mutation_id: mutation,
      base_revision: snapshot.revision, action,
      expected_entity_revisions: versions, payload,
    },
  });
  return response;
}
function entity(snapshot, id) {
  const found = snapshot.body.entities.find(e => e.id === id && e.kind === 'account');
  expect(found, 'Requested entity must exist in authenticated full state').toBeTruthy();
  return found;
}
async function bootstrap(context) {
  const r = await context.request.post(ORIGIN + '/api/auth/email/finance/session', {
    headers: {'Origin': ORIGIN, 'Content-Type': 'application/json'}, data: {},
  });
  expect(r.status(), 'Authenticated finance bootstrap').toBe(200);
  return (await r.json()).profile_id;
}
async function openAccounts(page) {
  await view(page, 'settings');
  await page.locator('[data-settings-card="finance-accounts"] [data-view="accounts-connected"]').click();
  await expect(page.locator('#toolbar-title')).toHaveText('Счета и кошельки');
  await expect(page.locator('.fh-accounts-total')).toBeVisible();
}

test('#68 true FH SQLite + PostgreSQL: two browser devices converge on money and reject stale commands', async ({page, context, browser}) => {
  test.setTimeout(180_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  const second = await browser.newContext();
  const third = await browser.newContext();
  const ownerWatch = await observe(context, page);
  const p2 = await second.newPage();
  const secondWatch = await observe(second, p2);
  const p3 = await third.newPage();
  const thirdWatch = await observe(third, p3);
  try {
    const created = await context.request.post('/__e2e__/personal-session');
    expect(created.status()).toBe(200);
    const owner = (await created.json()).user;
    expect(owner.id).toMatch(/^[a-f0-9]{32}$/);
    await page.goto('/');
    await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
    await loginViaUi(p2, owner.email);
    const profileA = await bootstrap(context);
    const profileB = await bootstrap(second);
    expect(profileA).toBe(profileB);

    await openAccounts(page);
    await openAccounts(p2);
    await expect(page.locator('.fh-accounts-total')).toContainText('Всего на счетах');
    await expect(p2.locator('.fh-accounts-total')).toContainText('Всего на счетах');
    const initial = await state(context);
    expect(initial.revision).toBe(0);
    expect(initial.body.entities).toEqual([]);

    const firstId = randomUUID(), secondId = randomUUID();
    const first = await submit(context, initial, 'account.create', {
      id: firstId, name: 'Счёт А', kind: 'bank', currency: 'RUB', opening_minor: 100_000,
    });
    expect(first.status()).toBe(201);
    expect((await first.json()).replayed).toBe(false);
    const afterFirst = await state(second);
    expect(afterFirst.revision).toBe(1);
    expect(entity(afterFirst, firstId).data.balance_minor).toBe(100_000);

    const next = await submit(second, afterFirst, 'account.create', {
      id: secondId, name: 'Счёт Б', kind: 'savings', currency: 'RUB', opening_minor: 0,
    });
    expect(next.status()).toBe(201);
    const staleDevice = await state(second);
    const serverOwner = await state(context);
    expect(staleDevice.revision).toBe(2);
    expect(serverOwner.revision).toBe(2);
    const versions = {
      [firstId]: entity(serverOwner, firstId).entity_revision,
      [secondId]: entity(serverOwner, secondId).entity_revision,
    };
    const completed = await submit(context, serverOwner, 'account.transfer', {
      from_account_id: firstId, to_account_id: secondId,
      amount_minor: 10_000, occurred_on: month,
    }, versions, 1);
    expect(completed.status()).toBe(201);

    // Second device must not silently overwrite that committed transfer.
    const rejected = await submit(second, staleDevice, 'account.transfer', {
      from_account_id: firstId, to_account_id: secondId,
      amount_minor: 3_000, occurred_on: month,
    }, versions, 1);
    expect(rejected.status()).toBe(412);

    const final = await state(second);
    expect(final.revision).toBe(3);
    expect(entity(final, firstId).data.balance_minor).toBe(90_000);
    expect(entity(final, secondId).data.balance_minor).toBe(10_000);
    expect(final.body.entities.filter(e => e.kind === 'transaction')).toHaveLength(1);
    const sum = final.body.entities.filter(e => e.kind === 'account')
      .reduce((total, row) => total + row.data.balance_minor, 0);
    expect(sum).toBe(100_000);
    // Refresh the actual React screen, which must derive values from SQL.
    await p2.getByRole('button', {name: /К обзору/}).click();
    await openAccounts(p2);
    await expect(p2.locator('.fh-account-card').filter({hasText: 'Счёт А'})).toBeVisible();
    await expect(p2.locator('.fh-account-card').filter({hasText: 'Счёт Б'})).toBeVisible();

    // A third unrelated authenticated user has a separate profile and cannot
    // observe or mutate the owner's money.
    const other = await third.request.post('/__e2e__/personal-session');
    expect(other.status()).toBe(200);
    const strangerProfile = await bootstrap(third);
    expect(strangerProfile).not.toBe(profileA);
    const stranger = await state(third);
    expect(stranger.body.entities).toEqual([]);

    await logoutViaUi(page);
    const denied = await context.request.get(ORIGIN + '/api/finance/v1/state');
    expect(denied.status()).toBe(401);
    expect((await state(second)).revision).toBe(3);
    ownerWatch.assertClean(); secondWatch.assertClean(); thirdWatch.assertClean();
  } finally {
    await second.close();
    await third.close();
  }
});
