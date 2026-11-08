import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  readBankCsv, readBankStatementFile, suggestColumnMapping, normalizeBankStatement,
  reconcileBankStatement, draftBankImportBatch, draftBankImportUndo,
  projectAccountBalances, summarizeBankImportAudit,
} from '../src/importers/bank-statements/index.ts';

const encoder = new TextEncoder();
const accounts = [
  { id: 'checking', name: 'Основной', aliases: ['**1234'], currency: 'RUB' },
  { id: 'savings', name: 'Накопительный', currency: 'RUB' },
];
const input = (value) => encoder.encode(value);
const base = 'Дата;Сумма;Описание;Счёт;Счёт назначения;Тип;Категория;ID\n';
async function previewOf(csv, overrides = {}) {
  const table = await readBankStatementFile(input(csv), { filename: 'synthetic.csv' });
  const proposed = suggestColumnMapping(table.headers);
  assert.equal(proposed.warnings.length, 0);
  const preview = await normalizeBankStatement(table, {
    mapping: proposed.mapping, accounts, categories: ['Питание', 'Зарплата'],
    ...overrides,
  });
  return { table, preview };
}
const operationAt = (p, i) => p.rows[i].operation;

test('CSV delimiter sniffing, quotes/newlines, Excel sep marker and all rows', () => {
  const csv = 'sep=;\nДата;Сумма;Описание\n07.11.2026;-12,50;"Магазин;\nотдел ""дом"""\n08.11.2026;5,00;Возврат\n';
  const result = readBankCsv(input(csv));
  assert.equal(result.delimiter, ';');
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].cells[2], 'Магазин;\nотдел "дом"');
  assert.equal(result.rows[1].cells[0], '08.11.2026');
  const tab = readBankCsv(input('Date\tAmount\tDescription\n2026-11-07\t-2.50\tCoffee'));
  assert.equal(tab.delimiter, '\t');
  const pipe = readBankCsv(input('Date|Amount|Memo\n2026-11-07|-5|Bus'));
  assert.equal(pipe.delimiter, '|');
  const comma = readBankCsv(input('Date,Amount,Memo\n2026-11-07,-15.20,"a,b"'));
  assert.equal(comma.delimiter, ',');
});

test('UTF-8 BOM, UTF-16LE BOM, Windows-1251 autodetection and override', () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...input('Date;Amount\n2026-11-07;-2')]);
  assert.equal(readBankCsv(bom).headers[0], 'Date');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Дата;Сумма\n07.11.2026;-1,50', 'utf16le')]);
  assert.deepEqual(readBankCsv(utf16).headers, ['Дата', 'Сумма']);
  const cp1251 = Buffer.concat([
    Buffer.from('c4e0f2e03bd1f3ecece00a', 'hex'),
    Buffer.from('07.11.2026;-1,50', 'ascii'),
  ]);
  assert.deepEqual(readBankCsv(cp1251).headers, ['Дата', 'Сумма']);
  assert.deepEqual(readBankCsv(cp1251, { encoding: 'windows-1251' }).headers, ['Дата', 'Сумма']);
  assert.throws(() => readBankCsv(cp1251, { encoding: 'utf-8' }), /кодировка/);
});

test('integer RUB cents for negatives, regional grouping and explicit type', async () => {
  const csv = base +
    '07.11.2026;-1 234,56;Магазин;Основной;;расход;Питание;A1\n' +
    '08.11.2026;1,234.50;Оклад;Основной;;доход;Зарплата;A2\n' +
    '09.11.2026;2.345,67;Оклад2;Основной;;доход;Зарплата;A3\n';
  const { preview } = await previewOf(csv);
  assert.equal(preview.accepted, 3);
  assert.equal(preview.rejected, 0);
  assert.equal(preview.outflowCents, 123456);
  assert.equal(preview.inflowCents, 123450 + 234567);
  assert.equal(operationAt(preview, 0).kind, 'expense');
  assert.equal(operationAt(preview, 0).amountCents, 123456);
  assert.equal(operationAt(preview, 1).date, '2026-11-08');
  assert.equal(operationAt(preview, 2).externalId, 'A3');
});

test('ambiguous dates and numbers fail closed until disambiguated', async () => {
  const raw = base + '02/03/2026;1,234;???;Основной;;доход;Зарплата;A1\n';
  const { preview: bad } = await previewOf(raw);
  assert.equal(bad.accepted, 0);
  assert.equal(bad.rejected, 1);
  assert.ok(bad.rows[0].warnings.some(x => x.code === 'AMBIGUOUS_DATE'));
  assert.ok(bad.rows[0].warnings.some(x => x.code === 'AMBIGUOUS_AMOUNT'));
  const { preview: good } = await previewOf(raw, {
    dateOrder: 'DMY', numberFormat: 'comma-decimal',
  });
  assert.equal(good.accepted, 0);
  assert.equal(good.rows[0].warnings.some(x => x.code === 'INVALID_AMOUNT'), true);
  const { preview: grouped } = await previewOf(raw, {
    dateOrder: 'DMY', numberFormat: 'dot-decimal',
  });
  assert.equal(grouped.accepted, 1);
  assert.equal(operationAt(grouped, 0).date, '2026-03-02');
  assert.equal(operationAt(grouped, 0).amountCents, 123400);
});

test('calendar boundaries, overflow, empty amounts and invalid accounts/categories', async () => {
  const raw = base +
    '29.02.2025;100;A;Основной;;доход;Зарплата;1\n' +
    '28.02.2026;900719925474099;B;Основной;;доход;Зарплата;2\n' +
    '01.03.2026;200;C;Чужой;;доход;Зарплата;3\n' +
    '01.03.2026;200;D;Основной;;доход;Неизвестная;4\n' +
    '01.03.2026;0;E;Основной;;доход;Зарплата;5\n';
  const { preview } = await previewOf(raw);
  assert.equal(preview.accepted, 0);
  assert.equal(preview.rejected, 5);
  const codes = preview.rows.flatMap(x => x.warnings.map(w => w.code));
  for (const code of ['INVALID_DATE', 'AMOUNT_OVERFLOW', 'UNKNOWN_ACCOUNT', 'UNKNOWN_CATEGORY', 'ZERO_AMOUNT']) {
    assert.ok(codes.includes(code), code);
  }
});

