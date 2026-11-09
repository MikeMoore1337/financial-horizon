#!/usr/bin/python3
"""Root-owned, forced-command, static-only Financial Horizon deploy endpoint.

Installed separately from application releases. No attacker-controlled source is
executed on the host. Only a validated dist/ tarball may be published.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path('/srv/www/fin-horizon')
STATE = Path('/var/lib/fh-static-deploy')
HOST = 'fin-horizon.mikemoore.top'
ORIGIN_PORT = 8444  # Caddy origin; public :443 is owned by Xray on this VPS
ORIGIN_CA = Path('/usr/local/lib/financial-horizon/certs/cloudflare-origin-rsa-root.pem')
ORIGIN_CA_SHA256 = '91a8a5567efa6bf941162aa806b3ba476aaddf7867640e53053b35fb225a5dae'
REPO = 'MikeMoore1337/financial-horizon'
MAX_ARCHIVE = 30_000_000
MAX_UNPACKED = 90_000_000
MAX_FILES = 3000
MAX_FILE = 20_000_000
REQUIRED_FILES = {'index.html', 'account.html', 'sw.js', 'manifest.webmanifest', '__release.json'}
COMMAND = re.compile(r'^deploy ([0-9a-f]{40}) ([0-9a-f]{64})$')


class DeployFailure(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def parse_command(value: str) -> tuple[str, str]:
    match = COMMAND.fullmatch(value)
    if not match:
        raise DeployFailure('COMMAND_REJECTED')
    return match.group(1), match.group(2)


def validated_members(archive: tarfile.TarFile, sha: str) -> list[tarfile.TarInfo]:
    seen: set[str] = set()
    files: set[str] = set()
    members: list[tarfile.TarInfo] = []
    for member in archive:
        members.append(member)
        if len(members) > MAX_FILES:
            raise DeployFailure('ARCHIVE_ENTRY_COUNT')
    if not members:
        raise DeployFailure('ARCHIVE_ENTRY_COUNT')
    total = 0
    for member in members:
        path = PurePosixPath(member.name)
        parts = path.parts
        if (path.as_posix() != member.name.rstrip('/')
                or path.is_absolute() or len(parts) < 1 or parts[0] != 'dist'
                or any(p in ('', '.', '..') or p.startswith('.') for p in parts[1:])
                or '\\' in member.name or any(ord(c) < 32 for c in member.name)):
            raise DeployFailure('ARCHIVE_PATH_REJECTED')
        if member.name in seen:
            raise DeployFailure('ARCHIVE_DUPLICATE_PATH')
        seen.add(member.name)
        if not (member.isfile() or member.isdir()):
            raise DeployFailure('ARCHIVE_UNSAFE_ENTRY')
        if member.isfile():
            if len(parts) < 2 or not 0 <= member.size <= MAX_FILE:
                raise DeployFailure('ARCHIVE_FILE_SIZE')
            total += member.size
            files.add('/'.join(parts[1:]))
        if total > MAX_UNPACKED:
            raise DeployFailure('ARCHIVE_UNPACKED_TOO_LARGE')
    if not REQUIRED_FILES.issubset(files):
        raise DeployFailure('ARCHIVE_REQUIRED_FILES_MISSING')
    try:
        obj = json.loads(archive.extractfile('dist/__release.json').read(MAX_FILE + 1))
    except (ValueError, TypeError, KeyError, AttributeError, OSError) as exc:
        raise DeployFailure('ARCHIVE_MANIFEST_INVALID') from exc
    if (not isinstance(obj, dict) or set(obj) != {'repository', 'source_sha', 'run_id'}
            or obj['repository'] != REPO or obj['source_sha'] != sha
            or type(obj['run_id']) is not int or obj['run_id'] <= 0):
        raise DeployFailure('ARCHIVE_MANIFEST_MISMATCH')
    return members


def extract_static(payload: bytes, sha: str, output: Path) -> None:
    if len(payload) > MAX_ARCHIVE:
        raise DeployFailure('ARCHIVE_COMPRESSED_TOO_LARGE')
    try:
        with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as tf:
            entries = validated_members(tf, sha)
            for member in entries:
                parts = PurePosixPath(member.name).parts
                path = output.joinpath(*parts)
                if member.isdir():
                    path.mkdir(parents=True, exist_ok=True)
                    path.chmod(0o755)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    # Do not follow symlinks, and never execute files from dist.
                    with path.open('xb') as dest:
                        source = tf.extractfile(member)
                        if source is None:
                            raise DeployFailure('ARCHIVE_FILE_MISSING')
                        shutil.copyfileobj(source, dest, length=1024 * 1024)
                        dest.flush()
                        os.fsync(dest.fileno())
                    path.chmod(0o644)
            for directory in sorted(output.rglob('*'), key=lambda p: len(p.parts), reverse=True):
                if directory.is_dir():
                    directory.chmod(0o755)
    except (tarfile.TarError, EOFError, OSError) as exc:
        raise DeployFailure('ARCHIVE_EXTRACT_FAILED') from exc


def current_release(root: Path) -> Path:
    releases = root / 'releases'
    current = root / 'current'
    if not current.is_symlink() or not releases.is_dir() or releases.is_symlink():
        raise DeployFailure('RELEASE_LAYOUT_UNKNOWN')
    try:
        resolved = current.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise DeployFailure('RELEASE_LINK_BROKEN') from exc
    if resolved.parent != releases.resolve() or not resolved.is_dir():
        raise DeployFailure('RELEASE_LINK_OUTSIDE_ROOT')
    return resolved


def atomic_switch(root: Path, release: Path) -> None:
    if release.parent != (root / 'releases') or not release.is_dir() or release.is_symlink():
        raise DeployFailure('RELEASE_TARGET_INVALID')
    path = root / 'current'
    temp = root / '.incoming-fh-current'
    if temp.exists() or temp.is_symlink():
        raise DeployFailure('RELEASE_SWITCH_CONFLICT')
    try:
        temp.symlink_to(release)
        os.replace(temp, path)
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        temp.unlink(missing_ok=True)


def write_atomic(path: Path, content: bytes) -> None:
    fd, tmp = tempfile.mkstemp(prefix='.fh-receipt-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def verify_origin_ca() -> None:
    """Fail closed unless the pinned Cloudflare RSA trust anchor is root-controlled."""
    try:
        for directory in (ORIGIN_CA.parent.parent, ORIGIN_CA.parent):
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or (
                    info.st_mode & (stat.S_IWGRP | stat.S_IWOTH)):
                raise DeployFailure('ORIGIN_CA_DIR_UNSAFE')
        info = ORIGIN_CA.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or
                info.st_mode & (stat.S_IWGRP | stat.S_IWOTH) or info.st_size > 8192):
            raise DeployFailure('ORIGIN_CA_FILE_UNSAFE')
        with ORIGIN_CA.open('rb') as handle:
            content = handle.read(8193)
    except OSError as exc:
        raise DeployFailure('ORIGIN_CA_MISSING') from exc
    if hashlib.sha256(content).hexdigest() != ORIGIN_CA_SHA256:
        raise DeployFailure('ORIGIN_CA_HASH_MISMATCH')


def probe_release(sha: str) -> None:
    verify_origin_ca()

    def fetch(path: str) -> bytes:
        args = [
            '/usr/bin/curl', '--silent', '--show-error', '--fail', '--noproxy', '*',
            '--max-time', '8', '--max-redirs', '0',
            '--cacert', str(ORIGIN_CA),
            '--resolve', f'{HOST}:{ORIGIN_PORT}:127.0.0.1',
            '--write-out', '\\n%{http_code}',
            '-H', 'Cache-Control: no-store', f'https://{HOST}:{ORIGIN_PORT}/{path}',
        ]
        result = subprocess.run(args, capture_output=True, timeout=12, check=False)
        if result.returncode != 0 or not result.stdout or len(result.stdout) > 2_000_000:
            raise DeployFailure('HTTPS_SMOKE_FAILED')
        body, separator, status = result.stdout.rpartition(b'\\n')
        if not separator or status != b'200' or not body:
            raise DeployFailure('HTTPS_SMOKE_STATUS')
        return body

    try:
        manifest = json.loads(fetch(f'__release.json?sha={sha}'))
    except (ValueError, UnicodeError) as exc:
        raise DeployFailure('HTTPS_RELEASE_MISMATCH') from exc
    if manifest.get('source_sha') != sha or manifest.get('repository') != REPO:
        raise DeployFailure('HTTPS_RELEASE_MISMATCH')
    for path in ('index.html', 'account.html', 'sw.js', 'manifest.webmanifest'):
        fetch(path)
    for service in ('caddy.service', 'fh-email-auth.service'):
        if subprocess.run(['/usr/bin/systemctl', 'is-active', '--quiet', service],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          check=False).returncode:
            raise DeployFailure('SERVICE_NOT_READY')


def ensure_safe_layout(root: Path, state: Path) -> None:
    for path in (root, root / 'releases', state):
        if path.is_symlink() or not path.is_dir():
            raise DeployFailure('PRIVILEGED_LAYOUT_INVALID')
        info = path.stat()
        if info.st_uid != 0 or info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise DeployFailure('PRIVILEGED_LAYOUT_PERMISSIONS')
    current_release(root)


def deploy(payload: bytes, sha: str, digest: str, root: Path, state: Path,
           health=probe_release) -> str:
    if hashlib.sha256(payload).hexdigest() != digest:
        raise DeployFailure('ARCHIVE_HASH_MISMATCH')
    previous = current_release(root)
    target = root / 'releases' / sha
    if target == previous:
        health(sha)
        return f'ALREADY_DEPLOYED={sha}'
    if target.exists() or target.is_symlink():
        raise DeployFailure('RELEASE_ALREADY_EXISTS')
    temp = Path(tempfile.mkdtemp(prefix=f'.incoming-fh-{sha[:12]}-', dir=root / 'releases'))
    switched = False
    installed = False
    try:
        extract_static(payload, sha, temp)
        os.replace(temp / 'dist', target)
        installed = True
        atomic_switch(root, target)
        switched = True
        health(sha)
        receipt = json.dumps({'source_sha': sha, 'archive_sha256': digest,
                              'previous_release': previous.name}, sort_keys=True).encode() + b'\n'
        write_atomic(state / f'{sha}.json', receipt)
        write_atomic(state / 'last-success.sha', (sha + '\n').encode())
        return f'PRODUCTION_DEPLOYED={sha}'
    except Exception as exc:
        if switched:
            try:
                atomic_switch(root, previous)
            except Exception as rollback_error:
                raise DeployFailure('ROLLBACK_FAILED') from rollback_error
        if installed:
            shutil.rmtree(target)
        if isinstance(exc, DeployFailure):
            raise
        raise DeployFailure('RELEASE_FAILED') from exc
    finally:
        shutil.rmtree(temp, ignore_errors=True)


def run() -> int:
    try:
        if os.geteuid() != 0:
            raise DeployFailure('ROOT_REQUIRED')
        sha, digest = parse_command(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
        ensure_safe_layout(ROOT, STATE)
        with open('/run/lock/fh-static-deploy.lock', 'a+b') as lock:
            import fcntl
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise DeployFailure('DEPLOYMENT_ALREADY_RUNNING') from exc
            payload = sys.stdin.buffer.read(MAX_ARCHIVE + 1)
            if len(payload) > MAX_ARCHIVE:
                raise DeployFailure('ARCHIVE_COMPRESSED_TOO_LARGE')
            print(deploy(payload, sha, digest, ROOT, STATE), flush=True)
        return 0
    except DeployFailure as exc:
        print(f'FH_DEPLOY_FAILED={exc.code}', file=sys.stderr, flush=True)
        return 1
    except Exception:
        print('FH_DEPLOY_FAILED=UNEXPECTED_ERROR', file=sys.stderr, flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(run())
