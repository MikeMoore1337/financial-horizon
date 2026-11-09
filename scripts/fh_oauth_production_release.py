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
import pwd
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
USER_COLUMNS = ("id", "email", "password_hash", "verified_at",
                "password_changed_at", "disabled", "created_at")


class Gate(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def command(args: list[str], *, timeout: int = 1200, cwd: Path | None = None,
            env: dict[str, str] | None = None,
            failure_code: str | None = None) -> bytes:
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       cwd=cwd, env=env, timeout=timeout, check=False)
    if p.returncode:
        # Never expose unfiltered pip, subprocess or OAuth output: it may hold
        # tokens, local paths or secrets. Stable operation codes identify the step.
        raise Gate(failure_code or "COMMAND_FAILED_" + re.sub(
            r"[^A-Z0-9_]", "_", Path(args[0]).name.upper()))
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


def save_private_release_receipt(prefix: str, content: bytes) -> None:
    fd, filename = tempfile.mkstemp(
        prefix="fh-oauth-release-" + prefix + "-", suffix=".backup", dir=BACKUPS
    )
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        Path(filename).unlink(missing_ok=True)
        raise


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


def safe_uvicorn_argv(process_args: list[str], expected_port: int) -> list[str]:
    """Preserve known Uvicorn flags for a new release-private systemd ExecStart.

    The old deployment copied backend/current without its .venv. Switching the
    current link can therefore leave the previous ExecStart missing (203/EXEC).
    Unsupported argv layouts fail closed, without changing listening policy.
    """
    if not process_args:
        raise Gate("AUTH_EXEC_PROCESS_MISSING")
    executable = Path(process_args[0]).name
    if executable in {"python", "python3", "python3.11", "python3.12",
                      "python3.13", "python3.14"}:
        if process_args[1:3] == ["-m", "uvicorn"]:
            rest = process_args[3:]
        elif (len(process_args) >= 3 and
              Path(process_args[1]).name in {"uvicorn", "uvicorn3"} and
              Path(process_args[1]).is_absolute()):
            # Shebang-launched console scripts appear under /proc/PID/cmdline
            # as Python followed by the absolute uvicorn entrypoint path.
            rest = process_args[2:]
        else:
            raise Gate("AUTH_EXEC_LAYOUT_UNSUPPORTED")
    elif executable in {"uvicorn", "uvicorn3"}:
        rest = process_args[1:]
    else:
        raise Gate("AUTH_EXEC_LAYOUT_UNSUPPORTED")
    if not rest or rest[0] != "fh_email_auth.app:app":
        raise Gate("AUTH_EXEC_APP_UNEXPECTED")
    switches = {
        "--no-access-log", "--proxy-headers", "--no-proxy-headers",
        "--no-server-header", "--no-date-header",
    }
    values = {
        "--host", "--port", "--workers", "--log-level", "--loop",
        "--http", "--lifespan", "--timeout-keep-alive", "--backlog",
        "--forwarded-allow-ips", "--interface",
    }
    seen: dict[str, str] = {}
    flags: set[str] = set()
    argv = [rest[0]]
    index = 1
    while index < len(rest):
        item = rest[index]
        if item in switches:
            if item in flags:
                raise Gate("AUTH_EXEC_DUPLICATE_SWITCH")
            flags.add(item)
            argv.append(item)
            index += 1
            continue
        key, sep, inline_value = item.partition("=")
        if key not in values or key in seen:
            raise Gate("AUTH_EXEC_UNKNOWN_OR_DUPLICATE_OPTION")
        if sep:
            value = inline_value
            index += 1
        else:
            if index + 1 >= len(rest):
                raise Gate("AUTH_EXEC_OPTION_MISSING_VALUE")
            value = rest[index + 1]
            index += 2
        if not re.fullmatch(r"[A-Za-z0-9_.,:/\*-]+", value):
            raise Gate("AUTH_EXEC_UNSAFE_OPTION_VALUE")
        seen[key] = value
        argv.extend((key, value))
    if seen.get("--host") != "127.0.0.1" or seen.get("--port") != str(expected_port):
        raise Gate("AUTH_EXEC_BINDING_MISMATCH")
    if "--no-access-log" not in flags:
        raise Gate("AUTH_EXEC_ACCESS_LOG_NOT_DISABLED")
    if "--proxy-headers" in flags and "--no-proxy-headers" in flags:
        raise Gate("AUTH_EXEC_CONFLICTING_OPTIONS")
    for key in ("--workers", "--backlog", "--timeout-keep-alive"):
        if key in seen and not seen[key].isdigit():
            raise Gate("AUTH_EXEC_NONNUMERIC_OPTION")
    return argv