test('valid internal transfer has 2 balanced legs but no income or expense', async () => {
  const { preview } = await previewOf(base +
    '07.11.2026;-500,00;Между счетами;Основной;Накопительный;перевод;;tr1\n');
  assert.equal(preview.accepted, 1);
  assert.equal(preview.transfersCents, 50000);
  assert.equal(preview.inflowCents + preview.outflowCents, 0);
  const reconciled = reconcileBankStatement(preview, []);
  const key = operationAt(preview, 0).sourceKey;
  const batch = await draftBankImportBatch(reconciled, [key]);
  const balances = projectAccountBalances(batch, [
    { accountId: 'checking', currentCents: 100000, statementClosingCents: 50000 },
    { accountId: 'savings', currentCents: 20000, statementClosingCents: 70000 },
  ]);
  assert.deepEqual(balances.map(x => x.projectedCents), [50000, 70000]);
  assert.deepEqual(balances.map(x => x.discrepancyCents), [0, 0]);
  assert.equal(balances.reduce((sum, x) => sum + x.deltaCents, 0), 0);
  const pending = await previewOf(base +
    '07.11.2026;-500,00;Ошибка;Основной;;перевод;;tr1\n');
  assert.equal(pending.preview.rejected, 1);
  assert.equal(pending.preview.rows[0].warnings[0].code, 'ACCOUNT_REQUIRED');
});

test('manual selection, same-file replay, overlapping exports, possible duplicates and full undo', async () => {
  const source = base + [
    '07.11.2026;-100,00;Покупка;Основной;;расход;Питание;TX1',
    '08.11.2026;-200,00;Покупка;Основной;;расход;Питание;TX2',
  ].join('\n') + '\n';
  const { preview } = await previewOf(source);
  const first = reconcileBankStatement(preview, []);
  assert.equal(first.ready, 2);
  const keys = preview.rows.map(x => x.operation.sourceKey);
  const batch = await draftBankImportBatch(first, keys);
  assert.deepEqual(batch.sourceKeys, [...keys].sort());
  assert.equal(batch.journal.length, 2);
  const existing = batch.operations.map((x, i) => ({
    id: String(i + 1), accountId: x.accountId, date: x.date,
    amountCents: x.amountCents, description: x.description,
    kind: x.kind, sourceKey: x.sourceKey, fingerprint: x.fingerprint,
    externalId: x.externalId, targetAccountId: x.targetAccountId,
    category: x.category, currency: x.currency, importBatchKey: batch.batchKey,
  }));
  const replay = reconcileBankStatement(preview, existing);
  assert.equal(replay.duplicates, 2);
  await assert.rejects(draftBankImportBatch(replay, keys));
  const later = await previewOf(base +
    '08.11.2026;-200,00;Покупка;Основной;;расход;Питание;TX2\n' +
    '09.11.2026;-300,00;Покупка;Основной;;расход;Питание;TX3\n');
  const partial = reconcileBankStatement(later.preview, existing);
  assert.equal(partial.duplicates, 1);
  assert.equal(partial.ready, 1);
  const newRow = partial.rows.find(x => x.status === 'ready');
  assert.ok(newRow?.operation);
  const secondBatch = await draftBankImportBatch(partial, [newRow.operation.sourceKey]);
  assert.equal(secondBatch.operations.length, 1);
  const undo = draftBankImportUndo(batch, existing);
  assert.deepEqual(undo.movementIds, ['1', '2']);
  assert.throws(() => draftBankImportUndo(batch, existing.slice(0, 1)), /безопасно отменить/);
  assert.throws(() => draftBankImportUndo(batch, existing.map((x, i) =>
    i === 0 ? { ...x, voidedAt: '2026-11-07' } : x)), /безопасно отменить/);
});

test('content-only duplicates need explicit review, even when same bank IDs absent', async () => {
  const { preview } = await previewOf(base +
    '07.11.2026;-100,00;Кофе;Основной;;расход;Питание;\n');
  const candidate = operationAt(preview, 0);
  const existing = [{
    id: 'legacy', fingerprint: candidate.fingerprint, accountId: candidate.accountId,
    date: candidate.date, kind: candidate.kind, description: candidate.description,
    amountCents: candidate.amountCents,
  }];
  const reconciled = reconcileBankStatement(preview, existing);
  assert.equal(reconciled.possibleDuplicates, 1);
  await assert.rejects(draftBankImportBatch(reconciled, [candidate.sourceKey]), /подтверждения/);
  const accepted = await draftBankImportBatch(reconciled, [candidate.sourceKey], [candidate.sourceKey]);
  assert.equal(accepted.expectedOperationCount, 1);
  assert.deepEqual(
    (await draftBankImportBatch(reconciled, [candidate.sourceKey], [candidate.sourceKey])).batchKey,
    accepted.batchKey,
  );
});

test('split income/expense columns and negative parentheses', async () => {
  const table = await readBankStatementFile(input(
    'date;income;expense;account;description\n' +
    '2026-11-07;1200;;Основной;Оклад\n' +
    '2026-11-08;;300,50;Основной;Еда\n',
  ));
  const { mapping } = suggestColumnMapping(table.headers);
  const preview = await normalizeBankStatement(table, {
    mapping, accounts, numberFormat: 'auto', defaultAccountId: 'checking',
  });
  assert.equal(preview.accepted, 2);
  assert.equal(preview.inflowCents, 120000);
  assert.equal(preview.outflowCents, 30050);
  const { preview: paren } = await previewOf(base +
    '07.11.2026;"(1,234.50)";Магазин;Основной;;расход;Питание;A1\n');
  assert.equal(paren.accepted, 1);
  assert.equal(paren.outflowCents, 123450);
});

