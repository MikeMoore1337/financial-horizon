import type { AccountKind, LedgerState } from '../domain/accounts/ledger.ts';
import { MAX_MINOR } from '../domain/accounts/money.ts';
import { assertLedgerState } from '../domain/accounts/invariants.ts';

export type { AccountKind };

export interface AccountViewRow {
  id: string;
  name: string;
  kind: AccountKind;
  entityRevision: number;
  archived: boolean;
  balanceMinor: number;
  reservedMinor: number;
  availableMinor: number;
}

export interface AccountsViewModel {
  rows: AccountViewRow[];
  totalMinor: number;
  reservedMinor: number;
  availableMinor: number;
}

/** Convert explicit user-entered RUB into bounded integer kopecks, without float math. */
export function parseRubMinor(value: string, allowNegative = false): number {
  if (typeof value !== 'string') throw new TypeError('Укажите сумму');
  const match = /^(-?)(\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)(?:[,.](\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new TypeError('Сумма должна содержать рубли и не более двух знаков копеек');
  const isNegative = match[1] === '-';
  if (isNegative && !allowNegative) throw new RangeError('Сумма должна быть положительной');
  const rubles = match[2]!.replace(/[ \u00a0\u202f]/g, '');
  const kopecks = (match[3] || '').padEnd(2, '0');
  const minor = BigInt(rubles) * 100n + BigInt(kopecks || '0');
  if (minor > BigInt(MAX_MINOR)) throw new RangeError('Сумма превышает допустимый предел');
  return Number(isNegative ? -minor : minor);
}

export function formatRubMinor(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new RangeError('Некорректная сумма');
  const absolute = Math.abs(minor);
  const rubles = Math.floor(absolute / 100);
  const kopecks = String(absolute % 100).padStart(2, '0');
  return (minor < 0 ? '−' : '') + new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 0,
    useGrouping: true,
  }).format(rubles) + ',' + kopecks + ' ₽';
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError('Остаток превышает допустимый предел');
  return result;
}

/** Never invent reserves: every account must have an explicit trusted value. */
export function deriveAccountsView(
  snapshot: LedgerState,
  activeProfileId: string,
  reservedMinorByAccount: Readonly<Record<string, number>>,
): AccountsViewModel {
  if (!snapshot || !activeProfileId || snapshot.profileId !== activeProfileId) {
    throw new Error('Нет доступа к финансовому профилю');
  }
  assertLedgerState(snapshot);
  if (!reservedMinorByAccount || typeof reservedMinorByAccount !== 'object' ||
    Array.isArray(reservedMinorByAccount)) {
    throw new Error('Отсутствуют подтверждённые сведения о резервах');
  }
  const accountIds = new Set(snapshot.accounts.map(account => account.id));
  const balances = new Map(snapshot.accounts.map(account => [account.id, account.openingMinor]));
  for (const posting of snapshot.postings) {
    const balance = balances.get(posting.accountId);
    if (balance === undefined) throw new Error('Проводка без счёта');
    balances.set(posting.accountId, checkedAdd(balance, posting.signedMinor));
  }
  for (const id of Object.keys(reservedMinorByAccount)) {
    if (!accountIds.has(id)) throw new Error('Резерв с неизвестным счётом');
  }
  let totalMinor = 0;
  let reservedMinor = 0;
  const rows: AccountViewRow[] = snapshot.accounts.map(account => {
    if (!Object.prototype.hasOwnProperty.call(reservedMinorByAccount, account.id)) {
      throw new Error('Отсутствует подтверждённый резерв счёта');
    }
    const reserve = reservedMinorByAccount[account.id]!;
    if (!Number.isSafeInteger(reserve) || reserve < 0) {
      throw new Error('Повреждены сведения о резервах');
    }
    const balance = balances.get(account.id)!;
    const available = checkedAdd(balance, -reserve);
    totalMinor = checkedAdd(totalMinor, balance);
    reservedMinor = checkedAdd(reservedMinor, reserve);
    return {
      id: account.id,
      name: account.name,
      kind: account.kind,
      entityRevision: account.entityRevision,
      archived: account.archivedAt !== null,
      balanceMinor: balance,
      reservedMinor: reserve,
      availableMinor: available,
    };
  });
  rows.sort((a, b) => Number(a.archived) - Number(b.archived) ||
    a.name.localeCompare(b.name, 'ru') || a.id.localeCompare(b.id));
  return {
    rows,
    totalMinor,
    reservedMinor,
    availableMinor: checkedAdd(totalMinor, -reservedMinor),
  };
}

export function isValidLedgerDate(date: string): boolean {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const candidate = new Date(date + 'T00:00:00.000Z');
  return Number.isFinite(candidate.getTime()) && candidate.toISOString().slice(0, 10) === date;
}
