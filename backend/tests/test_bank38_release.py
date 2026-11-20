"""#38: native production bank routing operator, synthetic only, no VPS writes."""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
SCRIPT = SCRIPTS / "fh_bank38_release.py"


def load():
    sys.path.insert(0, str(SCRIPTS))
    try:
        spec = importlib.util.spec_from_file_location("fh_bank38_release", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(SCRIPTS))


def original_caddy(m):
    routes = m.finance.ROUTES
    for role in ("read", "write"):
        original = (
            f"    handle @fh_finance_{role} {{\n"
            "        reverse_proxy 127.0.0.1:9138\n"
            "    }\n"
        )
        exact = (
            f"    handle @fh_finance_{role} {{\n"
            "        reverse_proxy 127.0.0.1:9138 {\n"
            '            header_down Cache-Control "private, no-store, no-transform"\n'
            "        }\n"
            "    }\n"
        )
        assert routes.count(original) == 1
        routes = routes.replace(original, exact, 1)
    return (
        "fin-horizon.mikemoore.top:8444 {\n"
        + routes + "    @fh_oauth_live_get {\n"
        + "        method GET\n"
        + "        path /api/auth/providers\n"
        + "    }\n"
        + "    handle @fh_oauth_live_get { reverse_proxy 127.0.0.1:9138 }\n"
        + "}\n"
    ).encode("utf-8")


def test_exact_strong_etag_bank_routes_keep_original_caddy_unchanged():
    m = load()
    original = original_caddy(m)
    patched = m.bank_caddy_patch(original)
    assert patched.replace(m.BANK_ROUTES.encode(), b"", 1) == original
    assert b"@fh_bank38_read" in patched
    assert b"@fh_bank38_write" in patched
    assert patched.count(b'header_down Cache-Control "private, no-store, no-transform"') == 4
    expected = {
        "/api/finance/v2/bank-import/rows": 1,
        "/api/finance/v2/bank-import/batches": 1,
        "/api/finance/v2/bank-import/commit": 1,
        "/api/finance/v2/bank-import/undo": 1,
    }
    for path, count in expected.items():
        assert patched.count(path.encode()) == count
    assert b"/api/finance/v2/bank-import/*" not in patched
    assert b"/api/finance/v1/import/" not in patched
    assert b"method GET" in patched and b"method POST" in patched
    assert m.FLAG == b"[Service]\nEnvironment=FH_FINANCE_BANK_IMPORT_RUNTIME=on\n"


@pytest.mark.parametrize("modify", [
    lambda x: x.replace(b"method GET", b"method POST", 1),
    lambda x: x.replace(b"reverse_proxy 127.0.0.1:9138",
                        b"reverse_proxy 0.0.0.0:9138", 1),
    lambda x: x.replace(
        b'header_down Cache-Control "private, no-store, no-transform"',
        b'header_down Cache-Control "private, no-store"', 1,
    ),
    lambda x: x.replace(
        b'header_down Cache-Control "private, no-store, no-transform"',
        b'header_down Cache-Control "private, no-store, no-transform"\n'
        b'        header_up Authorization leaked', 1,
    ),
    lambda x: x.replace(
        b"path /api/finance/v1/state /api/finance/v1/changes",
        b"path /api/finance/v1/state /api/finance/v1/changes /api/finance/v1/*",
    ),
    lambda x: x.replace(b"    @fh_oauth_live_get {", b"    @unknown {"),
    lambda x: x.replace(b"    @fh_oauth_live_get {",
                        b"    @fh_bank38_read {\n    }\n    @fh_oauth_live_get {"),
    lambda x: x.replace(b"    @fh_oauth_live_get {",
                        b"    @fh_personal_import_write {\n    }\n    @fh_oauth_live_get {"),
])
def test_unknown_caddy_alteration_fails_closed(modify):
    m = load()
    baseline = original_caddy(m)
    changed = modify(baseline)
    assert baseline != changed
    with pytest.raises(m.Hold, match="CADDY_"):
        m.bank_caddy_patch(changed)


def test_double_patch_and_missing_original_marker_rejected():
    m = load()
    baseline = original_caddy(m)
    with pytest.raises(m.Hold, match="CADDY_SOURCE_NOT_EXACT_BASELINE"):
        m.bank_caddy_patch(m.bank_caddy_patch(baseline))
    with pytest.raises(m.Hold, match="CADDY_SOURCE_NOT_EXACT_BASELINE"):
        m.bank_caddy_patch(baseline.replace(b"    @fh_oauth_live_get {",
                                             b"    @other {"))
    with pytest.raises(m.Hold):
        m.bank_caddy_patch(b"unknown caddy configuration")


def test_postgres_schema_checks_exact_head_rls_and_runtime_grants(monkeypatch):
    m = load()
    statements = []
    values = ["0007_bank_statements", "18", "t"]

    def sql(command, **kwargs):
        assert command[:3] == ["docker", "exec", "-u"]
        statements.append(command[-1])
        return values.pop(0)

    monkeypatch.setattr(m.finance, "run", sql)
    m.postgres_ready()
    assert len(statements) == 3
    assert "relforcerowsecurity" in statements[1]
    assert "has_table_privilege" in statements[2]
    assert "DELETE" in statements[2]

    for bad, response in [(0, "0006_reserve_events"), (1, "16"), (2, "f")]:
        values = ["0007_bank_statements", "18", "t"]
        values[bad] = response
        monkeypatch.setattr(m.finance, "run", lambda _args, **kw: values.pop(0))
        with pytest.raises(m.Hold):
            m.postgres_ready()