test('XSS is data only, dangerous CSV structures and file formats are rejected', async () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const { preview } = await previewOf(base +
    '07.11.2026;-100;'+malicious+';Основной;;расход;Питание;A1\n');
  assert.equal(operationAt(preview, 0).description, malicious);
  assert.throws(() => readBankCsv(input('a;b\n"unterminated;1')), /Незакрытые/);
  assert.throws(() => readBankCsv(new Uint8Array(4_000_001)), /4 МБ/);
  assert.throws(() => readBankCsv(input('a;b\nc\0d;1')), /нулевые/);
  await assert.rejects(readBankStatementFile(input('dummy'), { filename: 'bad.xlsm' }), /Макросы/);
  await assert.rejects(readBankStatementFile(input('wrong'), { filename: 'bad.xlsx', format: 'xlsx' }), /XLSX/);
  await assert.rejects(readBankStatementFile(new Uint8Array([0x50, 0x4b, 1, 2]),
    { filename: 'bad.xlsx' }), /XLSX|каталог/);
});

test('mapping is strict; mixed amount columns and reused fields never produce operations', async () => {
  const { table } = await previewOf(base + '07.11.2026;2;A;Основной;;доход;Зарплата;X\n');
  const bad = await normalizeBankStatement(table, {
    mapping: { date: 0, amount: 1, income: 1 }, accounts,
  });
  assert.equal(bad.accepted, 0);
  assert.equal(bad.rejected, 1);
  assert.ok(bad.warnings.some(x => x.code === 'REUSED_COLUMN'));
});


test('conflicting bank external IDs are blocked, including inside the same file', async () => {
  const { preview } = await previewOf(base +
    '07.11.2026;-100;А;Основной;;расход;Питание;BANK-7\n' +
    '08.11.2026;-200;Б;Основной;;расход;Питание;BANK-7\n');
  const within = reconcileBankStatement(preview, []);
  assert.equal(within.ready, 1);
  assert.equal(within.invalid, 1);
  assert.ok(within.rows[1].warnings.some(x => x.code === 'DUPLICATE_EXTERNAL_ID'));
  const first = operationAt(preview, 0);
  const other = operationAt(preview, 1);
  const saved = [{
    id: 'saved-1', accountId: first.accountId, kind: first.kind,
    date: first.date, description: first.description, amountCents: first.amountCents,
    externalId: first.externalId, fingerprint: first.fingerprint,
  }];
  const different = reconcileBankStatement({
    ...preview, rows: [{ rowNumber: other.sourceRow, operation: other, warnings: [] }],
  }, saved);
  assert.equal(different.invalid, 1);
  assert.ok(different.rows[0].warnings.some(x => x.code === 'EXTERNAL_ID_CONFLICT'));
  await assert.rejects(draftBankImportBatch(different, [other.sourceKey]));
});

test('invalid grouping and wrong CSV column width block rows without silent realignment', async () => {
  const malformed = await previewOf(base +
    '07.11.2026;1 2 3;Некорректно;Основной;;доход;Зарплата;G1\n' +
    '08.11.2026;100;Некорректно;Основной;;доход;Зарплата;G2;extra\n');
  assert.equal(malformed.preview.accepted, 0);
  assert.equal(malformed.preview.rejected, 2);
  assert.ok(malformed.preview.rows[0].warnings.some(x => x.code === 'INVALID_AMOUNT'));
  assert.ok(malformed.preview.rows[1].warnings.some(x => x.code === 'ROW_WIDTH'));
  assert.equal(malformed.table.warnings.some(x => x.code === 'ROW_WIDTH'), true);
});

test('invalid column mapping retains every row in the preview for manual inspection', async () => {
  const { table } = await previewOf(base +
    '07.11.2026;100;Тест;Основной;;доход;Зарплата;A1\n');
  const invalid = await normalizeBankStatement(table, {
    mapping: { amount: 1 }, accounts,
  });
  assert.equal(invalid.rows.length, 1);
  assert.equal(invalid.rows[0].operation, null);
  assert.equal(reconcileBankStatement(invalid, []).invalid, 1);
});


test('committed synthetic fixture is read locally without affecting application data', async () => {
  const bytes = readFileSync(new URL('./fixtures/bank-statements/synthetic.csv', import.meta.url));
  const table = await readBankStatementFile(bytes, { filename: 'synthetic.csv' });
  const { mapping } = suggestColumnMapping(table.headers);
  const preview = await normalizeBankStatement(table, {
    mapping, accounts, categories: ['Питание', 'Зарплата'],
  });
  assert.equal(preview.accepted, 3);
  assert.equal(preview.outflowCents, 123450);
  assert.equal(preview.inflowCents, 1500000);
  assert.equal(preview.transfersCents, 50000);
});


test('batch plan is immutable and confirmation digest covers mapped financial details', async () => {
  const { preview } = await previewOf(base +
    '07.11.2026;-100;Тест;Основной;;расход;Питание;LOCK-1\n');
  const op = preview.rows[0].operation;
  const reconciliation = reconcileBankStatement(preview, []);
  const plan = await draftBankImportBatch(reconciliation, [op.sourceKey]);
  const initial = plan.operations[0].amountCents;
  op.amountCents = 12345;
  assert.equal(plan.operations[0].amountCents, initial);
  assert.throws(() => { plan.operations[0].amountCents = 42; }, TypeError);
  assert.throws(() => { plan.sourceKeys.push('other'); }, TypeError);
  const changed = await draftBankImportBatch(reconciliation, [op.sourceKey]);
  assert.notEqual(changed.batchKey, plan.batchKey);
});


