"""SQLite WAL identity store; opaque tokens and atomic single-use actions."""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import os
import secrets
import sqlite3
import time

from .security import make_password_hash, verify_password, random_token, token_hash


class Throttled(Exception):
    pass


class AuthFailure(Exception):
    pass


class AuthStore:
    def __init__(self, path: Path, now=None):
        self.path=Path(path)
        self.now=now or time.time
        if not self.path.parent.exists() or self.path.parent.is_symlink():
            raise ValueError("Protected SQLite parent directory must already exist")
        if os.name!="nt" and self.path.parent.stat().st_mode & 0o077:
            raise ValueError("Auth database parent directory must be private")
        if self.path.is_symlink():
            raise ValueError("SQLite symlinks are forbidden")
        if not self.path.exists():
            try:
                fd=os.open(self.path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
            except FileExistsError:
                pass
            else:
                os.close(fd)
        self._init()

    @contextmanager
    def _db(self):
        cx=sqlite3.connect(self.path,timeout=6,isolation_level=None)
        cx.execute("PRAGMA foreign_keys=ON")
        cx.execute("PRAGMA busy_timeout=5000")
        try: yield cx
        finally: cx.close()

    def _init(self):
        with self._db() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    email TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL DEFAULT '',
                    verified_at INTEGER,
                    password_changed_at INTEGER,
                    disabled INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS actions (
                    hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id),
                    purpose TEXT NOT NULL CHECK(purpose IN ('verify','reset')),
                    expires_at INTEGER NOT NULL,
                    consumed_at INTEGER,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS actions_user_idx ON actions(user_id,purpose);
                CREATE TABLE IF NOT EXISTS sessions (
                    hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id),
                    expires_at INTEGER NOT NULL,
                    revoked_at INTEGER,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
                CREATE TABLE IF NOT EXISTS email_changes (
                    hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id),
                    new_email TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS email_changes_user_idx ON email_changes(user_id);
                CREATE TABLE IF NOT EXISTS counters (
                    key TEXT NOT NULL,
                    bucket INTEGER NOT NULL,
                    count INTEGER NOT NULL,
                    PRIMARY KEY(key,bucket)
                );
                CREATE TABLE IF NOT EXISTS mail_reservations (
                    timestamp INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS mail_reservations_time_idx
                    ON mail_reservations(timestamp);
            """)

    def limit(self, rate_key: str, max_attempts: int, period: int):
        now=int(self.now())
        bucket=(now//period)*period
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute("DELETE FROM counters WHERE bucket<?",(now-2*86400,))
                row=db.execute(
                    """INSERT INTO counters(key,bucket,count) VALUES(?,?,1)
                       ON CONFLICT(key,bucket) DO UPDATE SET count=count+1
                         WHERE count < ?
                       RETURNING count""",
                    (rate_key,bucket,max_attempts)
                ).fetchone()
                db.commit()
                if row is None:
                    raise Throttled()
            except:
                db.rollback()
                raise

    def reserve_transactional_email(self, max_per_24h: int = 80) -> None:
        """Atomic rolling 24-hour send budget, safe across midnight/time zones."""
        now=int(self.now())
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute("DELETE FROM mail_reservations WHERE timestamp <= ?", (now-86400,))
                row=db.execute("SELECT count(*) FROM mail_reservations").fetchone()
                if row[0]>=max_per_24h:
                    db.rollback()
                    raise Throttled()
                db.execute("INSERT INTO mail_reservations(timestamp) VALUES(?)",(now,))
                db.commit()
            except:
                db.rollback()
                raise

    def _create_action(self, db, user_id: str, purpose: str, ttl: int) -> str:
        now=int(self.now())
        token=random_token()
        db.execute(
            "DELETE FROM actions WHERE user_id=? AND purpose=? AND consumed_at IS NULL",
            (user_id,purpose)
        )
        db.execute(
            "INSERT INTO actions(hash,user_id,purpose,expires_at,consumed_at,created_at) VALUES(?,?,?,?,NULL,?)",
            (token_hash(token),user_id,purpose,now+ttl,now)
        )
        return token

    def create_account(self,email: str) -> str | None:
        # Never save an attacker-chosen password for an unverified address.
        now=int(self.now())
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                row=db.execute("SELECT id FROM users WHERE email=?",(email,)).fetchone()
                if row:
                    db.rollback()
                    return None
                uid=secrets.token_hex(16)
                db.execute(
                    "INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)",
                    (uid,email,'',now)
                )
                token=self._create_action(db,uid,"verify",24*3600)
                db.commit()
                return token
            except:
                db.rollback()
                raise

    def email_action(self,email: str,purpose: str) -> str | None:
        now=int(self.now())
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                user=db.execute("SELECT id,verified_at,disabled FROM users WHERE email=?",(email,)).fetchone()
                if not user or user[2] or (purpose=="verify" and user[1]) or (purpose=="reset" and not user[1]):
                    db.rollback()
                    return None
                token=self._create_action(db,user[0],purpose,24*3600 if purpose=="verify" else 3600)
                db.commit()
                return token
            except:
                db.rollback()
                raise

    def _consume_action(self,db,token: str,purpose: str):
        now=int(self.now())
        row=db.execute(
            "SELECT user_id FROM actions WHERE hash=? AND purpose=? AND consumed_at IS NULL AND expires_at>?",
            (token_hash(token),purpose,now)
        ).fetchone()
        if not row:
            raise AuthFailure()
        updated=db.execute(
            "UPDATE actions SET consumed_at=? WHERE hash=? AND consumed_at IS NULL",
            (now,token_hash(token))
        )
        if updated.rowcount!=1:
            raise AuthFailure()
        return row[0]

    def _session(self,db,user_id: str) -> str:
        now=int(self.now())
        raw=random_token()
        db.execute(
            "INSERT INTO sessions(hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
            (token_hash(raw),user_id,now+7*86400,now)
        )
        return raw

    def _precheck_action(self,token:str,purpose:str)->bool:
        if not isinstance(token,str) or not 32<=len(token)<=256:
            return False
        with self._db() as db:
            return db.execute(
                "SELECT 1 FROM actions WHERE hash=? AND purpose=? AND consumed_at IS NULL AND expires_at>?",
                (token_hash(token),purpose,int(self.now()))
            ).fetchone() is not None

    def confirm_email(self,token: str,password: str) -> str:
        if not self._precheck_action(token,"verify"):
            raise AuthFailure()
        password_hash=make_password_hash(password)
        if not isinstance(token,str) or not 32<=len(token)<=256:
            raise AuthFailure()
        now=int(self.now())
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                uid=self._consume_action(db,token,"verify")
                result=db.execute(
                    "UPDATE users SET verified_at=?,password_hash=? WHERE id=? AND verified_at IS NULL AND disabled=0",
                    (now,password_hash,uid)
                )
                if result.rowcount!=1:
                    raise AuthFailure()
                session=self._session(db,uid)
                db.commit()
                return session
            except:
                db.rollback()
                raise

    def login(self,email: str,password: str) -> str:
        with self._db() as db:
            row=db.execute(
                "SELECT id,password_hash,verified_at,disabled FROM users WHERE email=?",(email,)
            ).fetchone()
        if not verify_password(password,row[1] if row else None):
            raise AuthFailure()
        if not row or not row[2] or row[3]:
            raise AuthFailure()
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                current=db.execute("SELECT verified_at,disabled,password_hash FROM users WHERE id=?",(row[0],)).fetchone()
                if not current or not current[0] or current[1] or current[2]!=row[1]:
                    # A password reset between hash verification and session
                    # issuance must invalidate the old credentials immediately.
                    raise AuthFailure()
                session=self._session(db,row[0])
                db.commit()
                return session
            except:
                db.rollback()
                raise

    def reset_password(self,token: str,new_password: str) -> None:
        if not self._precheck_action(token,"reset"):
            raise AuthFailure()
        new_hash=make_password_hash(new_password)
        now=int(self.now())
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                uid=self._consume_action(db,token,"reset")
                row=db.execute("SELECT verified_at,disabled FROM users WHERE id=?",(uid,)).fetchone()
                if not row or not row[0] or row[1]:
                    raise AuthFailure()
                db.execute(
                    "UPDATE users SET password_hash=?,password_changed_at=? WHERE id=?",
                    (new_hash,now,uid)
                )
                # A password reset must also invalidate pending mailbox changes.
                db.execute("DELETE FROM email_changes WHERE user_id=?",(uid,))
                db.execute("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",(now,uid))
                db.commit()
            except:
                db.rollback()
                raise

    def request_email_change(self, session: str|None, new_email: str, password: str) -> str | None:
        """Verify the current password, then issue a one-time token for the NEW mailbox.

        The caller always gives a neutral response when the target email is in use.
        No data is moved between account IDs.
        """
        if not isinstance(session,str) or not 32 <= len(session) <= 256 or not session.isascii():
            raise AuthFailure()
        now=int(self.now())
        current_hash=token_hash(session)
        with self._db() as db:
            row=db.execute(
                """SELECT u.id,u.email,u.password_hash FROM sessions s
                   JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>?
                     AND s.revoked_at IS NULL AND u.disabled=0 AND u.verified_at IS NOT NULL""",
                (current_hash,now)
            ).fetchone()
        if not row or not verify_password(password,row[2]):
            raise AuthFailure()
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                fresh=db.execute(
                    """SELECT u.id,u.email,u.password_hash FROM sessions s
                       JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>?
                         AND s.revoked_at IS NULL AND u.disabled=0 AND u.verified_at IS NOT NULL""",
                    (current_hash,int(self.now()))
                ).fetchone()
                if not fresh or fresh!=row:
                    raise AuthFailure()
                if new_email==fresh[1] or db.execute(
                    "SELECT 1 FROM users WHERE email=?",(new_email,)
                ).fetchone():
                    db.rollback()
                    return None
                token=random_token()
                db.execute("DELETE FROM email_changes WHERE user_id=?",(fresh[0],))
                db.execute(
                    """INSERT INTO email_changes(hash,user_id,new_email,expires_at,created_at)
                       VALUES(?,?,?,?,?)""",
                    (token_hash(token),fresh[0],new_email,int(self.now())+3600,int(self.now()))
                )
                db.commit()
                return token
            except:
                db.rollback()
                raise

    def confirm_email_change(self, session: str|None, token: str) -> tuple[str,str]:
        """Atomically change mailbox, invalidate all earlier sessions, issue a new cookie."""
        if not isinstance(session,str) or not 32<=len(session)<=256 or not session.isascii():
            raise AuthFailure()
        if not isinstance(token,str) or not 32<=len(token)<=256 or not token.isascii():
            raise AuthFailure()
        now=int(self.now())
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                current=db.execute(
                    """SELECT s.user_id,u.email FROM sessions s
                       JOIN users u ON u.id=s.user_id
                       WHERE s.hash=? AND s.revoked_at IS NULL AND s.expires_at>?
                       AND u.verified_at IS NOT NULL AND u.disabled=0""",
                    (token_hash(session),now)
                ).fetchone()
                if not current:
                    raise AuthFailure()
                row=db.execute(
                    """SELECT new_email FROM email_changes WHERE hash=? AND user_id=?
                       AND expires_at>?""",
                    (token_hash(token),current[0],now)
                ).fetchone()
                if not row:
                    raise AuthFailure()
                try:
                    updated=db.execute(
                        "UPDATE users SET email=? WHERE id=? AND email=? AND disabled=0",
                        (row[0],current[0],current[1])
                    )
                except sqlite3.IntegrityError:
                    raise AuthFailure() from None
                if updated.rowcount!=1:
                    raise AuthFailure()
                db.execute("DELETE FROM email_changes WHERE user_id=?",(current[0],))
                # Old reset links are no longer trustworthy after an email change.
                db.execute("DELETE FROM actions WHERE user_id=?",(current[0],))
                db.execute(
                    "UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
                    (now,current[0])
                )
                new_session=self._session(db,current[0])
                db.commit()
                return new_session,current[1]
            except:
                db.rollback()
                raise

    def rotate_session(self, session: str|None) -> str:
        """Single-use rotation with no window accepting the old and new tokens."""
        if not isinstance(session,str) or not 32<=len(session)<=256 or not session.isascii():
            raise AuthFailure()
        now=int(self.now())
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                row=db.execute(
                    """SELECT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id
                       WHERE s.hash=? AND s.revoked_at IS NULL AND s.expires_at>?
                       AND u.disabled=0 AND u.verified_at IS NOT NULL""",
                    (token_hash(session),now)
                ).fetchone()
                if not row:
                    raise AuthFailure()
                db.execute(
                    "UPDATE sessions SET revoked_at=? WHERE hash=? AND revoked_at IS NULL",
                    (now,token_hash(session))
                )
                token=self._session(db,row[0])
                db.commit()
                return token
            except:
                db.rollback()
                raise

    def current(self,session: str|None):
        if not isinstance(session,str) or not 32<=len(session)<=256 or not session.isascii():return None
        with self._db() as db:
            row=db.execute(
                """SELECT s.user_id, u.email FROM sessions s JOIN users u ON u.id=s.user_id
                   WHERE s.hash=? AND s.expires_at>? AND s.revoked_at IS NULL AND u.disabled=0 AND u.verified_at IS NOT NULL""",
                (token_hash(session),int(self.now()))
            ).fetchone()
        return {"id":row[0],"email":row[1]} if row else None

    def logout(self,session: str|None):
        if not isinstance(session,str) or not 32<=len(session)<=256 or not session.isascii():return
        with self._db() as db:
            db.execute(
                "UPDATE sessions SET revoked_at=? WHERE hash=? AND revoked_at IS NULL",
                (int(self.now()),token_hash(session))
            )
