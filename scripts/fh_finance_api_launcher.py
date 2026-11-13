#!/usr/bin/env python3
"""Systemd-only finance credential adapter for the existing FH auth Uvicorn.

The password is already stored under the existing private PostgreSQL secret.
systemd LoadCredential copies it into a service-private /run/credentials dir.
Only this process environment receives the resulting DSN; no URL or password
is added to a unit file, command line, static page or persistent runtime env.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import sys

CREDENTIAL_NAME = "fh_finance_runtime_password"
CREDENTIAL_DIR = Path("/run/credentials/fh-email-auth.service")
USER = "fh_email_auth.app:app"


def main() -> int:
    if sys.argv[1:3] != ["--", USER]:
        raise SystemExit("FINANCE_LAUNCHER_NO_GO: UNEXPECTED_UVICORN_APP")
    supplied = os.environ.get("CREDENTIALS_DIRECTORY", "")
    if supplied != str(CREDENTIAL_DIR):
        raise SystemExit("FINANCE_LAUNCHER_NO_GO: SYSTEMD_CREDENTIALS_REQUIRED")
    try:
        secret = (CREDENTIAL_DIR / CREDENTIAL_NAME).read_text(encoding="ascii")
    except (OSError, UnicodeError):
        raise SystemExit("FINANCE_LAUNCHER_NO_GO: PRIVATE_CREDENTIAL_UNAVAILABLE") from None
    if not re.fullmatch(r"[0-9a-f]{64}", secret):
        raise SystemExit("FINANCE_LAUNCHER_NO_GO: INVALID_PRIVATE_CREDENTIAL")
    if os.environ.get("FH_FINANCE_RUNTIME_MODE") != "personal" or (
        os.environ.get("FH_FINANCE_V2_RUNTIME") != "on" or
        os.environ.get("FH_FINANCE_IMPORT_RUNTIME") != "off"
    ):
        raise SystemExit("FINANCE_LAUNCHER_NO_GO: FINANCE_FLAGS_NOT_EXPLICIT")
    # Never print, persist or expose this URL in argv or journal.
    os.environ["FH_FINANCE_DATABASE_URL"] = (
        "postgresql+psycopg://fh_finance_runtime:"
        + secret + "@127.0.0.1:54329/fh_finance"
    )
    del secret
    os.execv(sys.executable, [
        sys.executable, "-m", "uvicorn", *sys.argv[2:],
    ])
    raise AssertionError("execv should not return")


if __name__ == "__main__":
    raise SystemExit(main())
