"""#33/#70: synthetic negative tests for opt-in finance HTTP release gating."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import os
import subprocess
import sys

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/fh_finance_private_api_release.py"


def module():
    spec = importlib.util.spec_from_file_location("fh_finance_private_api_release", SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_exact_private_runtime_and_stable_identity_reject_changes(monkeypatch):
    m = module()
    password = "a" * 64
    monkeypatch.setattr(m, "role_password", lambda: password)
    runtime = {
        "FH_FINANCE_RUNTIME_MODE": "personal",
        "FH_FINANCE_V2_RUNTIME": "on",
        "FH_FINANCE_IMPORT_RUNTIME": "off",
        "FH_FINANCE_PROFILE_NAMESPACE": "b2a81324-f19e-46ec-8851-c16e0c94462d",
    }
    body = "".join(k + "=" + v + "\n" for k, v in runtime.items())
    assert m.parse_runtime(body) == runtime
    for modified in (
        body.replace("MODE=personal", "MODE=off"),
        body.replace("V2_RUNTIME=on", "V2_RUNTIME=off"),
        body.replace("IMPORT_RUNTIME=off", "IMPORT_RUNTIME=on"),
        body.replace("PROFILE_NAMESPACE=b2a81324-f19e-46ec-8851-c16e0c94462d",
                     "PROFILE_NAMESPACE=00000000-0000-0000-0000-000000000000"),
        body + "FH_FINANCE_DATABASE_URL=" + m.dsn(password) + "\n",
        body + "FH_FINANCE_PROFILE_NAMESPACE=extra\n",
        body + "FH_RUNTIME_UNKNOWN=1\n",
        body + "BASH='hello world'\n",
    ):
        with pytest.raises(m.NoGo):
            m.parse_runtime(modified)
    with pytest.raises(m.NoGo):
        m.dsn("p@ss")


def test_caddy_patch_has_only_approved_authenticated_routes():
    m = module()
    original = (
        "fin-horizon.mikemoore.top:8444 {\n"
        "    @fh_oauth_live_get {\n"
        "        method GET\n"
        "        path /api/auth/providers\n"
        "    }\n"
        "    handle @fh_oauth_live_get { reverse_proxy 127.0.0.1:9138 }\n"
        "    handle @fh_oauth_live_post { reverse_proxy 127.0.0.1:9138 }\n"
        "}\n"
    )
    updated = m.compose_caddy(original)
    assert updated.replace(m.ROUTES, "", 1) == original
    assert updated.count(m.ROUTES) == 1
    assert "127.0.0.1:9138" in updated
    assert "0.0.0.0:" not in updated
    for marker in ("/api/finance/v1/state", "/api/finance/v1/changes",
                   "/api/auth/email/finance/session",
                   "/api/finance/v1/commands", "/api/finance/v2/commands"):
        assert marker in m.ROUTES
    assert "method GET" in m.ROUTES and "method POST" in m.ROUTES
    assert "/api/finance/v1/import" not in m.ROUTES
    assert "/api/finance/v2/import" not in m.ROUTES
    assert "path /api/finance/*" not in m.ROUTES
    assert "@fh_oauth_live_get" in updated and "@fh_oauth_live_post" in updated
    for unsafe in (updated, original.replace(m.CADDY_MARKER,
                                             m.CADDY_MARKER + "/api/finance/v1/state"),
                   original.replace("handle @fh_oauth_live_post",
                                    "handle @oops"), ""):
        if unsafe != original:
            with pytest.raises(m.NoGo):
                m.compose_caddy(unsafe)


def test_private_runtime_never_enabled_from_default_or_invalid_args():
    for args in (["--preflight"], ["--prepare"], ["--enable-local"],
                 ["--publish"], ["--rollback"]):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *args, "--sha", "a" * 40],
            env={**os.environ, "GITHUB_ACTIONS": "true"},
            capture_output=True, text=True, timeout=5, check=False,
        )
        assert result.returncode != 0
        assert result.stderr == ""
        assert "FINANCE_API_RELEASE=NO_GO" in result.stdout


def test_no_financial_data_migration_or_settings_side_effects_in_release_script():
    source = SCRIPT.read_text(encoding="utf-8")
    assert "FINANCE_API_IMPORT=OFF" in source
    assert "FINANCE_API_LOCAL_ENABLED=PASS" in source
    assert "FINANCE_HTTPS_ORIGIN_ROUTING=PASS" in source
    assert "FINANCE_LOCAL_ROLLBACK=PASS" in source
    assert "CADDY_FINANCE_ROLLBACK=PASS" in source
    assert "FINANCE_PROFILE_NAMESPACE_BACKUP=PASS" in source
    assert "FINANCE_ROLLBACK" in source
    for forbidden in (
        "docker compose down", "DROP TABLE", "CREATE ROLE",
        "FH_FINANCE_IMPORT_RUNTIME=on", "fh-finance-accounts\" content=\"enabled",
        "systemctl stop fh-finance-personal", "rm -rf",
        "ALTER TABLE", "idempotency_key=unverified",
    ):
        assert forbidden not in source


def test_caddy_rollback_rejects_unexpected_concurrent_edits(tmp_path, monkeypatch):
    m = module()
    backup_root = tmp_path / "backups"
    backup_root.mkdir()
    stage = tmp_path / "caddy"
    original = (
        "    @fh_oauth_live_get {\n"
        "    handle @fh_oauth_live_get { reverse_proxy 127.0.0.1:9138 }\n"
        "    handle @fh_oauth_live_post { reverse_proxy 127.0.0.1:9138 }\n"
    )
    stage.write_text(original, encoding="utf-8")
    source = stage.read_bytes()
    monkeypatch.setattr(m, "CADDY", stage)
    monkeypatch.setattr(m, "BACKUPS", backup_root)
    backup = m.caddy_original_backup("a" * 40)
    assert backup.name == "fh-finance-api-caddy.original.bak"
    assert backup.parent == backup_root
    m.write_exclusive(backup, source)
    assert backup.read_bytes() == source
    stage.write_text("concurrent Caddy admin edits", encoding="utf-8")
    with pytest.raises(m.NoGo, match="UNRECOGNIZED_CADDY_FINANCE_ROUTING"):
        m.compose_caddy(stage.read_text())


def test_rollback_is_never_silent_or_implicit():
    m = module()
    with pytest.raises(m.NoGo, match="ROLLBACK_EXPLICIT_ROOT_APPROVAL_REQUIRED"):
        m.rollback("a" * 40)



def test_least_privilege_postgres_probe_uses_service_identity_no_sql_data(monkeypatch):
    from types import SimpleNamespace

    m = module()
    seen = {}
    monkeypatch.setattr(m, "python_binary", lambda: Path(sys.executable))
    monkeypatch.setattr(
        m.pwd, "getpwnam",
        lambda username: SimpleNamespace(pw_dir="/var/empty", pw_uid=1234, pw_gid=1234),
    )

    def fake_run(args, **kwargs):
        seen["args"] = args
        seen["options"] = kwargs
        compile(args[2], "<finance-probe>", "exec")
        return ""

    monkeypatch.setattr(m, "run", fake_run)
    url = m.dsn("a" * 64)
    m.role_connectivity(url)
    assert seen["args"][:2] == [sys.executable, "-c"]
    assert "finance.finance_profiles LIMIT 0" in seen["args"][2]
    assert "COUNT(*) FROM pg_class" in seen["args"][2]
    assert "FH_FINANCE_DATABASE_URL" in seen["args"][2]
    assert url not in seen["args"][2]
    assert seen["options"]["user"] == "fh-email-auth"
    assert seen["options"]["env"]["FH_FINANCE_DATABASE_URL"] == url
    assert seen["options"]["error"] == "FH_RUNTIME_DATABASE_ROLE_UNUSABLE"



def test_systemd_finance_credential_dropin_has_no_password_or_shell(monkeypatch):
    m = module()
    monkeypatch.setattr(
        m, "python_binary",
        lambda: Path("/opt/financial-horizon-auth/releases/abc/.finance-venv/bin/python"),
    )
    monkeypatch.setattr(
        m, "approved_uvicorn_args",
        lambda: [
            "fh_email_auth.app:app", "--host", "127.0.0.1", "--port", "9138",
            "--no-access-log",
        ],
    )
    content = m.finance_systemd_dropin().decode("ascii")
    assert content.startswith("[Service]\n")
    assert "LoadCredential=fh_finance_runtime_password:" in content
    assert "EnvironmentFile=/etc/financial-horizon/finance/runtime.env" in content
    assert "ExecStart=\n" in content
    assert "ExecStart=/opt/financial-horizon-auth/releases/abc/.finance-venv/bin/python" in content
    assert "finance_api_launcher.py -- fh_email_auth.app:app" in content
    assert "fh_email_auth.app:app --host 127.0.0.1 --port 9138" in content
    assert "FH_FINANCE_DATABASE_URL" not in content
    assert "fh_finance_runtime:" not in content
    assert "sh -c" not in content and "/bin/bash" not in content


def test_launcher_fails_closed_without_service_credentials():
    file = SCRIPT.parent / "fh_finance_api_launcher.py"
    assert file.is_file()
    for args in ([], ["--", "not-the-auth-app"]):
        result = subprocess.run(
            [sys.executable, str(file), *args],
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
            capture_output=True, text=True, timeout=5, check=False,
        )
        assert result.returncode != 0
        assert "FINANCE_LAUNCHER_NO_GO" in result.stderr
        assert "postgresql" not in result.stderr
    result = subprocess.run(
        [sys.executable, str(file), "--", "fh_email_auth.app:app"],
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
        capture_output=True, text=True, timeout=5, check=False,
    )
    assert result.returncode != 0
    assert "SYSTEMD_CREDENTIALS_REQUIRED" in result.stderr
    assert "postgresql" not in result.stderr


def test_runtime_file_does_not_store_any_password(monkeypatch):
    m = module()
    password = "e" * 64
    monkeypatch.setattr(m, "role_password", lambda: password)
    saved = {
        "FH_FINANCE_RUNTIME_MODE": "personal",
        "FH_FINANCE_V2_RUNTIME": "on",
        "FH_FINANCE_IMPORT_RUNTIME": "off",
        "FH_FINANCE_PROFILE_NAMESPACE": "b2a81324-f19e-46ec-8851-c16e0c94462d",
    }
    data = "".join(k + "=" + v + "\n" for k, v in saved.items())
    assert m.parse_runtime(data) == saved
    assert password not in data
    assert "DATABASE_URL" not in data
    assert "LoadCredential" in SCRIPT.read_text(encoding="utf-8")
    assert "CREDENTIALS_DIRECTORY" in (
        SCRIPT.parent / "fh_finance_api_launcher.py"
    ).read_text(encoding="utf-8")



def test_codeql_security_fixes_require_owner_only_create_and_tls_12_floor():
    source = SCRIPT.read_text(encoding="utf-8")
    assert (
        "os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)"
        in source
    )
    assert 'context.minimum_version = ssl.TLSVersion.TLSv1_2' in source
    assert 'write_exclusive(FINANCE_DROPIN, content, mode=0o600)' in source
    assert 'os.fchown(fd, 0, account.pw_gid)' in source
    assert 'os.fchmod(fd, 0o640)' in source
    assert 'os.chmod(LAUNCHER_INSTALLED, 0o640)' not in source
    assert 'LAUNCHER_INSTALLED.stat().st_gid != account.pw_gid' in source
    assert "ssl.CERT_NONE" not in source
    assert "check_hostname = False" not in source
