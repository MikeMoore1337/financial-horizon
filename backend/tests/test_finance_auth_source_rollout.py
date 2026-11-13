"""No-production-write regressions for the personal FH auth source rollout."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
SCRIPT = SCRIPTS / "fh_finance_auth_source_rollout.py"


def load():
    sys.path.insert(0, str(SCRIPTS))
    spec = importlib.util.spec_from_file_location("fh_finance_auth_source_rollout", SCRIPT)
    assert spec and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_sha_validation_and_no_implicit_release():
    m = load()
    assert m.versioned_sha("a" * 40) == "a" * 40
    for invalid in ("", "main", "F" * 40, "../" + "a" * 40,
                    "0" * 39, "0" * 41):
        with pytest.raises(m.NoGo):
            m.versioned_sha(invalid)


@pytest.mark.parametrize("mode", ("--preflight", "--stage", "--apply"))
def test_github_actions_is_prohibited_from_operating_production(mode):
    env = dict(os.environ, GITHUB_ACTIONS="true")
    result = subprocess.run(
        [sys.executable, str(SCRIPT), mode, "--sha", "a" * 40],
        env=env, capture_output=True, text=True, timeout=5, check=False,
    )
    assert result.returncode != 0
    assert "FINANCE_BACKEND_RELEASE=NO_GO" in result.stdout
    assert "FAILURE_CODE=AUTHORIZED_PRODUCTION_ROOT_REQUIRED" in result.stdout
    assert result.stderr == ""


def test_stage_source_manifest_rejects_symlinks_and_cannot_hide_modified_code(tmp_path):
    m = load()
    for package in m.PACKAGES:
        d = tmp_path / package
        d.mkdir()
        (d / "module.py").write_text("value = 3\n", encoding="utf-8")
    original = m.source_files(tmp_path)
    assert len(original) == len(m.PACKAGES)
    (tmp_path / "finance_db" / "module.py").write_text("value = 4\n", encoding="utf-8")
    assert original != m.source_files(tmp_path)
    (tmp_path / "finance_api" / "escape.py").symlink_to(
        tmp_path / "finance_db" / "module.py"
    )
    with pytest.raises(m.NoGo, match="SYMLINK_IN_BACKEND_SOURCE"):
        m.source_files(tmp_path)


def test_dropin_is_exact_source_override_and_never_changes_oauth_env(tmp_path):
    m = load()
    target = tmp_path / ("a" * 40)
    source = m.dropin_content(target, [
        "fh_email_auth.app:app", "--host", "127.0.0.1", "--port", "9127",
        "--no-access-log",
    ])
    assert source.count("ExecStart=") == 2
    assert "80-finance-source" not in source
    assert f"WorkingDirectory={target / 'backend'}" in source
    assert f"PYTHONPATH={target}:{target / 'backend'}" in source
    assert "EnvironmentFile" not in source
    assert "FH_FINANCE_RUNTIME_MODE" not in source
    assert "Finance" not in source
    with pytest.raises(m.NoGo, match="SYSTEMD_EXEC_ARGUMENT_UNSAFE"):
        m.dropin_content(target, ["fh_email_auth.app:app", "--bad=1;touch /tmp/x"])


def test_live_four_oauth_providers_must_be_unchanged(monkeypatch):
    m = load()
    monkeypatch.setattr(m, "auth_status", lambda port, path: (
        (200, {"enabled": True,
               "providers": ["google", "telegram", "yandex", "vk"]})
        if path == "/api/auth/providers"
        else (200, {"authenticated": False})
    ))
    assert m.auth_baseline(8791) == ("google", "telegram", "vk", "yandex")
    monkeypatch.setattr(m, "auth_status", lambda port, path: (
        (200, {"enabled": True, "providers": ["google"]})
        if path == "/api/auth/providers"
        else (200, {"authenticated": False})
    ))
    with pytest.raises(m.NoGo, match="FOUR_OAUTH_PROVIDERS_NOT_ACTIVE"):
        m.auth_baseline(8791)


def test_feature_and_runtime_not_mounted_by_source_switch():
    m = load()
    content = SCRIPT.read_text(encoding="utf-8")
    assert "finance_still_off(port)" in content
    assert "FINANCE_RUNTIME_FLAGS=OFF" in content
    assert "CADDY_CHANGED=NO" in content
    assert "AUTH_SQLITE_PROTECTED_BACKUP=PASS" in content
    assert "AUTH_SQLITE_RESTORED=NO" in content
    assert "FINANCE_BACKEND_ROLLBACK=PASS" in content
    assert "70-oauth.conf" in content and "80-finance-source.conf" in content
    assert "sqlite3.connect(filename)" in content
    assert "source.backup(output)" in content
    assert all(x not in content for x in (
        "docker compose down", "DROP TABLE", "sqlite3.connect(':memory:')",
        "FH_FINANCE_RUNTIME_MODE=personal", "systemctl stop fh-finance-personal",
    ))


def test_script_has_no_unexpected_top_level_execution():
    result = subprocess.run(
        [sys.executable, "-m", "py_compile", str(SCRIPT)],
        capture_output=True, text=True, timeout=5, check=False,
    )
    assert result.returncode == 0, result.stderr


def test_release_link_switch_is_atomic_and_checks_expected_old_release(tmp_path, monkeypatch):
    m = load()
    releases = tmp_path / "releases"
    releases.mkdir()
    old = releases / ("a" * 40)
    new = releases / ("b" * 40)
    old.mkdir()
    new.mkdir()
    current = tmp_path / "current"
    current.symlink_to(old)
    monkeypatch.setattr(m, "RELEASES", releases)
    monkeypatch.setattr(m, "CURRENT", current)

    m.switch_current(old, new)
    assert current.is_symlink() and current.resolve() == new
    assert old.is_dir()
    with pytest.raises(m.NoGo, match="AUTH_RELEASE_LINK_CHANGED"):
        m.switch_current(old, new)
    m.switch_current(new, old)
    assert current.resolve() == old
