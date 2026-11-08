"""Offline regression tests for the root-only OAuth staged DB binder.

All systemd, production DB, and private env operations are mocked or confined
to TemporaryDirectory. No test contacts a live service or changes Caddy.
"""
from __future__ import annotations

from contextlib import redirect_stdout
import importlib.util
import io
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[2] / "scripts/fh_oauth_bind_live_db.py"
spec = importlib.util.spec_from_file_location("fh_oauth_bind_live_db", SOURCE)
assert spec is not None and spec.loader is not None
binder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(binder)

DB = Path("/var/lib/financial-horizon/private/live-auth.sqlite3")
SECRET = "synthetic-secret-not-for-production-xxxxxxxxxxxx"
STAGED = "\n".join([
    "FH_ENABLE_CLOUD_AUTH=false",
    "FH_TELEGRAM_OAUTH_ENABLED=false",
    "FH_GOOGLE_OAUTH_ENABLED=false",
    "FH_YANDEX_OAUTH_ENABLED=false",
    "FH_VK_OAUTH_ENABLED=false",
    "FH_GOOGLE_OAUTH_CLIENT_ID=synthetic-google-client",
    "FH_GOOGLE_OAUTH_CLIENT_SECRET=synthetic-google-secret",
    "FH_YANDEX_OAUTH_CLIENT_ID=synthetic-yandex-client",
    "FH_YANDEX_OAUTH_CLIENT_SECRET=synthetic-yandex-secret",
    "FH_VK_OAUTH_CLIENT_ID=synthetic-vk-client",
    f"FH_SESSION_SECRET={SECRET}",
    "",
])


class StagedEnvTests(unittest.TestCase):
    def test_key_absent_requires_binding_and_exact_path_is_idempotent(self):
        self.assertFalse(binder.validate_env(STAGED, DB))
        self.assertTrue(binder.validate_env(
            STAGED + "FH_AUTH_DATABASE_PATH=" + str(DB) + "\n", DB
        ))

    def test_duplicate_or_mismatched_database_is_denied(self):
        for staged in (
            STAGED + "FH_AUTH_DATABASE_PATH=/tmp/other.sqlite3\n",
            STAGED + "FH_AUTH_DATABASE_PATH=" + str(DB) + "\n"
                     + "FH_AUTH_DATABASE_PATH=" + str(DB) + "\n",
            STAGED + "FH_OAUTH_DATABASE_PATH=/tmp/canary.sqlite3\n",
            STAGED + " FH_AUTH_DATABASE_PATH =/tmp/other.sqlite3\n",
        ):
            with self.subTest(staged=staged[-80:]):
                with self.assertRaises(binder.Blocked):
                    binder.validate_env(staged, DB)

    def test_disabled_telegram_and_all_other_provider_flags_required(self):
        for flag in binder.FLAGS:
            modified = STAGED.replace(flag + "=false", flag + "=true")
            with self.subTest(flag=flag):
                with self.assertRaises(binder.Blocked):
                    binder.validate_env(modified, DB)

    def test_missing_credentials_or_short_secret_is_denied(self):
        for key in binder.CREDENTIALS:
            modified = STAGED.replace(key + "=", key + "= \n# ")
            # Duplicate stub assignment or missing credential remains fail-closed.
            with self.subTest(key=key):
                with self.assertRaises(binder.Blocked):
                    binder.validate_env(modified, DB)
        with self.assertRaises(binder.Blocked):
            binder.validate_env(
                STAGED.replace("FH_SESSION_SECRET=" + SECRET,
                               "FH_SESSION_SECRET=short"), DB
            )