test('positive transfers are blocked without an explicit direction choice', async () => {
  const csv = base +
    '08.11.2026;500,00;Входящий перевод;Накопительный;Основной;перевод;;TR-IN\n';
  const blocked = (await previewOf(csv)).preview;
  assert.equal(blocked.rejected, 1);
  assert.ok(blocked.rows[0].warnings.some(x => x.code === 'TRANSFER_DIRECTION_REQUIRED'));
  const recognized = (await previewOf(csv, { transferDirection: 'signed-source' })).preview;
  const operation = recognized.rows[0].operation;
  assert.equal(recognized.accepted, 1);
  assert.equal(operation.accountId, 'checking');
  assert.equal(operation.targetAccountId, 'savings');
  assert.equal(recognized.inflowCents + recognized.outflowCents, 0);
  const explicit = (await previewOf(csv, { transferDirection: 'from-to' })).preview;
  assert.equal(explicit.rows[0].operation.accountId, 'savings');
  assert.equal(explicit.rows[0].operation.targetAccountId, 'checking');
});

test('non-transfer with two mapped accounts and negative split amounts fail closed', async () => {
  const mismapped = (await previewOf(base +
    '08.11.2026;-300;Не перевод;Основной;Накопительный;расход;;A1\n')).preview;
  assert.equal(mismapped.accepted, 0);
  assert.ok(mismapped.rows[0].warnings.some(x => x.code === 'TRANSFER_KIND_REQUIRED'));
  const split = await readBankStatementFile(input(
    'Дата;Приход;Расход;Счёт\n' +
    '08.11.2026;-250;;Основной\n' +
    '09.11.2026;;-250;Основной\n',
  ));
  const { mapping } = suggestColumnMapping(split.headers);
  const result = await normalizeBankStatement(split, { mapping, accounts });
  assert.equal(result.rejected, 2);
  assert.ok(result.rows.every(x => x.warnings.some(w => w.code === 'NEGATIVE_SPLIT_AMOUNT')));
});

test('tampered transaction snapshots and linked payments prevent a bank batch undo', async () => {
  const { preview } = await previewOf(base +
    '07.11.2026;-100,00;Тест;Основной;;расход;Питание;UD-1\n');
  const op = preview.rows[0].operation;
  const plan = await draftBankImportBatch(reconcileBankStatement(preview, []), [op.sourceKey]);
  const record = {
    id: 'saved', importBatchKey: plan.batchKey, sourceKey: op.sourceKey,
    fingerprint: op.fingerprint, externalId: op.externalId,
    accountId: op.accountId, targetAccountId: op.targetAccountId,
    date: op.date, amountCents: op.amountCents, kind: op.kind,
    description: op.description, category: op.category, currency: 'RUB',
  };
  assert.deepEqual(draftBankImportUndo(plan, [record]).movementIds, ['saved']);
  for (const modified of [
    { ...record, amountCents: op.amountCents + 1 },
    { ...record, description: 'Редактировано' },
    { ...record, date: '2026-11-09' },
    { ...record, linkedPaymentId: 'settlement-1' },
    { ...record, category: 'Другая' },
    { ...record, fingerprint: 'tampered' },
  ]) {
    assert.throws(() => draftBankImportUndo(plan, [modified]), /изменена или связана/);
  }
});

test('source key replay with changed column mapping is a hard conflict', async () => {
  const { preview } = await previewOf(base +
    '07.11.2026;-100,00;Синтетическая;Основной;;расход;Питание;KEY-1\n');
  const original = preview.rows[0].operation;
  const modified = { ...original, amountCents: original.amountCents + 100, fingerprint: 'modified' };
  const attempt = reconcileBankStatement({
    ...preview, rows: [{ rowNumber: original.sourceRow, operation: modified, warnings: [] }],
  }, [{
    id: 'saved', sourceKey: original.sourceKey, fingerprint: original.fingerprint,
    accountId: original.accountId, date: original.date,
    kind: original.kind, description: original.description,
    amountCents: original.amountCents,
  }]);
  assert.equal(attempt.invalid, 1);
  assert.ok(attempt.rows[0].warnings.some(x => x.code === 'SOURCE_KEY_CONFLICT'));
});

test('invalid trailing timestamp text or time values do not silently become a valid day', async () => {
  const value = base +
    '2026-11-07Tnot-time;-3;A;Основной;;расход;Питание;TS-1\n' +
    '2026-11-07T25:01:00;-4;B;Основной;;расход;Питание;TS-2\n' +
    '2026-11-07T13:24:10;-5;C;Основной;;расход;Питание;TS-3\n';
  const { preview } = await previewOf(value);
  assert.equal(preview.accepted, 1);
  assert.equal(preview.rejected, 2);
  assert.equal(preview.rows[2].operation.date, '2026-11-07');
  assert.ok(preview.rows[1].warnings.some(x => x.code === 'INVALID_TIME'));
});


test('IBM866, Windows-1252 and UTF-16BE bank CSV decoding uses explicit encodings or BOM', () => {
  const ibm866 = Buffer.from('84a0e2a03b91e3acaca00a30372e31312e323032363b2d31300a', 'hex');
  assert.deepEqual(readBankCsv(ibm866, { encoding: 'ibm866' }).headers, ['Дата', 'Сумма']);
  const cp1252 = Buffer.from('52e973756de93b416d6f756e740a372e31312e323032363b2d31300a', 'hex');
  assert.deepEqual(readBankCsv(cp1252, { encoding: 'windows-1252' }).headers, ['Résumé', 'Amount']);
  const utf16be = Buffer.from(
    'feff0414043004420430003b04210443043c043c0430000a00300037002e00310031002e0032003000320036003b002d00310030000a',
    'hex',
  );
  assert.deepEqual(readBankCsv(utf16be).headers, ['Дата', 'Сумма']);
});

