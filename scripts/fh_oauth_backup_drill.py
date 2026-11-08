#!/usr/bin/env python3
"""Online SQLite snapshot + isolated restore drill for FH OAuth release readiness.

Never migrates the live database, changes an environment file, or restarts
production services. Stores only one 0600 root-only backup, then validates a
temporary restored clone. No secret values, DB path, or account data are printed.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
from urllib.parse import quote

AUTH_SERVICE = "fh-email-auth.service"
EMAIL_CONFIG = Path("/etc/financial-horizon/email-auth.env")
OAUTH_CONFIG = Path("/etc/financial-horizon/oauth.env")
BACKUPS = Path("/var/backups/financial-horizon")
CANARY_DB = Path("/var/lib/financial-horizon/oauth-canary/auth.sqlite3")
USER_COLUMNS = (
    "id", "email", "password_hash", "verified_at",
    "password_changed_at", "disabled", "created_at",
)
TABLES = ("users", "sessions", "actions", "email_changes")
FLAGS = (
    "FH_ENABLE_CLOUD_AUTH", "FH_TELEGRAM_OAUTH_ENABLED",
    "FH_GOOGLE_OAUTH_ENABLED", "FH_YANDEX_OAUTH_ENABLED", "FH_VK_OAUTH_ENABLED",
)


class Blocked(Exception):
    """A fail-closed check; code is a constant and safe to display."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def value(raw: str, name: str) -> list[str]:
    return [row.partition("=")[2].strip().strip('"').strip("'")
            for row in raw.splitlines() if row.startswith(name + "=")]


def root_private_text(path: Path) -> str:
    if path.is_symlink():
        raise Blocked("CONFIG_SYMLINK")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or stat.S_IMODE(st.st_mode) != 0o600:
            raise Blocked("CONFIG_NOT_ROOT_PRIVATE")
        raw = os.read(fd, 1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise Blocked("CONFIG_TOO_LARGE")
        return raw.decode("utf-8", errors="strict")
    finally:
        os.close(fd)


def running_database() -> Path:
    result = subprocess.check_output(
        ["systemctl", "show", "-p", "MainPID", "--value", AUTH_SERVICE],
        timeout=12, stderr=subprocess.DEVNULL,
    ).strip()
    if not result.isdigit() or int(result) <= 1:
        raise Blocked("SERVICE_NOT_RUNNING")
    env = Path(f"/proc/{int(result)}/environ").read_bytes().split(b"\0")
    matches = [s.partition(b"=")[2] for s in env
               if s.startswith(b"FH_AUTH_DATABASE_PATH=")]
    if len(matches) != 1:
        raise Blocked("PROCESS_DB_KEY_AMBIGUOUS")
    try:
        name = matches[0].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise Blocked("PROCESS_DB_PATH_INVALID") from exc
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", name):
        raise Blocked("PROCESS_DB_PATH_INVALID")
    return Path(name)


def guarded_source(path: Path) -> None:
    if (not path.is_absolute() or path == CANARY_DB or
            path.is_symlink() or not path.is_file()):
        raise Blocked("DB_MISSING_OR_CANARY")
    if (path.parent.is_symlink() or
            path.parent.stat().st_mode & 0o077 or
            path.stat().st_mode & 0o077):
        raise Blocked("DB_NOT_PRIVATE")


def inspect_sqlite(path: Path) -> tuple[int, ...]:
    uri = "file:" + quote(str(path), safe="/") + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True, timeout=15)) as conn:
        columns = conn.execute("PRAGMA table_info(users)").fetchall()
        if tuple(c[1] for c in columns) != USER_COLUMNS or columns[1][3] != 1:
            raise Blocked("PRE_OAUTH_USERS_SCHEMA_UNEXPECTED")
        names = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}
        if any(name not in names for name in TABLES) or "oauth_identities" in names:
            raise Blocked("AUTH_TABLE_SET_UNEXPECTED")
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise Blocked("DB_INTEGRITY_FAILED")
        if conn.execute("PRAGMA foreign_key_check").fetchall():
            raise Blocked("DB_FOREIGN_KEY_FAILED")
        count = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master "
            "WHERE tbl_name='users' AND type IN ('index','trigger') AND sql IS NOT NULL"
        ).fetchone()[0]
        if count != 0:
            raise Blocked("UNEXPECTED_USERS_INDEX_OR_TRIGGER")
        return tuple(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                     for table in TABLES)


