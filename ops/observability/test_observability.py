"""Privacy-preserving unit checks only; not a real offsite restore receipt."""
from datetime import datetime, timedelta, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
import json
import os
import stat
import unittest

import backup_guard
import metrics


class BackupGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(prefix="fh45-synthetic-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive_dir = self.root / "backups"
        self.receipt_dir = self.root / "receipts"
        for d in (self.archive_dir, self.receipt_dir):
            d.mkdir(mode=0o700)
        self.archive = self.archive_dir / "fh-finance-20261108T123456000000000Z.pgdump.gpg"
        self.archive.write_bytes(b"synthetic fixture only; not a real GPG archive" * 3)
        self.archive.chmod(0o600)
        self.receipt = self.receipt_dir / "status.json"

    def scripts(self, offsite_ok=True):
        backup = self.root / "backup.sh"
        backup.write_text(f"#!/bin/sh\nprintf '%s\\n' '{self.archive}'\n")
        backup.chmod(0o700)
        offsite = self.root / "upload.sh"
        offsite.write_text("#!/bin/sh\nprintf 'OFFSITE_BACKUP_PASS: synthetic\\n'\n" if offsite_ok else
                           "#!/bin/sh\nexit 1\n")
        offsite.chmod(0o700)
        return backup, offsite

    def test_successful_exit_receipt_and_hash(self):
        backup, offsite = self.scripts()
        self.assertEqual(backup_guard.run_backup(self.archive_dir, self.receipt, backup, offsite)["gate"], "PASS")
        self.assertEqual(stat.S_IMODE(self.receipt.stat().st_mode), 0o600)
        result = backup_guard.verify(self.archive_dir, self.receipt, 8)
        self.assertEqual(result["gate"], "PASS")
        self.assertFalse(result["independent_restore_verified"])

    def test_offsite_failure_never_writes_success_receipt(self):
        backup, offsite = self.scripts(offsite_ok=False)
        with self.assertRaisesRegex(backup_guard.GateError, "OFFSITE_COMMAND_FAILED"):
            backup_guard.run_backup(self.archive_dir, self.receipt, backup, offsite)
        self.assertFalse(self.receipt.exists())

    def test_incomplete_and_tampered_archive_fail(self):
        backup, offsite = self.scripts()
        backup_guard.run_backup(self.archive_dir, self.receipt, backup, offsite)
        self.archive.write_bytes(b"truncated")
        with self.assertRaises(backup_guard.GateError):
            backup_guard.verify(self.archive_dir, self.receipt, 8)
        self.archive.write_bytes(b"X" * 100)
        self.archive.chmod(0o600)
        with self.assertRaisesRegex(backup_guard.GateError, "BACKUP_CHECKSUM_MISMATCH"):
            backup_guard.verify(self.archive_dir, self.receipt, 8)

    def test_stale_and_symlink_receipt_fail(self):
        backup, offsite = self.scripts()
        backup_guard.run_backup(self.archive_dir, self.receipt, backup, offsite)
        old = datetime.now(timezone.utc) + timedelta(hours=9)
        with self.assertRaisesRegex(backup_guard.GateError, "BACKUP_STALE"):
            backup_guard.verify(self.archive_dir, self.receipt, 8, now=old)
        target = self.receipt_dir / "real.json"
        self.receipt.replace(target)
        self.receipt.symlink_to(target)
        with self.assertRaises(backup_guard.GateError):
            backup_guard.verify(self.archive_dir, self.receipt, 8)

    def test_old_partial_backup_fails(self):
        backup, offsite = self.scripts()
        backup_guard.run_backup(self.archive_dir, self.receipt, backup, offsite)
        partial = self.archive_dir / "fh-finance-incomplete.partial"
        partial.write_bytes(b"incomplete")
        old = datetime.now().timestamp() - 3600
        os.utime(partial, (old, old))
        with self.assertRaisesRegex(backup_guard.GateError, "ABANDONED_PARTIAL_BACKUP"):
            backup_guard.verify(self.archive_dir, self.receipt, 8)


class MetricsTests(unittest.TestCase):
    def test_alerts_are_redacted_and_sustained(self):
        samples = [{"cpu_percent": 92, "ram_percent": 91, "disk_free_percent": 8,
                    "postgres": {"connections_percent": 80, "lock_waiters": 1}} for _ in range(3)]
        result = metrics.alerts(samples)
        self.assertEqual(result["gate"], "FAIL")
        codes = {a["code"] for a in result["alerts"]}
        self.assertTrue({"CPU_SUSTAINED", "MEMORY_SUSTAINED", "DISK_CRITICAL",
                         "POSTGRES_CONNECTIONS_HIGH", "POSTGRES_LOCK_WAITERS"} <= codes)
        self.assertNotIn("email", json.dumps(result))

    def test_empty_alert_samples_blocked(self):
        with self.assertRaises(metrics.GateError):
            metrics.alerts([])

    def test_health_probe_only_fixed_paths(self):
        for url in ("https://example.com/secret", "http://user:pass@localhost/healthz",
                    "http://localhost/healthz?token=x"):
            with self.assertRaises(metrics.GateError):
                metrics.probe(url)

    def test_linux_resources_without_database(self):
        if not Path("/proc/stat").exists():
            self.skipTest("Linux-specific probe")
        result = metrics.sample_resources(Path("/tmp"), with_db=False, interval=0.01)
        self.assertEqual(result["gate"], "PASS")
        self.assertEqual(result["postgres"], "NOT_RUN")
        self.assertGreaterEqual(result["disk_free_percent"], 0)


if __name__ == "__main__":
    unittest.main()
