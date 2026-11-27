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
    # Exact finance reverse_proxy layout installed by the existing
    # fh_finance_etag_transport.py release. This preserves strong ETags.
    finance_routes = m.finance.ROUTES
    for name in ("read", "write"):
        old = (
            f"    handle @fh_finance_{name} {{\n"
            "        reverse_proxy 127.0.0.1:9138\n"
            "    }\n"
        )
        new = (
            f"    handle @fh_finance_{name} {{\n"
            "        reverse_proxy 127.0.0.1:9138 {\n"
            '            header_down Cache-Control "private, no-store, no-transform"\n'
            "        }\n"
            "    }\n"
        )
        assert finance_routes.count(old) == 1
        finance_routes = finance_routes.replace(old, new, 1)
    return (
        "fin-horizon.mikemoore.top:8444 {\n"
        + finance_routes
        + "    @fh_oauth_live_get {\n"
        + "        method GET\n"
        + "        path /api/auth/providers\n"
        + "    }\n"
        + "    handle @fh_oauth_live_get { reverse_proxy 127.0.0.1:9138 }\n"
        + "}\n"
    ).encode("utf-8")


def test_nested_finance_fixture_matches_shipped_etag_release_contract():
    """Prevent synthetic tests drifting away from actual owner Caddy history."""
    spec = importlib.util.spec_from_file_location(
        "fh_finance_etag_transport", SCRIPTS / "fh_finance_etag_transport.py",
    )
    assert spec and spec.loader is not None
    etag = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(SCRIPTS))
    try:
        spec.loader.exec_module(etag)
    finally:
        sys.path.remove(str(SCRIPTS))
    m = load()
    site = fixture_caddy(m)
    assert site.count(etag.NEW_READ.encode()) == 1
    assert site.count(etag.NEW_WRITE.encode()) == 1
    assert site.count(etag.HEADER.encode()) == 2
    assert etag.OLD_READ.encode() not in site
    assert etag.OLD_WRITE.encode() not in site


def fixture_env():
    return (
        b"FH_FINANCE_RUNTIME_MODE=personal\n"
        b"FH_FINANCE_V2_RUNTIME=on\n"
        b"FH_FINANCE_IMPORT_RUNTIME=off\n"
        b"FH_FINANCE_PROFILE_NAMESPACE=b2a81324-f19e-46ec-8851-c16e0c94462d\n"
    )


def test_only_exact_import_routes_with_no_wildcard_or_oauth_changes():
    m = load()
    base = fixture_caddy(m)
    patched = m.caddy_import_patch(base)
    assert patched.replace(m.IMPORT_ROUTING.encode(), b"", 1) == base
    assert patched.count(b"@fh_personal_import_write") == 2
    assert patched.count(b"method POST") >= 2
    assert b"reverse_proxy 127.0.0.1:9138" in patched
    assert patched.count(b'header_down Cache-Control "private, no-store, no-transform"') == 3
    assert b"handle @fh_oauth_live_get" in patched
    assert (b"method GET\n        path /api/finance/v1/import/bank/rows\n" in patched)
    assert patched.count(b"@fh_personal_import_read") == 2
    assert patched.count(b"/api/finance/v1/import/bank/rows") == 1
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
        with pytest.raises(m.Hold, match="^CADDY_FINANCE_"):
            m.caddy_import_patch(invalid)


def test_bank_reconciliation_read_requires_anonymous_denial(monkeypatch):
    m = load()
    def probe(path, *, method="GET", origin=None):
        if path == "/api/auth/providers":
            return 200
        if method == "POST" and origin == "https://untrusted.example":
            return 403
        return 401
    monkeypatch.setattr(m.finance,"local_probe",probe)
    monkeypatch.setattr(m.finance,"public_probe",probe)
    m.verify_enabled()
    monkeypatch.setattr(m.finance,"public_probe",lambda path, **kw:
                        200 if path == "/api/finance/v1/import/bank/rows" else probe(path,**kw))
    with pytest.raises(m.Hold,match="IMPORT_BANK_READ_ANONYMOUS_GUARD_FAILED"):
        m.verify_enabled()


