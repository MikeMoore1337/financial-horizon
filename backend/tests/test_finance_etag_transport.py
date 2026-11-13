"""#33/#70: prevent weak revision ETags at Caddy/Cloudflare compression.

All fixtures synthetic; never contact production, run Caddy or print ETags.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
SCRIPT = SCRIPTS / "fh_finance_etag_transport.py"


def load():
    sys.path.insert(0, str(SCRIPTS))
    spec = importlib.util.spec_from_file_location("fh_finance_etag_transport", SCRIPT)
    assert spec and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _oauth_and_finance_caddy() -> bytes:
    return (
        "fin-horizon.mikemoore.top:8444 {\n"
        "    @fh_finance_read {\n"
        "        method GET\n"
        "        path /api/finance/v1/state /api/finance/v1/changes\n"
        "    }\n"
        "    handle @fh_finance_read {\n"
        "        reverse_proxy 127.0.0.1:9138\n"
        "    }\n"
        "    @fh_finance_write {\n"
        "        method POST\n"
        "        path /api/auth/email/finance/session /api/finance/v1/commands /api/finance/v2/commands\n"
        "    }\n"
        "    handle @fh_finance_write {\n"
        "        reverse_proxy 127.0.0.1:9138\n"
        "    }\n"
        "    handle @fh_oauth_live_get {\n"
        "        reverse_proxy 127.0.0.1:9138\n"
        "    }\n"
        "    handle @fh_oauth_live_post {\n"
        "        reverse_proxy 127.0.0.1:9138\n"
        "    }\n"
        "}\n"
    ).encode("utf-8")


def test_exact_finance_routes_get_no_transform_while_oauth_unchanged():
    m = load()
    source = _oauth_and_finance_caddy()
    updated = m.patch(source)
    assert updated != source
    assert updated.count(m.HEADER.encode()) == 2
    assert updated.count(b"no-transform") == 2
    assert updated.count(b"private, no-store, no-transform") == 2
    assert b"0.0.0.0" not in updated
    assert b"handle @fh_oauth_live_get {\n        reverse_proxy" in updated
    assert b"handle @fh_oauth_live_post {\n        reverse_proxy" in updated
    assert b"/api/finance/v1/import" not in updated
    assert updated.replace(m.NEW_READ.encode(), m.OLD_READ.encode(), 1).replace(
        m.NEW_WRITE.encode(), m.OLD_WRITE.encode(), 1
    ) == source
    with pytest.raises(m.NoGo, match="CADDY_FINANCE_ROUTING_UNRECOGNIZED"):
        m.patch(updated)


@pytest.mark.parametrize("mutation", (
    lambda s: s.replace(b"127.0.0.1:9138", b"127.0.0.1:9322", 1),
    lambda s: s.replace(b"    handle @fh_finance_write {", b"    handle @fh_finance_OTHER {"),
    lambda s: s.replace(b"    handle @fh_oauth_live_get {", b"    handle @fake_live_get {"),
    lambda s: s + b"\n" + s,
))
def test_reject_unrecognized_production_caddy_or_concurrent_routes(mutation):
    m = load()
    with pytest.raises(m.NoGo, match="CADDY_FINANCE_ROUTING_UNRECOGNIZED"):
        m.patch(mutation(_oauth_and_finance_caddy()))


def test_enforce_no_transform_header_and_origin_unauthenticated(monkeypatch):
    m = load()
    monkeypatch.setattr(m, "public_probe",
                        lambda path: 200 if path == "/api/auth/providers" else 401)
    monkeypatch.setattr(m, "auth_provider_baseline", lambda: None)
    monkeypatch.setattr(m, "trusted_origin_headers", lambda: (
        401, {"cache-control": "private, no-store, no-transform"},
    ))
    m.verify_headers()

    for status, cache in (
        (200, "private, no-store, no-transform"),
        (401, "private, no-store"),
        (401, "no-transform"),
        (401, "private, no-transform"),
    ):
        monkeypatch.setattr(m, "trusted_origin_headers", lambda s=status, h=cache: (
            s, {"cache-control": h},
        ))
        with pytest.raises(m.NoGo):
            m.verify_headers()


@pytest.mark.parametrize("operation", ("--preflight", "--apply", "--verify", "--rollback"))
def test_no_implicit_production_caddy_writes_from_ci(operation):
    result = subprocess.run(
        [sys.executable, str(SCRIPT), operation, "--sha", "a" * 40],
        env={**os.environ, "GITHUB_ACTIONS": "true"},
        capture_output=True, text=True, timeout=5, check=False,
    )
    assert result.returncode != 0
    assert result.stderr == ""
    assert "FINANCE_ETAG_RELEASE=NO_GO" in result.stdout
    assert "FAILURE_CODE=AUTHORIZED_NATIVE_ROOT_REQUIRED" in result.stdout


def test_release_never_forges_etags_or_touches_databases():
    source = SCRIPT.read_text(encoding="utf-8")
    assert "no-transform" in source
    assert "FINANCE_ETAG_ROLLBACK=PASS" in source
    assert "FINANCE_ETAG_NO_TRANSFORM=PASS" in source
    assert "ORIGIN_TLS_TRUST_ANCHOR_CHANGED" in source
    assert "ssl.TLSVersion.TLSv1_2" in source
    for prohibited in (
        "ETag W/", "ETag: W/", "header_down ETag",
        "allow_internal=True", "docker compose down",
        "systemctl restart", "FH_FINANCE_IMPORT_RUNTIME=on",
        "DROP TABLE", "ALTER ROLE", "FH_FINANCE_RUNTIME_MODE=off",
        "response.body", "finance_profiles SET", "/etc/caddy/Caddyfile mode",
    ):
        assert prohibited not in source


def test_backup_path_fixed_and_root_private():
    m = load()
    assert m.BACKUP == Path(
        "/var/backups/financial-horizon-finance/fh-finance-etag-caddy-original.bak"
    )
    assert m.BACKUP.is_relative_to(m.BACKUPS)



def test_emergency_rollback_needs_no_remote_ci_or_healthy_service(monkeypatch):
    m = load()
    sha = "a" * 40
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    monkeypatch.setattr(m.os, "geteuid", lambda: 0)

    def local_command(args, **kwargs):
        if args[-2:] == ["rev-parse", "HEAD"]:
            return sha
        if args[-2:] == ["status", "--porcelain"]:
            return ""
        if args[-3:] == ["remote", "get-url", "origin"]:
            return "https://github.com/MikeMoore1337/financial-horizon.git"
        raise AssertionError("Emergency rollback must not depend on live API/CI")

    monkeypatch.setattr(m, "run", local_command)
    monkeypatch.setattr(
        m, "current_sha",
        lambda unused: pytest.fail("No remote current_sha or health gate during rollback"),
    )
    m.emergency_rollback_gate(sha)
    with pytest.raises(m.NoGo, match="SOURCE_SHA_MISMATCH"):
        m.emergency_rollback_gate("b" * 40)


def test_rollback_requires_explicit_operator_opt_in(monkeypatch):
    m = load()
    monkeypatch.delenv("FH_FINANCE_ETAG_ROLLBACK", raising=False)
    with pytest.raises(m.NoGo, match="EXPLICIT_ROLLBACK_REQUIRED"):
        m.rollback("a" * 40)
