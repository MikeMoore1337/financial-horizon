#!/usr/bin/env python3
"""#69: replace the exact legacy FH systemd credential launcher, source-only.

The legacy launcher hard-requires FH_FINANCE_IMPORT_RUNTIME=off and crashes
before Uvicorn starts if the owner enables import. This tool upgrades ONLY
that root-owned, auth-group-readable launcher. It never enables import,
changes finance balances, edits OAuth SQLite, restarts systemd or changes
Caddy. The existing service stays active through the replacement.

Native VPS, after exact-main CI is green:
  python3 scripts/fh_finance_personal_launcher_upgrade.py --sha SHA --preflight
  FH_PERSONAL_LAUNCHER_UPGRADE=YES \
    python3 scripts/fh_finance_personal_launcher_upgrade.py --sha SHA --install
"""
from __future__ import annotations

import argparse
from hashlib import sha256
import os
from pathlib import Path
import pwd
import stat
import sys
import tempfile

import fh_finance_personal_import_window as imp
import fh_finance_private_api_release as finance


LEGACY_SHA256 = "4f11c4b73f75eee3f84eac54ae6d083459ca7c3c9f476f7171c025f4dc601cda"
TARGET = finance.LAUNCHER_INSTALLED
SOURCE = finance.LAUNCHER_SOURCE
BACKUPS = finance.BACKUPS


class Hold(Exception):
    pass


def deny(code: str) -> None:
    raise Hold(code)


def receipt_path(sha: str) -> Path:
    imp.verified_sha(sha)
    return BACKUPS / ("fh-finance-launcher-before-import-" + sha + ".bak")


def inspect_existing() -> tuple[bytes, bytes, int, str]:
    """Only the exact original legacy file or the reviewed target is valid."""
    try:
        parent = TARGET.parent.lstat()
        if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0
            or stat.S_IMODE(parent.st_mode) & 0o022):
            deny("LAUNCHER_PARENT_UNTRUSTED")
        source = SOURCE.read_bytes()
        if (len(source) < 800 or len(source) > 16384 or
            b'FH_FINANCE_IMPORT_RUNTIME' not in source or
            b'FINANCE_FLAGS_NOT_EXPLICIT' not in source):
            deny("LAUNCHER_TARGET_SOURCE_UNTRUSTED")
        current = finance.secure_file(TARGET, 0, 0o640)
        service_gid = pwd.getpwnam("fh-email-auth").pw_gid
        if (TARGET.stat().st_gid != service_gid or service_gid == 0):
            deny("LAUNCHER_SERVICE_GROUP_CHANGED")
    except (OSError, KeyError):
        deny("LAUNCHER_TRUSTED_SOURCE_UNAVAILABLE")
    if current == source:
        state = "current"
    elif sha256(current).hexdigest() == LEGACY_SHA256:
        state = "legacy"
    else:
        deny("LAUNCHER_INSTALLED_UNKNOWN_SOURCE")
    return current, source, service_gid, state


def preflight(sha: str) -> tuple[bytes, bytes, int, str, Path]:
    # Use the full established protected service/Caddy/PG/auth preflight.
    # Only the launcher-equality check is skipped until this tool updates it.
    if os.geteuid() != 0 or os.getenv("GITHUB_ACTIONS") == "true":
        deny("PRODUCTION_ROOT_REQUIRED")
    raw, _, _, mode = imp.live_preflight(sha, require_launcher=False)
    if mode != "off" or imp.ON in raw:
        deny("IMPORT_RUNTIME_MUST_BE_OFF")
    before, target, gid, status = inspect_existing()
    receipt = receipt_path(sha)
    if receipt.exists() or receipt.is_symlink():
        if (finance.secure_file(receipt, 0, 0o600) != before and
            status != "current"):
            deny("LAUNCHER_ROLLBACK_RECEIPT_CHANGED")
        # If target is already deployed, retained original must be legacy.
        if status == "current" and sha256(
            finance.secure_file(receipt, 0, 0o600)
        ).hexdigest() != LEGACY_SHA256:
            deny("LAUNCHER_ROLLBACK_RECEIPT_INVALID")
    print("FH_LAUNCHER_UPGRADE_PREFLIGHT=PASS")
    print("FH_LAUNCHER_INSTALLED=" + status.upper())
    print("FH_USER_FINANCE_AND_AUTH_UNCHANGED=YES")
    return before, target, gid, status, receipt