def preflight() -> Path:
    if os.geteuid() != 0:
        raise Blocked("ROOT_REQUIRED")
    db = running_database()
    guarded_source(db)
    email = root_private_text(EMAIL_CONFIG)
    staged = root_private_text(OAUTH_CONFIG)
    if value(email, "FH_AUTH_DATABASE_PATH") != [str(db)] or \
            value(staged, "FH_AUTH_DATABASE_PATH") != [str(db)]:
        raise Blocked("CONFIG_DATABASE_PATH_MISMATCH")
    if any(value(staged, key) != ["false"] for key in FLAGS):
        raise Blocked("OAUTH_FLAGS_MUST_BE_OFF")
    if (BACKUPS.is_symlink() or not BACKUPS.is_dir() or
            BACKUPS.stat().st_uid != 0 or
            stat.S_IMODE(BACKUPS.stat().st_mode) != 0o700):
        raise Blocked("BACKUP_DIRECTORY_NOT_PRIVATE")
    inspect_sqlite(db)
    return db


def file_hash(path: Path) -> bytes:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.digest()


def backup_and_restore_drill(source: Path, directory: Path = BACKUPS) -> None:
    """Consistent SQLite online backup; isolate and validate a full restored copy."""
    fd, filename = tempfile.mkstemp(
        prefix="auth-before-oauth-", suffix=".sqlite3", dir=directory,
    )
    snapshot = Path(filename)
    os.fchmod(fd, 0o600)
    os.close(fd)
    valid = False
    try:
        uri = "file:" + quote(str(source), safe="/") + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True, timeout=30)) as live:
            with closing(sqlite3.connect(snapshot, timeout=30)) as target:
                live.backup(target)
                target.commit()
        first = inspect_sqlite(snapshot)
        with tempfile.TemporaryDirectory(prefix="fh-oauth-restore-", dir=directory) as temp:
            clone = Path(temp) / "restored.sqlite3"
            shutil.copyfile(snapshot, clone)
            clone.chmod(0o600)
            second = inspect_sqlite(clone)
            if first != second or file_hash(snapshot) != file_hash(clone):
                raise Blocked("RESTORE_MISMATCH")
        if stat.S_IMODE(snapshot.stat().st_mode) != 0o600 or snapshot.is_symlink():
            raise Blocked("BACKUP_PERMISSIONS_INVALID")
        valid = True
    finally:
        if not valid:
            # Do not retain an incomplete or unverified snapshot.
            snapshot.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--preflight", action="store_true")
    group.add_argument("--backup-drill", action="store_true")
    args = parser.parse_args()
    try:
        source = preflight()
        print("LIVE_DB_PREFLIGHT=PASS")
        print("OAUTH_FLAGS_OFF=YES")
        print("TELEGRAM_DISABLED=YES")
        if args.preflight:
            print("BACKUP_STATUS=READY")
            return 0
        backup_and_restore_drill(source)
        print("CONSISTENT_BACKUP=CREATED")
        print("BACKUP_FILE_MODE_0600=YES")
        print("RESTORE_DRILL=PASS")
        print("SCHEMA_AND_FK=PASS")
        print("LIVE_DATABASE_MODIFIED=NO")
        print("SERVICES_RESTARTED=NO")
        print("CADDY_CHANGED=NO")
        print("OAUTH_FEATURE_FLAGS_CHANGED=NO")
        print("BACKUP_STATUS=PASS")
        return 0
    except Blocked as exc:
        print("BACKUP_STATUS=BLOCKED")
        print("FAILURE_CODE=" + exc.code)
    except (OSError, sqlite3.Error, UnicodeError, subprocess.SubprocessError):
        print("BACKUP_STATUS=FAILED")
        print("FAILURE_CODE=RUNTIME_ERROR")
    return 1


if __name__ == "__main__":
    sys.exit(main())