def ensure_supported_systemd_launch() -> None:
    unit_type = command(
        ["systemctl", "show", "--value", "-p", "Type", SERVICE],
        timeout=12, failure_code="AUTH_SYSTEMD_TYPE_UNKNOWN",
    ).decode().strip()
    if unit_type not in ("simple", "exec"):
        raise Gate("AUTH_SYSTEMD_TYPE_UNSUPPORTED")


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


def stage_isolated_python(auth_py: Path, new_backend: Path,
                          source: Path) -> str:
    """Install all auth dependencies in a NEW release-only venv, never live.

    The currently running service keeps its original Python executable.
    A post-switch systemd PYTHONPATH prepends the new venv's site-packages,
    preserving any existing PYTHONPATH for source-module discovery.
    """
    target = new_backend / ".oauth-venv"
    if not new_backend.is_dir() or target.exists() or target.is_symlink():
        raise Gate("ISOLATED_VENV_TARGET_INVALID")
    requirements = source / "backend" / "requirements.txt"
    if not requirements.is_file():
        raise Gate("REQUIREMENTS_NOT_FOUND")
    try:
        # Some production Python installations use uv-built virtualenvs
        # without pip/ensurepip. Prefer uv when present, otherwise use the
        # standard venv+pip path. Both targets are release-private.
        uv = shutil.which("uv")
        if uv:
            command([uv, "venv", "--python", str(auth_py), str(target)],
                    timeout=120, failure_code="ISOLATED_VENV_CREATION_FAILED")
        else:
            command([str(auth_py), "-m", "venv", "--copies", str(target)],
                    timeout=120, failure_code="ISOLATED_VENV_CREATION_FAILED")
        isolated_py = target / "bin" / "python"
        if not isolated_py.is_file():
            raise Gate("ISOLATED_VENV_PYTHON_MISSING")
        if uv:
            command([uv, "pip", "install", "--python", str(isolated_py),
                     "--link-mode", "copy", "--no-progress", "-r", str(requirements)],
                    timeout=360, failure_code="ISOLATED_DEPS_INSTALL_FAILED")
        else:
            command([str(isolated_py), "-m", "pip", "install", "--no-input",
                     "--disable-pip-version-check", "--require-virtualenv",
                     "-r", str(requirements)],
                    timeout=360, failure_code="ISOLATED_DEPS_INSTALL_FAILED")
        modules = "import fastapi, uvicorn, httpx, pwdlib, joserfc, cryptography"
        command([str(isolated_py), "-c", modules],
                timeout=30, failure_code="ISOLATED_DEPS_IMPORT_FAILED")
        site = command(
            [str(isolated_py), "-c",
             "import sysconfig; print(sysconfig.get_path('purelib'))"],
            timeout=30, failure_code="ISOLATED_SITE_QUERY_FAILED",
        ).decode("utf-8", errors="strict").strip()
        if (not site or not re.fullmatch(r"/[A-Za-z0-9_./-]+", site) or
                not Path(site).is_relative_to(target) or
                not Path(site).is_dir()):
            raise Gate("ISOLATED_SITE_PATH_INVALID")
        return site
    except Exception:
        # This path belongs exclusively to this staged release.
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        raise


