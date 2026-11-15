"""#69: synthetic tests for private systemd loader upgrade; no real VPS IO."""
from __future__ import annotations

from hashlib import sha256
import importlib.util
from pathlib import Path
import os
import subprocess
import sys
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
OPERATOR = SCRIPTS / "fh_finance_personal_launcher_upgrade.py"
LAUNCHER = SCRIPTS / "fh_finance_api_launcher.py"


def load(path):
    sys.path.insert(0, str(SCRIPTS))
    try:
        spec = importlib.util.spec_from_file_location(path.stem, path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(SCRIPTS))


def old_launcher():
    """Reconstruct exact deployed legacy program from the minimal new diff."""
    target = LAUNCHER.read_text(encoding="utf-8")
    new = (
        "    # #69: the owner may open a bounded import window on the existing\n"
        "    # personal/v2 finance backend. Keep OFF as the required default and\n"
        "    # reject every unknown or inconsistent runtime combination. Import ON\n"
        "    # alone never creates finance access: the service still requires its\n"
        "    # private systemd credential, existing FH session, Origin and RLS.\n"
        '    if os.environ.get("FH_FINANCE_RUNTIME_MODE") != "personal" or (\n'
        '        os.environ.get("FH_FINANCE_V2_RUNTIME") != "on" or\n'
        '        os.environ.get("FH_FINANCE_IMPORT_RUNTIME") not in ("off", "on")\n'
        '    ):\n'
        '        raise SystemExit("FINANCE_LAUNCHER_NO_GO: FINANCE_FLAGS_NOT_EXPLICIT")'
    )
    original = (
        '    if os.environ.get("FH_FINANCE_RUNTIME_MODE") != "personal" or (\n'
        '        os.environ.get("FH_FINANCE_V2_RUNTIME") != "on" or\n'
        '        os.environ.get("FH_FINANCE_IMPORT_RUNTIME") != "off"\n'
        '    ):\n'
        '        raise SystemExit("FINANCE_LAUNCHER_NO_GO: FINANCE_FLAGS_NOT_EXPLICIT")'
    )
    assert target.count(new) == 1
    return target.replace(new, original).encode("utf-8")


def test_legacy_deployed_launcher_digest_is_pinned_and_source_reviewed():
    upgrade = load(OPERATOR)
    original = old_launcher()
    assert sha256(original).hexdigest() == upgrade.LEGACY_SHA256
    new = LAUNCHER.read_bytes()
    assert new != original
    assert b'FH_FINANCE_IMPORT_RUNTIME") not in ("off", "on")' in new
    assert b'FH_FINANCE_IMPORT_RUNTIME") != "off"' not in new
    assert b"CREDENTIALS_DIRECTORY" in new
    assert b"LoadCredential" not in new  # launcher only reads systemd-provided file


@pytest.mark.parametrize("runtime,v2,import_mode,accepted", [
    ("personal", "on", "off", True),
    ("personal", "on", "on", True),
    ("personal", "on", "bogus", False),
    ("personal", "off", "on", False),
    ("off", "on", "on", False),
    ("off", "off", "off", False),
    ("", "on", "on", False),
    ("personal", "on", "", False),
])
def test_credential_launcher_rejects_all_other_runtime_modes(
    tmp_path, monkeypatch, runtime, v2, import_mode, accepted,
):
    launcher = load(LAUNCHER)
    (tmp_path / launcher.CREDENTIAL_NAME).write_text("a" * 64, encoding="ascii")
    monkeypatch.setattr(launcher, "CREDENTIAL_DIR", tmp_path)
    monkeypatch.setattr(launcher.sys, "argv", [
        "launcher", "--", launcher.USER, "--host", "127.0.0.1", "--port", "9138",
    ])
    monkeypatch.setenv("CREDENTIALS_DIRECTORY", str(tmp_path))
    monkeypatch.setenv("FH_FINANCE_RUNTIME_MODE", runtime)
    monkeypatch.setenv("FH_FINANCE_V2_RUNTIME", v2)
    monkeypatch.setenv("FH_FINANCE_IMPORT_RUNTIME", import_mode)
    monkeypatch.delenv("FH_FINANCE_DATABASE_URL", raising=False)

    class WouldExec(Exception):
        pass

    calls = []
    def mock_exec(executable, argv):
        calls.append((executable, argv))
        raise WouldExec()

    monkeypatch.setattr(launcher.os, "execv", mock_exec)
    if accepted:
        with pytest.raises(WouldExec):
            launcher.main()
        assert calls
        assert calls[0][1][-4:] == ["--host", "127.0.0.1", "--port", "9138"]
        dsn = os.environ.get("FH_FINANCE_DATABASE_URL", "")
        assert dsn.startswith("postgresql+psycopg://fh_finance_runtime:")
        assert "a" * 64 in dsn
    else:
        with pytest.raises(SystemExit, match="FINANCE_FLAGS_NOT_EXPLICIT"):
            launcher.main()
        assert calls == []
        assert "FH_FINANCE_DATABASE_URL" not in os.environ


def test_missing_explicit_import_flag_denied_even_with_credential(tmp_path, monkeypatch):
    launcher = load(LAUNCHER)
    (tmp_path / launcher.CREDENTIAL_NAME).write_text("a" * 64, encoding="ascii")
    monkeypatch.setattr(launcher, "CREDENTIAL_DIR", tmp_path)
    monkeypatch.setattr(launcher.sys, "argv", ["launcher", "--", launcher.USER])
    monkeypatch.setenv("CREDENTIALS_DIRECTORY", str(tmp_path))
    monkeypatch.setenv("FH_FINANCE_RUNTIME_MODE", "personal")
    monkeypatch.setenv("FH_FINANCE_V2_RUNTIME", "on")
    monkeypatch.delenv("FH_FINANCE_IMPORT_RUNTIME", raising=False)
    with pytest.raises(SystemExit, match="FINANCE_FLAGS_NOT_EXPLICIT"):
        launcher.main()


