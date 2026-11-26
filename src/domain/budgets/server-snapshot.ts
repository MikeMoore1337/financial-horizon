/** #35 wire projection. A complete authenticated profile image is required.
 * No local receipt is synthesized, and no command is authorized here.
 */
import { MAX_MINOR, type BudgetRule } from './index.ts';
import { assertBudgetRules } from './rules.ts';
import type { BudgetCategoryAssignment } from './ledger-adapter.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
export const budgetEntityKinds = ['budget_category', 'budget_rule', 'budget_assignment'] as const;
type BudgetEntityKind = typeof budgetEntityKinds[number];

function invalid(reason: string): never {
  throw Error('INVALID_BUDGET_SNAPSHOT: ' + reason);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid('Повреждён идентификатор');
  return value;
}
function categoryId(value: unknown): string | null {
  return value === null ? null : uuid(value);
}
function month(value: unknown): string {
  if (typeof value !== 'string' || !MONTH.test(value) || value.startsWith('0000')) {
    invalid('Неверный месяц');
  }
  return value;
}
function optionalMonth(value: unknown): string | null {
  return value === null ? null : month(value);
}
function exact(data: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) {
    invalid('Неизвестные или отсутствующие бюджетные поля');
  }
}
function integer(value: unknown, lower: number, upper = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < lower || value > upper) {
    invalid('Неверная сумма или ревизия');
  }
  return value;
}

export interface ServerBudgetCategory {
  id: string;
  name: string;
  archived: boolean;
  entityRevision: number;
}
export interface ServerBudgetAssignment extends BudgetCategoryAssignment {
  id: string;
  entityRevision: number;
}
export interface ServerBudgetRule extends BudgetRule {
  entityRevision: number;
}
export interface ServerBudgetView {
  profileId: string;
  rules: ServerBudgetRule[];
  categories: ServerBudgetCategory[];
  assignments: ServerBudgetAssignment[];
}

type Decoded =
  | { kind: 'budget_category'; item: ServerBudgetCategory }
  | { kind: 'budget_rule'; item: ServerBudgetRule }
  | { kind: 'budget_assignment'; item: ServerBudgetAssignment };

export function decodeBudgetEntity(raw: unknown, profileId: string): Decoded {
  uuid(profileId);
  if (!object(raw) || !object(raw.data) ||
      !budgetEntityKinds.includes(raw.kind as BudgetEntityKind)) invalid('Неверный тип сущности');
  const id = uuid(raw.id);
  const entityRevision = integer(raw.entity_revision, 1);
  const data = raw.data;
  if (raw.kind === 'budget_category') {
    exact(data, ['name', 'archived']);
    if (typeof data.name !== 'string' || data.name.length === 0 ||
        Array.from(data.name).length > 40 || data.name !== data.name.trim() ||
        /[\x00-\x1f\x7f]/.test(data.name) || typeof data.archived !== 'boolean') {
      invalid('Повреждена категория');
    }
    return {kind: 'budget_category', item: {id, name: data.name, archived: data.archived, entityRevision}};
  }
  if (raw.kind === 'budget_rule') {
    exact(data, ['category_id','limit_minor','recurrence','from_month','ends_before_month','archived_from_month']);
    const category = categoryId(data.category_id);
    if (data.recurrence !== 'monthly' && data.recurrence !== 'once') invalid('Неверная периодичность');
    const rule: BudgetRule = {
      id, profileId, scope: category === null ? {kind: 'total'} : {kind: 'category', categoryId: category},
      limitMinor: integer(data.limit_minor, 0, MAX_MINOR),
      recurrence: data.recurrence, fromMonth: month(data.from_month),
      endsBeforeMonth: optionalMonth(data.ends_before_month),
      archivedFromMonth: optionalMonth(data.archived_from_month),
    };
    assertBudgetRules([rule], profileId);
    return {kind: 'budget_rule', item: {...rule, entityRevision}};
  }
  exact(data, ['transaction_id', 'category_id']);
  const transactionId = uuid(data.transaction_id);
  if (transactionId === id) invalid('Идентификатор назначения совпадает с проводкой');
  return {kind: 'budget_assignment', item: {
    id, profileId, transactionId, categoryId: categoryId(data.category_id), entityRevision,
  }};
}

/** Validate cross-entity references and every rule interval, including future
 * months. Reversed expenses retain their original classification for history.
 */
export function decodeBudgetEntities(entities: readonly unknown[], profileId: string): ServerBudgetView {
  uuid(profileId);
  const categories: ServerBudgetCategory[] = [];
  const rules: ServerBudgetRule[] = [];
  const assignments: ServerBudgetAssignment[] = [];
  const ids = new Set<string>();
  const transactionById = new Map<string, Record<string, unknown>>();
  for (const entry of entities) {
    if (!object(entry)) invalid('Повреждена сущность');
    if (entry.kind === 'transaction' && object(entry.data)) transactionById.set(uuid(entry.id), entry.data);
    if (!budgetEntityKinds.includes(entry.kind as BudgetEntityKind)) continue;
    const decoded = decodeBudgetEntity(entry, profileId);
    if (ids.has(decoded.item.id)) invalid('Повторяющийся идентификатор бюджета');
    ids.add(decoded.item.id);
    if (decoded.kind === 'budget_category') categories.push(decoded.item);
    else if (decoded.kind === 'budget_rule') rules.push(decoded.item);
    else assignments.push(decoded.item);
  }
  for (const entry of entities) {
    if (object(entry) && !budgetEntityKinds.includes(entry.kind as BudgetEntityKind) &&
        typeof entry.id === 'string' && ids.has(entry.id)) invalid('Бюджетный ID занят финансовой записью');
  }
  const categoryIds = new Set(categories.map(x => x.id));
  const names = new Set<string>();
  for (const category of categories) {
    const key = category.name.toLocaleLowerCase('ru-RU');
    if (names.has(key)) invalid('Повторяющееся название категории');
    names.add(key);
  }
  assertBudgetRules(rules.map(({entityRevision: _rev, ...rule}) => rule), profileId);
  for (const rule of rules) {
    if (rule.scope.kind === 'category' && !categoryIds.has(rule.scope.categoryId)) invalid('Нет категории лимита');
  }
  const assigned = new Set<string>();
  for (const item of assignments) {
    if (assigned.has(item.transactionId) || item.categoryId !== null && !categoryIds.has(item.categoryId)) {
      invalid('Повреждено назначение категории');
    }
    assigned.add(item.transactionId);
    const tx = transactionById.get(item.transactionId);
    if (!tx || !['expense','payment'].includes(String(tx.kind)) ||
        !Array.isArray(tx.postings) || tx.postings.length !== 1 || !object(tx.postings[0]) ||
        typeof tx.postings[0].signed_minor !== 'number' || !Number.isSafeInteger(tx.postings[0].signed_minor) ||
        tx.postings[0].signed_minor >= 0 || tx.postings[0].signed_minor < -MAX_MINOR ||
        tx.kind === 'payment' && !object(tx.payment_link)) invalid('Назначение не относится к расходу');
  }
  return {profileId, categories, rules, assignments};
}
