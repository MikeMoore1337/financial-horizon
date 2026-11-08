#!/usr/bin/env python3
"""Safely switch ONLY the isolated, owner-restricted Financial Horizon OAuth canary.

This is an operator script, not a public OAuth enablement mechanism. It never
changes the production email service, the live SQLite, Caddy, or client secrets.
Tested against the fixed owner-only canary deployed for Financial Horizon #9.
"""
from __future__ import annotations

import argparse
import http.client
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

CANARY_CONFIG = Path('/etc/financial-horizon/oauth-canary.env')
STAGED_CONFIG = Path('/etc/financial-horizon/oauth.env')
EMAIL_CONFIG = Path('/etc/financial-horizon/email-auth.env')
CANARY_UNIT = Path('/etc/systemd/system/fh-oauth-canary.service')
CADDY_SITE = Path('/etc/caddy/sites.d/fin-horizon.mikemoore.top.caddy')
ROOT_ONLY_BACKUPS = Path('/var/backups/financial-horizon')
CANARY_DB = Path('/var/lib/financial-horizon/oauth-canary/auth.sqlite3')
ORIGIN_HOST = 'fin-horizon.mikemoore.top'
CANARY_PORT = 9139
PROVIDERS = ('telegram', 'google', 'yandex', 'vk')
TESTABLE = ('google', 'yandex', 'vk')
DESTINATIONS = {
    'google': 'accounts.google.com',
    'yandex': 'oauth.yandex.ru',
    'vk': 'id.vk.ru',
}

class CheckFailed(RuntimeError):
    """A fail-closed deployment condition was not met."""


def parse_env(raw: str) -> dict[str, str]:
    """Read relevant dotenv keys without printing values or running the file."""
    out = {}
    for row in raw.splitlines():
        line = row.strip()
        if not line or line.startswith('#'):
            continue
        if not re.match(r'^[A-Z][A-Z0-9_]*=', line):
            raise CheckFailed('Unexpected dotenv syntax')
        key, value = line.split('=', 1)
        if key in out:
            raise CheckFailed('Duplicate environment key')
        out[key] = value.strip().strip('"').strip("'")
    return out


def rewrite_flags(original: str, target: str) -> str:
    """Change no other settings, always explicitly disable Telegram."""
    if target not in TESTABLE:
        raise CheckFailed('Provider must be google, yandex or vk')
    current = parse_env(original)
    if current.get('FH_ENABLE_CLOUD_AUTH') != 'true':
        raise CheckFailed('Isolated OAuth canary must already be enabled')
    if current.get('FH_AUTH_DATABASE_PATH') != str(CANARY_DB):
        raise CheckFailed('Canary database path changed')
    output = original
    for name in PROVIDERS:
        key = f'FH_{name.upper()}_OAUTH_ENABLED'
        if current.get(key) not in ('true', 'false'):
            raise CheckFailed('Missing/invalid provider flag')
        pattern = rf'(?m)^{re.escape(key)}=(?:true|false)$'
        if len(re.findall(pattern, output)) != 1:
            raise CheckFailed('Nonunique provider flag')
        output = re.sub(pattern, f'{key}={str(name == target).lower()}', output)
    if parse_env(output) != {**current, **{
        f'FH_{name.upper()}_OAUTH_ENABLED': str(name == target).lower()
        for name in PROVIDERS
    }}:
        raise CheckFailed('Unexpected configuration difference')
    return output


def require_private_file(path: Path) -> str:
    if not path.is_file() or path.is_symlink():
        raise CheckFailed('Required private file missing or linked')
    st = path.stat()
    if st.st_uid != 0 or stat.S_IMODE(st.st_mode) != 0o600:
        raise CheckFailed('Root-only file expected (mode 600)')
    return path.read_text(encoding='utf-8')


