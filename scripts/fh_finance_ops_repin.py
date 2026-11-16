#!/usr/bin/env python3
"""#66: safely advance the personal PostgreSQL systemd source SHA after an auth-only release.

The initialized DB, encryption keys, Docker container, backup jobs and auth
service remain untouched. Needed because personal-start.sh requires the source
SHA in root-only start.env to match the checked-out main HEAD on reboot.

Never use this as a substitute for a database/schema code upgrade.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from urllib.request import Request, urlopen

REPO = Path("/opt/financial-horizon-ops")
START = Path("/etc/financial-horizon/finance/start.env")
BACKUP_ROOT = Path("/var/backups/financial-horizon-finance")
DATA = "/srv/financial-horizon-finance/pgdata"
CHECKOUT = str(REPO)
REQUIRED = frozenset({"app-tests", "finance-postgres", "email-auth-tests", "e2e-real-browser"})


class NoGo(ValueError):
    pass


def deny(reason: str):
    raise NoGo(reason)


def command(*args: str, timeout: int = 15) -> str:
    try:
        result = subprocess.run(
            list(args), capture_output=True, text=True,
            timeout=timeout, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        deny("READ_ONLY_COMMAND_UNAVAILABLE")
    if result.returncode:
        deny("READ_ONLY_COMMAND_FAILED")
    return result.stdout.strip()


def private_text(path: Path) -> str:
    try:
        meta = path.lstat()
        if (not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0
            or stat.S_IMODE(meta.st_mode) != 0o600 or meta.st_nlink != 1):
            deny("START_ENV_NOT_ROOT_PRIVATE")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            raw = os.read(fd, 4096)
            if len(raw) >= 4096:
                deny("START_ENV_TOO_LARGE")
            return raw.decode("ascii")
        finally:
            os.close(fd)
    except (OSError, UnicodeError):
        deny("START_ENV_UNREADABLE")


def parse_start(raw: str) -> dict[str, str]:
    values = {}
    for line in raw.splitlines():
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*=[A-Za-z0-9_./-]+", line):
            deny("START_ENV_UNEXPECTED_FORMAT")
        key, _, value = line.partition("=")
        if key in values:
            deny("START_ENV_DUPLICATE_KEY")
        values[key] = value
    if set(values) != {
        "FH_FINANCE_PERSONAL_MODE", "FH_FINANCE_APPROVED_SHA",
        "FH_FINANCE_DATA_DIR", "FH_FINANCE_CHECKOUT_DIR"
    }:
        deny("START_ENV_UNEXPECTED_KEYS")
    if (values["FH_FINANCE_PERSONAL_MODE"] != "YES"
        or values["FH_FINANCE_DATA_DIR"] != DATA
        or values["FH_FINANCE_CHECKOUT_DIR"] != CHECKOUT
        or not re.fullmatch(r"[0-9a-f]{40}", values["FH_FINANCE_APPROVED_SHA"])):
        deny("START_ENV_UNEXPECTED_VALUES")
    return values


def github_json(path: str) -> dict:
    request = Request(
        "https://api.github.com/repos/MikeMoore1337/financial-horizon/" + path,
        headers={"Accept": "application/vnd.github+json",
                 "User-Agent": "fh-finance-personal-ops-pin"},
    )
    try:
        with urlopen(request, timeout=15) as response:
            data = response.read(1024 * 1024 + 1)
        result = json.loads(data)
    except (OSError, ValueError):
        deny("GITHUB_ATTESTATION_UNAVAILABLE")
    if len(data) > 1024 * 1024 or not isinstance(result, dict):
        deny("GITHUB_ATTESTATION_INVALID")
    return result


def verify_exact_ci(sha: str) -> None:
    try:
        if github_json("branches/main")["commit"]["sha"] != sha:
            deny("SHA_NOT_CURRENT_MAIN")
        runs = github_json("actions/runs?head_sha=" + sha
                           + "&event=push&per_page=50")["workflow_runs"]
        for run in runs:
            if (run.get("name") != "tests" or run.get("head_sha") != sha
                or run.get("status") != "completed"
                or run.get("conclusion") != "success"):
                continue
            jobs = github_json("actions/runs/" + str(run["id"]) + "/jobs?per_page=100")["jobs"]
            passing = {j.get("name") for j in jobs if j.get("conclusion") == "success"}
            if REQUIRED.issubset(passing):
                return
    except (KeyError, TypeError):
        deny("GITHUB_ATTESTATION_INVALID")
    deny("CURRENT_MAIN_CI_NOT_COMPLETE")


def verify_source_unchanged(old_sha: str, new_sha: str) -> None:
    if old_sha == new_sha:
        return
    if not re.fullmatch(r"[0-9a-f]{40}", old_sha + ""):
        deny("UNTRUSTED_ORIGINAL_SHA")
    command("git", "-C", CHECKOUT, "cat-file", "-e", old_sha + "^{commit}")
    command("git", "-C", CHECKOUT, "merge-base", "--is-ancestor", old_sha, new_sha)
    # The database-service code and migrations must be byte-for-byte
    # unchanged across the source update. No implicit schema upgrade.
    output = subprocess.run(
        ["git", "-C", CHECKOUT, "diff", "--quiet",
         old_sha, new_sha, "--", "deploy/postgres"],
        capture_output=True, timeout=15, check=False,
    )
    if output.returncode != 0:
        deny("POSTGRES_RUNTIME_CHANGED_REQUIRES_SEPARATE_REVIEW")


def validate(sha: str) -> tuple[str, str]:
    if (os.geteuid() != 0 or os.environ.get("GITHUB_ACTIONS") == "true"
        or not re.fullmatch(r"[0-9a-f]{40}", sha)):
        deny("EXPLICIT_PRODUCTION_ROOT_AND_SHA_REQUIRED")
    if command("git", "-C", CHECKOUT, "rev-parse", "HEAD") != sha:
        deny("CHECKOUT_SHA_MISMATCH")
    if command("git", "-C", CHECKOUT, "status", "--porcelain"):
        deny("CHECKOUT_DIRTY")
    remote = command("git", "-C", CHECKOUT, "remote", "get-url", "origin")
    if remote not in {
        "https://github.com/MikeMoore1337/financial-horizon.git",
        "https://github.com/MikeMoore1337/financial-horizon",
        "git@github.com:MikeMoore1337/financial-horizon.git",
    }:
        deny("UNEXPECTED_REPOSITORY")
    verify_exact_ci(sha)
    old_raw = private_text(START)
    old_sha = parse_start(old_raw)["FH_FINANCE_APPROVED_SHA"]
    verify_source_unchanged(old_sha, sha)
    for unit in ("fh-finance-personal.service", "fh-finance-personal-backup.timer",
                 "fh-email-auth.service", "caddy.service"):
        if command("systemctl", "is-active", unit) != "active":
            deny("REQUIRED_SYSTEMD_UNIT_INACTIVE")
    if command("systemctl", "show", "fh-finance-personal-backup.service",
               "-p", "Result", "--value") != "success":
        deny("LAST_ENCRYPTED_BACKUP_UNSUCCESSFUL")
    if command("docker", "inspect", "--format",
               "{{.State.Health.Status}}", "fh-finance-postgres") != "healthy":
        deny("POSTGRES_NOT_HEALTHY")
    if command("docker", "port", "fh-finance-postgres", "5432/tcp") != (
        "127.0.0.1:54329"
    ):
        deny("POSTGRES_NOT_LOOPBACK_ONLY")
    if (BACKUP_ROOT.is_symlink() or not BACKUP_ROOT.is_dir()
        or BACKUP_ROOT.stat().st_uid != 0
        or stat.S_IMODE(BACKUP_ROOT.stat().st_mode) != 0o700):
        deny("PRIVATE_BACKUP_DIRECTORY_MISSING")
    return old_raw, old_sha


def atomically_repin(sha: str, old_raw: str, old_sha: str) -> None:
    if old_sha == sha:
        print("FINANCE_OPS_SHA_PIN=ALREADY_CURRENT")
        return
    marker = "FH_FINANCE_APPROVED_SHA=" + old_sha
    if old_raw.count(marker) != 1:
        deny("START_ENV_SHA_AMBIGUOUS")
    new_raw = old_raw.replace(marker, "FH_FINANCE_APPROVED_SHA=" + sha, 1)
    if parse_start(new_raw)["FH_FINANCE_APPROVED_SHA"] != sha:
        deny("START_ENV_NEW_SHA_INVALID")

    backup = BACKUP_ROOT / ("fh-finance-ops-start-" + old_sha + ".env.bak")
    try:
        fd = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        try:
            os.fchmod(fd, 0o600)
            os.write(fd, old_raw.encode("ascii"))
            os.fsync(fd)
        finally:
            os.close(fd)
    except (FileExistsError, OSError):
        deny("OPS_START_BACKUP_ALREADY_EXISTS_OR_UNAVAILABLE")
    print("FINANCE_OPS_PREVIOUS_CONFIG_BACKUP=PASS")

    tempname = None
    try:
        fd, tempname = tempfile.mkstemp(prefix=".start-env-new-", dir=START.parent)
        try:
            os.fchmod(fd, 0o600)
            os.write(fd, new_raw.encode("ascii"))
            os.fsync(fd)
        finally:
            os.close(fd)
        # Do not overwrite if an independent process altered config.
        if private_text(START) != old_raw:
            deny("START_ENV_CHANGED_DURING_REPIN")
        os.replace(tempname, START)
        dir_fd = os.open(START.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        if tempname and os.path.exists(tempname):
            os.unlink(tempname)
    if parse_start(private_text(START))["FH_FINANCE_APPROVED_SHA"] != sha:
        deny("START_ENV_REPIN_READBACK_FAILED")
    print("FINANCE_OPS_SHA_PIN=PASS")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    opts = parser.add_mutually_exclusive_group(required=True)
    opts.add_argument("--preflight", action="store_true")
    opts.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        old_raw, old_sha = validate(args.sha)
        print("FINANCE_OPS_EXACT_SHA_CI=PASS")
        print("FINANCE_POSTGRES_CODE_UNCHANGED=PASS")
        print("FINANCE_OPS_ORIGINAL_PIN=" + ("CURRENT" if old_sha == args.sha else "STALE"))
        if args.apply:
            if os.environ.get("FH_FINANCE_PERSONAL_OPS_REPIN") != "YES":
                deny("EXPLICIT_OPS_PIN_APPROVAL_REQUIRED")
            atomically_repin(args.sha, old_raw, old_sha)
        else:
            print("FINANCE_OPS_PREFLIGHT=PASS")
            print("FINANCE_OPS_CONFIG_UNCHANGED=YES")
        print("FINANCE_DATABASE_AND_AUTH_UNCHANGED=YES")
        return 0
    except NoGo as exc:
        print("FINANCE_OPS_REPIN=NO_GO")
        print("FAILURE_CODE=" + str(exc))
        return 1
    except Exception:
        print("FINANCE_OPS_REPIN=FAILED")
        print("FAILURE_CODE=UNEXPECTED_RUNTIME")
        return 1


if __name__ == "__main__":
    sys.exit(main())
