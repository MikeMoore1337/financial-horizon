import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { test, expect } from '@playwright/test';
import { observe, visitGuest, scopedState } from './helpers.mjs';

// Test only: serve the isolated TypeScript kernel to the real browser.
// This does not alter the production build, application, Service Worker or UI.
test.use({ serviceWorkers: 'block' });

const SOURCES = new Set(['index', 'engine', 'math', 'reconcile', 'types']);

test('loan domain executes in Chromium and WebKit with exact cents and no IndexedDB mutation', async ({ page, context }) => {
  const watcher = await observe(context, page);
  await page.route('**/fh-loan-qa/*.js', async route => {
    const filename = new URL(route.request().url()).pathname.split('/').at(-1);
    const moduleName = filename?.replace(/\.js$/, '');
    if (!moduleName || !SOURCES.has(moduleName) || filename !== moduleName + '.js') {
      await route.abort('blockedbyclient');
      return;
    }
    const source = await readFile(new URL('../../src/domain/loans/' + moduleName + '.ts', import.meta.url), 'utf8');
    const transpiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      fileName: moduleName + '.ts',
      reportDiagnostics: true,
    });
    if (transpiled.diagnostics?.length) {
      throw new Error('Loan TypeScript transpilation failed: ' + transpiled.diagnostics.map(d => d.messageText).join(','));
    }
    const code = transpiled.outputText.replaceAll(".ts'", ".js'").replaceAll('.ts"', '.js"');
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: code, headers: { 'Cache-Control': 'no-store' } });
  });
  await visitGuest(page);
  const before = await scopedState(page, 'state');
  const result = await page.evaluate(async () => {
    const { calculateLoan, reconcileLoanSchedule } = await import('/fh-loan-qa/index.js');
    const terms = {
      principalCents: 1_000_000, startDate: '2026-01-01',
      firstDueDate: '2026-02-01', termMonths: 2,
      annualRateMicroPercent: 12_000_000, dayCount: 'ACT/365F',
      rounding: 'HALF_UP', scheduleType: 'annuity', maxExtensionMonths: 0,
    };
    const planned = calculateLoan(terms, [], { mode: 'plan' });
    const expected = [
      { date: '2026-02-01', amountCents: 507_410,
        interestCents: 10_192, principalCents: 497_218, balanceCents: 502_782 },
      { date: '2026-03-01', amountCents: 507_410,
        interestCents: 4_628, principalCents: 502_782, balanceCents: 0 },
    ];
    const compare = reconcileLoanSchedule(planned, expected);
    const partial = reconcileLoanSchedule(planned, expected.map(({date, amountCents, balanceCents}) =>
      ({date, amountCents, balanceCents})));
    const started = performance.now();
    const long = calculateLoan({ ...terms, principalCents: 300_000_000,
      startDate: '2026-01-01', firstDueDate: '2026-02-01',
      termMonths: 360, maxExtensionMonths: 0,
      annualRateMicroPercent: 9_500_000, dayCount: 'ACT/ACT-ISDA',
    }, [], { mode: 'plan' });
    const benchmarkMs = performance.now() - started;
    return {
      dates: planned.rows.map(row => row.date),
      firstInterest: planned.rows[0].interestCents,
      secondInterest: planned.rows[1].interestCents,
      match: compare.exactMatch, complete: compare.comparisonComplete,
      partialMatch: partial.matchingKnownFields, partialExact: partial.exactMatch,
      longClosed: long.complete, longRows: long.rows.length,
      benchmarkMs, bankParityVerified: planned.bankParityVerified,
    };
  });
  expect(result.dates).toEqual(['2026-02-01', '2026-03-01']);
  expect(result.firstInterest).toBe(10_192);
  expect(result.secondInterest).toBe(4_628);
  expect(result.match).toBe(true);
  expect(result.complete).toBe(true);
  expect(result.partialMatch).toBe(true);
  expect(result.partialExact).toBe(false);
  expect(result.bankParityVerified).toBe(false);
  expect(result.longClosed).toBe(true);
  expect(result.longRows).toBeLessThanOrEqual(360);
  expect(result.benchmarkMs).toBeLessThan(20_000);
  expect(await scopedState(page, 'state')).toEqual(before);
  console.log('Synthetic 360-month ACT/ACT-ISDA browser calculation (ms):', Math.round(result.benchmarkMs));
  watcher.assertClean();
});
