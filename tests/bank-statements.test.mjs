import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  readBankCsv, readBankStatementFile, suggestColumnMapping, normalizeBankStatement,
  reconcileBankStatement, draftBankImportBatch, draftBankImportUndo,
  projectAccountBalances,
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
    externalId: x.externalId, importBatchKey: batch.batchKey,
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
