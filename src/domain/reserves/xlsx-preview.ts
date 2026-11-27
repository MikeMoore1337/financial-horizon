/**
 * Read-only #6 preview adapter for the existing two-paydays XLSX importer.
 * Does not alter imported expenses, create obligations or send finance commands.
 * The UI and the server must separately enforce explicit consent and ownership.
 */
import { calculateReserve, type ReserveDefinition } from './index.ts';
import { parseReservePeriodHint, type ReservePeriodHint } from './import-suggestions.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MONEY_MAX = 1_000_000_000_000;
const SOURCE = /^I([1-9][0-9]{0,2})$/;

export interface ImportedExpenseRow {
  readonly source: string;
  readonly title: string;
  readonly kind: string;
  readonly amountCents: number;
}

interface BaseSuggestion {
  readonly source: string;
  readonly rowNumber: number;
  readonly rawCells: readonly unknown[];
  readonly title: string;
  readonly importedAmountCents: number;
  readonly confirmationRequired: true;
}
export type XlsxReservePreview =
  | (BaseSuggestion & { readonly status: 'suggestion'; readonly periodMonths: number })
  | (BaseSuggestion & { readonly status: 'invalid'; readonly reason: 'out-of-range' | 'ambiguous' | 'oversized' | 'unsupported' });

function cents(value: unknown, key: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
      || value < min || value > MONEY_MAX) {
    throw new RangeError(`${key}: требуется безопасная сумма в целых копейках`);
  }
  return value;
}

function identifier(value: unknown, key: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new RangeError(`${key}: недопустимый UUID`);
  }
  return value;
}

/** Match only existing parsed expense sources. Never infer a new spreadsheet row. */
export function previewXlsxReserves(
  rows: readonly (readonly unknown[])[],
  importedEntries: readonly ImportedExpenseRow[],
): readonly XlsxReservePreview[] {
  if (!Array.isArray(rows) || rows.length > 500
      || !Array.isArray(importedEntries) || importedEntries.length > 500) {
    throw new RangeError('Превышен безопасный размер предварительного просмотра');
  }
  const result: XlsxReservePreview[] = [];
  const sources = new Set<string>();
  for (const entry of importedEntries) {
    if (entry.kind !== 'expense') continue;
    const match = SOURCE.exec(entry.source);
    if (!match) throw new RangeError('Неподдерживаемая ссылка на исходную строку');
    if (sources.has(entry.source)) throw new RangeError('Повторяющаяся исходная строка');
    sources.add(entry.source);
    const rowNumber = Number(match[1]);
    const row = rows[rowNumber - 1];
    if (!Array.isArray(row) || row.length > 128) {
      throw new RangeError('Исходная строка XLSX недоступна');
    }
    if (typeof entry.title !== 'string' || !entry.title.trim()
        || String(row[8] ?? '').trim().slice(0, 100) !== entry.title) {
      throw new RangeError('Исходная строка и импортированное обязательство не совпадают');
    }
    const importedAmountCents = cents(entry.amountCents, 'Исходная сумма', 1);
    const hint: ReservePeriodHint | null = parseReservePeriodHint(row[11]);
    if (hint === null) continue;
    const base: BaseSuggestion = {
      source: entry.source, rowNumber, rawCells: [...row],
      title: entry.title, importedAmountCents, confirmationRequired: true,
    };
    result.push(hint.status === 'suggestion'
      ? { ...base, status: 'suggestion', periodMonths: hint.periodMonths }
      : { ...base, status: 'invalid', reason: hint.reason });
  }
  return result;
}

export interface ConfirmedXlsxReserve {
  /** An existing, server-authorized obligation is mandatory: never create a duplicate. */
  readonly obligationId: string;
  readonly accountId: string;
  readonly reserveId: string;
  readonly openedOn: string;
  readonly firstDueOn: string;
  readonly dueDay: number;
  readonly targetCents: number;
  readonly openingReservedCents: number;
  readonly contributionMode: 'auto' | 'fixed';
  readonly fixedMonthlyCents?: number;
  readonly confirmed: true;
  /** This adapter leaves the original imported expense unchanged. */
  readonly sourceHandling: 'keep-original-unchanged';
}

/** Validate a deliberate user decision, returning a draft only, never a write. */
export function confirmXlsxReservePreview(
  preview: XlsxReservePreview,
  decision: ConfirmedXlsxReserve,
): { readonly source: string; readonly payload: Readonly<Record<string, string | number | null>> } {
  if (preview.status !== 'suggestion' || preview.confirmationRequired !== true
      || decision?.confirmed !== true || decision.sourceHandling !== 'keep-original-unchanged') {
    throw new RangeError('Требуется явное подтверждение определённого периода и сохранения исходной записи');
  }
  const id = identifier(decision.reserveId, 'Резерв');
  const accountId = identifier(decision.accountId, 'Счёт');
  const obligationId = identifier(decision.obligationId, 'Существующее обязательство');
  if (decision.contributionMode !== 'auto' && decision.contributionMode !== 'fixed') {
    throw new RangeError('Способ взноса необходимо выбрать явно');
  }
  if (decision.contributionMode === 'fixed' && decision.fixedMonthlyCents === undefined) {
    throw new RangeError('Нужен фиксированный ежемесячный взнос');
  }
  if (decision.contributionMode === 'auto' && decision.fixedMonthlyCents !== undefined) {
    throw new RangeError('Автоматический план не допускает фиксированного взноса');
  }
  const target = cents(decision.targetCents, 'Подтверждённая сумма', 1);
  const opening = cents(decision.openingReservedCents, 'Уже накоплено', 0);
  const definition: ReserveDefinition = {
    id, title: preview.title, openedOn: decision.openedOn,
    firstDueDate: decision.firstDueOn, periodMonths: preview.periodMonths,
    targetCents: target, openingReservedCents: opening,
    contributionMode: decision.contributionMode, dueDay: decision.dueDay,
    ...(decision.contributionMode === 'fixed'
      ? { fixedMonthlyCents: cents(decision.fixedMonthlyCents, 'Фиксированный взнос', 1) } : {}),
  };
  // Reuse the existing engine's short-month/date/period rules, not a duplicate calendar.
  calculateReserve(definition, [], definition.openedOn);
  return {
    source: preview.source,
    payload: {
      id, obligation_id: obligationId, account_id: accountId,
      title: preview.title, opened_on: definition.openedOn,
      first_due_on: definition.firstDueDate, period_months: definition.periodMonths,
      due_day: definition.dueDay!, target_minor: target,
      opening_reserved_minor: opening, contribution_mode: definition.contributionMode,
      fixed_monthly_minor: definition.fixedMonthlyCents ?? null,
    },
  };
}
