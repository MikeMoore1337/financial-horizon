"""#66: personal PostgreSQL ops pin advances only across source-only changes.

Synthetic files and local Git only; never touch the real VPS or credentials.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "fh_finance_ops_repin.py"


def load():
    spec = importlib.util.spec_from_file_location("fh_finance_ops_repin", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_start_env_exact_contract_rejects_extra_values_and_duplicates():
    m = load()
    sha = "a" * 40
    value = (
        "FH_FINANCE_PERSONAL_MODE=YES\n"
        f"FH_FINANCE_APPROVED_SHA={sha}\n"
        "FH_FINANCE_DATA_DIR=/srv/financial-horizon-finance/pgdata\n"
        "FH_FINANCE_CHECKOUT_DIR=/opt/financial-horizon-ops\n"
    )
    assert m.parse_start(value)["FH_FINANCE_APPROVED_SHA"] == sha
    for attempt in (
        value + "FH_FINANCE_APPROVED_SHA=" + sha + "\n",
        value + "SECRET=unexpected\n",
        value.replace("MODE=YES", "MODE=NO"),
        value.replace("FINANCE_APPROVED_SHA", "FINANCE_APPROVED_SHA\nEVIL"),
        value.replace("FH_FINANCE_APPROVED_SHA=" + sha, "FH_FINANCE_APPROVED_SHA=main"),
        value.replace("CHECKOUT_DIR=/opt/", "CHECKOUT_DIR=/tmp/"),
    ):
        with pytest.raises(m.NoGo):
            m.parse_start(attempt)


def test_atomic_repin_changes_only_original_sha_preserves_root_private_0600(
    tmp_path, monkeypatch,
):
    m = load()
    original = "a" * 40
    new = "b" * 40
    source = (
        "FH_FINANCE_PERSONAL_MODE=YES\n"
        f"FH_FINANCE_APPROVED_SHA={original}\n"
        "FH_FINANCE_DATA_DIR=/srv/financial-horizon-finance/pgdata\n"
        "FH_FINANCE_CHECKOUT_DIR=/opt/financial-horizon-ops\n"
    )
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    backup_dir = tmp_path / "backups"
    backup_dir.mkdir()
    start = config_dir / "start.env"
    start.write_text(source, encoding="ascii")
    start.chmod(0o600)
    monkeypatch.setattr(m, "START", start)
    monkeypatch.setattr(m, "BACKUP_ROOT", backup_dir)
    monkeypatch.setattr(m.os, "geteuid", lambda: 0)
    monkeypatch.setattr(m, "private_text", lambda p: p.read_text(encoding="ascii"))

    m.atomically_repin(new, source, original)
    assert m.parse_start(start.read_text())["FH_FINANCE_APPROVED_SHA"] == new
    assert source.replace(original, new, 1) == start.read_text()
    assert stat.S_IMODE(start.stat().st_mode) == 0o600
    backup = backup_dir / ("fh-finance-ops-start-" + original + ".env.bak")
    assert backup.read_text() == source
    assert stat.S_IMODE(backup.stat().st_mode) == 0o600
    m.atomically_repin(new, start.read_text(), new)
    with pytest.raises(m.NoGo, match="OPS_START_BACKUP_ALREADY_EXISTS_OR_UNAVAILABLE"):
        m.atomically_repin(new, source, original)


def test_dangerous_systemd_changes_prohibited_across_git_history(tmp_path, monkeypatch):
    m = load()
    repo = tmp_path / "testrepo"
    repo.mkdir()
    def git(*args):
        r = subprocess.run(["git", "-C", str(repo), *args],
                           capture_output=True, text=True, check=True, timeout=15)
        return r.stdout.strip()
    git("init")
    git("config", "user.email", "ci@example.invalid")
    git("config", "user.name", "Synthetic Fixture")
    (repo / "deploy/postgres").mkdir(parents=True)
    (repo / "deploy/postgres/compose.yml").write_text("internal: true\n")
    (repo / "README.md").write_text("One\n")
    git("add", ".")
    git("commit", "-m", "initial")
    old = git("rev-parse", "HEAD")
    (repo / "README.md").write_text("Two\n")
    git("add", ".")
    git("commit", "-m", "auth only")
    safe = git("rev-parse", "HEAD")
    monkeypatch.setattr(m, "CHECKOUT", str(repo))
    m.verify_source_unchanged(old, safe)
    (repo / "deploy/postgres/compose.yml").write_text("internal: false\n")
    git("add", ".")
    git("commit", "-m", "changed database")
    unsafe = git("rev-parse", "HEAD")
    with pytest.raises(m.NoGo, match="POSTGRES_RUNTIME_CHANGED_REQUIRES_SEPARATE_REVIEW"):
        m.verify_source_unchanged(old, unsafe)


def test_ops_pin_never_runs_on_github_runner():
    for op in ("--preflight", "--apply"):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), op, "--sha", "a" * 40],
            env={**os.environ, "GITHUB_ACTIONS": "true"},
            capture_output=True, text=True, timeout=5, check=False,
        )
        assert result.returncode != 0
        assert "EXPLICIT_PRODUCTION_ROOT_AND_SHA_REQUIRED" in result.stdout
        assert result.stderr == ""


def test_script_does_not_modify_database_credentials_services_or_oauth():
    content = SCRIPT.read_text(encoding="utf-8")
    assert "POSTGRES_RUNTIME_CHANGED_REQUIRES_SEPARATE_REVIEW" in content
    assert "CURRENT_MAIN_CI_NOT_COMPLETE" in content
    assert "FINANCE_OPS_PREVIOUS_CONFIG_BACKUP=PASS" in content
    assert "FH_FINANCE_PERSONAL_OPS_REPIN" in content
    for forbidden in (
        "docker stop", "docker compose down", "systemctl restart",
        "systemctl daemon-reload", "psql -U", "DROP TABLE", "CREATE ROLE",
        "/etc/financial-horizon/oauth.env", "FH_FINANCE_RUNTIME_MODE=personal"
    ):
        assert forbidden not in content
