#!/usr/bin/env python3
"""#66/#70 - guarded auth backend source upgrade for the PERSONAL finance mode.

This intentionally does NOT enable finance routes, touch the SQLite schema,
change OAuth settings, modify Caddy or import any financial data.

Run on the real authorized FH production VPS only. Stage first with
--stage; after reviewing the stage-only receipts, opt in with --apply.
The source switch is a new systemd drop-in above the existing 70-oauth.conf,
which is preserved verbatim. A failing readiness check restores the prior
systemd configuration without restoring a stale SQLite snapshot.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import http.client
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote
from urllib.request import Request, urlopen

from fh_oauth_production_release import safe_uvicorn_argv

REPO = Path("/opt/financial-horizon-ops")
RELEASES = Path("/opt/financial-horizon-auth/releases")
CURRENT = Path("/opt/financial-horizon-auth/current")
BACKUPS = Path("/var/backups/financial-horizon")
DROPIN_DIR = Path("/etc/systemd/system/fh-email-auth.service.d")
OAUTH_DROPIN = DROPIN_DIR / "70-oauth.conf"
FINANCE_SOURCE_DROPIN = DROPIN_DIR / "80-finance-source.conf"
SERVICE = "fh-email-auth.service"
USER = "fh-email-auth"
ORIGIN_HOST = "fin-horizon.mikemoore.top"
REQUIRED_JOBS = frozenset({
    "finance-postgres", "app-tests", "email-auth-tests", "e2e-real-browser"
})
PACKAGES = ("fh_email_auth", "fh_auth", "finance_db", "finance_api")


class NoGo(Exception):
    pass


def deny(reason: str) -> None:
    raise NoGo(reason)


def checked(args: list[str], *, cwd: Path | None = None,
            timeout: int = 30, env: dict[str, str] | None = None,
            as_user: bool = False, code: str = "COMMAND_FAILED") -> bytes:
    identity = {}
    if as_user:
        account = pwd.getpwnam(USER)
        if account.pw_uid == 0 or account.pw_gid == 0:
            deny("SERVICE_USER_PRIVILEGED")
        identity = {"user": account.pw_uid, "group": account.pw_gid, "extra_groups": []}
    try:
        result = subprocess.run(
            args, cwd=cwd, env=env, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, timeout=timeout, check=False, **identity,
        )
    except (OSError, subprocess.TimeoutExpired, ValueError):
        deny(code)
    if result.returncode != 0:
        # stdout/stderr may contain private runtime paths or credentials.
        deny(code)
    return result.stdout


def systemd_value(prop: str) -> str:
    return checked(["systemctl", "show", SERVICE, "-p", prop, "--value"],
                   code="SERVICE_METADATA_UNAVAILABLE").decode().strip()


def assert_private(path: Path, mode: int) -> None:
    if path.is_symlink() or not path.is_file():
        deny("PRIVATE_FILE_NOT_REGULAR")
    data = path.stat()
    if data.st_uid != 0 or stat.S_IMODE(data.st_mode) != mode:
        deny("PRIVATE_FILE_PERMISSIONS")


def active_services() -> None:
    for service in (SERVICE, "fh-finance-personal.service", "caddy.service"):
        checked(["systemctl", "is-active", "--quiet", service],
                code="REQUIRED_SERVICE_UNAVAILABLE")


def versioned_sha(sha: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        deny("EXACT_COMMIT_SHA_REQUIRED")
    return sha


def get_json(path: str) -> dict:
    url = "https://api.github.com/repos/MikeMoore1337/financial-horizon/" + path
    request = Request(url, headers={
        "User-Agent": "fh-finance-personal-backend-release",
        "Accept": "application/vnd.github+json",
    })
    try:
        with urlopen(request, timeout=12) as response:
            content = response.read(1024 * 1024 + 1)
        value = json.loads(content)
    except (OSError, ValueError, TimeoutError):
        deny("GITHUB_ATTESTATION_UNAVAILABLE")
    if len(content) > 1024 * 1024 or not isinstance(value, dict):
        deny("GITHUB_ATTESTATION_INVALID")
    return value


def verify_exact_main_ci(sha: str) -> None:
    if get_json("branches/main")["commit"]["sha"] != sha:
        deny("RELEASE_NOT_CURRENT_MAIN")
    runs = get_json(f"actions/runs?head_sha={sha}&event=push&per_page=50")
    for run in runs.get("workflow_runs", []):
        if (run.get("name") == "tests" and run.get("head_sha") == sha and
            run.get("status") == "completed" and run.get("conclusion") == "success"):
            jobs = get_json(f"actions/runs/{run['id']}/jobs?per_page=100")
            successful = {j["name"] for j in jobs.get("jobs", [])
                          if j.get("conclusion") == "success"}
            if REQUIRED_JOBS.issubset(successful):
                return
    deny("RELEASE_MAIN_CI_NOT_SUCCESSFUL")


def safe_process() -> tuple[list[str], dict[str, str]]:
    pid = systemd_value("MainPID")
    if not pid.isdecimal() or int(pid) <= 1:
        deny("AUTH_PROCESS_NOT_RUNNING")
    proc = Path(f"/proc/{pid}")
    try:
        args = [part.decode("utf-8") for part in
                (proc / "cmdline").read_bytes().split(b"\0") if part]
        env_rows = (proc / "environ").read_bytes().split(b"\0")
        env = {}
        for row in env_rows:
            if b"=" in row:
                k, _, v = row.partition(b"=")
                env[k.decode("utf-8")] = v.decode("utf-8")
        return args, env
    except (OSError, UnicodeError):
        deny("LIVE_AUTH_PROCESS_UNREADABLE")


def parsed_port(args: list[str]) -> int:
    values = [args[i + 1] for i, a in enumerate(args[:-1]) if a == "--port"]
    values += [a.partition("=")[2] for a in args if a.startswith("--port=")]
    if len(values) != 1 or not values[0].isdigit():
        deny("LIVE_AUTH_PORT_AMBIGUOUS")
    port = int(values[0])
    if port < 1024 or port > 65535 or port == 54329:
        deny("LIVE_AUTH_PORT_UNSAFE")
    return port


def auth_status(port: int, path: str) -> tuple[int, dict]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request("GET", path, headers={"Host": ORIGIN_HOST, "Cache-Control": "no-store"})
        response = conn.getresponse()
        data = response.read(8193)
        if len(data) > 8192:
            deny("LIVE_AUTH_RESPONSE_TOO_LARGE")
        obj = json.loads(data)
        if not isinstance(obj, dict):
            deny("LIVE_AUTH_RESPONSE_UNEXPECTED")
        return response.status, obj
    except (OSError, http.client.HTTPException, ValueError):
        deny("LIVE_AUTH_RESPONSE_UNAVAILABLE")
    finally:
        conn.close()


def auth_baseline(port: int) -> tuple[str, ...]:
    status, data = auth_status(port, "/api/auth/providers")
    providers = data.get("providers")
    if (status != 200 or data.get("enabled") is not True or
        not isinstance(providers, list) or
        any(not isinstance(p, str) for p in providers)):
        deny("LIVE_OAUTH_PROVIDERS_INVALID")
    if set(providers) != {"google", "yandex", "vk", "telegram"} or len(providers) != 4:
        deny("FOUR_OAUTH_PROVIDERS_NOT_ACTIVE")
    status, data = auth_status(port, "/api/auth/email/me")
    if status != 200 or data.get("authenticated") is not False:
        deny("ANONYMOUS_AUTH_BASELINE_FAILED")
    return tuple(sorted(providers))


def finance_still_off(port: int) -> None:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request("GET", "/api/finance/v1/state",
                     headers={"Host": ORIGIN_HOST, "Cache-Control": "no-store"})
        response = conn.getresponse()
        response.read(2048)
        if response.status != 404:
            deny("FINANCE_RUNTIME_MUST_REMAIN_OFF")
    except (OSError, http.client.HTTPException):
        deny("FINANCE_ROUTE_GUARD_UNAVAILABLE")
    finally:
        conn.close()


def release_path(sha: str) -> Path:
    return RELEASES / sha


def source_files(root: Path) -> dict[str, str]:
    if root.is_symlink() or not root.is_dir():
        deny("BACKEND_SOURCE_DIRECTORY_MISSING")
    listing: dict[str, str] = {}
    for pkg in PACKAGES:
        path = root / pkg
        if not path.is_dir() or path.is_symlink():
            deny("BACKEND_SOURCE_PACKAGE_MISSING")
        for candidate in path.rglob("*"):
            if candidate.is_symlink():
                deny("SYMLINK_IN_BACKEND_SOURCE")
            if candidate.is_file() and (
                candidate.suffix in (".py", ".sql", ".ini", ".json", ".md")
            ):
                rel = candidate.relative_to(root).as_posix()
                listing[rel] = hashlib.sha256(candidate.read_bytes()).hexdigest()
    return listing


def release_ready(sha: str) -> tuple[Path, Path]:
    target = release_path(sha)
    if target.is_symlink() or not target.is_dir():
        deny("STAGED_SOURCE_NOT_FOUND")
    root = target / "backend"
    manifest = target / "__finance_source.json"
    if manifest.is_symlink() or not manifest.is_file():
        deny("STAGED_MANIFEST_MISSING")
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        deny("STAGED_MANIFEST_INVALID")
    if (data != {"sha": sha, "source_hashes": source_files(root)} or
        data["source_hashes"] != source_files(REPO / "backend")):
        deny("STAGED_SOURCE_CHANGED")
    python = target / ".finance-venv" / "bin" / "python"
    if not python.is_file() or python.is_symlink():
        deny("STAGED_PYTHON_UNAVAILABLE")
    return target, python


def preflight(sha: str, *, allow_existing_stage: bool) -> tuple[int, list[str]]:
    if os.geteuid() != 0 or os.environ.get("GITHUB_ACTIONS") == "true":
        deny("AUTHORIZED_PRODUCTION_ROOT_REQUIRED")
    checked(["git", "-C", str(REPO), "diff", "--quiet"], code="SOURCE_DIRTY")
    checked(["git", "-C", str(REPO), "diff", "--cached", "--quiet"],
            code="SOURCE_INDEX_DIRTY")
    if checked(["git", "-C", str(REPO), "status", "--porcelain"]).strip():
        deny("SOURCE_UNTRACKED_CHANGES")
    checkout = checked(["git", "-C", str(REPO), "rev-parse", "HEAD"]).decode().strip()
    if checkout != sha:
        deny("SOURCE_SHA_MISMATCH")
    origin = checked(["git", "-C", str(REPO), "remote", "get-url", "origin"]).decode().strip()
    if origin not in (
        "https://github.com/MikeMoore1337/financial-horizon.git",
        "https://github.com/MikeMoore1337/financial-horizon",
        "git@github.com:MikeMoore1337/financial-horizon.git",
    ):
        deny("UNEXPECTED_SOURCE_ORIGIN")
    verify_exact_main_ci(sha)
    active_services()
    if systemd_value("User") != USER:
        deny("AUTH_SERVICE_USER_CHANGED")
    directory = Path(systemd_value("WorkingDirectory"))
    if not directory.is_relative_to(RELEASES) or directory.name != "backend":
        deny("AUTH_WORKDIR_UNEXPECTED")
    old_release = directory.parent
    if old_release == release_path(sha):
        deny("SOURCE_ALREADY_INSTALLED")
    if CURRENT.resolve(strict=True) != old_release.resolve(strict=True):
        deny("AUTH_RELEASE_LINK_DIVERGED")
    dropins = systemd_value("DropInPaths").split()
    if str(OAUTH_DROPIN) not in dropins or FINANCE_SOURCE_DROPIN.exists():
        deny("OAUTH_DROPIN_NOT_PRESERVED_OR_SOURCE_ALREADY_ACTIVE")
    if not OAUTH_DROPIN.is_file():
        deny("LIVE_OAUTH_DROPIN_NOT_FOUND")
    args, env = safe_process()
    for key in ("FH_FINANCE_RUNTIME_MODE", "FH_FINANCE_V2_RUNTIME",
                "FH_FINANCE_IMPORT_RUNTIME"):
        if env.get(key, "off") != "off":
            deny("FINANCE_FEATURE_ALREADY_ENABLED")
    if not (REPO / "backend" / "fh_email_auth" / "app.py").is_file():
        deny("CURRENT_BACKEND_SOURCE_MISSING")
    if "_personal_finance_runtime_options" not in (
        REPO / "backend" / "fh_email_auth" / "app.py"
    ).read_text(encoding="utf-8"):
        deny("PERSONAL_FINANCE_RUNTIME_NOT_IN_SOURCE")
    port = parsed_port(args)
    try:
        argv = safe_uvicorn_argv(args, port)
    except Exception:
        deny("AUTH_LAUNCH_ARGUMENTS_UNSUPPORTED")
    auth_baseline(port)
    finance_still_off(port)
    if BACKUPS.is_symlink() or not BACKUPS.is_dir() or (
        BACKUPS.stat().st_uid != 0 or stat.S_IMODE(BACKUPS.stat().st_mode) != 0o700
    ):
        deny("PRIVATE_AUTH_BACKUP_DIRECTORY_REQUIRED")
    if not allow_existing_stage and release_path(sha).exists():
        deny("RELEASE_CANDIDATE_ALREADY_EXISTS")
    return port, argv


def python_env(target: Path) -> dict[str, str]:
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": pwd.getpwnam(USER).pw_dir,
        "PYTHONPATH": str(target) + ":" + str(target / "backend"),
        "PYTHONNOUSERSITE": "1",
        "FH_EMAIL_AUTH_ENABLED": "false",
        "FH_ENABLE_CLOUD_AUTH": "false",
        "FH_FINANCE_RUNTIME_MODE": "off",
        "FH_FINANCE_V2_RUNTIME": "off",
        "FH_FINANCE_IMPORT_RUNTIME": "off",
    }


def check_staged_import(sha: str, target: Path, python: Path) -> None:
    code = (
        "import pathlib,sys;"
        "from fh_email_auth.app import _personal_finance_runtime_options;"
        "import fh_auth.app,backend.finance_db.finance_router,"
        "backend.finance_api.accounts_v2_service;"
        "assert _personal_finance_runtime_options()=={};"
        "r=pathlib.Path(sys.argv[1]);"
        "assert pathlib.Path(sys.modules['fh_email_auth.app'].__file__).resolve()"
        ".is_relative_to(r.resolve());"
        "assert pathlib.Path(sys.modules['backend.finance_db.finance_router'].__file__)"
        ".resolve().is_relative_to(r.resolve())"
    )
    checked([str(python), "-c", code, str(target)], cwd=target / "backend",
            env=python_env(target), as_user=True, timeout=30,
            code="AUTH_FINANCE_IMPORT_AS_SERVICE_USER_FAILED")


def stage(sha: str) -> None:
    preflight(sha, allow_existing_stage=False)
    target = release_path(sha)
    if not RELEASES.is_dir() or RELEASES.is_symlink():
        deny("RELEASE_DIRECTORY_UNSAFE")
    source = REPO / "backend"
    before = source_files(source)
    try:
        target.mkdir(mode=0o755)
        shutil.copytree(source, target / "backend",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        python = target / ".finance-venv" / "bin" / "python"
        interpreter = sys.executable
        venv = checked([interpreter, "-m", "venv", str(target / ".finance-venv")],
                       timeout=120, code="ISOLATED_VENV_CREATION_FAILED")
        checked([str(python), "-m", "pip", "install",
                 "--no-input", "--disable-pip-version-check",
                 "--require-virtualenv", "-r", str(REPO / "backend/requirements.txt"),
                 "-r", str(REPO / "backend/requirements-finance.txt")],
                timeout=360, code="ISOLATED_DEPS_INSTALL_FAILED")
        if before != source_files(target / "backend"):
            deny("STAGED_SOURCE_COPY_MISMATCH")
        (target / "__finance_source.json").write_text(
            json.dumps({"sha": sha, "source_hashes": before},
                       sort_keys=True, separators=(",", ":")),
            encoding="utf-8",
        )
        check_staged_import(sha, target, python)
    except Exception:
        # Delete only the new, inactive stage, never the live release.
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        raise
    print("FINANCE_BACKEND_STAGED=PASS")
    print("FINANCE_RUNTIME_FLAGS=OFF")
    print("LIVE_AUTH_SERVICE_UNCHANGED=YES")


def backup_live_auth_db() -> None:
    _, env = safe_process()
    raw = env.get("FH_AUTH_DATABASE_PATH", "")
    db = Path(raw)
    if not db.is_absolute() or not db.is_file() or db.is_symlink():
        deny("LIVE_AUTH_DB_NOT_IDENTIFIED")
    fd, filename = tempfile.mkstemp(
        prefix="fh-auth-before-finance-source-", suffix=".sqlite3", dir=BACKUPS,
    )
    try:
        os.fchmod(fd, 0o600)
        os.close(fd)
        fd = -1
        with closing(sqlite3.connect(
            "file:" + quote(str(db), safe="/") + "?mode=ro", uri=True, timeout=12,
        )) as source, closing(sqlite3.connect(filename)) as output:
            source.backup(output)
            if output.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                deny("AUTH_BACKUP_INTEGRITY_FAILED")
            if output.execute("PRAGMA foreign_key_check").fetchall():
                deny("AUTH_BACKUP_FK_FAILED")
    except Exception:
        Path(filename).unlink(missing_ok=True)
        raise
    finally:
        if fd >= 0:
            os.close(fd)
    print("AUTH_SQLITE_PROTECTED_BACKUP=PASS")


def dropin_content(target: Path, argv: list[str]) -> str:
    python = target / ".finance-venv" / "bin" / "python"
    commands = [str(python), "-m", "uvicorn", *argv]
    if not all(re.fullmatch(r"[/A-Za-z0-9_.,:/*=-]+", arg) for arg in commands):
        deny("SYSTEMD_EXEC_ARGUMENT_UNSAFE")
    return (
        "[Service]\n"
        "ExecStart=\n"
        "ExecStart=" + " ".join(commands) + "\n"
        "WorkingDirectory=" + str(target / "backend") + "\n"
        "Environment=\"PYTHONPATH=" + str(target) + ":" + str(target / "backend") + "\"\n"
    )


def atomic_dropin(path: Path, value: str) -> None:
    if path.exists() or path.is_symlink():
        deny("FINANCE_SOURCE_DROPIN_ALREADY_EXISTS")
    fd, tempname = tempfile.mkstemp(prefix=".finance-source-", dir=DROPIN_DIR)
    try:
        os.fchmod(fd, 0o644)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tempname, path)
    finally:
        if fd >= 0:
            os.close(fd)
        if os.path.exists(tempname):
            os.unlink(tempname)


def readiness(port: int, providers: tuple[str, ...]) -> None:
    if tuple(auth_baseline(port)) != providers:
        deny("OAUTH_PROVIDER_REGRESSION")
    finance_still_off(port)
    active_services()


def apply(sha: str) -> None:
    port, argv = preflight(sha, allow_existing_stage=True)
    target, python = release_ready(sha)
    check_staged_import(sha, target, python)
    baseline = auth_baseline(port)
    backup_live_auth_db()
    content = dropin_content(target, argv)
    switched = False
    try:
        atomic_dropin(FINANCE_SOURCE_DROPIN, content)
        switched = True
        checked(["systemctl", "daemon-reload"], timeout=25,
                code="AUTH_DAEMON_RELOAD_FAILED")
        checked(["systemctl", "restart", SERVICE], timeout=40,
                code="AUTH_SOURCE_SERVICE_RESTART_FAILED")
        deadline = time.monotonic() + 35
        while True:
            try:
                readiness(port, baseline)
                break
            except NoGo:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.5)
        print("FINANCE_BACKEND_SOURCE_DEPLOYED=PASS")
        print("OAUTH_PROVIDER_SET_PRESERVED=PASS")
        print("EMAIL_AUTH_ANONYMOUS_SMOKE=PASS")
        print("FINANCE_RUNTIME_FLAGS=OFF")
        print("AUTH_SQLITE_RESTORED=NO")
        print("CADDY_CHANGED=NO")
    except Exception:
        if switched:
            print("FINANCE_BACKEND_ROLLBACK=STARTED")
            try:
                FINANCE_SOURCE_DROPIN.unlink()
                checked(["systemctl", "daemon-reload"], timeout=25,
                        code="ROLLBACK_DAEMON_RELOAD_FAILED")
                checked(["systemctl", "restart", SERVICE], timeout=40,
                        code="ROLLBACK_AUTH_RESTART_FAILED")
                deadline = time.monotonic() + 35
                while True:
                    try:
                        readiness(port, baseline)
                        break
                    except NoGo:
                        if time.monotonic() >= deadline:
                            raise
                        time.sleep(0.5)
                print("FINANCE_BACKEND_ROLLBACK=PASS")
            except Exception:
                print("FINANCE_BACKEND_ROLLBACK=FAILED_MANUAL_REVIEW_REQUIRED")
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--preflight", action="store_true")
    operation.add_argument("--stage", action="store_true")
    operation.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        sha = versioned_sha(args.sha)
        if args.preflight:
            preflight(sha, allow_existing_stage=True)
            print("FINANCE_BACKEND_PREFLIGHT=PASS")
            print("LIVE_AUTH_SERVICE_UNCHANGED=YES")
        elif args.stage:
            stage(sha)
        else:
            apply(sha)
        return 0
    except NoGo as exc:
        print("FINANCE_BACKEND_RELEASE=NO_GO")
        print("FAILURE_CODE=" + str(exc))
        return 1
    except Exception:
        # Fail closed without printing exception text/traceback containing secrets.
        print("FINANCE_BACKEND_RELEASE=FAILED")
        print("FAILURE_CODE=UNEXPECTED_RUNTIME")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