def service_python_path(isolated_site: str, process_env: dict[str, str],
                        staged_modules: str | None = None) -> str:
    old_path = process_env.get("PYTHONPATH", "")
    if old_path and not re.fullmatch(r"[/A-Za-z0-9_.:-]+", old_path):
        raise Gate("EXISTING_PYTHONPATH_UNEXPECTED")
    # The prior release only prepended site-packages: uvicorn could import
    # the old backend through its inherited PYTHONPATH or --app-dir instead.
    parts = [staged_modules, isolated_site, old_path]
    result = os.pathsep.join(p for p in parts if p)
    if not re.fullmatch(r"[/A-Za-z0-9_.:-]+", result):
        raise Gate("ISOLATED_PYTHONPATH_INVALID")
    return result


def schema_is_nullable(path: Path) -> bool:
    """Read the real SQLite schema without creating files or altering rows."""
    if path == CANARY_DB or path.is_symlink() or not path.is_file():
        raise Gate("AUTH_DB_NOT_ALLOWED")
    with closing(sqlite3.connect(
        "file:" + quote(str(path), safe="/") + "?mode=ro", uri=True,
        timeout=12,
    )) as conn:
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise Gate("LIVE_DB_INTEGRITY")
        if conn.execute("PRAGMA foreign_key_check").fetchall():
            raise Gate("LIVE_DB_FOREIGN_KEYS")
        columns = conn.execute("PRAGMA table_info(users)").fetchall()
        if tuple(c[1] for c in columns) != USER_COLUMNS or columns[1][3] not in (0, 1):
            raise Gate("MIGRATION_SCHEMA_UNEXPECTED")
        if conn.execute(
            "SELECT count(*) FROM sqlite_master WHERE tbl_name='users' "
            "AND type IN ('index','trigger') AND sql IS NOT NULL"
        ).fetchone()[0]:
            raise Gate("USERS_SCHEMA_CUSTOMIZATION_UNEXPECTED")
        return columns[1][3] == 0


def staged_modules_root(new_backend: Path) -> Path:
    """Locate source packages under the staged release, not the old live tree."""
    roots = [entry.parent.parent for entry in
             new_backend.rglob("fh_email_auth/app.py") if entry.is_file()]
    if len(roots) != 1 or not (roots[0] / "fh_auth" / "app.py").is_file():
        raise Gate("STAGED_AUTH_PACKAGES_NOT_FOUND")
    parent = roots[0]
    if parent.is_symlink() or not parent.resolve().is_relative_to(new_backend.resolve()):
        raise Gate("STAGED_AUTH_PACKAGE_PATH_INVALID")
    return parent


def grant_staged_release_read_access(stage: Path, *, user: str) -> None:
    """Keep staged files root-owned and writable only by root.

    Group-read/traverse is granted strictly within the newly created backend
    release to the service account's primary group. No active release, system
    packages, symlink target or shared hardlinked inode may be changed.
    """
    if (stage.is_symlink() or not stage.is_dir() or
            stage.parent.resolve() != (BACKEND_ROOT / "releases").resolve()):
        raise Gate("STAGED_RELEASE_OWNERSHIP_SCOPE_INVALID")
    stage_owner = stage.lstat().st_uid
    if stage_owner != os.geteuid():
        raise Gate("STAGED_RELEASE_NOT_OWNED_BY_OPERATOR")
    try:
        account = pwd.getpwnam(user)
    except KeyError as exc:
        raise Gate("SERVICE_ACCOUNT_NOT_FOUND") from exc
    if account.pw_uid == 0 or account.pw_gid == 0:
        raise Gate("SERVICE_ACCOUNT_PRIVILEGED")
    candidates: list[tuple[Path, os.stat_result]] = []
    for current, directories, files in os.walk(stage, followlinks=False):
        for name in [".", *directories, *files]:
            candidate = Path(current) if name == "." else Path(current) / name
            info = candidate.lstat()
            if stat.S_ISLNK(info.st_mode):
                continue
            if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise Gate("STAGED_RELEASE_SPECIAL_FILE")
            if info.st_uid != stage_owner:
                raise Gate("STAGED_RELEASE_NOT_OPERATOR_OWNED")
            if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
                raise Gate("STAGED_RELEASE_SHARED_HARDLINK")
            candidates.append((candidate, info))
    for candidate, info in candidates:
        mode = stat.S_IMODE(info.st_mode)
        # Root remains the only writer. The service user can traverse
        # directories, read code and dependencies, and execute binaries.
        group_bits = (0o50 if stat.S_ISDIR(info.st_mode) else
                      0o40 | (0o10 if mode & 0o100 else 0))
        safe_mode = (mode | group_bits) & ~0o020
        os.chown(candidate, -1, account.pw_gid, follow_symlinks=False)
        os.chmod(candidate, safe_mode, follow_symlinks=False)


