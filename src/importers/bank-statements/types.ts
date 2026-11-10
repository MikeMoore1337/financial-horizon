/** Pure, local-only parsing contract. No state, network, DOM, or database writes. */
export type BankCell = string | number | null;
export type BankFormat = 'csv' | 'xlsx';
export type DateOrder = 'DMY' | 'MDY';
export type NumberFormat = 'auto' | 'comma-decimal' | 'dot-decimal';
export type BankKind = 'income' | 'expense' | 'transfer';
export type WarningSeverity = 'info' | 'warning' | 'error';

export interface ImportWarning {
  code: string;
  message: string;
  severity: WarningSeverity;
  row?: number;
  column?: number;
}

export interface BankTableRow {
  /** Physical CSV line or one-based XLSX row, including the header. */
  rowNumber: number;
  cells: BankCell[];
}

export interface BankStatementTable {
  format: BankFormat;
  fileDigest: string;
  filename: string;
  headers: string[];
  headerRowNumber: number;
  csvEncoding?: string;
  csvDelimiter?: string;
  rows: BankTableRow[];
  warnings: ImportWarning[];
  sheetName?: string;
  dateSystem?: '1900' | '1904';
}

export type MappableField =
  | 'date' | 'amount' | 'income' | 'expense' | 'description'
  | 'account' | 'targetAccount' | 'category' | 'currency'
  | 'kind' | 'externalId';
export type ColumnMapping = Partial<Record<MappableField, number>>;

export interface KnownBankAccount {
  id: string;
  name: string;
  aliases?: readonly string[];
  currency: 'RUB';
}

export interface BankImportOptions {
  mapping: ColumnMapping;
  accounts: readonly KnownBankAccount[];
  categories?: readonly string[];
  defaultAccountId?: string;
  dateOrder?: DateOrder;
  numberFormat?: NumberFormat;
  /** For a positive transfer, explicitly specify how the two mapped accounts relate. */
  transferDirection?: 'signed-source' | 'from-to';
  /** Explicitly map CSV descriptions to a category, never silently create one. */
  categoryAliases?: Readonly<Record<string, string>>;
}

export interface NormalizedBankOperation {
  sourceRow: number;
  sourceKey: string;
  fingerprint: string;
  externalId: string | null;
  date: string;
  amountCents: number;
  kind: BankKind;
  description: string;
  accountId: string;
  targetAccountId: string | null;
  category: string | null;
  currency: 'RUB';
}

export interface OperationPreview {
  rowNumber: number;
  operation: NormalizedBankOperation | null;
  warnings: ImportWarning[];
}

export interface BankImportPreview {
  fileDigest: string;
  mapping: ColumnMapping;
  rows: OperationPreview[];
  warnings: ImportWarning[];
  accepted: number;
  rejected: number;
  inflowCents: number;
  outflowCents: number;
  /** Transfers are not an income or expense and are excluded from totals. */
  transfersCents: number;
}

export type MatchStatus = 'ready' | 'duplicate' | 'possible-duplicate' | 'invalid';
export interface ExistingBankMovement {
  id: string;
  sourceKey?: string | null;
  fingerprint?: string | null;
  externalId?: string | null;
  accountId: string;
  targetAccountId?: string | null;
  date: string;
  amountCents: number;
  kind: BankKind;
  description: string;
  category?: string | null;
  currency?: string | null;
  /** Any change or linked obligation/loan payment must forbid an undo proposal. */
  linkedPaymentId?: string | null;
  voidedAt?: string | null;
  importBatchKey?: string | null;
}

export interface ReconciledBankRow extends OperationPreview {
  status: MatchStatus;
  existingIds: string[];
}
export interface ReconciliationResult {
  rows: ReconciledBankRow[];
  ready: number;
  duplicates: number;
  possibleDuplicates: number;
  invalid: number;
}

export interface ImportBatchPlan {
  /** Stable for the same file and confirmed row selection; not a database commit. */
  batchKey: string;
  sourceKeys: readonly string[];
  operations: readonly Readonly<NormalizedBankOperation>[];
  expectedOperationCount: number;
  journal: readonly { type: 'planned'; sourceKey: string; sourceRow: number }[];
}

export interface ImportUndoPlan {
  batchKey: string;
  movementIds: string[];
  expectedOperationCount: number;
}

/** A privacy-safe proposal for an import audit, never a persisted event. */
export interface BankImportAuditSummary {
  version: 1;
  reviewedRows: number;
  ready: number;
  duplicate: number;
  possibleDuplicate: number;
  invalid: number;
  plannedRows: number;
  warningCounts: readonly { code: string; count: number }[];
  errorRows: readonly { rowNumber: number; codes: readonly string[] }[];
  omittedErrorRows: number;
}

export interface AccountBalanceSnapshot {
  accountId: string;
  currentCents: number;
  statementClosingCents?: number;
}

export interface AccountBalanceProjection {
  accountId: string;
  currentCents: number;
  deltaCents: number;
  projectedCents: number;
  discrepancyCents: number | null;
}