test('empty CSV lines are skipped, physical row numbers survive quoted linebreaks', () => {
  const data = 'Дата;Сумма;Описание\n\n07.11.2026;-100;"Много\nстрок"\n\n08.11.2026;200;Доход\n';
  const parsed = readBankCsv(input(data));
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows.map(x => x.rowNumber), [3, 6]);
});

test('pre-hash file size guard rejects excessively large CSV and XLSX inputs', async () => {
  await assert.rejects(
    readBankStatementFile(new Uint8Array(4_000_001), { filename: 'oversized.csv' }),
    /4 МБ/,
  );
  const oversizedZip = new Uint8Array(6_000_001);
  oversizedZip[0] = 0x50; oversizedZip[1] = 0x4b;
  await assert.rejects(
    readBankStatementFile(oversizedZip, { filename: 'oversized.xlsx' }),
    /6 МБ/,
  );
  await assert.rejects(readBankStatementFile(new Uint8Array(0)), /пуст/);
});


test('a transfer appearing in both own-account bank statements is never silently posted twice', async () => {
  const exported = await previewOf(base +
    '07.11.2026;-500,00;Отправлено;Основной;Накопительный;перевод;;OUT-123\n');
  const outgoing = exported.preview.rows[0].operation;
  const imported = await previewOf(base +
    '07.11.2026;500,00;Получено;Накопительный;Основной;перевод;;IN-789\n', {
      transferDirection: 'signed-source',
    });
  const incoming = imported.preview.rows[0].operation;
  assert.equal(incoming.accountId, outgoing.accountId);
  assert.equal(incoming.targetAccountId, outgoing.targetAccountId);
  assert.notEqual(incoming.fingerprint, outgoing.fingerprint);
  const existing = [{
    id: 'record-1', accountId: outgoing.accountId,
    targetAccountId: outgoing.targetAccountId,
    date: outgoing.date, amountCents: outgoing.amountCents, kind: 'transfer',
    description: outgoing.description, externalId: outgoing.externalId,
    sourceKey: outgoing.sourceKey, fingerprint: outgoing.fingerprint,
  }];
  const reconciliation = reconcileBankStatement(imported.preview, existing);
  assert.equal(reconciliation.possibleDuplicates, 1);
  await assert.rejects(
    draftBankImportBatch(reconciliation, [incoming.sourceKey]),
    /подтверждения/,
  );
  const sameStatement = await previewOf(base +
    '07.11.2026;-500,00;Отправлено;Основной;Накопительный;перевод;;OUT-123\n' +
    '07.11.2026;-500,00;Отправлено ещё;Основной;Накопительный;перевод;;OUT-124\n');
  const partial = reconcileBankStatement(sameStatement.preview, []);
  assert.equal(partial.ready, 1);
  assert.equal(partial.possibleDuplicates, 1);
});


test('CSV metadata preamble can be skipped by choosing a physical header row', async () => {
  const raw = 'Синтетическая выписка\nПериод ноябрь 2026\n' +
    base + '07.11.2026;-50,00;Покупка;Основной;;расход;Питание;PM-1\n';
  const table = await readBankStatementFile(input(raw), {
    filename: 'preamble.csv', headerRowNumber: 3,
  });
  assert.equal(table.headerRowNumber, 3);
  assert.deepEqual(table.rows.map(x => x.rowNumber), [4]);
  assert.ok(table.warnings.some(x => x.code === 'SKIPPED_PREAMBLE'));
  const { mapping } = suggestColumnMapping(table.headers);
  const preview = await normalizeBankStatement(table, { mapping, accounts, categories: ['Питание'] });
  assert.equal(preview.accepted, 1);
  assert.equal(preview.outflowCents, 5000);
  await assert.rejects(readBankStatementFile(input(raw), { headerRowNumber: 100 }), /заголовка/);
  await assert.rejects(readBankStatementFile(input(raw), { headerRowNumber: 0 }), /заголовка/);
});


test('CSV parsing exposes detected encoding/delimiter and warns about guessed legacy encoding', async () => {
  const old = Buffer.from('c4e0f2e03bd1f3ecece00a30372e31312e323032363b2d31300a', 'hex');
  const parsed = await readBankStatementFile(old, { filename: 'legacy.csv' });
  assert.equal(parsed.csvEncoding, 'windows-1251');
  assert.equal(parsed.csvDelimiter, ';');
  assert.equal(parsed.headerRowNumber, 1);
  assert.ok(parsed.warnings.some(x => x.code === 'ENCODING_GUESSED'));
  const explicit = await readBankStatementFile(old, {
    filename: 'legacy.csv', csvEncoding: 'windows-1251',
  });
  assert.equal(explicit.warnings.some(x => x.code === 'ENCODING_GUESSED'), false);
});


test('Excel sep directive preserves physical CSV row numbers and source keys', async () => {
  const csv = 'sep=;\n' + base +
    '07.11.2026;-10,00;Тест;Основной;;расход;Питание;ROW-3\n';
  const bytes = input(csv);
  const parsed = readBankCsv(bytes);
  assert.equal(parsed.headerRowNumber, 2);
  assert.equal(parsed.rows[0].rowNumber, 3);
  const table = await readBankStatementFile(bytes, { filename: 'with-sep.csv' });
  const { mapping } = suggestColumnMapping(table.headers);
  const preview = await normalizeBankStatement(table, {
    mapping, accounts, categories: ['Питание'],
  });
  assert.equal(preview.accepted, 1);
  assert.equal(preview.rows[0].rowNumber, 3);
  assert.equal(preview.rows[0].operation.sourceRow, 3);
});

