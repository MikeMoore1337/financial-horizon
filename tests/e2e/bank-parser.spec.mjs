import { test, expect } from '@playwright/test';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PYTHON = process.env.FH_E2E_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
const PYTHON_PREFIX = process.platform === 'win32' && !process.env.FH_E2E_PYTHON ? ['-3'] : [];
const fixtureScript = resolve('tests/e2e/make_bank_xlsx.py');
const accounts = [
  { id: 'checking', name: 'Основной', currency: 'RUB' },
  { id: 'savings', name: 'Накопительный', currency: 'RUB' },
];

async function setup(page, testInfo) {
  const errors = [], external = [], posts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (!request.url().startsWith('http://127.0.0.1:8791/')) external.push(request.url());
    if (request.method() !== 'GET') posts.push(request.url());
  });
  const moduleSource = new Map(
    ['index.ts', 'csv.ts', 'xlsx.ts', 'normalize.ts', 'reconcile.ts', 'audit.ts', 'types.ts']
      .map(name => [name, ts.transpileModule(
        readFileSync(resolve('src/importers/bank-statements', name), 'utf8'),
        { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
      ).outputText]),
  );
  await page.route('**/__bank-parser-harness', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html lang="ru"><meta charset="utf-8"><body><div id="preview"></div></body></html>',
  }));
  await page.route('**/__bank-parser/*.ts', route => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    const body = moduleSource.get(name);
    return body ? route.fulfill({ contentType: 'text/javascript', body }) : route.abort();
  });
  await page.goto('http://127.0.0.1:8791/__bank-parser-harness');
  return {
    assertClean() {
      expect(errors).toEqual([]);
      expect(external).toEqual([]);
      expect(posts).toEqual([]);
    },
  };
}

function makeFixture(testInfo, suffix = '') {
  const path = testInfo.outputPath('synthetic-bank' + suffix + '.xlsx');
  execFileSync(PYTHON, [...PYTHON_PREFIX, fixtureScript, path, ...(suffix ? [suffix] : [])]);
  return readFileSync(path).toString('base64');
}

test('native browser safely parses a synthetic XLSX, skips formulas and balances transfer', async ({ page }, testInfo) => {
  const watcher = await setup(page, testInfo);
  const encoded = makeFixture(testInfo);
  const result = await page.evaluate(async ({ encoded, accounts }) => {
    const mod = await import('/__bank-parser/index.ts');
    const bytes = Uint8Array.from(atob(encoded), x => x.charCodeAt(0));
    const table = await mod.readBankStatementFile(bytes, { filename: 'synthetic.xlsx' });
    const { mapping } = mod.suggestColumnMapping(table.headers);
    const preview = await mod.normalizeBankStatement(table, {
      mapping, accounts, categories: ['Питание', 'Зарплата'],
    });
    const transfer = preview.rows.find(x => x.operation?.kind === 'transfer')?.operation;
    const text = document.querySelector('#preview');
    text.textContent = preview.rows.map(row => row.operation?.description || '').join('\n');
    return {
      format: table.format, sheetName: table.sheetName, accepted: preview.accepted,
      rejected: preview.rejected, inflow: preview.inflowCents,
      outflow: preview.outflowCents, transfer: preview.transfersCents,
      formulaWarnings: table.warnings.filter(x => x.code === 'FORMULA_IGNORED').length,
      transferAccounts: transfer && [transfer.accountId, transfer.targetAccountId],
      rendered: text.textContent, docWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  }, { encoded, accounts });
  expect(result.format).toBe('xlsx');
  expect(result.sheetName).toBe('Выписка');
  expect(result.accepted).toBe(3);
  expect(result.rejected).toBe(1);
  expect(result.inflow).toBe(150025);
  expect(result.outflow).toBe(123450);
  expect(result.transfer).toBe(50000);
  expect(result.formulaWarnings).toBe(1);
  expect(result.transferAccounts).toEqual(['checking', 'savings']);
  expect(result.rendered).toContain('Синтетическая покупка');
  expect(result.docWidth).toBeLessThanOrEqual(result.viewportWidth);
  watcher.assertClean();
});

test('native browser rejects bombs, DTD, unsafe paths, encryption, duplicate rows and corruption', async ({ page }, testInfo) => {
  const watcher = await setup(page, testInfo);
  for (const suffix of ['--bomb', '--doctype', '--external', '--corrupt', '--duplicate-row', '--traversal', '--encrypted-flag', '--too-many-rows']) {
    const encoded = makeFixture(testInfo, suffix);
    const outcome = await page.evaluate(async encoded => {
      const mod = await import('/__bank-parser/index.ts');
      try {
        await mod.readBankStatementFile(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)), {
          filename: 'synthetic.xlsx',
        });
        return 'ACCEPTED';
      } catch (error) { return String(error.message); }
    }, encoded);
    expect(outcome, suffix).not.toBe('ACCEPTED');
  }
  watcher.assertClean();
});

