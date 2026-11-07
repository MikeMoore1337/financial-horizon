import type {
  BankCell, BankImportOptions, BankImportPreview, BankKind, BankStatementTable,
  ColumnMapping, ImportWarning, KnownBankAccount, NormalizedBankOperation,
  NumberFormat, OperationPreview, MappableField,
} from './types.ts';

const FIELDS: MappableField[] = [
  'date', 'amount', 'income', 'expense', 'description', 'account',
  'targetAccount', 'category', 'currency', 'kind', 'externalId',
];
const ALIASES: Readonly<Record<MappableField, readonly string[]>> = {
  date: ['дата', 'датаоперации', 'датапроведения', 'дататранзакции', 'date', 'bookingdate', 'transactiondate'],
  amount: ['сумма', 'суммаоперации', 'amount', 'sum', 'transactionamount'],
  income: ['приход', 'поступление', 'зачисление', 'credit', 'income', 'deposit'],
  expense: ['расход', 'списание', 'debit', 'expense', 'withdrawal'],
  description: ['описание', 'назначение', 'назначениеплатежа', 'детали', 'операция', 'description', 'details', 'merchant', 'memo'],
  account: ['счет', 'счетоперации', 'карта', 'account', 'accountnumber', 'card'],
  targetAccount: ['счетполучателя', 'счетназначения', 'счетзачисления', 'toaccount', 'targetaccount'],
  category: ['категория', 'category', 'categoryname'],
  currency: ['валюта', 'currency', 'ccy'],
  kind: ['тип', 'типоперации', 'видоперации', 'direction', 'type', 'operationtype'],
  externalId: ['идентификатор', 'номероперации', 'idоперации', 'transactionid', 'reference', 'operationid', 'externalid'],
};
const CODEC = new TextEncoder();
function warn(code: string, message: string, severity: ImportWarning['severity'], row?: number, column?: number): ImportWarning {
  return { code, message, severity, ...(row === undefined ? {} : { row }), ...(column === undefined ? {} : { column }) };
}
function norm(s: string): string {
  return s.trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[\s._\-№#/:]+/g, '');
}
function text(value: BankCell | undefined): string {
  return value === null || value === undefined ? '' : String(value).replace(/\u00a0/g, ' ').trim();
}
export async function sha256(value: Uint8Array | string): Promise<string> {
  const input = typeof value === 'string' ? CODEC.encode(value) : value;
  if (!globalThis.crypto?.subtle) throw new Error('Требуется браузер с Web Crypto (SHA-256)');
  const buffer = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(input));
  return Array.from(new Uint8Array(buffer), n => n.toString(16).padStart(2, '0')).join('');
}
export function suggestColumnMapping(headers: readonly string[]): {
  mapping: ColumnMapping; warnings: ImportWarning[];
} {
  const mapping: ColumnMapping = {}, warnings: ImportWarning[] = [];
  const normalized = headers.map(norm);
  for (const field of FIELDS) {
    const matches = normalized.map((header, index) =>
      ALIASES[field].includes(header) ? index : -1).filter(index => index >= 0);
    if (matches.length === 1) mapping[field] = matches[0];
    if (matches.length > 1) warnings.push(warn(
      'AMBIGUOUS_COLUMN', 'Неоднозначное соответствие колонки: ' + field, 'warning',
    ));
  }
  return { mapping, warnings };
}

function mappingWarnings(headers: readonly string[], mapping: ColumnMapping): ImportWarning[] {
  const warnings: ImportWarning[] = [];
  const seen = new Map<number, string>();
  for (const field of FIELDS) {
    const column = mapping[field];
    if (column === undefined) continue;
    if (!Number.isInteger(column) || column < 0 || column >= headers.length) {
      warnings.push(warn('INVALID_COLUMN', 'Неизвестная колонка: ' + field, 'error'));
    } else if (seen.has(column)) {
      warnings.push(warn('REUSED_COLUMN', 'Колонка назначена двум полям: ' + field, 'error'));
    } else seen.set(column, field);
  }
  if (mapping.date === undefined) warnings.push(warn('DATE_REQUIRED', 'Не выбрана колонка даты', 'error'));
  if (mapping.amount === undefined && mapping.income === undefined && mapping.expense === undefined) {
    warnings.push(warn('AMOUNT_REQUIRED', 'Не выбрана колонка суммы', 'error'));
  }
  if (mapping.amount !== undefined && (mapping.income !== undefined || mapping.expense !== undefined)) {
    warnings.push(warn('CONFLICTING_MAPPING', 'Выберите либо сумму, либо приход/расход', 'error'));
  }
  return warnings;
}

