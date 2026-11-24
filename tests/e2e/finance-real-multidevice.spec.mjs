import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {test, expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {ORIGIN, observe, loginViaUi, view, logoutViaUi, visitGuest, addEntry, scopedState} from './helpers.mjs';

const month = '2026-11-12';
const testModules = {
  vault: '/__e2e_138_vault__.js', session: '/__e2e_138_session__.js',
  atomic: '/__e2e_138_atomic__.js', delta: '/__e2e_138_delta__.js',
  cache: '/__e2e_138_cache__.js', outbox: '/__e2e_138_outbox__.js',
  pull: '/__e2e_138_pull__.js', dispatch: '/__e2e_138_dispatch__.js',
  controller: '/__e2e_138_controller__.js',
  hint: '/__e2e_138_hint__.js',
};
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const compile = path => ts.transpileModule(source(path), {
  compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022},
}).outputText;
const testModuleSources = new Map([
  [testModules.hint, source('../../src/cloud/offline-access-hint.mjs')],
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
  [testModules.pull, source('../../src/cloud/authenticated-snapshot-pull-candidate.mjs')
    .replaceAll("'./verified-delta-candidate.mjs'", JSON.stringify(testModules.delta))],
  [testModules.dispatch, source('../../src/cloud/finance-offline-dispatch-candidate.mjs')
    .replaceAll("'../security/protected-atomic-candidate.ts'", JSON.stringify(testModules.atomic))
    .replaceAll("'./encrypted-command-outbox-candidate.mjs'", JSON.stringify(testModules.outbox))],
  [testModules.controller, source('../../src/cloud/finance-sync-controller.mjs')
    .replaceAll("'../security/local-budget-session.ts'", JSON.stringify(testModules.session))
    .replaceAll("'../security/protected-atomic-candidate.ts'", JSON.stringify(testModules.atomic))
    .replaceAll("'./authenticated-snapshot-pull-candidate.mjs'", JSON.stringify(testModules.pull))
    .replaceAll("'./encrypted-cloud-cache-candidate.mjs'", JSON.stringify(testModules.cache))
    .replaceAll("'./encrypted-command-outbox-candidate.mjs'", JSON.stringify(testModules.outbox))
    .replaceAll("'./offline-access-hint.mjs'", JSON.stringify(testModules.hint))
    .replaceAll("'./finance-offline-dispatch-candidate.mjs'", JSON.stringify(testModules.dispatch))],
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
  await expect(page.locator('#main .fh-accounts-total')).toBeVisible();
}

test('#68 sync controls remain accessible in both themes and responsive widths', async ({page, context}, testInfo) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  expect((await context.request.post('/__e2e__/personal-session')).status()).toBe(200);
  await bootstrap(context);
  const initial = await state(context);
  expect((await submit(context, initial, 'account.create', {id:randomUUID(),
    name:'Synthetic accessibility account', kind:'cash', currency:'RUB', opening_minor:500})).status()).toBe(201);
  await page.goto('/');
  await openAccounts(page);
  await page.screenshot({path:testInfo.outputPath('accounts-before.png'), fullPage:true});
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  await page.getByLabel('Парольная фраза', {exact:true}).fill('synthetic accessibility passphrase');
  await page.getByRole('button', {name:'Создать копию'}).click();
  await page.getByLabel('Я сохранил ключ вне браузера').check();
  await page.getByRole('button', {name:'Разблокировать'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible();
  await page.getByText('Записать доход или расход').click();
  await page.getByText('Создать резерв', {exact:true}).click();
  await page.getByText('Завершить или восстановить цикл резерва').click();
  await page.getByText('Отменить событие резерва').click();
  await page.getByText('Отметить пропущенный взнос').click();
  await page.getByText('Изменить название или цель резерва').click();
  await page.getByText('Пополнить или освободить резерв').click();
  await page.getByText('Создать обязательство', {exact:true}).click();
  await page.getByText('Записать оплату обязательства').click();
  await page.getByText('Записать платёж по кредиту').click();
  await page.getByText('Отменить подтверждённую операцию').click();
  for (const width of [320, 1280]) {
    await page.setViewportSize({width, height:900});
    for (const theme of ['light', 'dark']) {
      if (await page.locator('body').getAttribute('data-theme') !== theme) {
        await page.locator('#theme-toggle').click();
      }
      const report = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
      expect(report.violations.map(item => ({rule:item.id, targets:item.nodes.map(node => node.target)})),
        `sync controls ${width}px ${theme}`).toEqual([]);
      const size = await page.evaluate(() => ({width:document.documentElement.clientWidth,
        scroll:Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        overflowing:[...document.querySelectorAll('body *')].filter(element => {
          const rect=element.getBoundingClientRect();
          return rect.width && rect.right > document.documentElement.clientWidth + 1;
        }).slice(0, 12).map(element => ({tag:element.tagName, className:element.className?.baseVal || element.className}))}));
      expect(size.scroll, JSON.stringify(size.overflowing)).toBeLessThanOrEqual(size.width + 1);
      await page.screenshot({path:testInfo.outputPath(`sync-${width}-${theme}.png`), fullPage:true});
    }
  }
  // Different platform fonts or enlarged text must not overflow long actions.
  await page.setViewportSize({width:320, height:900});
  await page.addStyleTag({content:'.fh-sync button { font-size: 20px; }'});
  const enlarged = await page.evaluate(() => ({width:document.documentElement.clientWidth,
    scroll:Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)}));
  expect(enlarged.scroll).toBeLessThanOrEqual(enlarged.width + 1);
});

for (const fault of ['network', 'http503', 'http429']) test(`#68 local unlock works during ${fault} while the browser reports online`, async ({browser}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  // Isolate deterministic network fault injection from browser Service Worker routing;
  // other restart and revocation tests exercise the real installed worker.
  const context = await browser.newContext({baseURL:ORIGIN, serviceWorkers:'block'});
  const page = await context.newPage();
  try {
    expect((await context.request.post('/__e2e__/personal-session')).status()).toBe(200);
    await page.goto('/');
    await openAccounts(page);
    await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
    const phrase = 'synthetic unavailable server phrase sixty eight';
    await page.getByLabel('Парольная фраза', {exact:true}).fill(phrase);
    await page.getByRole('button', {name:'Создать копию'}).click();
    await page.getByLabel('Я сохранил ключ вне браузера').check();
    await page.getByRole('button', {name:'Разблокировать'}).click();
    await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible();
    await context.route('**/api/auth/email/me', route => fault === 'network'
      ? route.abort('failed')
      : route.fulfill({status:fault === 'http503' ? 503 : 429, contentType:'application/json', body:'{}'}));
    await page.reload();
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    await page.getByLabel('Парольная фраза', {exact:true}).fill(phrase);
    await page.getByRole('button', {name:'Разблокировать'}).click();
    await expect(page.getByText(fault === 'network' ? 'Нет связи с сервером' : 'Сервер временно недоступен', {exact:true})).toBeVisible();
    let sent = 0;
    page.on('request', request => {if (request.method() === 'POST' && /\/api\/finance\/v[12]\/commands$/.test(request.url())) sent++;});
    await page.getByRole('button', {name:/Новый счёт/}).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Название').fill('Synthetic unreachable server account');
    await dialog.getByLabel(/Начальный остаток/).fill('1,00');
    await dialog.getByRole('button', {name:'Сохранить'}).click();
    await expect(page.getByText(/В очереди: 1/)).toBeVisible();
    expect(sent).toBe(0);
    await context.unroute('**/api/auth/email/me');
    await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
    const after = await state(context);
    expect(after.body.entities.filter(x => x.kind === 'account' &&
      x.data.name === 'Synthetic unreachable server account')).toHaveLength(1);
    expect(sent).toBe(1);
  } finally {await context.close();}
});

test('#68 offline obligation is created once after reconnect', async ({page, context}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  expect((await context.request.post('/__e2e__/personal-session')).status()).toBe(200);
  await page.goto('/');
  await openAccounts(page);
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  await page.getByLabel('Парольная фраза', {exact:true}).fill('synthetic obligation phrase issue sixty eight');
  await page.getByRole('button', {name:'Создать копию'}).click();
  await page.getByLabel('Я сохранил ключ вне браузера').check();
  await page.getByRole('button', {name:'Разблокировать'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible();
  await context.setOffline(true);
  try {
    await page.getByText('Создать обязательство', {exact:true}).click();
    const form = page.locator('details').filter({has:page.getByText('Создать обязательство', {exact:true})});
    await form.getByLabel('Название обязательства').fill('Synthetic offline obligation');
    await form.getByLabel('Сумма обязательства, ₽').fill('12');
    await form.getByLabel('Дата начала обязательства').fill('2026-11-12');
    await form.getByLabel('Повторение обязательства').selectOption('month');
    await form.getByRole('button', {name:'Сохранить обязательство в очередь'}).click();
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
  } finally {await context.setOffline(false);}
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
  const after = await state(context);
  const obligations = after.body.entities.filter(x => x.kind === 'obligation' &&
    x.data.title === 'Synthetic offline obligation');
  expect(obligations).toHaveLength(1);
  expect(obligations[0].data.amount_minor).toBe(1200);
  expect(obligations[0].data.recurrence_unit).toBe('month');
  expect(obligations[0].data.starts_on).toBe('2026-11-12');
});

test('#68 offline credit payment and compensation each post exactly once', async ({page, context}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  expect((await context.request.post('/__e2e__/personal-session')).status()).toBe(200);
  await bootstrap(context);
  const before = await state(context), accountId = randomUUID();
  expect((await submit(context, before, 'account.create', {id:accountId,
    name:'Synthetic loan account', kind:'cash', currency:'RUB', opening_minor:5000})).status()).toBe(201);
  const created = await context.request.post('/api/finance/v1/__e2e__/synthetic-loan',
    {headers:{Origin:'http://127.0.0.1:8791'}});
  expect(created.status()).toBe(200);
  const loanId = (await created.json()).id;
  await page.goto('/');
  await openAccounts(page);
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  await page.getByLabel('Парольная фраза', {exact:true}).fill('synthetic loan phrase issue sixty eight');
  await page.getByRole('button', {name:'Создать копию'}).click();
  await page.getByLabel('Я сохранил ключ вне браузера').check();
  await page.getByRole('button', {name:'Разблокировать'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible();
  await context.setOffline(true);
  try {
    await page.getByText('Записать платёж по кредиту').click();
    const form = page.locator('details').filter({has:page.getByText('Записать платёж по кредиту', {exact:true})});
    await form.getByRole('combobox', {name:'Кредит', exact:true}).selectOption(loanId);
    await form.getByLabel('Счёт платежа по кредиту').selectOption(accountId);
    await form.getByLabel('Сумма платежа по кредиту, ₽').fill('12');
    await form.getByLabel('Дата платежа по кредиту').fill('2026-11-12');
    await form.getByLabel('Стратегия досрочного погашения').selectOption('amount');
    await form.getByRole('button', {name:'Сохранить платёж в очередь'}).click();
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
  } finally {await context.setOffline(false);}
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
  const after = await state(context);
  expect(entity(after, accountId).data.balance_minor).toBe(3800);
  const facts = after.body.entities.filter(x => x.kind === 'loan_payment' && x.data.loan_id === loanId);
  const payments = after.body.entities.filter(x => x.kind === 'transaction' &&
    x.data.payment_link?.loan_payment_id === facts[0]?.id);
  expect(facts).toHaveLength(1);
  expect(facts[0].data.strategy).toBe('amount');
  expect(payments).toHaveLength(1);
  expect(payments[0].data.postings).toEqual([{account_id:accountId, signed_minor:-1200}]);
  await context.setOffline(true);
  try {
    await page.getByText('Отменить подтверждённую операцию').click();
    await page.getByLabel('Операция для отмены').selectOption(payments[0].id);
    await page.getByLabel('Причина отмены').fill('Synthetic loan correction');
    await page.getByRole('button', {name:'Сохранить отмену'}).click();
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
  } finally {await context.setOffline(false);}
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
  const restored = await state(context);
  expect(entity(restored, accountId).data.balance_minor).toBe(5000);
  expect(restored.body.entities.find(x => x.id === facts[0].id).data.voided_at).toBeTruthy();
  const reversals = restored.body.entities.filter(x => x.kind === 'transaction' &&
    x.data.reversed_transaction_id === payments[0].id);
  expect(reversals).toHaveLength(1);
  expect(reversals[0].data.postings).toEqual([{account_id:accountId, signed_minor:1200}]);
});

test('#68 offline UI records an expense once after reconnecting', async ({page, context}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  expect((await context.request.post('/__e2e__/personal-session')).status()).toBe(200);
  await bootstrap(context);
  const before = await state(context), accountId = randomUUID();
  expect((await submit(context, before, 'account.create', {id:accountId,
    name:'Synthetic offline expense', kind:'cash', currency:'RUB', opening_minor:500})).status()).toBe(201);
  await page.goto('/');
  await openAccounts(page);
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  await expect(page.locator('#storage-context-chip')).toHaveText('Локальная копия');
  await expect(page.locator('#storage-context-footnote')).toContainText('в зашифрованном виде');
  await page.getByLabel('Парольная фраза', {exact:true}).fill('synthetic expense phrase issue sixty eight');
  await page.getByRole('button', {name:'Создать копию'}).click();
  await page.getByLabel('Я сохранил ключ вне браузера').check();
  await page.getByRole('button', {name:'Разблокировать'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible();
  await context.setOffline(true);
  try {
    await page.getByText('Записать доход или расход').click();
    const form = page.locator('details').filter({has:page.getByText('Записать доход или расход')});
    await form.getByLabel('Счёт операции').selectOption(accountId);
    await form.getByLabel('Сумма, ₽', {exact:true}).fill('1,25');
    await form.getByLabel('Дата операции').fill('2026-11-12');
    await form.getByLabel('Примечание', {exact:true}).fill('Synthetic expense');
    await form.getByRole('button', {name:'Сохранить операцию'}).click();
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
    await page.getByText('Ожидающие операции', {exact:true}).click();
    await expect(page.getByText('Расход 1,25 ₽: «Synthetic offline expense»')).toBeVisible();
  } finally {await context.setOffline(false);}
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
  const after = await state(context);
  expect(entity(after, accountId).data.balance_minor).toBe(375);
  const expenses = after.body.entities.filter(x => x.kind === 'transaction' &&
    x.data.kind === 'expense' && x.data.note === 'Synthetic expense');
  expect(expenses).toHaveLength(1);
  expect(expenses[0].data.postings).toEqual([{account_id:accountId, signed_minor:-125}]);
  await context.setOffline(true);
  try {
    await page.getByText('Отменить подтверждённую операцию').click();
    await page.getByLabel('Операция для отмены').selectOption(expenses[0].id);
    await page.getByLabel('Причина отмены').fill('Synthetic correction');
    await page.getByRole('button', {name:'Сохранить отмену'}).click();
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
  } finally {await context.setOffline(false);}
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
  const reversed = await state(context);
  expect(entity(reversed, accountId).data.balance_minor).toBe(500);
  const cancellations = reversed.body.entities.filter(x => x.kind === 'transaction' &&
    x.data.kind === 'reversal' && x.data.reversed_transaction_id === expenses[0].id);
  expect(cancellations).toHaveLength(1);
  expect(cancellations[0].data.postings).toEqual([{account_id:accountId, signed_minor:125}]);
});

test('#68 offline reserve cycle close and undo preserve paid balance', async ({page, context}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  expect((await context.request.post('/__e2e__/personal-session')).status()).toBe(200);
  await bootstrap(context);
  const accountId=randomUUID();
  expect((await submit(context, await state(context), 'account.create', {id:accountId,
    name:'Synthetic cycle account', kind:'cash', currency:'RUB', opening_minor:10000})).status()).toBe(201);
  const planned=await submit(context, await state(context), 'obligation.create', {title:'Synthetic cycle obligation',
    direction:'expense', amount_minor:5000, starts_on:'2026-11-12', timezone:'Europe/Moscow',
    recurrence_unit:'none', recurrence_every:1}, {}, 1);
  expect(planned.status()).toBe(201);
  const obligationId=(await planned.json()).changes[0].entity_id, reserveId=randomUUID();
  const before=await state(context);
  const create=await submit(context,before,'reserve.create',{id:reserveId,obligation_id:obligationId,
    account_id:accountId,title:'Synthetic cycle reserve',target_minor:5000,opened_on:'2026-10-12',
    first_due_on:'2026-11-12',period_months:1,due_day:12,contribution_mode:'auto',opening_reserved_minor:0},
    {[accountId]:versionOf(before,accountId),[obligationId]:versionOf(before,obligationId)});
  expect(create.status()).toBe(201);
  const ready=await state(context);
  const paid=await submit(context,ready,'settlement.payment.record',{account_id:accountId,
    obligation_id:obligationId,amount_minor:5000,paid_on:'2026-11-12',occurrence_on:'2026-11-12',
    reserve_id:reserveId,reserved_used_minor:0},{[accountId]:versionOf(ready,accountId),
      [obligationId]:versionOf(ready,obligationId),[reserveId]:versionOf(ready,reserveId)});
  expect(paid.status()).toBe(201);
  await page.goto('/');
  await openAccounts(page);
  await page.getByRole('button',{name:'Офлайн-синхронизация'}).click();
  await page.getByLabel('Парольная фраза',{exact:true}).fill('synthetic cycle phrase issue sixty eight');
  await page.getByRole('button',{name:'Создать копию'}).click();
  await page.getByLabel('Я сохранил ключ вне браузера').check();
  await page.getByRole('button',{name:'Разблокировать'}).click();
  await expect(page.getByText('Синхронизировано',{exact:true})).toBeVisible();
  await page.getByText('Завершить или восстановить цикл резерва').click();
  const form=page.locator('details').filter({has:page.getByText('Завершить или восстановить цикл резерва',{exact:true})});
  await form.getByLabel('Резерв для цикла').selectOption(reserveId);
  await form.getByLabel('Дата действия с циклом').fill('2026-11-12');
  for (const [closing,cycle,due] of [[true,2,'2026-12-12'],[false,1,'2026-11-12']]) {
    await context.setOffline(true);
    try {
      if(!closing) await form.getByLabel('Причина восстановления цикла').fill('Synthetic cycle correction');
      page.once('dialog', prompt=>prompt.accept());
      await form.getByRole('button',{name:closing?'Завершить цикл':'Отменить закрытие цикла',exact:true}).click();
      await expect(page.getByText('Ожидает отправки',{exact:true})).toBeVisible();
    } finally {await context.setOffline(false);}
    await expect(page.getByText('Синхронизировано',{exact:true})).toBeVisible({timeout:30_000});
    const result=await state(context), reserve=result.body.entities.find(x=>x.id===reserveId);
    expect(reserve.data.cycle_number).toBe(cycle);
    expect(reserve.data.target_on).toBe(due);
    expect(entity(result,accountId).data.balance_minor).toBe(5000);
    expect(entity(result,accountId).data.reserved_minor).toBe(0);
  }
});

test('#68 offline reserve creation, changes and archive preserve real account balance', async ({page, context}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  expect((await context.request.post('/__e2e__/personal-session')).status()).toBe(200);
  await bootstrap(context);
  const accountId = randomUUID(), initial = await state(context);
  expect((await submit(context, initial, 'account.create', {id:accountId,
    name:'Synthetic allocation account', kind:'cash', currency:'RUB', opening_minor:10000})).status()).toBe(201);
  const planned = await submit(context, await state(context), 'obligation.create', {
    title:'Synthetic reserve obligation', direction:'expense', amount_minor:5000,
    starts_on:'2026-11-12', timezone:'Europe/Moscow', recurrence_unit:'none', recurrence_every:1,
  }, {}, 1);
  expect(planned.status()).toBe(201);
  const obligationId = (await planned.json()).changes[0].entity_id;
  await page.goto('/');
  await openAccounts(page);
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  await page.getByLabel('Парольная фраза', {exact:true}).fill('synthetic reserve allocation phrase sixty eight');
  await page.getByRole('button', {name:'Создать копию'}).click();
  await page.getByLabel('Я сохранил ключ вне браузера').check();
  await page.getByRole('button', {name:'Разблокировать'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible();
  await page.getByText('Создать резерв', {exact:true}).click();
  const createForm = page.locator('details').filter({has:page.getByText('Создать резерв', {exact:true})});
  await context.setOffline(true);
  try {
    await createForm.getByLabel('Название резерва').fill('Synthetic allocation reserve');
    await createForm.getByLabel('Расход для резерва').selectOption(obligationId);
    await createForm.getByLabel('Счёт для резерва').selectOption(accountId);
    await createForm.getByLabel('Цель резерва, ₽').fill('50');
    await createForm.getByLabel('Дата открытия резерва').fill('2026-10-12');
    await createForm.getByLabel('Первая дата оплаты резерва').fill('2026-11-12');
    await createForm.getByRole('button', {name:'Сохранить резерв в очередь'}).click();
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
  } finally {await context.setOffline(false);}
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
  const reserves = (await state(context)).body.entities.filter(x => x.kind === 'reserve' &&
    x.data.title === 'Synthetic allocation reserve');
  expect(reserves).toHaveLength(1);
  const reserveId = reserves[0].id;
  await page.getByText('Изменить название или цель резерва').click();
  const editForm = page.locator('details').filter({has:page.getByText('Изменить название или цель резерва', {exact:true})});
  await context.setOffline(true);
  try {
    await editForm.getByLabel('Резерв для изменения').selectOption(reserveId);
    await editForm.getByLabel('Новое название резерва').fill('Synthetic updated reserve');
    await editForm.getByLabel('Новая цель резерва, ₽').fill('60');
    await editForm.getByLabel('Дата изменения резерва').fill('2026-11-12');
    await editForm.getByRole('button', {name:'Сохранить изменение резерва в очередь'}).click();
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
  } finally {await context.setOffline(false);}
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
  const edited = (await state(context)).body.entities.find(x => x.id === reserveId);
  expect(edited.data.title).toBe('Synthetic updated reserve');
  expect(edited.data.target_minor).toBe(6000);
  expect(edited.data.allocated_minor).toBe(0);
  expect(edited.data.event_log.filter(x => x.kind === 'target_change')).toHaveLength(1);
  await page.getByText('Отметить пропущенный взнос').click();
  const skipForm = page.locator('details').filter({has:page.getByText('Отметить пропущенный взнос', {exact:true})});
  await context.setOffline(true);
  try {
    await skipForm.getByLabel('Резерв для пропуска').selectOption(reserveId);
    await skipForm.getByLabel('Дата пропущенного взноса').fill('2026-11-12');
    await skipForm.getByLabel('Дата отметки пропуска').fill('2026-11-12');
    await skipForm.getByRole('button', {name:'Сохранить пропуск в очередь'}).click();
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
  } finally {await context.setOffline(false);}
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
  const skipped = await state(context);
  const skippedEvents = skipped.body.entities.find(x => x.id === reserveId).data.event_log.filter(x => x.kind === 'skip');
  expect(skippedEvents).toHaveLength(1);
  expect(entity(skipped, accountId).data.balance_minor).toBe(10000);
  expect(entity(skipped, accountId).data.reserved_minor).toBe(0);
  await page.getByText('Отменить событие резерва').click();
  const voidForm = page.locator('details').filter({has:page.getByText('Отменить событие резерва', {exact:true})});
  const voidEvent = async (id) => {
    await context.setOffline(true);
    try {
      await voidForm.getByLabel('Резерв для отмены события').selectOption(reserveId);
      await voidForm.getByLabel('Событие для отмены').selectOption(id);
      await voidForm.getByLabel('Дата отмены события').fill('2026-11-12');
      await voidForm.getByLabel('Причина отмены события').fill('Synthetic correction');
      await voidForm.getByRole('button', {name:'Сохранить отмену события в очередь'}).click();
      await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
    } finally {await context.setOffline(false);}
    await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
  };
  await voidEvent(skippedEvents[0].id);
  const afterSkipVoid = await state(context);
  expect(afterSkipVoid.body.entities.find(x => x.id === reserveId).data.event_log
    .filter(x => x.kind === 'void' && x.target_event_id === skippedEvents[0].id)).toHaveLength(1);
  expect(entity(afterSkipVoid, accountId).data.reserved_minor).toBe(0);
  await page.getByText('Пополнить или освободить резерв').click();
  const form = page.locator('details').filter({has:page.getByText('Пополнить или освободить резерв', {exact:true})});
  for (const [action, amount, expected, events] of [['contribution','12',1200,1], ['contribution','12',1200,2], ['release','5',700,1], ['release','7',0,2]]) {
    await context.setOffline(true);
    try {
      await form.getByRole('combobox', {name:'Резерв', exact:true}).selectOption(reserveId);
      await form.getByLabel('Действие с резервом').selectOption(action);
      await form.getByLabel('Сумма распределения, ₽').fill(amount);
      await form.getByLabel('Дата распределения').fill('2026-11-12');
      await form.getByRole('button', {name:'Сохранить распределение в очередь'}).click();
      await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
    } finally {await context.setOffline(false);}
    await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
    const after = await state(context);
    expect(entity(after, accountId).data.balance_minor).toBe(10000);
    expect(entity(after, accountId).data.reserved_minor).toBe(expected);
    const reserve = after.body.entities.find(x => x.id === reserveId);
    expect(reserve.data.allocated_minor).toBe(expected);
    expect(reserve.data.event_log.filter(x => x.kind === action)).toHaveLength(events);
    if (action === 'contribution' && events === 1) {
      const original = reserve.data.event_log.find(x => x.kind === 'contribution');
      await voidEvent(original.id);
      const restored = await state(context);
      expect(entity(restored, accountId).data.balance_minor).toBe(10000);
      expect(entity(restored, accountId).data.reserved_minor).toBe(0);
      expect(restored.body.entities.find(x => x.id === reserveId).data.allocated_minor).toBe(0);
    }
  }
  await context.setOffline(true);
  try {
    await form.getByRole('combobox', {name:'Резерв', exact:true}).selectOption(reserveId);
    page.once('dialog', prompt => prompt.accept());
    await form.getByRole('button', {name:'Архивировать выбранный резерв'}).click();
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
  } finally {await context.setOffline(false);}
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
  const archived = await state(context);
  expect(archived.body.entities.find(x => x.id === reserveId).data.archived_at).toBeTruthy();
  expect(entity(archived, accountId).data.balance_minor).toBe(10000);
  expect(entity(archived, accountId).data.reserved_minor).toBe(0);
});

for (const useReserve of [false, true]) test(`#68 offline settlement creates one payment fact and one cash posting (reserve=${useReserve})`, async ({page, context}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  expect((await context.request.post('/__e2e__/personal-session')).status()).toBe(200);
  await bootstrap(context);
  const accountId = randomUUID(), initial = await state(context);
  expect((await submit(context, initial, 'account.create', {id:accountId,
    name:'Синтетический платёжный счёт', kind:'cash', currency:'RUB', opening_minor:10000})).status()).toBe(201);
  const accountState = await state(context);
  const planned = await submit(context, accountState, 'obligation.create', {
    title:'Синтетическое обязательство', direction:'expense', amount_minor:2500,
    starts_on:'2026-11-12', timezone:'Europe/Moscow', recurrence_unit:'none', recurrence_every:1,
  }, {}, 1);
  expect(planned.status()).toBe(201);
  const obligationId = (await planned.json()).changes[0].entity_id;
  let reserveId = null;
  if (useReserve) {
    reserveId = randomUUID();
    const beforeReserve = await state(context);
    const created = await submit(context, beforeReserve, 'reserve.create', {
      id:reserveId, obligation_id:obligationId, account_id:accountId,
      title:'Синтетический платёжный резерв', target_minor:2500, opened_on:'2026-10-12',
      first_due_on:'2026-11-12', period_months:1, due_day:12,
      contribution_mode:'auto', opening_reserved_minor:1500,
    }, {[accountId]:versionOf(beforeReserve, accountId), [obligationId]:versionOf(beforeReserve, obligationId)});
    expect(created.status()).toBe(201);
  }
  await page.goto('/');
  await openAccounts(page);
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  await page.getByLabel('Парольная фраза', {exact:true}).fill('synthetic offline settlement phrase sixty eight');
  await page.getByRole('button', {name:'Создать копию'}).click();
  await page.getByLabel('Я сохранил ключ вне браузера').check();
  await page.getByRole('button', {name:'Разблокировать'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible();
  await context.setOffline(true);
  try {
    await page.getByText('Записать оплату обязательства').click();
    const form = page.locator('details').filter({has:page.getByText('Записать оплату обязательства', {exact:true})});
    await form.getByRole('combobox', {name:'Обязательство', exact:true}).selectOption(obligationId);
    await form.getByRole('combobox', {name:'Счёт оплаты'}).selectOption(accountId);
    await form.getByLabel('Сумма оплаты, ₽').fill('25,00');
    await form.getByLabel('Дата оплаты', {exact:true}).fill('2026-11-12');
    await form.getByLabel('Дата периода обязательства').fill('2026-11-12');
    if (useReserve) {
      await form.getByRole('combobox', {name:'Резерв для оплаты'}).selectOption(reserveId);
      await form.getByLabel('Из резерва, ₽').fill('15,00');
    }
    await form.getByRole('button', {name:'Сохранить оплату в очередь'}).click();
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
  } finally {await context.setOffline(false);}
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
  const after = await state(context);
  expect(entity(after, accountId).data.balance_minor).toBe(7500);
  const facts = after.body.entities.filter(item => item.kind === 'settlement' && item.data.obligation_id === obligationId);
  const transactions = after.body.entities.filter(item => item.kind === 'transaction' &&
    item.data.payment_link?.settlement_id === facts[0]?.id);
  expect(facts).toHaveLength(1);
  expect(transactions).toHaveLength(1);
  expect(transactions[0].data.postings).toEqual([{account_id:accountId, signed_minor:-2500}]);
  if (useReserve) {
    expect(entity(after, accountId).data.reserved_minor).toBe(0);
    expect(transactions[0].data.reserve_allocation).toMatchObject({reserve_id:reserveId, delta_minor:-1500});
  }
  await context.setOffline(true);
  try {
    await page.getByText('Отменить подтверждённую операцию').click();
    await page.getByLabel('Операция для отмены').selectOption(transactions[0].id);
    await page.getByLabel('Причина отмены').fill('Синтетическая отмена оплаты');
    await page.getByRole('button', {name:'Сохранить отмену'}).click();
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
  } finally {await context.setOffline(false);}
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
  const restored = await state(context);
  expect(entity(restored, accountId).data.balance_minor).toBe(10000);
  const voided = restored.body.entities.find(item => item.kind === 'settlement' && item.id === facts[0].id);
  expect(voided.data.voided_at).not.toBeNull();
  const reversals = restored.body.entities.filter(item => item.kind === 'transaction' &&
    item.data.reversed_transaction_id === transactions[0].id);
  expect(reversals).toHaveLength(1);
  expect(reversals[0].data.postings).toEqual([{account_id:accountId, signed_minor:2500}]);
  if (useReserve) expect(entity(restored, accountId).data.reserved_minor).toBe(1500);
});

test('#68 active UI retains an offline queued command across reload and later unlock', async ({page, context}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  await visitGuest(page);
  await addEntry(page, 'Синтетическая гостевая запись');
  const guestBefore = await scopedState(page, 'guest-state-v2');
  expect((await context.request.post('/__e2e__/personal-session')).status()).toBe(200);
  await page.evaluate(() => sessionStorage.removeItem('fh-guest-session-v2'));
  await bootstrap(context);
  const existingId = randomUUID(), initial = await state(context);
  expect((await submit(context, initial, 'account.create', {id:existingId,
    name:'Счёт до перезапуска', kind:'cash', currency:'RUB', opening_minor:0})).status()).toBe(201);
  await page.goto('/');
  await expect(page.locator('#save-indicator')).toHaveText(/Локальная база готова|Серверный раздел/);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await openAccounts(page);
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  await page.getByLabel('Парольная фраза', {exact:true}).fill('synthetic persistent phrase issue sixty eight');
  await page.getByRole('button', {name:'Создать копию'}).click();
  const originalRecovery = await page.locator('output').textContent();
  expect(originalRecovery).toHaveLength(43);
  await page.getByLabel('Я сохранил ключ вне браузера').check();
  await page.getByRole('button', {name:'Разблокировать'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible();
  await page.getByText('Ключ восстановления', {exact:true}).click();
  await page.getByLabel('Парольная фраза для нового ключа').fill('synthetic persistent phrase issue sixty eight');
  await page.getByLabel('Понимаю, что прежний ключ перестанет действовать').check();
  await page.getByRole('button', {name:'Выпустить новый ключ'}).click();
  const recoveryKey = await page.locator('output').textContent();
  expect(recoveryKey).toHaveLength(43);
  expect(recoveryKey).not.toBe(originalRecovery);
  await context.setOffline(true);
  try {
    await page.getByRole('button', {name:/Новый счёт/}).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Название').fill('Счёт после перезапуска');
    await dialog.getByLabel(/Начальный остаток/).fill('20,00');
    await dialog.getByRole('button', {name:'Сохранить'}).click();
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
    // Returning focus while disconnected must not mistake a network failure
    // for a server revocation or destroy the already unlocked screen.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const redirected = await page.waitForURL(/account\.html/, {timeout:2000})
      .then(() => true, () => false);
    expect(redirected).toBe(false);
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
    await page.reload();
    await expect(page.getByText(/Доступна только локальная зашифрованная копия/)).toBeVisible();
    await page.getByLabel('Способ разблокировки').selectOption('recoveryKey');
    await page.getByLabel('Ключ восстановления', {exact:true}).fill(originalRecovery);
    await page.getByRole('button', {name:'Разблокировать'}).click();
    await expect(page.getByText(/Неверн|не удалось|подтверд/i).first()).toBeVisible();
    await page.getByLabel('Ключ восстановления', {exact:true}).fill(recoveryKey);
    await page.getByRole('button', {name:'Разблокировать'}).click();
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
    expect(await scopedState(page, 'guest-state-v2')).toEqual(guestBefore);
    await page.locator('.fh-account-card').filter({hasText:'Счёт до перезапуска'})
      .getByRole('button', {name:'Изменить'}).click();
    const offlineDialog = page.getByRole('dialog');
    await offlineDialog.getByLabel('Название').fill('Изменён после перезапуска');
    await offlineDialog.getByRole('button', {name:'Сохранить'}).click();
    await expect(page.getByText(/В очереди:\s*2/)).toBeVisible();
  } finally {await context.setOffline(false);}
  await expect(page.getByText('Конфликт', {exact:true})).toBeVisible({timeout:30_000});
  await page.getByRole('button', {name:'Обновить с сервера'}).click();
  await page.getByRole('button', {name:'Применить заново'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
  const server = await state(context);
  expect(server.body.entities.filter(x => x.kind === 'account' && x.data.name === 'Счёт после перезапуска')).toHaveLength(1);
  expect(entity(server, existingId).data.name).toBe('Изменён после перезапуска');
  expect(JSON.stringify(server.body)).not.toContain('Синтетическая гостевая запись');
});

test('#68 explicit logout disables offline entry without deleting the vault', async ({page, context}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  const login = await context.request.post('/__e2e__/personal-session');
  expect(login.status()).toBe(200);
  const user = (await login.json()).user;
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await openAccounts(page);
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  await page.getByLabel('Парольная фраза', {exact:true}).fill('synthetic logout phrase issue sixty eight');
  await page.getByRole('button', {name:'Создать копию'}).click();
  await page.getByLabel('Я сохранил ключ вне браузера').check();
  await page.getByRole('button', {name:'Разблокировать'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('fh-offline-sync-actor-v1'))).toMatch(/^[a-f0-9]{32}$/);
  await logoutViaUi(page);
  expect(await page.evaluate(() => localStorage.getItem('fh-offline-sync-actor-v1'))).toBeNull();
  await context.setOffline(true);
  try {
    await page.goto('/');
    await expect(page).toHaveURL(/account\.html/);
    await expect(page.getByText(/Доступна только локальная зашифрованная копия/)).toHaveCount(0);
  } finally {await context.setOffline(false);}
  await page.reload();
  await loginViaUi(page, user.email, undefined, {reuseAccountPage:true});
  await openAccounts(page);
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  await page.getByLabel('Парольная фраза', {exact:true}).fill('synthetic logout phrase issue sixty eight');
  await page.getByRole('button', {name:'Разблокировать'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible();
});

test('#68 unlocked queue synchronizes after leaving the accounts screen', async ({page, context}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  expect((await context.request.post('/__e2e__/personal-session')).status()).toBe(200);
  await page.goto('/');
  await openAccounts(page);
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  const phrase = 'synthetic background queue phrase sixty eight';
  await page.getByLabel('Парольная фраза', {exact:true}).fill(phrase);
  await page.getByRole('button', {name:'Создать копию'}).click();
  await page.getByLabel('Я сохранил ключ вне браузера').check();
  await page.getByRole('button', {name:'Разблокировать'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible();
  await context.setOffline(true);
  try {
    await page.getByRole('button', {name:/Новый счёт/}).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Название').fill('Фоновая синхронизация');
    await dialog.getByLabel(/Начальный остаток/).fill('2,00');
    await dialog.getByRole('button', {name:'Сохранить'}).click();
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
    page.once('dialog', prompt => prompt.accept());
    await page.getByRole('button', {name:/К обзору/}).click();
    await expect(page.locator('#toolbar-title')).toHaveText('Обзор');
  } finally {await context.setOffline(false);}
  await expect.poll(async () => {
    const current = await state(context);
    return current.body.entities.filter(x => x.kind === 'account' && x.data.name === 'Фоновая синхронизация').length;
  }, {timeout:30_000}).toBe(1);
  await openAccounts(page);
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible();
  await expect(page.getByLabel('Парольная фраза', {exact:true})).toHaveCount(0);
});

test('#68 offline restart never sends a queue after remote session revocation', async ({page, context, browser}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  const first = await context.request.post('/__e2e__/personal-session');
  const user = (await first.json()).user;
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await loginViaUi(otherPage, user.email);
  await bootstrap(other);
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await openAccounts(page);
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  const phrase = 'synthetic offline revocation phrase sixty eight';
  await page.getByLabel('Парольная фраза', {exact:true}).fill(phrase);
  await page.getByRole('button', {name:'Создать копию'}).click();
  await page.getByLabel('Я сохранил ключ вне браузера').check();
  await page.getByRole('button', {name:'Разблокировать'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible();
  await context.setOffline(true);
  try {
    await page.getByRole('button', {name:/Новый счёт/}).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Название').fill('Ожидает подтверждения сессии');
    await dialog.getByLabel(/Начальный остаток/).fill('4,00');
    await dialog.getByRole('button', {name:'Сохранить'}).click();
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
    await page.reload();
    await page.getByLabel('Парольная фраза', {exact:true}).fill(phrase);
    await page.getByRole('button', {name:'Разблокировать'}).click();
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
    const revoked = await other.request.post('/api/auth/email/logout-others',
      {headers:{Origin:ORIGIN}, data:{}});
    expect(revoked.status()).toBe(200);
  } finally {await context.setOffline(false);}
  await expect(page.getByText('Доступ к аккаунту отозван. Войдите снова.')).toBeVisible({timeout:30_000});
  expect(await page.evaluate(() => localStorage.getItem('fh-offline-sync-actor-v1'))).toBeNull();
  await context.setOffline(true);
  try {
    const restarted = await context.newPage();
    await restarted.goto('/');
    await expect(restarted).toHaveURL(/account\.html/);
    await expect(restarted.getByLabel('Парольная фраза', {exact:true})).toHaveCount(0);
    await restarted.close();
  } finally {await context.setOffline(false);}
  const before = await state(other);
  expect(before.body.entities.filter(x => x.kind === 'account' && x.data.name === 'Ожидает подтверждения сессии')).toHaveLength(0);
  await page.getByRole('button', {name:'Назад'}).click();
  await loginViaUi(page, user.email, undefined, {reuseAccountPage:true});
  await openAccounts(page);
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  await page.getByLabel('Парольная фраза', {exact:true}).fill(phrase);
  await page.getByRole('button', {name:'Разблокировать'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
  const after = await state(other);
  expect(after.body.entities.filter(x => x.kind === 'account' && x.data.name === 'Ожидает подтверждения сессии')).toHaveLength(1);
  await other.close();
});

test('#68 active UI clears the previous account when the shared session switches', async ({page, context}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  const watch = await observe(context, page);
  const first = await context.request.post('/__e2e__/personal-session');
  expect(first.status()).toBe(200);
  const actor = (await first.json()).user.id;
  await page.goto('/');
  await expect(page.locator('#save-indicator')).toHaveText(/Локальная база готова|Серверный раздел/);
  await openAccounts(page);
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  const phrase = 'synthetic session switch phrase sixty eight';
  await page.getByLabel('Парольная фраза', {exact:true}).fill(phrase);
  await page.getByRole('button', {name:'Создать копию'}).click();
  await page.getByLabel('Я сохранил ключ вне браузера').check();
  await page.getByRole('button', {name:'Разблокировать'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible();
  await page.getByRole('button', {name:/Новый счёт/}).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Название').fill('Счёт первого пользователя');
  await dialog.getByLabel(/Начальный остаток/).fill('5,00');
  await dialog.getByRole('button', {name:'Сохранить'}).click();
  await expect(page.getByRole('heading', {name:'Счёт первого пользователя'})).toBeVisible({timeout:30_000});
  const second = await context.request.post('/__e2e__/personal-session');
  expect(second.status()).toBe(200);
  expect((await second.json()).user.id).not.toBe(actor);
  await bootstrap(context);
  await page.getByRole('button', {name:'Обновить с сервера'}).click();
  await expect(page.getByRole('heading', {name:'Счёт первого пользователя'})).toHaveCount(0);
  await expect(page).toHaveURL(/\/account\.html$/);
  await expect(page.getByRole('heading', {name:'Аккаунт'})).toBeVisible();
  const newState = await state(context);
  expect(newState.body.entities).toEqual([]);
  await page.goto('/');
  await expect(page.locator('#save-indicator')).toHaveText(/Локальная база готова|Серверный раздел/);
  await openAccounts(page);
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  await page.getByLabel('Парольная фраза', {exact:true}).fill(phrase);
  await page.getByRole('button', {name:'Разблокировать'}).click();
  await expect(page.getByText('Сначала создайте зашифрованную копию')).toBeVisible();
  await expect(page.getByRole('heading', {name:'Счёт первого пользователя'})).toHaveCount(0);
  expect(watch.exceptions).toEqual([]);
  expect(watch.unplanned).toEqual([]);
  expect(watch.consoleErrors).toEqual([
    'Failed to load resource: the server responded with a status of 403 (Forbidden)',
  ]);
});

test('#68 a new login in another tab revokes the previously displayed account', async ({page, context, browser}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  const separate = await browser.newContext();
  const registered = await separate.request.post('/__e2e__/personal-session');
  expect(registered.status()).toBe(200);
  const other = (await registered.json()).user;
  await separate.close();
  expect((await context.request.post('/__e2e__/personal-session')).status()).toBe(200);
  await page.goto('/');
  await expect(page.locator('#save-indicator')).toHaveText(/Локальная база готова|Серверный раздел/);
  await openAccounts(page);
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  await page.getByLabel('Парольная фраза', {exact:true}).fill('synthetic account rotation phrase 68');
  await page.getByRole('button', {name:'Создать копию'}).click();
  await page.getByLabel('Я сохранил ключ вне браузера').check();
  await page.getByRole('button', {name:'Разблокировать'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible();
  await page.getByRole('button', {name:/Новый счёт/}).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Название').fill('Скрытый после смены');
  await dialog.getByLabel(/Начальный остаток/).fill('1,00');
  await dialog.getByRole('button', {name:'Сохранить'}).click();
  await expect(page.getByRole('heading', {name:'Скрытый после смены'})).toBeVisible({timeout:30_000});
  await context.clearCookies({name:'fh_email_session'});
  const loginTab = await context.newPage();
  await loginViaUi(loginTab, other.email);
  await expect(page).toHaveURL(/account\.html/);
  await expect(page.getByRole('heading', {name:'Скрытый после смены'})).toHaveCount(0);
  expect(await loginTab.evaluate(() => localStorage.getItem('fh-offline-sync-actor-v1'))).toBeNull();
  await context.setOffline(true);
  try {
    const restarted = await context.newPage();
    await restarted.goto('/');
    await expect(restarted).toHaveURL(/account\.html/);
    await expect(restarted.getByRole('heading', {name:'Скрытый после смены'})).toHaveCount(0);
    await restarted.close();
  } finally {await context.setOffline(false);}
  await loginTab.close();
});

test('#68 two active tabs preserve both queued operations and resolve the stale second command', async ({page, context}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  const watch = await observe(context, page);
  expect((await context.request.post('/__e2e__/personal-session')).status()).toBe(200);
  await page.goto('/');
  await expect(page.locator('#save-indicator')).toHaveText(/Локальная база готова|Серверный раздел/);
  await openAccounts(page);
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  const phrase = 'synthetic shared tabs phrase sixty eight';
  await page.getByLabel('Парольная фраза', {exact:true}).fill(phrase);
  await page.getByRole('button', {name:'Создать копию'}).click();
  await page.getByLabel('Я сохранил ключ вне браузера').check();
  await page.getByRole('button', {name:'Разблокировать'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible();
  const second = await context.newPage();
  const secondErrors = [], secondExceptions = [];
  second.on('pageerror', error => secondExceptions.push(error.message));
  second.on('console', message => {if (message.type() === 'error') secondErrors.push(message.text());});
  await second.goto('/');
  await expect(second.locator('#save-indicator')).toHaveText(/Локальная база готова|Серверный раздел/);
  await openAccounts(second);
  await second.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  await second.getByLabel('Парольная фраза', {exact:true}).fill(phrase);
  await second.getByRole('button', {name:'Разблокировать'}).click();
  await expect(second.getByText('Синхронизировано', {exact:true})).toBeVisible();
  await context.setOffline(true);
  try {
    for (const [tab, name] of [[page, 'Первый офлайн счёт'], [second, 'Второй офлайн счёт']]) {
      await tab.getByRole('button', {name:/Новый счёт/}).click();
      const dialog = tab.getByRole('dialog');
      await dialog.getByLabel('Название').fill(name);
      await dialog.getByLabel(/Начальный остаток/).fill('1,00');
      await dialog.getByRole('button', {name:'Сохранить'}).click();
      await expect(tab.getByText('Ожидает отправки', {exact:true})).toBeVisible();
    }
    await expect(second.getByText(/В очереди: 2/)).toBeVisible();
    await expect(page.getByText(/В очереди: 2/)).toBeVisible();
  } finally {await context.setOffline(false);}
  let conflicted;
  await expect.poll(async () => {
    if (await page.getByText('Конфликт', {exact:true}).isVisible()) {conflicted = page; return true;}
    if (await second.getByText('Конфликт', {exact:true}).isVisible()) {conflicted = second; return true;}
    return false;
  }, {timeout:30_000}).toBe(true);
  await conflicted.getByRole('button', {name:'Обновить с сервера'}).click();
  await conflicted.getByRole('button', {name:'Применить заново'}).click();
  await expect(conflicted.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
  const final = await state(context);
  const names = final.body.entities.filter(x => x.kind === 'account').map(x => x.data.name);
  expect(names.filter(x => x === 'Первый офлайн счёт')).toHaveLength(1);
  expect(names.filter(x => x === 'Второй офлайн счёт')).toHaveLength(1);
  expect(final.revision).toBe(2);
  await second.close();
  expect(watch.exceptions).toEqual([]);
  expect(secondExceptions).toEqual([]);
  expect(watch.unplanned).toEqual([]);
  expect([...watch.consoleErrors, ...secondErrors]).toEqual([
    'Failed to load resource: the server responded with a status of 412 (Precondition Failed)',
  ]);
});

for (const resolution of ['server', 'reapply']) test(`#68 active accounts UI queues offline and resolves two-device conflict: ${resolution}`, async ({page, context, browser}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  const watch = await observe(context, page);
  const created = await context.request.post('/__e2e__/personal-session');
  expect(created.status()).toBe(200);
  const owner = (await created.json()).user;
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await loginViaUi(otherPage, owner.email);
  await bootstrap(other);
  await page.goto('/');
  await openAccounts(page);
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  await page.getByLabel('Парольная фраза', {exact:true}).fill('synthetic local phrase issue sixty eight');
  await page.getByRole('button', {name:'Создать копию'}).click();
  await expect(page.locator('output')).toBeVisible();
  await page.getByLabel('Я сохранил ключ вне браузера').check();
  await page.getByRole('button', {name:'Разблокировать'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible();
  await context.setOffline(true);
  try {
    await page.getByRole('button', {name:/Новый счёт/}).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Название').fill('Синтетический офлайн счёт');
    await dialog.getByLabel(/Начальный остаток/).fill('10,00');
    await dialog.getByRole('button', {name:'Сохранить'}).click();
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
    await expect(page.getByRole('heading', {name:'Синтетический офлайн счёт'})).toHaveCount(0);
  } finally {await context.setOffline(false);}
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
  await expect(page.getByRole('heading', {name:'Синтетический офлайн счёт'})).toBeVisible();
  const server = await state(context);
  const accounts = server.body.entities.filter(x => x.kind === 'account' && x.data.name === 'Синтетический офлайн счёт');
  expect(accounts).toHaveLength(1);
  await context.setOffline(true);
  try {
    await page.locator('.fh-account-card').filter({hasText:'Синтетический офлайн счёт'})
      .getByRole('button', {name:'Изменить'}).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Название').fill('Локальное изменение');
    await dialog.getByRole('button', {name:'Сохранить'}).click();
    await expect(page.getByText('Ожидает отправки', {exact:true})).toBeVisible();
    const remote = await state(other);
    const current = entity(remote, accounts[0].id);
    const changed = await submit(other, remote, 'account.update', {
      account_id:accounts[0].id, name:'Версия другого устройства', kind:'bank',
    }, {[accounts[0].id]:current.entity_revision});
    expect(changed.status()).toBe(201);
  } finally {await context.setOffline(false);}
  await expect(page.getByText('Конфликт', {exact:true})).toBeVisible({timeout:30_000});
  await page.getByRole('button', {name:'Обновить с сервера'}).click();
  await expect(page.getByRole('heading', {name:'Версия другого устройства'})).toBeVisible();
  await page.getByRole('button', {name:resolution === 'server' ? 'Принять серверную версию' : 'Применить заново'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
  const final = await state(other);
  expect(entity(final, accounts[0].id).data.name).toBe(resolution === 'server' ? 'Версия другого устройства' : 'Локальное изменение');
  expect(final.revision).toBe(resolution === 'server' ? 2 : 3);
  await other.close();
  expect(watch.exceptions).toEqual([]);
  expect(watch.unplanned).toEqual([]);
  expect(watch.consoleErrors).toEqual([
    'Failed to load resource: the server responded with a status of 412 (Precondition Failed)',
  ]);
});

test('#68 controller binds real session, encrypts queue and rejects account switching', async ({page, context}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  await context.route('**/__e2e_138_*.js', route => route.fulfill({
    status: 200, contentType: 'text/javascript',
    body: testModuleSources.get(new URL(route.request().url()).pathname),
    headers: {'Cache-Control': 'no-store'},
  }));
  const created = await context.request.post('/__e2e__/personal-session');
  expect(created.status()).toBe(200);
  const actor = (await created.json()).user.id;
  await page.goto('/__e2e__/ready');
  const accountId = randomUUID(), mutation = randomUUID();
  const first = await page.evaluate(async ({actor, accountId, mutation}) => {
    const {FinanceSyncController} = await import('/__e2e_138_controller__.js');
    const controller = new FinanceSyncController({verifiedActorUserId:actor, origin:location.origin});
    const created = await controller.createLocal('synthetic independent local phrase 68', true);
    const opened = await controller.unlock({passphrase:'synthetic independent local phrase 68'});
    const queued = await controller.enqueue({schema_version:2, client_mutation_id:mutation,
      base_revision:opened.cloud.revision, action:'account.create', expected_entity_revisions:{},
      payload:{id:accountId, name:'synthetic controller account', kind:'cash', currency:'RUB', opening_minor:500}});
    const sent = await controller.dispatchOnce();
    const after = await controller.refresh();
    globalThis.__controller68 = controller;
    return {key:created.recoveryKey.length, opened:opened.status, queued:queued.status,
      sent:sent.status, after:after.status, revision:after.cloud.revision, pending:after.outbox.length};
  }, {actor, accountId, mutation});
  expect(first).toEqual({key:43, opened:'SYNCHRONIZED', queued:'QUEUED_ENCRYPTED',
    sent:'DURABLY_CONFIRMED', after:'SYNCHRONIZED', revision:1, pending:0});
  const later = await page.evaluate(async ({accountId}) => {
    const controller = globalThis.__controller68;
    const outcomes = [];
    for (const action of ['account.update', 'account.archive', 'account.unarchive', 'transaction.record']) {
      const current = await controller.read();
      const account = current.cloud.entities.find(entity => entity.id === accountId);
      const payload = action === 'account.update' ? {account_id:accountId, name:'synthetic edited', kind:'bank'} :
        action === 'transaction.record' ? {id:crypto.randomUUID(), account_id:accountId,
          kind:'expense', signed_minor:-125, occurred_on:'2026-11-12', note:'synthetic expense'} :
        {account_id:accountId};
      await controller.enqueue({schema_version:2, client_mutation_id:crypto.randomUUID(),
        base_revision:current.cloud.revision, action,
        expected_entity_revisions:{[accountId]:account.entity_revision}, payload});
      outcomes.push((await controller.dispatchOnce()).status);
      await controller.refresh();
    }
    const final = await controller.read();
    return {outcomes, account:final.cloud.entities.find(entity => entity.id === accountId),
      pending:final.outbox.length};
  }, {accountId});
  expect(later.outcomes).toEqual(Array(4).fill('DURABLY_CONFIRMED'));
  expect(later.pending).toBe(0);
  expect(later.account.data).toMatchObject({name:'synthetic edited', type:'bank', balance_minor:375, archived_at:null});
  const oldProfile = (await state(context)).body.profile_id;
  const switched = await context.request.post('/__e2e__/personal-session');
  expect(switched.status()).toBe(200);
  const newActor = (await switched.json()).user.id;
  expect(newActor).not.toBe(actor);
  const newProfile = await bootstrap(context);
  expect(newProfile).not.toBe(oldProfile);
  const denied = await context.request.get('/api/finance/v1/state', {
    headers:{'X-FH-Expected-Profile':oldProfile},
  });
  expect(denied.status()).toBe(403);
  const deniedWrite = await context.request.post('/api/finance/v2/commands', {
    headers:{'Origin':ORIGIN, 'X-FH-Expected-Profile':oldProfile}, data:{},
  });
  expect(deniedWrite.status()).toBe(403);
  expect(await page.evaluate(async () => {
    try { await globalThis.__controller68.dispatchOnce(); return false; } catch { return true; }
  })).toBe(true);
  const afterSwitch = await state(context);
  expect(afterSwitch.body.entities).toEqual([]);
});

test('#68 user resolves semantic conflict only after a durable server cancellation', async ({browser}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  // This single fault-construction test injects ES modules through Playwright;
  // WebKit service workers bypass route interception. The surrounding #68
  // browser suite separately exercises the real installed service worker.
  const context = await browser.newContext({serviceWorkers:'block'});
  const page = await context.newPage();
  await context.route('**/__e2e_138_*.js', route => route.fulfill({
    status:200, contentType:'text/javascript',
    body:testModuleSources.get(new URL(route.request().url()).pathname),
    headers:{'Cache-Control':'no-store'},
  }));
  const login = await context.request.post('/__e2e__/personal-session');
  const actor = (await login.json()).user.id;
  await bootstrap(context);
  const accountId = randomUUID(), initial = await state(context);
  expect((await submit(context, initial, 'account.create', {id:accountId,
    name:'Synthetic conflict account', kind:'cash', currency:'RUB', opening_minor:500})).status()).toBe(201);
  const current = await state(context);
  expect((await submit(context, current, 'account.archive', {account_id:accountId},
    {[accountId]:entity(current, accountId).entity_revision})).status()).toBe(201);
  await page.goto('/');
  await openAccounts(page);
  await page.getByRole('button', {name:'Офлайн-синхронизация'}).click();
  const phrase = 'synthetic semantic conflict phrase sixty eight';
  await page.getByLabel('Парольная фраза', {exact:true}).fill(phrase);
  await page.getByRole('button', {name:'Создать копию'}).click();
  await page.getByLabel('Я сохранил ключ вне браузера').check();
  await page.getByRole('button', {name:'Разблокировать'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible();
  const mutation = await page.evaluate(async ({actor, accountId, phrase}) => {
    const atomic = await import('/__e2e_138_atomic__.js');
    const {LocalBudgetSession} = await import('/__e2e_138_session__.js');
    const outbox = await import('/__e2e_138_outbox__.js');
    const scope = 'account:' + actor, session = new LocalBudgetSession();
    session.selectScope(scope);
    await session.unlock(await atomic.getAtomicEncryptedKeyset(scope), {passphrase:phrase});
    const bundle = await atomic.readAtomicEncryptedCandidate(scope, session);
    const cloud = bundle.snapshot.cloudFinance, account = cloud.entities.find(x => x.id === accountId);
    const identity = {scope, profileId:cloud.profileId, epoch:cloud.epoch,
      generation:session.lifecycleVersion, signal:session.lifecycleSignal};
    const id = crypto.randomUUID();
    await outbox.enqueueEncryptedFinanceCommandCandidate({scope, session, identity,
      expectedEpoch:bundle.epoch, ifMatch:cloud.serverEtag,
      command:{schema_version:2, client_mutation_id:id, base_revision:cloud.revision,
        action:'account.archive', expected_entity_revisions:{[accountId]:account.entity_revision},
        payload:{account_id:accountId}}});
    const channel = new BroadcastChannel('fh-finance-sync-v1');
    channel.postMessage('changed'); channel.close(); session.logout();
    return id;
  }, {actor, accountId, phrase});
  await expect(page.getByText('Конфликт', {exact:true})).toBeVisible({timeout:30_000});
  await page.getByRole('button', {name:'Обновить с сервера'}).click();
  await page.getByRole('button', {name:'Принять серверную версию'}).click();
  await expect(page.getByText('Синхронизировано', {exact:true})).toBeVisible({timeout:30_000});
  const server = await state(context);
  expect(entity(server, accountId).data.archived_at).not.toBeNull();
  const proof = await page.evaluate(async ({actor, phrase, mutation}) => {
    const atomic = await import('/__e2e_138_atomic__.js');
    const {LocalBudgetSession} = await import('/__e2e_138_session__.js');
    const scope = 'account:' + actor, session = new LocalBudgetSession();
    session.selectScope(scope);
    await session.unlock(await atomic.getAtomicEncryptedKeyset(scope), {passphrase:phrase});
    const bundle = await atomic.readAtomicEncryptedCandidate(scope, session);
    const saved = bundle.conflicts.find(x => x.original?.mutationId === mutation);
    session.logout();
    return {pending:bundle.outbox.length, choice:saved?.choice, original:saved?.original?.mutationId};
  }, {actor, phrase, mutation});
  expect(proof).toEqual({pending:0, choice:'ACCEPT_SERVER', original:mutation});
  await context.close();
});

test('#68 semantic conflict is released only after the server fences the original UUID', async ({page, context}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  await context.route('**/__e2e_138_*.js', route => route.fulfill({
    status:200, contentType:'text/javascript',
    body:testModuleSources.get(new URL(route.request().url()).pathname),
    headers:{'Cache-Control':'no-store'},
  }));
  const login = await context.request.post('/__e2e__/personal-session');
  const actor = (await login.json()).user.id;
  await bootstrap(context);
  const accountId = randomUUID(), initial = await state(context);
  expect((await submit(context, initial, 'account.create', {id:accountId, name:'Synthetic held account',
    kind:'cash', currency:'RUB', opening_minor:500})).status()).toBe(201);
  const current = await state(context);
  expect((await submit(context, current, 'account.archive', {account_id:accountId},
    {[accountId]:entity(current, accountId).entity_revision})).status()).toBe(201);
  await page.goto('/__e2e__/ready');
  const result = await page.evaluate(async ({actor, accountId}) => {
    const {FinanceSyncController} = await import('/__e2e_138_controller__.js');
    const controller = new FinanceSyncController({verifiedActorUserId:actor, origin:location.origin});
    await controller.createLocal('synthetic cancellation phrase issue sixty eight', true);
    const opened = await controller.unlock({passphrase:'synthetic cancellation phrase issue sixty eight'});
    const account = opened.cloud.entities.find(item => item.id === accountId);
    const command = {schema_version:2, client_mutation_id:crypto.randomUUID(),
      base_revision:opened.cloud.revision, action:'account.archive',
      expected_entity_revisions:{[accountId]:account.entity_revision}, payload:{account_id:accountId}};
    await controller.enqueue(command);
    const held = await controller.dispatchOnce();
    const refreshed = await controller.refresh();
    const decision = await controller.resolve({mutationId:command.client_mutation_id,
      observedRevision:refreshed.cloud.revision, choice:'ACCEPT_SERVER', explicitUserChoice:true});
    const after = await controller.read();
    controller.close();
    return {held:held.status, decision:decision.status, pending:after.outbox.length,
      original:after.conflicts[0].original.command, etag:opened.cloud.serverEtag};
  }, {actor, accountId});
  expect(result.held).toBe('CONFLICT_HOLD');
  expect(result.decision).toBe('CONFLICT_RESOLVED');
  expect(result.pending).toBe(0);
  const replay = await context.request.post('/api/finance/v2/commands', {data:result.original,
    headers:{'Origin':ORIGIN, 'If-Match':result.etag, 'Idempotency-Key':result.original.client_mutation_id}});
  expect(replay.status()).toBe(409);
  expect((await replay.json()).code).toBe('command_cancelled');
});

test('#68 committed command remains queued when compacted history prevents verification', async ({page, context}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  await context.route('**/__e2e_138_*.js', route => route.fulfill({
    status:200, contentType:'text/javascript',
    body:testModuleSources.get(new URL(route.request().url()).pathname),
    headers:{'Cache-Control':'no-store'},
  }));
  const login = await context.request.post('/__e2e__/personal-session');
  const actor = (await login.json()).user.id;
  await page.goto('/__e2e__/ready');
  const accountId = randomUUID();
  const result = await page.evaluate(async ({actor, accountId}) => {
    const {FinanceSyncController} = await import('/__e2e_138_controller__.js');
    const transport = (url, options) => String(url).includes('/api/finance/v1/changes?')
      ? Promise.resolve(new Response(JSON.stringify({code:'snapshot_required'}),
        {status:410, headers:{'Content-Type':'application/json'}})) : fetch(url, options);
    const controller = new FinanceSyncController({verifiedActorUserId:actor, origin:location.origin,
      fetchImpl:transport});
    await controller.createLocal('synthetic committed phrase issue sixty eight', true);
    const opened = await controller.unlock({passphrase:'synthetic committed phrase issue sixty eight'});
    const command = {schema_version:2, client_mutation_id:crypto.randomUUID(),
      base_revision:opened.cloud.revision, action:'account.create', expected_entity_revisions:{},
      payload:{id:accountId, name:'Synthetic already committed', kind:'cash', currency:'RUB', opening_minor:500}};
    await controller.enqueue(command);
    const held = await controller.dispatchOnce();
    const refreshed = await controller.refresh();
    let refused = false;
    try { await controller.resolve({mutationId:command.client_mutation_id,
      observedRevision:refreshed.cloud.revision, choice:'ACCEPT_SERVER', explicitUserChoice:true}); }
    catch {refused = true;}
    const after = await controller.read();
    controller.close();
    return {held:held.status, refused, pending:after.outbox.length,
      conflict:after.conflicts[0].httpStatus};
  }, {actor, accountId});
  expect(result).toEqual({held:'SNAPSHOT_REQUIRED_HOLD', refused:true, pending:1, conflict:410});
  const server = await state(context);
  expect(server.body.entities.filter(item => item.id === accountId)).toHaveLength(1);
});

test('#68 queued v1 transfer reconciles with the real server and replay is idempotent', async ({page, context}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  await context.route('**/__e2e_138_*.js', route => route.fulfill({
    status: 200, contentType: 'text/javascript',
    body: testModuleSources.get(new URL(route.request().url()).pathname),
    headers: {'Cache-Control': 'no-store'},
  }));
  expect((await context.request.post('/__e2e__/personal-session')).status()).toBe(200);
  await page.goto('/__e2e__/ready');
  const profile = await bootstrap(context);
  const one = randomUUID(), two = randomUUID(), mutation = randomUUID();
  const initial = await state(context);
  expect((await submit(context, initial, 'account.create', {id: one, name: 'synthetic one',
    kind: 'bank', currency: 'RUB', opening_minor: 5000})).status()).toBe(201);
  const next = await state(context);
  expect((await submit(context, next, 'account.create', {id: two, name: 'synthetic two',
    kind: 'cash', currency: 'RUB', opening_minor: 0})).status()).toBe(201);
  const before = await state(context);
  const versions = {[one]: entity(before, one).entity_revision, [two]: entity(before, two).entity_revision};
  const payload = {from_account_id: one, to_account_id: two, amount_minor: 1200, occurred_on: month};
  const result = await page.evaluate(async ({profile, before, versions, payload, mutation}) => {
    const atomic = await import('/__e2e_138_atomic__.js');
    const {LocalBudgetSession} = await import('/__e2e_138_session__.js');
    const cache = await import('/__e2e_138_cache__.js');
    const outbox = await import('/__e2e_138_outbox__.js');
    const dispatch = await import('/__e2e_138_dispatch__.js');
    const me = await (await fetch('/api/auth/email/me', {credentials: 'same-origin'})).json();
    const scope = 'account:' + me.user.id;
    const passphrase = 'synthetic transfer phrase for issue 68';
    await atomic.createAtomicEncryptedCandidate(scope, passphrase,
      {snapshot: {version: 2, revision: 0}, outbox: [], conflicts: []}, 2);
    const session = new LocalBudgetSession(); session.selectScope(scope);
    await session.unlock(await atomic.getAtomicEncryptedKeyset(scope), {passphrase});
    const identity = {scope, profileId: profile, generation: session.lifecycleVersion,
      epoch: 'e'.repeat(32), signal: session.lifecycleSignal};
    await cache.initializeEncryptedCloudCacheCandidate({scope, session, identity,
      pages: [{cursorSent: null, body: before.body}], etag: before.etag,
      expectedEpoch: 0, confirmedAccountCacheInitialization: true});
    let staleRejected = false;
    try {
      await outbox.enqueueEncryptedFinanceCommandCandidate({scope, session, identity, expectedEpoch: 1,
        ifMatch: before.etag, command: {schema_version: 1, client_mutation_id: mutation,
          base_revision: before.revision, action: 'account.transfer',
          expected_entity_revisions: {...versions, [payload.from_account_id]: versions[payload.from_account_id] + 1}, payload}});
    } catch { staleRejected = true; }
    await outbox.enqueueEncryptedFinanceCommandCandidate({scope, session, identity, expectedEpoch: 1,
      ifMatch: before.etag, command: {schema_version: 1, client_mutation_id: mutation,
        base_revision: before.revision, action: 'account.transfer', expected_entity_revisions: versions, payload}});
    let corruptStage = 0, rejected = false;
    const transport = async (url, options) => {
      const response = await fetch(url, options);
      const corruptReceipt = corruptStage === 0 && url.endsWith('/api/finance/v1/commands') && response.status === 201;
      const corruptDelta = corruptStage === 1 && url.includes('/api/finance/v1/changes?') && response.status === 200;
      if (corruptReceipt || corruptDelta) {
        corruptStage += 1;
        const body = await response.json();
        body.changes[0].payload.amount_minor += 1;
        return new Response(JSON.stringify(body), {status: response.status,
          headers: {'Content-Type': 'application/json'}});
      }
      return response;
    };
    try {
      await dispatch.dispatchOneEncryptedFinanceCommandCandidate({scope, session, identity,
        expectedEpoch: 2, origin: location.origin, explicitNetworkCandidateConsent: true,
        fetchImpl: transport});
    } catch { rejected = true; }
    const held = await atomic.readAtomicEncryptedCandidate(scope, session);
    const sent = await dispatch.dispatchOneEncryptedFinanceCommandCandidate({scope, session, identity,
      expectedEpoch: held.epoch, origin: location.origin, explicitNetworkCandidateConsent: true,
      fetchImpl: transport});
    const saved = await atomic.readAtomicEncryptedCandidate(scope, session);
    session.logout();
    return {status: sent.status, staleRejected, rejected, held: held.outbox.length, pending: saved.outbox.length,
      revision: saved.snapshot.cloudFinance.revision, proof: saved.snapshot.cloudFinance.appliedReceipts.length};
  }, {profile, before, versions, payload, mutation});
  expect(result).toEqual({status: 'DURABLY_CONFIRMED', staleRejected: true, rejected: true, held: 1,
    pending: 0, revision: 3, proof: 1});
  expect((await submit(context, before, 'account.transfer', payload, versions, 1, mutation)).status()).toBe(200);
  const final = await state(context);
  expect(final.revision).toBe(3);
  expect(entity(final, one).data.balance_minor).toBe(3800);
  expect(entity(final, two).data.balance_minor).toBe(1200);
});

for (const choice of ['ACCEPT_SERVER', 'REAPPLY']) test(`#68 real PostgreSQL stale command resolution: ${choice}`, async ({page, context}) => {
  test.setTimeout(120_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  await context.route('**/__e2e_138_*.js', route => route.fulfill({
    status: 200, contentType: 'text/javascript',
    body: testModuleSources.get(new URL(route.request().url()).pathname),
    headers: {'Cache-Control': 'no-store'},
  }));
  expect((await context.request.post('/__e2e__/personal-session')).status()).toBe(200);
  await page.goto('/__e2e__/ready');
  const profile = await bootstrap(context);
  const initial = await state(context);
  const pendingId = randomUUID(), accountId = randomUUID(), replacementId = randomUUID();
  await page.evaluate(async ({profile, initial, pendingId, accountId}) => {
    const atomic = await import('/__e2e_138_atomic__.js');
    const {LocalBudgetSession} = await import('/__e2e_138_session__.js');
    const cache = await import('/__e2e_138_cache__.js');
    const outbox = await import('/__e2e_138_outbox__.js');
    const me = await (await fetch('/api/auth/email/me', {credentials: 'same-origin'})).json();
    const scope = 'account:' + me.user.id;
    const passphrase = 'synthetic recovery phrase for issue 68';
    await atomic.createAtomicEncryptedCandidate(scope, passphrase,
      {snapshot: {version: 2, revision: 0}, outbox: [], conflicts: []}, 2);
    const session = new LocalBudgetSession(); session.selectScope(scope);
    await session.unlock(await atomic.getAtomicEncryptedKeyset(scope), {passphrase});
    const identity = {scope, profileId: profile, generation: session.lifecycleVersion,
      epoch: 'e'.repeat(32), signal: session.lifecycleSignal};
    await cache.initializeEncryptedCloudCacheCandidate({scope, session, identity,
      pages: [{cursorSent: null, body: initial.body}], etag: initial.etag, expectedEpoch: 0,
      confirmedAccountCacheInitialization: true});
    await outbox.enqueueEncryptedFinanceCommandCandidate({scope, session, identity,
      expectedEpoch: 1, ifMatch: initial.etag,
      command: {schema_version: 2, client_mutation_id: pendingId, base_revision: initial.revision,
        action: 'account.create', expected_entity_revisions: {},
        payload: {id: accountId, name: 'synthetic offline', kind: 'cash', currency: 'RUB', opening_minor: 100}}});
    globalThis.__real68 = {scope, session, identity, atomic, cache, outbox};
  }, {profile, initial, pendingId, accountId});
  const otherId = randomUUID();
  expect((await submit(context, initial, 'account.create', {
    id: otherId, name: 'synthetic server', kind: 'bank', currency: 'RUB', opening_minor: 200,
  })).status()).toBe(201);
  const result = await page.evaluate(async ({pendingId, replacementId, accountId, choice}) => {
    const {scope, session, identity, atomic, cache, outbox} = globalThis.__real68;
    const {dispatchOneEncryptedFinanceCommandCandidate} = await import('/__e2e_138_dispatch__.js');
    const {downloadVerifiedFinanceSnapshotCandidate} = await import('/__e2e_138_pull__.js');
    const held = await dispatchOneEncryptedFinanceCommandCandidate({scope, session, identity,
      expectedEpoch: 2, origin: location.origin, explicitNetworkCandidateConsent: true});
    const pulled = await downloadVerifiedFinanceSnapshotCandidate({scope, session, identity,
      origin: location.origin, explicitReadConsent: true});
    await cache.refreshEncryptedCloudSnapshot({scope, session, identity, pages: pulled.pages,
      etag: pulled.etag, expectedEpoch: held.bundleEpoch});
    const before = await atomic.readAtomicEncryptedCandidate(scope, session);
    const resolved = await outbox.resolveStaleFinanceConflict({scope, session, identity,
      expectedEpoch: before.epoch, mutationId: pendingId, observedRevision: pulled.serverRevision,
      choice, explicitUserChoice: true,
      ...(choice === 'REAPPLY' ? {replacementCommand: {
        schema_version: 2, client_mutation_id: replacementId, base_revision: pulled.serverRevision,
        action: 'account.create', expected_entity_revisions: {},
        payload: {id: accountId, name: 'synthetic offline', kind: 'cash', currency: 'RUB', opening_minor: 100},
      }} : {})});
    let sent = null;
    if (choice === 'REAPPLY') {
      sent = await dispatchOneEncryptedFinanceCommandCandidate({scope, session, identity,
        expectedEpoch: resolved.bundleEpoch, origin: location.origin, explicitNetworkCandidateConsent: true});
    }
    const after = await atomic.readAtomicEncryptedCandidate(scope, session);
    session.logout();
    return {held: held.status, resolved: resolved.status, pending: after.outbox.length,
      preserved: after.conflicts[0].original.mutationId === pendingId,
      code: after.conflicts[0].verifiedStaleRevision, revision: after.snapshot.cloudFinance.revision,
      sent: sent?.status ?? null};
  }, {pendingId, replacementId, accountId, choice});
  expect(result).toEqual({held: 'CONFLICT_HOLD', resolved: 'CONFLICT_RESOLVED',
    pending: 0, preserved: true, code: 1, revision: choice === 'REAPPLY' ? 2 : 1,
    sent: choice === 'REAPPLY' ? 'DURABLY_CONFIRMED' : null});
  const final = await state(context);
  expect(final.body.entities.filter(x => x.id === accountId).length).toBe(choice === 'REAPPLY' ? 1 : 0);
  expect(final.body.entities.some(x => x.id === otherId)).toBe(true);
});

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

test('#138 online payment center survives a lost response and synchronizes two devices', async ({page, context, browser}) => {
  test.setTimeout(45_000);
  if (process.env.FH_E2E_REAL_FINANCE !== 'yes') test.skip();
  const second = await browser.newContext();
  const other = await second.newPage();
  const exceptions = [];
  page.on('pageerror', error => exceptions.push(error.message));
  other.on('pageerror', error => exceptions.push(error.message));
  try {
    await page.clock.setFixedTime(new Date('2026-11-12T12:00:00'));
    await other.clock.setFixedTime(new Date('2026-11-12T12:00:00'));
    // Send the real request, then lose the response at the browser boundary.
    // Unlike network routing this also works when WebKit has a Service Worker.
    await page.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await nativeFetch(input, init);
        if (window.__fhLoseNextPayment && String(input).includes('/api/finance/v2/commands') && init?.method === 'POST') {
          window.__fhLoseNextPayment = false;
          if (response.status !== 201) throw Error('Expected committed synthetic payment');
          throw new TypeError('Synthetic lost response after server commit');
        }
        return response;
      };
    });
    const created = await context.request.post('/__e2e__/personal-session');
    expect(created.status()).toBe(200);
    const owner = (await created.json()).user;
    await page.goto('/?fh_reserves_e2e=1');
    await loginViaUi(other, owner.email);
    await other.goto('/?fh_reserves_e2e=1');
    const profile = await bootstrap(context);
    expect(await bootstrap(second)).toBe(profile);
    const accountId = randomUUID();
    let current = await state(context);
    expect((await submit(context, current, 'account.create', {
      id: accountId, name: 'Синтетический счёт оплаты', kind: 'bank', currency: 'RUB', opening_minor: 10000,
    })).status()).toBe(201);
    const openDue = async target => {
      await view(target, 'obligations');
      await target.locator('.fh-reserve-tabs').first().getByRole('button', {name:'К оплате'}).click();
      await expect(target.getByRole('button', {name:'В аккаунте'})).toHaveAttribute('aria-pressed','true');
    };
    await openDue(page);
    await expect(page.locator('#storage-context-chip')).toHaveText('На сервере');
    await page.getByRole('button',{name:'На устройстве'}).click();
    await expect(page.locator('#storage-context-chip')).toHaveText('Локально');
    await page.getByRole('button',{name:'В аккаунте'}).click();
    await expect(page.locator('#storage-context-chip')).toHaveText('На сервере');
    await page.getByRole('button',{name:'Добавить обязательство в аккаунт'}).click();
    const create = page.locator('form').filter({has:page.getByRole('heading',{name:'Новое обязательство'})});
    await create.getByLabel('Название').fill('Синтетическая синхронизированная оплата');
    await create.getByLabel('Сумма, ₽').fill('55');
    await create.getByLabel('Повторять').selectOption('none');
    await create.getByRole('button',{name:'Сохранить обязательство'}).click();
    await expect(create).toHaveCount(0);
    expect((await state(context)).body.entities.filter(e=>e.kind==='obligation')).toHaveLength(1);
    await openDue(other);
    const card = target => target.locator('[data-server-payment-id]').filter({hasText:'Синтетическая синхронизированная оплата'});
    await expect(card(page)).toContainText('55');
    await expect(card(other)).toContainText('55');
    await card(other).getByRole('button',{name:'Отметить оплату'}).click();
    await card(other).getByLabel('Сумма, ₽').fill('50');
    await card(page).getByRole('button',{name:'Отметить оплату'}).click();
    await card(page).getByLabel('Сумма, ₽').fill('20');
    await context.setOffline(true);
    await card(page).getByRole('button',{name:'Подтвердить оплату'}).click();
    await expect(page.getByRole('alert')).toContainText('недоступен');
    expect((await state(second)).body.entities.filter(e=>e.kind==='settlement')).toHaveLength(0);
    await context.setOffline(false);
    await page.evaluate(() => { window.__fhLoseNextPayment = true; });
    await card(page).getByRole('button',{name:'Подтвердить оплату'}).dblclick();
    await expect(page.getByRole('button',{name:'Сверить оплату'})).toBeVisible();
    expect(entity(await state(second),accountId).data.balance_minor).toBe(8000);
    await page.reload();
    await openDue(page);
    await page.getByRole('button',{name:'Сверить оплату'}).click();
    await expect(page.getByRole('button',{name:'Сверить оплату'})).toHaveCount(0);
    await expect(card(page)).toContainText('35');
    await view(page,'overview');
    await expect(page.locator('#storage-context-chip')).toHaveText('На сервере');
    await expect(page.locator('.kpi-grid')).toContainText(/Оплачено:.*20/);
    await view(page,'calendar');
    await expect(page.locator('#storage-context-chip')).toHaveText('На сервере');
    await page.locator('.cal-day[data-date="2026-11-12"]').click();
    await expect(page.locator('.cal-layout .plain-list')).toContainText('Синтетическая синхронизированная оплата');
    await expect(page.locator('.cal-layout .plain-list')).toContainText('факт 20');
    await expect(page.locator('.cal-layout')).toContainText(/Подтверждённый поток:.*20/);
    await page.getByRole('button',{name:'Открыть центр оплат: Синтетическая синхронизированная оплата'}).click();
    await expect(card(page)).toContainText('35');
    // The other device still has a stale larger tranche; it cannot overpay.
    await card(other).locator('form').evaluate(form => form.requestSubmit());
    await expect(other.getByRole('alert')).toContainText('Данные изменились');
    await expect(other.getByRole('button',{name:'Сверить оплату'})).toHaveCount(0);
    expect(entity(await state(second),accountId).data.balance_minor).toBe(8000);
    await other.reload();
    await openDue(other);
    await expect(card(other)).toContainText('35');
    await card(other).getByRole('button',{name:'Отметить оплату'}).click();
    await expect(card(other).getByLabel('Сумма, ₽')).toHaveValue('35.00');
    await card(other).getByRole('button',{name:'Подтвердить оплату'}).click();
    await expect(card(other)).toHaveCount(0);
    await page.reload();
    await openDue(page);
    await expect(card(page)).toHaveCount(0);
    // A lost reply during cancellation is reconciled with the same mutation.
    const history = other.getByRole('region',{name:'История оплат аккаунта'});
    const lastPayment = history.locator('article').filter({hasText:'35'});
    await other.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await nativeFetch(input, init);
        if (window.__fhLoseNextPayment && String(input).includes('/api/finance/v2/commands') && init?.method === 'POST') {
          window.__fhLoseNextPayment = false;
          if (response.status !== 201) throw Error('Expected committed synthetic reversal');
          throw new TypeError('Synthetic lost response after server commit');
        }
        return response;
      };
    });
    await other.reload();
    await openDue(other);
    await other.evaluate(() => { window.__fhLoseNextPayment = true; });
    await expect(lastPayment).toHaveCount(1);
    await expect(lastPayment.getByRole('button',{name:'Отменить оплату'})).toBeEnabled();
    other.once('dialog', dialog => dialog.accept());
    await lastPayment.getByRole('button',{name:'Отменить оплату'}).click();
    await expect(other.getByRole('button',{name:'Сверить оплату'})).toBeVisible();
    expect(entity(await state(context),accountId).data.balance_minor).toBe(8000);
    await other.reload();
    await openDue(other);
    await other.getByRole('button',{name:'Сверить оплату'}).click();
    await expect(other.getByRole('button',{name:'Сверить оплату'})).toHaveCount(0);
    await expect(card(other)).toContainText('35');
    await card(other).getByRole('button',{name:'Отметить оплату'}).click();
    await card(other).getByRole('button',{name:'Подтвердить оплату'}).click();
    await expect(card(other)).toHaveCount(0);
    await page.reload();
    await openDue(page);
    await expect(card(page)).toHaveCount(0);
    const final = await state(context);
    expect(entity(final,accountId).data.balance_minor).toBe(4500);
    expect(final.body.entities.filter(e=>e.kind==='settlement')).toHaveLength(3);
    expect(final.body.entities.filter(e=>e.kind==='settlement' && e.data.voided_at)).toHaveLength(1);
    expect(final.body.entities.filter(e=>e.kind==='transaction')).toHaveLength(4);
    // In-memory profile reuse must not outlive the real authenticated session.
    const logout = await context.request.post('/api/auth/email/logout', {
      headers:{Origin:ORIGIN,'Content-Type':'application/json'}, data:{},
    });
    expect(logout.status()).toBe(200);
    await page.locator('.sidebar-nav [data-view="overview"]').evaluate(button => button.click());
    await expect.poll(async () => page.url().includes('/account.html') ||
      await page.getByRole('alert').filter({hasText:'Не удалось загрузить обзор аккаунта'}).isVisible()).toBe(true);
    expect((await second.request.get(ORIGIN + '/api/finance/v1/state')).status()).toBe(200);
    expect(exceptions).toEqual([]);
  } finally {
    await second.close();
  }
});
