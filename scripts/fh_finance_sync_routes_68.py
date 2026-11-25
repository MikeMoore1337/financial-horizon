#!/usr/bin/env python3
"""Publish only the #68 recovery/cancellation routes; preserve existing services.

Run on the trusted production host, after exact-main CI and backend rollout:
  python3 scripts/fh_finance_sync_routes_68.py --sha SHA --preflight
  FH_SYNC68_ROUTES=ENABLE python3 scripts/fh_finance_sync_routes_68.py --sha SHA --enable
  FH_SYNC68_OWNER=ENABLE python3 scripts/fh_finance_sync_routes_68.py --sha SHA --activate-owner
  FH_SYNC68_OWNER=DISABLE python3 scripts/fh_finance_sync_routes_68.py --sha SHA --deactivate-owner
  FH_SYNC68_ROUTES=DISABLE python3 scripts/fh_finance_sync_routes_68.py --sha SHA --disable

The owner step restarts only the auth service to load a private systemd
credential. No finance command, account change or database migration is
performed. On failures, restore exact prior state unless it changed concurrently.
For rollback, deactivate the owner first, close sync routes second, then use
the existing backend/static rollback procedure. Bank #38 rollback also requires
sync routes to be closed first so its original Caddy bytes match exactly.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import re
import stat
import sqlite3
from contextlib import closing

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
OWNER_SECRET = finance.SECRETS.parent / 'sync68_actor'
OWNER_DROPIN = Path('/etc/systemd/system/fh-email-auth.service.d/96-sync68-owner.conf')
AUTH_DATA_ROOT = Path('/var/lib/financial-horizon')
OWNER_UNIT = (
    '[Service]\n'
    'LoadCredential=fh_sync68_actor:/etc/financial-horizon/finance/secrets/sync68_actor\n'
    'Environment=FH_FINANCE_SYNC_CREDENTIAL=on\n'
).encode('ascii')


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


def backend_ready(sha: str) -> None:
    backup_path(sha)
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


def preflight(sha: str) -> tuple[bytes, int]:
    target = backup_path(sha)
    backend_ready(sha)
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


def enabled_route_preflight(sha: str) -> None:
    backend_ready(sha)
    original = finance.secure_file(backup_path(sha), 0, 0o600)
    current, _ = finance.caddy_snapshot()
    if current != patch_caddy(original):
        deny('SYNC_PUBLIC_ROUTES_NOT_EXACT')
    public_guards()


def reload_caddy() -> None:
    finance.run(['caddy', 'validate', '--config', str(finance.CADDYFILE)],
                error='SYNC_CADDY_VALIDATE_FAILED')
    finance.run(['systemctl', 'reload', 'caddy.service'], error='SYNC_CADDY_RELOAD_FAILED')


def live_environment() -> dict[bytes, bytes]:
    pid = source.systemd_value('MainPID')
    if not pid.isdecimal() or int(pid) <= 1:
        deny('SYNC_AUTH_PROCESS_UNAVAILABLE')
    try:
        raw = (Path('/proc') / pid / 'environ').read_bytes()
    except OSError:
        deny('SYNC_AUTH_ENV_UNAVAILABLE')
    return dict(item.split(b'=', 1) for item in raw.split(b'\0') if b'=' in item)


def unique_google_actor() -> bytes:
    """Read one owner-selected Google identity without printing identifiers."""
    env = live_environment()
    try:
        db = Path(env.get(b'FH_AUTH_DATABASE_PATH', b'/var/lib/financial-horizon/auth.sqlite3').decode('utf-8')).resolve(strict=True)
        if not db.is_file() or not db.is_relative_to(AUTH_DATA_ROOT):
            deny('SYNC_AUTH_DB_PATH_UNTRUSTED')
        with closing(sqlite3.connect(db.as_uri() + '?mode=ro', uri=True, timeout=5)) as connection:
            rows = connection.execute(
                'SELECT DISTINCT u.id FROM users u JOIN oauth_identities oi ON oi.user_id=u.id '
                'WHERE u.disabled=0 AND oi.provider=? LIMIT 2', ('google',),
            ).fetchall()
    except (OSError, UnicodeError, sqlite3.Error):
        deny('SYNC_GOOGLE_ACTOR_LOOKUP_FAILED')
    if len(rows) != 1 or not isinstance(rows[0][0], str) or not re.fullmatch(r'[a-f0-9]{32}', rows[0][0]):
        deny('SYNC_GOOGLE_ACTOR_NOT_UNIQUE')
    return rows[0][0].encode('ascii')


def restart_auth() -> None:
    finance.run(['systemctl', 'daemon-reload'], error='SYNC_SYSTEMD_RELOAD_FAILED')
    bank.restart_auth()


def check_owner_directories() -> None:
    for directory in (OWNER_SECRET.parent, OWNER_DROPIN.parent):
        if (directory.is_symlink() or not directory.is_dir() or directory.stat().st_uid != 0 or
                stat.S_IMODE(directory.stat().st_mode) & 0o022):
            deny('SYNC_OWNER_DIRECTORY_UNTRUSTED')


def activate_owner(sha: str) -> None:
    if os.environ.get('FH_SYNC68_OWNER') != 'ENABLE':
        deny('EXPLICIT_OWNER_ENABLE_REQUIRED')
    enabled_route_preflight(sha)
    actor = unique_google_actor()
    check_owner_directories()
    if (OWNER_SECRET.exists() or OWNER_SECRET.is_symlink() or
            OWNER_DROPIN.exists() or OWNER_DROPIN.is_symlink() or
            live_environment().get(b'FH_FINANCE_SYNC_CREDENTIAL', b'off') != b'off'):
        deny('SYNC_OWNER_STATE_NOT_EMPTY')
    source.backup_live_auth_db()
    secret_created = dropin_created = False
    try:
        finance.write_exclusive(OWNER_SECRET, actor, mode=0o600)
        secret_created = True
        if finance.secure_file(OWNER_SECRET, 0, 0o600) != actor:
            deny('SYNC_OWNER_CREDENTIAL_WRITE_FAILED')
        finance.write_exclusive(OWNER_DROPIN, OWNER_UNIT, mode=0o644)
        dropin_created = True
        if finance.secure_file(OWNER_DROPIN, 0, 0o644) != OWNER_UNIT:
            deny('SYNC_OWNER_DROPIN_WRITE_FAILED')
        restart_auth()
        if (backend.live_state() != source.RELEASES / sha or
                live_environment().get(b'FH_FINANCE_SYNC_CREDENTIAL') != b'on' or
                unique_google_actor() != actor):
            deny('SYNC_OWNER_POSTCHECK_FAILED')
        owner_ready()
        bank.postgres_ready()
        public_guards()
    except Exception:
        print('FH_SYNC68_OWNER_ROLLBACK=STARTED')
        try:
            if dropin_created:
                if finance.secure_file(OWNER_DROPIN, 0, 0o644) != OWNER_UNIT:
                    deny('SYNC_OWNER_DROPIN_CONCURRENT_CHANGE')
                OWNER_DROPIN.unlink()
            if secret_created:
                if finance.secure_file(OWNER_SECRET, 0, 0o600) != actor:
                    deny('SYNC_OWNER_CREDENTIAL_CONCURRENT_CHANGE')
                OWNER_SECRET.unlink()
            if dropin_created:
                restart_auth()
            print('FH_SYNC68_OWNER_ROLLBACK=PASS')
        except Exception:
            print('FH_SYNC68_OWNER_ROLLBACK=MANUAL_REVIEW_REQUIRED')
        raise
    print('FH_SYNC68_OWNER_ACTIVATED=PASS')
    print('FH_SYNC68_NO_FINANCIAL_WRITES=YES')


def deactivate_owner(sha: str) -> None:
    backup_path(sha)
    if (os.geteuid() != 0 or os.environ.get('GITHUB_ACTIONS') == 'true' or
            os.environ.get('FH_SYNC68_OWNER') != 'DISABLE'):
        deny('EXPLICIT_NATIVE_OWNER_DISABLE_REQUIRED')
    original = finance.secure_file(backup_path(sha), 0, 0o600)
    current, _ = finance.caddy_snapshot()
    if current not in (original, patch_caddy(original)):
        deny('SYNC_CADDY_CHANGED_MANUAL_REVIEW')
    if finance.secure_file(OWNER_DROPIN, 0, 0o644) != OWNER_UNIT:
        deny('SYNC_OWNER_DROPIN_CHANGED')
    actor = finance.secure_file(OWNER_SECRET, 0, 0o600)
    if not re.fullmatch(rb'[a-f0-9]{32}', actor):
        deny('SYNC_OWNER_CREDENTIAL_INVALID')
    try:
        OWNER_DROPIN.unlink()
        OWNER_SECRET.unlink()
        restart_auth()
        if live_environment().get(b'FH_FINANCE_SYNC_CREDENTIAL', b'off') != b'off':
            deny('SYNC_OWNER_STILL_ENABLED')
        bank.public_negative_checks()
    except Exception:
        print('FH_SYNC68_OWNER_DEACTIVATION_ROLLBACK=STARTED')
        try:
            if OWNER_SECRET.exists() or OWNER_SECRET.is_symlink():
                if finance.secure_file(OWNER_SECRET, 0, 0o600) != actor:
                    deny('SYNC_OWNER_CREDENTIAL_CONCURRENT_CHANGE')
            else:
                finance.write_exclusive(OWNER_SECRET, actor, mode=0o600)
            if OWNER_DROPIN.exists() or OWNER_DROPIN.is_symlink():
                if finance.secure_file(OWNER_DROPIN, 0, 0o644) != OWNER_UNIT:
                    deny('SYNC_OWNER_DROPIN_CONCURRENT_CHANGE')
            else:
                finance.write_exclusive(OWNER_DROPIN, OWNER_UNIT, mode=0o644)
            restart_auth()
            print('FH_SYNC68_OWNER_DEACTIVATION_ROLLBACK=PASS')
        except Exception:
            print('FH_SYNC68_OWNER_DEACTIVATION_ROLLBACK=MANUAL_REVIEW_REQUIRED')
        raise
    print('FH_SYNC68_OWNER_DEACTIVATED=PASS')


def owner_ready() -> None:
    if (finance.secure_file(OWNER_DROPIN, 0, 0o644) != OWNER_UNIT or
            finance.secure_file(OWNER_SECRET, 0, 0o600) != unique_google_actor() or
            live_environment().get(b'FH_FINANCE_SYNC_CREDENTIAL') != b'on'):
        deny('SYNC_OWNER_NOT_READY')


def enable(sha: str) -> None:
    if os.environ.get('FH_SYNC68_ROUTES') != 'ENABLE':
        deny('EXPLICIT_SYNC_ENABLE_REQUIRED')
    original, mode = preflight(sha)
    if (OWNER_SECRET.exists() or OWNER_SECRET.is_symlink() or
            OWNER_DROPIN.exists() or OWNER_DROPIN.is_symlink() or
            live_environment().get(b'FH_FINANCE_SYNC_CREDENTIAL', b'off') != b'off'):
        deny('SYNC_OWNER_MUST_BE_DISABLED_WHEN_OPENING_ROUTES')
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
    if (OWNER_SECRET.exists() or OWNER_SECRET.is_symlink() or
            OWNER_DROPIN.exists() or OWNER_DROPIN.is_symlink() or
            live_environment().get(b'FH_FINANCE_SYNC_CREDENTIAL', b'off') != b'off'):
        deny('SYNC_OWNER_MUST_BE_DISABLED_FIRST')
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
    for action in ('preflight', 'enable', 'disable', 'activate-owner', 'deactivate-owner'):
        choice.add_argument('--' + action, action='store_true')
    args = parser.parse_args()
    try:
        if args.preflight:
            preflight(args.sha)
        elif args.enable:
            enable(args.sha)
        elif args.disable:
            disable(args.sha)
        elif args.activate_owner:
            activate_owner(args.sha)
        else:
            deactivate_owner(args.sha)
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
