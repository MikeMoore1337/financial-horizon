/**
 * Persisted v1/v2 finance records. Values are integer minor currency units;
 * never turn them into floating-point rubles in storage or API contracts.
 * Existing runtime validation remains in finance.js during the JS -> TS migration.
 */
declare const centsBrand: unique symbol;
declare const dateBrand: unique symbol;
declare const monthBrand: unique symbol;
declare const identifierBrand: unique symbol;

export type Cents = number & { readonly [centsBrand]: 'integer-minor-units' };
export type ISODate = string & { readonly [dateBrand]: 'YYYY-MM-DD' };
export type ISOMonth = string & { readonly [monthBrand]: 'YYYY-MM' };
export type FinanceId = string & { readonly [identifierBrand]: 'finance-id' };
export type Recurrence = 'once' | 'monthly' | 'yearly';

export interface FinanceEntry {
  id: FinanceId;
  title: string;
  kind: 'income' | 'expense';
  amountCents: Cents;
  date: ISODate;
  recurrence: Recurrence;
  category: string;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface LoanScheduleRow {
  date: ISODate;
  amountCents: Cents;
  balanceCents?: Cents;
  interestCents?: Cents | null;
  principalCents?: Cents | null;
}

export interface FinanceLoan {
  id: FinanceId;
  title: string;
  openingCents: Cents;
  paymentCents: Cents;
  apr: number;
  termMonths: number;
  dueDay: number;
  asOfDate: ISODate;
  schedule?: LoanScheduleRow[];
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface LoanPayment {
  id: FinanceId;
  loanId: FinanceId;
  date: ISODate;
  amountCents: Cents;
  strategy: 'amount' | 'term';
  createdAt: string;
  updatedAt?: string;
  voidedAt?: string | null;
}

export interface Settlement {
  id: FinanceId;
  entryId: FinanceId;
  occurrence: ISOMonth;
  date: ISODate;
  amountCents: Cents;
  createdAt: string;
  updatedAt?: string;
  voidedAt?: string | null;
}

export interface AuditRecord {
  id?: FinanceId;
  action?: string;
  description: string;
  date: string;
  [key: string]: unknown;
}

export interface FinanceContents {
  entries: FinanceEntry[];
  loans: FinanceLoan[];
  settlements: Settlement[];
  loanPayments: LoanPayment[];
  categories: string[];
  audit: AuditRecord[];
  settings: { currency: 'RUB'; [key: string]: unknown };
}

export type FinanceStateV1 = FinanceContents & {
  version: 1;
  revision?: never;
};

export type FinanceStateV2 = FinanceContents & {
  version: 2;
  revision: number;
};

export type PersistedFinanceState = FinanceStateV1 | FinanceStateV2;

export type FinanceScope =
  'state' | 'guest-state-v2' | (string & { readonly __accountScope: true });

export function assertCents(input: number): asserts input is Cents {
  if (!Number.isSafeInteger(input) || input < 0) {
    throw new RangeError('Денежная сумма должна быть неотрицательным целым числом копеек');
  }
}