def atomic_install(blob: bytes, gid: int) -> None:
    """Preserve the original 0640 root:fh-email-auth trust model atomically."""
    if not isinstance(blob, bytes) or not 800 <= len(blob) <= 16384:
        deny("LAUNCHER_BYTES_INVALID")
    fd = None
    pending = None
    try:
        fd, pending = tempfile.mkstemp(prefix=".fh-launcher-", dir=TARGET.parent)
        os.fchown(fd, 0, gid)
        os.fchmod(fd, 0o640)
        os.write(fd, blob)
        os.fsync(fd)
        os.close(fd)
        fd = None
        os.replace(pending, TARGET)
        pending = None
        directory_fd = os.open(TARGET.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError:
        deny("LAUNCHER_ATOMIC_INSTALL_FAILED")
    finally:
        if fd is not None:
            os.close(fd)
        if pending is not None and os.path.lexists(pending):
            os.unlink(pending)


def install(sha: str) -> None:
    original, candidate, gid, state, receipt = preflight(sha)
    if state == "current":
        imp.launcher_ready()
        print("FH_LAUNCHER_UPGRADE=ALREADY_CURRENT")
        print("FH_AUTH_SERVICE_NOT_RESTARTED=YES")
        return
    if os.environ.get("FH_PERSONAL_LAUNCHER_UPGRADE") != "YES":
        deny("EXPLICIT_LAUNCHER_APPROVAL_REQUIRED")
    # No current or future server data is read. This backup is ONLY the
    # unmodified legacy program needed to undo an operator-file regression.
    if not (receipt.exists() or receipt.is_symlink()):
        finance.write_exclusive(receipt, original, mode=0o600)
    elif finance.secure_file(receipt, 0, 0o600) != original:
        deny("LAUNCHER_ROLLBACK_RECEIPT_CHANGED")
    try:
        atomic_install(candidate, gid)
        imp.launcher_ready()
        finance.enabled_local_smoke()
        if (finance.public_probe("/api/auth/providers") != 200 or
            finance.public_probe("/api/finance/v1/state") != 401):
            deny("LAUNCHER_POSTINSTALL_ANONYMOUS_SECURITY_FAILED")
    except Exception:
        print("FH_LAUNCHER_UPGRADE_ROLLBACK=STARTED")
        try:
            if finance.secure_file(TARGET, 0, 0o640) != candidate:
                deny("LAUNCHER_CONCURRENT_CHANGE_REQUIRES_MANUAL_REVIEW")
            atomic_install(original, gid)
            if finance.secure_file(TARGET, 0, 0o640) != original:
                deny("LAUNCHER_ROLLBACK_MISMATCH")
            print("FH_LAUNCHER_UPGRADE_ROLLBACK=PASS")
        except Exception:
            print("FH_LAUNCHER_UPGRADE_ROLLBACK=MANUAL_REVIEW_REQUIRED")
        raise
    print("FH_LAUNCHER_UPGRADE=PASS")
    print("FH_AUTH_SERVICE_NOT_RESTARTED=YES")
    print("FH_FINANCE_IMPORT_RUNTIME=OFF")
    print("FH_FINANCIAL_DATA_UNCHANGED=YES")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--preflight", action="store_true")
    actions.add_argument("--install", action="store_true")
    args = parser.parse_args()
    try:
        if args.preflight:
            preflight(args.sha)
        else:
            install(args.sha)
        return 0
    except (Hold, imp.Hold, finance.NoGo) as exc:
        print("FH_LAUNCHER_UPGRADE=NO_GO")
        print("FAILURE_CODE=" + str(exc))
        return 1
    except Exception:
        print("FH_LAUNCHER_UPGRADE=FAILED")
        print("FAILURE_CODE=UNEXPECTED_RUNTIME")
        return 1


if __name__ == "__main__":
    sys.exit(main())
