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
    (tmp_path / "requirements.txt").write_text("fastapi==1.0\n", encoding="utf-8")
    (tmp_path / "requirements-finance.txt").write_text("sqlalchemy==2.0\n", encoding="utf-8")
    original = m.source_files(tmp_path)
    assert len(original) == len(m.PACKAGES) + 2
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


def test_restricted_source_copy_gets_service_group_read_without_world_access(
    tmp_path, monkeypatch,
):
    """shutil.copytree preserves 0700/0600 - the observed VPS deployment mode."""
    import types
    import stat

    m = load()
    releases = tmp_path / "releases"
    releases.mkdir()
    current_old = releases / ("a" * 40)
    current_old.mkdir()
    target = releases / ("b" * 40)
    target.mkdir(mode=0o700)
    source = target / "backend"
    source.mkdir(mode=0o700)
    package = source / "fh_email_auth"
    package.mkdir(mode=0o700)
    item = package / "__init__.py"
    item.write_text("from __future__ import annotations\n", encoding="utf-8")
    item.chmod(0o600)
    # A venv interpreter may be linked to a system-owned binary.
    venv = target / ".finance-venv"
    venv.mkdir(mode=0o700)
    (venv / "bin").mkdir(mode=0o700)
    (venv / "bin" / "python").symlink_to(sys.executable)

    current = tmp_path / "current"
    current.symlink_to(current_old)
    monkeypatch.setattr(m, "RELEASES", releases)
    monkeypatch.setattr(m, "CURRENT", current)
    # No root permission is required by the isolated test. The production
    # code uses real pwd/chown with the dedicated service group's primary gid.
    monkeypatch.setattr(m.pwd, "getpwnam", lambda name: types.SimpleNamespace(
        pw_uid=1234, pw_gid=1234,
    ))
    affected = []
    monkeypatch.setattr(m.os, "chown", lambda *args, **kwargs: affected.append(args[0]))
    m.grant_staged_service_read_access(target)

    for d in (target, source, package, venv, venv / "bin"):
        assert stat.S_IMODE(d.stat().st_mode) & 0o750 == 0o750
        assert not stat.S_IMODE(d.stat().st_mode) & 0o007
    assert stat.S_IMODE(item.stat().st_mode) == 0o640
    assert not any(str(x).endswith("/bin/python") for x in affected)
    assert (venv / "bin" / "python").is_symlink()
    assert current.resolve() == current_old


def test_service_group_permissions_reject_hardlinks_and_source_symlinks(
    tmp_path, monkeypatch,
):
    import types

    m = load()
    releases = tmp_path / "releases"
    releases.mkdir()
    current_old = releases / ("a" * 40)
    current_old.mkdir()
    target = releases / ("b" * 40)
    target.mkdir()
    monkeypatch.setattr(m, "RELEASES", releases)
    current = tmp_path / "current"
    current.symlink_to(current_old)
    monkeypatch.setattr(m, "CURRENT", current)
    monkeypatch.setattr(m.pwd, "getpwnam", lambda name: types.SimpleNamespace(
        pw_uid=1234, pw_gid=1234,
    ))
    file = target / "file.py"
    file.write_text("data = 1\n", encoding="utf-8")
    (target / "hardlink.py").hardlink_to(file)
    with pytest.raises(m.NoGo, match="STAGED_SHARED_OR_UNTRUSTED_INODE"):
        m.grant_staged_service_read_access(target)
    (target / "hardlink.py").unlink()
    (target / "outside.py").symlink_to(file)
    with pytest.raises(m.NoGo, match="STAGED_SOURCE_SYMLINK_FORBIDDEN"):
        m.grant_staged_service_read_access(target)
    assert current.resolve() == current_old