class FileSafetyTests(unittest.TestCase):
    def test_actual_sqlite_readonly_check_accepts_expected_legacy_schema(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root)
            folder.chmod(0o700)
            db_path = folder / "live.sqlite3"
            with sqlite3.connect(db_path) as db:
                db.executescript("""
                    CREATE TABLE users (
                        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
                        password_hash TEXT NOT NULL DEFAULT '',
                        verified_at INTEGER, password_changed_at INTEGER,
                        disabled INTEGER NOT NULL DEFAULT 0,
                        created_at INTEGER NOT NULL
                    );
                """)
            db_path.chmod(0o600)
            binder.validate_db(db_path)
            alias = folder / "alias.sqlite3"
            alias.symlink_to(db_path)
            with self.assertRaises(binder.Blocked):
                binder.validate_db(alias)

    def test_env_atomic_replacement_preserves_0600_and_existing_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "oauth.env"
            target.write_bytes(b"PUBLIC_TEST_ONLY=true\n")
            target.chmod(0o600)
            new_content = b"PUBLIC_TEST_ONLY=true\nFH_AUTH_DATABASE_PATH=/tmp/synthetic.sqlite3\n"
            binder.atomic_env_replace(target, new_content)
            self.assertEqual(target.read_bytes(), new_content)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_private_backup_is_unique_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as root:
            with mock.patch.object(binder, "BACKUP_DIR", Path(root)):
                binder.durable_create_backup(b"ONE-ONLY\n")
                binder.durable_create_backup(b"TWO-ONLY\n")
                backups = list(Path(root).glob("oauth-env-before-live-db-bind-*.env"))
                self.assertEqual(len(backups), 2)
                self.assertEqual({p.read_bytes() for p in backups},
                                 {b"ONE-ONLY\n", b"TWO-ONLY\n"})
                self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600
                                    for p in backups))

    def test_preflight_apply_idempotent_and_does_not_print_secrets(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root)
            stage = folder / "oauth.env"
            email = folder / "email-auth.env"
            non_sensitive_stage = "TEST_ONLY_CONFIG=true\n"
            stage.write_text(non_sensitive_stage)
            email.write_text("FH_AUTH_DATABASE_PATH=" + str(DB) + "\n")
            stage.chmod(0o600)
            email.chmod(0o600)
            with mock.patch.object(binder, "OAUTH_ENV", stage), \
                    mock.patch.object(binder, "EMAIL_ENV", email), \
                    mock.patch.object(binder, "BACKUP_DIR", folder), \
                    mock.patch.object(binder, "running_db_path", return_value=DB), \
                    mock.patch.object(binder, "validate_db"), \
                    mock.patch.object(binder, "verify_backup_dir"), \
                    mock.patch.object(binder, "validate_env",
                                      side_effect=lambda raw, live: binder.one_value(
                                          raw, "FH_AUTH_DATABASE_PATH") == [str(live)]), \
                    mock.patch.object(binder, "private_regular",
                                      side_effect=lambda p: Path(p).read_bytes()), \
                    mock.patch.object(binder.os, "geteuid", return_value=0):
                output = io.StringIO()
                with redirect_stdout(output):
                    binder.execute(apply=False)
                self.assertIn("BIND_STATUS=READY_FOR_APPLY", output.getvalue())
                self.assertEqual(stage.read_text(), non_sensitive_stage)
                self.assertFalse(list(folder.glob("oauth-env-before-live-db-bind-*")))

                output = io.StringIO()
                with redirect_stdout(output):
                    binder.execute(apply=True)
                self.assertIn("BIND_STATUS=PASS", output.getvalue())
                self.assertIn("DATABASE_MIGRATED=NO", output.getvalue())
                self.assertIn("SERVICES_RESTARTED=NO", output.getvalue())
                self.assertNotIn(SECRET, output.getvalue())
                self.assertTrue(stage.read_text().startswith(non_sensitive_stage))
                self.assertEqual(binder.one_value(stage.read_text(), "FH_AUTH_DATABASE_PATH"),
                                 [str(DB)])
                backups = list(folder.glob("oauth-env-before-live-db-bind-*"))
                self.assertEqual(len(backups), 1)
                self.assertEqual(backups[0].read_text(), non_sensitive_stage)

                output = io.StringIO()
                with redirect_stdout(output):
                    binder.execute(apply=True)
                self.assertIn("BIND_STATUS=ALREADY_MATCHED", output.getvalue())
                self.assertEqual(len(list(folder.glob("oauth-env-before-live-db-bind-*"))), 1)


if __name__ == "__main__":
    unittest.main()
