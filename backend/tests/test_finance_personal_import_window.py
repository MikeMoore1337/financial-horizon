"""#69 private personal import activation: synthetic, NO production writes."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
SCRIPT = SCRIPTS / "fh_finance_personal_import_window.py"


def load():
    sys.path.insert(0, str(SCRIPTS))
    try:
        spec = importlib.util.spec_from_file_location(
            "fh_finance_personal_import_window", SCRIPT
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(SCRIPTS))


def fixture_caddy(m):
    return (
        "fin-horizon.mikemoore.top:8444 {\n"
        + m.finance.ROUTES
        + "    @fh_oauth_live_get {\n"
        + "        method GET\n"
        + "        path /api/auth/providers\n"
        + "    }\n"
        + "    handle @fh_oauth_live_get { reverse_proxy 127.0.0.1:9138 }\n"
        + "}\n"
    ).encode("utf-8")


def fixture_env():
    return (
        b"FH_FINANCE_RUNTIME_MODE=personal\n"
        b"FH_FINANCE_V2_RUNTIME=on\n"
        b"FH_FINANCE_IMPORT_RUNTIME=off\n"
        b"FH_FINANCE_PROFILE_NAMESPACE=b2a81324-f19e-46ec-8851-c16e0c94462d\n"
    )


def test_only_three_new_exact_post_routes_with_no_wildcard_or_oauth_changes():
    m = load()
    base = fixture_caddy(m)
    patched = m.caddy_import_patch(base)
    assert patched.replace(m.IMPORT_ROUTING.encode(), b"", 1) == base
    assert patched.count(b"@fh_personal_import_write") == 2
    assert patched.count(b"method POST") >= 2
    assert b"reverse_proxy 127.0.0.1:9138" in patched
    assert b"handle @fh_oauth_live_get" in patched
    assert b"method GET\n        path /api/finance/v1/import/" not in patched
    assert b"/api/finance/v1/import/*" not in patched
    for p in ("manifest", "commit", "restore"):
        assert patched.count(
            ("/api/finance/v1/import/" + p).encode()
        ) == 1
    for invalid in (
        base + b"/api/finance/v1/import/manifest\n",
        patched,
        base.replace(b"handle @fh_finance_write", b"handle @unknown"),
        base.replace(b"method POST", b"method GET"),
        b"arbitrary sites",
    ):
        with pytest.raises(m.Hold, match="CADDY_FINANCE_LAYOUT_UNRECOGNIZED"):
            m.caddy_import_patch(invalid)


def test_private_runtime_diff_changes_only_import_flag():
    m = load()
    source = fixture_env()
    mode, normalized = m.checked_runtime(source)
    assert mode == "off" and normalized == source
    enabled = source.replace(m.OFF, m.ON)
    mode, normalized = m.checked_runtime(enabled)
    assert mode == "on" and normalized == source
    assert normalized.replace(m.OFF, m.ON) == enabled
    for invalid in (
        source + m.OFF,
        source.replace(b"personal", b"off"),
        source.replace(b"FH_FINANCE_V2_RUNTIME=on",
                       b"FH_FINANCE_V2_RUNTIME=off"),
        source.replace(m.OFF, b"FH_FINANCE_IMPORT_RUNTIME=ON\n"),
        source + b"FH_FINANCE_DATABASE_URL=postgresql://leak\n",
        source.replace(b"PROFILE_NAMESPACE", b"PROFILE_NAMESPACE_CHANGED"),
    ):
        with pytest.raises(m.Hold):
            m.checked_runtime(invalid)


def test_import_flag_enabling_is_dormant_without_explicit_root_token(monkeypatch):
    m = load()
    original = fixture_env()
    caddy = fixture_caddy(m)
    monkeypatch.setattr(m, "live_preflight", lambda sha: (original, caddy, 0o640, "off"))
    monkeypatch.setattr(m, "backup_paths", lambda sha: (
        Path("/synthetic/backup-runtime"), Path("/synthetic/backup-caddy")
    ))
    monkeypatch.setattr(Path, "exists", lambda _self: False)
    monkeypatch.setattr(Path, "is_symlink", lambda _self: False)
    monkeypatch.delenv("FH_PERSONAL_IMPORT_WINDOW", raising=False)
    calls = []
    monkeypatch.setattr(m.finance, "atomic_replace", lambda *a, **kw: calls.append(a))
    with pytest.raises(m.Hold, match="EXPLICIT_OWNER_ENABLE_REQUIRED"):
        m.enable("1" * 40)
    assert calls == []


def test_failed_public_smoke_restores_runtime_caddy_and_restarts_auth(
    monkeypatch, tmp_path,
):
    m = load()
    original_runtime = fixture_env()
    original_caddy = fixture_caddy(m)
    values = {m.RUNTIME: original_runtime, m.CADDY: original_caddy}
    events = []
    monkeypatch.setenv("FH_PERSONAL_IMPORT_WINDOW", "ENABLE")
    monkeypatch.setattr(m, "live_preflight",
                        lambda _sha: (original_runtime, original_caddy, 0o640, "off"))
    monkeypatch.setattr(m, "BACKUPS", tmp_path)
    monkeypatch.setattr(m.backend, "check_checkout", lambda *a: events.append("attest"))
    monkeypatch.setattr(m.source, "backup_live_auth_db",
                        lambda: events.append("auth-db-backup"))
    monkeypatch.setattr(m.finance, "write_exclusive",
                        lambda path, content, **kw: events.append("backup"))
    monkeypatch.setattr(m.finance, "atomic_replace",
                        lambda path, data, **kw: values.__setitem__(path, data))
    monkeypatch.setattr(m.finance, "caddy_snapshot",
                        lambda: (values[m.CADDY], 0o640))
    monkeypatch.setattr(m.finance, "run",
                        lambda args, **kwargs: events.append(tuple(args)) or "")
    monkeypatch.setattr(m, "restart_auth", lambda: events.append("restart-auth"))
    monkeypatch.setattr(m.finance, "local_probe",
                        lambda path, **kwargs: (
                            401 if b"IMPORT_RUNTIME=on" in values[m.RUNTIME] else 404))
    monkeypatch.setattr(m.finance, "public_probe",
                        lambda path, **kwargs: 503)
    with pytest.raises(m.Hold, match="IMPORT_PUBLIC_DENY_ANONYMOUS_OR_CSRF_FAILED"):
        m.enable("1" * 40)
    assert values[m.RUNTIME] == original_runtime
    assert values[m.CADDY] == original_caddy
    assert events.index("auth-db-backup") < events.index("restart-auth")
    assert events.count("restart-auth") == 2
    assert ("systemctl", "restart", "fh-finance-personal.service") not in events


def test_disable_first_closes_public_route_then_auth_runtime(monkeypatch, tmp_path):
    m = load()
    old_runtime = fixture_env()
    old_caddy = fixture_caddy(m)
    monkeypatch.setattr(m, "BACKUPS", tmp_path)
    backup_runtime, backup_caddy = m.backup_paths("1" * 40)
    values = {
        backup_runtime: old_runtime,
        backup_caddy: old_caddy,
        m.RUNTIME: old_runtime.replace(m.OFF, m.ON),
        m.CADDY: m.caddy_import_patch(old_caddy),
    }
    order = []
    monkeypatch.setenv("FH_PERSONAL_IMPORT_WINDOW", "DISABLE")
    monkeypatch.setattr(m.os, "geteuid", lambda: 0)
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    monkeypatch.setattr(m.finance, "secure_file",
                        lambda path, *_a: values[path])
    monkeypatch.setattr(m.finance, "caddy_snapshot",
                        lambda: (values[m.CADDY], 0o640))
    monkeypatch.setattr(m.finance, "atomic_replace",
                        lambda path, data, **kwargs:
                        (order.append(("write", path)), values.__setitem__(path, data)))
    monkeypatch.setattr(m.finance, "run",
                        lambda args, **kw: order.append(tuple(args)) or "")
    monkeypatch.setattr(m, "restart_auth", lambda: order.append(("restart-auth",)))
    monkeypatch.setattr(m.finance, "local_probe", lambda *a, **kw: 404)
    monkeypatch.setattr(m.finance, "enabled_local_smoke", lambda: None)
    m.disable("1" * 40)
    assert values[m.CADDY] == old_caddy
    assert values[m.RUNTIME] == old_runtime
    assert order.index(("write", m.CADDY)) < order.index(("write", m.RUNTIME))
    assert ("systemctl", "reload", "caddy.service") in order
    assert ("restart-auth",) in order


def test_bad_production_mode_does_not_touch_external_resources():
    m = load()
    for bad in ("main", "../path", "a" * 39):
        with pytest.raises(m.Hold, match="INVALID_SHA"):
            m.verified_sha(bad)
    p = subprocess.run(
        [sys.executable, str(SCRIPT), "--sha", "a" * 40, "--preflight"],
        capture_output=True, text=True, timeout=15,
        env={"GITHUB_ACTIONS": "true", "PATH": "/usr/bin:/bin"}, check=False,
    )
    assert p.returncode != 0
    assert p.stdout.startswith("FH_IMPORT_WINDOW=NO_GO")
    assert "AUTHORIZED_PRODUCTION_ROOT_ONLY" in p.stdout
    text = SCRIPT.read_text(encoding="utf-8")
    assert "FH_PERSONAL_IMPORT_WINDOW" in text
    for forbidden in (
        "DROP TABLE", "DELETE FROM", "ALTER ROLE", "docker compose down",
        "rm -rf", "indexedDB.deleteDatabase", "post_import_financial_data",
    ):
        assert forbidden not in text