def test_enable_requires_explicit_owner_token_before_any_side_effect(monkeypatch):
    m = load()
    original = original_caddy(m)
    monkeypatch.setattr(m, "read_only_preflight",
                        lambda _sha: (original, 0o640))
    calls = []
    monkeypatch.setattr(m.finance, "write_exclusive",
                        lambda *args, **kwargs: calls.append("write"))
    monkeypatch.setattr(m.source, "backup_live_auth_db",
                        lambda: calls.append("auth backup"))
    monkeypatch.delenv("FH_BANK38_RELEASE", raising=False)
    with pytest.raises(m.Hold, match="EXPLICIT_BANK38_ENABLE_REQUIRED"):
        m.enable("1" * 40)
    assert calls == []


def test_failed_public_bank_auth_reverts_caddy_and_95_dropin(monkeypatch, tmp_path):
    m = load()
    original = original_caddy(m)
    patched = m.bank_caddy_patch(original)
    fake_drop = tmp_path / "95-bank-import-38.conf"
    m.DROP95 = fake_drop
    m.CADDY = tmp_path / "site.caddy"
    m.CADDY.write_bytes(original)
    m.BACKUPS = tmp_path
    events = []
    monkeypatch.setenv("FH_BANK38_RELEASE", "ENABLE")
    monkeypatch.setattr(m, "read_only_preflight", lambda _sha: (original, 0o640))
    monkeypatch.setattr(m.backend, "check_checkout", lambda _sha: None)
    monkeypatch.setattr(m.source, "backup_live_auth_db",
                        lambda: events.append("auth-db-backup"))
    monkeypatch.setattr(m.finance, "write_exclusive",
                        lambda path, content, **kw: path.write_bytes(content))
    monkeypatch.setattr(m.finance, "secure_file",
                        lambda path, *_args: path.read_bytes())
    monkeypatch.setattr(m.finance, "atomic_replace",
                        lambda path, content, **kw: path.write_bytes(content))
    monkeypatch.setattr(m.finance, "caddy_snapshot",
                        lambda: (m.CADDY.read_bytes(), 0o640))
    monkeypatch.setattr(m.finance, "run",
                        lambda args, **kw: events.append(tuple(args)) or "")
    monkeypatch.setattr(m, "restart_auth",
                        lambda: events.append("restart-auth"))
    monkeypatch.setattr(m.finance, "local_probe",
                        lambda path, **kw: 401 if fake_drop.exists() else 404)
    monkeypatch.setattr(m, "public_negative_checks",
                        lambda: m.refuse("SYNTHETIC_PUBLIC_SMOKE_FAILURE"))
    # Caddy may be mutated before the injected failure; original must return.
    with pytest.raises(m.Hold, match="SYNTHETIC_PUBLIC_SMOKE_FAILURE"):
        m.enable("1" * 40)
    assert m.CADDY.read_bytes() == original
    assert patched != original
    assert not fake_drop.exists()
    assert events.count("restart-auth") == 2
    assert ("systemctl", "reload", "caddy.service") in events
    assert ("systemctl", "restart", "fh-finance-personal.service") not in events


def test_emergency_disable_closes_caddy_first(monkeypatch, tmp_path):
    m = load()
    sha = "1" * 40
    original = original_caddy(m)
    m.BACKUPS = tmp_path
    backup = m.backup_path(sha)
    backup.write_bytes(original)
    m.CADDY = tmp_path / "site.caddy"
    m.CADDY.write_bytes(m.bank_caddy_patch(original))
    m.DROP95 = tmp_path / "95-bank-import-38.conf"
    m.DROP95.write_bytes(m.FLAG)
    seen = []
    monkeypatch.setenv("FH_BANK38_RELEASE", "DISABLE")
    monkeypatch.setattr(m.os, "geteuid", lambda: 0)
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    monkeypatch.setattr(m.finance, "secure_file",
                        lambda path, *_args: path.read_bytes())
    monkeypatch.setattr(m.finance, "caddy_snapshot",
                        lambda: (m.CADDY.read_bytes(), 0o640))
    monkeypatch.setattr(m.finance, "atomic_replace",
                        lambda path, contents, **kw: (
                            seen.append("close-public-route"), path.write_bytes(contents)))
    monkeypatch.setattr(m.finance, "run",
                        lambda args, **kw: seen.append(tuple(args)) or "")
    monkeypatch.setattr(m, "restart_auth", lambda: seen.append("restart-auth"))
    monkeypatch.setattr(m.finance, "local_probe", lambda path: 404)
    m.disable(sha)
    assert not m.DROP95.exists()
    assert m.CADDY.read_bytes() == original
    assert seen.index("close-public-route") < seen.index("restart-auth")


def test_script_cannot_run_from_ci_and_has_no_database_mutation_commands():
    m = load()
    assert m.verified_sha("a" * 40) == "a" * 40
    with pytest.raises(m.Hold, match="INVALID_EXACT_SHA"):
        m.verified_sha("../new")
    run = subprocess.run(
        [sys.executable, str(SCRIPT), "--sha", "a" * 40, "--preflight"],
        env={"GITHUB_ACTIONS": "true", "PATH": "/usr/bin:/bin"},
        capture_output=True, text=True, timeout=15, check=False,
    )
    assert run.returncode != 0
    assert "TRUSTED_NATIVE_ROOT_REQUIRED" in run.stdout
    code = SCRIPT.read_text(encoding="utf-8")
    for forbidden in ("DROP TABLE", "docker compose down", "UPDATE finance.",
                      "DELETE FROM", "DROP ROLE", "indexedDB.deleteDatabase"):
        assert forbidden not in code