def verify_service_user_module_access(auth_py: Path, source_root: Path,
                                      check_env: dict[str, str],
                                      staged_release: Path | None = None) -> None:
    """Check staging under the same user and working directory as systemd."""
    user = command(["systemctl", "show", "--value", "-p", "User", SERVICE],
                   timeout=15, failure_code="SERVICE_USER_UNAVAILABLE").decode().strip()
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*", user):
        raise Gate("SERVICE_USER_INVALID")
    try:
        account = pwd.getpwnam(user)
    except KeyError as exc:
        raise Gate("SERVICE_ACCOUNT_NOT_FOUND") from exc
    if staged_release is not None:
        grant_staged_release_read_access(staged_release, user=user)
    if "PYTHONPATH" not in check_env:
        raise Gate("STAGED_PYTHONPATH_MISSING")
    service_env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": account.pw_dir,
        "PYTHONPATH": check_env["PYTHONPATH"],
        "PYTHONNOUSERSITE": "1",
    }
    # Inheriting /root or a private operator working directory would produce
    # a false negative even if systemd's configured WorkingDirectory is fine.
    command(["runuser", "-u", user, "--", "test", "-x", str(source_root)],
            timeout=15, cwd=source_root, env=service_env,
            failure_code="STAGED_SOURCE_NOT_TRAVERSABLE")
    for package in ("fh_email_auth", "fh_auth"):
        command(["runuser", "-u", user, "--", "test", "-r",
                 str(source_root / package / "__init__.py")],
                timeout=15, cwd=source_root, env=service_env,
                failure_code="STAGED_SOURCE_NOT_READABLE")
    check = (
        "import importlib.util,pathlib,sys; root=pathlib.Path(sys.argv[1]); "
        "assert all(pathlib.Path(importlib.util.find_spec(p).origin).parent == "
        "root / p for p in sys.argv[2].split(','))"
    )
    command(["runuser", "-u", user, "--", str(auth_py), "-c", check,
             str(source_root), "fh_email_auth,fh_auth"],
            timeout=30, cwd=source_root, env=service_env,
            failure_code="STAGED_AUTH_IMPORT_AS_SERVICE_USER_FAILED")


def systemd_oauth_dropin(modules_root: Path, python_path: str,
                         runtime_python: Path, uvicorn_args: list[str]) -> bytes:
    """Override old ExecStart and use the verified release-private interpreter."""
    if (not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(modules_root)) or
            not re.fullmatch(r"[/A-Za-z0-9_.:-]+", python_path)):
        raise Gate("SYSTEMD_RELEASE_PATH_INVALID")
    release_root = modules_root.parent if modules_root.name == "backend" else modules_root
    expected = release_root / ".oauth-venv" / "bin" / "python"
    if runtime_python != expected or not runtime_python.is_file():
        raise Gate("RELEASE_PRIVATE_PYTHON_INVALID")
    if not uvicorn_args or uvicorn_args[0] != "fh_email_auth.app:app":
        raise Gate("AUTH_EXEC_APP_UNEXPECTED")
    tokens = [str(runtime_python), "-m", "uvicorn", *uvicorn_args]
    if any(not re.fullmatch(r"[/A-Za-z0-9_.,:/*=-]+", token)
           for token in tokens):
        raise Gate("SYSTEMD_EXECSTART_UNSAFE")
    return (
        "[Service]\n"
        "ExecStart=\n"
        "ExecStart=" + " ".join(tokens) + "\n"
        "WorkingDirectory=" + str(modules_root) + "\n"
        "Environment=\"PYTHONPATH=" + python_path + "\"\n"
        "EnvironmentFile=/etc/financial-horizon/oauth.env\n"
    ).encode("utf-8")


