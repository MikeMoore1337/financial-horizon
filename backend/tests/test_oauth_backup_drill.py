"""Offline, synthetic tests for the production OAuth backup and restore drill."""
from __future__ import annotations

from contextlib import redirect_stdout
import importlib.util
import io
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[2] / "scripts/fh_oauth_backup_drill.py"
spec = importlib.util.spec_from_file_location("fh_oauth_backup_drill", SOURCE)
assert spec is not None and spec.loader is not None
drill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drill)


def init_db(path: Path):
    with sqlite3.connect(path) as connection:
        connection.executescript("""
            PRAGMA foreign_keys=ON;
            CREATE TABLE users (
                id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL DEFAULT '',
                verified_at INTEGER, password_changed_at INTEGER,
                disabled INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE sessions (
                hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id)
            );
            CREATE TABLE actions (
                hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id)
            );
            CREATE TABLE email_changes (
                hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id)
            );
            INSERT INTO users (id,email,created_at)
            VALUES ('00000000000000000000000000000000',
                    'example@example.invalid', 1);
            INSERT INTO sessions (hash,user_id)
            VALUES ('test-hash','00000000000000000000000000000000');
        """)
    path.chmod(0o600)


class SnapshotTests(unittest.TestCase):
    def test_online_sqlite_backup_and_isolated_restore(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root)
            folder.chmod(0o700)
            source = folder / "auth.sqlite3"
            init_db(source)
            before = drill.file_hash(source)
            self.assertEqual(drill.inspect_sqlite(source), (1, 1, 0, 0))
            drill.backup_and_restore_drill(source, folder)
            snapshots = list(folder.glob("auth-before-oauth-*.sqlite3"))
            self.assertEqual(len(snapshots), 1)
            snapshot = snapshots[0]
            self.assertEqual(snapshot.stat().st_mode & 0o777, 0o600)
            self.assertEqual(drill.inspect_sqlite(snapshot), (1, 1, 0, 0))
            self.assertEqual(drill.file_hash(source), before)
            self.assertFalse(list(folder.glob("fh-oauth-restore-*")))

    def test_wrong_schema_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            db = Path(root) / "test.sqlite3"
            init_db(db)
            with sqlite3.connect(db) as conn:
                conn.execute("ALTER TABLE users ADD COLUMN unexpected TEXT")
            with self.assertRaises(drill.Blocked) as raised:
                drill.inspect_sqlite(db)
            self.assertEqual(raised.exception.code, "PRE_OAUTH_USERS_SCHEMA_UNEXPECTED")
            self.assertFalse(list(Path(root).glob("auth-before-oauth-*")))

    def test_auth_identity_table_signals_no_live_migration_needed(self):
        with tempfile.TemporaryDirectory() as root:
            db = Path(root) / "test.sqlite3"
            init_db(db)
            with sqlite3.connect(db) as conn:
                conn.execute("CREATE TABLE oauth_identities (provider TEXT)")
            with self.assertRaises(drill.Blocked) as raised:
                drill.inspect_sqlite(db)
            self.assertEqual(raised.exception.code, "AUTH_TABLE_SET_UNEXPECTED")

    def test_restrict_source_to_private_regular_file_not_canary(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root)
            folder.chmod(0o700)
            db = folder / "auth.sqlite3"
            init_db(db)
            drill.guarded_source(db)
            db.chmod(0o644)
            with self.assertRaises(drill.Blocked):
                drill.guarded_source(db)
            db.chmod(0o600)
            alias = folder / "alias.sqlite3"
            alias.symlink_to(db)
            with self.assertRaises(drill.Blocked):
                drill.guarded_source(alias)
            with self.assertRaises(drill.Blocked):
                drill.guarded_source(drill.CANARY_DB)

    def test_preflight_rejects_ambiguous_stage_key_and_enabled_flags(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root)
            folder.chmod(0o700)
            db = folder / "auth.sqlite3"
            init_db(db)
            stage = "FH_AUTH_DATABASE_PATH=" + str(db) + "\n"
            for key in drill.FLAGS:
                stage += key + "=false\n"
            with mock.patch.object(drill, "running_database", return_value=db), \
                    mock.patch.object(drill, "EMAIL_CONFIG", folder / "email.env"), \
                    mock.patch.object(drill, "OAUTH_CONFIG", folder / "oauth.env"), \
                    mock.patch.object(drill, "BACKUPS", folder), \
                    mock.patch.object(drill, "root_private_text",
                                      side_effect=lambda p: (
                                          "FH_AUTH_DATABASE_PATH=" + str(db) + "\n"
                                          if p.name == "email.env" else stage
                                      )), \
                    mock.patch.object(drill.os, "geteuid", return_value=0):
                self.assertEqual(drill.preflight(), db)
                with mock.patch.object(drill, "root_private_text",
                                       return_value=stage.replace(
                                           "FH_TELEGRAM_OAUTH_ENABLED=false",
                                           "FH_TELEGRAM_OAUTH_ENABLED=true")):
                    with self.assertRaises(drill.Blocked):
                        drill.preflight()
                with mock.patch.object(drill, "root_private_text",
                                       return_value=stage + "FH_AUTH_DATABASE_PATH=/tmp/other.sqlite3\n"):
                    with self.assertRaises(drill.Blocked):
                        drill.preflight()

    def test_main_preflight_does_not_write_or_emit_paths(self):
        with mock.patch.object(drill, "preflight", return_value=Path("/test/auth.sqlite3")), \
                mock.patch.object(drill, "backup_and_restore_drill") as backup, \
                mock.patch("sys.argv", ["program", "--preflight"]), \
                redirect_stdout(io.StringIO()) as output:
            self.assertEqual(drill.main(), 0)
            self.assertIn("BACKUP_STATUS=READY", output.getvalue())
            self.assertNotIn("/test/auth.sqlite3", output.getvalue())
            backup.assert_not_called()


if __name__ == "__main__":
    unittest.main()
