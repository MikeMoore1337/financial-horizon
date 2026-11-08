import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LedgerState } from '../../src/domain/accounts/ledger.ts';
import { Accounts, type AccountsProps } from '../../src/react/Accounts';
import { deriveAccountsView, formatRubMinor, parseRubMinor } from '../../src/react/accounts-view-model';
import { createScreenRoot } from '../../src/react/ScreenRoot';

const PROFILE = '00000000-0000-4000-8000-0000000000aa';
const FOREIGN = '00000000-0000-4000-8000-0000000000dd';
const A = '00000000-0000-4000-8000-0000000000ab';
const B = '00000000-0000-4000-8000-0000000000ac';
const T = '00000000-0000-4000-8000-0000000000ad';

function snapshot(): LedgerState {
  return {
    profileId: PROFILE,
    revision: 1,
    accounts: [
      { id: A, profileId: PROFILE, name: 'Основной', kind: 'bank', currency: 'RUB',
        openingMinor: 13_500_000, entityRevision: 1, archivedAt: null },
      { id: B, profileId: PROFILE, name: 'Накопления', kind: 'savings', currency: 'RUB',
        openingMinor: 8_000_000, entityRevision: 1, archivedAt: null },
    ],
    transactions: [],
    postings: [],
    paymentLinks: [],
    receipts: [],
  };
}
function props(patch: Partial<AccountsProps> = {}): AccountsProps {
  return {
    snapshot: snapshot(),
    activeProfileId: PROFILE,
    reservedMinorByAccount: { [A]: 3_000_000, [B]: 0 },
    status: 'ready',
    writable: true,
    onBack: vi.fn(),
    onRefresh: vi.fn(),
    onCreate: vi.fn().mockResolvedValue(undefined),
    onUpdate: vi.fn().mockResolvedValue(undefined),
    onTransfer: vi.fn().mockResolvedValue(undefined),
    onArchive: vi.fn().mockResolvedValue(undefined),
    onUnarchive: vi.fn().mockResolvedValue(undefined),
    ...patch,
  };
}
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('approved account model and money safety', () => {
  it('uses exact integer kopecks; respects decimal separators and money boundaries', () => {
    expect(parseRubMinor('1 000,01')).toBe(100001);
    expect(parseRubMinor('1\u202f234,56')).toBe(123456);
    expect(parseRubMinor('0,00', true)).toBe(0);
    expect(parseRubMinor('-1,25', true)).toBe(-125);
    expect(formatRubMinor(-125)).toContain('−1,25 ₽');
    expect(() => parseRubMinor('-1,00')).toThrow();
    expect(() => parseRubMinor('1,234')).toThrow();
    expect(() => parseRubMinor('1e6')).toThrow();
    expect(() => parseRubMinor('10000000000,01', true)).toThrow();
    expect(() => parseRubMinor('')).toThrow();
  });
  it('distinguishes actual, allocated and available, never planned cash', () => {
    const data = snapshot();
    const original = structuredClone(data);
    const model = deriveAccountsView(data, PROFILE, { [A]: 3_000_000, [B]: 0 });
    expect(model.totalMinor).toBe(21_500_000);
    expect(model.reservedMinor).toBe(3_000_000);
    expect(model.availableMinor).toBe(18_500_000);
    expect(model.rows.find(row => row.id === A)?.availableMinor).toBe(10_500_000);
    expect(data).toEqual(original);
  });
  it('conserves assets and excludes internal transfers from expenses', () => {
    const data = snapshot();
    data.revision = 2;
    data.accounts.forEach(account => { account.entityRevision = 2; });
    data.transactions.push({ id: T, profileId: PROFILE, kind: 'transfer',
      occurredOn: '2026-11-08', note: null, actorUserId: 'a'.repeat(32),
      entityRevision: 1, reversedTransactionId: null });
    data.postings.push({ profileId: PROFILE, transactionId: T, accountId: A, signedMinor: -100000 });
    data.postings.push({ profileId: PROFILE, transactionId: T, accountId: B, signedMinor: 100000 });
    const model = deriveAccountsView(data, PROFILE, { [A]: 0, [B]: 0 });
    expect(model.totalMinor).toBe(21_500_000);
    expect(model.rows.find(row => row.id === A)?.balanceMinor).toBe(13_400_000);
    expect(model.rows.find(row => row.id === B)?.balanceMinor).toBe(8_100_000);
  });
  it('fails closed on foreign profiles, unavailable reserves and tampering', () => {
    const data = snapshot();
    expect(() => deriveAccountsView(data, FOREIGN, { [A]: 0, [B]: 0 })).toThrow();
    expect(() => deriveAccountsView(data, PROFILE, { [A]: 0 })).toThrow();
    expect(() => deriveAccountsView(data, PROFILE, { [A]: 0, [B]: -1 })).toThrow();
    data.accounts[0]!.openingMinor = Number.POSITIVE_INFINITY;
    expect(() => deriveAccountsView(data, PROFILE, { [A]: 0, [B]: 0 })).toThrow();
  });
});

