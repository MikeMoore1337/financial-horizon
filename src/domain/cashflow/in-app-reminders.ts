/**
 * #40: deterministic, read-only in-app reminder projection.
 * Callers supply confirmed getMonthEvents() rows and/or verified #6 projections.
 * No persistence, notification API, network, account mutation or financial ledger.
 */
import { dayNumber } from './calendar.ts';
import type { ReserveProjection } from '../reserves/index.ts';

export type ReminderLead = 1 | 3 | 7;
export type ReminderTrigger = 'advance' | 'today' | 'overdue';

export interface ReminderSettings {
  readonly enabled: boolean;
  readonly daysBefore: readonly ReminderLead[];
}

export const DEFAULT_REMINDER_SETTINGS: Readonly<ReminderSettings> = Object.freeze({
  enabled: true,
  daysBefore: Object.freeze([1, 3, 7] as const),
});

/** Existing finance.js getMonthEvents() record; no derived or duplicated payment ledger. */
export interface ConfirmedMonthOccurrence {
  readonly source: 'entry' | 'loan';
  readonly id: string;
  readonly title: string;
  readonly kind: 'income' | 'expense';
  readonly date: string;
  readonly plannedCents: number;
  readonly paidCents: number;
}

export interface DuePayment {
  readonly key: string;
  readonly source: 'entry' | 'loan';
  readonly recordId: string;
  readonly occurrence: string;
  readonly title: string;
  readonly dueDate: string;
  readonly plannedCents: number;
  readonly paidCents: number;
  readonly remainingCents: number;
  readonly daysUntilDue: number;
  readonly partial: boolean;
  readonly status: 'upcoming' | 'today' | 'overdue';
}

interface ReminderBase {
  readonly id: string;
  readonly title: string;
  readonly dueDate: string;
  readonly daysUntilDue: number;
  readonly trigger: ReminderTrigger;
  readonly intervalDays: ReminderLead | null;
}

export interface PaymentReminder extends ReminderBase {
  readonly kind: 'payment';
  readonly source: 'entry' | 'loan';
  readonly recordId: string;
  readonly occurrence: string;
  readonly plannedCents: number;
  readonly paidCents: number;
  readonly remainingCents: number;
  readonly partial: boolean;
}

export interface ReserveReminder extends ReminderBase {
  readonly kind: 'reserve-shortfall';
  readonly source: 'reserve';
  readonly recordId: string;
  readonly occurrence: string;
  readonly cycleNumber: number;
  readonly targetCents: number;
  readonly remainingCents: number;
  readonly reservedCents: number;
  /** Current funding gap, not a negative bank-account balance. */
  readonly fundingGapCents: number;
  /** #6 projection with future scheduled contributions, not confirmed money. */
  readonly projectedShortfallCents: number;
}

export type InAppReminder = PaymentReminder | ReserveReminder;

export interface ReminderInput {
  /** An already verified guest/account scope. Never mix sources from different actors. */
  readonly scopeKey: string;
  /** Local calendar date from localCalendarDate(), never a UTC date slice. */
  readonly currentDate: string;
  readonly settings: ReminderSettings;
  /** Can include previous unpaid cycles; each row is one confirmed occurrence. */
  readonly payments: readonly ConfirmedMonthOccurrence[];
  /** Only verified server-backed #6 ReserveProjection objects. */
  readonly reserves?: readonly ReserveProjection[];
  readonly maxAlerts?: number;
}

export interface ReminderResult {
  /** Unpaid payments, independent of the enable/disable switch. */
  readonly duePayments: readonly DuePayment[];
  readonly alerts: readonly InAppReminder[];
  readonly totalAlerts: number;
  readonly hiddenAlerts: number;
}

const ALLOWED_LEADS = new Set<number>([1, 3, 7]);
const MAX_CENTS = 1_000_000_000_000;

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() ||
      value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RangeError(`${label}: некорректный идентификатор`);
  }
}

function amount(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
      value < 0 || value > MAX_CENTS) {
    throw new RangeError(`${label}: требуется неотрицательная сумма в копейках`);
  }
}

function daysBetween(today: string, due: string): number {
  return dayNumber(due) - dayNumber(today);
}

