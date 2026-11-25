"""Simulate lost journal rows ONLY in the disposable localhost CI database."""
import os
import re
import sys
from uuid import UUID, uuid5

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url


def main():
    if os.environ.get("FH_E2E_REAL_FINANCE") != "yes" or os.environ.get("FH_FINANCE_CI_ALLOW_BOOTSTRAP") != "yes":
        raise RuntimeError("Disposable finance E2E database required")
    url = make_url(os.environ["FH_FINANCE_MIGRATION_URL"])
    if (url.drivername != "postgresql+psycopg" or url.host != "127.0.0.1"
            or url.database != "fh_finance_ci" or url.username != "fh_finance_migrator"
            or url.password != "ci_migration_password_only" or url.query):
        raise RuntimeError("Refusing non-CI database")
    if len(sys.argv) not in (3, 4):
        raise RuntimeError("Expected synthetic identity, revision and optional gap mode")
    actor, raw_revision = sys.argv[1:3]
    mode = sys.argv[3] if len(sys.argv) == 4 else "watermark"
    if mode not in ("watermark", "gap"):
        raise RuntimeError("Invalid synthetic loss mode")
    if not re.fullmatch(r"[a-f0-9]{32}", actor) or not re.fullmatch(r"[1-9][0-9]{0,8}", raw_revision):
        raise RuntimeError("Invalid synthetic identity or revision")
    profile = uuid5(UUID("e15ea001-d512-4fb7-a0ee-e05b4df1d45e"),
                    "financial-horizon:finance-profile:v1:" + actor)
    revision = int(raw_revision)
    engine = create_engine(url)
    try:
        with engine.begin() as connection:
            connection.execute(text("SELECT set_config('fh.user_id', :v, true)"), {"v": actor})
            connection.execute(text("SELECT set_config('fh.profile_id', :v, true)"), {"v": str(profile)})
            count = connection.execute(text("SELECT count(*) FROM finance.change_log WHERE profile_id=:p AND revision=:r"),
                                       {"p": profile, "r": revision}).scalar_one()
            if not 1 <= count <= 3:
                raise RuntimeError("Expected a bounded synthetic committed revision")
            connection.execute(text("ALTER TABLE finance.change_log DISABLE TRIGGER protect_change_log"))
            deleted = connection.execute(text("DELETE FROM finance.change_log WHERE profile_id=:p AND revision=:r"),
                                         {"p": profile, "r": revision}).rowcount
            connection.execute(text("ALTER TABLE finance.change_log ENABLE TRIGGER protect_change_log"))
            if mode == "watermark":
                updated = connection.execute(text("UPDATE finance.finance_profiles SET min_available_revision=:r "
                                                  "WHERE id=:p AND revision=:r"),
                                             {"p": profile, "r": revision}).rowcount
            else:
                updated = connection.execute(text("SELECT count(*) FROM finance.finance_profiles "
                                                  "WHERE id=:p AND revision=:r AND min_available_revision<:r"),
                                             {"p": profile, "r": revision}).scalar_one()
            if deleted != count or updated != 1:
                raise RuntimeError("Unexpected synthetic database state")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
