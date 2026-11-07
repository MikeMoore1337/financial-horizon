# Reserve calculation contract (#6, phase 1)

This is an independent, **pure TypeScript module**. It does not read/write IndexedDB,
PostgreSQL, accounts, network, system time or user interface. Importing it does not
change the v1/v2 persisted format or older encrypted backups.

## Model and dates

- `ReserveDefinition`: `id`, `title`, `openedOn`, `firstDueDate`, `periodMonths`
  (1..60), `targetCents`, `openingReservedCents`, `contributionMode` (`auto` or
  `fixed`), and optionally `fixedMonthlyCents` / `dueDay` (1..31).
- `firstDueDate` is the **first upcoming payment**, inside the initial billing
  period. Future due dates are calculated as `firstDueDate + N * periodMonths`,
  clamped to short months using the **original** `dueDay` anchor. The anchor
  permits 31 January -> 28 February -> 31 March and 29 February across leap years.
- Monthly installments are due on the anchor day in each calendar month after
  the calculation date and up to the obligation due date, inclusive. A contribution
  on the calculation date is already recorded; it is never silently counted twice.
- `auto` divides the remaining funding gap equally in integer kopecks with the
  last installment receiving the rounding remainder. `fixed` uses the configured
  amount (capped by the gap) and reports any projected shortfall. A past-due gap
  is an **immediate** funding need, not a fictional account expense.

## Events and accounting

`calculateReserve(definition, events, asOfDate)` replays a chronologically ordered,
append-only journal scoped by `reserveId` and unique event IDs:

- `contribution`: earmarks **existing** money (`reservedCents += amount`), not income,
  expense or an account debit.
- `payment`: a declaration of an actual obligation payment. Its full `amountCents`
  is counted **once** toward the obligation; only `reservedUsedCents` reduces the
  earmarked reserve. Unreserved money may also be used for the payment.
- `skip`: audits a missed monthly slot; it does not create an expense or a debit.
- `target_change`: changes the target (not below already paid amounts).
- `cycle_close`: allowed only when the current obligation is fully paid; the
  remaining earmarked amount carries forward unchanged.
- `void`: references one earlier event ID. Replaying the journal excludes its
  effect but keeps the original and reversal in history. Invalid dependent actions
  (such as closing a now-unpaid cycle) fail closed; voiding a void is unsupported.

A failed validation never mutates the inputs. All monetary values are integer
kopecks, nonnegative and bounded; never convert to floating-point rubles for math.
`assessReserveContribution(amountCents, unreservedAvailableCents)` is only a
**preview**, not an authorization to transfer or spend.

## Advisory XLSX recurrence recognition

`parseReservePeriodHint(note)` in `import-suggestions.ts` is **independent**
of the existing XLSX importer. It recognizes Russian annotations such as
`раз в 3 мес`, `ежегодно`, `каждые 2 года`, and validates 1..60 months.
It returns a `suggestion` with `confirmationRequired: true` or an
`invalid` status for conflicting/out-of-range notes; unrelated descriptions
return `null`.

**It does not create a reserve, alter an existing imported expense, infer
a payment date, move money, or write any finance state.** The eventual
`excel-import.js` integration must present a read-only suggestion with the
original row and require explicit user confirmation for amount, account,
next due date, and how to treat the old one-time expense. The imported row
must not become a duplicate obligation when confirmed. This connection
remains blocked until the agreed #33 ledger/persistence contract and the
separate approved UI implementation.

## Required integration gate with #33

Do **not** independently write to `finance.js`, `ledger-operations.js`, `storage.js`,
`app.js`, React UI, PostgreSQL or the current finance schema from this module.
Before integration, agree an atomic command/transaction contract with #33:

1. Earmarking does **not** change bank account balance or actual expense; compute
   available **unreserved** funds from the authoritative accounts/ledger.
2. A `payment` is paired with exactly one immutable, idempotent account posting
   keyed by the domain event ID (plus reserve/user scope). A void requires the
   appropriate compensating posting in the **same transaction**. Reject insufficient
   account funds, replays, scope violations, stale revisions and partial commits.
3. Event journal, reserve projection, account operation and receipt are persisted
   atomically with account scoping. Keep old v1/v2 payloads and encrypted backups
   readable; use a versioned migration and separately tested downgrade.
4. Only after contract agreement and owner-approved visual mockup, integrate
   calendar/overview, XLSX suggestions and CRUD in a **separate sequential PR**.
   Do not enable an unfinished feature in production.

Run `node --test tests/reserves.test.mjs` on Node.js 24 or newer; type-check through
project `npm run typecheck` once the module is included in the root tsconfig.