function triggerFor(days: number, enabledLeads: Set<number>): ReminderTrigger | null {
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  return enabledLeads.has(days) ? 'advance' : null;
}

function reminderId(
  scope: string, kind: string, source: string, id: string,
  occurrence: string, trigger: ReminderTrigger, interval: number | null,
): string {
  // JSON encoding prevents collisions between composite identity parts.
  return JSON.stringify(['fh-reminder-v1', scope, kind, source, id, occurrence, trigger, interval]);
}

function urgency(a: { daysUntilDue: number; dueDate: string; title: string },
                 b: { daysUntilDue: number; dueDate: string; title: string }): number {
  const group = (days: number) => days === 0 ? 0 : days < 0 ? 1 : 2;
  const aGroup = group(a.daysUntilDue);
  const bGroup = group(b.daysUntilDue);
  if (aGroup !== bGroup) return aGroup - bGroup;
  // Prefer the latest missed installment, not an endless backlog of old ones.
  const dateOrder = aGroup === 1
    ? b.dueDate.localeCompare(a.dueDate)
    : a.dueDate.localeCompare(b.dueDate);
  return dateOrder || a.title.localeCompare(b.title, 'ru');
}

function validatedSettings(settings: ReminderSettings): Set<number> {
  if (!settings || typeof settings.enabled !== 'boolean' ||
      !Array.isArray(settings.daysBefore)) {
    throw new TypeError('Некорректные настройки напоминаний');
  }
  const leads = new Set<number>();
  for (const lead of settings.daysBefore) {
    if (!ALLOWED_LEADS.has(lead)) throw new RangeError('Допустимы интервалы 1, 3 и 7 дней');
    leads.add(lead);
  }
  return leads;
}

/** Calendar date in a selected IANA timezone, safe around midnight and DST. */
export function localCalendarDate(instant: Date, timeZone?: string): string {
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
    throw new RangeError('Некорректный момент времени');
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    ...(timeZone ? { timeZone } : {}),
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant);
  const value = (kind: string) => parts.find((part) => part.type === kind)?.value;
  const year = value('year')?.padStart(4, '0');
  const month = value('month');
  const day = value('day');
  if (!year || !month || !day) throw new RangeError('Невозможно определить локальную дату');
  const date = `${year}-${month}-${day}`;
  dayNumber(date);
  return date;
}

/**
 * Pure projection: reading the same snapshot in two tabs returns the same event IDs.
 * Past advance triggers are never replayed after a long absence.
 */