def test_staged_import_checks_emit_specific_sanitized_failure_category(
    tmp_path, monkeypatch,
):
    import types

    m = load()
    target = tmp_path / ("b" * 40)
    python = target / ".finance-venv" / "bin" / "python"
    checks = []
    monkeypatch.setattr(m.pwd, "getpwnam", lambda name: types.SimpleNamespace(
        pw_uid=1234, pw_gid=1234, pw_dir="/nonexistent",
    ))
    def checked_probe(args, **kwargs):
        checks.append(kwargs.get("code"))
        if kwargs.get("code") == "STAGED_MODULE_IMPORT_LEDGER_FAILED":
            raise m.NoGo(kwargs["code"])
        return b""

    monkeypatch.setattr(m, "checked", checked_probe)
    with pytest.raises(m.NoGo, match="STAGED_MODULE_IMPORT_LEDGER_FAILED"):
        m.check_staged_import("b" * 40, target, python)
    assert "STAGED_BACKEND_NOT_TRAVERSABLE" in checks
    assert "STAGED_VENV_NOT_EXECUTABLE" in checks
    assert "STAGED_PACKAGE_NOT_READABLE_FINANCE_DB" in checks
    assert "STAGED_MODULE_IMPORT_AUTH_FAILED" in checks
    assert "STAGED_MODULE_IMPORT_OAUTH_FAILED" in checks
    assert checks[-1] == "STAGED_MODULE_IMPORT_LEDGER_FAILED"



def test_release_ready_accepts_verified_standard_venv_python_symlink(
    tmp_path, monkeypatch,
):
    """Regression: --stage PASS must not turn into --apply STAGED_PYTHON_UNAVAILABLE."""
    import shutil

    m = load()
    sha = "b" * 40
    repo = tmp_path / "repo"
    source = repo / "backend"
    source.mkdir(parents=True)
    for pkg in m.PACKAGES:
        package = source / pkg
        package.mkdir()
        (package / "__init__.py").write_text("", encoding="utf-8")
    for filename in ("requirements.txt", "requirements-finance.txt"):
        (source / filename).write_text("synthetic-only\n", encoding="utf-8")

    releases = tmp_path / "releases"
    releases.mkdir()
    stage = releases / sha
    stage.mkdir()
    shutil.copytree(source, stage / "backend")
    (stage / ".finance-venv" / "bin").mkdir(parents=True)
    interpreter = stage / ".finance-venv" / "bin" / "python"
    # CI's managed Python installation can have non-production filesystem
    # permissions. Pin a controlled, non-writable copy to exercise the same
    # executable identity check deterministically without relaxing it.
    operator_python = tmp_path / "operator-python"
    shutil.copyfile(sys.executable, operator_python)
    operator_python.chmod(0o750)
    monkeypatch.setattr(m.sys, "executable", str(operator_python))
    interpreter.symlink_to(operator_python)
    (stage / "__finance_source.json").write_text(
        json.dumps({"sha": sha, "source_hashes": m.source_files(source)}),
        encoding="utf-8",
    )

    monkeypatch.setattr(m, "RELEASES", releases)
    monkeypatch.setattr(m, "REPO", repo)
    target, resolved_python = m.release_ready(sha)
    assert target == stage
    assert resolved_python == interpreter
    assert resolved_python.is_symlink()

    # A link to a different executable is NOT an acceptable venv interpreter.
    interpreter.unlink()
    interpreter.symlink_to("/bin/sh")
    with pytest.raises(m.NoGo, match="STAGED_PYTHON_UNTRUSTED"):
        m.release_ready(sha)

    interpreter.unlink()
    interpreter.symlink_to(stage / "nonexistent")
    with pytest.raises(m.NoGo, match="STAGED_PYTHON_UNAVAILABLE"):
        m.release_ready(sha)


def test_staged_python_rejects_symlinks_outside_pinned_interpreter(
    tmp_path,
):
    """Only operator Python or a private stage-owned interpreter may be linked."""
    import shutil

    m = load()
    target = tmp_path / "releases" / ("b" * 40)
    bin_dir = target / ".finance-venv" / "bin"
    bin_dir.mkdir(parents=True)
    python = bin_dir / "python"
    # A symlink pointing outside the release to an arbitrary executable
    # must fail even when that executable is otherwise root-owned and executable.
    python.symlink_to("/usr/bin/env")
    with pytest.raises(m.NoGo, match="STAGED_PYTHON_UNTRUSTED"):
        m.verified_staged_python(target)

    python.unlink()
    # A normal copied executable inside the stage remains valid.
    shutil.copyfile(sys.executable, python)
    python.chmod(0o750)
    assert m.verified_staged_python(target) == python