test('1904 XLSX date system is converted without shifting account transactions', async ({ page }, testInfo) => {
  const watcher = await setup(page, testInfo);
  const encoded = makeFixture(testInfo, '--1904');
  const result = await page.evaluate(async ({ encoded, accounts }) => {
    const mod = await import('/__bank-parser/index.ts');
    const bytes = Uint8Array.from(atob(encoded), x => x.charCodeAt(0));
    const table = await mod.readBankStatementFile(bytes, { filename: 'synthetic.xlsx' });
    const { mapping } = mod.suggestColumnMapping(table.headers);
    const preview = await mod.normalizeBankStatement(table, { mapping, accounts });
    return { dateSystem: table.dateSystem, date: preview.rows[0].operation?.date,
      accepted: preview.accepted, rejected: preview.rejected };
  }, { encoded, accounts });
  expect(result).toEqual({ dateSystem: '1904', date: '2026-11-07', accepted: 3, rejected: 1 });
  watcher.assertClean();
});


test('browser can choose a bank XLSX header after a two-row report preamble', async ({ page }, testInfo) => {
  const watcher = await setup(page, testInfo);
  const encoded = makeFixture(testInfo, '--preamble');
  const result = await page.evaluate(async ({ encoded, accounts }) => {
    const mod = await import('/__bank-parser/index.ts');
    const table = await mod.readBankStatementFile(
      Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
      { filename: 'synthetic-preamble.xlsx', headerRowNumber: 3 },
    );
    const { mapping } = mod.suggestColumnMapping(table.headers);
    const preview = await mod.normalizeBankStatement(table, { mapping, accounts });
    return { row: table.headerRowNumber, accepted: preview.accepted,
      expense: preview.outflowCents, warnings: table.warnings.map(w => w.code) };
  }, { encoded, accounts });
  expect(result.row).toBe(3);
  expect(result.accepted).toBe(1);
  expect(result.expense).toBe(5000);
  expect(result.warnings).toContain('SKIPPED_PREAMBLE');
  watcher.assertClean();
});


