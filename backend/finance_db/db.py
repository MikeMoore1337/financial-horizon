"""Transaction-bound PostgreSQL context. Only call after the auth session is verified."""
from __future__ import annotations

from contextlib import contextmanager
import os
import re
from uuid import UUID

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

_AUTH_ID = re.compile(r"^[0-9a-f]{32}$")


def create_finance_engine(url: str | None = None) -> Engine:
    """Use runtime credentials, never the migration or PostgreSQL superuser role."""
    dsn = url or os.environ["FH_FINANCE_DATABASE_URL"]
    if not dsn.startswith("postgresql+psycopg://"):
        raise ValueError("Financial database must use PostgreSQL with psycopg 3")
    return create_engine(
        dsn,
        pool_size=2,
        max_overflow=1,
        pool_timeout=3,
        pool_pre_ping=True,
        connect_args={
            "options": "-csearch_path=finance,pg_catalog"
            " -cstatement_timeout=5000 -clock_timeout=1500"
            " -cidle_in_transaction_session_timeout=15000"
        },
    )


@contextmanager
def finance_transaction(engine: Engine, *, verified_user_id: str, profile_id: UUID):
    """Fail closed: SET LOCAL scope expires on COMMIT/ROLLBACK, including pooled connections.

    verified_user_id MUST come from AuthStore.current on the server (#67).
    Never derive user identity or scope from an untrusted request body.
    """
    if not _AUTH_ID.fullmatch(verified_user_id):
        raise ValueError("Verified auth user id must be 32 lowercase hex characters")
    if not isinstance(profile_id, UUID):
        raise TypeError("profile_id must be a server-authorized UUID")
    with Session(engine) as session, session.begin():
        session.execute(text("SELECT set_config('fh.user_id', :user_id, true)"), {"user_id": verified_user_id})
        session.execute(text("SELECT set_config('fh.profile_id', :profile_id, true)"), {"profile_id": str(profile_id)})
        yield session
