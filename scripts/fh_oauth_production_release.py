#!/usr/bin/env python3
"""Single guarded OAuth #9 production rollout. Run only on the real FH VPS.

Requires a pinned, CI-passing main SHA. No Telegram or public registration.
Makes NO changes unless every required production layout invariant holds.
On failed rollout restores links, Caddy and OAuth configuration, never blindly
restores an old SQLite snapshot (which could lose new sessions/accounts).
"""
from __future__ import annotations

import argparse
from contextlib import closing
import http.client
import io
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
from urllib.request import urlopen
from urllib.parse import quote

HOST = "fin-horizon.mikemoore.top"
SERVICE = "fh-email-auth.service"
BACKEND_ROOT = Path("/opt/financial-horizon-auth")
STATIC_ROOT = Path("/srv/www/fin-horizon")
EMAIL_ENV = Path("/etc/financial-horizon/email-auth.env")
OAUTH_ENV = Path("/etc/financial-horizon/oauth.env")
CADDY_SITE = Path("/etc/caddy/sites.d/fin-horizon.mikemoore.top.caddy")
CADDY_MAIN = Path("/etc/caddy/Caddyfile")
BACKUPS = Path("/var/backups/financial-horizon")
DROPIN = Path("/etc/systemd/system/fh-email-auth.service.d/70-oauth.conf")
CANARY_DB = Path("/var/lib/financial-horizon/oauth-canary/auth.sqlite3")
ALLOWED = {"FH_GOOGLE_OAUTH_ENABLED", "FH_YANDEX_OAUTH_ENABLED", "FH_VK_OAUTH_ENABLED"}
FLAGS = {"FH_ENABLE_CLOUD_AUTH", "FH_TELEGRAM_OAUTH_ENABLED", *ALLOWED}
PROVIDERS = ["google", "yandex", "vk"]


class Gate(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def command(args: list[str], *, timeout: int = 1200, cwd: Path | None = None) -> bytes:
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       cwd=cwd, timeout=timeout, check=False)
    if p.returncode:
        raise Gate("COMMAND_FAILED_" + re.sub(r"[^A-Z0-9_]", "_",
                                               Path(args[0]).name.upper()))
    return p.stdout


def private_file(path: Path) -> bytes:
    if path.is_symlink():
        raise Gate("PRIVATE_FILE_LINK")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or \
                stat.S_IMODE(st.st_mode) != 0o600:
            raise Gate("PRIVATE_FILE_MODE")
        return os.read(fd, 1024 * 1024 + 1)
    finally:
        os.close(fd)


def assignment(raw: bytes, name: str) -> list[str]:
    return [r.partition(b"=")[2].decode().strip().strip('"').strip("'")
            for r in raw.splitlines() if r.startswith((name + "=").encode())]


def replace_flags(raw: bytes) -> bytes:
    data = raw
    for name in sorted(FLAGS):
        wanted = b"false" if name == "FH_TELEGRAM_OAUTH_ENABLED" else b"true"
        old = (name + "=false").encode()
        if data.count(old) != 1 or assignment(data, name) != ["false"]:
            raise Gate("OAUTH_FLAGS_NOT_DISABLED")
        data = data.replace(old, name.encode() + b"=" + wanted, 1)
    return data


def atomic_file(path: Path, data: bytes, mode: int | None = 0o600) -> None:
    existing = None
    if path.exists() or path.is_symlink():
        if path.is_symlink() or not path.is_file():
            raise Gate("ATOMIC_TARGET_NOT_REGULAR")
        existing = path.stat()
    fd, name = tempfile.mkstemp(prefix=".fh-oauth-", dir=path.parent)
    try:
        if existing is not None:
            os.fchown(fd, existing.st_uid, existing.st_gid)
        os.fchmod(fd, stat.S_IMODE(existing.st_mode) if mode is None and existing else
                  (mode if mode is not None else 0o600))
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def current_release(root: Path) -> Path:
    link = root / "current"
    if not link.is_symlink():
        raise Gate("RELEASE_LINK_NOT_FOUND")
    value = link.resolve(strict=True)
    if value.parent != (root / "releases").resolve(strict=True):
        raise Gate("RELEASE_LINK_OUTSIDE_ROOT")
    return value