test('bank identity checks actual financial fields, not only stale stored fingerprints', async () => {
  const { preview } = await previewOf(base +
    '07.11.2026;-100,00;Покупка;Основной;;расход;Питание;BANK-FIELDS-1\n');
  const original = preview.rows[0].operation;
  const saved = {
    id: 'saved', accountId: original.accountId, date: original.date,
    amountCents: original.amountCents, kind: original.kind,
    description: original.description, category: original.category,
    externalId: original.externalId, sourceKey: original.sourceKey,
    fingerprint: original.fingerprint,
  };
  assert.equal(reconcileBankStatement(preview, [saved]).duplicates, 1);
  // A stale stored fingerprint must never hide a changed booked amount.
  const edited = { ...saved, amountCents: original.amountCents + 1 };
  const conflict = reconcileBankStatement(preview, [edited]);
  assert.equal(conflict.invalid, 1);
  assert.ok(conflict.rows[0].warnings.some(x => x.code === 'SOURCE_KEY_CONFLICT'));
  // A category remap of the same physical row also needs manual reconciliation.
  const changedCategory = { ...saved, category: 'Другое' };
  assert.equal(reconcileBankStatement(preview, [changedCategory]).invalid, 1);
  // Bank statement descriptions often change formatting without changing money.
  const differentDescription = { ...saved, sourceKey: null, fingerprint: 'legacy-other-note' };
  assert.equal(reconcileBankStatement(preview, [differentDescription]).duplicates, 1);
  // A matching bank ID with different booked money is a hard conflict, not replay.
  const alteredAmount = { ...differentDescription, amountCents: 50000 };
  const byBankId = reconcileBankStatement(preview, [alteredAmount]);
  assert.equal(byBankId.invalid, 1);
  assert.ok(byBankId.rows[0].warnings.some(x => x.code === 'EXTERNAL_ID_CONFLICT'));
});

test('ambiguous or duplicate source keys in a provided reconciliation cannot be submitted', async () => {
  const { preview } = await previewOf(base +
    '07.11.2026;-100,00;Тест;Основной;;расход;Питание;DUP-KEY-1\n');
  const reconciliation = reconcileBankStatement(preview, []);
  const candidate = reconciliation.rows[0];
  const key = candidate.operation.sourceKey;
  await assert.rejects(draftBankImportBatch({
    ...reconciliation, rows: [candidate, { ...candidate, rowNumber: 99 }],
  }, [key]), /Повторяющиеся исходные ключи/);
  await assert.rejects(draftBankImportBatch({
    ...reconciliation, rows: [{ ...candidate, status: 'unexpected' }],
  }, [key]), /Нельзя проводить/);
});

test('control separators in imported descriptions have unambiguous financial hashes', async () => {
  const raw = base +
    '07.11.2026;-100;Тест\u001fразделитель;Основной;;расход;Питание;SEP-A\n' +
    '07.11.2026;-100;Тест\u001eразделитель;Основной;;расход;Питание;SEP-B\n';
  const { preview } = await previewOf(raw);
  assert.equal(preview.accepted, 2);
  assert.notEqual(preview.rows[0].operation.fingerprint, preview.rows[1].operation.fingerprint);
  const reconciliation = reconcileBankStatement(preview, []);
  const a = await draftBankImportBatch(reconciliation, [preview.rows[0].operation.sourceKey]);
  const b = await draftBankImportBatch(reconciliation, [preview.rows[1].operation.sourceKey]);
  assert.notEqual(a.batchKey, b.batchKey);
  assert.equal(a.expectedOperationCount, 1);
  assert.equal(b.expectedOperationCount, 1);
});

test('multiple existing ledger rows with the same bank identity are treated as corruption', async () => {
  const { preview } = await previewOf(base +
    '07.11.2026;-100;Тест;Основной;;расход;Питание;DUP-LEDGER-ID\n');
  const op = preview.rows[0].operation;
  const saved = {
    accountId: op.accountId, date: op.date, kind: op.kind,
    amountCents: op.amountCents, description: op.description,
    sourceKey: op.sourceKey, fingerprint: op.fingerprint, externalId: op.externalId,
  };
  const result = reconcileBankStatement(preview, [
    { id: 'booked-1', ...saved }, { id: 'booked-2', ...saved },
  ]);
  assert.equal(result.invalid, 1);
  assert.equal(result.rows[0].existingIds.length, 2);
});


test('category alias lookup ignores inherited constructor/__proto__ names', async () => {
  const table = await readBankStatementFile(input(
    base +
    '07.11.2026;-100,00;Тест;Основной;;расход;constructor;ALIAS-1\n' +
    '08.11.2026;-200,00;Тест;Основной;;расход;__proto__;ALIAS-2\n',
  ));
  const { mapping } = suggestColumnMapping(table.headers);
  const preview = await normalizeBankStatement(table, {
    mapping, accounts, categories: ['constructor', '__proto__'], categoryAliases: {},
  });
  assert.equal(preview.accepted, 2);
  assert.deepEqual(preview.rows.map(x => x.operation.category), ['constructor', '__proto__']);
  const aliases = Object.create(null);
  aliases.constructor = 42;
  const invalid = await normalizeBankStatement(table, {
    mapping, accounts, categories: ['constructor', '__proto__'], categoryAliases: aliases,
  });
  assert.equal(invalid.accepted, 1);
  assert.equal(invalid.rejected, 1);
  assert.ok(invalid.rows[0].warnings.some(x => x.code === 'INVALID_CATEGORY_ALIAS'));
});


test('typical bank headings map to correct fields without changing imported amounts', async () => {
  const table = await readBankStatementFile(input(
    'Дата и время операции;Сумма в валюте счёта;Комментарий;Номер счёта;Тип операции;Валюта операции;Transaction UID\n' +
    '07.11.2026;-450,25;Условная покупка;Основной;расход;RUB;TX-ABC\n',
  ));
  const { mapping, warnings } = suggestColumnMapping(table.headers);
  assert.deepEqual(warnings, []);
  assert.deepEqual(mapping, {
    date: 0, amount: 1, description: 2, account: 3,
    kind: 4, currency: 5, externalId: 6,
  });
  const preview = await normalizeBankStatement(table, { mapping, accounts });
  assert.equal(preview.accepted, 1);
  assert.equal(preview.outflowCents, 45025);
  assert.equal(preview.rows[0].operation.externalId, 'TX-ABC');
});