def check_static_guards(target: str) -> str:
    if os.geteuid() != 0:
        raise CheckFailed('Root required')
    original = require_private_file(CANARY_CONFIG)
    production = parse_env(require_private_file(STAGED_CONFIG))
    original_values = parse_env(original)
    live_email = parse_env(require_private_file(EMAIL_CONFIG))
    if production.get('FH_ENABLE_CLOUD_AUTH') != 'false':
        raise CheckFailed('Production OAuth flag unexpectedly enabled')
    if any(production.get(f'FH_{n.upper()}_OAUTH_ENABLED') != 'false' for n in PROVIDERS):
        raise CheckFailed('Production provider flag unexpectedly enabled')
    if original_values.get('FH_AUTH_DATABASE_PATH') != str(CANARY_DB):
        raise CheckFailed('Canary points at non-canary database')
    if live_email.get('FH_AUTH_DATABASE_PATH') == str(CANARY_DB):
        raise CheckFailed('Canary and live databases must differ')
    if not CANARY_DB.is_file() or CANARY_DB.is_symlink():
        raise CheckFailed('Isolated test database missing')
    with sqlite3.connect(f'file:{CANARY_DB}?mode=ro', uri=True, timeout=5) as conn:
        if conn.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise CheckFailed('Isolated test database integrity error')
        col = conn.execute('PRAGMA table_info(users)').fetchall()
        if not col or col[1][3] != 0:
            raise CheckFailed('Canary not migrated for OAuth-only accounts')
    id_field = production.get(f'FH_{target.upper()}_OAUTH_CLIENT_ID', '')
    secret_field = production.get(f'FH_{target.upper()}_OAUTH_CLIENT_SECRET', '')
    if len(id_field) < 5 or (target != 'vk' and len(secret_field) < 8):
        raise CheckFailed('Target provider credentials not staged')
    if not CANARY_UNIT.is_file() or CANARY_UNIT.is_symlink():
        raise CheckFailed('Canary systemd unit missing')
    unit = CANARY_UNIT.read_text(encoding='utf-8')
    for expected in (
        'User=fh-email-auth',
        'ExecStart=',
        '--host 127.0.0.1 --port 9139',
        'EnvironmentFile=/etc/financial-horizon/oauth-canary.env',
    ):
        if expected not in unit:
            raise CheckFailed('Unrecognized canary service configuration')
    if not CADDY_SITE.is_file() or CADDY_SITE.is_symlink():
        raise CheckFailed('Caddy site config missing')
    site = CADDY_SITE.read_text(encoding='utf-8')
    for expected in ('@owner_oauth_canary', '@any_oauth_canary',
                     'remote_ip ', 'header CF-Connecting-IP ',
                     'reverse_proxy 127.0.0.1:9139', 'respond "Forbidden" 403'):
        if expected not in site:
            raise CheckFailed('Owner-only reverse-proxy gate not verified')
    if (not ROOT_ONLY_BACKUPS.is_dir() or ROOT_ONLY_BACKUPS.is_symlink() or
            ROOT_ONLY_BACKUPS.stat().st_uid != 0 or
            stat.S_IMODE(ROOT_ONLY_BACKUPS.stat().st_mode) != 0o700):
        raise CheckFailed('Root-only backup directory missing')
    for name in ('caddy.service', 'fh-email-auth.service', 'fh-oauth-canary.service'):
        subprocess.run(['systemctl', 'is-active', '--quiet', name],
                       check=True, timeout=12, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
    return original


def request(path: str) -> tuple[int, dict[str, str], bytes]:
    conn = http.client.HTTPConnection('127.0.0.1', CANARY_PORT, timeout=5)
    try:
        conn.request('GET', path, headers={'Host': ORIGIN_HOST,
                                            'Cache-Control': 'no-store'})
        resp = conn.getresponse()
        status = resp.status
        headers = {k.lower(): v for k, v in resp.getheaders()}
        body = resp.read(8192)
        return status, headers, body
    finally:
        conn.close()


def ready(target: str, *, wait_seconds: float) -> None:
    deadline = time.monotonic() + wait_seconds
    while True:
        try:
            status, headers, body = request('/api/auth/providers')
            doc = json.loads(body)
            if (status == 200 and doc.get('enabled') is True and
                    doc.get('providers') == [target]):
                return
        except (OSError, TimeoutError, ValueError, json.JSONDecodeError):
            pass
        if time.monotonic() >= deadline:
            raise CheckFailed('Canary readiness/provider list did not match')
        time.sleep(0.25)


def verify_target(target: str) -> None:
    ready(target, wait_seconds=25)
    status, headers, _ = request(f'/api/auth/oauth/{target}/start')
    redirect = urlsplit(headers.get('location', ''))
    if status != 303 or redirect.scheme != 'https' or redirect.hostname != DESTINATIONS[target]:
        raise CheckFailed('Selected provider start redirect unexpected')
    status, _, _ = request('/api/auth/oauth/telegram/start')
    if status != 404:
        raise CheckFailed('Telegram is still enabled in test canary')
    for other in TESTABLE:
        if other != target:
            status, _, _ = request(f'/api/auth/oauth/{other}/start')
            if status != 404:
                raise CheckFailed('More than one provider is active')


def atomic_replace(path: Path, body: str) -> None:
    candidate = path.with_name(path.name + '.oauth-switch-tmp')
    fd = os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            out.write(body)
            out.flush()
            os.fsync(out.fileno())
        os.replace(candidate, path)
    finally:
        candidate.unlink(missing_ok=True)


def restart() -> None:
    subprocess.run(['systemctl', 'restart', 'fh-oauth-canary.service'],
                   check=True, timeout=35, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)


def write_private_backup(target: str, contents: str) -> Path:
    """Create a new root-only backup on EVERY switch; never overwrite an older one."""
    fd, filename = tempfile.mkstemp(
        prefix=f'oauth-canary-env-before-{target}-switch-',
        suffix='.env', dir=ROOT_ONLY_BACKUPS,
    )
    path = Path(filename)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            out.write(contents)
            out.flush()
            os.fsync(out.fileno())
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        path.unlink(missing_ok=True)
        raise
    return path


def preflight(target: str) -> None:
    """Read-only precondition check, no environment edits or service restarts."""
    before = check_static_guards(target)
    current = [p for p in PROVIDERS if parse_env(before).get(
        f'FH_{p.upper()}_OAUTH_ENABLED') == 'true']
    if len(current) != 1:
        raise CheckFailed('Expected exactly one enabled test provider')
    print('CANARY_PREFLIGHT=PASS')
    print('CURRENT_PROVIDER=' + current[0])
    print('TARGET_PROVIDER=' + target)
    print('BACKUP_POLICY=UNIQUE_PER_SWITCH')


def switch(target: str) -> None:
    before = check_static_guards(target)
    old = parse_env(before)
    previous = [n for n in PROVIDERS
                if old.get(f'FH_{n.upper()}_OAUTH_ENABLED') == 'true']
    if len(previous) != 1:
        raise CheckFailed('Expected exactly one enabled test provider')
    after = rewrite_flags(before, target)
    if after == before:
        verify_target(target)
        print('CANARY_SWITCH=ALREADY_ACTIVE')
        return
    write_private_backup(target, before)
    atomic_replace(CANARY_CONFIG, after)
    try:
        restart()
        verify_target(target)
        subprocess.run(['systemctl', 'is-active', '--quiet', 'fh-email-auth.service'],
                       check=True, timeout=12)
    except BaseException:
        restored = False
        try:
            atomic_replace(CANARY_CONFIG, before)
            restart()
            ready(previous[0], wait_seconds=30)
            restored = True
        except BaseException:
            pass
        print('CANARY_SWITCH=FAILED')
        print('ROLLBACK=' + ('PASS' if restored else 'UNCONFIRMED'))
        raise CheckFailed('Isolated canary switch failed; do not test OAuth') from None
    print('CANARY_SWITCH=PASS')
    print('SELECTED_PROVIDER=' + target)
    print('TELEGRAM_CANARY_DISABLED=YES')
    print('OTHER_PROVIDERS_DISABLED=YES')
    print('ISOLATED_SQLITE_IN_USE=YES')
    print('PRODUCTION_AUTH_AND_CADDY_UNCHANGED=YES')
    print('SECRETS_AND_TOKENS_PRINTED=NO')
    print('REAL_OAUTH_LOGIN=NOT_YET_VERIFIED')


# Only known, constant reasons are rendered. Never print private env values.
SAFE_FAILURE_CODES = {
    'Target provider credentials not staged': 'TARGET_CREDENTIALS_NOT_STAGED',
    'Production OAuth flag unexpectedly enabled': 'PRODUCTION_OAUTH_FLAG_CHANGED',
    'Production provider flag unexpectedly enabled': 'PRODUCTION_PROVIDER_FLAG_CHANGED',
    'Canary points at non-canary database': 'CANARY_DATABASE_PATH_CHANGED',
    'Canary and live databases must differ': 'DATABASE_ISOLATION_FAILED',
    'Isolated test database integrity error': 'CANARY_DATABASE_INTEGRITY_FAILED',
    'Canary not migrated for OAuth-only accounts': 'CANARY_SCHEMA_NOT_READY',
    'Root-only backup directory missing': 'BACKUP_DIRECTORY_NOT_PRIVATE',
    'Unrecognized canary service configuration': 'CANARY_UNIT_CHANGED',
    'Owner-only reverse-proxy gate not verified': 'CADDY_OWNER_GATE_CHANGED',
    'Expected exactly one enabled test provider': 'INVALID_CURRENT_PROVIDER_SELECTION',
    'Missing/invalid provider flag': 'INVALID_PROVIDER_FLAGS',
    'Isolated OAuth canary must already be enabled': 'CANARY_NOT_ENABLED',
    'Canary readiness/provider list did not match': 'CANARY_READINESS_FAILED',
    'Selected provider start redirect unexpected': 'PROVIDER_START_REDIRECT_FAILED',
    'Isolated canary switch failed; do not test OAuth': 'SWITCH_ROLLBACK_REQUIRED',
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--provider', choices=TESTABLE, required=True)
    parser.add_argument('--preflight', action='store_true',
                        help='Read-only validation; do not switch the provider')
    args = parser.parse_args()
    try:
        if args.preflight:
            preflight(args.provider)
        else:
            switch(args.provider)
    except (CheckFailed, OSError, subprocess.SubprocessError, sqlite3.Error) as exc:
        # Never print untrusted exception messages, files, credentials or stderr.
        print('CANARY_PRECONDITION_OR_SWITCH=FAILED')
        print('FAILURE_TYPE=' + type(exc).__name__)
        if isinstance(exc, CheckFailed):
            print('FAILURE_CODE=' + SAFE_FAILURE_CODES.get(str(exc), 'OTHER_CHECK_FAILED'))
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
