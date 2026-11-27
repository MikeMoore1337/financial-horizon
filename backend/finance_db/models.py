"""SQLAlchemy 2 typed finance models.

Reviewed Alembic DDL is authoritative for CHECKs, RLS, triggers and GRANTs.
Never call Base.metadata.create_all(): it does not install security policies.
"""
from __future__ import annotations

from datetime import date, datetime
from uuid import UUID as Uuid
from typing import Any

from sqlalchemy import (
    BigInteger, CheckConstraint, CHAR, Date, DateTime, ForeignKeyConstraint,
    Index, Integer, LargeBinary, MetaData, SmallInteger, String, Text, UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    metadata = MetaData(schema="finance")


class FinanceProfile(Base):
    __tablename__ = "finance_profiles"
    id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True), primary_key=True)
    owner_user_id: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    currency: Mapped[str] = mapped_column(CHAR(3), server_default=text("'RUB'"))
    revision: Mapped[int] = mapped_column(BigInteger, server_default=text("0"))
    min_available_revision: Mapped[int] = mapped_column(BigInteger, server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class ProfileEntity:
    """Composite tenant identifier, not a globally unique row ID."""
    profile_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True), primary_key=True)
    id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True), primary_key=True)


class Revisable:
    entity_revision: Mapped[int] = mapped_column(BigInteger, server_default=text("1"))


def profile_fk():
    return ForeignKeyConstraint(["profile_id"], ["finance.finance_profiles.id"], ondelete="RESTRICT")


class Account(ProfileEntity, Revisable, Base):
    __tablename__ = "accounts"
    __table_args__ = (profile_fk(),)
    name: Mapped[str] = mapped_column(String(160))
    kind: Mapped[str] = mapped_column(String(16))
    currency: Mapped[str] = mapped_column(CHAR(3), server_default=text("'RUB'"))
    opening_minor: Mapped[int] = mapped_column(BigInteger)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class Obligation(ProfileEntity, Revisable, Base):
    __tablename__ = "obligations"
    __table_args__ = (profile_fk(),)
    title: Mapped[str] = mapped_column(String(160))
    direction: Mapped[str] = mapped_column(String(8))
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    starts_on: Mapped[date] = mapped_column(Date)
    timezone: Mapped[str] = mapped_column(String(64), server_default=text("'UTC'"))
    recurrence_unit: Mapped[str] = mapped_column(String(8), server_default=text("'none'"))
    recurrence_every: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    category: Mapped[str | None] = mapped_column(String(100))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class Loan(ProfileEntity, Revisable, Base):
    __tablename__ = "loans"
    __table_args__ = (profile_fk(),)
    title: Mapped[str] = mapped_column(String(160))
    opening_minor: Mapped[int] = mapped_column(BigInteger)
    payment_minor: Mapped[int] = mapped_column(BigInteger)
    apr_basis_points: Mapped[int] = mapped_column(Integer)
    term_months: Mapped[int] = mapped_column(Integer)
    due_day: Mapped[int] = mapped_column(SmallInteger)
    as_of_date: Mapped[date] = mapped_column(Date)
    calculation_version: Mapped[int] = mapped_column(SmallInteger, server_default=text("1"))
    imported_schedule: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class Reserve(ProfileEntity, Revisable, Base):
    __tablename__ = "reserves"
    __table_args__ = (
        profile_fk(),
        ForeignKeyConstraint(
            ["profile_id", "obligation_id"],
            ["finance.obligations.profile_id", "finance.obligations.id"],
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["profile_id", "account_id"],
            ["finance.accounts.profile_id", "finance.accounts.id"],
            ondelete="RESTRICT",
        ),
    )
    title: Mapped[str] = mapped_column(String(160))
    target_minor: Mapped[int] = mapped_column(BigInteger)
    target_on: Mapped[date | None] = mapped_column(Date)
    opening_reserved_minor: Mapped[int] = mapped_column(BigInteger, server_default=text("0"))
    opening_target_minor: Mapped[int] = mapped_column(BigInteger, server_default=text("0"))
    cycle_number: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    obligation_id: Mapped[Uuid | None] = mapped_column(UUID(as_uuid=True))
    account_id: Mapped[Uuid | None] = mapped_column(UUID(as_uuid=True))
    opened_on: Mapped[date | None] = mapped_column(Date)
    first_due_on: Mapped[date | None] = mapped_column(Date)
    period_months: Mapped[int | None] = mapped_column(SmallInteger)
    due_day: Mapped[int | None] = mapped_column(SmallInteger)
    contribution_mode: Mapped[str | None] = mapped_column(String(8))
    fixed_monthly_minor: Mapped[int | None] = mapped_column(BigInteger)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class LedgerTransaction(ProfileEntity, Revisable, Base):
    __tablename__ = "ledger_transactions"
    __table_args__ = (
        profile_fk(),
        ForeignKeyConstraint(
            ["profile_id", "reversed_transaction_id"],
            ["finance.ledger_transactions.profile_id", "finance.ledger_transactions.id"],
            ondelete="RESTRICT",
        ),
    )
    kind: Mapped[str] = mapped_column(String(16))
    occurred_on: Mapped[date] = mapped_column(Date)
    note: Mapped[str | None] = mapped_column(String(500))
    posted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))
    actor_user_id: Mapped[str] = mapped_column(String(32))
    reversed_transaction_id: Mapped[Uuid | None] = mapped_column(UUID(as_uuid=True))


