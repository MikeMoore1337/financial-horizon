#!/usr/bin/env python3
"""#69/#70 - update the ALREADY ENABLED personal FH backend, without data changes.

Only replace the source paths in the existing 80-finance-source.conf and
90-finance-runtime.conf, together with the private auth release symlink.
Never run the initial-enable scripts, mutate PostgreSQL/SQLite, change OAuth
configuration, enable import/sync, or edit Caddy. Stage before publishing.

Invocation on the authorized production VPS:
    python3 scripts/fh_finance_active_backend_upgrade.py --sha SHA --preflight
    python3 scripts/fh_finance_active_backend_upgrade.py --sha SHA --stage
    python3 scripts/fh_finance_active_backend_upgrade.py --sha SHA --publish
For an explicitly requested post-release source rollback:
    python3 scripts/fh_finance_active_backend_upgrade.py --sha SHA --rollback
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import time

import fh_finance_auth_source_rollout as source
import fh_finance_private_api_release as finance

REPO = source.REPO
RELEASES = source.RELEASES
CURRENT = source.CURRENT
BACKUPS = source.BACKUPS
SERVICE = source.SERVICE
DROP80 = source.FINANCE_SOURCE_DROPIN
DROP90 = finance.FINANCE_DROPIN
DROP70 = source.OAUTH_DROPIN
HEX = re.compile(r"^[a-f0-9]{40}$")


class Hold(Exception):
    """A controlled refusal, never a reason to disable security."""


def refuse(code: str) -> None:
    raise Hold(code)


def release(sha: str) -> Path:
    if not HEX.fullmatch(sha):
        refuse("EXACT_SHA_INVALID")
    return RELEASES / sha


def protected(path: Path, mode: int) -> bytes:
    try:
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or
                stat.S_IMODE(info.st_mode) != mode or info.st_nlink != 1):
            refuse("PROTECTED_DROPIN_INVALID")
        return path.read_bytes()
    except OSError:
        refuse("PROTECTED_DROPIN_UNAVAILABLE")


def expected_configs(
    old: Path, new: Path, config80: bytes, config90: bytes,
) -> tuple[bytes, bytes]:
    """Accept precisely the two known protected drop-in contracts."""
    if (not HEX.fullmatch(old.name) or not HEX.fullmatch(new.name) or
            old.parent != RELEASES or new.parent != RELEASES or old == new):
        refuse("UNEXPECTED_RELEASE_SOURCE")
    try:
        c80 = config80.decode("ascii")
        c90 = config90.decode("ascii")
    except UnicodeError:
        refuse("DROPIN_NOT_ASCII")
    a80 = c80.splitlines()
    a90 = c90.splitlines()
    previous = str(old)
    if (len(a80) != 5 or a80[0] != "[Service]" or
            a80[1] != "ExecStart=" or
            not a80[2].startswith(
                f"ExecStart={previous}/.finance-venv/bin/python -m uvicorn "
            ) or
            a80[3] != f"WorkingDirectory={previous}/backend" or
            a80[4] != (f'Environment="PYTHONPATH={previous}:'
                         f'{previous}/backend"')):
        refuse("SOURCE_DROPIN_UNKNOWN_LAYOUT")
    launcher_line = (
        f"ExecStart={previous}/.finance-venv/bin/python "
        f"{finance.LAUNCHER_INSTALLED} -- "
    )
    if (len(a90) != 5 or a90[0] != "[Service]" or
            a90[1] != f"EnvironmentFile={finance.FINANCE_ENV}" or
            a90[2] != (
                f"LoadCredential={finance.CREDENTIAL_NAME}:{finance.SECRETS}"
            ) or a90[3] != "ExecStart=" or
            not a90[4].startswith(launcher_line)):
        refuse("FINANCE_DROPIN_UNKNOWN_LAYOUT")
    if (c80.count(previous) != 4 or c90.count(previous) != 1 or
            str(new) in c80 or str(new) in c90):
        refuse("SOURCE_DROPIN_PATH_NOT_UNIQUE")
    # Pinning the original text means the OAuth listener arguments,
    # finance runtime and credential name are preserved verbatim.
    new80 = c80.replace(previous, str(new)).encode("ascii")
    new90 = c90.replace(previous, str(new)).encode("ascii")
    if (previous.encode() in new80 or previous.encode() in new90):
        refuse("OLD_RELEASE_REFERENCE_REMAINS")
    return new80, new90


def check_checkout(sha: str) -> None:
    if os.geteuid() != 0 or os.environ.get("GITHUB_ACTIONS") == "true":
        refuse("AUTHORIZED_PRODUCTION_ROOT_REQUIRED")
    actual = source.checked(
        ["git", "-C", str(REPO), "rev-parse", "HEAD"],
        code="SOURCE_GIT_UNAVAILABLE",
    ).decode().strip()
    if actual != sha:
        refuse("OPS_CHECKOUT_EXACT_SHA_REQUIRED")
    if source.checked(
        ["git", "-C", str(REPO), "status", "--porcelain"],
        code="SOURCE_STATUS_UNAVAILABLE",
    ).strip():
        refuse("OPS_CHECKOUT_DIRTY")
    source.verify_exact_main_ci(sha)


def live_state() -> Path:
    """Require a running personal instance, not a source-only auth service."""
    source.active_services()
    if source.systemd_value("User") != source.USER:
        refuse("SOURCE_RUNTIME_NOT_PERSONAL")
    source.checked(
        ["systemctl", "is-active", "--quiet",
         "fh-finance-personal-backup.timer"],
        code="FINANCE_BACKUP_TIMER_INACTIVE",
    )
    if not (DROP70.is_file() and DROP80.is_file() and DROP90.is_file()):
        refuse("ALL_THREE_PROTECTED_DROPINS_REQUIRED")
    paths = source.systemd_value("DropInPaths").split()
    if any(str(path) not in paths for path in (DROP70, DROP80, DROP90)):
        refuse("LIVE_DROPIN_SET_CHANGED")
    # Validated root-only runtime has immutable personal/v2 ON, import OFF.
    finance.load_runtime()
    live_dir = Path(source.systemd_value("WorkingDirectory"))
    previous = live_dir.parent
    if (live_dir != previous / "backend" or previous.parent != RELEASES or
            not HEX.fullmatch(previous.name) or
            not CURRENT.is_symlink() or
            CURRENT.resolve(strict=True) != previous.resolve(strict=True)):
        refuse("LIVE_AUTH_RELEASE_MISMATCH")
    expected_configs(
        previous, RELEASES / ("a" * 40),
        protected(DROP80, 0o644), protected(DROP90, 0o600),
    )
    finance.auth_provider_baseline()
    finance.enabled_local_smoke()
    if (finance.public_probe("/api/auth/providers") != 200 or
            finance.public_probe("/api/finance/v1/state") != 401 or
            finance.public_probe("/api/finance/v2/commands",
                                 method="POST", origin=finance.ORIGIN) != 401):
        refuse("FINANCE_ORIGIN_ANONYMOUS_GUARD_FAILED")
    return previous


def preflight(sha: str) -> Path:
    check_checkout(sha)
    old = live_state()
    if old == release(sha):
        refuse("BACKEND_SOURCE_ALREADY_CURRENT")
    if RELEASES.is_symlink() or not RELEASES.is_dir():
        refuse("RELEASE_DIRECTORY_NOT_TRUSTED")
    if not (BACKUPS.is_dir() and not BACKUPS.is_symlink() and
            BACKUPS.stat().st_uid == 0 and
            stat.S_IMODE(BACKUPS.stat().st_mode) == 0o700):
        refuse("PRIVATE_BACKUP_DIR_INVALID")
    print("FH_ACTIVE_BACKEND_PREFLIGHT=PASS")
    print("FH_EXISTING_FINANCE_RUNTIME=PRESERVED")
    print("FH_IMPORT_RUNTIME=OFF")
    return old


def stage(sha: str) -> None:
    preflight(sha)
    target = release(sha)
    if target.exists() or target.is_symlink():
        refuse("NEW_RELEASE_ALREADY_EXISTS")
    before = source.source_files(REPO / "backend")
    old_umask = os.umask(0o022)
    created = False
    try:
        target.mkdir(mode=0o755)
        created = True
        shutil.copytree(
            REPO / "backend", target / "backend",
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        python = target / ".finance-venv/bin/python"
        uv = shutil.which("uv")
        if uv:
            source.checked(
                [uv, "venv", "--python", sys.executable,
                 str(target / ".finance-venv")],
                timeout=120, code="ISOLATED_VENV_FAILED",
            )
            source.checked(
                [uv, "pip", "install", "--python", str(python),
                 "--link-mode", "copy", "--no-progress",
                 "-r", str(REPO / "backend/requirements.txt"),
                 "-r", str(REPO / "backend/requirements-finance.txt")],
                timeout=360, code="ISOLATED_DEPENDENCIES_FAILED",
            )
        else:
            source.checked(
                [sys.executable, "-m", "venv", "--copies",
                 str(target / ".finance-venv")],
                timeout=120, code="ISOLATED_VENV_FAILED",
            )
            source.checked(
                [str(python), "-m", "pip", "install", "--no-input",
                 "--disable-pip-version-check", "--require-virtualenv",
                 "-r", str(REPO / "backend/requirements.txt"),
                 "-r", str(REPO / "backend/requirements-finance.txt")],
                timeout=360, code="ISOLATED_DEPENDENCIES_FAILED",
            )
        if source.source_files(target / "backend") != before:
            refuse("STAGED_SOURCE_CHANGED")
        (target / "__finance_source.json").write_text(
            json.dumps({"sha": sha, "source_hashes": before},
                       separators=(",", ":"), sort_keys=True),
            encoding="utf-8",
        )
        source.grant_staged_service_read_access(target)
        source.check_staged_import(
            sha, target, source.verified_staged_python(target),
        )
    except Exception:
        if created and target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        raise
    finally:
        os.umask(old_umask)
    print("FH_ACTIVE_BACKEND_STAGED=PASS")
    print("FH_SERVICE_NOT_RESTARTED=YES")
    print("FH_FINANCE_IMPORT=OFF")


def backup_paths(sha: str) -> tuple[Path, Path]:
    release(sha)  # Validate user-supplied suffix.
    return (BACKUPS / f"fh-active-backend-80-{sha}.bak",
            BACKUPS / f"fh-active-backend-90-{sha}.bak")


def patch_dropins(
    old: Path, target: Path, prior80: bytes, prior90: bytes,
) -> tuple[bytes, bytes]:
    after80, after90 = expected_configs(old, target, prior80, prior90)
    finance.atomic_replace(DROP80, after80, mode=0o644)
    finance.atomic_replace(DROP90, after90, mode=0o600)
    return after80, after90


def restore_service(
    old: Path, target: Path, before80: bytes, before90: bytes,
) -> None:
    """Rollback source-only switch; never restore stale auth or finance DB."""
    finance.atomic_replace(DROP80, before80, mode=0o644)
    finance.atomic_replace(DROP90, before90, mode=0o600)
    now = CURRENT.resolve(strict=True)
    if now == target:
        source.switch_current(target, old)
    elif now != old:
        refuse("ROLLBACK_RELEASE_SYMLINK_CHANGED")
    source.checked(["systemctl", "daemon-reload"],
                   code="ROLLBACK_SYSTEMD_RELOAD_FAILED")
    source.checked(["systemctl", "restart", SERVICE], timeout=45,
                   code="ROLLBACK_AUTH_RESTART_FAILED")
    if live_state() != old:
        refuse("ROLLBACK_WRONG_SOURCE")
    print("FH_ACTIVE_BACKEND_ROLLBACK=PASS")
    print("FH_FINANCIAL_DATA_UNCHANGED=YES")


def publish(sha: str) -> None:
    previous = preflight(sha)
    target, python = source.release_ready(sha)
    source.check_staged_import(sha, target, python)
    prior80 = protected(DROP80, 0o644)
    prior90 = protected(DROP90, 0o600)
    expected_configs(previous, target, prior80, prior90)
    backup80, backup90 = backup_paths(sha)
    if any(p.exists() or p.is_symlink() for p in (backup80, backup90)):
        refuse("BACKEND_BACKUP_ALREADY_EXISTS")
    # A consistent source-only rollback must be available BEFORE the switch.
    source.backup_live_auth_db()
    source.checked(["test", "-r", str(finance.LAUNCHER_INSTALLED)],
                   code="FINANCE_LAUNCHER_UNAVAILABLE")
    finance.write_exclusive(backup80, prior80, mode=0o600)
    finance.write_exclusive(backup90, prior90, mode=0o600)
    try:
        patch_dropins(previous, target, prior80, prior90)
        source.switch_current(previous, target)
        source.checked(["systemctl", "daemon-reload"],
                       code="AUTH_DAEMON_RELOAD_FAILED")
        source.checked(["systemctl", "restart", SERVICE], timeout=45,
                       code="AUTH_BACKEND_RESTART_FAILED")
        deadline = time.monotonic() + 35
        while True:
            try:
                if live_state() != target:
                    refuse("RELEASE_PATH_DIVERGED")
                break
            except Exception:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.5)
        if (protected(DROP80, 0o644) !=
                expected_configs(previous, target, prior80, prior90)[0] or
                protected(DROP90, 0o600) !=
                expected_configs(previous, target, prior80, prior90)[1]):
            refuse("POST_RELEASE_DROPIN_DIVERGED")
    except Exception:
        print("FH_ACTIVE_BACKEND_ROLLBACK=STARTED")
        try:
            restore_service(previous, target, prior80, prior90)
        except Exception:
            print("FH_ACTIVE_BACKEND_ROLLBACK=MANUAL_REVIEW_REQUIRED")
        raise
    print("FH_ACTIVE_BACKEND_PUBLISHED=PASS")
    print("FH_FINANCE_V2=ON")
    print("FH_IMPORT_AND_BACKGROUND_SYNC=OFF")
    print("FH_AUTH_AND_FINANCE_DATA_UNCHANGED=YES")


def rollback(sha: str) -> None:
    # A manual rollback is always scoped to the exact deployed SHA, not main.
    if os.geteuid() != 0:
        refuse("AUTHORIZED_PRODUCTION_ROOT_REQUIRED")
    target = release(sha)
    current = CURRENT.resolve(strict=True)
    if current != target or Path(
        source.systemd_value("WorkingDirectory")
    ) != target / "backend":
        refuse("ROLLBACK_SOURCE_IS_NOT_CURRENT")
    backup80, backup90 = backup_paths(sha)
    originals = (protected(backup80, 0o600), protected(backup90, 0o600))
    try:
        source80 = originals[0].decode("ascii").splitlines()[3]
        if not source80.startswith("WorkingDirectory="):
            refuse("ROLLBACK_ORIGINAL_UNKNOWN")
        old = Path(source80.partition("=")[2]).parent
        expected80, expected90 = expected_configs(
            old, target, originals[0], originals[1],
        )
        if (protected(DROP80, 0o644) != expected80 or
                protected(DROP90, 0o600) != expected90):
            refuse("ROLLBACK_CONCURRENT_DROPIN_CHANGE")
    except UnicodeError:
        refuse("ROLLBACK_BACKUP_CORRUPT")
    restore_service(old, target, *originals)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--sha", required=True)
    m = p.add_mutually_exclusive_group(required=True)
    for action in ("preflight", "stage", "publish", "rollback"):
        m.add_argument("--" + action, action="store_true")
    args = p.parse_args()
    try:
        if args.preflight:
            preflight(args.sha)
        elif args.stage:
            stage(args.sha)
        elif args.publish:
            publish(args.sha)
        else:
            rollback(args.sha)
        return 0
    except (Hold, source.NoGo, finance.NoGo) as exc:
        print("FH_ACTIVE_BACKEND_UPGRADE=NO_GO")
        print("FAILURE_CODE=" + str(exc))
        return 1
    except Exception:
        print("FH_ACTIVE_BACKEND_UPGRADE=FAILED")
        print("FAILURE_CODE=UNEXPECTED_RUNTIME")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
