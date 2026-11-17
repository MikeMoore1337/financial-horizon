/**
 * Read-only reconciliation of one reserve payment against the #33 account
 * projection. No posting, expense, persistence, clock, account lookup, or I/O.
 *
 * Account-scoped allocation must be validated by the authoritative server.
 * This is a calculation oracle, NEVER a financial write authorization.
 */
export interface ReservePaymentImpactInput {
  /** Real bank/account balance before a confirmed payment (signed kopecks). */
  readonly accountBalanceCents: number;
  /** All earmarked funds on this ONE account, including this obligation. */
  readonly allocatedOnAccountCents: number;
  /** Allocation belonging to this obligation on this account. */
  readonly reservedForObligationCents: number;
  /** Actual amount to be debited from the account exactly once. */
  readonly paymentCents: number;
  /** Part of the payment funded by this obligation's allocated money. */
  readonly reservedUsedCents: number;
}

export interface ReservePaymentImpact {
  readonly accountBalanceBeforeCents: number;
  readonly accountBalanceAfterCents: number;
  readonly allocatedBeforeCents: number;
  readonly allocatedAfterCents: number;
  readonly unreservedBeforeCents: number;
  readonly unreservedAfterCents: number;
  readonly unreservedDecreaseCents: number;
  /** The full real payment is the ONE ledger expense/debit. */
  readonly ledgerDebitCents: number;
  readonly expenseCents: number;
  /** Informational only: negative unreserved balance requires an external policy. */
  readonly canPayFromUnreservedAndAllocation: boolean;
  readonly unreservedShortfallCents: number;
}

function minor(value: number, name: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name}: требуется безопасное целое число копеек`);
  }
}

function checked(value: number, name: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name}: переполнение целых копеек`);
  }
  return value;
}

/**
 * Algebraically reconciles reserve consumption with a single actual payment.
 *
 * before available = balance - allocated
 * after balance = balance - actual payment
 * after allocated = allocated - reserved used
 * after available = before available - (payment - reserved used)
 *
 * Must not be used to post an account debit: #33/#67 own that responsibility.
 */
export function previewReservePaymentImpact(input: ReservePaymentImpactInput): ReservePaymentImpact {
  if (!input || typeof input !== 'object') throw new TypeError('Параметры оплаты не переданы');
  const { accountBalanceCents, allocatedOnAccountCents, reservedForObligationCents,
    paymentCents, reservedUsedCents } = input;
  minor(accountBalanceCents, 'Баланс счёта', -Number.MAX_SAFE_INTEGER);
  minor(allocatedOnAccountCents, 'Средства всех резервов счёта', 0);
  minor(reservedForObligationCents, 'Средства текущего резерва', 0);
  minor(paymentCents, 'Сумма фактической оплаты', 1);
  minor(reservedUsedCents, 'Использовано из резерва', 0);
  if (allocatedOnAccountCents < reservedForObligationCents) {
    throw new RangeError('Средства текущего резерва превышают все резервы счёта');
  }
  if (reservedUsedCents > reservedForObligationCents || reservedUsedCents > paymentCents) {
    throw new RangeError('Использование резерва превышает выделенные средства или оплату');
  }

  const accountBalanceAfterCents = checked(accountBalanceCents - paymentCents, 'Баланс после оплаты');
  const allocatedAfterCents = allocatedOnAccountCents - reservedUsedCents;
  const unreservedBeforeCents = checked(
    accountBalanceCents - allocatedOnAccountCents, 'Доступно до оплаты',
  );
  const unreservedAfterCents = checked(
    accountBalanceAfterCents - allocatedAfterCents, 'Доступно после оплаты',
  );
  const unreservedDecreaseCents = paymentCents - reservedUsedCents;
  const unreservedShortfallCents = checked(
    Math.max(0, unreservedDecreaseCents - unreservedBeforeCents), 'Недостаток средств',
  );
  // An explicit negative available balance is a policy decision for #33/#67;
  // this pure preview neither authorizes overdraft nor silently blocks a payment.
  return {
    accountBalanceBeforeCents: accountBalanceCents,
    accountBalanceAfterCents,
    allocatedBeforeCents: allocatedOnAccountCents,
    allocatedAfterCents,
    unreservedBeforeCents,
    unreservedAfterCents,
    unreservedDecreaseCents,
    ledgerDebitCents: paymentCents,
    expenseCents: paymentCents,
    canPayFromUnreservedAndAllocation: unreservedShortfallCents === 0,
    unreservedShortfallCents,
  };
}
