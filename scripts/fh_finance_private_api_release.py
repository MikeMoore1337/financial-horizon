#!/usr/bin/env python3
"""#33/#70: opt in finance API on the existing FH OAuth service, without changing ledgers.

Two distinct release steps: enable the private backend and, after inspection,
publish *only* the reviewed finance routes through the existing Caddy proxy.
No accounts are created by this script. Import and PWA feature flags stay OFF.
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
import socket
import sqlite3
import ssl
import stat
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen
from uuid import UUID, uuid4

from fh_oauth_production_release import safe_uvicorn_argv

REPO = Path("/opt/financial-horizon-ops")
SERVICE = "fh-email-auth.service"
ORIGIN = "https://fin-horizon.mikemoore.top"
HOST = "fin-horizon.mikemoore.top"
BACKEND_PORT = 9138
FINANCE_PORT = 54329
SHA_ENV = Path("/etc/financial-horizon/finance/start.env")
SECRETS = Path("/etc/financial-horizon/finance/secrets/runtime_password")
FINANCE_ENV = Path("/etc/financial-horizon/finance/runtime.env")
LAUNCHER_SOURCE = REPO / "scripts/fh_finance_api_launcher.py"
LAUNCHER_INSTALLED = Path("/usr/local/lib/financial-horizon/finance_api_launcher.py")
CREDENTIAL_NAME = "fh_finance_runtime_password"
FINANCE_DROPIN = Path("/etc/systemd/system/fh-email-auth.service.d/90-finance-runtime.conf")
AUTH_SOURCE_DROPIN = Path("/etc/systemd/system/fh-email-auth.service.d/80-finance-source.conf")
OAUTH_DROPIN = Path("/etc/systemd/system/fh-email-auth.service.d/70-oauth.conf")
CADDY = Path("/etc/caddy/sites.d/fin-horizon.mikemoore.top.caddy")
CADDYFILE = Path("/etc/caddy/Caddyfile")
BACKUPS = Path("/var/backups/financial-horizon-finance")
CA_CERT = Path("/usr/local/lib/financial-horizon/certs/cloudflare-origin-rsa-root.pem")
CA_SHA = "91a8a5567efa6bf941162aa806b3ba476aaddf7867640e53053b35fb225a5dae"
PROVIDERS = {"google", "yandex", "vk", "telegram"}
JOBS = {"app-tests", "email-auth-tests", "finance-postgres", "e2e-real-browser"}
CADDY_MARKER = "    @fh_oauth_live_get {"
ROUTES = (
    "    @fh_finance_read {\n"
    "        method GET\n"
    "        path /api/finance/v1/state /api/finance/v1/changes\n"
    "    }\n"
    "    handle @fh_finance_read {\n"
    "        reverse_proxy 127.0.0.1:9138\n"
    "    }\n"
    "    @fh_finance_write {\n"
    "        method POST\n"
    "        path /api/auth/email/finance/session /api/finance/v1/commands /api/finance/v2/commands\n"
    "    }\n"
    "    handle @fh_finance_write {\n"
    "        reverse_proxy 127.0.0.1:9138\n"
    "    }\n"
)


class NoGo(Exception):
    pass


def deny(reason: str) -> None:
    raise NoGo(reason)


def run(args: list[str], *, timeout: int = 20, user: str | None = None,
        env: dict[str, str] | None = None, error: str = "COMMAND_FAILED") -> str:
    extra = {}
    if user:
        account = pwd.getpwnam(user)
        if account.pw_uid == 0 or account.pw_gid == 0:
            deny("SERVICE_USER_PRIVILEGED")
        extra = {"user": account.pw_uid, "group": account.pw_gid, "extra_groups": []}
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, env=env, check=False, **extra)
    except (OSError, subprocess.TimeoutExpired):
        deny(error)
    if result.returncode:
        deny(error)
    if len(result.stdout) > 65536:
        deny("COMMAND_OUTPUT_UNEXPECTED")
    return result.stdout.decode("utf-8").strip()


def secure_file(path: Path, owner: int, mode: int) -> bytes:
    try:
        meta = path.lstat()
        if (not stat.S_ISREG(meta.st_mode) or meta.st_uid != owner or
            stat.S_IMODE(meta.st_mode) != mode or meta.st_nlink != 1):
            deny("PROTECTED_FILE_PERMISSIONS_INVALID")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            data = os.read(fd, 8193)
            if len(data) > 8192:
                deny("PROTECTED_FILE_TOO_LARGE")
            return data
        finally:
            os.close(fd)
    except OSError:
        deny("PROTECTED_FILE_UNREADABLE")


def write_exclusive(path: Path, data: bytes, *, mode: int = 0o600) -> None:
    if path.exists() or path.is_symlink():
        deny("PROTECTED_TARGET_ALREADY_EXISTS")
    fd = None
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, mode)
        os.fchmod(fd, mode)
        os.write(fd, data)
        os.fsync(fd)
    except OSError:
        deny("PROTECTED_WRITE_FAILED")
    finally:
        if fd is not None:
            os.close(fd)


def atomic_replace(path: Path, data: bytes, *, mode: int) -> None:
    fd, tmp = tempfile.mkstemp(prefix=".fh-finance-", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.replace(tmp, path)
    finally:
        if os.path.lexists(tmp):
            os.unlink(tmp)


def github(path: str) -> dict:
    request = Request("https://api.github.com/repos/MikeMoore1337/financial-horizon/" + path,
                      headers={"User-Agent": "fh-finance-private-api-release",
                               "Accept": "application/vnd.github+json"})
    try:
        with urlopen(request, timeout=12) as response:
            raw = response.read(1024 * 1024 + 1)
        value = json.loads(raw)
    except (OSError, ValueError):
        deny("EXACT_SHA_GITHUB_UNAVAILABLE")
    if len(raw) > 1024 * 1024 or not isinstance(value, dict):
        deny("EXACT_SHA_GITHUB_UNEXPECTED")
    return value


def attest_sha(sha: str) -> None:
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        deny("INVALID_EXACT_SHA")
    if github("branches/main")["commit"]["sha"] != sha:
        deny("NOT_CURRENT_MAIN")
    runs = github(f"actions/runs?head_sha={sha}&event=push&per_page=50")
    for item in runs.get("workflow_runs", []):
        if (item.get("name") != "tests" or item.get("head_sha") != sha or
            item.get("conclusion") != "success" or item.get("status") != "completed"):
            continue
        jobs = github(f"actions/runs/{item['id']}/jobs?per_page=100")["jobs"]
        passing = {job.get("name") for job in jobs if job.get("conclusion") == "success"}
        if JOBS <= passing:
            return
    deny("EXACT_SHA_CI_INCOMPLETE")


def live_auth() -> None:
    for unit in ("caddy.service", "fh-finance-personal.service",
                 "fh-finance-personal-backup.timer", SERVICE):
        if run(["systemctl", "is-active", unit]) != "active":
            deny("REQUIRED_SERVICE_INACTIVE")
    if run(["systemctl", "show", SERVICE, "-p", "User", "--value"]) != "fh-email-auth":
        deny("UNEXPECTED_AUTH_SERVICE_USER")
    if not (AUTH_SOURCE_DROPIN.is_file() and OAUTH_DROPIN.is_file()):
        deny("EXISTING_OAUTH_SOURCE_DROPINS_MISSING")
    wd = Path(run(["systemctl", "show", SERVICE, "-p", "WorkingDirectory", "--value"]))
    if (wd.name != "backend" or not wd.is_relative_to("/opt/financial-horizon-auth/releases")
        or not (wd / "fh_email_auth/app.py").is_file()
        or "_personal_finance_runtime_options" not in
        (wd / "fh_email_auth/app.py").read_text(encoding="utf-8")
        or not (wd.parent / ".finance-venv/bin/python").is_file()):
        deny("LIVE_FINANCE_CAPABLE_AUTH_SOURCE_REQUIRED")
    pid = run(["systemctl", "show", SERVICE, "-p", "MainPID", "--value"])
    if not pid.isdecimal() or int(pid) <= 1:
        deny("AUTH_PID_UNAVAILABLE")
    # Never print values from /proc/PID/environ, which contains OAuth secrets.
    try:
        variables = {
            key.decode(): val.decode()
            for item in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
            if b"=" in item for key, _, val in [item.partition(b"=")]
        }
    except (OSError, UnicodeError):
        deny("AUTH_RUNTIME_ENV_UNAVAILABLE")
    for flag in ("FH_FINANCE_RUNTIME_MODE", "FH_FINANCE_V2_RUNTIME",
                 "FH_FINANCE_IMPORT_RUNTIME"):
        if variables.get(flag, "off") != "off" and not FINANCE_DROPIN.is_file():
            deny("UNEXPECTED_FINANCE_FEATURE_ALREADY_ENABLED")
    if (variables.get("FH_AUTH_DATABASE_PATH", "") ==
        "/var/lib/financial-horizon/oauth-canary/auth.sqlite3"):
        deny("PRODUCTION_AUTH_STORE_IS_CANARY")


def local_probe(path: str, *, method: str = "GET", origin: str | None = None) -> int:
    conn = http.client.HTTPConnection("127.0.0.1", BACKEND_PORT, timeout=5)
    headers = {"Host": HOST, "Cache-Control": "no-store"}
    if origin is not None:
        headers["Origin"] = origin
    try:
        conn.request(method, path, headers=headers, body=b"" if method == "POST" else None)
        response = conn.getresponse()
        body = response.read(8193)
        if len(body) > 8192:
            deny("LOCAL_HTTP_BODY_TOO_LARGE")
        if path == "/api/auth/providers" and response.status == 200:
            data = json.loads(body)
            if (not isinstance(data, dict) or data.get("enabled") is not True or
                set(data.get("providers", [])) != PROVIDERS or
                len(data.get("providers", [])) != 4):
                deny("OAUTH_PROVIDER_SET_CHANGED")
        return response.status
    except (OSError, http.client.HTTPException, ValueError):
        deny("LOCAL_HTTP_PROBE_UNAVAILABLE")
    finally:
        conn.close()


def auth_provider_baseline() -> None:
    if (local_probe("/api/auth/providers") != 200
        or local_probe("/api/auth/email/me") != 200):
        deny("LIVE_AUTH_BASELINE_FAILED")


def current_sha(sha: str) -> None:
    if os.geteuid() != 0 or os.getenv("GITHUB_ACTIONS") == "true":
        deny("NATIVE_ROOT_ONLY")
    if run(["git", "-C", str(REPO), "status", "--porcelain"]):
        deny("SOURCE_DIRTY")
    if run(["git", "-C", str(REPO), "rev-parse", "HEAD"]) != sha:
        deny("SOURCE_SHA_MISMATCH")
    if run(["git", "-C", str(REPO), "remote", "get-url", "origin"]) not in {
        "https://github.com/MikeMoore1337/financial-horizon.git",
        "https://github.com/MikeMoore1337/financial-horizon",
        "git@github.com:MikeMoore1337/financial-horizon.git",
    }:
        deny("UNTRUSTED_SOURCE")
    attest_sha(sha)
    raw_start = secure_file(SHA_ENV, 0, 0o600).decode("ascii")
    if raw_start.count("FH_FINANCE_APPROVED_SHA=" + sha + "\n") != 1:
        deny("POSTGRES_SYSTEMD_SHA_PIN_MISMATCH")
    live_auth()
    auth_provider_baseline()


def dsn(password: str) -> str:
    if not re.fullmatch(r"[a-f0-9]{64}", password):
        deny("RUNTIME_PASSWORD_FORMAT_INVALID")
    return "postgresql+psycopg://fh_finance_runtime:" + password + "@127.0.0.1:54329/fh_finance"


def role_password() -> str:
    raw = secure_file(SECRETS, 999, 0o400)
    try:
        return raw.decode("ascii")
    except UnicodeError:
        deny("RUNTIME_SECRET_INVALID")


def parse_runtime(content: str) -> dict[str, str]:
    result = {}
    for line in content.splitlines():
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*=[A-Za-z0-9_+:/@.\-]+", line):
            deny("RUNTIME_ENV_INVALID")
        key, _, value = line.partition("=")
        if key in result:
            deny("RUNTIME_ENV_DUPLICATE_KEY")
        result[key] = value
    if set(result) != {
        "FH_FINANCE_RUNTIME_MODE", "FH_FINANCE_V2_RUNTIME",
        "FH_FINANCE_IMPORT_RUNTIME", "FH_FINANCE_PROFILE_NAMESPACE",
    } or (
        result["FH_FINANCE_RUNTIME_MODE"] != "personal" or
        result["FH_FINANCE_V2_RUNTIME"] != "on" or
        result["FH_FINANCE_IMPORT_RUNTIME"] != "off"
    ):
        deny("RUNTIME_ENV_UNEXPECTED_KEYS_OR_FLAGS")
    try:
        namespace = UUID(result["FH_FINANCE_PROFILE_NAMESPACE"])
    except (ValueError, KeyError):
        deny("FINANCE_PROFILE_NAMESPACE_INVALID")
    if namespace.int == 0 or str(namespace) != result["FH_FINANCE_PROFILE_NAMESPACE"]:
        deny("RUNTIME_ENV_IDENTITY_MISMATCH")
    return result


def load_runtime() -> dict[str, str]:
    return parse_runtime(secure_file(FINANCE_ENV, 0, 0o600).decode("ascii"))


def python_binary() -> Path:
    wd = Path(run(["systemctl", "show", SERVICE, "-p", "WorkingDirectory", "--value"]))
    executable = wd.parent / ".finance-venv/bin/python"
    if not executable.is_file():
        deny("FINANCE_AUTH_PYTHON_UNAVAILABLE")
    return executable


def role_connectivity(url: str) -> None:
    # Execute as the live unprivileged FH service identity. The secret is in
    # the child environment only, never argv or stdout/logs.
    python = python_binary()
    module = (
        "import os,psycopg;"
        "conn=psycopg.connect(os.environ['FH_FINANCE_DATABASE_URL'].replace("
        "'postgresql+psycopg://','postgresql://',1),connect_timeout=3);"
        "cursor=conn.cursor();"
        "cursor.execute('SELECT current_user,current_database()');"
        "assert cursor.fetchone()==('fh_finance_runtime','fh_finance');"
        "cursor.execute('SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n"
        " ON c.relnamespace=n.oid WHERE n.nspname=\\'finance\\'"
        " AND c.relkind=\\'r\\' AND c.relforcerowsecurity');"
        "assert cursor.fetchone()[0]==15;"
        "cursor.execute('SELECT 1 FROM finance.finance_profiles LIMIT 0');"
        "conn.close()"
    )
    run([str(python), "-c", module], timeout=20, user="fh-email-auth",
        env={"PATH": "/usr/bin:/bin", "HOME": pwd.getpwnam("fh-email-auth").pw_dir,
             "FH_FINANCE_DATABASE_URL": url}, error="FH_RUNTIME_DATABASE_ROLE_UNUSABLE")


def preflight(sha: str) -> None:
    current_sha(sha)
    if FINANCE_DROPIN.exists() or FINANCE_DROPIN.is_symlink():
        deny("FINANCE_RUNTIME_ALREADY_ENABLED")
    if local_probe("/api/finance/v1/state") != 404:
        deny("FINANCE_ROUTER_ALREADY_PUBLISHED")
    if local_probe("/api/finance/v2/commands", method="POST") != 404:
        deny("FINANCE_V2_ROUTER_ALREADY_PUBLISHED")
    if not (BACKUPS.is_dir() and not BACKUPS.is_symlink()
            and BACKUPS.stat().st_uid == 0
            and stat.S_IMODE(BACKUPS.stat().st_mode) == 0o700):
        deny("FINANCE_PRIVATE_BACKUP_DIRECTORY_MISSING")
    print("FINANCE_PRIVATE_API_PREFLIGHT=PASS")


def prepare(sha: str) -> None:
    preflight(sha)
    if not FINANCE_ENV.exists() and not FINANCE_ENV.is_symlink():
        config = {
            "FH_FINANCE_RUNTIME_MODE": "personal",
            "FH_FINANCE_V2_RUNTIME": "on",
            "FH_FINANCE_IMPORT_RUNTIME": "off",
            "FH_FINANCE_PROFILE_NAMESPACE": str(uuid4()),
        }
        value = "".join(k + "=" + v + "\n" for k, v in config.items())
        parse_runtime(value)
        write_exclusive(FINANCE_ENV, value.encode("ascii"))
    config = load_runtime()
    # A copy of the protected stable profile namespace is required for restore.
    backup = BACKUPS / "fh-finance-runtime-profile.env.bak"
    if not backup.exists():
        write_exclusive(backup, secure_file(FINANCE_ENV, 0, 0o600))
    if secure_file(backup, 0, 0o600) != secure_file(FINANCE_ENV, 0, 0o600):
        deny("FINANCE_PROFILE_BACKUP_DIVERGED")
    role_connectivity(dsn(role_password()))
    print("FINANCE_RUNTIME_CREDENTIALS=PASS")
    print("FINANCE_PROFILE_NAMESPACE_BACKUP=PASS")
    print("FINANCE_API_PREPARED=PASS")
    print("FINANCE_API_NOT_YET_ENABLED=YES")


def enabled_local_smoke() -> None:
    auth_provider_baseline()
    if (local_probe("/api/finance/v1/state") != 401 or
        local_probe("/api/finance/v1/changes") != 401 or
        local_probe("/api/finance/v2/commands", method="POST", origin=ORIGIN) != 401 or
        local_probe("/api/auth/email/finance/session", method="POST", origin=ORIGIN) != 401 or
        local_probe("/api/auth/email/finance/session", method="POST",
                    origin="https://untrusted.example") != 403):
        deny("FINANCE_LOCAL_UNAUTHENTICATED_SECURITY_REGRESSION")


def approved_uvicorn_args() -> list[str]:
    pid = run(["systemctl", "show", SERVICE, "-p", "MainPID", "--value"])
    if not pid.isdecimal() or int(pid) <= 1:
        deny("AUTH_PROCESS_UNAVAILABLE")
    try:
        cmdline = [
            arg.decode("utf-8") for arg in
            Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0") if arg
        ]
        return safe_uvicorn_argv(cmdline, BACKEND_PORT)
    except (OSError, UnicodeError, ValueError):
        deny("LIVE_UVICORN_ARGUMENTS_UNSAFE")


def prepare_launcher() -> None:
    if (LAUNCHER_INSTALLED.parent.is_symlink() or
            not LAUNCHER_INSTALLED.parent.is_dir() or
            LAUNCHER_INSTALLED.parent.stat().st_uid != 0):
        deny("TRUSTED_LAUNCHER_DIRECTORY_REQUIRED")
    source = LAUNCHER_SOURCE.read_bytes()
    if LAUNCHER_INSTALLED.exists() or LAUNCHER_INSTALLED.is_symlink():
        if secure_file(LAUNCHER_INSTALLED, 0, 0o644) != source:
            deny("INSTALLED_LAUNCHER_CHANGED")
    else:
        write_exclusive(LAUNCHER_INSTALLED, source, mode=0o644)


def finance_systemd_dropin() -> bytes:
    args = [
        str(python_binary()), str(LAUNCHER_INSTALLED), "--", *approved_uvicorn_args(),
    ]
    if not all(re.fullmatch(r"[/A-Za-z0-9_.,:/*=+-]+", a) for a in args):
        deny("SYSTEMD_AUTH_LAUNCH_ARGUMENTS_UNSAFE")
    return (
        "[Service]\n"
        "EnvironmentFile=/etc/financial-horizon/finance/runtime.env\n"
        "LoadCredential=" + CREDENTIAL_NAME + ":" + str(SECRETS) + "\n"
        "ExecStart=\n"
        "ExecStart=" + " ".join(args) + "\n"
    ).encode("ascii")


def enable_local(sha: str) -> None:
    preflight(sha)
    load_runtime()
    role_connectivity(dsn(role_password()))
    if not (FINANCE_DROPIN.parent.is_dir() and not FINANCE_DROPIN.parent.is_symlink()):
        deny("SYSTEMD_DROPIN_DIRECTORY_MISSING")
    prepare_launcher()
    content = finance_systemd_dropin()
    write_exclusive(FINANCE_DROPIN, content, mode=0o644)
    try:
        run(["systemctl", "daemon-reload"], error="SYSTEMD_RELOAD_FAILED")
        run(["systemctl", "restart", SERVICE], timeout=45, error="AUTH_RESTART_FAILED")
        deadline = time.monotonic() + 30
        while True:
            try:
                enabled_local_smoke()
                break
            except NoGo:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.5)
        print("FINANCE_API_LOCAL_ROUTES=PASS")
        print("FINANCE_API_OAUTH_PRESERVED=PASS")
        print("FINANCE_API_IMPORT=OFF")
        print("FINANCE_API_LOCAL_ENABLED=PASS")
        print("CADDY_UNCHANGED=YES")
    except Exception:
        print("FINANCE_LOCAL_ROLLBACK=STARTED")
        FINANCE_DROPIN.unlink(missing_ok=True)
        try:
            run(["systemctl", "daemon-reload"], error="FINANCE_LOCAL_ROLLBACK_DAEMON_FAILED")
            run(["systemctl", "restart", SERVICE], timeout=45,
                error="FINANCE_LOCAL_ROLLBACK_SERVICE_FAILED")
            auth_provider_baseline()
            if local_probe("/api/finance/v1/state") != 404:
                deny("FINANCE_LOCAL_ROLLBACK_ROUTE_STILL_LIVE")
            print("FINANCE_LOCAL_ROLLBACK=PASS")
        except Exception:
            print("FINANCE_LOCAL_ROLLBACK=FAILED_MANUAL_REVIEW_REQUIRED")
        raise


def compose_caddy(before: str) -> str:
    if (before.count(CADDY_MARKER) != 1
        or before.count("handle @fh_oauth_live_get {") != 1
        or before.count("handle @fh_oauth_live_post {") != 1
        or "@fh_finance_read" in before or "@fh_finance_write" in before
        or "/api/finance/v1/" in before or "/api/finance/v2/" in before
        or "/api/auth/email/finance/session" in before):
        deny("UNRECOGNIZED_CADDY_FINANCE_ROUTING")
    return before.replace(CADDY_MARKER, ROUTES + CADDY_MARKER, 1)


def public_probe(path: str, *, method: str = "GET", origin: str | None = None) -> int:
    try:
        if hashlib.sha256(CA_CERT.read_bytes()).hexdigest() != CA_SHA:
            deny("ORIGIN_TLS_TRUST_ANCHOR_CHANGED")
        context = ssl.create_default_context(cafile=str(CA_CERT))
        with socket.create_connection(("127.0.0.1", 8444), timeout=5) as raw:
            with context.wrap_socket(raw, server_hostname=HOST) as encrypted:
                headers = [
                    f"{method} {path} HTTP/1.1",
                    f"Host: {HOST}",
                    "Connection: close",
                    "Cache-Control: no-store",
                ]
                if method == "POST":
                    headers.append("Content-Length: 0")
                if origin is not None:
                    headers.append("Origin: " + origin)
                headers.append("")
                headers.append("")
                encrypted.sendall("\r\n".join(headers).encode("ascii"))
                response = http.client.HTTPResponse(encrypted)
                response.begin()
                response.read(8192)
                return response.status
    except (OSError, ssl.SSLError, http.client.HTTPException, ValueError):
        deny("ORIGIN_HTTPS_PROBE_FAILED")


def caddy_original_backup(sha: str) -> Path:
    # One fixed, root-only rollback receipt. Never derive a filesystem path
    # from a CLI supplied SHA; release provenance is validated independently.
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        deny("INVALID_EXACT_SHA")
    return BACKUPS / "fh-finance-api-caddy.original.bak"


def caddy_snapshot() -> tuple[bytes, int]:
    try:
        info = CADDY.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
            or not CADDYFILE.is_file()):
            deny("CADDY_SITE_UNSAFE")
        data = CADDY.read_bytes()
        if len(data) > 256_000:
            deny("CADDY_SITE_TOO_LARGE")
        return data, stat.S_IMODE(info.st_mode)
    except OSError:
        deny("CADDY_SITE_UNREADABLE")


def publish(sha: str) -> None:
    current_sha(sha)
    if not FINANCE_DROPIN.is_file() or not FINANCE_ENV.is_file():
        deny("FINANCE_PRIVATE_API_NOT_ENABLED")
    load_runtime()
    enabled_local_smoke()
    original, mode = caddy_snapshot()
    try:
        patched = compose_caddy(original.decode("utf-8")).encode("utf-8")
    except UnicodeError:
        deny("CADDY_SITE_NOT_UTF8")
    backup = caddy_original_backup(sha)
    if backup.exists() or backup.is_symlink():
        if secure_file(backup, 0, 0o600) != original:
            deny("CADDY_ORIGINAL_BACKUP_CHANGED")
    else:
        write_exclusive(backup, original)
    try:
        atomic_replace(CADDY, patched, mode=mode)
        run(["caddy", "validate", "--config", str(CADDYFILE)],
            error="NEW_CADDY_CONFIG_REJECTED")
        run(["systemctl", "reload", "caddy.service"],
            error="CADDY_RELOAD_FAILED")
        if (public_probe("/api/auth/providers") != 200 or
            public_probe("/api/finance/v1/state") != 401 or
            public_probe("/api/finance/v1/changes") != 401 or
            public_probe("/api/auth/email/finance/session", method="POST", origin=ORIGIN) != 401 or
            public_probe("/api/finance/v2/commands", method="POST", origin=ORIGIN) != 401):
            deny("ORIGIN_FINANCE_ANONYMOUS_ACCESS_FAILED")
        print("FINANCE_HTTPS_ORIGIN_ROUTING=PASS")
        print("FINANCE_PUBLIC_ANONYMOUS_REJECTED=PASS")
        print("FINANCE_API_PUBLISHED=PASS")
        print("FINANCE_IMPORT_PWA=OFF")
    except Exception:
        print("CADDY_FINANCE_ROLLBACK=STARTED")
        try:
            current, _ = caddy_snapshot()
            if current != patched:
                deny("CADDY_CONCURRENT_EDIT_REQUIRES_MANUAL_REVIEW")
            atomic_replace(CADDY, original, mode=mode)
            run(["caddy", "validate", "--config", str(CADDYFILE)],
                error="CADDY_RESTORE_VALIDATE_FAILED")
            run(["systemctl", "reload", "caddy.service"],
                error="CADDY_RESTORE_RELOAD_FAILED")
            print("CADDY_FINANCE_ROLLBACK=PASS")
        except Exception:
            print("CADDY_FINANCE_ROLLBACK=FAILED_MANUAL_REVIEW_REQUIRED")
        raise


def rollback(sha: str) -> None:
    if os.geteuid() != 0 or os.getenv("FH_FINANCE_ROLLBACK") != "YES":
        deny("ROLLBACK_EXPLICIT_ROOT_APPROVAL_REQUIRED")
    if FINANCE_DROPIN.is_file():
        backup = caddy_original_backup(sha)
        if backup.is_file():
            original = secure_file(backup, 0, 0o600)
            current, mode = caddy_snapshot()
            expected_published = compose_caddy(original.decode("utf-8")).encode("utf-8")
            if current == expected_published:
                atomic_replace(CADDY, original, mode=mode)
                run(["caddy", "validate", "--config", str(CADDYFILE)],
                    error="CADDY_RESTORE_VALIDATE_FAILED")
                run(["systemctl", "reload", "caddy.service"],
                    error="CADDY_RESTORE_RELOAD_FAILED")
            elif current != original:
                deny("CADDY_CONCURRENT_EDIT_REQUIRES_MANUAL_REVIEW")
        FINANCE_DROPIN.unlink()
        run(["systemctl", "daemon-reload"])
        run(["systemctl", "restart", SERVICE], timeout=45)
        auth_provider_baseline()
        if local_probe("/api/finance/v1/state") != 404:
            deny("FINANCE_ROLLBACK_STILL_ACTIVE")
    print("FINANCE_RUNTIME_ROLLBACK=PASS")
    print("FINANCE_USER_DATA_UNCHANGED=YES")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    action = parser.add_mutually_exclusive_group(required=True)
    for name in ("preflight", "prepare", "enable-local", "publish", "rollback"):
        action.add_argument("--" + name, action="store_true")
    args = parser.parse_args()
    try:
        if not re.fullmatch(r"[0-9a-f]{40}", args.sha):
            deny("EXACT_SHA_REQUIRED")
        if args.preflight:
            preflight(args.sha)
        elif args.prepare:
            prepare(args.sha)
        elif args.enable_local:
            enable_local(args.sha)
        elif args.publish:
            publish(args.sha)
        else:
            rollback(args.sha)
        return 0
    except NoGo as exc:
        print("FINANCE_API_RELEASE=NO_GO")
        print("FAILURE_CODE=" + str(exc))
        return 1
    except Exception:
        print("FINANCE_API_RELEASE=FAILED")
        print("FAILURE_CODE=UNEXPECTED_RUNTIME")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