def test_interleaved_existing_finance_caddy_blocks_are_safe_and_preserved():
    """Production: separate valid read/write blocks, no contiguous ROUTES."""
    m = load()
    original = fixture_caddy(m).decode("utf-8")
    marker = "    @fh_finance_write {"
    unrelated = (
        "    @fh_auxiliary_health {\n"
        "        method GET\n"
        "        path /internal-healthz\n"
        "    }\n"
        "    handle @fh_auxiliary_health {\n"
        "        reverse_proxy 127.0.0.1:9138\n"
        "    }\n"
    )
    assert original.count(marker) == 1
    current = original.replace(marker, unrelated + marker, 1).encode("utf-8")
    assert current.count(m.finance.ROUTES.encode("utf-8")) == 0
    # Matches the operator's diagnostic: one matcher+one handle per finance
    # method, but their old contiguous constant is absent.
    assert current.count(b"@fh_finance_read {") == 2
    assert current.count(b"handle @fh_finance_read {") == 1
    assert current.count(b"@fh_finance_write {") == 2
    assert current.count(b"handle @fh_finance_write {") == 1
    result = m.caddy_import_patch(current)
    assert result.replace(m.IMPORT_ROUTING.encode(), b"", 1) == current
    assert result.count(b"/api/finance/v1/import/manifest") == 1
    assert result.count(b"@fh_personal_import_write") == 2
    assert result.count(b"@fh_auxiliary_health") == 2
    with pytest.raises(m.Hold, match="CADDY_FINANCE_LAYOUT_UNRECOGNIZED"):
        m.caddy_import_patch(result)


def test_caddy_approved_existing_path_alternative_order_does_not_change_policy():
    m = load()
    base = fixture_caddy(m)
    rearranged = (
        base.replace(
            b"path /api/finance/v1/state /api/finance/v1/changes",
            b"path /api/finance/v1/changes /api/finance/v1/state",
        )
        .replace(
            b"path /api/auth/email/finance/session /api/finance/v1/commands /api/finance/v2/commands",
            b"path /api/finance/v2/commands /api/auth/email/finance/session /api/finance/v1/commands",
        )
    )
    assert rearranged != base
    assert m.caddy_import_patch(rearranged).replace(
        m.IMPORT_ROUTING.encode(), b"", 1
    ) == rearranged


@pytest.mark.parametrize("tamper", [
    lambda b: b.replace(b"method GET", b"method POST", 1),
    lambda b: b.replace(
        b'header_down Cache-Control "private, no-store, no-transform"',
        b'header_down Cache-Control "private, no-store"', 1,
    ),
    lambda b: b.replace(
        b'header_down Cache-Control "private, no-store, no-transform"',
        b'header_down ETag W/"forged"', 1,
    ),
    lambda b: b.replace(
        b"reverse_proxy 127.0.0.1:9138 {",
        b"reverse_proxy 127.0.0.1:9138", 1,
    ),
    lambda b: b.replace(
        b'header_down Cache-Control "private, no-store, no-transform"',
        b'header_down Cache-Control "private, no-store, no-transform"\\n            header_up Authorization leaked', 1,
    ),
    lambda b: b.replace(b"method POST", b"method GET", 1),
    lambda b: b.replace(
        b"path /api/finance/v1/state /api/finance/v1/changes",
        b"path /api/finance/v1/state /api/finance/v1/changes /api/finance/v1/*",
    ),
    lambda b: b.replace(
        b"path /api/auth/email/finance/session /api/finance/v1/commands /api/finance/v2/commands",
        b"path /api/auth/email/finance/session /api/finance/v1/commands",
    ),
    lambda b: b.replace(
        b"path /api/auth/email/finance/session /api/finance/v1/commands /api/finance/v2/commands",
        b"path /api/auth/email/finance/session /api/finance/v1/commands /api/finance/v2/commands /api/finance/v1/import/commit",
    ),
    lambda b: b.replace(
        b"reverse_proxy 127.0.0.1:9138", b"reverse_proxy 0.0.0.0:9138", 1
    ),
    lambda b: b.replace(
        b"reverse_proxy 127.0.0.1:9138",
        b"reverse_proxy 127.0.0.1:9138\n        uri strip_prefix /api/",
        1
    ),
    lambda b: b.replace(
        b"    handle @fh_finance_write {",
        b"    handle @fh_finance_write {\n        route {"
    ),
    lambda b: b.replace(
        b"    @fh_finance_write {",
        b"    @fh_finance_write {\n        method POST\n    }\n    @fh_finance_write {",
    ),
    lambda b: b.replace(
        b"    handle @fh_finance_read {",
        b"    handle @fh_finance_read {\n        reverse_proxy 127.0.0.1:9138\n    }\n    handle @fh_finance_read {",
    ),
    lambda b: b.replace(b"    @fh_oauth_live_get {", b"    @fh_untrusted_get {"),
])
def test_import_caddy_refuses_extra_matchers_methods_paths_proxy_or_rewrites(tamper):
    m = load()
    modified = tamper(fixture_caddy(m))
    assert modified != fixture_caddy(m)
    with pytest.raises(m.Hold, match="^CADDY_FINANCE_"):
        m.caddy_import_patch(modified)


