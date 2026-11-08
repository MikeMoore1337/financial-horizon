# Financial goals domain (#37)

This isolated TypeScript module does not read or modify the browser finance state,
IndexedDB, bank accounts, PostgreSQL, React or global ledger. It is not yet a
user-facing feature. `GoalRecord` is a separately versioned, JSON-serializable,
append-only event stream. No migration is performed here.

## Usage and invariants

- All amounts are **integer kopecks**, non-negative and bounded by
  `MAX_GOAL_CENTS` (10^12 kopecks). Date strings are `YYYY-MM-DD` without
  timezone conversion. No implicit `Date.now()`, network call or account balance.
- `createGoal` requires the caller's stable goal and creation-event IDs. The
  `openingCents` are an **explicit allocation of existing savings**, not income,
  an account deposit, an inferred balance or a real bank transfer.
- `applyGoalEvent` returns a new record. It supports config updates, money
  contributions and withdrawals, missed-installment annotations, completion,
  reopening, archiving/restoring and append-only reversals. Full replay rejects
  overdraws, invalid lifecycle transitions and conflicting idempotent retries.
- `funding: 'virtual'` and `usage: 'virtual-release'` change the goal's earmarked
  amount only. This allocation is **not** a financial account transaction or
  an expense; availability across multiple goals must be checked by #33.
- `funding: 'account-transfer'` and `usage: 'account-transfer'` require a stable
  `ledgerMovementId` referring to an **already posted, verified transfer between
  the user's own accounts**. `usage: 'expense'` requires an existing confirmed
  expense posting. Neither call creates another posting. These operations
  must only be persisted after the #33 transaction has committed.
- Reversing a ledger-linked event requires a separate, already posted
  `ledgerReversalId`; reversing a virtual operation must not have one. A
  reversal is effective from its own date and preserves earlier historical
  snapshots. Refusing a reversal that would make goal savings negative is
  intentional and must be resolved at the account/ledger level first.
- Scheduled monthly installments follow the creation-date day-of-month
  anchor with Feb 28/29 clamping and no cumulative drift. `monthlyCents: null`
  means auto recompute the remaining amount over non-skipped due dates.
  Fixed plans are compared with the required contribution, yielding an explicit
  monthly deficit and projected completion date or a null/limited forecast.
  Historic installments retain the plan in effect before their due dates.
  Contributions already assigned to future installments are credited once;
  automatic monthly planning uses integer water-filling and only the missing
  portion of a prepaid installment is reserved. The last proposed reservation
  is capped to the remaining exact kopecks.

## Integration gate for #33 and #6

`goalLedgerLinks([goalA, goalB, ...])` reports **read-only references** with
expected ledger type and money amount; it throws on duplicate movement IDs
across all supplied goals. The future #33 adapter must additionally:

1. Enforce the authenticated user's account ownership, RUB currency and
   transfer/expense type and exact amount. Never accept client-provided
   `alreadyPosted` as proof of a posted bank operation.
2. Commit the real transfer/expense/reversal **once**, then link the resulting
   immutable transaction ID to the goal event using an atomic, idempotent
   write/outbox protocol. If the two writes cannot be made atomic, perform
   recovery/reconciliation rather than re-posting a movement.
3. Reject reuse of a ledger transaction across *all* goals and mandatory
   reserves (#6); reserve availability must be computed over shared bank
   accounts rather than treating individual goal balances as additional cash.
4. Define storage schema/migration and encrypted backup/import compatibility
   in the owning migration task. Do not inject goals into v1/v2 state without
   that migration and the explicit cross-device-sync contract.

## Forecast adapter gate for #36

`goalForecastReservations(goal, asOf)` returns **unconfirmed proposals** dated
by due installment; `cashFlowCents` is deliberately zero for virtual allocation
and own-account transfers. The planned allocation affects *unreserved available
funds*, not external income or spending. #36 must combine these proposals with
#33 balances and *actual* transactions, exclude overdue/voided/unnecessary
installments, and avoid counting both a goal proposal and its linked actual
ledger operation. Actual expenses remain sourced exclusively from #33.

## Draft mapping to open #33 / #36 contracts (NOT CONNECTED)

These types were checked against **open, not yet merged** PR #84 (`src/domain/accounts/ledger.ts`)
and PR #103 (`src/domain/cashflow/types.ts`). This is a proposed adapter contract,
**not** an assertion that their APIs or persistence protocols are finalized:

| Goal domain action | Verified #33 ledger operation | #36 projection input |
| --- | --- | --- |
| Virtual contribution | None; validate shared unallocated funds | One `ReserveMovementDto` `{ kind: 'allocate', status: 'actual' }` after a durable goal event |
| Virtual release for later spending | None | One `{ kind: 'release', status: 'actual' }`; any separate purchase comes only from the booked #33 expense |
| Real contribution between own accounts | An already committed `LedgerTransaction.kind: 'transfer'` with exactly two opposite account postings | Its transfer is not an external inflow/outflow; the **earmark** is one `allocate` movement, never a `BookedFlowDto` expense |
| Withdrawal using own-account transfer | One verified transfer; zero external cashflow | The goal `release` is a reserve movement, not income |
| Actual purchase using goal savings | One verified `expense`/posted payment and matching goal use | One cash expense via #33 actuals, plus one `release` of earmarking; no second expense |
| Correct a virtual movement | Append-only void/reversal in the goal journal | Emit only the net canonical effective reserve event(s), never both the voided event and its compensation |
| Correct a linked ledger movement | One already committed `reversal` referencing the original transaction | Normalize the pair to one logical corrected accounting fact and one reservation correction |
| Unpaid planned contribution | No account posting | `{ kind: 'allocate', status: 'planned' }` sourced from `goalForecastReservations()` only |

**Adapter invariants (required before enabling user writes):**

1. The mapping of `GoalLedgerLink.expectedLedgerKind` to the actual #33
   `LedgerTransaction.kind` is explicit (`account-transfer` -> `transfer`,
   `expense` -> confirmed expense); reject unrelated kinds such as `adjustment`
   or unverified `payment` even if signed amounts appear to match.
2. The server must derive the authenticated profile and validate all transaction
   IDs, posting account IDs, dates, reversal relationships, amounts, and ownership
   from one authoritative revision. A client-supplied `ledgerMovementId` alone
   is never confirmation. Link writes need atomicity or resumable reconciliation.
3. Assign a globally unique deterministic movement ID to each emitted #36
   `ReserveMovementDto` to prevent replays from duplicating reserves. Planned
   future allocations represent only the **unpaid portion**, including any
   prepayment assigned to that installment. Future events are estimates, not facts.
4. A confirmed opening goal allocation from before the #36 `openingDate` belongs
   in **one** `openingReservedCents` snapshot if actually earmarked; never include
   it again as an actual `allocate` event from that date forward. Reconcile
   voluntary goals and mandatory #6 reservations against the same account-level
   available balance, without summing either into total bank cash.
5. On goal withdrawal for a purchase, a ledger expense reduces bank cash once;
   a goal release reduces locked funds once. If bank expense and release occur on
   different dates, their ordering and observed balance must remain explicit.
6. The current #36 `CashflowInputDto` and #33 domain are independent, read-only
   candidates. Do **not** import their PR-only files, expose bank details in a
   preview, or attach these DTOs to IndexedDB/React until joint contracts,
   migrations, authorization and encrypted backup tests are reviewed.

**Release:** This PR is domain-only. Production UI, migration, account linkage
and backup/device QA remain separately gated behind #33/#36, approved design,
independent review, exact-SHA CI, and an observed deployment/rollback receipt.