test('separate credit/debit bank columns accept zero in the unused direction only', async () => {
  const table = await readBankStatementFile(input(
    'date;income;expense;account;description\n' +
    '2026-11-07;1200,00;0;Основной;Оклад\n' +
    '2026-11-08;0,00;300,50;Основной;Еда\n' +
    '2026-11-09;1,00;2,00;Основной;Повреждённая строка\n' +
    '2026-11-10;0;0;Основной;Нулевая строка\n' +
    '2026-11-11;1,00;INVALID;Основной;Повреждённый второй столбец\n',
  ));
  const { mapping } = suggestColumnMapping(table.headers);
  const preview = await normalizeBankStatement(table, { mapping, accounts });
  assert.equal(preview.accepted, 2);
  assert.equal(preview.rejected, 3);
  assert.equal(preview.inflowCents, 120000);
  assert.equal(preview.outflowCents, 30050);
  assert.ok(preview.rows[2].warnings.some(x => x.code === 'CONFLICTING_AMOUNT'));
  assert.ok(preview.rows[3].warnings.some(x => x.code === 'ZERO_AMOUNT'));
  assert.ok(preview.rows[4].warnings.some(x => x.code === 'INVALID_AMOUNT'));
});


test('privacy-safe audit summarizes bank import results without sensitive text, IDs or amounts', async () => {
  const raw = base +
    '07.11.2026;-100,00;<img src=x onerror=alert(1)>;Основной;;расход;Питание;BANK-SENSITIVE-1\n' +
    '99.11.2026;-200,00;PRIVATE_NOTE;Основной;;расход;Питание;BANK-SENSITIVE-2\n';
  const { preview } = await previewOf(raw);
  const reconciled = reconcileBankStatement(preview, []);
  const plan = await draftBankImportBatch(reconciled, [preview.rows[0].operation.sourceKey]);
  const journal = summarizeBankImportAudit(reconciled, plan);
  assert.equal(journal.version, 1);
  assert.equal(journal.reviewedRows, 2);
  assert.equal(journal.ready, 1);
  assert.equal(journal.invalid, 1);
  assert.equal(journal.plannedRows, 1);
  assert.deepEqual(journal.errorRows.map(x => x.rowNumber), [3]);
  assert.ok(journal.warningCounts.some(x => x.code === 'INVALID_DATE'));
  const json = JSON.stringify(journal);
  for (const secret of ['<img', 'PRIVATE_NOTE', 'BANK-SENSITIVE', 'Основной', '10000', '20000', plan.batchKey, preview.fileDigest]) {
    assert.equal(json.includes(secret), false, secret);
  }
  assert.throws(() => { journal.errorRows.push({ rowNumber: 99, codes: [] }); }, TypeError);
});

test('audit receipt limits error row detail to 200 and counts all omitted errors', () => {
  const many = {
    rows: Array.from({ length: 205 }, (_, i) => ({
      rowNumber: i + 2,
      operation: null,
      status: 'invalid',
      existingIds: [],
      warnings: [{ code: 'BAD_ROW', message: 'Sensitive account and amount', severity: 'error' }],
    })),
    ready: 0, duplicates: 0, possibleDuplicates: 0, invalid: 205,
  };
  const summary = summarizeBankImportAudit(many);
  assert.equal(summary.invalid, 205);
  assert.equal(summary.errorRows.length, 200);
  assert.equal(summary.omittedErrorRows, 5);
  assert.equal(summary.warningCounts.find(x => x.code === 'BAD_ROW').count, 205);
  assert.equal(JSON.stringify(summary).includes('Sensitive'), false);
});


test('a proposed ready operation with an error warning is blocked at confirmation', async () => {
  const { preview } = await previewOf(base +
    '07.11.2026;-100,00;Проверка;Основной;;расход;Питание;ERR-WARNING\n');
  const reconciled = reconcileBankStatement(preview, []);
  const key = preview.rows[0].operation.sourceKey;
  await assert.rejects(draftBankImportBatch({
    ...reconciled, rows: [{ ...reconciled.rows[0], warnings: [{
      code: 'INVALID_ACCOUNT', severity: 'error', message: 'Должен быть отказ',
    }] }],
  }, [key]), /Нельзя проводить/);
});


test('a split credit/debit direction cannot be overridden by an opposite type column', async () => {
  const table = await readBankStatementFile(input(
    'date;credit;debit;type;account;description\n' +
    '2026-11-07;0;100;income;Основной;Неверный доход\n' +
    '2026-11-08;100;0;expense;Основной;Неверный расход\n' +
    '2026-11-09;0;100;expense;Основной;Верный расход\n' +
    '2026-11-10;100;0;income;Основной;Верный доход\n',
  ));
  const { mapping } = suggestColumnMapping(table.headers);
  const preview = await normalizeBankStatement(table, { mapping, accounts });
  assert.equal(preview.accepted, 2);
  assert.equal(preview.rejected, 2);
  assert.equal(preview.inflowCents, 10000);
  assert.equal(preview.outflowCents, 10000);
  assert.ok(preview.rows[0].warnings.some(w => w.code === 'SIGN_KIND_CONFLICT'));
  assert.ok(preview.rows[1].warnings.some(w => w.code === 'SIGN_KIND_CONFLICT'));
  assert.equal(reconcileBankStatement(preview, []).invalid, 2);
  const keys = preview.rows.slice(0, 2).map(row => row.operation?.sourceKey).filter(Boolean);
  assert.equal(keys.length, 0);
});

