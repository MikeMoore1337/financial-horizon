import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { BankImport, type BankImportProps } from '../../src/importers/bank-statements/BankImport';

const ACCOUNT = vi.hoisted(() => '11111111-1111-4111-8111-111111111111');

vi.mock('../../src/importers/bank-statements/server.ts', () => ({
  loadSignedBankSnapshot: vi.fn(async () => ({
    revision: 101,
    etag: '"synthetic-strong-etag"',
    accounts: [{ id: ACCOUNT, name: 'Основной', entityRevision: 1, balanceMinor: 100000 }],
    movements: [],
    batches: [],
    historyNextCursor: 2,
  })),
  loadOlderSignedBankHistory: vi.fn(async () => ({
    batches: [
      {
        batch_id: '33333333-3333-4333-8333-333333333333',
        batch_key: 'c'.repeat(64),
        status: 'cancelled',
        operation_count: 1,
        committed_revision: 1,
        cancelled_revision: 100,
        committed_at: '2026-11-07T12:00:00+00:00',
      },
    ],
    historyNextCursor: null,
  })),
}));

vi.mock('../../src/importers/bank-statements/index.ts', () => ({
  readBankStatementFile: vi.fn(async () => ({
    format: 'csv',
    filename: 'synthetic.csv',
    fileDigest: 'd'.repeat(64),
    headers: ['Дата'],
    headerRowNumber: 1,
    rows: [{ rowNumber: 2, cells: ['2026-11-07'] }],
    warnings: [],
  })),
  suggestColumnMapping: vi.fn(() => ({
    mapping: { date: 0 },
    warnings: [],
  })),
  normalizeBankStatement: vi.fn(async () => ({
    rows: [
      {
        rowNumber: 2,
        warnings: [],
        operation: {
          sourceRow: 2,
          sourceKey: 'a'.repeat(64),
          fingerprint: 'b'.repeat(64),
          accountId: ACCOUNT,
          targetAccountId: null,
          date: '2026-11-07',
          amountCents: 12345,
          kind: 'expense',
          description: 'Synthetic sample',
          category: null,
          externalId: null,
          currency: 'RUB',
        },
      },
    ],
    accepted: 1,
    rejected: 0,
    warnings: [],
  })),
  reconcileBankStatement: vi.fn((preview) => ({
    rows: preview.rows.map((row) => ({
      ...row,
      status: 'ready',
      existingIds: [],
    })),
    ready: 1,
    duplicates: 0,
    possibleDuplicates: 0,
    invalid: 0,
  })),
  draftBankImportBatch: vi.fn(),
}));

vi.mock('../../src/importers/bank-statements/save.ts', () => ({
  buildBankCommitRequest: vi.fn(),
  buildBankUndoRequest: vi.fn(),
  commitConfirmedBankBatch: vi.fn(),
  undoConfirmedBankBatch: vi.fn(),
}));

afterEach(cleanup);

const props: BankImportProps = {
  mode: 'account',
  verifiedActorUserId: 'f'.repeat(32),
  guestLedger: null,
  guestRevision: 0,
  onBack: vi.fn(),
  onOpenAccounts: vi.fn(),
  onGuestAddAccount: vi.fn(async () => undefined),
  onGuestCommit: vi.fn(async () => undefined),
  onGuestUndo: vi.fn(async () => undefined),
};

it('#38: old history pagination cannot restore explicitly excluded bank operations', async () => {
  render(
    <StrictMode>
      <BankImport {...props} />
    </StrictMode>,
  );
  const more = await screen.findByRole('button', { name: 'Загрузить более ранние партии' });
  const upload = document.querySelector<HTMLInputElement>('.fh-bank-file input[type=file]');
  expect(upload).toBeTruthy();
  fireEvent.change(upload!, {
    target: {
      files: [
        {
          name: 'synthetic.csv',
          size: 50,
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        },
      ],
    },
  });
  const decision = await screen.findByRole('combobox', { name: 'Решение строки 2' });
  await waitFor(() => {
    expect((decision as HTMLSelectElement).value).toBe('include');
  });
  fireEvent.change(decision, { target: { value: 'skip' } });
  expect((decision as HTMLSelectElement).value).toBe('skip');
  const save = screen.getByRole('button', { name: /Подтвердить импорт 0 операций/ });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(more);
  await waitFor(() => {
    expect(document.querySelectorAll('.fh-bank-history')).toHaveLength(1);
  });
  expect((decision as HTMLSelectElement).value).toBe('skip');
  expect((save as HTMLButtonElement).disabled).toBe(true);
});