class LedgerPosting(Base):
    __tablename__ = "ledger_postings"
    __table_args__ = (
        ForeignKeyConstraint(
            ["profile_id", "transaction_id"],
            ["finance.ledger_transactions.profile_id", "finance.ledger_transactions.id"],
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["profile_id", "account_id"],
            ["finance.accounts.profile_id", "finance.accounts.id"],
            ondelete="RESTRICT",
        ),
    )
    profile_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True), primary_key=True)
    transaction_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True), primary_key=True)
    account_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True), primary_key=True)
    signed_minor: Mapped[int] = mapped_column(BigInteger)


class Settlement(ProfileEntity, Revisable, Base):
    __tablename__ = "settlements"
    __table_args__ = (
        profile_fk(),
        ForeignKeyConstraint(
            ["profile_id", "obligation_id"],
            ["finance.obligations.profile_id", "finance.obligations.id"],
            ondelete="RESTRICT",
        ),
    )
    obligation_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True))
    occurrence_on: Mapped[date] = mapped_column(Date)
    paid_on: Mapped[date] = mapped_column(Date)
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    voided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class LoanPayment(ProfileEntity, Revisable, Base):
    __tablename__ = "loan_payments"
    __table_args__ = (
        profile_fk(),
        ForeignKeyConstraint(
            ["profile_id", "loan_id"],
            ["finance.loans.profile_id", "finance.loans.id"],
            ondelete="RESTRICT",
        ),
    )
    loan_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True))
    paid_on: Mapped[date] = mapped_column(Date)
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    strategy: Mapped[str] = mapped_column(String(8))
    voided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class LedgerPaymentLink(Base):
    __tablename__ = "ledger_payment_links"
    __table_args__ = (
        ForeignKeyConstraint(
            ["profile_id", "transaction_id"],
            ["finance.ledger_transactions.profile_id", "finance.ledger_transactions.id"],
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["profile_id", "settlement_id"],
            ["finance.settlements.profile_id", "finance.settlements.id"],
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["profile_id", "loan_payment_id"],
            ["finance.loan_payments.profile_id", "finance.loan_payments.id"],
            ondelete="RESTRICT",
        ),
    )
    profile_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True), primary_key=True)
    transaction_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True), primary_key=True)
    settlement_id: Mapped[Uuid | None] = mapped_column(UUID(as_uuid=True))
    loan_payment_id: Mapped[Uuid | None] = mapped_column(UUID(as_uuid=True))


