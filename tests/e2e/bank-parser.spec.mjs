import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PYTHON = process.env.FH_E2E_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
const PYTHON_PREFIX = process.platform === 'win32' && !process.env.FH_E2E_PYTHON ? ['-3'] : [];
const fixtureScript = resolve('tests/e2e/make_bank_xlsx.py');
const parserEntrypoint = resolve('src/importers/bank-statements/index.ts');
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
  const bundle = await build({
    entryPoints: [parserEntrypoint], bundle: true, write: false,
    platform: 'browser', format: 'esm', target: ['es2022'],
  });
  const source = bundle.outputFiles[0].text;
  await page.route('**/__bank-parser-harness', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html lang="ru"><meta charset="utf-8"><body><div id="preview"></div></body></html>',
  }));
  await page.route('**/__bank-parser-module.js', route => route.fulfill({
    contentType: 'text/javascript', body: source,
  }));
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
    const mod = await import('/__bank-parser-module.js');
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

test('native browser rejects bomb, DTD, external parts and corrupt ZIP', async ({ page }, testInfo) => {
  const watcher = await setup(page, testInfo);
  for (const suffix of ['--bomb', '--doctype', '--external', '--corrupt']) {
    const encoded = makeFixture(testInfo, suffix);
    const outcome = await page.evaluate(async encoded => {
      const mod = await import('/__bank-parser-module.js');
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
