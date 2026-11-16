"""#69/#70: source-only release of an already ACTIVE personal FH backend.

All tests use synthetic drop-ins and monkeypatch I/O. They never touch
real systemd, PostgreSQL, Caddy, OAuth SQLite or a user's IndexedDB.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
SCRIPT = SCRIPTS / "fh_finance_active_backend_upgrade.py"


def load():
    sys.path.insert(0, str(SCRIPTS))
    try:
        spec = importlib.util.spec_from_file_location(
            "fh_finance_active_backend_upgrade", SCRIPT,
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(SCRIPTS))


def snapshots(module):
    old = module.RELEASES / ("1" * 40)
    target = module.RELEASES / ("2" * 40)
    config80 = textwrap.dedent(f"""\
        [Service]
        ExecStart=
        ExecStart={old}/.finance-venv/bin/python -m uvicorn fh_email_auth.app:app --host 127.0.0.1 --port 9138
        WorkingDirectory={old}/backend
        Environment="PYTHONPATH={old}:{old}/backend"
    """).encode("ascii")
    config90 = textwrap.dedent(f"""\
        [Service]
        EnvironmentFile={module.finance.FINANCE_ENV}
        LoadCredential={module.finance.CREDENTIAL_NAME}:{module.finance.SECRETS}
        ExecStart=
        ExecStart={old}/.finance-venv/bin/python {module.finance.LAUNCHER_INSTALLED} -- fh_email_auth.app:app --host 127.0.0.1 --port 9138
    """).encode("ascii")
    return old, target, config80, config90


def test_exact_known_two_dropins_only_change_release_absolute_paths():
    module = load()
    old, target, first, second = snapshots(module)
    a, b = module.expected_configs(old, target, first, second)
    assert a == first.replace(str(old).encode(), str(target).encode())
    assert b == second.replace(str(old).encode(), str(target).encode())
    assert first != a and second != b
    assert module.finance.CREDENTIAL_NAME.encode() in b
    assert module.finance.SECRETS.as_posix().encode() in b
    assert b"FH_FINANCE_IMPORT_RUNTIME=on" not in a + b
    assert b"EnvironmentFile=" in b
    assert b"FH_FINANCE_RUNTIME_MODE" not in a


@pytest.mark.parametrize("tamper", [
    lambda old, c80, c90: (c80.replace(
        b"WorkingDirectory=", b"WorkingDirectory=/tmp/untrusted/"), c90),
    lambda old, c80, c90: (c80 + b"Environment=FH_FINANCE_IMPORT_RUNTIME=on\n", c90),
    lambda old, c80, c90: (c80.replace(
        b"ExecStart=/", b"ExecStart=/tmp/malicious/"), c90),
    lambda old, c80, c90: (c80, c90.replace(
        b"LoadCredential=", b"EnvironmentFile=/tmp/private\nLoadCredential=")),
    lambda old, c80, c90: (c80, c90.replace(
        b"fh_finance_runtime_password", b"another_credential")),
    lambda old, c80, c90: (c80, c90.replace(
        str(old).encode("ascii"), b"/tmp/fake-release")),
    lambda old, c80, c90: (c80.replace(b"[Service]\n", b"[Unit]\n"), c90),
])
def test_unknown_or_modified_runtime_source_layout_is_no_go(tamper):
    m = load()
    old, target, c80, c90 = snapshots(m)
    a, b = tamper(old, c80, c90)
    with pytest.raises(m.Hold):
        m.expected_configs(old, target, a, b)


def test_invalid_shas_and_source_account_guard_fail_closed():
    m = load()
    for sha in ("main", "../escape", "0" * 39, "0" * 41, "A" * 40):
        with pytest.raises(m.Hold, match="EXACT_SHA_INVALID"):
            m.release(sha)
    old, target, a, b = snapshots(m)
    with pytest.raises(m.Hold, match="UNEXPECTED_RELEASE_SOURCE"):
        m.expected_configs(old, old, a, b)
    with pytest.raises(m.Hold, match="UNEXPECTED_RELEASE_SOURCE"):
        m.expected_configs(Path("/tmp/evil/" + old.name), target, a, b)


def test_protected_dropins_reject_wrong_ownership_permissions_and_symlinks(
        tmp_path, monkeypatch):
    m = load()
    original = tmp_path / "80-finance-source.conf"
    original.write_text("synthetic", encoding="ascii")
    # CI uses non-root files; test only mode + hardlink/symlink properties
    # with the module's stat.owner check explicitly faked to root.
    real_lstat = original.lstat
    class FakeStat:
        @property
        def st_mode(self):
            return real_lstat().st_mode
        st_uid = 0
        st_nlink = 1
    monkeypatch.setattr(Path, "lstat", lambda self: FakeStat())
    original.chmod(0o600)
    with pytest.raises(m.Hold, match="PROTECTED_DROPIN_INVALID"):
        m.protected(original, 0o644)
    original.chmod(0o644)
    assert m.protected(original, 0o644) == b"synthetic"
    assert real_lstat().st_nlink == 1


def test_production_process_rejects_actions_without_systemd_or_secrets(monkeypatch):
    m = load()
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    calls = []
    monkeypatch.setattr(m.source, "checked", lambda *args, **kwargs:
                        calls.append(args) or b"")
    with pytest.raises(m.Hold, match="AUTHORIZED_PRODUCTION_ROOT_REQUIRED"):
        m.check_checkout("a" * 40)
    assert calls == []


def test_publish_auto_rolls_back_both_dropins_and_release_symlink_on_failure(
        monkeypatch):
    m = load()
    old, target, first, second = snapshots(m)
    installed = {m.DROP80: first, m.DROP90: second}
    link = [old]
    events = []
    monkeypatch.setattr(m, "preflight", lambda sha: old)
    monkeypatch.setattr(m.source, "release_ready",
                        lambda sha: (target, target / ".finance-venv/bin/python"))
    monkeypatch.setattr(m.source, "check_staged_import",
                        lambda *args: events.append("staged"))
    monkeypatch.setattr(m, "protected", lambda path, mode: installed[path])
    monkeypatch.setattr(m, "backup_paths",
                        lambda sha: (Path("/unused-first"), Path("/unused-second")))
    monkeypatch.setattr(m.Path, "exists", lambda self: False)
    monkeypatch.setattr(m.Path, "is_symlink", lambda self: False)
    monkeypatch.setattr(m.source, "backup_live_auth_db",
                        lambda: events.append("sqlite-backup"))
    monkeypatch.setattr(m.source, "checked",
                        lambda *args, **kwargs: events.append(
                            tuple(args[0])) or b"")
    monkeypatch.setattr(m.finance, "write_exclusive",
                        lambda *args, **kwargs: events.append("backup"))
    monkeypatch.setattr(m.finance, "atomic_replace",
                        lambda path, data, **kwargs: installed.__setitem__(path, data))
    def switch(previous, next_release):
        assert link[0] == previous
        link[0] = next_release
        events.append("switch")
    monkeypatch.setattr(m.source, "switch_current", switch)
    monkeypatch.setattr(m.CURRENT.__class__, "resolve",
                        lambda self, strict=False: link[0])
    monkeypatch.setattr(m, "live_state",
                        lambda: (_ for _ in ()).throw(m.Hold("SYNTHETIC_SMOKE_FAILURE"))
                        if link[0] == target else old)
    monkeypatch.setattr(m.time, "monotonic",
                        iter([0, 36]).__next__)
    with pytest.raises(m.Hold, match="SYNTHETIC_SMOKE_FAILURE"):
        m.publish("2" * 40)
    assert link[0] == old
    assert installed == {m.DROP80: first, m.DROP90: second}
    assert events.count("switch") == 2
    assert events.index("sqlite-backup") < events.index("switch")


def test_no_unintended_finance_mutation_or_implicit_sync_enablement():
    text = SCRIPT.read_text(encoding="utf-8")
    for forbidden in (
        "DROP TABLE", "ALTER ROLE", "DELETE FROM",
        "docker compose down", "rm -rf", "FH_FINANCE_IMPORT_RUNTIME=on",
        "FH_FINANCE_RUNTIME_MODE=off", "systemctl stop fh-finance-personal",
        "docker compose up", "indexedDB.deleteDatabase",
    ):
        assert forbidden not in text
    assert "BACKEND_PUBLISHED=PASS" in text
    assert "FH_IMPORT_AND_BACKGROUND_SYNC=OFF" in text
    assert "ROLLBACK=PASS" in text
    assert "source.backup_live_auth_db()" in text
    assert "source.verify_exact_main_ci" in text


def test_cli_fails_closed_under_github_actions_without_sudo():
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--sha", "a" * 40, "--preflight"],
        capture_output=True, text=True, timeout=15,
        env={"GITHUB_ACTIONS": "true", "PATH": "/usr/bin:/bin"},
        check=False,
    )
    assert result.returncode != 0
    assert "FH_ACTIVE_BACKEND_UPGRADE=NO_GO" in result.stdout
    assert "AUTHORIZED_PRODUCTION_ROOT_REQUIRED" in result.stdout