def test_launcher_preflight_rejects_unauthorized_source_and_receipt(tmp_path, monkeypatch):
    upgrade = load(OPERATOR)
    new = LAUNCHER.read_bytes()
    legacy = old_launcher()
    assert len(new) > 800 and len(legacy) > 800
    monkeypatch.setattr(upgrade, "TARGET", tmp_path / "launcher.py")
    monkeypatch.setattr(upgrade, "SOURCE", LAUNCHER)
    monkeypatch.setattr(upgrade.pwd, "getpwnam", lambda _name: SimpleNamespace(pw_gid=1234))
    monkeypatch.setattr(upgrade.finance, "secure_file",
                        lambda path, *_a: path.read_bytes())
    actual_stat = Path.stat
    monkeypatch.setattr(
        Path, "stat",
        lambda self, **kw: SimpleNamespace(st_gid=1234)
        if self == upgrade.TARGET else actual_stat(self, **kw),
    )
    # Root ownership check is done on real directory: CI temp directory
    # is arbitrary, and therefore deliberately not trusted by inspect_existing.
    with pytest.raises(upgrade.Hold, match="LAUNCHER_PARENT_UNTRUSTED"):
        upgrade.inspect_existing()
    # This validates the protected operator's refusal to use /tmp as a
    # trusted installation directory, not just its happy-path mock.
    assert sha256(legacy).hexdigest() == upgrade.LEGACY_SHA256


def test_install_is_source_only_and_reuses_matching_original_backup(
    tmp_path, monkeypatch, capsys,
):
    upgrade = load(OPERATOR)
    orig = old_launcher()
    target = LAUNCHER.read_bytes()
    backup = tmp_path / "legacy.bak"
    backup.write_bytes(orig)
    files = {upgrade.TARGET: orig}
    events = []
    monkeypatch.setattr(
        upgrade, "preflight",
        lambda _sha: (orig, target, 1234, "legacy", backup),
    )
    monkeypatch.setenv("FH_PERSONAL_LAUNCHER_UPGRADE", "YES")
    monkeypatch.setattr(
        upgrade.finance, "secure_file", lambda path, *_a: (
            files[path] if path in files else path.read_bytes()
        ),
    )
    monkeypatch.setattr(upgrade.finance, "write_exclusive",
                        lambda *args, **kwargs: pytest.fail("Do not rewrite backup"))
    def install(data, gid):
        assert gid == 1234
        files[upgrade.TARGET] = data
        events.append("install")
    monkeypatch.setattr(upgrade, "atomic_install", install)
    monkeypatch.setattr(upgrade.imp, "launcher_ready",
                        lambda: events.append("verify-launcher"))
    monkeypatch.setattr(upgrade.finance, "enabled_local_smoke",
                        lambda: events.append("auth-smoke"))
    monkeypatch.setattr(
        upgrade.finance, "public_probe",
        lambda path: 200 if path == "/api/auth/providers" else 401,
    )
    upgrade.install("1" * 40)
    assert files[upgrade.TARGET] == target
    assert events == ["install", "verify-launcher", "auth-smoke"]
    output = capsys.readouterr().out
    assert "FH_LAUNCHER_UPGRADE=PASS" in output
    assert "FH_AUTH_SERVICE_NOT_RESTARTED=YES" in output


def test_install_restores_exact_old_launcher_when_postinstall_probe_fails(
    tmp_path, monkeypatch, capsys,
):
    upgrade = load(OPERATOR)
    original = old_launcher()
    target = LAUNCHER.read_bytes()
    backup = tmp_path / "legacy.bak"
    active = {upgrade.TARGET: original}
    monkeypatch.setattr(
        upgrade, "preflight",
        lambda _sha: (original, target, 1234, "legacy", backup),
    )
    monkeypatch.setenv("FH_PERSONAL_LAUNCHER_UPGRADE", "YES")
    monkeypatch.setattr(upgrade.finance, "write_exclusive",
                        lambda path, data, **kw: path.write_bytes(data))
    monkeypatch.setattr(upgrade.finance, "secure_file",
                        lambda path, *_a: active[path])
    monkeypatch.setattr(upgrade, "atomic_install",
                        lambda data, gid: active.__setitem__(upgrade.TARGET, data))
    monkeypatch.setattr(upgrade.imp, "launcher_ready", lambda: None)
    monkeypatch.setattr(upgrade.finance, "enabled_local_smoke", lambda: None)
    monkeypatch.setattr(upgrade.finance, "public_probe", lambda _path: 503)
    with pytest.raises(upgrade.Hold, match="LAUNCHER_POSTINSTALL_ANONYMOUS_SECURITY_FAILED"):
        upgrade.install("1" * 40)
    assert active[upgrade.TARGET] == original
    assert "FH_LAUNCHER_UPGRADE_ROLLBACK=PASS" in capsys.readouterr().out


def test_cli_never_installs_launcher_without_native_operator_approval():
    result = subprocess.run(
        [sys.executable, str(OPERATOR), "--sha", "1" * 40, "--install"],
        env={**os.environ, "GITHUB_ACTIONS": "true"},
        capture_output=True, text=True, timeout=10, check=False,
    )
    assert result.returncode != 0
    assert "FH_LAUNCHER_UPGRADE=NO_GO" in result.stdout
    assert "PRODUCTION_ROOT_REQUIRED" in result.stdout
    assert result.stderr == ""
