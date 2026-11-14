#!/usr/bin/env python3
"""#69: temporary owner-confirmed import window on ALREADY ACTIVE personal FH.

A bounded production operator action, not a general finance migration tool.
No endpoint is mounted unless the existing private FH AuthStore + PostgreSQL
v2 runtime is active. This script never submits a financial command/import,
reads the user's finance values, changes PostgreSQL, or edits IndexedDB.

After external-backup + independent-browser-restore are owner-accepted:
  python3 scripts/fh_finance_personal_import_window.py --sha SHA --preflight
  FH_PERSONAL_IMPORT_WINDOW=ENABLE python3 scripts/fh_finance_personal_import_window.py --sha SHA --enable
After the owner finishes one import, close the write surface:
  FH_PERSONAL_IMPORT_WINDOW=DISABLE python3 scripts/fh_finance_personal_import_window.py --sha SHA --disable

Only three exact same-origin POST paths are published. If anything diverges,
the action refuses or restores its own runtime/Caddy changes. Static UI is a
separate reviewed release and remains independently gated.
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
import fh_finance_private_api_release as finance


IMPORT_ROUTING = (
    "    @fh_personal_import_write {\n"
    "        method POST\n"
    "        path /api/finance/v1/import/manifest /api/finance/v1/import/commit /api/finance/v1/import/restore\n"
    "    }\n"
    "    handle @fh_personal_import_write {\n"
    "        reverse_proxy 127.0.0.1:9138\n"
    "    }\n"
)
OFF = b"FH_FINANCE_IMPORT_RUNTIME=off\n"
ON = b"FH_FINANCE_IMPORT_RUNTIME=on\n"
BACKUP_PREFIX = "fh-personal-import-window-"
LAST_SOURCE = backend.CURRENT
CADDY = finance.CADDY
RUNTIME = finance.FINANCE_ENV
BACKUPS = source.BACKUPS
SERVICE = finance.SERVICE


class Hold(Exception):
    pass


def deny(reason: str) -> None:
    raise Hold(reason)


def verified_sha(sha: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        deny("INVALID_SHA")
    return sha


def backup_paths(sha: str) -> tuple[Path, Path]:
    verified_sha(sha)
    return (BACKUPS / f"{BACKUP_PREFIX}{sha}.runtime.bak",
            BACKUPS / f"{BACKUP_PREFIX}{sha}.caddy.bak")


def checked_runtime(raw: bytes) -> tuple[str, bytes]:
    """Reuse previously accepted personal flags; vary only import off/on."""
    if type(raw) is not bytes or len(raw) > 4096:
        deny("RUNTIME_ENV_UNKNOWN")
    if raw.count(OFF) == 1 and ON not in raw:
        mode, normalized = "off", raw
    elif raw.count(ON) == 1 and OFF not in raw:
        mode, normalized = "on", raw.replace(ON, OFF, 1)
    else:
        deny("RUNTIME_IMPORT_FLAG_AMBIGUOUS")
    try:
        config = finance.parse_runtime(normalized.decode("ascii"))
    except (UnicodeError, finance.NoGo):
        deny("RUNTIME_ENV_UNTRUSTED")
    if config["FH_FINANCE_RUNTIME_MODE"] != "personal" or (
        config["FH_FINANCE_V2_RUNTIME"] != "on"
    ):
        deny("FINANCE_PERSONAL_V2_REQUIRED")
    return mode, normalized


def _named_caddy_block(text: str, name: str) -> tuple[tuple[str, ...], ...]:
    """Read exactly one simple Caddy named matcher/handle, not nearby blocks.

    Match statements by their actual anchored name (not substring counts:
    '@fh_finance_read {' appears inside 'handle @fh_finance_read {').
    Existing finance blocks may be separated by other valid Caddy rules.
    Never accept additional methods, paths, directives or proxy targets.
    """
    pattern = re.compile(r"(?m)^[ \t]*" + re.escape(name) + r"[ \t]*\{")
    found = list(pattern.finditer(text))
    if len(found) != 1:
        deny("CADDY_FINANCE_BLOCK_MISSING_OR_DUPLICATE")
    opening = found[0].end()
    # Existing approved named matchers/handlers are flat. Nested Caddy
    # subroutes are NOT silently accepted by this migration.
    closing = text.find("}", opening)
    if closing < 0 or "{" in text[opening:closing]:
        deny("CADDY_FINANCE_BLOCK_NESTED_OR_UNCLOSED")
    end_line = text.find("\n", closing)
    if end_line < 0:
        end_line = len(text)
    if text[closing + 1:end_line].strip().lstrip("#").strip():
        deny("CADDY_FINANCE_BLOCK_TRAILING_CONTENT")
    lines = []
    for line in text[opening:closing].splitlines():
        # Only simple exact directives, no unrelated directives or quotes.
        directive = line.split("#", 1)[0].strip()
        if directive:
            lines.append(tuple(directive.split()))
    return tuple(lines)


def _require_existing_finance_routes(text: str) -> None:
    required = (
        ("@fh_finance_read", {
            ("method", "GET"),
            ("path", "/api/finance/v1/state", "/api/finance/v1/changes"),
        }),
        ("@fh_finance_write", {
            ("method", "POST"),
            ("path", "/api/auth/email/finance/session",
             "/api/finance/v1/commands", "/api/finance/v2/commands"),
        }),
        ("handle @fh_finance_read", {
            ("reverse_proxy", "127.0.0.1:9138"),
        }),
        ("handle @fh_finance_write", {
            ("reverse_proxy", "127.0.0.1:9138"),
        }),
    )
    for name, expected in required:
        found = _named_caddy_block(text, name)
        if len(found) != len(expected) or set(found) != expected:
            deny("CADDY_FINANCE_BLOCK_UNEXPECTED_DIRECTIVES")


def caddy_import_patch(original: bytes) -> bytes:
    """Append exact import POST handler without rewriting live finance/OAuth.

    The old release's finance read/write blocks are validated individually:
    their byte-contiguous layout is not a security requirement. Other site
    rules may be interleaved. The entire existing site remains byte-for-byte
    unchanged except for inserting our small known import-only allowlist.
    """
    if type(original) is not bytes or len(original) > 256_000:
        deny("CADDY_BYTES_INVALID")
    try:
        text = original.decode("utf-8")
    except UnicodeError:
        deny("CADDY_ENCODING_INVALID")
    if (text.count(finance.CADDY_MARKER) != 1 or
        "@fh_personal_import_write" in text or
        "/api/finance/v1/import/" in text):
        deny("CADDY_FINANCE_LAYOUT_UNRECOGNIZED")
    _require_existing_finance_routes(text)
    # Same stable insertion anchor as the original private OAuth/finance
    # routing rollout. Never add a wildcard route or alter existing handlers.
    return text.replace(finance.CADDY_MARKER,
                        IMPORT_ROUTING + finance.CADDY_MARKER, 1).encode("utf-8")


def trusted_runtime_file() -> bytes:
    return finance.secure_file(RUNTIME, 0, 0o600)


def current_source() -> Path:
    working = Path(source.systemd_value("WorkingDirectory"))
    if (working.name != "backend" or working.parent.parent != source.RELEASES or
        not working.is_dir() or working.is_symlink() or
        not LAST_SOURCE.is_symlink() or
        working.parent.resolve(strict=True) != LAST_SOURCE.resolve(strict=True)):
        deny("BACKEND_SOURCE_NOT_RELEASED")
    return working


def live_preflight(sha: str) -> tuple[bytes, bytes, int, str]:
    """Must be read-only. Verify current main, CI, OAuth, PWA/finance guard."""
    verified_sha(sha)
    if os.geteuid() != 0 or os.getenv("GITHUB_ACTIONS") == "true":
        deny("AUTHORIZED_PRODUCTION_ROOT_ONLY")
    backend.check_checkout(sha)
    source.active_services()
    cwd = current_source()
    if source.source_files(cwd) != source.source_files(source.REPO / "backend"):
        deny("BACKEND_FINANCE_SOURCE_DRIFT")
    if not (source.OAUTH_DROPIN.is_file() and backend.DROP80.is_file()
            and backend.DROP90.is_file()):
        deny("REQUIRED_FINANCE_DROPINS_MISSING")
    # The existing 70/80/90 contract remains untouched during import window.
    release = cwd.parent
    backend.expected_configs(
        release, source.RELEASES / ("a" * 40),
        backend.protected(backend.DROP80, 0o644),
        backend.protected(backend.DROP90, 0o600),
    )
    finance.enabled_local_smoke()
    if (finance.public_probe("/api/auth/providers") != 200 or
        finance.public_probe("/api/finance/v1/state") != 401 or
        finance.public_probe("/api/finance/v2/commands",
                             method="POST", origin=finance.ORIGIN) != 401):
        deny("EXISTING_PUBLIC_AUTH_FINANCE_GUARD_FAILED")
    raw = trusted_runtime_file()
    mode, _ = checked_runtime(raw)
    caddy, chmod = finance.caddy_snapshot()
    if mode == "off":
        caddy_import_patch(caddy)
        if finance.local_probe(
            "/api/finance/v1/import/manifest", method="POST",
            origin=finance.ORIGIN,
        ) != 404:
            deny("IMPORT_ALREADY_MOUNTED_WITH_FLAG_OFF")
    else:
        b_runtime, b_caddy = backup_paths(sha)
        original_runtime = finance.secure_file(b_runtime, 0, 0o600)
        original_caddy = finance.secure_file(b_caddy, 0, 0o600)
        previous, _ = checked_runtime(original_runtime)
        if (previous != "off" or
            original_runtime.replace(OFF, ON, 1) != raw or
            caddy_import_patch(original_caddy) != caddy):
            deny("IMPORT_WINDOW_RECEIPT_OR_CONFIGURATION_MISMATCH")
        if finance.local_probe(
            "/api/finance/v1/import/manifest",
            method="POST", origin=finance.ORIGIN,
        ) != 401:
            deny("IMPORT_LOCAL_ANONYMOUS_AUTH_GUARD_FAILED")
    if (not BACKUPS.is_dir() or BACKUPS.is_symlink() or
        BACKUPS.stat().st_uid != 0 or
        (BACKUPS.stat().st_mode & 0o777) != 0o700):
        deny("BACKUP_DIRECTORY_UNTRUSTED")
    print("FH_IMPORT_WINDOW_PREFLIGHT=PASS")
    print("FH_IMPORT_RUNTIME_BEFORE=" + mode.upper())
    print("FH_FINANCIAL_DATA_UNCHANGED=YES")
    return raw, caddy, chmod, mode


def verify_enabled() -> None:
    if (finance.local_probe("/api/auth/providers") != 200 or
        finance.local_probe("/api/finance/v1/state") != 401 or
        finance.local_probe("/api/finance/v2/commands",
                            method="POST", origin=finance.ORIGIN) != 401):
        deny("EXISTING_LOCAL_FINANCE_FAILED")
    for path in ("manifest", "commit", "restore"):
        endpoint = "/api/finance/v1/import/" + path
        if (finance.local_probe(endpoint, method="POST",
                                origin=finance.ORIGIN) != 401 or
            finance.public_probe(endpoint, method="POST",
                                 origin=finance.ORIGIN) != 401 or
            finance.public_probe(endpoint, method="POST",
                                 origin="https://untrusted.example") != 403):
            deny("IMPORT_PUBLIC_DENY_ANONYMOUS_OR_CSRF_FAILED")
    if finance.public_probe("/api/auth/providers") != 200:
        deny("OAUTH_ORIGIN_FAILED")


def restart_auth() -> None:
    # Only auth Uvicorn; never PostgreSQL, backup.timer or Caddy.
    finance.run(["systemctl", "restart", SERVICE], timeout=45,
                error="AUTH_RESTART_FAILED")
    deadline = time.monotonic() + 30
    while True:
        try:
            finance.enabled_local_smoke()
            return
        except finance.NoGo:
            if time.monotonic() >= deadline:
                raise
            time.sleep(.5)


def restore_before_enable(raw: bytes, caddy: bytes, mode: int) -> None:
    # Restore only our source toggles, never financial or auth DB snapshots.
    finance.atomic_replace(CADDY, caddy, mode=mode)
    finance.run(["caddy", "validate", "--config", str(finance.CADDYFILE)],
                error="CADDY_RESTORE_VALIDATE_FAILED")
    finance.run(["systemctl", "reload", "caddy.service"],
                error="CADDY_RESTORE_RELOAD_FAILED")
    finance.atomic_replace(RUNTIME, raw, mode=0o600)
    restart_auth()
    if finance.local_probe("/api/finance/v1/import/manifest",
                           method="POST", origin=finance.ORIGIN) != 404:
        deny("IMPORT_ROUTE_REMAINS_ACTIVE_AFTER_ROLLBACK")
    print("FH_IMPORT_WINDOW_ROLLBACK=PASS")


def enable(sha: str) -> None:
    raw, caddy, caddy_mode, mode = live_preflight(sha)
    if mode != "off":
        deny("IMPORT_WINDOW_ALREADY_ENABLED")
    backup_runtime, backup_caddy = backup_paths(sha)
    if any(p.exists() or p.is_symlink() for p in (backup_runtime, backup_caddy)):
        deny("IMPORT_WINDOW_BACKUP_ALREADY_EXISTS")
    new_caddy = caddy_import_patch(caddy)
    new_runtime = raw.replace(OFF, ON, 1)
    checked_runtime(new_runtime)
    if os.environ.get("FH_PERSONAL_IMPORT_WINDOW") != "ENABLE":
        deny("EXPLICIT_OWNER_ENABLE_REQUIRED")
    # Revalidate latest main & exact tests immediately before the write gate.
    backend.check_checkout(sha)
    source.backup_live_auth_db()
    finance.write_exclusive(backup_runtime, raw, mode=0o600)
    finance.write_exclusive(backup_caddy, caddy, mode=0o600)
    try:
        finance.atomic_replace(RUNTIME, new_runtime, mode=0o600)
        restart_auth()
        # Route must be mounted locally, but not yet published through Caddy.
        if finance.local_probe(
            "/api/finance/v1/import/manifest", method="POST",
            origin=finance.ORIGIN,
        ) != 401:
            deny("IMPORT_LOCAL_AUTH_GUARD_FAILED")
        before, _ = finance.caddy_snapshot()
        if before != caddy:
            deny("CADDY_CHANGED_DURING_IMPORT_ENABLE")
        finance.atomic_replace(CADDY, new_caddy, mode=caddy_mode)
        finance.run(["caddy", "validate", "--config", str(finance.CADDYFILE)],
                    error="IMPORT_CADDY_VALIDATION_FAILED")
        finance.run(["systemctl", "reload", "caddy.service"],
                    error="IMPORT_CADDY_RELOAD_FAILED")
        verify_enabled()
    except Exception:
        print("FH_IMPORT_WINDOW_ROLLBACK=STARTED")
        try:
            latest, _ = finance.caddy_snapshot()
            if latest not in (caddy, new_caddy):
                deny("CADDY_CONCURRENT_CHANGE_REQUIRES_REVIEW")
            restore_before_enable(raw, caddy, caddy_mode)
        except Exception:
            print("FH_IMPORT_WINDOW_ROLLBACK=MANUAL_REVIEW_REQUIRED")
        raise
    print("FH_IMPORT_WINDOW_BACKEND=ENABLED")
    print("FH_IMPORT_ANONYMOUS_AND_CSRF_DENY=PASS")
    print("FH_IMPORT_WINDOW_FINANCIAL_WRITE=NOT_PERFORMED")
    print("FH_IMPORT_FRONTEND=INDEPENDENTLY_GATED")


def disable(sha: str) -> None:
    # Emergency closure must work even if main moved while the owner imports.
    verified_sha(sha)
    if (os.geteuid() != 0 or os.getenv("GITHUB_ACTIONS") == "true" or
        os.getenv("FH_PERSONAL_IMPORT_WINDOW") != "DISABLE"):
        deny("EXPLICIT_PRODUCTION_DISABLE_REQUIRED")
    original_runtime_path, original_caddy_path = backup_paths(sha)
    old_runtime = finance.secure_file(original_runtime_path, 0, 0o600)
    old_caddy = finance.secure_file(original_caddy_path, 0, 0o600)
    before, _ = checked_runtime(old_runtime)
    if before != "off":
        deny("IMPORT_BACKUP_NOT_ORIGINAL_OFF")
    now = trusted_runtime_file()
    mode, _ = checked_runtime(now)
    if mode != "on" or now != old_runtime.replace(OFF, ON, 1):
        deny("IMPORT_RUNTIME_ALREADY_DISABLED_OR_CHANGED")
    current, caddy_mode = finance.caddy_snapshot()
    if current != caddy_import_patch(old_caddy):
        deny("CADDY_CONCURRENT_CHANGE_REQUIRES_REVIEW")
    # Close PUBLIC import routes FIRST. A failed backend restart must never
    # leave private financial import POST paths reachable from the internet.
    finance.atomic_replace(CADDY, old_caddy, mode=caddy_mode)
    finance.run(["caddy", "validate", "--config", str(finance.CADDYFILE)],
                error="IMPORT_DISABLE_CADDY_INVALID")
    finance.run(["systemctl", "reload", "caddy.service"],
                error="IMPORT_DISABLE_CADDY_RELOAD_FAILED")
    finance.atomic_replace(RUNTIME, old_runtime, mode=0o600)
    restart_auth()
    if finance.local_probe(
        "/api/finance/v1/import/manifest", method="POST",
        origin=finance.ORIGIN,
    ) != 404:
        deny("IMPORT_STILL_MOUNTED_AFTER_DISABLE")
    finance.enabled_local_smoke()
    print("FH_IMPORT_WINDOW_BACKEND=DISABLED")
    print("FH_IMPORT_PUBLIC_ROUTES=REMOVED")
    print("FH_IMPORT_USER_FINANCIAL_DATA_UNCHANGED_BY_TOGGLE=YES")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--preflight", action="store_true")
    action.add_argument("--enable", action="store_true")
    action.add_argument("--disable", action="store_true")
    args = parser.parse_args()
    try:
        if args.preflight:
            live_preflight(args.sha)
        elif args.enable:
            enable(args.sha)
        else:
            disable(args.sha)
        return 0
    except (Hold, finance.NoGo, source.NoGo, backend.Hold) as exc:
        print("FH_IMPORT_WINDOW=NO_GO")
        print("FAILURE_CODE=" + str(exc))
        return 1
    except Exception:
        print("FH_IMPORT_WINDOW=FAILED")
        print("FAILURE_CODE=UNEXPECTED_RUNTIME")
        return 1


if __name__ == "__main__":
    sys.exit(main())
