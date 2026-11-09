"""Synthetic localhost E2E origin: built Vite frontend and real FastAPI/SQLite."""
import re
import sys
import tempfile
import threading
from pathlib import Path

import uvicorn
from fastapi import HTTPException
from fastapi.responses import FileResponse, Response

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "dist"
sys.path.insert(0, str(ROOT / "backend"))
from fh_email_auth.app import create_app
from fh_email_auth.config import Settings

ORIGIN = "http://127.0.0.1:8791"
PUBLIC_FILES = {
    "index.html",
    "account.html",
    "manifest.webmanifest",
    "theme-bootstrap.js",
    "styles.css",
    "account.css",
}
LEGACY_FILES = {
    "app.js", "account.js", "account-oauth.js", "auth-ui.js",
    "auth-session.js", "backup.js", "excel-import.js",
    "finance.js", "ledger-operations.js", "schedule.js", "state-migrations.js",
    "storage.js",
}
PUBLIC_SUFFIXES = {".js", ".css", ".svg", ".png", ".ico", ".webp", ".webmanifest"}


class SyntheticInbox:
    def __init__(self):
        self.items = []
        self.lock = threading.Lock()

    def send(self, email, purpose, token):
        if not email.endswith(".invalid"):
            raise ValueError("Synthetic email domains only")
        with self.lock:
            self.items.append((email, purpose, token))
        return True

    def latest(self, email, purpose):
        with self.lock:
            return next((t for e, p, t in reversed(self.items) if e == email and p == purpose), None)


def local_app(directory):
    if not (DIST / "sw.js").is_file():
        raise RuntimeError("E2E requires a real Vite dist; run npm run build first")

    config = Settings(
        enabled=True, public_origin=ORIGIN, database_path=directory / "auth.sqlite3",
        rate_secret="e2e-local-rate-secret-" + "a" * 48,
        turnstile_secret="e2e-local-only-secret", turnstile_sitekey="e2e-local-sitekey",
        smtp_host="smtp.test.invalid", smtp_port=465, smtp_username="synthetic",
        smtp_password="not-a-real-password", smtp_from="noreply@example.invalid",
        test_mode=True,
    )
    inbox = SyntheticInbox()
    app = create_app(
        config=config,
        mailer=inbox,
        captcha=lambda secret, token, origin, action: (
            secret == config.turnstile_secret
            and token == "e2e-" + action
            and origin == ORIGIN
        ),
    )
    sw_revision = {"value": 0}
    legacy_sw = {"enabled": False}

    @app.get("/__e2e__/ready")
    def ready():
        return {"ready": True, "backend": "FastAPI + SQLite", "frontend": "dist"}

    @app.get("/__e2e__/mail")
    def mail(email: str, purpose: str):
        if not email.endswith(".invalid") or purpose not in {
            "verify", "reset", "email-change", "email-changed"
        }:
            raise HTTPException(404)
        token = inbox.latest(email, purpose)
        if token is None:
            raise HTTPException(404)
        return {"token": token}

    @app.post("/__e2e__/sw-upgrade")
    def sw_upgrade():
        sw_revision["value"] += 1
        return {"revision": sw_revision["value"]}

    @app.post("/__e2e__/sw-version/{kind}")
    def sw_version(kind: str):
        if kind not in {"legacy", "vite"}:
            raise HTTPException(404)
        legacy_sw["enabled"] = kind == "legacy"
        return {"kind": kind}

    @app.get("/sw.js")
    def sw():
        source_path = ROOT / "sw.js" if legacy_sw["enabled"] else DIST / "sw.js"
        source = source_path.read_text(encoding="utf-8")
        if sw_revision["value"]:
            source = re.sub(
                r"^const CACHE='([^']+)';",
                lambda match: "const CACHE='" + match.group(1)
                + "-e2e-" + str(sw_revision["value"]) + "';",
                source, count=1, flags=re.MULTILINE,
            )
        return Response(
            source, media_type="application/javascript",
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/{resource:path}")
    def static_frontend(resource: str):
        resource = resource or "index.html"
        allowed = (
            resource in PUBLIC_FILES
            or resource in LEGACY_FILES
            or (
                resource.startswith("assets/")
                and Path(resource).suffix.lower() in PUBLIC_SUFFIXES
            )
        )
        if not allowed:
            raise HTTPException(404)
        base = ROOT if legacy_sw["enabled"] and (
            resource in PUBLIC_FILES | LEGACY_FILES
        ) else DIST
        if legacy_sw["enabled"] and resource in {"state-migrations.js", "app.js"}:
            base = ROOT / "legacy"
        target = (base / resource).resolve()
        if not target.is_relative_to(base.resolve()) or not target.is_file():
            raise HTTPException(404)
        return FileResponse(target)

    return app


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="financial-horizon-e2e-") as tmp:
        uvicorn.run(local_app(Path(tmp)), host="127.0.0.1", port=8791, log_level="warning")
