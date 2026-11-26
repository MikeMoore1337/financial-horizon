#!/usr/bin/env python3
"""#38: audited, explicit bank API + Caddy exposure on an already-migrated FH VPS.

Run only on the trusted native production host, after current main CI, Alembic
0007_bank_statements and a real encrypted backup + isolated restore drill.
This operator does NOT alter PostgreSQL, import any financial data, enable
legacy #69 import, or change static PWA assets.

  python3 scripts/fh_bank38_release.py --sha SHA --preflight
  FH_BANK38_RELEASE=ENABLE python3 scripts/fh_bank38_release.py --sha SHA --enable
  FH_BANK38_RELEASE=DISABLE python3 scripts/fh_bank38_release.py --sha SHA --disable

New routes are a strict same-origin allowlist: two GET, two POST. Only the
read-only gate can run without an explicit mutation token. On failure, restore
the original Caddy bytes and disable the exact bank feature drop-in.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import sys
import time

import fh_finance_active_backend_upgrade as backend
import fh_finance_auth_source_rollout as source
import fh_finance_personal_import_window as legacy
import fh_finance_private_api_release as finance

BANK_ROUTES = (
    "    @fh_bank38_read {\n"
    "        method GET\n"
    "        path /api/finance/v2/bank-import/rows /api/finance/v2/bank-import/batches\n"
    "    }\n"
    "    handle @fh_bank38_read {\n"
    "        reverse_proxy 127.0.0.1:9138 {\n"
    '            header_down Cache-Control "private, no-store, no-transform"\n'
    "        }\n"
    "    }\n"
    "    @fh_bank38_write {\n"
    "        method POST\n"
    "        path /api/finance/v2/bank-import/commit /api/finance/v2/bank-import/undo\n"
    "    }\n"
    "    handle @fh_bank38_write {\n"
    "        reverse_proxy 127.0.0.1:9138 {\n"
    '            header_down Cache-Control "private, no-store, no-transform"\n'
    "        }\n"
    "    }\n"
)
DROP95 = Path("/etc/systemd/system/fh-email-auth.service.d/95-bank-import-38.conf")
FLAG = b"[Service]\nEnvironment=FH_FINANCE_BANK_IMPORT_RUNTIME=on\n"
BACKUPS = source.BACKUPS
CADDY = finance.CADDY
SERVICE = finance.SERVICE
HEX = re.compile(r"^[a-f0-9]{40}$")


class Hold(Exception):
    pass


def refuse(reason: str) -> None:
    raise Hold(reason)


def verified_sha(sha: str) -> str:
    if not HEX.fullmatch(sha):
        refuse("INVALID_EXACT_SHA")
    return sha


def backup_path(sha: str) -> Path:
    return BACKUPS / ("fh-bank38-caddy-original-" + verified_sha(sha) + ".bak")


def bank_caddy_patch(original: bytes) -> bytes:
    """Preserve entire site verbatim except for four pinned Caddy blocks."""
    if type(original) is not bytes or not 0 < len(original) <= 256_000:
        refuse("CADDY_SOURCE_BYTES_INVALID")
    try:
        text = original.decode("utf-8")
    except UnicodeError:
        refuse("CADDY_SOURCE_NOT_UTF8")
    if (text.count(finance.CADDY_MARKER) != 1
            or "/api/finance/v2/bank-import/" in text
            or "@fh_bank38_" in text
            or "@fh_personal_import_write" in text
            or "/api/finance/v1/import/" in text):
        refuse("CADDY_SOURCE_NOT_EXACT_BASELINE")
    try:
        legacy._require_existing_finance_routes(text)
    except legacy.Hold:
        refuse("CADDY_EXISTING_FINANCE_ROUTES_DIFFER")
    return text.replace(
        finance.CADDY_MARKER, BANK_ROUTES + finance.CADDY_MARKER, 1,
    ).encode("utf-8")


def postgres_ready() -> None:
    """Only metadata: never print finance data or read passwords."""
    def sql(statement: str) -> str:
        return finance.run(
            ["docker", "exec", "-u", "postgres", "fh-finance-postgres",
             "psql", "-X", "-U", "postgres", "-d", "fh_finance",
             "-Atqc", statement],
            error="BANK_SCHEMA_SQL_UNAVAILABLE",
        ).strip()

    version = sql("SELECT version_num FROM finance.alembic_version")
    expected_tables = {"0007_bank_statements": "18", "0008_budget_rules": "21"}.get(version)
    if expected_tables is None:
        refuse("BANK_SCHEMA_0007_REQUIRED")
    tables = sql("""
        SELECT count(*) FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='finance' AND c.relkind='r'
        AND c.relname<>'alembic_version'
        AND c.relrowsecurity AND c.relforcerowsecurity
    """)
    if tables != expected_tables:
        refuse("BANK_ALL_FORCE_RLS_TABLES_REQUIRED")
    allowed = sql("""
        SELECT has_table_privilege('fh_finance_runtime',
                    'finance.bank_import_batches','SELECT')
          AND has_table_privilege('fh_finance_runtime',
                    'finance.bank_import_rows','SELECT')
          AND has_table_privilege('fh_finance_runtime',
                    'finance.bank_import_rows','INSERT')
          AND NOT has_table_privilege('fh_finance_runtime',
                    'finance.bank_import_rows','DELETE')
    """)
    if allowed != "t":
        refuse("BANK_RUNTIME_PERMISSIONS_UNSAFE")


def _existing_dropin() -> bool:
    if DROP95.is_symlink():
        refuse("BANK_DROPIN_SYMLINK")
    return DROP95.exists()


def read_only_preflight(sha: str) -> tuple[bytes, int]:
    verified_sha(sha)
    if os.geteuid() != 0 or os.getenv("GITHUB_ACTIONS") == "true":
        refuse("TRUSTED_NATIVE_ROOT_REQUIRED")
    backend.check_checkout(sha)
    source.active_services()
    if finance.run(
        ["systemctl", "is-active", "fh-finance-personal-backup.timer"],
        error="BANK_BACKUP_TIMER_UNAVAILABLE",
    ) != "active":
        refuse("BANK_BACKUP_TIMER_NOT_ACTIVE")
    if finance.run(
        ["docker", "inspect", "-f", "{{.State.Health.Status}}",
         "fh-finance-postgres"],
        error="BANK_POSTGRES_HEALTH_UNAVAILABLE",
    ) != "healthy":
        refuse("BANK_POSTGRES_NOT_HEALTHY")
    if finance.run(
        ["docker", "port", "fh-finance-postgres", "5432/tcp"],
        error="BANK_PRIVATE_PORT_UNAVAILABLE",
    ) != "127.0.0.1:54329":
        refuse("BANK_POSTGRES_NOT_LOOPBACK_ONLY")
    finance.load_runtime()  # strict legacy #69 off and personal finance v2 on
    current = legacy.current_source()
    if source.source_files(current) != source.source_files(source.REPO / "backend"):
        refuse("BANK_BACKEND_NOT_RELEASED_FOR_MAIN")
    if _existing_dropin():
        refuse("BANK_ALREADY_ENABLED_OR_UNRECOGNIZED")
    postgres_ready()
    finance.enabled_local_smoke()
    if (finance.local_probe("/api/finance/v2/bank-import/rows") != 404
            or finance.local_probe("/api/finance/v2/bank-import/commit",
                                   method="POST", origin=finance.ORIGIN) != 404):
        refuse("BANK_FEATURE_ALREADY_MOUNTED")
    caddy, mode = finance.caddy_snapshot()
    bank_caddy_patch(caddy)
    if (not BACKUPS.is_dir() or BACKUPS.is_symlink()
            or BACKUPS.stat().st_uid != 0
            or BACKUPS.stat().st_mode & 0o777 != 0o700):
        refuse("OWNER_BACKUP_DIRECTORY_UNTRUSTED")
    if backup_path(sha).exists() or backup_path(sha).is_symlink():
        refuse("BANK_RELEASE_BACKUP_ALREADY_EXISTS")
    print("FH38_BANK_API_PREFLIGHT=PASS")
    print("FH38_SCHEMA_0007_AND_RLS=PASS")
    print("FH38_SIGNED_BANK_API=OFF")
    print("FH38_AUTH_DATA_UNCHANGED=YES")
    return caddy, mode


def restart_auth() -> None:
    finance.run(["systemctl", "restart", SERVICE], timeout=45,
                error="BANK_AUTH_RESTART_FAILED")
    deadline = time.monotonic() + 40
    while True:
        try:
            finance.enabled_local_smoke()
            return
        except finance.NoGo:
            if time.monotonic() >= deadline:
                raise
            time.sleep(.5)


def public_negative_checks() -> None:
    if (finance.public_probe("/api/auth/providers") != 200
            or finance.public_probe("/api/finance/v1/state") != 401
            or finance.public_probe("/api/finance/v2/commands",
                                    method="POST", origin=finance.ORIGIN) != 401):
        refuse("BANK_EXISTING_AUTH_OR_FINANCE_REGRESSION")
    for path in (
        "/api/finance/v2/bank-import/rows",
        "/api/finance/v2/bank-import/batches",
    ):
        if finance.local_probe(path) != 401 or finance.public_probe(path) != 401:
            refuse("BANK_ANONYMOUS_GET_NOT_REJECTED")
    for path in (
        "/api/finance/v2/bank-import/commit",
        "/api/finance/v2/bank-import/undo",
    ):
        if (finance.local_probe(path, method="POST", origin=finance.ORIGIN) != 401
                or finance.public_probe(path, method="POST", origin=finance.ORIGIN) != 401
                or finance.public_probe(path, method="POST",
                                        origin="https://untrusted.example") != 403):
            refuse("BANK_ANONYMOUS_POST_OR_CSRF_NOT_REJECTED")


def _reload_caddy() -> None:
    finance.run(["caddy", "validate", "--config", str(finance.CADDYFILE)],
                error="BANK_CADDY_VALIDATE_FAILED")
    finance.run(["systemctl", "reload", "caddy.service"],
                error="BANK_CADDY_RELOAD_FAILED")


def _remove_exact_flag() -> None:
    if (_existing_dropin() and
            finance.secure_file(DROP95, 0, 0o644) == FLAG):
        DROP95.unlink()
        finance.run(["systemctl", "daemon-reload"],
                    error="BANK_SYSTEMD_RELOAD_FAILED")
    else:
        refuse("BANK_FLAG_NOT_EXACT_OR_REMOVED_BY_OTHER_OPERATOR")


def enable(sha: str) -> None:
    original, mode = read_only_preflight(sha)
    if os.getenv("FH_BANK38_RELEASE") != "ENABLE":
        refuse("EXPLICIT_BANK38_ENABLE_REQUIRED")
    backend.check_checkout(sha)
    patch = bank_caddy_patch(original)
    # Separate immutable backup must exist before any Caddy or systemd change.
    finance.write_exclusive(backup_path(sha), original, mode=0o600)
    source.backup_live_auth_db()
    created = False
    try:
        finance.write_exclusive(DROP95, FLAG, mode=0o644)
        created = True
        finance.run(["systemctl", "daemon-reload"],
                    error="BANK_SYSTEMD_RELOAD_FAILED")
        restart_auth()
        # The new endpoints are mounted locally before public exposure.
        if (finance.local_probe("/api/finance/v2/bank-import/rows") != 401
                or finance.local_probe("/api/finance/v2/bank-import/commit",
                                       method="POST", origin=finance.ORIGIN) != 401):
            refuse("BANK_LOCAL_MOUNT_OR_AUTH_FAILED")
        now, _ = finance.caddy_snapshot()
        if now != original:
            refuse("BANK_CONCURRENT_CADDY_CHANGE")
        finance.atomic_replace(CADDY, patch, mode=mode)
        _reload_caddy()
        public_negative_checks()
    except Exception:
        print("FH38_BANK_API_ROLLBACK=STARTED")
        try:
            current, _ = finance.caddy_snapshot()
            if current not in (original, patch):
                refuse("BANK_CADDY_CONCURRENT_CHANGE_MANUAL_REVIEW")
            if current != original:
                finance.atomic_replace(CADDY, original, mode=mode)
                _reload_caddy()
            if created:
                _remove_exact_flag()
                restart_auth()
            if finance.local_probe("/api/finance/v2/bank-import/rows") != 404:
                refuse("BANK_BACKEND_STILL_ACTIVE_AFTER_ROLLBACK")
            print("FH38_BANK_API_ROLLBACK=PASS")
        except Exception:
            print("FH38_BANK_API_ROLLBACK=MANUAL_REVIEW_REQUIRED")
        raise
    print("FH38_BANK_API_PUBLIC_GUARDS=PASS")
    print("FH38_BANK_API_BACKEND=ENABLED")
    print("FH38_NO_USER_FINANCIAL_COMMAND_EXECUTED=YES")


def disable(sha: str) -> None:
    # Emergency closure: do not require the older SHA to remain current main.
    verified_sha(sha)
    if (os.geteuid() != 0 or os.getenv("GITHUB_ACTIONS") == "true"
            or os.getenv("FH_BANK38_RELEASE") != "DISABLE"):
        refuse("BANK_EXPLICIT_NATIVE_DISABLE_REQUIRED")
    original = finance.secure_file(backup_path(sha), 0, 0o600)
    patched = bank_caddy_patch(original)
    if not _existing_dropin() or finance.secure_file(DROP95, 0, 0o644) != FLAG:
        refuse("BANK_FLAG_NOT_EXACT")
    current, mode = finance.caddy_snapshot()
    if current != patched:
        refuse("BANK_CADDY_CHANGED_OR_ALREADY_DISABLED")
    # Remove public paths first; never leave writable bank endpoints exposed
    # if the subsequent backend flag removal/restart fails.
    finance.atomic_replace(CADDY, original, mode=mode)
    _reload_caddy()
    _remove_exact_flag()
    restart_auth()
    if finance.local_probe("/api/finance/v2/bank-import/rows") != 404:
        refuse("BANK_BACKEND_FLAG_STILL_ACTIVE")
    print("FH38_BANK_API_BACKEND=DISABLED")
    print("FH38_BANK_PUBLIC_ROUTES=REMOVED")
    print("FH38_FINANCIAL_DATA_UNCHANGED_BY_TOGGLE=YES")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument("--preflight", action="store_true")
    choice.add_argument("--enable", action="store_true")
    choice.add_argument("--disable", action="store_true")
    args = parser.parse_args()
    try:
        if args.preflight:
            read_only_preflight(args.sha)
        elif args.enable:
            enable(args.sha)
        else:
            disable(args.sha)
        return 0
    except (Hold, backend.Hold, source.NoGo, finance.NoGo,
            legacy.Hold) as exc:
        print("FH38_BANK_API=NO_GO")
        print("FAILURE_CODE=" + str(exc))
        return 1
    except Exception:
        print("FH38_BANK_API=FAILED")
        print("FAILURE_CODE=UNEXPECTED_RUNTIME")
        return 1


if __name__ == "__main__":
    sys.exit(main())
