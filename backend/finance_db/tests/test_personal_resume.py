"""#66: pre-migration recovery stays data-preserving and fail-closed.

No tests use a production PostgreSQL container, key or financial record.
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = ROOT / "deploy" / "postgres" / "scripts"
CHECK = SCRIPTS / "personal_port_check.py"
RECOVER = SCRIPTS / "personal-resume.sh"


def load_checker():
    spec = importlib.util.spec_from_file_location("fh_personal_port_check", CHECK)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_exact_loopback_binding_accepts_only_configured_and_effective_localhost():
    check = load_checker()
    mounts = [{
        "Type": "bind", "Source": check.DATA_DIR,
        "Destination": "/var/lib/postgresql/data", "RW": True,
    }]
    check.verify(check.EXPECTED, None, mounts, check.IMAGE, check.NETWORK,
                 False, configured_only=True)
    check.verify(check.EXPECTED, check.EXPECTED, mounts, check.IMAGE,
                 check.NETWORK, True, configured_only=False)


def test_loopback_binding_rejects_extra_ports_wildcards_ipv6_and_mismatched_mounts():
    check = load_checker()
    mounts = [{
        "Type": "bind", "Source": check.DATA_DIR,
        "Destination": "/var/lib/postgresql/data", "RW": True,
    }]
    safe = dict(configured=check.EXPECTED, effective=check.EXPECTED,
                mounts=mounts, image=check.IMAGE, network=check.NETWORK,
                running=True, configured_only=False)
    cases = [
        {"configured": {"5432/tcp": [{"HostIp": "0.0.0.0", "HostPort": "54329"}]}},
        {"configured": {"5432/tcp": [{"HostIp": "::1", "HostPort": "54329"}]}},
        {"configured": {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": "54329"}],
                         "6543/tcp": [{"HostIp": "127.0.0.1", "HostPort": "6543"}]}},
        {"configured": {}},
        {"effective": {"5432/tcp": [{"HostIp": "0.0.0.0", "HostPort": "54329"}]}},
        {"effective": None},
        {"running": False},
        {"network": "host"},
        {"network": "another-project_default"},
        {"image": "postgres:latest"},
        {"mounts": []},
        {"mounts": [dict(mounts[0], Source="/srv/other/pgdata")]},
        {"mounts": [dict(mounts[0], RW=False)]},
        {"mounts": mounts + [{"Type": "bind", "Source": "/srv/other",
                              "Destination": "/var/lib/postgresql/data/pgdata", "RW": True}]},
    ]
    for patch in cases:
        with pytest.raises(check.UnsafeBinding):
            check.verify(**{**safe, **patch})


def test_personal_recovery_scripts_parse_and_refuse_ci_without_finance_writes():
    for script in (RECOVER, SCRIPTS / "personal-bootstrap.sh",
                   SCRIPTS / "personal-start.sh"):
        parsed = subprocess.run(["bash", "-n", str(script)], text=True,
                                capture_output=True, timeout=5, check=False)
        assert parsed.returncode == 0, parsed.stderr
    compiled = subprocess.run(["python3", "-m", "py_compile", str(CHECK)],
                              capture_output=True, text=True, timeout=5, check=False)
    assert compiled.returncode == 0, compiled.stderr
    env = dict(os.environ)
    env["GITHUB_ACTIONS"] = "true"
    env.pop("FH_FINANCE_RESUME_PRE_MIGRATION", None)
    denied = subprocess.run(["bash", str(RECOVER)], env=env,
                            text=True, capture_output=True, timeout=5, check=False)
    assert denied.returncode != 0
    assert denied.stdout == ""
    assert "FINANCE_PERSONAL_RESUME_NO_GO:" in denied.stderr


def test_recovery_never_reinitializes_volume_or_bypasses_migrations():
    resume = RECOVER.read_text(encoding="utf-8")
    bootstrap = (SCRIPTS / "personal-bootstrap.sh").read_text(encoding="utf-8")
    restart = (SCRIPTS / "personal-start.sh").read_text(encoding="utf-8")
    for required in (
        "EXPLICIT_PRE_MIGRATION_RESUME_REQUIRED",
        "NEW_SHA_MUST_FAST_FORWARD_FROM_ORIGINAL",
        "FINANCE_PERSONAL_RESUME_EXACT_SHA_CI=PASS",
        "STOPPED_CONTAINER_REQUIRED",
        "EXISTING_PG17_CLUSTER_REQUIRED",
        "UNSAFE_EXISTING_CONTAINER_CONFIG",
        "EXISTING_SCHEMA_REQUIRES_MANUAL_REVIEW",
        "--no-deps",
        "SCHEMA_MIGRATION_FAILED",
        "REAL_ISOLATED_RESTORE_FAILED",
        "FINANCE_PERSONAL_BACKUP_RESTORE=PASS",
        "FINANCE_PERSONAL_START_ENV_UPDATED=PASS",
    ):
        assert required in resume
    assert "docker start fh-finance-postgres" in resume
    for forbidden in ("initdb ", "docker compose down", "docker rm ", "mkfs", "rm -rf",
                      "alembic stamp", "TRUNCATE ", "DROP SCHEMA"):
        # Comments may mention an unsafe command by name; check executable lines.
        active_lines = [
            line for line in resume.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
        assert all(forbidden not in line for line in active_lines), forbidden
    assert "personal_port_check.py" in bootstrap
    assert "personal_port_check.py" in restart
    assert "--configured-only" in restart
    assert "docker port fh-finance-postgres" not in bootstrap
    assert "docker port fh-finance-postgres" not in restart