class ReserveAllocation(ProfileEntity, Base):
    __tablename__ = "reserve_allocations"
    __table_args__ = (
        profile_fk(),
        ForeignKeyConstraint(
            ["profile_id", "reserve_id"],
            ["finance.reserves.profile_id", "finance.reserves.id"],
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["profile_id", "account_id"],
            ["finance.accounts.profile_id", "finance.accounts.id"],
            ondelete="RESTRICT",
        ),
    )
    reserve_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True))
    account_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True))
    delta_minor: Mapped[int] = mapped_column(BigInteger)
    linked_transaction_id: Mapped[Uuid | None] = mapped_column(UUID(as_uuid=True))
    reverses_allocation_id: Mapped[Uuid | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class ReserveEvent(ProfileEntity, Base):
    __tablename__ = "reserve_events"
    __table_args__ = (
        profile_fk(),
        ForeignKeyConstraint(
            ["profile_id", "reserve_id"], ["finance.reserves.profile_id", "finance.reserves.id"],
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["profile_id", "target_event_id"],
            ["finance.reserve_events.profile_id", "finance.reserve_events.id"],
        ),
        ForeignKeyConstraint(
            ["profile_id", "allocation_id"],
            ["finance.reserve_allocations.profile_id", "finance.reserve_allocations.id"],
        ),
        ForeignKeyConstraint(
            ["profile_id", "transaction_id"],
            ["finance.ledger_transactions.profile_id", "finance.ledger_transactions.id"],
        ),
    )
    reserve_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True))
    kind: Mapped[str] = mapped_column(String(20))
    occurred_on: Mapped[date] = mapped_column(Date)
    cycle_number: Mapped[int] = mapped_column(Integer)
    revision: Mapped[int] = mapped_column(BigInteger)
    amount_minor: Mapped[int | None] = mapped_column(BigInteger)
    reserved_used_minor: Mapped[int | None] = mapped_column(BigInteger)
    target_minor: Mapped[int | None] = mapped_column(BigInteger)
    slot_on: Mapped[date | None] = mapped_column(Date)
    note: Mapped[str | None] = mapped_column(String(500))
    target_event_id: Mapped[Uuid | None] = mapped_column(UUID(as_uuid=True))
    allocation_id: Mapped[Uuid | None] = mapped_column(UUID(as_uuid=True))
    transaction_id: Mapped[Uuid | None] = mapped_column(UUID(as_uuid=True))
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class CommandReceipt(Base):
    __tablename__ = "command_receipts"
    __table_args__ = (profile_fk(),)
    profile_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True), primary_key=True)
    client_mutation_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True), primary_key=True)
    request_sha256: Mapped[bytes] = mapped_column(LargeBinary(32))
    status_code: Mapped[int] = mapped_column(SmallInteger)
    committed_revision: Mapped[int | None] = mapped_column(BigInteger)
    response_body: Mapped[dict[str, Any]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class ChangeLog(Base):
    __tablename__ = "change_log"
    __table_args__ = (profile_fk(),)
    profile_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True), primary_key=True)
    revision: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    ordinal: Mapped[int] = mapped_column(SmallInteger, primary_key=True, server_default=text("0"))
    schema_version: Mapped[int] = mapped_column(SmallInteger, server_default=text("1"))
    kind: Mapped[str] = mapped_column(String(50))
    entity_id: Mapped[Uuid | None] = mapped_column(UUID(as_uuid=True))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    server_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class ImportBatch(ProfileEntity, Base):
    __tablename__ = "import_batches"
    __table_args__ = (profile_fk(),)
    source_sha256: Mapped[bytes] = mapped_column(LargeBinary(32))
    status: Mapped[str] = mapped_column(String(16))
    base_revision: Mapped[int] = mapped_column(BigInteger)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))
    committed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source_canonical_json: Mapped[bytes | None] = mapped_column(LargeBinary)


class ImportRecordMap(Base):
    __tablename__ = "import_record_map"
    __table_args__ = (profile_fk(),)
    profile_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True), primary_key=True)
    source_sha256: Mapped[bytes] = mapped_column(LargeBinary(32), primary_key=True)
    record_type: Mapped[str] = mapped_column(String(30), primary_key=True)
    source_record_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    target_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True))

class BankImportBatch(ProfileEntity, Base):
    """Separate from #69 legacy-history import; bank ledger audit only."""
    __tablename__ = "bank_import_batches"
    __table_args__ = (profile_fk(),)
    batch_key: Mapped[str] = mapped_column(CHAR(64))
    file_digest: Mapped[str] = mapped_column(CHAR(64))
    payload_sha256: Mapped[bytes] = mapped_column(LargeBinary(32))
    status: Mapped[str] = mapped_column(String(16))
    committed_revision: Mapped[int] = mapped_column(BigInteger)
    cancelled_revision: Mapped[int | None] = mapped_column(BigInteger)
    operation_count: Mapped[int] = mapped_column(Integer)
    committed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class BankImportRow(Base):
    """Original bank entry mapping is immutable, even after whole-batch reversal."""
    __tablename__ = "bank_import_rows"
    __table_args__ = (
        profile_fk(),
        ForeignKeyConstraint(
            ["profile_id", "batch_id"],
            ["finance.bank_import_batches.profile_id", "finance.bank_import_batches.id"],
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["profile_id", "account_id"],
            ["finance.accounts.profile_id", "finance.accounts.id"], ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["profile_id", "target_account_id"],
            ["finance.accounts.profile_id", "finance.accounts.id"], ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["profile_id", "transaction_id"],
            ["finance.ledger_transactions.profile_id", "finance.ledger_transactions.id"],
            ondelete="RESTRICT",
        ),
    )
    profile_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True), primary_key=True)
    source_key: Mapped[str] = mapped_column(CHAR(64), primary_key=True)
    batch_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True))
    fingerprint: Mapped[str] = mapped_column(CHAR(64))
    external_id: Mapped[str | None] = mapped_column(String(150))
    account_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True))
    target_account_id: Mapped[Uuid | None] = mapped_column(UUID(as_uuid=True))
    transaction_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True))
    kind: Mapped[str] = mapped_column(String(16))
    occurred_on: Mapped[date] = mapped_column(Date)
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    description: Mapped[str] = mapped_column(String(500))
    category: Mapped[str | None] = mapped_column(String(160))