export function buildInAppReminders(input: ReminderInput): ReminderResult {
  identifier(input.scopeKey, 'Область данных');
  const currentDate = input.currentDate;
  dayNumber(currentDate);
  const leads = validatedSettings(input.settings);
  const maxAlerts = input.maxAlerts ?? 100;
  if (!Number.isSafeInteger(maxAlerts) || maxAlerts < 1 || maxAlerts > 1_000) {
    throw new RangeError('Лимит событий должен быть от 1 до 1000');
  }

  const duePayments: DuePayment[] = [];
  const alerts: InAppReminder[] = [];
  const paymentSeen = new Map<string, string>();
  const reserveSeen = new Map<string, string>();

  for (const row of input.payments) {
    if (row.source !== 'entry' && row.source !== 'loan') {
      throw new RangeError('Неизвестный источник платежа');
    }
    if (row.kind !== 'expense' && row.kind !== 'income') {
      throw new RangeError('Неизвестное направление операции');
    }
    if (row.kind === 'income') continue;
    identifier(row.id, 'Платёж');
    if (typeof row.title !== 'string' || !row.title.trim()) {
      throw new RangeError('У платежа нет названия');
    }
    amount(row.plannedCents, 'Плановая сумма');
    amount(row.paidCents, 'Подтверждённая оплата');
    const daysUntilDue = daysBetween(currentDate, row.date);
    const occurrence = row.date.slice(0, 7);
    const key = JSON.stringify([row.source, row.id, occurrence]);
    const signature = JSON.stringify([
      row.title, row.date, row.plannedCents, row.paidCents,
    ]);
    const prior = paymentSeen.get(key);
    if (prior !== undefined) {
      if (prior !== signature) throw new RangeError('Противоречивые экземпляры платежа');
      continue;
    }
    paymentSeen.set(key, signature);
    const remainingCents = Math.max(0, row.plannedCents - row.paidCents);
    if (remainingCents === 0) continue;
    const partial = row.paidCents > 0;
    const payment: DuePayment = {
      key, source: row.source, recordId: row.id, occurrence, title: row.title,
      dueDate: row.date, plannedCents: row.plannedCents,
      paidCents: row.paidCents, remainingCents, daysUntilDue, partial,
      status: daysUntilDue < 0 ? 'overdue' : daysUntilDue === 0 ? 'today' : 'upcoming',
    };
    duePayments.push(payment);
    if (!input.settings.enabled) continue;
    const trigger = triggerFor(daysUntilDue, leads);
    if (!trigger) continue;
    const intervalDays = trigger === 'advance' ? daysUntilDue as ReminderLead : null;
    alerts.push({
      id: reminderId(input.scopeKey, 'payment', row.source, row.id,
        occurrence, trigger, intervalDays),
      kind: 'payment', source: row.source, recordId: row.id, occurrence,
      title: row.title, dueDate: row.date, daysUntilDue, trigger, intervalDays,
      plannedCents: row.plannedCents, paidCents: row.paidCents, remainingCents, partial,
    });
  }

  for (const row of input.reserves ?? []) {
    identifier(row.id, 'Резерв');
    if (typeof row.title !== 'string' || !row.title.trim() ||
        !Number.isSafeInteger(row.cycleNumber) || row.cycleNumber < 1) {
      throw new RangeError('Некорректное описание цикла резерва');
    }
    amount(row.targetCents, 'Цель резерва');
    amount(row.remainingObligationCents, 'Остаток обязательства');
    amount(row.reservedCents, 'Накопленный резерв');
    amount(row.fundingGapCents, 'Недостаток накоплений');
    amount(row.projectedShortfallCents, 'Прогноз дефицита');
    if (row.remainingObligationCents > row.targetCents ||
        row.fundingGapCents !== Math.max(0, row.remainingObligationCents - row.reservedCents) ||
        row.projectedShortfallCents > row.fundingGapCents ||
        row.cyclePaid !== (row.remainingObligationCents === 0)) {
      throw new RangeError('Противоречивое подтверждённое состояние резерва');
    }
    const daysUntilDue = daysBetween(currentDate, row.dueDate);
    const occurrence = String(row.cycleNumber);
    const key = JSON.stringify([row.id, occurrence]);
    const signature = JSON.stringify([
      row.title, row.dueDate, row.targetCents, row.remainingObligationCents,
      row.reservedCents, row.fundingGapCents, row.projectedShortfallCents,
    ]);
    const prior = reserveSeen.get(key);
    if (prior !== undefined) {
      if (prior !== signature) throw new RangeError('Противоречивые экземпляры резерва');
      continue;
    }
    reserveSeen.set(key, signature);
    if (!input.settings.enabled || row.cyclePaid || row.fundingGapCents === 0) continue;
    const trigger = triggerFor(daysUntilDue, leads);
    if (!trigger) continue;
    const intervalDays = trigger === 'advance' ? daysUntilDue as ReminderLead : null;
    alerts.push({
      id: reminderId(input.scopeKey, 'reserve-shortfall', 'reserve',
        row.id, occurrence, trigger, intervalDays),
      kind: 'reserve-shortfall', source: 'reserve', recordId: row.id, occurrence,
      title: row.title, dueDate: row.dueDate, daysUntilDue, trigger, intervalDays,
      cycleNumber: row.cycleNumber, targetCents: row.targetCents,
      remainingCents: row.remainingObligationCents, reservedCents: row.reservedCents,
      fundingGapCents: row.fundingGapCents,
      projectedShortfallCents: row.projectedShortfallCents,
    });
  }

  duePayments.sort(urgency);
  alerts.sort(urgency);
  return {
    duePayments,
    alerts: alerts.slice(0, maxAlerts),
    totalAlerts: alerts.length,
    hiddenAlerts: Math.max(0, alerts.length - maxAlerts),
  };
}