def test_caddy_rejects_old_flat_proxy_layout_without_strong_etag_policy():
    m = load()
    source = (
        "fin-horizon.mikemoore.top:8444 {\n" +
        m.finance.ROUTES +
        "    @fh_oauth_live_get {\n"
        "        method GET\n"
        "        path /api/auth/providers\n"
        "    }\n"
        "}\n"
    ).encode("utf-8")
    with pytest.raises(m.Hold, match="CADDY_FINANCE_BLOCK_UNEXPECTED_DIRECTIVES"):
        m.caddy_import_patch(source)


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
    monkeypatch.setattr(
        m.finance, "local_probe",
        lambda path, **kwargs: (
            200 if path == "/api/auth/providers" else
            (401 if b"IMPORT_RUNTIME=on" in values[m.RUNTIME] else 404)
            if path.startswith("/api/finance/v1/import/") else 401
        ),
    )
    monkeypatch.setattr(m.finance, "public_probe",
                        lambda path, **kwargs: 503)
    with pytest.raises(m.Hold, match="IMPORT_PUBLIC_DENY_ANONYMOUS_OR_CSRF_FAILED"):
        m.enable("1" * 40)
    assert values[m.RUNTIME] == original_runtime
    assert values[m.CADDY] == original_caddy
    assert events.index("auth-db-backup") < events.index("restart-auth")
    assert events.count("restart-auth") == 2
    assert ("systemctl", "restart", "fh-finance-personal.service") not in events


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("tampered", [False, True])
def test_disable_first_closes_public_route_then_auth_runtime(monkeypatch, tmp_path, legacy, tampered):
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
    if legacy:
        values[m.CADDY] = values[m.CADDY].replace(m.IMPORT_ROUTING.encode(),m.LEGACY_IMPORT_ROUTING.encode(),1)
    if tampered:
        values[m.CADDY] += b"# concurrent change\n"
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
    if tampered:
        before = dict(values)
        with pytest.raises(m.Hold,match="CADDY_CONCURRENT_CHANGE_REQUIRES_REVIEW"):
            m.disable("1" * 40)
        assert values == before and order == []
        return
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


def test_live_preflight_has_actual_exported_oauth_dropin_and_reaches_read_only_pass(
    monkeypatch, tmp_path, capsys,
):
    """Regression: source.OAUTH_DROPIN exists; source.DROP70 never existed.

    Exercise the real preflight control flow with synthetic responses, rather
    than stubbing live_preflight() itself as other candidate tests do.
    """
    m = load()
    from types import SimpleNamespace

    assert m.source.OAUTH_DROPIN.name == "70-oauth.conf"
    assert not hasattr(m.source, "DROP70")
    sha = "1" * 40

    monkeypatch.setattr(m.os, "geteuid", lambda: 0)
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    monkeypatch.setattr(m.backend, "check_checkout", lambda _sha: None)
    monkeypatch.setattr(m.source, "active_services", lambda: None)
    live = m.source.RELEASES / sha / "backend"
    monkeypatch.setattr(m, "current_source", lambda: live)
    monkeypatch.setattr(m.source, "source_files", lambda path: {"same": "hash"})

    actual_is_file = Path.is_file
    approved = {m.source.OAUTH_DROPIN, m.backend.DROP80, m.backend.DROP90}
    monkeypatch.setattr(
        Path, "is_file",
        lambda self: True if self in approved else actual_is_file(self),
    )
    monkeypatch.setattr(m.backend, "protected", lambda path, mode: b"synthetic")
    monkeypatch.setattr(m.backend, "expected_configs",
                        lambda *args: (b"safe-source", b"safe-runtime"))
    monkeypatch.setattr(m.finance, "enabled_local_smoke", lambda: None)
    monkeypatch.setattr(m, "launcher_ready", lambda: None)
    monkeypatch.setattr(
        m.finance, "public_probe",
        lambda path, **kwargs: 200 if path == "/api/auth/providers" else 401,
    )
    monkeypatch.setattr(m, "trusted_runtime_file", fixture_env)
    old_caddy = fixture_caddy(m)
    monkeypatch.setattr(m.finance, "caddy_snapshot",
                        lambda: (old_caddy, 0o640))
    monkeypatch.setattr(m.finance, "local_probe", lambda *args, **kw: 404)
    monkeypatch.setattr(m, "BACKUPS", tmp_path)
    actual_stat = Path.stat
    monkeypatch.setattr(
        Path, "stat",
        lambda self, **kw: SimpleNamespace(st_mode=0o40700, st_uid=0)
        if self == tmp_path else actual_stat(self, **kw),
    )

    runtime, caddy, caddy_mode, mode = m.live_preflight(sha)
    assert runtime == fixture_env()
    assert caddy == old_caddy
    assert caddy_mode == 0o640
    assert mode == "off"
    stdout = capsys.readouterr().out
    assert "FH_IMPORT_WINDOW_PREFLIGHT=PASS" in stdout
    assert "FH_IMPORT_RUNTIME_BEFORE=OFF" in stdout
    assert "FH_FINANCIAL_DATA_UNCHANGED=YES" in stdout


