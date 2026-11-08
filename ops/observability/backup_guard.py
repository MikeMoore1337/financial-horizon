#!/usr/bin/env python3
"""Record a successful encrypted PostgreSQL backup + offsite upload; fail closed.

Receipt asserts successful execution of #66's uploader, not an independent
restore, a remote availability check, or a cryptographic proof of backup data.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile

ARCHIVE_RE = re.compile(r"fh-finance-[0-9TZ]+\.pgdump\.gpg\Z")


class GateError(Exception):
    pass


def secure_file(path: Path, *, mode: int = 0o600) -> None:
    try:
        st = path.lstat()
    except OSError as exc:
        raise GateError("FILE_MISSING") from exc
    if not stat.S_ISREG(st.st_mode) or stat.S_IMODE(st.st_mode) != mode or st.st_size < 32:
        raise GateError("UNSAFE_OR_INCOMPLETE_FILE")


def secure_directory(directory: Path) -> None:
    try:
        st = directory.lstat()
    except OSError as exc:
        raise GateError("DIRECTORY_MISSING") from exc
    if not stat.S_ISDIR(st.st_mode) or stat.S_IMODE(st.st_mode) != 0o700:
        raise GateError("UNSAFE_DIRECTORY")


def checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for piece in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(piece)
    return digest.hexdigest()


def check_archive(backup_dir: Path, archive: Path) -> None:
    secure_directory(backup_dir)
    if archive.parent.resolve() != backup_dir.resolve() or not ARCHIVE_RE.fullmatch(archive.name):
        raise GateError("UNEXPECTED_ARCHIVE")
    secure_file(archive)


def run_backup(backup_dir: Path, receipt: Path, backup_script: Path,
               offsite_script: Path) -> dict:
    secure_directory(backup_dir)
    secure_directory(receipt.parent)
    if receipt.is_symlink():
        raise GateError("UNSAFE_RECEIPT")
    for script in (backup_script, offsite_script):
        if not script.is_file() or script.is_symlink():
            raise GateError("SCRIPT_MISSING")
    # Do not return child stdout/stderr: external backup tools can emit secrets.
    try:
        backup = subprocess.run([str(backup_script)], check=False, capture_output=True,
                                text=True, timeout=900)
        if backup.returncode:
            raise GateError("BACKUP_COMMAND_FAILED")
        lines = backup.stdout.strip().splitlines()
        if len(lines) != 1:
            raise GateError("BACKUP_OUTPUT_INVALID")
        archive = Path(lines[0])
        if not archive.is_absolute():
            raise GateError("BACKUP_OUTPUT_INVALID")
        check_archive(backup_dir, archive)
        offsite = subprocess.run([str(offsite_script), str(archive)], check=False,
                                 capture_output=True, text=True, timeout=300)
        if offsite.returncode or "OFFSITE_BACKUP_PASS:" not in offsite.stdout:
            raise GateError("OFFSITE_COMMAND_FAILED")
    except subprocess.TimeoutExpired as exc:
        raise GateError("BACKUP_TIMED_OUT") from exc
    # Record only after exact encrypted artifact passed the existing uploader.
    record = {"schema": 1, "archive": archive.name, "sha256": checksum(archive),
              "completed_at_utc": datetime.now(timezone.utc).isoformat(),
              "source": "successful_backup_and_offsite_upload"}
    fd, temp = tempfile.mkstemp(prefix=".fh45-receipt-", dir=receipt.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            os.fchmod(handle.fileno(), 0o600)
            json.dump(record, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, receipt)
        # fsync directory to preserve rename across crashes.
        dfd = os.open(receipt.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return {"gate": "PASS", "backup_and_offsite_recorded": True}


def verify(backup_dir: Path, receipt: Path, max_age_hours: float,
           now: datetime | None = None) -> dict:
    if not (0.1 <= max_age_hours <= 720):
        raise GateError("AGE_LIMIT_INVALID")
    secure_directory(backup_dir)
    secure_directory(receipt.parent)
    secure_file(receipt)
    try:
        record = json.loads(receipt.read_text(encoding="utf-8"))
        if (record.get("schema") != 1 or record.get("source") != "successful_backup_and_offsite_upload"
                or not isinstance(record.get("archive"), str)
                or not isinstance(record.get("sha256"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", record["sha256"])):
            raise GateError("RECEIPT_INVALID")
        stamp = datetime.fromisoformat(record["completed_at_utc"])
        if stamp.tzinfo is None:
            raise GateError("RECEIPT_INVALID")
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        raise GateError("RECEIPT_INVALID") from exc
    now = now or datetime.now(timezone.utc)
    age = (now - stamp).total_seconds() / 3600
    if not (-5 / 60 <= age <= max_age_hours):
        raise GateError("BACKUP_STALE")
    archive = backup_dir / record["archive"]
    check_archive(backup_dir, archive)
    if checksum(archive) != record["sha256"]:
        raise GateError("BACKUP_CHECKSUM_MISMATCH")
    # Only flag abandoned partial files; a new live upload may be in progress.
    for partial in backup_dir.glob("*.partial"):
        if partial.is_symlink() or now.timestamp() - partial.stat().st_mtime > 1200:
            raise GateError("ABANDONED_PARTIAL_BACKUP")
    return {"gate": "PASS", "age_hours": round(max(0, age), 3),
            "local_sha256_matches_receipt": True,
            "offsite_uploader_returned_success": True,
            "independent_restore_verified": False}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["run", "verify"])
    parser.add_argument("--backup-dir", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--backup-script", type=Path)
    parser.add_argument("--offsite-script", type=Path)
    parser.add_argument("--max-age-hours", type=float, default=8)
    args = parser.parse_args(argv)
    try:
        if args.mode == "run":
            if not (args.backup_script and args.offsite_script):
                raise GateError("BACKUP_SCRIPTS_REQUIRED")
            output = run_backup(args.backup_dir, args.receipt,
                                args.backup_script, args.offsite_script)
        else:
            output = verify(args.backup_dir, args.receipt, args.max_age_hours)
        print(json.dumps({"schema": 1, **output}, sort_keys=True))
        return 0
    except Exception as exc:
        reason = str(exc) if isinstance(exc, GateError) else "BACKUP_CHECK_FAILED"
        print(json.dumps({"schema": 1, "gate": "FAIL", "reason": reason}, sort_keys=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
