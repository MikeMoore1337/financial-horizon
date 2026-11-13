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
async function submit(context, snapshot, action, payload, versions = {}, version = 2, mutation = randomUUID()) {
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
function versionOf(snapshot, id) {
  const found = snapshot.body.entities.find(e => e.id === id);
  expect(found, 'Referenced financial entity must exist').toBeTruthy();
  return found.entity_revision;
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
      id: firstId, name: 'Счёт А', kind: 'bank', currency: 'RUB', opening_minor: 200_000,
    });
    expect(first.status()).toBe(201);
    expect((await first.json()).replayed).toBe(false);
    const afterFirst = await state(second);
    expect(afterFirst.revision).toBe(1);
    expect(entity(afterFirst, firstId).data.balance_minor).toBe(200_000);

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
    // Exactly 1000 RUB: the transfer changes two accounts, not total assets.
    const transferPayload = {
      from_account_id: firstId, to_account_id: secondId,
      amount_minor: 100_000, occurred_on: month,
    };
    const transferMutation = randomUUID();
    const completed = await submit(
      context, serverOwner, 'account.transfer', transferPayload, versions, 1, transferMutation,
    );
    expect(completed.status()).toBe(201);
    const committedTransfer = await completed.json();
    expect(committedTransfer.replayed).toBe(false);
    const transferredAgain = await submit(
      context, serverOwner, 'account.transfer', transferPayload, versions, 1, transferMutation,
    );
    expect(transferredAgain.status()).toBe(200);
    const transferReplay = await transferredAgain.json();
    expect(transferReplay.replayed).toBe(true);
    expect(transferReplay.revision).toBe(committedTransfer.revision);

    // Second device must not silently overwrite that committed transfer.
    const rejected = await submit(second, staleDevice, 'account.transfer', {
      from_account_id: firstId, to_account_id: secondId,
      amount_minor: 3_000, occurred_on: month,
    }, versions, 1);
    expect(rejected.status()).toBe(412);

    const final = await state(second);
    expect(final.revision).toBe(3);
    expect(entity(final, firstId).data.balance_minor).toBe(100_000);
    expect(entity(final, secondId).data.balance_minor).toBe(100_000);
    expect(final.body.entities.filter(e => e.kind === 'transaction')).toHaveLength(1);
    const sum = final.body.entities.filter(e => e.kind === 'account')
      .reduce((total, row) => total + row.data.balance_minor, 0);
    expect(sum).toBe(200_000);

    // #33/#70: planned obligations do not debit cash; one settled payment
    // debits exactly once and its atomic void restores the same amount.
    const planned = await submit(second, final, 'obligation.create', {
      title: 'Синтетическая проверка оплаты', direction: 'expense',
      amount_minor: 5_500, starts_on: month, timezone: 'Europe/Moscow',
      recurrence_unit: 'none', recurrence_every: 1,
    }, {}, 1);
    expect(planned.status()).toBe(201);
    const planReceipt = await planned.json();
    expect(planReceipt.changes).toHaveLength(1);
    const obligationId = planReceipt.changes[0].entity_id;
    const beforePayment = await state(context);
    expect(beforePayment.revision).toBe(final.revision + 1);
    expect(entity(beforePayment, firstId).data.balance_minor).toBe(100_000);

    const paymentPayload = {
      obligation_id: obligationId, account_id: firstId,
      amount_minor: 5_500, paid_on: month, occurrence_on: month,
    };
    const paymentVersions = {
      [firstId]: versionOf(beforePayment, firstId),
      [obligationId]: versionOf(beforePayment, obligationId),
    };
    const paymentMutation = randomUUID();
    const paid = await submit(
      context, beforePayment, 'settlement.payment.record', paymentPayload,
      paymentVersions, 2, paymentMutation,
    );
    expect(paid.status()).toBe(201);
    const paidReceipt = await paid.json();
    expect(paidReceipt.changes).toHaveLength(2);
    const transactionId = paidReceipt.changes[0].entity_id;
    const factId = paidReceipt.changes[1].entity_id;
    const paymentReplayResponse = await submit(
      context, beforePayment, 'settlement.payment.record', paymentPayload,
      paymentVersions, 2, paymentMutation,
    );
    expect(paymentReplayResponse.status()).toBe(200);
    expect((await paymentReplayResponse.json()).replayed).toBe(true);

    const afterPayment = await state(second);
    expect(afterPayment.revision).toBe(beforePayment.revision + 1);
    expect(entity(afterPayment, firstId).data.balance_minor).toBe(94_500);
    expect(entity(afterPayment, secondId).data.balance_minor).toBe(100_000);
    const voidPayload = {
      transaction_id: transactionId, fact_id: factId,
      account_id: firstId, reason: 'Отмена тестовой оплаты',
    };
    const voidVersions = {
      [firstId]: versionOf(afterPayment, firstId),
      [transactionId]: versionOf(afterPayment, transactionId),
      [factId]: versionOf(afterPayment, factId),
    };
    const voidMutation = randomUUID();
    const voided = await submit(
      second, afterPayment, 'settlement.payment.void', voidPayload,
      voidVersions, 2, voidMutation,
    );
    expect(voided.status()).toBe(201);
    const voidReceipt = await voided.json();
    expect(voidReceipt.changes).toHaveLength(2);
    expect(voidReceipt.changes[0].payload.reversed_transaction_id).toBe(transactionId);
    const voidReplayResponse = await submit(
      second, afterPayment, 'settlement.payment.void', voidPayload,
      voidVersions, 2, voidMutation,
    );
    expect(voidReplayResponse.status()).toBe(200);
    expect((await voidReplayResponse.json()).replayed).toBe(true);

    const afterVoid = await state(context);
    expect(afterVoid.revision).toBe(afterPayment.revision + 1);
    expect(entity(afterVoid, firstId).data.balance_minor).toBe(100_000);
    expect(entity(afterVoid, secondId).data.balance_minor).toBe(100_000);
    const fact = afterVoid.body.entities.find(e => e.id === factId);
    expect(fact?.data?.voided_at).toBeTruthy();
    const rejectedSecondVoid = await submit(
      context, afterVoid, 'settlement.payment.void', voidPayload,
      {
        [firstId]: versionOf(afterVoid, firstId),
        [transactionId]: versionOf(afterVoid, transactionId),
        [factId]: versionOf(afterVoid, factId),
      },
    );
    expect(rejectedSecondVoid.status()).toBe(409);
    expect((await state(second)).revision).toBe(afterVoid.revision);
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
    // An authenticated but unrelated FH identity may not alter another
    // profile's account even with the real account UUID and revision.
    const crossProfileWrite = await submit(third, stranger, 'account.update', {
      account_id: firstId, name: 'Чужая правка', kind: 'cash',
    }, {[firstId]: versionOf(afterVoid, firstId)});
    expect(crossProfileWrite.status()).toBe(409);
    const ownerAfterIntrusion = await state(second);
    expect(ownerAfterIntrusion.revision).toBe(afterVoid.revision);
    expect(entity(ownerAfterIntrusion, firstId).data.name).toBe('Счёт А');

    await logoutViaUi(page);
    const denied = await context.request.get(ORIGIN + '/api/finance/v1/state');
    expect(denied.status()).toBe(401);
    expect((await state(second)).revision).toBe(afterVoid.revision);
    ownerWatch.assertClean(); secondWatch.assertClean(); thirdWatch.assertClean();
  } finally {
    await second.close();
    await third.close();
  }
});
