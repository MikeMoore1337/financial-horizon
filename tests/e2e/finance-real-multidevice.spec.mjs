import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {test, expect} from '@playwright/test';
import {ORIGIN, observe, loginViaUi, view, logoutViaUi} from './helpers.mjs';

const month = '2026-11-12';
const testModules = {
  vault: '/__e2e_138_vault__.js', session: '/__e2e_138_session__.js',
  atomic: '/__e2e_138_atomic__.js', delta: '/__e2e_138_delta__.js',
  cache: '/__e2e_138_cache__.js', outbox: '/__e2e_138_outbox__.js',
};
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const compile = path => ts.transpileModule(source(path), {
  compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022},
}).outputText;
const testModuleSources = new Map([
  [testModules.vault, compile('../../src/security/local-vault.ts')],
  [testModules.session, compile('../../src/security/local-budget-session.ts')
    .replaceAll("'./local-vault.ts'", JSON.stringify(testModules.vault))],
  [testModules.atomic, compile('../../src/security/protected-atomic-candidate.ts')
    .replaceAll("'./local-vault.ts'", JSON.stringify(testModules.vault))],
  [testModules.delta, source('../../src/cloud/verified-delta-candidate.mjs')],
  [testModules.cache, source('../../src/cloud/encrypted-cloud-cache-candidate.mjs')
    .replaceAll("'../security/protected-atomic-candidate.ts'", JSON.stringify(testModules.atomic))
    .replaceAll("'./verified-delta-candidate.mjs'", JSON.stringify(testModules.delta))],
  [testModules.outbox, source('../../src/cloud/encrypted-command-outbox-candidate.mjs')
    .replaceAll("'../security/protected-atomic-candidate.ts'", JSON.stringify(testModules.atomic))
    .replaceAll("'./verified-delta-candidate.mjs'", JSON.stringify(testModules.delta))],
]);
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
  let proofPage;
  try {
    await context.route('**/__e2e_138_*.js', route => route.fulfill({
      status: 200, contentType: 'text/javascript',
      body: testModuleSources.get(new URL(route.request().url()).pathname),
      headers: {'Cache-Control': 'no-store'},
    }));
    // Load test-only modules before the app installs its root-scoped service
    // worker. WebKit may otherwise route those modules through that worker.
    proofPage = await context.newPage();
    await proofPage.goto('/__e2e__/ready');
    await proofPage.evaluate(async () => {
      await Promise.all([import('/__e2e_138_atomic__.js'), import('/__e2e_138_session__.js'),
        import('/__e2e_138_cache__.js'), import('/__e2e_138_outbox__.js')]);
    });
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
    await proofPage.evaluate(async ({ownerId, profile, snapshot, mutation, payload, versions}) => {
      const atomic = await import('/__e2e_138_atomic__.js');
      const {LocalBudgetSession} = await import('/__e2e_138_session__.js');
      const {initializeEncryptedCloudCacheCandidate} = await import('/__e2e_138_cache__.js');
      const outbox = await import('/__e2e_138_outbox__.js');
      const scope = 'account:' + ownerId;
      const passphrase = 'synthetic isolated payment test';
      await atomic.createAtomicEncryptedCandidate(scope, passphrase,
        {snapshot: {version: 2, revision: 0}, outbox: [], conflicts: []}, 2);
      const session = new LocalBudgetSession(); session.selectScope(scope);
      await session.unlock(await atomic.getAtomicEncryptedKeyset(scope), {passphrase});
      const identity = {scope, profileId: profile, generation: session.lifecycleVersion,
        epoch: 'e'.repeat(32), signal: session.lifecycleSignal};
      await initializeEncryptedCloudCacheCandidate({scope, session, identity,
        pages: [{cursorSent: null, body: snapshot.body}], expectedEpoch: 0,
        confirmedAccountCacheInitialization: true});
      const command = {schema_version: 2, client_mutation_id: mutation,
        base_revision: snapshot.revision, action: 'settlement.payment.record',
        expected_entity_revisions: versions, payload};
      const queued = await outbox.enqueueEncryptedFinanceCommandCandidate({
        scope, session, identity, command, ifMatch: snapshot.etag, expectedEpoch: 1});
      if (queued.status !== 'QUEUED_ENCRYPTED') throw Error('Payment was not queued');
      globalThis.__fh138Proof = {scope, session, identity, outbox, atomic};
    }, {ownerId: owner.id, profile: profileA, snapshot: beforePayment,
      mutation: paymentMutation, payload: paymentPayload, versions: paymentVersions});
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
    const paymentDeltaResponse = await context.request.get(
      ORIGIN + '/api/finance/v1/changes?since_revision=' + beforePayment.revision + '&limit_revisions=1');
    expect(paymentDeltaResponse.status()).toBe(200);
    const paymentProof = await proofPage.evaluate(async ({receipt, deltaPage}) => {
      const p = globalThis.__fh138Proof;
      return p.outbox.persistAuthenticatedFinanceReceiptCandidate({
        scope: p.scope, session: p.session, identity: p.identity, expectedEpoch: 2,
        receipt, deltaPage, commandHttpStatus: 200, deltaHttpStatus: 200});
    }, {receipt: await paymentReplayResponse.json(), deltaPage: await paymentDeltaResponse.json()});
    expect(paymentProof.status).toBe('DURABLY_CONFIRMED');

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
    await proofPage.evaluate(async ({snapshot, mutation, payload, versions}) => {
      const p = globalThis.__fh138Proof;
      const command = {schema_version: 2, client_mutation_id: mutation,
        base_revision: snapshot.revision, action: 'settlement.payment.void',
        expected_entity_revisions: versions, payload};
      const queued = await p.outbox.enqueueEncryptedFinanceCommandCandidate({
        scope: p.scope, session: p.session, identity: p.identity, command,
        ifMatch: snapshot.etag, expectedEpoch: 3});
      if (queued.status !== 'QUEUED_ENCRYPTED') throw Error('Reversal was not queued');
    }, {snapshot: afterPayment, mutation: voidMutation, payload: voidPayload, versions: voidVersions});
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
    const voidDeltaResponse = await context.request.get(
      ORIGIN + '/api/finance/v1/changes?since_revision=' + afterPayment.revision + '&limit_revisions=1');
    expect(voidDeltaResponse.status()).toBe(200);
    const reversalProof = await proofPage.evaluate(async ({receipt, deltaPage}) => {
      const p = globalThis.__fh138Proof;
      const result = await p.outbox.persistAuthenticatedFinanceReceiptCandidate({
        scope: p.scope, session: p.session, identity: p.identity, expectedEpoch: 4,
        receipt, deltaPage, commandHttpStatus: 200, deltaHttpStatus: 200});
      const stored = await p.atomic.readAtomicEncryptedCandidate(p.scope, p.session);
      return {status: result.status, pending: stored.outbox.length,
        balance: stored.snapshot.cloudFinance.entities.find(e => e.id === receipt.changes[0].payload.accounts[0].id).data.balance_minor};
    }, {receipt: await voidReplayResponse.json(), deltaPage: await voidDeltaResponse.json()});
    expect(reversalProof).toEqual({status: 'DURABLY_CONFIRMED', pending: 0, balance: 100_000});

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

    // A reserve-linked payment and reversal must each reconcile their real
    // PostgreSQL receipt, complete delta, cash balance and allocation once.
    const reserveId = randomUUID();
    const reserveCreated = await submit(context, afterVoid, 'reserve.create', {
      id: reserveId, obligation_id: obligationId, account_id: firstId,
      title: 'Синтетический резерв', target_minor: 5500, opened_on: '2026-10-12',
      first_due_on: month, period_months: 1, due_day: 12,
      contribution_mode: 'auto', opening_reserved_minor: 3000,
    }, {[firstId]: versionOf(afterVoid, firstId), [obligationId]: versionOf(afterVoid, obligationId)});
    expect(reserveCreated.status()).toBe(201);
    const reserveState = await state(context);
    const reserveDelta = await context.request.get(
      ORIGIN + '/api/finance/v1/changes?since_revision=' + afterVoid.revision + '&limit_revisions=1');
    expect(reserveDelta.status()).toBe(200);
    const cachedReserve = await proofPage.evaluate(async page => {
      const p = globalThis.__fh138Proof;
      const {persistEncryptedCloudDeltaCandidate} = await import('/__e2e_138_cache__.js');
      return persistEncryptedCloudDeltaCandidate({scope: p.scope, session: p.session,
        identity: p.identity, expectedEpoch: 5, page});
    }, await reserveDelta.json());
    expect(cachedReserve.status).toBe('ENCRYPTED_DELTA_SAVED');
    const reservePayment = {account_id: firstId, obligation_id: obligationId,
      amount_minor: 2000, paid_on: month, occurrence_on: month,
      reserve_id: reserveId, reserved_used_minor: 1500};
    const reserveVersions = {[firstId]: versionOf(reserveState, firstId),
      [obligationId]: versionOf(reserveState, obligationId), [reserveId]: versionOf(reserveState, reserveId)};
    const reserveMutation = randomUUID();
    await proofPage.evaluate(async ({snapshot, payload, versions, mutation}) => {
      const p = globalThis.__fh138Proof;
      const command = {schema_version: 2, client_mutation_id: mutation, base_revision: snapshot.revision,
        action: 'settlement.payment.record', expected_entity_revisions: versions, payload};
      await p.outbox.enqueueEncryptedFinanceCommandCandidate({scope: p.scope, session: p.session,
        identity: p.identity, command, ifMatch: snapshot.etag, expectedEpoch: 6});
    }, {snapshot: reserveState, payload: reservePayment, versions: reserveVersions, mutation: reserveMutation});
    expect((await submit(context, reserveState, 'settlement.payment.record', reservePayment,
      reserveVersions, 2, reserveMutation)).status()).toBe(201);
    const reserveReplay = await submit(context, reserveState, 'settlement.payment.record',
      reservePayment, reserveVersions, 2, reserveMutation);
    expect(reserveReplay.status()).toBe(200);
    const reserveReceipt = await reserveReplay.json();
    const reservePayDelta = await context.request.get(
      ORIGIN + '/api/finance/v1/changes?since_revision=' + reserveState.revision + '&limit_revisions=1');
    expect(reservePayDelta.status()).toBe(200);
    const reserveProof = await proofPage.evaluate(async ({receipt, deltaPage}) => {
      const p = globalThis.__fh138Proof;
      return p.outbox.persistAuthenticatedFinanceReceiptCandidate({scope: p.scope, session: p.session,
        identity: p.identity, expectedEpoch: 7, receipt, deltaPage, commandHttpStatus: 200, deltaHttpStatus: 200});
    }, {receipt: reserveReceipt, deltaPage: await reservePayDelta.json()});
    expect(reserveProof.status).toBe('DURABLY_CONFIRMED');
    const afterReservePayment = await state(second);
    expect(entity(afterReservePayment, firstId).data.balance_minor).toBe(98_000);
    expect(entity(afterReservePayment, firstId).data.reserved_minor).toBe(1500);
    const reserveVoid = {account_id: firstId, transaction_id: reserveReceipt.changes[0].entity_id,
      fact_id: reserveReceipt.changes[1].entity_id, reserve_id: reserveId, reason: 'Отмена резервной оплаты'};
    const reserveVoidVersions = Object.fromEntries([firstId, reserveVoid.transaction_id, reserveVoid.fact_id, reserveId]
      .map(id => [id, versionOf(afterReservePayment, id)]));
    const reserveVoidMutation = randomUUID();
    await proofPage.evaluate(async ({snapshot, payload, versions, mutation}) => {
      const p = globalThis.__fh138Proof;
      const command = {schema_version: 2, client_mutation_id: mutation, base_revision: snapshot.revision,
        action: 'settlement.payment.void', expected_entity_revisions: versions, payload};
      await p.outbox.enqueueEncryptedFinanceCommandCandidate({scope: p.scope, session: p.session,
        identity: p.identity, command, ifMatch: snapshot.etag, expectedEpoch: 8});
    }, {snapshot: afterReservePayment, payload: reserveVoid, versions: reserveVoidVersions, mutation: reserveVoidMutation});
    expect((await submit(second, afterReservePayment, 'settlement.payment.void', reserveVoid,
      reserveVoidVersions, 2, reserveVoidMutation)).status()).toBe(201);
    const reserveVoidReplay = await submit(second, afterReservePayment, 'settlement.payment.void',
      reserveVoid, reserveVoidVersions, 2, reserveVoidMutation);
    expect(reserveVoidReplay.status()).toBe(200);
    const reserveVoidDelta = await context.request.get(
      ORIGIN + '/api/finance/v1/changes?since_revision=' + afterReservePayment.revision + '&limit_revisions=1');
    expect(reserveVoidDelta.status()).toBe(200);
    const reserveVoidProof = await proofPage.evaluate(async ({receipt, deltaPage}) => {
      const p = globalThis.__fh138Proof;
      const result = await p.outbox.persistAuthenticatedFinanceReceiptCandidate({scope: p.scope, session: p.session,
        identity: p.identity, expectedEpoch: 9, receipt, deltaPage, commandHttpStatus: 200, deltaHttpStatus: 200});
      const data = await p.atomic.readAtomicEncryptedCandidate(p.scope, p.session);
      p.session.logout();
      return {status: result.status, pending: data.outbox.length};
    }, {receipt: await reserveVoidReplay.json(), deltaPage: await reserveVoidDelta.json()});
    expect(reserveVoidProof).toEqual({status: 'DURABLY_CONFIRMED', pending: 0});
    const afterReserveVoid = await state(context);
    expect(entity(afterReserveVoid, firstId).data.balance_minor).toBe(100_000);
    expect(entity(afterReserveVoid, firstId).data.reserved_minor).toBe(3000);
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
    expect(ownerAfterIntrusion.revision).toBe(afterReserveVoid.revision);
    expect(entity(ownerAfterIntrusion, firstId).data.name).toBe('Счёт А');

    await logoutViaUi(page);
    const denied = await context.request.get(ORIGIN + '/api/finance/v1/state');
    expect(denied.status()).toBe(401);
    expect((await state(second)).revision).toBe(afterReserveVoid.revision);
    ownerWatch.assertClean(); secondWatch.assertClean(); thirdWatch.assertClean();
  } finally {
    await proofPage?.close();
    await second.close();
    await third.close();
  }
});