function makeDate(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const result = new Date(Date.UTC(y, m - 1, d));
  if (result.getUTCFullYear() !== y || result.getUTCMonth() + 1 !== m || result.getUTCDate() !== d) return null;
  return [y, String(m).padStart(2, '0'), String(d).padStart(2, '0')].join('-');
}
function parseDate(value: BankCell | undefined, table: BankStatementTable, order?: 'DMY' | 'MDY'): {
  iso: string | null; issue?: string;
} {
  if (typeof value === 'number' && table.format === 'xlsx') {
    const serial = Math.floor(value);
    if (!Number.isSafeInteger(serial) || serial < 0 || serial > 110_000 ||
        (table.dateSystem !== '1904' && serial === 60)) return { iso: null, issue: 'INVALID_DATE' };
    const date = table.dateSystem === '1904'
      ? Date.UTC(1904, 0, 1) + serial * 86_400_000
      : Date.UTC(1899, 11, 31) + (serial > 60 ? serial - 1 : serial) * 86_400_000;
    const iso = new Date(date).toISOString().slice(0, 10);
    return { iso: makeDate(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10))) };
  }
  const raw = text(value);
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(raw);
  if (match) return { iso: makeDate(Number(match[1]), Number(match[2]), Number(match[3])) };
  match = /^(\d{1,2})([./-])(\d{1,2})\2(\d{4})(?:\s+.*)?$/.exec(raw);
  if (!match) return { iso: null, issue: 'INVALID_DATE' };
  const first = Number(match[1]), second = Number(match[3]), year = Number(match[4]);
  if (!order && match[2] !== '.' && first <= 12 && second <= 12) {
    return { iso: null, issue: 'AMBIGUOUS_DATE' };
  }
  const resolved = order || (match[2] === '.' || first > 12 ? 'DMY' : 'MDY');
  const iso = resolved === 'DMY' ? makeDate(year, second, first) : makeDate(year, first, second);
  return { iso, issue: iso ? undefined : 'INVALID_DATE' };
}

function parseMoney(value: BankCell | undefined, style: NumberFormat): {
  cents: number | null; negative: boolean; issue?: string;
} {
  if (typeof value === 'number') {
    const value100 = Math.abs(value) * 100, rounded = Math.round(value100);
    if (!Number.isFinite(value100) || !Number.isSafeInteger(rounded) ||
        Math.abs(value100 - rounded) > 0.00001) return { cents: null, negative: false, issue: 'INVALID_AMOUNT' };
    return { cents: rounded, negative: value < 0 };
  }
  let raw = text(value).replace(/[\u00a0\u202f\s]/g, '').replace(/(?:руб(?:лей|ля|ль)?|RUB|RUR|₽)$/i, '');
  if (!raw) return { cents: null, negative: false, issue: 'EMPTY_AMOUNT' };
  const negative = /^\(.*\)$/.test(raw) || raw.startsWith('-');
  raw = raw.replace(/^\((.*)\)$/, '$1').replace(/^[+-]/, '');
  if (!/^\d[\d.,]*$/.test(raw)) return { cents: null, negative, issue: 'INVALID_AMOUNT' };
  const dots = [...raw.matchAll(/\./g)].length, commas = [...raw.matchAll(/,/g)].length;
  let decimal: string | null = null;
  if (dots && commas) decimal = raw.lastIndexOf('.') > raw.lastIndexOf(',') ? '.' : ',';
  else if (dots || commas) {
    const symbol = dots ? '.' : ',', parts = raw.split(symbol), last = parts[parts.length - 1] || '';
    if (parts.length === 2 && last.length <= 2) decimal = symbol;
    else if (parts.length === 2 && last.length === 3 && style === 'auto') {
      return { cents: null, negative, issue: 'AMBIGUOUS_AMOUNT' };
    } else if (style === 'comma-decimal' && symbol === ',') decimal = symbol;
    else if (style === 'dot-decimal' && symbol === '.') decimal = symbol;
  }
  const parts = decimal ? raw.split(decimal) : [raw];
  if (parts.length > 2 || (decimal && (parts[1]?.length || 0) > 2)) {
    return { cents: null, negative, issue: 'INVALID_AMOUNT' };
  }
  const integer = parts[0] || '', fraction = parts[1] || '';
  const groupChars = decimal === '.' ? ',' : decimal === ',' ? '.' : '[.,]';
  const groupRE = new RegExp('^\\d{1,3}(?:' + groupChars.replace('.', '\\.').replace(',', '\\,') + '\\d{3})+$');
  if (!/^\d+$/.test(integer) && !groupRE.test(integer)) {
    return { cents: null, negative, issue: 'INVALID_AMOUNT' };
  }
  const clean = integer.replace(/[.,]/g, '');
  try {
    const cents = BigInt(clean) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
    if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return { cents: null, negative, issue: 'AMOUNT_OVERFLOW' };
    return { cents: Number(cents), negative };
  } catch {
    return { cents: null, negative, issue: 'INVALID_AMOUNT' };
  }
}

