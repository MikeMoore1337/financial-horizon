#!/usr/bin/env python3
"""Publish only the #68 recovery/cancellation routes; preserve existing services.

Run on the trusted production host, after exact-main CI and backend rollout:
  python3 scripts/fh_finance_sync_routes_68.py --sha SHA --preflight
  FH_SYNC68_ROUTES=ENABLE python3 scripts/fh_finance_sync_routes_68.py --sha SHA --enable
  FH_SYNC68_ROUTES=DISABLE python3 scripts/fh_finance_sync_routes_68.py --sha SHA --disable

No finance command, account change, database migration or service restart is
performed. If public negative checks fail, restore the exact previous Caddy
bytes, unless another operator changed them in the meantime.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import stat

import fh_bank38_release as bank
import fh_finance_active_backend_upgrade as backend
import fh_finance_auth_source_rollout as source
import fh_finance_personal_import_window as legacy
import fh_finance_private_api_release as finance

ROUTES = (
    "    @fh_sync68_read {\n"
    "        method GET\n"
    "        path_regexp ^/api/finance/v1/commands/[0-9a-f-]+/changes$\n"
    "    }\n"
    "    handle @fh_sync68_read {\n"
    "        reverse_proxy 127.0.0.1:9138 {\n"
    '            header_down Cache-Control "private, no-store, no-transform"\n'
    "        }\n"
    "    }\n"
    "    @fh_sync68_write {\n"
    "        method POST\n"
    "        path /api/finance/v1/commands/cancel /api/finance/v2/commands/cancel\n"
    "    }\n"
    "    handle @fh_sync68_write {\n"
    "        reverse_proxy 127.0.0.1:9138 {\n"
    '            header_down Cache-Control "private, no-store, no-transform"\n'
    "        }\n"
    "    }\n"
)
READ = '/api/finance/v1/commands/00000000-0000-4000-8000-000000000000/changes'
WRITES = ('/api/finance/v1/commands/cancel', '/api/finance/v2/commands/cancel')


class Hold(Exception):
    pass


def deny(code: str) -> None:
    raise Hold(code)


def backup_path(sha: str) -> Path:
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        deny('INVALID_EXACT_SHA')
    return source.BACKUPS / ('fh-sync68-caddy-original-' + sha + '.bak')


def patch_caddy(original: bytes) -> bytes:
    # The existing protected backup reader is deliberately capped at 8192 B.
    # Never enable a route if that reader could not later restore the backup.
    if type(original) is not bytes or not 0 < len(original) <= 8192:
        deny('CADDY_SOURCE_BYTES_INVALID')
    try:
        text = original.decode('utf-8')
    except UnicodeError:
        deny('CADDY_SOURCE_NOT_UTF8')
    if (text.count(finance.CADDY_MARKER) != 1 or '@fh_sync68_' in text
            or '/commands/cancel' in text or '/commands/[0-9a-f-]+/changes' in text
            or text.count(bank.BANK_ROUTES) != 1):
        deny('CADDY_SOURCE_NOT_EXACT_BASELINE')
    try:
        legacy._require_existing_finance_routes(text)
    except legacy.Hold:
        deny('CADDY_EXISTING_FINANCE_ROUTES_DIFFER')
    return text.replace(finance.CADDY_MARKER, ROUTES + finance.CADDY_MARKER, 1).encode('utf-8')


def local_guards() -> None:
    if finance.local_probe(READ) != 401:
        deny('SYNC_LOCAL_READ_AUTH_FAILED')
    for path in WRITES:
        if (finance.local_probe(path, method='POST', origin=finance.ORIGIN) != 401 or
                finance.local_probe(path, method='POST', origin='https://untrusted.example') != 403):
            deny('SYNC_LOCAL_WRITE_AUTH_OR_ORIGIN_FAILED')


def public_guards() -> None:
    if finance.public_probe(READ) != 401:
        deny('SYNC_PUBLIC_READ_AUTH_FAILED')
    for path in WRITES:
        if (finance.public_probe(path, method='POST', origin=finance.ORIGIN) != 401 or
                finance.public_probe(path, method='POST', origin='https://untrusted.example') != 403):
            deny('SYNC_PUBLIC_WRITE_AUTH_OR_ORIGIN_FAILED')
    bank.public_negative_checks()
    if finance.public_probe('/api/finance/v1/state') != 401:
        deny('FINANCE_EXISTING_PUBLIC_GUARD_FAILED')


def preflight(sha: str) -> tuple[bytes, int]:
    target = backup_path(sha)
    backend.check_checkout(sha)
    if backend.live_state() != source.RELEASES / sha:
        deny('BACKEND_EXACT_SHA_REQUIRED')
    if source.source_files(source.RELEASES / sha / 'backend') != source.source_files(source.REPO / 'backend'):
        deny('BACKEND_SOURCE_INTEGRITY_FAILED')
    if (not bank._existing_dropin() or
            finance.secure_file(bank.DROP95, 0, 0o644) != bank.FLAG):
        deny('BANK_FLAG_CHANGED')
    bank.postgres_ready()
    local_guards()
    original, mode = finance.caddy_snapshot()
    patch_caddy(original)
    if (source.BACKUPS.is_symlink() or not source.BACKUPS.is_dir() or
            source.BACKUPS.stat().st_uid != 0 or
            stat.S_IMODE(source.BACKUPS.stat().st_mode) != 0o700 or
            target.exists() or target.is_symlink()):
        deny('ROLLBACK_BACKUP_UNAVAILABLE')
    if finance.public_probe(READ) != 404:
        deny('SYNC_PUBLIC_BASELINE_CHANGED')
    for path in WRITES:
        if finance.public_probe(path, method='POST', origin=finance.ORIGIN) != 404:
            deny('SYNC_PUBLIC_BASELINE_CHANGED')
    bank.public_negative_checks()
    print('FH_SYNC68_ROUTE_PREFLIGHT=PASS')
    return original, mode


def reload_caddy() -> None:
    finance.run(['caddy', 'validate', '--config', str(finance.CADDYFILE)],
                error='SYNC_CADDY_VALIDATE_FAILED')
    finance.run(['systemctl', 'reload', 'caddy.service'], error='SYNC_CADDY_RELOAD_FAILED')


def enable(sha: str) -> None:
    if os.environ.get('FH_SYNC68_ROUTES') != 'ENABLE':
        deny('EXPLICIT_SYNC_ENABLE_REQUIRED')
    original, mode = preflight(sha)
    patched = patch_caddy(original)
    finance.write_exclusive(backup_path(sha), original, mode=0o600)
    if finance.secure_file(backup_path(sha), 0, 0o600) != original:
        deny('SYNC_ROLLBACK_BACKUP_MISMATCH')
    try:
        if finance.caddy_snapshot()[0] != original:
            deny('SYNC_CADDY_CONCURRENT_CHANGE')
        finance.atomic_replace(finance.CADDY, patched, mode=mode)
        reload_caddy()
        public_guards()
    except Exception:
        print('FH_SYNC68_ROUTE_ROLLBACK=STARTED')
        try:
            current, _ = finance.caddy_snapshot()
            if current not in (original, patched):
                deny('SYNC_CADDY_CONCURRENT_CHANGE_MANUAL_REVIEW')
            if current != original:
                finance.atomic_replace(finance.CADDY, original, mode=mode)
                reload_caddy()
            print('FH_SYNC68_ROUTE_ROLLBACK=PASS')
        except Exception:
            print('FH_SYNC68_ROUTE_ROLLBACK=MANUAL_REVIEW_REQUIRED')
        raise
    print('FH_SYNC68_ROUTES_ENABLED=PASS')
    print('FH_SYNC68_NO_FINANCIAL_WRITES=YES')


def disable(sha: str) -> None:
    if (os.geteuid() != 0 or os.environ.get('GITHUB_ACTIONS') == 'true' or
            os.environ.get('FH_SYNC68_ROUTES') != 'DISABLE'):
        deny('EXPLICIT_NATIVE_SYNC_DISABLE_REQUIRED')
    original = finance.secure_file(backup_path(sha), 0, 0o600)
    patched = patch_caddy(original)
    current, mode = finance.caddy_snapshot()
    if current != patched:
        deny('SYNC_CADDY_CHANGED_OR_ALREADY_DISABLED')
    finance.atomic_replace(finance.CADDY, original, mode=mode)
    reload_caddy()
    if finance.public_probe(READ) != 404:
        deny('SYNC_ROUTE_STILL_PUBLIC')
    bank.public_negative_checks()
    print('FH_SYNC68_ROUTES_DISABLED=PASS')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sha', required=True)
    choice = parser.add_mutually_exclusive_group(required=True)
    for action in ('preflight', 'enable', 'disable'):
        choice.add_argument('--' + action, action='store_true')
    args = parser.parse_args()
    try:
        if args.preflight:
            preflight(args.sha)
        elif args.enable:
            enable(args.sha)
        else:
            disable(args.sha)
        return 0
    except (Hold, backend.Hold, source.NoGo, finance.NoGo, bank.Hold, legacy.Hold) as exc:
        print('FH_SYNC68_ROUTES=NO_GO')
        print('FAILURE_CODE=' + str(exc))
        return 1
    except Exception:
        print('FH_SYNC68_ROUTES=FAILED')
        print('FAILURE_CODE=UNEXPECTED_RUNTIME')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