test('source key uses XLSX sheet identity while preserving determinism', async () => {
  const csv = await readBankStatementFile(input(base +
    '07.11.2026;-100;Тест;Основной;;расход;Питание;SAME-1\n',
  ));
  const first = { ...csv, format: 'xlsx', sheetName: 'Ноябрь', dateSystem: '1900' };
  // Two distinct sheets can describe separate bank events with the same
  // amount/date; use a different bank event ID to isolate source row identity.
  const second = { ...first, sheetName: 'Декабрь',
    rows: first.rows.map(row => ({
      ...row, cells: row.cells.map((value, index) => index === 7 ? 'SAME-2' : value),
    })),
  };
  const opts = { mapping: suggestColumnMapping(csv.headers).mapping, accounts, categories: ['Питание'] };
  const a = await normalizeBankStatement(first, opts);
  const b = await normalizeBankStatement(second, opts);
  const replay = await normalizeBankStatement(first, opts);
  assert.notEqual(a.rows[0].operation.sourceKey, b.rows[0].operation.sourceKey);
  assert.equal(a.rows[0].operation.sourceKey, replay.rows[0].operation.sourceKey);
  assert.equal(reconcileBankStatement(b, [{
    ...a.rows[0].operation, id: 'already-imported',
  }]).duplicates, 0);
});


test('large overlapping import reconciles with bounded ledger reads and preserved statuses', () => {
  let inspected = 0;
  const existing = Array.from({ length: 2500 }, (_, i) => new Proxy({
    id: 'posted-' + i, sourceKey: 'previous-' + i,
    externalId: 'bank-previous-' + i, fingerprint: 'old-content-' + i,
    accountId: 'checking', targetAccountId: null,
    date: '2026-11-08', amountCents: 500, kind: 'expense',
    category: 'Питание', currency: 'RUB', description: 'Синтетический расход',
  }, {
    get(target, key, receiver) {
      if (['sourceKey', 'externalId', 'fingerprint', 'accountId'].includes(String(key))) {
        inspected++;
      }
      return Reflect.get(target, key, receiver);
    },
  }));
  const rows = Array.from({ length: 1500 }, (_, i) => ({
    rowNumber: i + 2, warnings: [],
    operation: {
      sourceRow: i + 2, sourceKey: 'new-' + i,
      externalId: 'bank-new-' + i, fingerprint: 'new-content-' + i,
      accountId: 'checking', targetAccountId: null,
      date: '2026-11-08', amountCents: 500, kind: 'expense',
      category: 'Питание', currency: 'RUB',
      description: 'Синтетический расход',
    },
  }));
  rows[0].operation.sourceKey = 'previous-10';
  rows[1].operation.externalId = 'bank-previous-11';
  rows[2].operation.fingerprint = 'old-content-12';
  rows[3].operation.sourceKey = 'previous-13';
  rows[3].operation.amountCents = 600;
  rows[4].operation.externalId = 'bank-previous-14';
  rows[4].operation.amountCents = 600;
  rows[6].operation.fingerprint = rows[5].operation.fingerprint;
  rows[8].operation.externalId = rows[7].operation.externalId;
  const snapshot = {
    fileDigest: 'synthetic-only', mapping: {}, rows, warnings: [],
    accepted: rows.length, rejected: 0,
    inflowCents: 0, outflowCents: rows.length * 500, transfersCents: 0,
  };
  const result = reconcileBankStatement(snapshot, existing);
  assert.deepEqual(result.rows.slice(0, 9).map(x => x.status), [
    'duplicate', 'duplicate', 'possible-duplicate', 'invalid', 'invalid',
    'ready', 'possible-duplicate', 'ready', 'invalid',
  ]);
  assert.deepEqual(result.rows.slice(0, 3).map(x => x.existingIds), [
    ['posted-10'], ['posted-11'], ['posted-12'],
  ]);
  assert.equal(result.rows.length, 1500);
  assert.equal(result.duplicates, 2);
  assert.equal(result.invalid, 3);
  assert.equal(result.possibleDuplicates, 2);
  assert.equal(result.ready, 1493);
  // On an unindexed O(N*M) implementation this would exceed 10 million reads.
  // Do not use fragile elapsed-time limits on shared CI runners.
  assert.ok(inspected < 100000, 'Excessive ledger reads: ' + inspected);
});

test('indexed reconciliation detects both directions of transfers across bank statements', () => {
  const expense = {
    sourceRow: 2, sourceKey: 'transfer-a', externalId: 'leg-a',
    fingerprint: 'transfer-out', accountId: 'checking',
    targetAccountId: 'savings', date: '2026-11-08', amountCents: 9500,
    kind: 'transfer', currency: 'RUB', description: 'Между своими',
    category: null,
  };
  const incoming = {
    ...expense, sourceRow: 3, sourceKey: 'transfer-b', externalId: 'leg-b',
    fingerprint: 'transfer-in', accountId: 'savings',
    targetAccountId: 'checking', description: 'Встречный перевод',
  };
  const preview = {
    fileDigest: 'synthetic', mapping: {}, warnings: [],
    rows: [{ rowNumber: 3, warnings: [], operation: incoming }],
    accepted: 1, rejected: 0, inflowCents: 0, outflowCents: 0,
    transfersCents: 9500,
  };
  const result = reconcileBankStatement(preview, [{ id: 'saved-transfer', ...expense }]);
  assert.equal(result.possibleDuplicates, 1);
  assert.deepEqual(result.rows[0].existingIds, ['saved-transfer']);
  const sameFile = reconcileBankStatement({
    ...preview,
    rows: [
      { rowNumber: 2, warnings: [], operation: expense },
      { rowNumber: 3, warnings: [], operation: incoming },
    ],
  }, []);
  assert.deepEqual(sameFile.rows.map(x => x.status), ['ready', 'possible-duplicate']);
});
