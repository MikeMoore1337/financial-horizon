#!/usr/bin/env python3
"""#33/#70: preserve strong finance revision ETags across Caddy and Cloudflare.

A real owner-authenticated HTTPS smoke showed a strong origin finance ETag
arriving as W/"..." at the browser during response compression. This
operator-only patch adds no-transform to ONLY the two existing finance Caddy
reverse_proxy handlers. It never modifies the ETag or bypasses If-Match.

On native FH VPS:
  --preflight  validate the exact pinned main/CI and recognized Caddy routes
  --apply      backup, patch, caddy validate/reload, anonymous HTTPS smoke
  --verify     verify patch, protected HTTPS and preserved OAuth
  --rollback   explicitly restore exact original Caddy config from backup

No PostgreSQL restart, auth restart, financial write, UI flag or secret output.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import os
from pathlib import Path
import re
import socket
import ssl
import stat
import sys

from fh_finance_private_api_release import (
    BACKUPS, CADDY, CADDYFILE, CA_CERT, CA_SHA, HOST,
    NoGo, auth_provider_baseline, caddy_snapshot, current_sha,
    deny, atomic_replace, public_probe, run, secure_file, write_exclusive,
)

BACKUP = BACKUPS / "fh-finance-etag-caddy-original.bak"
OLD_READ = (
    "    handle @fh_finance_read {\n"
    "        reverse_proxy 127.0.0.1:9138\n"
    "    }\n"
)
OLD_WRITE = (
    "    handle @fh_finance_write {\n"
    "        reverse_proxy 127.0.0.1:9138\n"
    "    }\n"
)
# "no-transform" prevents Caddy and Cloudflare from re-encoding finance
# representations and weakening the revision ETag. Keep private/no-store.
HEADER = '            header_down Cache-Control "private, no-store, no-transform"\n'
NEW_READ = (
    "    handle @fh_finance_read {\n"
    "        reverse_proxy 127.0.0.1:9138 {\n"
    + HEADER +
    "        }\n"
    "    }\n"
)
NEW_WRITE = (
    "    handle @fh_finance_write {\n"
    "        reverse_proxy 127.0.0.1:9138 {\n"
    + HEADER +
    "        }\n"
    "    }\n"
)


def patch(original: bytes) -> bytes:
    try:
        source = original.decode("utf-8")
    except UnicodeDecodeError:
        deny("CADDY_SITE_NOT_UTF8")
    if (source.count(OLD_READ) != 1 or source.count(OLD_WRITE) != 1
        or source.count("    handle @fh_oauth_live_get {") != 1
        or source.count("    handle @fh_oauth_live_post {") != 1
        or source.count("    @fh_finance_read {") != 1
        or source.count("    @fh_finance_write {") != 1
        or 'header_down Cache-Control "private, no-store, no-transform"' in source):
        deny("CADDY_FINANCE_ROUTING_UNRECOGNIZED")
    result = source.replace(OLD_READ, NEW_READ, 1).replace(OLD_WRITE, NEW_WRITE, 1)
    if result.replace(NEW_READ, OLD_READ, 1).replace(NEW_WRITE, OLD_WRITE, 1) != source:
        deny("CADDY_PATCH_NOT_REVERSIBLE")
    return result.encode("utf-8")


def trusted_origin_headers() -> tuple[int, dict[str, str]]:
    """Inspect only anonymous HTTPS response metadata, never financial JSON."""
    try:
        if hashlib.sha256(CA_CERT.read_bytes()).hexdigest() != CA_SHA:
            deny("ORIGIN_TLS_TRUST_ANCHOR_CHANGED")
        context = ssl.create_default_context(cafile=str(CA_CERT))
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        with socket.create_connection(("127.0.0.1", 8444), timeout=6) as sock:
            with context.wrap_socket(sock, server_hostname=HOST) as tls:
                request = (
                    "GET /api/finance/v1/state HTTP/1.1\r\n"
                    f"Host: {HOST}\r\n"
                    "Accept-Encoding: gzip, br\r\n"
                    "Cache-Control: no-store\r\n"
                    "Connection: close\r\n\r\n"
                )
                tls.sendall(request.encode("ascii"))
                response = http.client.HTTPResponse(tls)
                response.begin()
                # Discard at most the small anonymous JSON; never print it.
                response.read(2048)
                return response.status, {
                    key.lower(): value for key, value in response.getheaders()
                }
    except (OSError, ssl.SSLError, http.client.HTTPException, ValueError):
        deny("ORIGIN_HTTPS_METADATA_UNAVAILABLE")


def check_anonymous(status: int) -> None:
    if status != 401:
        deny("ANONYMOUS_FINANCE_ACCESS_NOT_DENIED")


def verify_headers() -> None:
    status, headers = trusted_origin_headers()
    check_anonymous(status)
    directives = {part.strip().lower()
                  for part in headers.get("cache-control", "").split(",")}
    if not {"private", "no-store", "no-transform"} <= directives:
        deny("FINANCE_NO_TRANSFORM_HEADER_MISSING")
    for path in ("/api/finance/v1/changes", "/api/finance/v1/state"):
        check_anonymous(public_probe(path))
    if public_probe("/api/auth/providers") != 200:
        deny("OAUTH_PUBLIC_ROUTE_REGRESSED")
    auth_provider_baseline()


def read_only_gate(sha: str) -> tuple[bytes, int, bytes]:
    current_sha(sha)  # Exact current main + CI + installed PostgreSQL SHA.
    if (not BACKUPS.is_dir() or BACKUPS.is_symlink()
        or BACKUPS.stat().st_uid != 0
        or stat.S_IMODE(BACKUPS.stat().st_mode) != 0o700):
        deny("PRIVATE_BACKUP_DIRECTORY_UNSAFE")
    before, mode = caddy_snapshot()
    if not 0 < len(before) <= 256_000:
        deny("CADDY_SOURCE_SIZE_UNSAFE")
    expected = patch(before)
    check_anonymous(public_probe("/api/finance/v1/state"))
    check_anonymous(public_probe("/api/finance/v1/changes"))
    if public_probe("/api/auth/providers") != 200:
        deny("OAUTH_PUBLIC_ROUTE_REGRESSED")
    return before, mode, expected


def validate_and_reload() -> None:
    run(["caddy", "validate", "--config", str(CADDYFILE)],
        error="CADDY_VALIDATE_FAILED")
    run(["systemctl", "reload", "caddy.service"], error="CADDY_RELOAD_FAILED")


def restore_on_failure(original: bytes, patched: bytes, mode: int) -> None:
    print("FINANCE_ETAG_ROLLBACK=STARTED")
    try:
        current, _ = caddy_snapshot()
        if current != patched:
            deny("CADDY_CHANGED_CONCURRENTLY")
        atomic_replace(CADDY, original, mode=mode)
        validate_and_reload()
        if public_probe("/api/auth/providers") != 200:
            deny("RESTORED_OAUTH_NOT_READY")
        check_anonymous(public_probe("/api/finance/v1/state"))
        print("FINANCE_ETAG_ROLLBACK=PASS")
    except Exception:
        print("FINANCE_ETAG_ROLLBACK=FAILED_MANUAL_REVIEW_REQUIRED")
        raise


def apply(sha: str) -> None:
    before, mode, after = read_only_gate(sha)
    if BACKUP.exists() or BACKUP.is_symlink():
        if secure_file(BACKUP, 0, 0o600) != before:
            deny("ETAG_ORIGINAL_BACKUP_MISMATCH")
    else:
        write_exclusive(BACKUP, before)
    try:
        atomic_replace(CADDY, after, mode=mode)
        validate_and_reload()
        verify_headers()
    except Exception:
        restore_on_failure(before, after, mode)
        raise
    print("FINANCE_ETAG_NO_TRANSFORM=PASS")
    print("FINANCE_ETAG_ORIGIN_HTTPS=PASS")
    print("FINANCE_ETAG_OAUTH_PRESERVED=PASS")
    print("FINANCE_ETAG_CADDY_ONLY=PASS")


def verify(sha: str) -> None:
    current_sha(sha)
    before = secure_file(BACKUP, 0, 0o600)
    expected = patch(before)
    actual, _ = caddy_snapshot()
    if actual != expected:
        deny("CADDY_ETAG_PATCH_DIVERGED")
    verify_headers()
    print("FINANCE_ETAG_NO_TRANSFORM=PASS")
    print("FINANCE_ETAG_ORIGIN_HTTPS=PASS")
    print("FINANCE_ETAG_CADDY_ONLY=PASS")


def rollback(sha: str) -> None:
    if os.environ.get("FH_FINANCE_ETAG_ROLLBACK") != "YES":
        deny("EXPLICIT_ROLLBACK_REQUIRED")
    current_sha(sha)
    original = secure_file(BACKUP, 0, 0o600)
    expected = patch(original)
    now, mode = caddy_snapshot()
    if now != expected:
        deny("CADDY_ETAG_PATCH_DIVERGED")
    atomic_replace(CADDY, original, mode=mode)
    validate_and_reload()
    if public_probe("/api/auth/providers") != 200:
        deny("RESTORED_OAUTH_NOT_READY")
    check_anonymous(public_probe("/api/finance/v1/state"))
    print("FINANCE_ETAG_ROLLBACK=PASS")
    print("FINANCE_DATABASE_UNCHANGED=YES")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    for arg in ("preflight", "apply", "verify", "rollback"):
        mode.add_argument("--" + arg, action="store_true")
    args = parser.parse_args()
    try:
        if not re.fullmatch(r"[0-9a-f]{40}", args.sha):
            deny("EXACT_MAIN_SHA_REQUIRED")
        if os.geteuid() != 0 or os.environ.get("GITHUB_ACTIONS") == "true":
            deny("AUTHORIZED_NATIVE_ROOT_REQUIRED")
        if args.preflight:
            read_only_gate(args.sha)
            print("FINANCE_ETAG_PREFLIGHT=PASS")
            print("PRODUCTION_CADDY_UNCHANGED=YES")
        elif args.apply:
            apply(args.sha)
        elif args.verify:
            verify(args.sha)
        else:
            rollback(args.sha)
        return 0
    except NoGo as exc:
        print("FINANCE_ETAG_RELEASE=NO_GO")
        print("FAILURE_CODE=" + str(exc))
        return 1
    except Exception:
        print("FINANCE_ETAG_RELEASE=FAILED")
        print("FAILURE_CODE=UNEXPECTED_RUNTIME")
        return 1


if __name__ == "__main__":
    sys.exit(main())
