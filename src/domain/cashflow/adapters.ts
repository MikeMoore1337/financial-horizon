import type { CashflowInputDto, CashflowSourcesDto } from './types.ts';

/** Safe signed kopeck arithmetic, rejecting both non-integers and IEEE-754 overflow. */
export function cents(value: number, field: string, nonNegative = false): number {
  if (!Number.isSafeInteger(value) || (nonNegative && value < 0)) {
    throw new RangeError(`${field} must be a ${nonNegative ? 'nonnegative ' : ''}safe integer of kopecks`);
  }
  return value;
}

export function addCents(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new RangeError('Cashflow amount exceeds safe integer kopecks');
  return sum;
}

/**
 * Pure consolidation at a common, explicitly confirmed opening-date snapshot.
 * It intentionally does NOT read account storage, execute ledger commands or fetch loans.
 */
export function adaptCashflowSources(source: CashflowSourcesDto): CashflowInputDto {
  if (source.accounts.length === 0) throw new RangeError('Explicit confirmed account snapshot is required');
  const accountIds = new Set<string>();
  let openingBalanceCents = 0;
  for (const account of source.accounts) {
    if (!account.id || accountIds.has(account.id)) throw new RangeError('Duplicate or empty account ID');
    if (account.currency !== 'RUB') throw new RangeError('Only RUB accounts can be consolidated');
    accountIds.add(account.id);
    openingBalanceCents = addCents(openingBalanceCents,
      cents(account.openingBalanceCents, 'account.openingBalanceCents'));
  }
  const reserveIds = new Set<string>();
  let openingReservedCents = 0;
  for (const reserve of source.reserves) {
    if (!reserve.id || reserveIds.has(reserve.id)) throw new RangeError('Duplicate or empty reserve ID');
    if (!accountIds.has(reserve.accountId)) throw new RangeError('Reserve references an unknown account');
    reserveIds.add(reserve.id);
    openingReservedCents = addCents(openingReservedCents,
      cents(reserve.openingReservedCents, 'reserve.openingReservedCents', true));
  }
  return {
    openingDate: source.openingDate,
    openingBalanceCents,
    openingReservedCents,
    asOfDate: source.asOfDate,
    horizonMonths: source.horizonMonths,
    plans: source.plans,
    actuals: source.actuals,
    overrides: source.overrides,
    reserves: source.reserveMovements,
  };
}