class BudgetCategory(ProfileEntity, Revisable, Base):
    __tablename__ = "budget_categories"
    __table_args__ = (profile_fk(),)
    name: Mapped[str] = mapped_column(String(40))
    archived: Mapped[bool] = mapped_column(server_default=text("false"))


class BudgetRule(ProfileEntity, Revisable, Base):
    __tablename__ = "budget_rules"
    __table_args__ = (
        profile_fk(),
        ForeignKeyConstraint(
            ["profile_id", "category_id"],
            ["finance.budget_categories.profile_id", "finance.budget_categories.id"],
            ondelete="RESTRICT",
        ),
    )
    category_id: Mapped[Uuid | None] = mapped_column(UUID(as_uuid=True))
    limit_minor: Mapped[int] = mapped_column(BigInteger)
    recurrence: Mapped[str] = mapped_column(String(7))
    from_month: Mapped[date] = mapped_column(Date)
    ends_before_month: Mapped[date | None] = mapped_column(Date)
    archived_from_month: Mapped[date | None] = mapped_column(Date)


class BudgetAssignment(ProfileEntity, Revisable, Base):
    """Independent sync identity; transaction_id uniquely references a posting."""
    __tablename__ = "budget_assignments"
    __table_args__ = (
        profile_fk(),
        ForeignKeyConstraint(
            ["profile_id", "transaction_id"],
            ["finance.ledger_transactions.profile_id", "finance.ledger_transactions.id"],
            ondelete="RESTRICT",
        ),
        UniqueConstraint("profile_id", "transaction_id"),
        ForeignKeyConstraint(
            ["profile_id", "category_id"],
            ["finance.budget_categories.profile_id", "finance.budget_categories.id"],
            ondelete="RESTRICT",
        ),
    )
    transaction_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True))
    category_id: Mapped[Uuid | None] = mapped_column(UUID(as_uuid=True))


class FinancialGoal(ProfileEntity, Revisable, Base):
    __tablename__ = "financial_goals"
    __table_args__ = (
        profile_fk(),
        ForeignKeyConstraint(["profile_id", "account_id"],
                             ["finance.accounts.profile_id", "finance.accounts.id"], ondelete="RESTRICT"),
    )
    account_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True))


class GoalEvent(ProfileEntity, Base):
    __tablename__ = "goal_events"
    __table_args__ = (
        profile_fk(),
        ForeignKeyConstraint(["profile_id", "goal_id"],
                             ["finance.financial_goals.profile_id", "finance.financial_goals.id"], ondelete="RESTRICT"),
        ForeignKeyConstraint(["profile_id", "ledger_transaction_id"],
                             ["finance.ledger_transactions.profile_id", "finance.ledger_transactions.id"],
                             ondelete="RESTRICT", deferrable=True, initially="DEFERRED"),
        UniqueConstraint("profile_id", "goal_id", "ordinal"),
        UniqueConstraint("profile_id", "ledger_transaction_id"),
    )
    goal_id: Mapped[Uuid] = mapped_column(UUID(as_uuid=True))
    ordinal: Mapped[int] = mapped_column(BigInteger)
    event: Mapped[dict[str, Any]] = mapped_column(JSONB)
    delta_minor: Mapped[int] = mapped_column(BigInteger)
    ledger_transaction_id: Mapped[Uuid | None] = mapped_column(UUID(as_uuid=True))