def switch_release(root: Path, target: Path) -> None:
    if not target.is_dir() or target.parent.resolve() != (root / "releases").resolve():
        raise Gate("RELEASE_TARGET_INVALID")
    link = root / "current"
    tmp = root / ".oauth-current-tmp"
    if tmp.exists() or tmp.is_symlink():
        raise Gate("RELEASE_TEMP_LINK_EXISTS")
    tmp.symlink_to(target)
    os.replace(tmp, link)


def running_process() -> tuple[int, list[str], dict[str, str]]:
    value = command(["systemctl", "show", "--value", "-p", "MainPID", SERVICE])
    if not value.strip().isdigit() or int(value.strip()) <= 1:
        raise Gate("AUTH_SERVICE_NOT_RUNNING")
    pid = int(value.strip())
    env = {}
    for row in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0"):
        if b"=" in row:
            key, _, val = row.partition(b"=")
            env[key.decode()] = val.decode(errors="replace")
    args = [x.decode(errors="replace") for x in
            Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0") if x]
    return pid, args, env


def proxy_port(args: list[str], caddy: str) -> int:
    matches = []
    for i, arg in enumerate(args):
        if arg == "--port" and i + 1 < len(args):
            matches.append(args[i + 1])
        if arg.startswith("--port="):
            matches.append(arg.partition("=")[2])
    if len(matches) != 1 or not matches[0].isdigit():
        raise Gate("AUTH_PORT_UNKNOWN")
    port = int(matches[0])
    if not 1 <= port <= 65535 or port == 9139:
        raise Gate("AUTH_PORT_INVALID")
    if f"reverse_proxy 127.0.0.1:{port}" not in caddy:
        raise Gate("CADDY_LIVE_PROXY_NOT_IDENTIFIED")
    return port


def public_caddy_config(original: str, port: int) -> str:
    marker = "handle @owner_oauth_canary {"
    if original.count(marker) != 1 or original.count("handle @any_oauth_canary {") != 1:
        raise Gate("OWNER_CANARY_HANDLERS_UNRECOGNIZED")
    if "@fh_oauth_live_get" in original or "@fh_oauth_live_post" in original:
        raise Gate("PUBLIC_OAUTH_ROUTE_ALREADY_PRESENT")
    # Named matchers are evaluated in written order among handle blocks.
    # Insert before the owner-only canary handler; keep canary/status protected.
    get_paths = ["/api/auth/providers", "/api/auth/email/me"]
    post_paths = ["/api/auth/email/logout", "/api/auth/email/logout-others"]
    for provider in PROVIDERS:
        get_paths.extend((f"/api/auth/oauth/{provider}/start",
                          f"/api/auth/oauth/{provider}/callback"))
        post_paths.append(f"/api/auth/oauth/{provider}/callback")
    callback_paths = [f"/api/auth/oauth/{p}/callback" for p in PROVIDERS]
    route = (
        "    @fh_oauth_live_get {\n"
        "        method GET\n"
        "        path " + " ".join(get_paths) + "\n"
        "    }\n"
        "    handle @fh_oauth_live_get {\n"
        f"        reverse_proxy 127.0.0.1:{port}\n"
        "    }\n"
        "    @fh_oauth_live_post {\n"
        "        method POST\n"
        "        path " + " ".join(post_paths) + "\n"
        "    }\n"
        "    handle @fh_oauth_live_post {\n"
        f"        reverse_proxy 127.0.0.1:{port}\n"
        "    }\n"
        "    @fh_oauth_callback_log_skip {\n"
        "        path " + " ".join(callback_paths) + "\n"
        "    }\n"
        "    log_skip @fh_oauth_callback_log_skip\n"
    )
    return original.replace(marker, route + "    " + marker, 1)


def http_probe(port: int, path: str) -> tuple[int, bytes]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request("GET", path, headers={"Host": HOST, "Cache-Control": "no-store"})
        resp = conn.getresponse()
        return resp.status, resp.read(4096)
    finally:
        conn.close()


def validate_running_oauth(port: int, expected: list[str]) -> None:
    status, body = http_probe(port, "/api/auth/providers")
    if status != 200:
        raise Gate("OAUTH_SERVICE_NOT_READY")
    try:
        data = json.loads(body)
    except ValueError as exc:
        raise Gate("OAUTH_PROVIDERS_BAD_JSON") from exc
    if data != {"enabled": True, "providers": expected}:
        raise Gate("OAUTH_PROVIDERS_UNEXPECTED")
    status, _ = http_probe(port, "/api/auth/oauth/telegram/start")
    if status != 404:
        raise Gate("TELEGRAM_NOT_DISABLED")
    status, body = http_probe(port, "/api/auth/email/me")
    if status != 200 or b'"authenticated":false' not in body.replace(b" ", b"").lower():
        raise Gate("SESSION_ENDPOINT_UNAVAILABLE")


def source_archive(sha: str, target: Path) -> Path:
    url = f"https://github.com/MikeMoore1337/financial-horizon/archive/{sha}.tar.gz"
    with urlopen(url, timeout=90) as resp:
        data = resp.read(45 * 1024 * 1024 + 1)
    if len(data) > 45 * 1024 * 1024:
        raise Gate("SOURCE_ARCHIVE_TOO_LARGE")
    root = target / "source"
    root.mkdir(mode=0o700)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        names = archive.getnames()
        roots = {name.partition("/")[0] for name in names}
        if len(roots) != 1 or not next(iter(roots)).startswith("financial-horizon-"):
            raise Gate("SOURCE_ARCHIVE_UNEXPECTED")
        prefix = next(iter(roots))
        if not names or any(name != prefix and not name.startswith(prefix + "/")
                            for name in names):
            raise Gate("SOURCE_ARCHIVE_UNEXPECTED")
        archive.extractall(root, filter="data")
    content = root / prefix
    if not (content / "backend/fh_auth/app.py").is_file() or \
            not (content / "account-oauth.js").is_file():
        raise Gate("SOURCE_CONTENT_MISSING")
    return content


def stage_backend(source: Path, sha: str, existing: Path) -> Path:
    destination = BACKEND_ROOT / "releases" / sha
    if destination.exists() or destination.is_symlink():
        raise Gate("BACKEND_RELEASE_ALREADY_EXISTS")
    packages = [p for p in existing.rglob("fh_email_auth/app.py") if p.is_file()]
    if len(packages) != 1:
        raise Gate("BACKEND_LAYOUT_UNKNOWN")
    relative = packages[0].parent.parent.relative_to(existing)
    shutil.copytree(existing, destination, symlinks=True,
                    ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".venv"))
    pkgroot = destination / relative
    for pkg in ("fh_email_auth", "fh_auth"):
        shutil.copytree(source / "backend" / pkg, pkgroot / pkg, dirs_exist_ok=True)
    return destination