function matchAccount(raw: string, accounts: readonly KnownBankAccount[]): { id: string | null; issue?: string } {
  const key = norm(raw);
  if (!key) return { id: null, issue: 'ACCOUNT_REQUIRED' };
  const found = accounts.filter(x => [x.id, x.name, ...(x.aliases || [])].some(alias => norm(alias) === key));
  if (!found.length) return { id: null, issue: 'UNKNOWN_ACCOUNT' };
  if (found.length > 1) return { id: null, issue: 'AMBIGUOUS_ACCOUNT' };
  return { id: found[0]?.id || null };
}
function classify(value: string): BankKind | null {
  const raw = norm(value);
  if (['доход', 'приход', 'зачисление', 'пополнение', 'income', 'credit', 'deposit'].includes(raw)) return 'income';
  if (['расход', 'списание', 'покупка', 'expense', 'debit', 'withdrawal', 'payment'].includes(raw)) return 'expense';
  if (['перевод', 'междусвоими', 'внутреннийперевод', 'transfer', 'internaltransfer'].includes(raw)) return 'transfer';
  return null;
}

/** No storage operations: every row is represented, including invalid rows. */
export async function normalizeBankStatement(
  table: BankStatementTable, options: BankImportOptions,
): Promise<BankImportPreview> {
  const { mapping, accounts } = options;
  const warnings = [...table.warnings, ...mappingWarnings(table.headers, mapping)];
  if (warnings.some(w => w.severity === 'error')) {
    return { fileDigest: table.fileDigest, mapping, rows: [], warnings,
      accepted: 0, rejected: table.rows.length, inflowCents: 0, outflowCents: 0, transfersCents: 0 };
  }
  const entries: OperationPreview[] = [];
  let inflowCents = 0, outflowCents = 0, transfersCents = 0;
  const sourceKeys = new Map<string, number>();
  const get = (cells: BankCell[], field: MappableField): BankCell | undefined => {
    const col = mapping[field];
    return col === undefined ? undefined : cells[col];
  };
  for (const source of table.rows) {
    const row = source.rowNumber, issues: ImportWarning[] = [];
    const err = (code: string, message: string, field?: MappableField) =>
      issues.push(warn(code, message, 'error', row, field ? mapping[field] : undefined));
    const note = (code: string, message: string) => issues.push(warn(code, message, 'warning', row));
    const date = parseDate(get(source.cells, 'date'), table, options.dateOrder);
    if (!date.iso) err(date.issue || 'INVALID_DATE', 'Дата отсутствует или неоднозначна', 'date');
    let amountCents: number | null = null, isNegative = false;
    if (mapping.amount !== undefined) {
      const n = parseMoney(get(source.cells, 'amount'), options.numberFormat || 'auto');
      amountCents = n.cents; isNegative = n.negative;
      if (n.issue) err(n.issue, 'Неверная или неоднозначная сумма', 'amount');
    } else {
      const credit = parseMoney(get(source.cells, 'income'), options.numberFormat || 'auto');
      const debit = parseMoney(get(source.cells, 'expense'), options.numberFormat || 'auto');
      const inPresent = credit.issue !== 'EMPTY_AMOUNT';
      const outPresent = debit.issue !== 'EMPTY_AMOUNT';
      if (inPresent && outPresent) err('CONFLICTING_AMOUNT', 'Заполнены и приход, и расход');
      else if (inPresent && !credit.issue) { amountCents = credit.cents; isNegative = false; }
      else if (outPresent && !debit.issue) { amountCents = debit.cents; isNegative = true; }
      else err(credit.issue && inPresent ? credit.issue : debit.issue && outPresent ? debit.issue : 'EMPTY_AMOUNT',
        'Отсутствует или неверна сумма');
    }
    if (amountCents === 0) err('ZERO_AMOUNT', 'Нулевая операция не проводится');
    const rawKind = text(get(source.cells, 'kind'));
    let kind: BankKind = isNegative ? 'expense' : 'income';
    if (mapping.kind !== undefined && rawKind) {
      const specified = classify(rawKind);
      if (!specified) err('UNKNOWN_KIND', 'Неизвестный тип операции', 'kind');
      else {
        kind = specified;
        if (mapping.amount !== undefined && specified !== 'transfer' &&
            ((isNegative && specified === 'income') || (!isNegative && specified === 'expense' && rawKind.startsWith('-')))) {
          err('SIGN_KIND_CONFLICT', 'Направление суммы противоречит типу', 'kind');
        }
      }
    }
    const accountRaw = text(get(source.cells, 'account')) || options.defaultAccountId || '';
    const account = matchAccount(accountRaw, accounts);
    if (!account.id) err(account.issue || 'UNKNOWN_ACCOUNT', 'Счёт не сопоставлен', 'account');
    let targetId: string | null = null;
    if (kind === 'transfer') {
      const target = matchAccount(text(get(source.cells, 'targetAccount')), accounts);
      targetId = target.id;
      if (!targetId) err(target.issue || 'TARGET_REQUIRED', 'Не выбран счёт назначения перевода', 'targetAccount');
      if (targetId && targetId === account.id) err('SAME_ACCOUNT', 'Перевод на тот же счёт', 'targetAccount');
    }
    const currency = text(get(source.cells, 'currency')) || 'RUB';
    if (!['RUB', 'RUR', '₽', 'РУБ', 'РУБЛЬ'].includes(currency.toUpperCase())) {
      err('UNSUPPORTED_CURRENCY', 'Поддерживается только RUB', 'currency');
    }
    let description = text(get(source.cells, 'description'));
    if (description.length > 500) err('DESCRIPTION_TOO_LONG', 'Описание длиннее 500 символов', 'description');
    if (!description) { note('EMPTY_DESCRIPTION', 'Описание операции не заполнено'); description = ''; }
    const externalId = text(get(source.cells, 'externalId'));
    if (externalId.length > 150) err('EXTERNAL_ID_TOO_LONG', 'Длинный идентификатор операции', 'externalId');
    let category: string | null = text(get(source.cells, 'category')) || null;
    if (category) {
      const mapped = options.categoryAliases?.[category] || category;
      const known = options.categories?.find(x => norm(x) === norm(mapped));
      if (options.categories && !known) err('UNKNOWN_CATEGORY', 'Неизвестная категория', 'category');
      else category = known || mapped;
    }
    const fatal = issues.some(x => x.severity === 'error');
    if (fatal || !date.iso || amountCents === null || account.id === null) {
      entries.push({ rowNumber: row, operation: null, warnings: issues });
      continue;
    }
    const fingerprint = await sha256([
      account.id, date.iso, kind, amountCents, targetId || '', norm(description), 'RUB',
    ].join('\u001f'));
    const sourceKey = await sha256(table.fileDigest + '\u001f' + row);
    if (sourceKeys.has(fingerprint)) note('REPEATED_CONTENT', 'Совпадающая операция внутри файла - требуется сверка');
    else sourceKeys.set(fingerprint, row);
    const operation: NormalizedBankOperation = {
      sourceRow: row, sourceKey, fingerprint, date: date.iso,
      amountCents, kind, description, externalId: externalId || null,
      accountId: account.id, targetAccountId: targetId, category, currency: 'RUB',
    };
    entries.push({ rowNumber: row, operation, warnings: issues });
    if (kind === 'income') inflowCents += amountCents;
    else if (kind === 'expense') outflowCents += amountCents;
    else transfersCents += amountCents;
  }
  if (![inflowCents, outflowCents, transfersCents].every(Number.isSafeInteger)) {
    warnings.push(warn('TOTAL_OVERFLOW', 'Суммарные денежные потоки превышают безопасный диапазон', 'error'));
  }
  return {
    fileDigest: table.fileDigest, mapping, rows: entries, warnings,
    accepted: entries.filter(x => x.operation !== null).length,
    rejected: entries.filter(x => x.operation === null).length,
    inflowCents, outflowCents, transfersCents,
  };
}
