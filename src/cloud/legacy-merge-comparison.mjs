/** Read-only candidate pairs. Similarity is not evidence of identity. */
const groups = [
  ['entries', 'obligation'], ['loans', 'loan'],
  ['settlements', 'settlement'], ['loanPayments', 'loan_payment'],
];
const titleKey = value => typeof value === 'string' && value.trim()
  ? value.normalize('NFKC').trim().toLocaleLowerCase('ru-RU') : null;
const key = (kind, values) => values.every(value => value !== null && value !== undefined)
  ? JSON.stringify([kind, ...values]) : null;
const amount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  ? value : null;

function keys(kind, row, server) {
  const d = server ? row.data : row;
  if (kind === 'entries') return [
    key('title', [titleKey(d.title)]),
    key('amount-date', [amount(server ? d.amount_minor : d.amountCents),
      date(server ? d.starts_on : d.date), server ? d.direction : d.kind]),
  ];
  if (kind === 'loans') return [
    key('title', [titleKey(d.title)]),
    key('amount-date', [amount(server ? d.opening_minor : d.openingCents),
      date(server ? d.as_of_date : d.asOfDate)]),
  ];
  if (kind === 'settlements') return [key('payment', [
    amount(server ? d.amount_minor : d.amountCents), date(server ? d.paid_on : d.date),
  ])];
  return [key('payment', [amount(server ? d.amount_minor : d.amountCents),
    date(server ? d.paid_on : d.date)])];
}

/** Returns candidate IDs only; all records require a separate owner decision. */
export function compareLegacyWithServer(source, entities) {
  if (!source || !Array.isArray(entities)) throw Error('IMPORT_HOLD: Нет данных для сравнения');
  const result = {};
  let pairs = 0;
  for (const [kind, serverKind] of groups) {
    if (!Array.isArray(source[kind])) throw Error('IMPORT_HOLD: Повреждён исходный список');
    const targets = entities.filter(entity => entity.kind === serverKind);
    const index = new Map();
    for (const target of targets) for (const value of keys(kind, target, true)) {
      if (value === null) continue;
      if (!index.has(value)) index.set(value, []);
      index.get(value).push(target.id);
    }
    const local = source[kind].map(row => {
      const ids = new Set();
      for (const value of keys(kind, row, false)) {
        if (value !== null) for (const id of index.get(value) || []) ids.add(id);
      }
      pairs += ids.size;
      if (pairs > 100_000) throw Error('IMPORT_HOLD: Слишком много возможных совпадений для безопасного просмотра');
      return {sourceId: row.id, candidateIds: [...ids].sort()};
    });
    result[kind] = {local, serverIds: targets.map(target => target.id).sort()};
  }
  return {status: 'NEEDS_OWNER_DECISIONS', groups: result, candidatePairs: pairs};
}