describe('approved accounts interface (feature not exposed)', () => {
  it('renders only confirmed amounts and five-item nav remains untouched', () => {
    render(<Accounts {...props()} />);
    expect(screen.getByRole('heading', { name: 'Счета' })).toBeTruthy();
    expect(screen.getByText('21' + '\u00a0' + '500,00 ₽')).toBeTruthy();
    expect(screen.getByText('Основной')).toBeTruthy();
    expect(screen.getByText('Накопления')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Перевести' })).toHaveLength(2);
    expect(document.querySelectorAll('[data-view]')).toHaveLength(0);
  });
  it('requires explicit opening balance; cannot create inferred zeros', async () => {
    const data = props();
    render(<Accounts {...data} />);
    fireEvent.click(screen.getByRole('button', { name: /Новый счёт/ }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Название'), { target: { value: 'Наличные' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(data.onCreate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Начальный остаток/), { target: { value: '0,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(data.onCreate).toHaveBeenCalledWith({
      name: 'Наличные', kind: 'bank', openingMinor: 0,
    }));
    expect(data.onRefresh).toHaveBeenCalledTimes(1);
  });
  it('previews transfer from an authoritative snapshot and passes expected revisions', async () => {
    const data = props();
    render(<Accounts {...data} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Перевести' })[0]!);
    fireEvent.change(screen.getByLabelText('Сумма в рублях'), { target: { value: '1 000,00' } });
    fireEvent.change(screen.getByLabelText('Дата перевода'), { target: { value: '2026-11-08' } });
    expect(screen.getByText(/Без изменений/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить перевод' }));
    await waitFor(() => expect(data.onTransfer).toHaveBeenCalledWith({
      fromAccountId: A, toAccountId: B, amountMinor: 100000, occurredOn: '2026-11-08',
      baseRevision: 1, expectedEntityRevisions: { [A]: 1, [B]: 1 },
    }));
    expect(data.snapshot!.accounts[0]!.openingMinor).toBe(13_500_000);
    expect(data.onRefresh).toHaveBeenCalledTimes(1);
  });
  it('cannot consume explicitly reserved funds via a transfer preview', () => {
    const data = props({ reservedMinorByAccount: { [A]: 13_400_000, [B]: 0 } });
    render(<Accounts {...data} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Перевести' })[0]!);
    fireEvent.change(screen.getByLabelText('Сумма в рублях'), { target: { value: '2 000,00' } });
    fireEvent.change(screen.getByLabelText('Дата перевода'), { target: { value: '2026-11-08' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить перевод' }));
    expect(data.onTransfer).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/зарезервированные/);
  });
  it('does not show another account or allow writes on conflict/offline', () => {
    const wrong = props({ activeProfileId: FOREIGN });
    const view = render(<Accounts {...wrong} />);
    expect(screen.queryByText('Основной')).toBeNull();
    expect(screen.getByText(/Сведения о счетах недоступны/)).toBeTruthy();
    view.rerender(<Accounts {...props({ status: 'offline' })} />);
    expect(screen.getByRole('button', { name: /Новый счёт/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Нет связи с сервером/)).toBeTruthy();
  });
  it('locks uncertain network result instead of silently retrying financial mutation', async () => {
    const send = vi.fn().mockRejectedValue(new Error('timeout after possible commit'));
    const data = props({ onTransfer: send });
    render(<Accounts {...data} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Перевести' })[0]!);
    fireEvent.change(screen.getByLabelText('Сумма в рублях'), { target: { value: '1 000,00' } });
    fireEvent.change(screen.getByLabelText('Дата перевода'), { target: { value: '2026-11-08' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить перевод' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/не подтверждён/));
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Подтвердить перевод' }).hasAttribute('disabled')).toBe(true);
  });
  it('keeps the new screen inaccessible without a caller route, and blocks invalid auth', () => {
    const host = document.createElement('main');
    document.body.append(host);
    const root = createScreenRoot(host, () => ({
      kind: 'account', accountId: PROFILE, verifiedUserId: FOREIGN, sessionValid: true,
    }));
    root.render({ view: 'accounts', props: props() });
    expect(host.querySelector('h1')).toBeNull();
    root.unmount();
  });
  it('escapes untrusted account names', () => {
    const p = props();
    p.snapshot!.accounts[0]!.name = '<img src=x onerror=alert(1)>';
    render(<Accounts {...p} />);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
});
