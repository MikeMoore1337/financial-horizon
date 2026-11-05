"""Standalone, fail-closed settings. No YFC credentials or users are accessed."""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit
import os


@dataclass(frozen=True)
class Settings:
    enabled: bool
    public_origin: str
    database_path: Path
    rate_secret: str
    turnstile_secret: str
    turnstile_sitekey: str
    smtp_host: str
    smtp_port: int
    smtp_username: str
    smtp_password: str
    smtp_from: str
    test_mode: bool = False

    @classmethod
    def from_env(cls) -> "Settings":
        e=os.environ
        return cls(
            enabled=e.get("FH_EMAIL_AUTH_ENABLED","false").lower()=="true",
            public_origin=e.get("FH_PUBLIC_URL","https://fin-horizon.mikemoore.top").rstrip("/"),
            database_path=Path(e.get("FH_AUTH_DATABASE_PATH",
                str(Path.home()/".financial-horizon"/"auth.sqlite3") if os.name=="nt"
                else "/var/lib/financial-horizon/auth.sqlite3")),
            rate_secret=e.get("FH_AUTH_RATE_SECRET",""),
            turnstile_secret=e.get("FH_TURNSTILE_SECRET_KEY",""),
            turnstile_sitekey=e.get("FH_TURNSTILE_SITE_KEY",""),
            smtp_host=e.get("FH_SMTP_HOST",""),
            smtp_port=int(e.get("FH_SMTP_PORT","465")),
            smtp_username=e.get("FH_SMTP_USERNAME",""),
            smtp_password=e.get("FH_SMTP_PASSWORD",""),
            smtp_from=e.get("FH_SMTP_FROM_EMAIL",""),
        )

    def __post_init__(self):
        u=urlsplit(self.public_origin)
        if (u.scheme!="https" and not (self.test_mode and
                self.public_origin=="http://127.0.0.1:8791")) or not u.hostname:
            raise ValueError("Invalid HTTPS FH_PUBLIC_URL")
        if u.username or u.password or u.path not in ("", "/") or u.query or u.fragment:
            raise ValueError("FH_PUBLIC_URL must be an exact origin")
        if not self.database_path.is_absolute():
            raise ValueError("Database path must be absolute")
        if self.enabled:
            if len(self.rate_secret)<32 or self.rate_secret.casefold().startswith("change"):
                raise ValueError("Strong FH_AUTH_RATE_SECRET required")
            if not self.turnstile_sitekey or not self.turnstile_secret:
                raise ValueError("Turnstile must be configured")
            if not self.test_mode:
                dummy_sitekeys={
                    "1x00000000000000000000AA",
                    "2x00000000000000000000AB",
                    "1x00000000000000000000BB",
                    "2x00000000000000000000BB",
                    "3x00000000000000000000FF",
                }
                dummy_secrets={
                    "1x0000000000000000000000000000000AA",
                    "2x0000000000000000000000000000000AA",
                    "3x0000000000000000000000000000000AA",
                }
                if (self.turnstile_sitekey in dummy_sitekeys or
                        self.turnstile_secret in dummy_secrets or
                        len(self.turnstile_sitekey)<20 or len(self.turnstile_secret)<20):
                    raise ValueError("Production Turnstile credentials must be genuine")
            if (not self.smtp_host or not self.smtp_username or not self.smtp_password
                    or not self.smtp_from or self.smtp_port not in (465,587)):
                raise ValueError("TLS SMTP relay must be configured")
            if "\n" in self.smtp_from or "\r" in self.smtp_from:
                raise ValueError("Invalid SMTP sender")