test('#38 real PostgreSQL + FH cookies: authenticated CSV bank import, replay and undo across devices', async ({page, context, browser}) => {
  test.setTimeout(180_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  const second = await browser.newContext();
  const secondPage = await second.newPage();
  const observeFirst = await observe(context,page);
  const observeSecond = await observe(second,secondPage);
  try {
    const created = await context.request.post('/__e2e__/personal-session');
    expect(created.status()).toBe(200);
    const owner = (await created.json()).user;
    await page.goto('/');
    await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
    await bootstrap(context);
    const accountA = randomUUID(), accountB = randomUUID();
    let current = await state(context);
    expect((await submit(context,current,'account.create',{
      id: accountA,name:'Тестовая карта',kind:'bank',
      currency:'RUB',opening_minor:30000,
    })).status()).toBe(201);
    current = await state(context);
    expect((await submit(context,current,'account.create',{
      id: accountB,name:'Копилка',kind:'savings',
      currency:'RUB',opening_minor:10000,
    })).status()).toBe(201);
    const before = await state(context);
    expect(before.revision).toBe(2);
    await view(page,'settings');
    await page.locator('[data-settings-card="bank-statement-import"] [data-view="bank-import"]').click();
    await expect(page.locator('#toolbar-title')).toHaveText('Импорт выписки');
    await expect(page.locator('.fh-bank-screen')).toBeVisible();
    const csv = [
      'Дата;Сумма;Описание;Счёт;Счёт назначения;Тип;ID',
      '07.11.2026;125,00;Синтетический возврат;Тестовая карта;;доход;BANK-E2E-IN',
      '08.11.2026;-25,50;Синтетическая покупка;Тестовая карта;;расход;BANK-E2E-OUT',
      '09.11.2026;-80,00;Синтетический перевод;Тестовая карта;Копилка;перевод;BANK-E2E-TRANSFER',
      '',
    ].join('\n');
    const synthetic = {
      name:'bank-synthetic-#38.csv',mimeType:'text/csv',buffer:Buffer.from(csv,'utf8'),
    };
    await page.locator('.fh-bank-file input[type="file"]').setInputFiles(synthetic);
    await expect(page.locator('.fh-bank-table tbody tr')).toHaveCount(3);
    const send = page.getByRole('button',{name:/Подтвердить импорт 3 операций/});
    await expect(send).toBeEnabled();
    await send.click();
    await expect(page.getByText('Импорт подтверждён: 3 операций')).toBeVisible();
    const posted = await state(context);
    expect(posted.revision).toBe(before.revision+1);
    expect(entity(posted,accountA).data.balance_minor).toBe(31950);
    expect(entity(posted,accountB).data.balance_minor).toBe(18000);
    const tx = posted.body.entities.filter(e => e.kind === 'transaction');
    expect(tx).toHaveLength(3);
    const transfer = tx.find(t=>t.data.kind==='transfer');
    expect(transfer.data.postings).toHaveLength(2);
    expect(transfer.data.postings.reduce((sum,p)=>sum+p.signed_minor,0)).toBe(0);

    // Another real browser with the same FH owner must see committed SQL money
    // without a bank-file POST, a client-side fabricated balance or a duplicate.
    await loginViaUi(secondPage,owner.email);
    await bootstrap(second);
    const other = await state(second);
    expect(other.revision).toBe(posted.revision);
    expect(entity(other,accountA).data.balance_minor).toBe(31950);
    await view(secondPage,'settings');
    await secondPage.locator('[data-settings-card="bank-statement-import"] [data-view="bank-import"]').click();
    await secondPage.locator('.fh-bank-file input[type="file"]').setInputFiles(synthetic);
    await expect(secondPage.locator('.fh-bank-table tbody tr')).toHaveCount(3);
    await expect(secondPage.getByRole('button',{name:/Подтвердить импорт 0 операций/})).toBeDisabled();
    expect((await state(second)).revision).toBe(posted.revision);

    page.once('dialog',dialog=>dialog.accept());
    const history = page.locator('#fh-bank-history');
    await expect(history.getByRole('button',{name:'Отменить'})).toBeVisible();
    await history.getByRole('button',{name:'Отменить'}).click();
    await expect(page.getByText('Отмена партии подтверждена')).toBeVisible();
    const reversed = await state(context);
    expect(reversed.revision).toBe(posted.revision+1);
    expect(entity(reversed,accountA).data.balance_minor).toBe(30000);
    expect(entity(reversed,accountB).data.balance_minor).toBe(10000);
    expect(reversed.body.entities.filter(e=>e.kind==='transaction')).toHaveLength(6);
    await expect(page.locator('#fh-bank-history')).toContainText('Отменено');
    const latest = await state(second);
    expect(latest.revision).toBe(reversed.revision);
    expect(entity(latest,accountB).data.balance_minor).toBe(10000);
    observeFirst.assertClean();observeSecond.assertClean();
  } finally {
    await second.close();
  }
});
