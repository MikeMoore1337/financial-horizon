# Issue #36 — confirmed ledger bridge (partial, not enabled)

Base main: dfe5200ebc0a037556821a2b1a60c083fc205b1c.

## Implemented scope

- Reuse the existing integer-kopek forecast engine and authoritative complete-snapshot decoder (#33/#67); never mutate the ledger.
- Require an explicit independently confirmed start-of-day checkpoint for every account, bound to the same profile and revision. Check the account set, per-account replay, exact aggregate and final available amount. This validates consistency, not the independent provenance of the checkpoint.
- Consume a posted payment once, validating its amount, date and obligation/fact relationship; link using the original occurrence date. A live settlement with no linked posting fails closed rather than inventing a cash movement.
- Keep confirmed loan-payment facts separate from future schedule calculation. Never infer installment identity from a prepayment.
- Preserve original cash posting and compensation on their actual dates using a single logical void with optional reversedOn. A voided payment does not settle its plan. Legacy undated void behavior is unchanged.
- Exclude own-account transfers from consolidated external cash flow. Keep fees as their own expense postings; separate balance adjustments from earned income and spending.

## Open integration contracts — do not enable the feature

The current account snapshot publishes opening_minor (undated), balance_minor, reserved_minor and available_minor, not an independently confirmed start-of-day balance/date for the forecasting window. Do not attach a guessed date to opening_minor or substitute today's account balance for a historical opening. Source and verify an authoritative checkpoint before wiring this adapter into the application. A revision match is not sufficient proof of provenance.

The UI must supply plans for linked obligations, including canceled historical obligations if their facts retain a reference. Current reserve totals already include goal allocations; they are not opening reserve balances. Historical reserve movements, goal allocations and future releases must be projected and reconciled exactly once; never merge current totals with the same goal allocations twice.

The existing goals/cashflow bridge is reusable, not evidence that live authenticated #37 data and mandatory #6 reserves are already integrated into #36. The existing server loan-plan adapter provides an approximate schedule only; #39 bank parity is not a prerequisite for an explicitly approximate forecast. #70 remains relevant to actual multi-profile, cross-device and release checks, not to this pure read-only adapter.

Still required: source checkpoint and opening reserve history, obligation/loan schedule mapping, authenticated and guest/offline assembly, approval of original design outputs before UI changes, app E2E, legacy restore, full regression and independent/security review, exact-SHA CI, deployment, rollback readiness and owner acceptance.

## Executed tests

In a separate Node 24.22.0 workspace, reconstructed the relevant main-domain subset from the clean older checkout and pinned blobs obtained through GitHub; changed source and test files checked with git hash-object against the branch. Not a full checkout, full application build, typecheck or production run.

Command: node --test tests/*cashflow*.test.mjs

68 tests passed, 0 failed, including existing adversarial (12,000) and property (2,000) seeded scenarios, existing goals bridge tests and 9 new confirmed-ledger tests. The mandatory deficit oracle reports 500,000 kopecks on 2026-11-12 for all four horizons. The test inputs are synthetic.

This PR is deliberately draft and must not close #36 or deploy an incomplete forecast.
