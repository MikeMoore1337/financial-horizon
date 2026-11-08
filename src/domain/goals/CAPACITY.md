# Read-only capacity reconciliation for #37 / #6 / #33

`reconcileGoalCapacity` and `assertGoalCapacity` share the **same** confirmed
account balance across voluntary financial goals and mandatory reserves. This
isolated layer has no persistence, HTTP requests, SQL, credentials, encryption,
or bank postings. It cannot authorize an authenticated user by itself.

## Contract

- `GoalCapacityInput.accounts` are **already confirmed** RUB account balances
  at `asOfDate`, scoped to the same account/profile by #33/#67. Do not derive
  them from planned income minus planned expense. Cash can be negative; it is
  not silently clamped or replaced by zero.
- `goals` are the entire saved per-scope immutable journals; the guard replays
  only entries effective on/before `asOfDate`. The entire journal is always
  validated, but a goal created after `asOfDate` contributes **zero** to the
  historical balance. It includes earmarked funds for
  active, completed **and archived** goals until a real release/use journal
  event is recorded. Goal status alone does **not** release funds.
- `bindings` map each goal to exactly one existing account. The API/provider
  must establish profile ownership and bank account existence authoritatively;
  supplied IDs, `scopeKey` and `ledgerRevision` are metadata, not security
  credentials. A split across multiple accounts requires a future explicit
  contract, **not** implicit assignment.
- `mandatoryReserves` include only funds *already earmarked* for #6 on the
  same account snapshot, not projected future contributions or planned bills.
  A reserve must not appear in both #6 and #37. Unknown/duplicate IDs and
  cross-scope account/reserve metadata are rejected.
- All monetary fields are safe integer kopecks. Aggregation uses `bigint`,
  then rejects out-of-range results instead of losing a kopeck.

Per-account invariants:

```text
confirmedBankCash = account.balanceCents           // never changed by this guard
voluntaryLock     = sum(goal.savedCents)            // verified journal replay
mandatoryLock     = sum(#6 allocatedCents)          // confirmed #6 snapshot
unallocatedCash   = confirmedBankCash - voluntaryLock - mandatoryLock
shortage          = max(0, -unallocatedCash)
```

Example: account cash 100,000 ₽; voluntary goal 30,000 ₽; mandatory
reserve 20,000 ₽ => **bank balance 100,000 ₽**, **free funds 50,000 ₽**,
**expense 0 ₽** from this pure calculation. No cash is moved merely by
calculating an allocation.

`reconcileGoalCapacity` returns a negative available amount and shortage for
an overcommitted *existing* snapshot so that a user can diagnose/release funds.
`assertGoalCapacity` rejects such a snapshot for use in a proposed allocation;
this is **not** the server transaction. The authoritative #67 writer must
validate all facts and ownership, recheck ledger/entity revisions and total
reservations in one SQL transaction, and apply a unique idempotency key.
Otherwise simultaneous requests could both observe the same capacity and
overspend it; passing this guard alone cannot prevent the race.

## Required integrated tests before enabling UI writes

1. Two concurrent deposits against one account, one capacity slot: exactly one
   succeeds and the other returns 409, with no partial ledger or goal journal.
2. A goal and an obligation reserve attempted simultaneously: no double lock.
3. A confirmed own-account transfer remains a transfer (never income/expense).
   A real purchase debits once; the matching goal use releases locked funds once.
4. A repeated request and a voided movement replay identically across two
   devices and after encrypted backup restoration.
5. Guest offline storage remains isolated from logged-in PostgreSQL state;
   migration uses explicit consent, versioned backup and tested rollback.

**Status:** this is a pure, read-only preflight contract. #33/#6/#67 adapters,
source-of-truth storage, and production screens are not connected here.
