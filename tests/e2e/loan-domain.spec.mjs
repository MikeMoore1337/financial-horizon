import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { test, expect } from '@playwright/test';
import { observe, visitGuest, scopedState } from './helpers.mjs';

// Test only: serve the isolated TypeScript kernel to the real browser.
// This does not alter the production build, application, Service Worker or UI.
test.use({ serviceWorkers: 'block' });

const SOURCES = new Set(['index', 'engine', 'math', 'reconcile', 'types', 'legacy-preview']);

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
    const { calculateLoan, reconcileLoanSchedule, prepareLegacyLoanPreview } = await import('/fh-loan-qa/index.js');
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
    const legacy = {
      openingCents: 90_000, paymentCents: 30_000, termMonths: 3,
      dueDay: 31, asOfDate: '2026-02-01',
    };
    const unconfirmed = prepareLegacyLoanPreview(legacy);
    const approved = prepareLegacyLoanPreview(legacy, {
      agreementConfirmed: true, openingBalanceDateConfirmed: true,
      firstDueDate: '2026-02-28', dueDayAnchor: 31,
      annualRateMicroPercent: 0, dayCount: 'ACT/365F',
      rounding: 'HALF_UP', scheduleType: 'annuity',
      installmentBasis: 'fixed-contractual',
    });
    const anchoredDates = approved.terms
      ? calculateLoan(approved.terms, [], { mode: 'plan' }).rows.map(row => row.date)
      : [];
    const amended = calculateLoan({ ...terms, principalCents: 100_000,
      annualRateMicroPercent: 0, termMonths: 4 }, [{
      id: 'amend-march', type: 'payment-change',
      date: '2026-03-01', paymentCents: 30_000,
    }], { mode: 'plan' });
    return {
      amendedPlannedCents: amended.rows.map(row => row.plannedPaymentCents),
      amendedPaidCents: amended.rows.map(row => row.amountCents),
      dates: planned.rows.map(row => row.date),
      unconfirmed: unconfirmed.status,
      unconfirmedTerms: unconfirmed.terms,
      approvedStatus: approved.status,
      approvedStoredDataChanged: approved.storedDataChanged,
      approvedBankParity: approved.bankParityVerified,
      anchoredDates,
      firstInterest: planned.rows[0].interestCents,
      secondInterest: planned.rows[1].interestCents,
      match: compare.exactMatch, complete: compare.comparisonComplete,
      partialMatch: partial.matchingKnownFields, partialExact: partial.exactMatch,
      longClosed: long.complete, longRows: long.rows.length,
      benchmarkMs, bankParityVerified: planned.bankParityVerified,
    };
  });
  expect(result.dates).toEqual(['2026-02-01', '2026-03-01']);
  expect(result.unconfirmed).toBe('needs-confirmation');
  expect(result.unconfirmedTerms).toBeNull();
  expect(result.approvedStatus).toBe('ready');
  expect(result.approvedStoredDataChanged).toBe(false);
  expect(result.approvedBankParity).toBe(false);
  expect(result.anchoredDates).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  expect(result.firstInterest).toBe(10_192);
  expect(result.secondInterest).toBe(4_628);
  expect(result.match).toBe(true);
  expect(result.complete).toBe(true);
  expect(result.partialMatch).toBe(true);
  expect(result.partialExact).toBe(false);
  expect(result.bankParityVerified).toBe(false);
  expect(result.amendedPlannedCents).toEqual([25_000, 30_000, 30_000, 30_000]);
  expect(result.amendedPaidCents).toEqual([25_000, 30_000, 30_000, 15_000]);
  expect(result.longClosed).toBe(true);
  expect(result.longRows).toBeLessThanOrEqual(360);
  expect(result.benchmarkMs).toBeLessThan(20_000);
  expect(await scopedState(page, 'state')).toEqual(before);
  console.log('Synthetic 360-month ACT/ACT-ISDA browser calculation (ms):', Math.round(result.benchmarkMs));
  watcher.assertClean();
});
