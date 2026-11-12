"""Fail-closed, independent provider configuration; shared email auth database."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit
import os

PROVIDERS = ("telegram", "google", "yandex", "vk")


@dataclass(frozen=True)
class Config:
    enabled: bool
    public_url: str
    database_path: Path
    session_secret: str
    credentials: dict[str, tuple[str, str]]
    test_mode: bool = False
    allowed_providers: tuple[str, ...] = ()

    @classmethod
    def from_env(cls) -> "Config":
        env = os.environ
        enabled = env.get("FH_ENABLE_CLOUD_AUTH", "false").lower() == "true"
        public_url = env.get("FH_PUBLIC_URL", "https://fin-horizon.mikemoore.top").rstrip("/")
        default_db = (str(Path.home() / ".financial-horizon" / "auth.sqlite3")
                      if os.name == "nt" else "/var/lib/financial-horizon/auth.sqlite3")
        db = Path(env.get("FH_AUTH_DATABASE_PATH", default_db))
        old_db = env.get("FH_OAUTH_DATABASE_PATH", "").strip()
        if enabled and old_db and Path(old_db).resolve(strict=False) != db.resolve(strict=False):
            raise ValueError("Standalone OAuth database is forbidden; use FH_AUTH_DATABASE_PATH")
        credentials = {
            p: (
                env.get(f"FH_{p.upper()}_OAUTH_CLIENT_ID", "").strip(),
                env.get(f"FH_{p.upper()}_OAUTH_CLIENT_SECRET", "").strip()
            ) for p in PROVIDERS
        }
        permitted = tuple(
            p for p in PROVIDERS if env.get(f"FH_{p.upper()}_OAUTH_ENABLED", "false").lower() == "true"
        )
        return cls(enabled, public_url, db, env.get("FH_SESSION_SECRET", ""),
                   credentials, allowed_providers=permitted)

    def __post_init__(self):
        u = urlsplit(self.public_url)
        if ((u.scheme != "https" and not (self.test_mode and
                self.public_url == "http://127.0.0.1:8791")) or
                not u.hostname or u.username or u.password or
                u.path not in ("", "/") or u.query or u.fragment):
            raise ValueError("FH_PUBLIC_URL must be an exact HTTPS origin")
        if not self.database_path.is_absolute():
            raise ValueError("Auth SQLite path must be absolute")
        if self.enabled and (len(self.session_secret) < 32 or
                             self.session_secret.casefold().startswith("change")):
            raise ValueError("Strong FH_SESSION_SECRET is required")
        if any(p not in PROVIDERS for p in self.allowed_providers):
            raise ValueError("Unknown OAuth provider enabled")
        if self.enabled and not self.active_providers():
            raise ValueError("No provider explicitly enabled with complete credentials")

    def active_providers(self) -> tuple[str, ...]:
        return tuple(
            p for p in PROVIDERS
            if self.enabled and p in self.allowed_providers
            and p in self.credentials and self.credentials[p][0]
            and (self.credentials[p][1] or p == "vk")
        )
