"""#66 - personal release scripts stay fail closed without an authorized VPS.

These are *static* and CLI negative checks, not a real production DB restore.
"""
from __future__ import annotations

import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = ROOT / "deploy" / "postgres" / "scripts"
SYSTEMD = ROOT / "deploy" / "postgres" / "systemd"
PERSONAL = (
    "personal-storage-preflight.sh",
    "personal-bootstrap.sh",
    "personal-start.sh",
    "personal-prepare.sh",
)


def test_personal_shell_scripts_parse_and_refuse_unapproved_environment():
    for name in PERSONAL:
        script = SCRIPTS / name
        parsed = subprocess.run(
            ["bash", "-n", str(script)],
            capture_output=True, text=True, timeout=5, check=False,
        )
        assert parsed.returncode == 0, parsed.stderr
        env = dict(os.environ)
        env.pop("FH_FINANCE_PERSONAL_MODE", None)
        env.pop("FH_FINANCE_APPROVED_SHA", None)
        env.pop("FH_FINANCE_DATA_DIR", None)
        env["GITHUB_ACTIONS"] = "true"
        denied = subprocess.run(
            ["bash", str(script)], env=env,
            capture_output=True, text=True, timeout=5, check=False,
        )
        assert denied.returncode != 0
        assert denied.stdout == ""
        assert "NO_GO:" in denied.stderr


def test_personal_deploy_requires_real_postgres_backup_and_restore():
    text = (SCRIPTS / "personal-bootstrap.sh").read_text(encoding="utf-8")
    assert "FINANCE_PERSONAL_MODE" in text
    assert "EXACT_SHA_REQUIRED" in text
    assert "FINANCE_PERSONAL_EXACT_SHA_CI=PASS" in text
    assert '"finance-postgres"' in text
    assert 'personal-storage-preflight.sh' in text
    assert 'backup.sh' in text and 'restore-drill.sh' in text
    assert "FINANCE_PERSONAL_BACKUP_RESTORE=PASS" in text
    assert "FINANCE_FINANCIAL_API=NOT_ENABLED" in text
    assert "personal_port_check.py" in text
    assert "ROOT_ONLY_BACKUP_CONFIG_REQUIRED" in text
    assert "SOURCE_ONLY" not in text


def test_personal_services_are_distinct_from_hardened_offsite_units():
    service = (SYSTEMD / "fh-finance-personal.service").read_text(encoding="utf-8")
    backup = (SYSTEMD / "fh-finance-personal-backup.service").read_text(encoding="utf-8")
    timer = (SYSTEMD / "fh-finance-personal-backup.timer").read_text(encoding="utf-8")
    assert "personal-start.sh" in service
    assert "backup.sh" in backup and "backup-and-offsite.sh" not in backup
    assert "fh-finance-personal-backup.service" in timer
    assert "OnCalendar=" in timer
    assert "EnvironmentFile=/etc/financial-horizon/finance/start.env" in service
    assert "EnvironmentFile=/etc/financial-horizon/finance/backup.env" in backup


def test_private_finance_postgres_is_reachable_only_on_host_loopback():
    override = ROOT / "deploy/postgres/personal-loopback.override.yml"
    content = override.read_text(encoding="utf-8")
    assert '127.0.0.1:54329:5432' in content
    assert '0.0.0.0:' not in content and '[::]:' not in content
    bootstrap = (SCRIPTS / "personal-bootstrap.sh").read_text(encoding="utf-8")
    restart = (SCRIPTS / "personal-start.sh").read_text(encoding="utf-8")
    assert "personal-loopback.override.yml" in bootstrap
    assert "personal-host-bridge.py" in bootstrap
    assert "personal-host-bridge.py" in restart
    assert "docker start fh-finance-postgres" in restart
    assert "docker compose" not in restart
    for text in (bootstrap, restart):
        assert "personal_port_check.py" in text
        assert "ONLY_LOOPBACK_DATABASE_PORT_ALLOWED" in text


def test_personal_prepare_is_opt_in_idempotent_and_never_bootstraps_services():
    source = (SCRIPTS / "personal-prepare.sh").read_text(encoding="utf-8")
    for required in (
        "FINANCE_PERSONAL_PREPARE=PASS",
        "FINANCE_PERSONAL_MODE", "FH_FINANCE_APPROVED_SHA",
        "EXISTING_FINANCE_DATABASE_DO_NOT_REINITIALIZE",
        "PARTIAL_SECRETS_REQUIRE_MANUAL_REVIEW",
        "O_EXCL", "O_NOFOLLOW", "secrets.token_hex(32)",
        "GPG_RECOVERY_MISMATCH", "backup.env", "start.env",
        "FINANCE_DATABASE_NOT_STARTED=YES",
        "FINANCE_AUTH_AND_PWA_UNCHANGED=YES",
        "personal-storage-preflight.sh",
    ):
        assert required in source or required.replace("GPG_", "") in source, required
    assert "docker compose up" not in source
    assert "systemctl start" not in source
    assert "rm -rf" not in source
    assert "mkfs" not in source
    assert "curl | sh" not in source
    assert "FH_FINANCE_GPG_RECIPIENT=" in source
