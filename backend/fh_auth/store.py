"""OAuth identities and one-time transactions in the existing Financial Horizon auth DB.

Financial records are never stored or migrated here. Existing email sessions and
OAuth sessions share fh_email_auth.store.AuthStore and the same cookie.
"""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from hmac import compare_digest
from pathlib import Path
import secrets
import sqlite3

from fh_email_auth.security import token_hash
from fh_email_auth.store import AuthFailure, AuthStore


def digest(value: str) -> str:
    return sha256(value.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Claim:
    provider: str
    verifier: str
    nonce: str
    redirect_uri: str
    intent: str = "login"
    target_user_id: str | None = None
    session_hash: str | None = None


class OAuthStore(AuthStore):
    """A single account/session authority, never a separate OAuth database."""

    def __init__(self, path: Path, now=None):
        super().__init__(path, now=now)
        with self._db() as db:
            columns = {row[1]: row for row in db.execute("PRAGMA table_info(users)")}
            if not columns or "email" not in columns or columns["email"][3]:
                raise ValueError("Auth DB requires explicit, backed-up OAuth migration")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS oauth_transactions (
                    state_hash TEXT PRIMARY KEY,
                    marker_hash TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    verifier TEXT NOT NULL,
                    nonce TEXT NOT NULL,
                    redirect_uri TEXT NOT NULL,
                    intent TEXT NOT NULL CHECK(intent IN ('login','link')),
                    target_user_id TEXT,
                    session_hash TEXT,
                    expires_at INTEGER NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('pending','claimed'))
                );
                CREATE INDEX IF NOT EXISTS oauth_tx_expiry_idx
                    ON oauth_transactions(expires_at);
            """)

    def begin(self, *, provider: str, state: str, browser_marker: str,
              verifier: str, nonce: str, redirect_uri: str,
              intent: str = "login", target_user_id: str | None = None,
              session: str | None = None, ttl: int = 600):
        if intent not in ("login", "link") or not 0 < ttl <= 600:
            raise ValueError("Invalid OAuth transaction")
        if intent == "link" and (not target_user_id or not session):
            raise ValueError("Link requires an authenticated principal")
        now = int(self.now())
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute("DELETE FROM oauth_transactions WHERE expires_at<=?", (now,))
                db.execute(
                    """INSERT INTO oauth_transactions
                       (state_hash,marker_hash,provider,verifier,nonce,redirect_uri,
                        intent,target_user_id,session_hash,expires_at,status)
                       VALUES(?,?,?,?,?,?,?,?,?,?,'pending')""",
                    (digest(state), digest(browser_marker), provider, verifier, nonce,
                     redirect_uri, intent, target_user_id,
                     token_hash(session) if session else None, now + ttl)
                )
                db.commit()
            except:
                db.rollback()
                raise

    def claim(self, *, provider: str, state: str | None, marker: str | None) -> Claim | None:
        if (not isinstance(state, str) or not isinstance(marker, str) or
                not 32 <= len(state) <= 256 or not 32 <= len(marker) <= 256):
            return None
        now = int(self.now())
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                cur = db.execute(
                    """UPDATE oauth_transactions SET status='claimed'
                       WHERE state_hash=? AND marker_hash=? AND provider=?
                         AND status='pending' AND expires_at>?""",
                    (digest(state), digest(marker), provider, now)
                )
                if cur.rowcount != 1:
                    db.rollback()
                    return None
                row = db.execute(
                    """SELECT provider,verifier,nonce,redirect_uri,intent,
                              target_user_id,session_hash
                       FROM oauth_transactions WHERE state_hash=?""",
                    (digest(state),)
                ).fetchone()
                db.commit()
                return Claim(*row)
            except:
                db.rollback()
                raise

    def finish(self, state: str):
        with self._db() as db:
            db.execute("DELETE FROM oauth_transactions WHERE state_hash=?", (digest(state),))

    def complete_login(self, provider: str, subject: str) -> tuple[str, str]:
        if not isinstance(subject, str) or not 0 < len(subject) <= 255:
            raise AuthFailure()
        now = int(self.now())
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                row = db.execute(
                    """SELECT u.id FROM oauth_identities oi
                       JOIN users u ON u.id=oi.user_id
                       WHERE oi.provider=? AND oi.subject=? AND u.disabled=0""",
                    (provider, subject)
                ).fetchone()
                if row:
                    uid = row[0]
                else:
                    # Distinguish disabled accounts from an unassigned identity.
                    if db.execute("SELECT 1 FROM oauth_identities WHERE provider=? AND subject=?",
                                  (provider, subject)).fetchone():
                        raise AuthFailure()
                    uid = secrets.token_hex(16)
                    db.execute(
                        """INSERT INTO users(id,email,password_hash,created_at)
                           VALUES(?,NULL,'',?)""",
                        (uid, now)
                    )
                    db.execute(
                        "INSERT INTO oauth_identities(provider,subject,user_id,created_at) VALUES(?,?,?,?)",
                        (provider, subject, uid, now)
                    )
                token = self._session(db, uid)
                db.commit()
                return uid, token
            except:
                db.rollback()
                raise

    def complete_link(self, claim: Claim, subject: str, session: str | None) -> str:
        """Bind only to the ORIGINAL live session; rotate it after successful linking."""
        if (claim.intent != "link" or not claim.target_user_id or not claim.session_hash
                or not isinstance(session, str) or not 32 <= len(session) <= 256
                or not compare_digest(claim.session_hash, token_hash(session))
                or not isinstance(subject, str) or not 0 < len(subject) <= 255):
            raise AuthFailure()
        now = int(self.now())
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                row = db.execute(
                    """SELECT u.id FROM sessions s JOIN users u ON u.id=s.user_id
                       WHERE s.hash=? AND s.revoked_at IS NULL AND s.expires_at>?
                         AND u.disabled=0""",
                    (token_hash(session), now)
                ).fetchone()
                if not row or row[0] != claim.target_user_id:
                    raise AuthFailure()
                existing = db.execute(
                    "SELECT user_id FROM oauth_identities WHERE provider=? AND subject=?",
                    (claim.provider, subject)
                ).fetchone()
                if existing and existing[0] != claim.target_user_id:
                    raise AuthFailure()
                if not existing:
                    try:
                        db.execute(
                            "INSERT INTO oauth_identities(provider,subject,user_id,created_at) VALUES(?,?,?,?)",
                            (claim.provider, subject, claim.target_user_id, now)
                        )
                    except sqlite3.IntegrityError:
                        raise AuthFailure() from None
                db.execute(
                    "UPDATE sessions SET revoked_at=? WHERE hash=? AND revoked_at IS NULL",
                    (now, token_hash(session))
                )
                token = self._session(db, claim.target_user_id)
                db.commit()
                return token
            except:
                db.rollback()
                raise

    def user_id_for(self, provider: str, subject: str) -> str | None:
        with self._db() as db:
            row = db.execute(
                "SELECT user_id FROM oauth_identities WHERE provider=? AND subject=?",
                (provider, subject)
            ).fetchone()
            return row[0] if row else None
