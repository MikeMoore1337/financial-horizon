#!/usr/bin/env python3
"""Bind staged OAuth configuration to the *running* Financial Horizon auth SQLite.

Owner-only operator utility. Does not restart services, migrate a database,
touch Caddy, enable providers, or print secret values and filesystem paths.
Fail closed on unexpected states and preserve the original env in a root-only
unique backup. Run --preflight before the explicit --apply step.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
from urllib.parse import quote

SERVICE = "fh-email-auth.service"
EMAIL_ENV = Path("/etc/financial-horizon/email-auth.env")
OAUTH_ENV = Path("/etc/financial-horizon/oauth.env")
BACKUP_DIR = Path("/var/backups/financial-horizon")
CANARY_DB = Path("/var/lib/financial-horizon/oauth-canary/auth.sqlite3")
EXPECTED_USER_COLUMNS = (
    "id", "email", "password_hash", "verified_at",
    "password_changed_at", "disabled", "created_at",
)
FLAGS = (
    "FH_ENABLE_CLOUD_AUTH", "FH_TELEGRAM_OAUTH_ENABLED",
    "FH_GOOGLE_OAUTH_ENABLED", "FH_YANDEX_OAUTH_ENABLED",
    "FH_VK_OAUTH_ENABLED",
)
CREDENTIALS = (
    "FH_GOOGLE_OAUTH_CLIENT_ID", "FH_GOOGLE_OAUTH_CLIENT_SECRET",
    "FH_YANDEX_OAUTH_CLIENT_ID", "FH_YANDEX_OAUTH_CLIENT_SECRET",
    "FH_VK_OAUTH_CLIENT_ID",
)


class Blocked(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def one_value(raw: str, key: str) -> list[str]:
    values = []
    for line in raw.splitlines():
        if line.startswith(key + "="):
            values.append(line.partition("=")[2].strip().strip('"').strip("'"))
    return values


def private_regular(path: Path, *, mode: int = 0o600) -> bytes:
    if path.is_symlink():
        raise Blocked("SYMLINK_REJECTED")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != mode:
            raise Blocked("PRIVATE_FILE_INVALID")
        with os.fdopen(fd, "rb", closefd=False) as handle:
            raw = handle.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise Blocked("CONFIG_TOO_LARGE")
        return raw
    finally:
        os.close(fd)


def running_db_path() -> Path:
    output = subprocess.check_output(
        ["systemctl", "show", "--value", "-p", "MainPID", SERVICE],
        timeout=12, stderr=subprocess.DEVNULL,
    )
    if not output.strip().isdigit():
        raise Blocked("SERVICE_PID_INVALID")
    pid = int(output.strip())
    if pid <= 1:
        raise Blocked("SERVICE_NOT_RUNNING")
    process_env = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    matches = [
        row.partition(b"=")[2]
        for row in process_env
        if row.startswith(b"FH_AUTH_DATABASE_PATH=")
    ]
    if len(matches) != 1:
        raise Blocked("LIVE_DB_PATH_MISSING_OR_DUPLICATE")
    try:
        value = matches[0].decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise Blocked("LIVE_DB_PATH_INVALID") from exc
    # Do not introduce invalid systemd EnvironmentFile syntax or line breaks.
    if not re.fullmatch(r"/[A-Za-z0-9_./-]+", value):
        raise Blocked("LIVE_DB_PATH_INVALID")
    return Path(value)


def validate_db(path: Path) -> None:
    if not path.is_absolute() or path == CANARY_DB or path.is_symlink() or not path.is_file():
        raise Blocked("LIVE_DB_ISOLATION_FAILED")
    if path.parent.is_symlink() or path.parent.stat().st_mode & 0o077:
        raise Blocked("LIVE_DB_PARENT_NOT_PRIVATE")
    if path.stat().st_mode & 0o077:
        raise Blocked("LIVE_DB_FILE_NOT_PRIVATE")
    uri = "file:" + quote(str(path), safe="/") + "?mode=ro"
    with sqlite3.connect(uri, uri=True, timeout=5) as db:
        cols = db.execute("PRAGMA table_info(users)").fetchall()
        if tuple(c[1] for c in cols) != EXPECTED_USER_COLUMNS:
            raise Blocked("LIVE_DB_SCHEMA_UNEXPECTED")
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise Blocked("LIVE_DB_INTEGRITY_FAILED")
        if db.execute("PRAGMA foreign_key_check").fetchall():
            raise Blocked("LIVE_DB_FK_FAILED")


def validate_env(raw: str, live: Path) -> bool:
    key = "FH_AUTH_DATABASE_PATH"
    current = one_value(raw, key)
    if len(current) > 1:
        raise Blocked("OAUTH_DB_KEY_DUPLICATE")
    if current and Path(current[0]) != live:
        raise Blocked("OAUTH_DB_KEY_MISMATCH")
    legacy = one_value(raw, "FH_OAUTH_DATABASE_PATH")
    if legacy and (len(legacy) != 1 or Path(legacy[0]) != live):
        raise Blocked("LEGACY_OAUTH_DB_KEY_MISMATCH")
    if any(one_value(raw, flag) != ["false"] for flag in FLAGS):
        raise Blocked("OAUTH_FEATURE_FLAG_NOT_OFF")
    if any(len(one_value(raw, credential)) != 1 or
           not one_value(raw, credential)[0] for credential in CREDENTIALS):
        raise Blocked("STAGED_CREDENTIALS_MISSING")
    secret = one_value(raw, "FH_SESSION_SECRET")
    if len(secret) != 1 or len(secret[0]) < 32:
        raise Blocked("SESSION_SECRET_NOT_CONFIGURED")
    return bool(current)


def verify_backup_dir(path: Path) -> None:
    if (path.is_symlink() or not path.is_dir() or path.stat().st_uid != 0 or
            stat.S_IMODE(path.stat().st_mode) != 0o700):
        raise Blocked("BACKUP_DIR_NOT_PRIVATE")


def durable_create_backup(data: bytes) -> None:
    fd, name = tempfile.mkstemp(
        prefix="oauth-env-before-live-db-bind-", suffix=".env", dir=BACKUP_DIR
    )
    backup = Path(name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        dir_fd = os.open(BACKUP_DIR, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        backup.unlink(missing_ok=True)
        raise


def atomic_env_replace(path: Path, raw: bytes) -> None:
    fd, name = tempfile.mkstemp(prefix=".fh-oauth-stage-", dir=path.parent)
    candidate = Path(name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as out:
            out.write(raw)
            out.flush()
            os.fsync(out.fileno())
        os.replace(candidate, path)
        dir_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
        candidate.unlink(missing_ok=True)


def execute(*, apply: bool) -> None:
    if os.geteuid() != 0:
        raise Blocked("ROOT_REQUIRED")
    live = running_db_path()
    validate_db(live)
    email = private_regular(EMAIL_ENV).decode("utf-8")
    if one_value(email, "FH_AUTH_DATABASE_PATH") != [str(live)]:
        raise Blocked("LIVE_EMAIL_CONFIG_MISMATCH")
    staged = private_regular(OAUTH_ENV)
    text = staged.decode("utf-8")
    already = validate_env(text, live)
    verify_backup_dir(BACKUP_DIR)
    print("LIVE_DATABASE_PREFLIGHT=PASS")
    print("OAUTH_FLAGS_REMAIN_OFF=YES")
    print("TELEGRAM_DISABLED=YES")
    print("OAUTH_DB_KEY_COUNT=" + ("1" if already else "0"))
    if already:
        print("OAUTH_DB_MATCH=YES")
        print("BIND_STATUS=ALREADY_MATCHED")
        return
    if not apply:
        print("BIND_STATUS=READY_FOR_APPLY")
        return
    # Refuse a concurrent edit; preserve every preexisting secret byte.
    if private_regular(OAUTH_ENV) != staged:
        raise Blocked("STAGED_CONFIG_CHANGED")
    durable_create_backup(staged)
    appended = staged + (b"" if staged.endswith(b"\n") else b"\n") + (
        "FH_AUTH_DATABASE_PATH=" + str(live) + "\n"
    ).encode("utf-8")
    atomic_env_replace(OAUTH_ENV, appended)
    if private_regular(OAUTH_ENV) != appended or not validate_env(
        appended.decode("utf-8"), live
    ):
        raise Blocked("POST_WRITE_VERIFICATION_FAILED")
    print("ROOT_ONLY_ENV_BACKUP=CREATED")
    print("OAUTH_DB_KEY_COUNT=1")
    print("OAUTH_DB_MATCH=YES")
    print("BIND_STATUS=PASS")
    print("SERVICES_RESTARTED=NO")
    print("DATABASE_MIGRATED=NO")
    print("CADDY_CHANGED=NO")
    print("SECRETS_PRINTED=NO")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--preflight", action="store_true")
    group.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        execute(apply=args.apply)
    except Blocked as exc:
        print("BIND_STATUS=BLOCKED")
        print("FAILURE_CODE=" + exc.code)
        return 1
    except (OSError, sqlite3.Error, UnicodeError, subprocess.SubprocessError):
        print("BIND_STATUS=FAILED")
        print("FAILURE_CODE=RUNTIME_ERROR")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
