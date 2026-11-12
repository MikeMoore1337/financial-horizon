"""#66 - local WAL readiness guard, no real production resources required."""
from __future__ import annotations

from pathlib import Path
import os
import subprocess

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "deploy/postgres/scripts/pitr-preflight.sh"


def test_pitr_preflight_shell_syntax():
    checked = subprocess.run(
        ["bash", "-n", str(SCRIPT)],
        capture_output=True, text=True, timeout=5,
        check=False,
    )
    assert checked.returncode == 0, checked.stderr


def test_pitr_preflight_fails_closed_without_authorized_luks_mount():
    env = dict(os.environ)
    env.pop("FH_FINANCE_DATA_DIR", None)
    env.pop("FH_FINANCE_MAPPER_NAME", None)
    # The probe must reject before any PostgreSQL/Docker operations or writes.
    result = subprocess.run(
        ["bash", str(SCRIPT)], env=env,
        capture_output=True, text=True, timeout=5,
        check=False,
    )
    assert result.returncode != 0
    assert result.stdout == ""
    assert "FINANCE_PITR_LOCAL_NO_GO" in result.stderr


def test_pitr_local_pass_never_claims_encrypted_offsite_or_real_restore():
    text = SCRIPT.read_text(encoding="utf-8")
    assert 'FINANCE_PITR_LOCAL_ARCHIVER_PREFLIGHT=PASS' in text
    assert 'FINANCE_PITR_ENCRYPTED_OFFSITE=NOT_VERIFIED' in text
    assert 'FINANCE_PITR_REAL_RESTORE=NOT_VERIFIED' in text
    assert 'FINANCE_PITR_RPO_RTO=NOT_VERIFIED' in text
    assert 'pg_stat_archiver' in text
    assert 'storage-preflight.sh' in text
    assert "pg_switch_wal" not in text