def safe_recent_service_error() -> str:
    """Only emit allowlisted error categories, never raw journal lines."""
    result = subprocess.run(
        ["journalctl", "-u", SERVICE, "--since", "-3 minutes",
         "-n", "180", "-o", "cat", "--no-pager"],
        capture_output=True, text=True, timeout=12, check=False,
    )
    if result.returncode != 0:
        return "JOURNAL_UNAVAILABLE"
    data = result.stdout[-24000:]
    patterns = (
        ("ModuleNotFoundError", "MODULE_NOT_FOUND"),
        ("ImportError", "IMPORT_ERROR"),
        ("PermissionError", "PERMISSION_ERROR"),
        ("sqlite3.OperationalError", "SQLITE_ERROR"),
        ("pydantic_core.ValidationError", "PYDANTIC_ERROR"),
        ("ValueError", "VALIDATION_ERROR"),
        ("Address already in use", "PORT_BIND_ERROR"),
        ("Traceback (most recent call last)", "PYTHON_TRACEBACK_PRESENT"),
    )
    for needle, label in patterns:
        if needle in data:
            return label
    return "NO_MATCHING_ERROR"


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
    # Previous attempts may have migrated users.email before rolling back
    # backend/Caddy. Never force the old NOT NULL schema or restore stale DBs.
    schema_is_nullable(path)
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
    ensure_supported_systemd_launch()
    approved_args = safe_uvicorn_argv(args, port)
    return (back, static, path, staged, caddy, new_caddy,
            port, auth_py, approved_args)


def migrate_live_database(source: Path, db: Path) -> bool:
    """Return True only if migration executed. Already-migrated DB is left as-is."""
    if schema_is_nullable(db):
        print("DB_SCHEMA_MIGRATION=ALREADY_READY", flush=True)
        return False
    migration = source / "backend/fh_auth/migrate.py"
    if not migration.is_file():
        raise Gate("MIGRATION_SCRIPT_MISSING")
    fd, filename = tempfile.mkstemp(prefix="auth-pre-oauth-release-",
                                    suffix=".sqlite3", dir=db.parent)
    os.close(fd)
    Path(filename).unlink()
    command([sys.executable, str(migration), str(db), filename], timeout=90,
            failure_code="AUTH_SCHEMA_MIGRATION_FAILED")
    backup = Path(filename)
    if not backup.is_file() or backup.stat().st_mode & 0o077:
        raise Gate("MIGRATION_BACKUP_INVALID")
    if not schema_is_nullable(db):
        raise Gate("MIGRATION_NOT_EFFECTIVE")
    print("DB_SCHEMA_MIGRATION=APPLIED", flush=True)
    return True