def test_import_preflight_rejects_legacy_installed_launcher_before_enable(
    tmp_path, monkeypatch,
):
    """The service launcher must be upgraded before changing runtime.env."""
    m = load()
    fake = tmp_path / "installed.py"
    fake.write_bytes(b"legacy-no-import-support")
    # The operator uses the native VPS checkout path; CI must explicitly
    # supply its actual synthetic repository source.
    monkeypatch.setattr(m.finance, "LAUNCHER_SOURCE",
                        SCRIPTS / "fh_finance_api_launcher.py")
    monkeypatch.setattr(m.finance, "LAUNCHER_INSTALLED", fake)
    monkeypatch.setattr(m.finance, "secure_file",
                        lambda path, *_args: path.read_bytes())
    monkeypatch.setattr(m.pwd, "getpwnam",
                        lambda _name: __import__("types").SimpleNamespace(
                            pw_gid=fake.stat().st_gid,
                        ))
    with pytest.raises(m.Hold, match="FINANCE_LAUNCHER_UPGRADE_REQUIRED"):
        m.launcher_ready()
    fake.write_bytes(m.finance.LAUNCHER_SOURCE.read_bytes())
    m.launcher_ready()


def test_import_enable_reuses_only_exact_matching_previous_rollback_receipts(
    tmp_path, monkeypatch, capsys,
):
    """Prior failure created two private backups before restoring OFF. Reuse."""
    m = load()
    original_runtime = fixture_env()
    original_caddy = fixture_caddy(m)
    values = {m.RUNTIME: original_runtime, m.CADDY: original_caddy}
    monkeypatch.setenv("FH_PERSONAL_IMPORT_WINDOW", "ENABLE")
    monkeypatch.setattr(m, "live_preflight",
                        lambda _sha: (original_runtime, original_caddy, 0o640, "off"))
    monkeypatch.setattr(m, "BACKUPS", tmp_path)
    r, c = m.backup_paths("1" * 40)
    r.write_bytes(original_runtime)
    c.write_bytes(original_caddy)
    monkeypatch.setattr(m.backend, "check_checkout", lambda *_args: None)
    monkeypatch.setattr(m.source, "backup_live_auth_db", lambda: None)
    monkeypatch.setattr(m.finance, "secure_file",
                        lambda path, *_args: path.read_bytes())
    monkeypatch.setattr(m.finance, "write_exclusive",
                        lambda *_args, **_kwargs: pytest.fail(
                            "Matching rollback receipts must be reused"
                        ))
    monkeypatch.setattr(m.finance, "atomic_replace",
                        lambda path, data, **kw: values.__setitem__(path, data))
    monkeypatch.setattr(m.finance, "caddy_snapshot",
                        lambda: (values[m.CADDY], 0o640))
    monkeypatch.setattr(m.finance, "local_probe",
                        lambda *_args, **_kw: 401)
    monkeypatch.setattr(m.finance, "run", lambda *_a, **_kw: "")
    monkeypatch.setattr(m, "restart_auth", lambda: None)
    monkeypatch.setattr(m, "verify_enabled", lambda: None)
    m.enable("1" * 40)
    assert values[m.RUNTIME] == original_runtime.replace(m.OFF, m.ON)
    assert values[m.CADDY] == m.caddy_import_patch(original_caddy)
    out = capsys.readouterr().out
    assert "FH_IMPORT_ORIGINAL_BACKUPS=VERIFIED_REUSE" in out
    assert "FH_IMPORT_WINDOW_BACKEND=ENABLED" in out


@pytest.mark.parametrize("tamper", ["runtime", "caddy", "partial"])
def test_import_previous_rollback_receipts_tampered_or_partial_halt_before_writes(
    tmp_path, monkeypatch, tamper,
):
    m = load()
    old = fixture_env()
    site = fixture_caddy(m)
    monkeypatch.setattr(m, "live_preflight", lambda _sha: (old, site, 0o640, "off"))
    monkeypatch.setattr(m, "BACKUPS", tmp_path)
    monkeypatch.setenv("FH_PERSONAL_IMPORT_WINDOW", "ENABLE")
    r, c = m.backup_paths("1" * 40)
    r.write_bytes(b"mismatch" if tamper == "runtime" else old)
    if tamper != "partial":
        c.write_bytes(b"mismatch" if tamper == "caddy" else site)
    monkeypatch.setattr(m.finance, "secure_file", lambda path, *_a: path.read_bytes())
    monkeypatch.setattr(m.finance, "write_exclusive",
                        lambda *_a, **_kw: pytest.fail("No writes on backup mismatch"))
    with pytest.raises(m.Hold, match="IMPORT_WINDOW_"):
        m.enable("1" * 40)