def stage_static(source: Path, sha: str) -> Path:
    destination = STATIC_ROOT / "releases" / sha
    if destination.exists() or destination.is_symlink():
        raise Gate("STATIC_RELEASE_ALREADY_EXISTS")
    command(["npm", "ci", "--no-audit", "--no-fund"], cwd=source, timeout=480)
    command(["npm", "run", "build"], cwd=source, timeout=480)
    dist = source / "dist"
    if any(not (dist / name).is_file() for name in
           ("index.html", "account.html", "account-oauth.js", "auth-ui.js", "sw.js")):
        raise Gate("STATIC_BUILD_INCOMPLETE")
    shutil.copytree(dist, destination)
    return destination


def find_auth_python(args: list[str]) -> Path:
    candidates = []
    for raw in args[:3]:
        path = Path(raw)
        if path.is_absolute() and path.is_file() and path.name in (
                "python", "python3", "uvicorn"):
            candidates.append(path.parent / "python")
    candidates += [
        BACKEND_ROOT / "venv" / "bin" / "python",
        BACKEND_ROOT / ".venv" / "bin" / "python",
    ]
    for p in candidates:
        if p.is_file() and subprocess.run(
            [str(p), "-c", "import fastapi, uvicorn, httpx, pwdlib"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            check=False, timeout=15,
        ).returncode == 0:
            return p
    raise Gate("AUTH_VENV_NOT_IDENTIFIED")


def preflight(sha: str):
    if os.geteuid() != 0 or not re.fullmatch("[a-f0-9]{40}", sha):
        raise Gate("ROOT_OR_SHA_INVALID")
    if sys.version_info < (3, 12):
        raise Gate("PYTHON_312_REQUIRED")
    if DROPIN.exists() or DROPIN.is_symlink():
        raise Gate("OAUTH_SYSTEMD_DROPIN_EXISTS")
    if BACKUPS.is_symlink() or not BACKUPS.is_dir() or \
            BACKUPS.stat().st_uid != 0 or \
            stat.S_IMODE(BACKUPS.stat().st_mode) != 0o700:
        raise Gate("BACKUP_DIRECTORY_INVALID")
    back = current_release(BACKEND_ROOT)
    static = current_release(STATIC_ROOT)
    _, args, env = running_process()
    path = Path(env.get("FH_AUTH_DATABASE_PATH", ""))
    if not path.is_absolute() or path == CANARY_DB or \
            not path.is_file() or path.is_symlink() or \
            path.parent.stat().st_mode & 0o077:
        raise Gate("LIVE_AUTH_DB_INVALID")
    with closing(sqlite3.connect("file:" + quote(str(path), safe="/") +
                                "?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok" or \
                db.execute("PRAGMA foreign_key_check").fetchall():
            raise Gate("LIVE_DB_INTEGRITY")
        cols = db.execute("PRAGMA table_info(users)").fetchall()
        if len(cols) != 7 or cols[1][1] != "email" or cols[1][3] != 1:
            raise Gate("MIGRATION_SCHEMA_NOT_LEGACY")
    email = private_file(EMAIL_ENV)
    staged = private_file(OAUTH_ENV)
    if assignment(email, "FH_AUTH_DATABASE_PATH") != [str(path)] or \
            assignment(staged, "FH_AUTH_DATABASE_PATH") != [str(path)]:
        raise Gate("AUTH_DB_PATH_MISMATCH")
    for key in FLAGS:
        if assignment(staged, key) != ["false"]:
            raise Gate("OAUTH_FLAGS_NOT_OFF")
    for provider in PROVIDERS:
        for suffix in (("CLIENT_ID", "CLIENT_SECRET") if provider != "vk" else ("CLIENT_ID",)):
            key = f"FH_{provider.upper()}_OAUTH_{suffix}"
            if len(assignment(staged, key)) != 1 or not assignment(staged, key)[0]:
                raise Gate("OAUTH_CREDENTIALS_NOT_STAGED")
    if len(assignment(staged, "FH_SESSION_SECRET")) != 1 or \
            len(assignment(staged, "FH_SESSION_SECRET")[0]) < 32:
        raise Gate("SESSION_SECRET_INVALID")
    if not CADDY_SITE.is_file() or CADDY_SITE.is_symlink() or not CADDY_MAIN.is_file():
        raise Gate("CADDY_CONFIG_MISSING")
    caddy = CADDY_SITE.read_text(encoding="utf-8")
    port = proxy_port(args, caddy)
    new_caddy = public_caddy_config(caddy, port)
    version = command(["node", "--version"]).decode().strip()
    if not re.fullmatch(r"v24\.\d+\.\d+", version):
        raise Gate("NODE_24_REQUIRED")
    auth_py = find_auth_python(args)
    for name in ("caddy.service", SERVICE):
        command(["systemctl", "is-active", "--quiet", name])
    return back, static, path, staged, caddy, new_caddy, port, auth_py


def migrate_live_database(source: Path, db: Path) -> None:
    migration = source / "backend/fh_auth/migrate.py"
    if not migration.is_file():
        raise Gate("MIGRATION_SCRIPT_MISSING")
    fd, filename = tempfile.mkstemp(prefix="auth-pre-oauth-release-",
                                    suffix=".sqlite3", dir=db.parent)
    os.close(fd)
    Path(filename).unlink()
    command([sys.executable, str(migration), str(db), filename], timeout=90)
    backup = Path(filename)
    if not backup.is_file() or backup.stat().st_mode & 0o077:
        raise Gate("MIGRATION_BACKUP_INVALID")


def rollout(sha: str) -> None:
    old_backend, old_static, db, old_env, old_caddy, new_caddy, port, auth_py = preflight(sha)
    print("RELEASE_PREFLIGHT=PASS", flush=True)
    with tempfile.TemporaryDirectory(prefix="fh-oauth-release-") as workdir:
        source = source_archive(sha, Path(workdir))
        new_backend = stage_backend(source, sha, old_backend)
        new_static = stage_static(source, sha)
        command([str(auth_py), "-m", "pip", "install", "--disable-pip-version-check",
                 "joserfc>=1.8,<2", "cryptography>=44,<50"], timeout=240)
        command([str(auth_py), "-c", "import joserfc, cryptography"], timeout=30)
        command([sys.executable, "-m", "compileall", "-q", str(new_backend)], timeout=45)
        print("RELEASE_STAGED=PASS", flush=True)
        changed = False
        db_migrated = False
        try:
            changed = True
            command(["systemctl", "stop", SERVICE], timeout=25)
            migrate_live_database(source, db)
            db_migrated = True
            switch_release(BACKEND_ROOT, new_backend)
            DROPIN.parent.mkdir(parents=True, exist_ok=True)
            atomic_file(DROPIN, b"[Service]\nEnvironmentFile=/etc/financial-horizon/oauth.env\n", 0o644)
            atomic_file(OAUTH_ENV, replace_flags(old_env))
            command(["systemctl", "daemon-reload"], timeout=25)
            command(["systemctl", "start", SERVICE], timeout=30)
            # A systemd active state does not prove Uvicorn is ready yet.
            import time
            deadline = time.monotonic() + 35
            while True:
                try:
                    validate_running_oauth(port, PROVIDERS)
                    break
                except (OSError, Gate):
                    if time.monotonic() >= deadline:
                        raise Gate("AUTH_READY_TIMEOUT")
                    time.sleep(0.5)
            atomic_file(CADDY_SITE, new_caddy.encode("utf-8"), None)
            command(["caddy", "validate", "--config", str(CADDY_MAIN)], timeout=30)
            command(["systemctl", "reload", "caddy.service"], timeout=30)
            switch_release(STATIC_ROOT, new_static)
            validate_running_oauth(port, PROVIDERS)
            # HTTPS origin HTTP response must actually reach production auth.
            data = command([
                "curl", "--fail", "--silent", "--show-error",
                "--max-time", "12", "--resolve", HOST + ":443:127.0.0.1",
                "https://" + HOST + "/api/auth/providers",
            ], timeout=16)
            try:
                exposed = json.loads(data)
            except ValueError as exc:
                raise Gate("PUBLIC_CADDY_BAD_JSON") from exc
            if exposed != {"enabled": True, "providers": PROVIDERS}:
                raise Gate("PUBLIC_CADDY_PROVIDER_MISMATCH")
            print("PUBLIC_CADDY_PROVIDERS=PASS", flush=True)
            print("PRODUCTION_OAUTH=DEPLOYED", flush=True)
            print("DEPLOYED_COMMIT=" + sha, flush=True)
            print("PUBLIC_PROVIDERS=google,yandex,vk", flush=True)
            print("TELEGRAM=DISABLED", flush=True)
            print("EMAIL_REGISTRATION_GATE=UNCHANGED", flush=True)
            print("DATABASE_MIGRATED=YES", flush=True)
            print("DB_RESTORE_NOT_PERFORMED=YES", flush=True)
        except Exception:
            if changed:
                print("ROLLBACK=STARTED", flush=True)
                # New nullable schema is compatible with the legacy email service.
                # Never restore an old DB and lose any post-migration sessions.
                try:
                    atomic_file(OAUTH_ENV, old_env)
                    atomic_file(CADDY_SITE, old_caddy.encode("utf-8"), None)
                    if DROPIN.exists():
                        DROPIN.unlink()
                    switch_release(BACKEND_ROOT, old_backend)
                    switch_release(STATIC_ROOT, old_static)
                    command(["systemctl", "daemon-reload"], timeout=25)
                    command(["systemctl", "restart", SERVICE], timeout=40)
                    command(["caddy", "validate", "--config", str(CADDY_MAIN)], timeout=30)
                    command(["systemctl", "reload", "caddy.service"], timeout=30)
                    print("ROLLBACK=PASS", flush=True)
                    print("LIVE_DB_SCHEMA_MAY_BE_NULLABLE=" +
                          ("YES" if db_migrated else "NO"), flush=True)
                except Exception:
                    print("ROLLBACK=FAILED_MANUAL_INTERVENTION_REQUIRED", flush=True)
            raise


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        if args.apply:
            rollout(args.sha)
        else:
            preflight(args.sha)
            print("RELEASE_PREFLIGHT=PASS")
            print("DEPLOYMENT_NOT_STARTED=YES")
        return 0
    except Gate as exc:
        print("RELEASE_STATUS=BLOCKED")
        print("FAILURE_CODE=" + exc.code)
        return 1
    except Exception:
        print("RELEASE_STATUS=FAILED")
        print("FAILURE_CODE=UNEXPECTED_RUNTIME")
        return 1


if __name__ == "__main__":
    sys.exit(main())