def rollout(sha: str, *, stage_only: bool = False) -> None:
    (old_backend, old_static, db, old_env, old_caddy,
     new_caddy, port, auth_py, approved_args) = preflight(sha)
    print("RELEASE_PREFLIGHT=PASS", flush=True)
    with tempfile.TemporaryDirectory(prefix="fh-oauth-release-") as workdir:
        source = source_archive(sha, Path(workdir))
        backend_candidate = BACKEND_ROOT / "releases" / sha
        static_candidate = STATIC_ROOT / "releases" / sha
        if (backend_candidate.exists() or backend_candidate.is_symlink() or
                static_candidate.exists() or static_candidate.is_symlink()):
            raise Gate("RELEASE_ALREADY_STAGED")
        stage_step = "COPY_BACKEND"
        try:
            new_backend = stage_backend(source, sha, old_backend)
            stage_step = "BUILD_STATIC"
            new_static = stage_static(source, sha)
            stage_step = "CREATE_ISOLATED_PYTHON"
            isolated_site = stage_isolated_python(auth_py, new_backend, source)
            stage_step = "READ_SERVICE_PROCESS"
            _, _, stage_process_env = running_process()
            stage_step = "LOCATE_STAGED_MODULES"
            modules_root = staged_modules_root(new_backend)
            stage_step = "RESOLVE_MODULE_PATH"
            prepared_path = service_python_path(
                isolated_site, stage_process_env, str(modules_root)
            )
            check_env = os.environ.copy()
            check_env["PYTHONPATH"] = prepared_path
            stage_step = "CHECK_LEGACY_INTERPRETER"
            command([str(auth_py), "-c",
                     "import fastapi, uvicorn, httpx, pwdlib, joserfc, cryptography"],
                    timeout=30, env=check_env,
                    failure_code="LIVE_PYTHON_WITH_STAGED_DEPS_FAILED")
            # Find specs without running app-level startup or touching SQLite.
            expected = "fh_email_auth,fh_auth"
            stage_step = "CHECK_NEW_MODULE_IMPORT"
            command([str(auth_py), "-c",
                     "import importlib.util,pathlib,sys; root=pathlib.Path(sys.argv[1]); "
                     "assert all(pathlib.Path(importlib.util.find_spec(p).origin).parent == "
                     "root / p for p in sys.argv[2].split(','))",
                     str(modules_root), expected],
                    timeout=30, env=check_env,
                    failure_code="NEW_AUTH_SOURCE_IMPORT_MISMATCH")
            stage_step = "CHECK_SERVICE_USER_ACCESS"
            verify_service_user_module_access(auth_py, modules_root, check_env,
                                              new_backend)
            # Validate the exact runtime used by the new systemd ExecStart.
            # The original interpreter can disappear when the current symlink
            # changes; do not depend on its executable or shebang at runtime.
            runtime_python = new_backend / ".oauth-venv" / "bin" / "python"
            stage_step = "READ_SERVICE_USER"
            user = command(
                ["systemctl", "show", "--value", "-p", "User", SERVICE],
                timeout=12, failure_code="SERVICE_USER_UNAVAILABLE",
            ).decode().strip()
            if not re.fullmatch(r"[a-z_][a-z0-9_-]*", user):
                raise Gate("SERVICE_USER_INVALID")
            service_env = {
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "PYTHONPATH": prepared_path,
                "PYTHONNOUSERSITE": "1",
            }
            stage_step = "CHECK_PRIVATE_RUNTIME"
            command(
                ["runuser", "-u", user, "--", str(runtime_python), "-c",
                 "import uvicorn,fastapi,fh_email_auth,fh_auth"],
                cwd=modules_root, env=service_env, timeout=30,
                failure_code="NEW_AUTH_RUNTIME_UNREADABLE_BY_SERVICE_USER",
            )
            stage_step = "BUILD_SYSTEMD_DROPIN"
            dropin_content = systemd_oauth_dropin(
                modules_root, prepared_path, runtime_python, approved_args,
            )
            stage_step = "COMPILE_BACKEND"
            command([sys.executable, "-m", "compileall", "-q", str(new_backend)],
                    timeout=45, failure_code="BACKEND_COMPILE_FAILED")
        except Exception:
            print("FAILED_STAGING_STEP=" + stage_step, flush=True)
            # Only delete this run's unactivated candidates, never the
            # symlinked live release or data; make failed staging retry-safe.
            try:
                if (current_release(BACKEND_ROOT) == old_backend and
                        current_release(STATIC_ROOT) == old_static):
                    for candidate in (backend_candidate, static_candidate):
                        if candidate.is_dir() and not candidate.is_symlink():
                            shutil.rmtree(candidate)
                    print("FAILED_STAGING_CLEANED=YES", flush=True)
            except Exception:
                print("FAILED_STAGING_CLEANUP=UNVERIFIED", flush=True)
            raise
        print("ISOLATED_PYTHON_DEPS=PASS", flush=True)
        print("LIVE_AUTH_PYTHON_UNMODIFIED=YES", flush=True)
        print("RELEASE_STAGED=PASS", flush=True)
        # Revalidate after network-dependent staging: other releases or
        # operators may have changed the live service while we built assets.
        _, fresh_args, fresh_env = running_process()
        if (safe_uvicorn_argv(fresh_args, port) != approved_args or
                fresh_env.get("FH_AUTH_DATABASE_PATH") != str(db) or
                private_file(OAUTH_ENV) != old_env or
                CADDY_SITE.read_text(encoding="utf-8") != old_caddy or
                current_release(BACKEND_ROOT) != old_backend or
                current_release(STATIC_ROOT) != old_static):
            raise Gate("LIVE_DEPLOYMENT_CHANGED_DURING_STAGING")
        # Same staging and security checks as production, but never enter
        # the service-stop, database-migration or Caddy activation section.
        # Remove only freshly created, inactive candidate release directories.
        if stage_only:
            if (current_release(BACKEND_ROOT) != old_backend or
                    current_release(STATIC_ROOT) != old_static):
                raise Gate("STAGE_ONLY_RELEASE_CHANGED")
            for candidate, parent in (
                (backend_candidate, BACKEND_ROOT / "releases"),
                (static_candidate, STATIC_ROOT / "releases"),
            ):
                if (candidate.is_symlink() or
                        candidate.parent.resolve(strict=True) != parent.resolve(strict=True) or
                        not candidate.is_dir()):
                    raise Gate("STAGE_ONLY_CLEANUP_SCOPE_INVALID")
                shutil.rmtree(candidate)
            print("STAGE_ONLY=PASS", flush=True)
            print("LIVE_SERVICE_STOPPED=NO", flush=True)
            print("DATABASE_MIGRATED=NO", flush=True)
            print("CADDY_CHANGED=NO", flush=True)
            return
        changed = False
        db_migrated = False
        # Crash-resistant root-only copies before touching live configuration.
        save_private_release_receipt("oauth-env", old_env)
        save_private_release_receipt("caddy", old_caddy.encode("utf-8"))
        print("PROTECTED_CONFIG_BACKUPS=CREATED", flush=True)
        try:
            changed = True
            command(["systemctl", "stop", SERVICE], timeout=25)
            schema_changed_now = migrate_live_database(source, db)
            db_migrated = True
            switch_release(BACKEND_ROOT, new_backend)
            DROPIN.parent.mkdir(parents=True, exist_ok=True)
            atomic_file(DROPIN, dropin_content, 0o644)
            atomic_file(OAUTH_ENV, replace_flags(old_env))
            command(["systemctl", "daemon-reload"], timeout=25)
            command(["systemctl", "start", SERVICE], timeout=30)
            # A systemd active state does not prove Uvicorn is ready yet.
            import time
            deadline = time.monotonic() + 35
            last_reason = "UNKNOWN"
            while True:
                try:
                    validate_running_oauth(port, PROVIDERS)
                    break
                except Gate as exc:
                    last_reason = exc.code
                except (OSError, http.client.HTTPException):
                    last_reason = "AUTH_HTTP_UNREACHABLE"
                if time.monotonic() >= deadline:
                    status = subprocess.run(
                        ["systemctl", "is-active", "--quiet", SERVICE],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        check=False, timeout=12,
                    )
                    print("AUTH_READY_LAST_REASON=" + last_reason, flush=True)
                    print("AUTH_SERVICE_STILL_ACTIVE=" +
                          ("YES" if status.returncode == 0 else "NO"), flush=True)
                    print("AUTH_RECENT_LOG_CATEGORY=" +
                          safe_recent_service_error(), flush=True)
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
            print("DATABASE_MIGRATED=" +
                  ("YES" if schema_changed_now else "ALREADY_READY"), flush=True)
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


