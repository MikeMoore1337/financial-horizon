"""Explicit, offline and backed-up migration of the existing email account schema.

Never run automatically during server startup. Stop the email-auth service and
create a second off-host protected backup before using this tool in production.
"""
from __future__ import annotations

from pathlib import Path
import os
import sqlite3
import sys


EXPECTED_COLUMNS = (
    "id", "email", "password_hash", "verified_at", "password_changed_at",
    "disabled", "created_at"
)


def migrate_user_table(db_path: Path, backup_path: Path) -> bool:
    db_path, backup_path = Path(db_path), Path(backup_path)
    if not db_path.is_file() or db_path.is_symlink():
        raise ValueError("Existing regular SQLite database required")
    if backup_path.exists() or backup_path.is_symlink() or backup_path == db_path:
        raise ValueError("Backup path must be new and different")
    if backup_path.parent.resolve() != db_path.parent.resolve():
        raise ValueError("Keep protected SQLite backup in the database directory")
    if os.name != "nt" and db_path.parent.stat().st_mode & 0o077:
        raise ValueError("Database directory must be private")
    with sqlite3.connect(db_path) as source:
        columns = source.execute("PRAGMA table_info(users)").fetchall()
        if tuple(c[1] for c in columns) != EXPECTED_COLUMNS:
            raise ValueError("Unexpected users schema; do not migrate")
        if columns[1][3] == 0:
            return False
        custom = source.execute(
            """SELECT name FROM sqlite_master WHERE tbl_name='users'
               AND type IN ('trigger','index') AND sql IS NOT NULL"""
        ).fetchall()
        if custom:
            raise ValueError("Unexpected users index/trigger; manual review required")
        if source.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Source database failed integrity check")
        fd = os.open(backup_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        try:
            with sqlite3.connect(backup_path) as backup:
                source.backup(backup)
                if backup.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise ValueError("Backup failed integrity check")
        except:
            backup_path.unlink(missing_ok=True)
            raise
    with sqlite3.connect(db_path, isolation_level=None, timeout=10) as db:
        db.execute("PRAGMA foreign_keys=OFF")
        db.execute("BEGIN EXCLUSIVE")
        try:
            # fail closed if another actor changed the schema between backup and lock
            cols = db.execute("PRAGMA table_info(users)").fetchall()
            if tuple(c[1] for c in cols) != EXPECTED_COLUMNS or cols[1][3] != 1:
                raise ValueError("Concurrent auth schema change")
            count = db.execute("SELECT count(*) FROM users").fetchone()[0]
            db.execute("""
                CREATE TABLE users_oauth_upgrade (
                    id TEXT PRIMARY KEY,
                    email TEXT UNIQUE,
                    password_hash TEXT NOT NULL DEFAULT '',
                    verified_at INTEGER,
                    password_changed_at INTEGER,
                    disabled INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                )
            """)
            db.execute("""
                INSERT INTO users_oauth_upgrade
                    (id,email,password_hash,verified_at,password_changed_at,disabled,created_at)
                SELECT id,email,password_hash,verified_at,password_changed_at,disabled,created_at
                FROM users
            """)
            db.execute("DROP TABLE users")
            db.execute("ALTER TABLE users_oauth_upgrade RENAME TO users")
            if db.execute("SELECT count(*) FROM users").fetchone()[0] != count:
                raise ValueError("User count changed during migration")
            if db.execute("PRAGMA foreign_key_check").fetchall():
                raise ValueError("Foreign key check failed")
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Migrated database failed integrity check")
            db.commit()
        except:
            db.rollback()
            raise
        finally:
            db.execute("PRAGMA foreign_keys=ON")
    return True


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python -m fh_auth.migrate DB_PATH NEW_BACKUP_PATH")
    print("AUTH_SCHEMA_MIGRATED=" + ("YES" if migrate_user_table(Path(sys.argv[1]), Path(sys.argv[2])) else "ALREADY_READY"))