test('real browser File API keeps CSV bytes local and renders hostile descriptions as text', async ({ page }, testInfo) => {
  const watcher = await setup(page, testInfo);
  const result = await page.evaluate(async () => {
    const mod = await import('/__bank-parser/index.ts');
    const malicious = '<img src=x onerror=window.__bankXss=1>';
    const raw = 'Дата;Сумма;Описание;Счёт;Тип;ID\n' +
      '07.11.2026;-99,50;' + malicious + ';Основной;расход;SEC-01\n' +
      '77.11.2026;-10;Sensitive private account name;Основной;расход;SEC-02\n';
    const file = new File([new TextEncoder().encode(raw)], 'synthetic-security.csv', { type: 'text/csv' });
    const table = await mod.readBankStatementFile(await file.arrayBuffer(), { filename: file.name });
    const { mapping } = mod.suggestColumnMapping(table.headers);
    const preview = await mod.normalizeBankStatement(table, {
      mapping, accounts: [{ id: 'checking', name: 'Основной', currency: 'RUB' }],
    });
    const reconciled = mod.reconcileBankStatement(preview, []);
    const batch = await mod.draftBankImportBatch(reconciled, [preview.rows[0].operation.sourceKey]);
    const summary = mod.summarizeBankImportAudit(reconciled, batch);
    const view = document.querySelector('#preview');
    view.textContent = preview.rows[0].operation.description;
    return {
      format: table.format, accepted: preview.accepted, rejected: preview.rejected,
      summary: JSON.stringify(summary), previewText: view.textContent,
      imageCount: document.querySelectorAll('img').length, injected: Boolean(window.__bankXss),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  expect(result.format).toBe('csv');
  expect(result.accepted).toBe(1);
  expect(result.rejected).toBe(1);
  expect(result.previewText).toContain('<img');
  expect(result.imageCount).toBe(0);
  expect(result.injected).toBe(false);
  expect(result.summary).not.toContain('SEC-01');
  expect(result.summary).not.toContain('Sensitive');
  expect(result.summary).not.toContain('Основной');
  expect(result.overflow).toBe(false);
  watcher.assertClean();
});


test('two sheets in one XLSX retain distinct source IDs on identical physical rows', async ({ page }, testInfo) => {
  const watcher = await setup(page, testInfo);
  const encoded = makeFixture(testInfo, '--two-sheets');
  const result = await page.evaluate(async ({ encoded, accounts }) => {
    const mod = await import('/__bank-parser/index.ts');
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const one = await mod.readBankStatementFile(bytes, { filename: 'synthetic.xlsx', sheetName: 'Выписка' });
    const two = await mod.readBankStatementFile(bytes, { filename: 'synthetic.xlsx', sheetName: 'Другой лист' });
    const options = { accounts, mapping: mod.suggestColumnMapping(one.headers).mapping };
    const a = await mod.normalizeBankStatement(one, options);
    const b = await mod.normalizeBankStatement(two, options);
    const repeat = await mod.normalizeBankStatement(one, options);
    return {
      digestEqual: one.fileDigest === two.fileDigest,
      keyA: a.rows[0].operation.sourceKey, keyB: b.rows[0].operation.sourceKey,
      repeatEqual: repeat.rows[0].operation.sourceKey === a.rows[0].operation.sourceKey,
      rowA: a.rows[0].rowNumber, rowB: b.rows[0].rowNumber,
    };
  }, { encoded, accounts });
  expect(result.digestEqual).toBe(true);
  expect(result.rowA).toBe(2);
  expect(result.rowB).toBe(2);
  expect(result.keyA).not.toBe(result.keyB);
  expect(result.repeatEqual).toBe(true);
  watcher.assertClean();
});

test('XLSX omitted trailing optional cells do not cause false row width errors', async ({ page }, testInfo) => {
  const watcher = await setup(page, testInfo);
  const encoded = makeFixture(testInfo, '--missing-trailing');
  const result = await page.evaluate(async ({ encoded, accounts }) => {
    const mod = await import('/__bank-parser/index.ts');
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const table = await mod.readBankStatementFile(bytes, { filename: 'synthetic.xlsx' });
    const preview = await mod.normalizeBankStatement(table, {
      mapping: mod.suggestColumnMapping(table.headers).mapping, accounts,
    });
    return {
      headers: table.headers.length, width: table.rows[0].cells.length,
      accepted: preview.accepted, first: preview.rows[0].operation?.amountCents,
      category: preview.rows[0].operation?.category,
      externalId: preview.rows[0].operation?.externalId,
      wrongWidth: preview.rows[0].warnings.some(w => w.code === 'ROW_WIDTH'),
    };
  }, { encoded, accounts });
  expect(result.headers).toBe(8);
  expect(result.width).toBe(8);
  expect(result.accepted).toBe(3);
  expect(result.first).toBe(123450);
  expect(result.category).toBe(null);
  expect(result.externalId).toBe(null);
  expect(result.wrongWidth).toBe(false);
  watcher.assertClean();
});


test('XLSX rejects recursive or overlong shared strings before expansion', async ({ page }, testInfo) => {
  const watcher = await setup(page, testInfo);
  for (const variant of ['--nested-shared', '--oversized-shared']) {
    const encoded = makeFixture(testInfo, variant);
    const outcome = await page.evaluate(async encoded => {
      const mod = await import('/__bank-parser/index.ts');
      try {
        await mod.readBankStatementFile(
          Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
          { filename: 'synthetic.xlsx' },
        );
        return 'UNSAFE_ACCEPT';
      } catch (error) { return String(error.message); }
    }, encoded);
    expect(outcome, variant).toMatch(/Вложенные строки|длинное текстовое поле/);
  }
  watcher.assertClean();
});

test('XLSX numeric bank IDs beyond 2^53 remain exact strings and never alias', async ({ page }, testInfo) => {
  const watcher = await setup(page, testInfo);
  const encoded = makeFixture(testInfo, '--big-number-id');
  const result = await page.evaluate(async ({ encoded, accounts }) => {
    const mod = await import('/__bank-parser/index.ts');
    const table = await mod.readBankStatementFile(
      Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
      { filename: 'synthetic.xlsx' },
    );
    const { mapping } = mod.suggestColumnMapping(table.headers);
    const preview = await mod.normalizeBankStatement(table, { mapping, accounts });
    return {
      cells: [table.rows[0].cells[7], table.rows[1].cells[7]],
      ids: [preview.rows[0].operation?.externalId, preview.rows[1].operation?.externalId],
      accepted: preview.accepted,
    };
  }, { encoded, accounts });
  expect(result.accepted).toBe(3);
  expect(result.cells).toEqual(['9007199254740993', '9007199254740992']);
  expect(result.ids).toEqual(['9007199254740993', '9007199254740992']);
  watcher.assertClean();
});