def safe_runtime_diagnostics(exc: Exception) -> tuple[str, str, int, int, str]:
    """Report only fixed category and source-function name, never exception text."""
    if isinstance(exc, FileNotFoundError):
        category = "OS_FILE_NOT_FOUND"
    elif isinstance(exc, PermissionError):
        category = "OS_PERMISSION_DENIED"
    elif isinstance(exc, NotImplementedError):
        category = "UNSUPPORTED_OS_OPERATION"
    elif isinstance(exc, subprocess.TimeoutExpired):
        category = "SUBPROCESS_TIMEOUT"
    elif isinstance(exc, OSError):
        category = "OS_ERROR"
    elif isinstance(exc, shutil.Error):
        category = "COPY_ERROR"
    elif isinstance(exc, ValueError):
        category = "VALUE_ERROR"
    elif isinstance(exc, TypeError):
        category = "TYPE_ERROR"
    elif isinstance(exc, AttributeError):
        category = "ATTRIBUTE_ERROR"
    elif isinstance(exc, AssertionError):
        category = "ASSERTION_FAILED"
    else:
        category = "OTHER_ERROR"
    stages = {
        "source_archive", "stage_backend", "stage_static",
        "stage_isolated_python", "staged_modules_root", "service_python_path",
        "grant_staged_release_read_access", "verify_service_user_module_access",
        "safe_uvicorn_argv", "systemd_oauth_dropin", "preflight",
        "rollout", "save_private_release_receipt", "atomic_file",
        "migrate_live_database", "validate_running_oauth",
        "current_release", "switch_release", "command",
        "running_process", "find_auth_python", "ensure_supported_systemd_launch",
        "safe_runtime_diagnostics",
    }
    found = "UNKNOWN"
    inner_line = 0
    rollout_line = 0
    trace = exc.__traceback__
    while trace is not None:
        frame = trace.tb_frame
        if frame.f_code.co_filename == __file__:
            if frame.f_code.co_name == "rollout":
                rollout_line = trace.tb_lineno
            if frame.f_code.co_name in stages:
                # Traceback walks from outermost to innermost: keep the last
                # allowlisted local frame, never the original path/message.
                found = frame.f_code.co_name.upper()
                inner_line = trace.tb_lineno
        trace = trace.tb_next
    target = "NOT_APPLICABLE"
    if isinstance(exc, FileNotFoundError):
        target = "OTHER"
        filename = exc.filename
        if isinstance(filename, str):
            base = Path(filename).name
            if base in {"runuser", "systemctl", "npm", "node", "uv", "test"}:
                target = "COMMAND_" + base.upper()
            elif base in {"python", "python3", "python3.12", "uvicorn"}:
                target = "PYTHON_EXECUTABLE"
            elif filename.startswith(str(BACKEND_ROOT / "releases") + "/"):
                target = "STAGED_BACKEND_RESOURCE"
            elif filename.startswith(str(STATIC_ROOT / "releases") + "/"):
                target = "STAGED_STATIC_RESOURCE"
    return category, found, inner_line, rollout_line, target


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--apply", action="store_true")
    action.add_argument("--stage-only", action="store_true")
    args = parser.parse_args()
    try:
        if args.apply:
            rollout(args.sha)
        elif args.stage_only:
            rollout(args.sha, stage_only=True)
        else:
            preflight(args.sha)
            print("RELEASE_PREFLIGHT=PASS")
            print("DEPLOYMENT_NOT_STARTED=YES")
        return 0
    except Gate as exc:
        print("RELEASE_STATUS=BLOCKED")
        print("FAILURE_CODE=" + exc.code)
        return 1
    except Exception as exc:
        category, stage, inner_line, rollout_line, target = safe_runtime_diagnostics(exc)
        print("SAFE_EXCEPTION_CATEGORY=" + category)
        print("SAFE_EXCEPTION_STAGE=" + stage)
        print("SAFE_EXCEPTION_LINE=" + str(inner_line))
        print("SAFE_ROLLOUT_LINE=" + str(rollout_line))
        print("SAFE_MISSING_RESOURCE=" + target)
        print("RAW_EXCEPTION_PRINTED=NO")
        print("RELEASE_STATUS=FAILED")
        print("FAILURE_CODE=UNEXPECTED_RUNTIME")
        return 1


if __name__ == "__main__":
    sys.exit(main())
