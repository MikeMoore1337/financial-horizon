"""One-shot migration entrypoint; password never appears in the URL or CLI."""
from __future__ import annotations
import os
from pathlib import Path
import subprocess

secret_path = Path(os.environ["FH_FINANCE_PASSWORD_FILE"])
password = secret_path.read_text(encoding="utf-8").rstrip("\n")
if len(password) < 32 or "\n" in password or "\r" in password or ":" in password:
    raise RuntimeError("Invalid database secret")
pgpass = Path("/tmp/fh-finance.pgpass")
pgpass.write_text("db:5432:fh_finance:fh_finance_migrator:" + password + "\n", encoding="utf-8")
pgpass.chmod(0o600)
env = os.environ.copy()
env.pop("FH_FINANCE_PASSWORD_FILE", None)
env["PGPASSFILE"] = str(pgpass)
try:
    subprocess.run(
        ["alembic", "-c", "backend/finance_db/alembic.ini", "upgrade", "head"],
        env=env,
        check=True,
    )
finally:
    pgpass.unlink(missing_ok=True)
