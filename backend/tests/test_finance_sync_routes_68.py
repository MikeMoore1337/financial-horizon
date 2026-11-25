"""#68 production route patch tests, using synthetic Caddy and fake I/O only."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys

import pytest

pytest.importorskip('pwd', reason='Production release helpers require Unix account APIs')

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
try:
    spec = importlib.util.spec_from_file_location('fh_finance_sync_routes_68', SCRIPTS / 'fh_finance_sync_routes_68.py')
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
finally:
    sys.path.remove(str(SCRIPTS))


def caddy_fixture():
    routes = m.finance.ROUTES
    for name in ('read', 'write'):
        old = f'    handle @fh_finance_{name} {{\n        reverse_proxy 127.0.0.1:9138\n    }}\n'
        new = (f'    handle @fh_finance_{name} {{\n        reverse_proxy 127.0.0.1:9138 {{\n'
               '            header_down Cache-Control "private, no-store, no-transform"\n'
               '        }\n    }\n')
        assert routes.count(old) == 1
        routes = routes.replace(old, new, 1)
    return ('site.example {\n' + routes + m.bank.BANK_ROUTES +
            '    @fh_oauth_live_get {\n        method GET\n    }\n}\n').encode()


def test_route_patch_preserves_existing_bytes_and_limits_new_methods():
    original = caddy_fixture()
    patched = m.patch_caddy(original)
    assert patched.replace(m.ROUTES.encode(), b'', 1) == original
    assert patched.count(m.bank.BANK_ROUTES.encode()) == 1
    assert 'method GET\n        path_regexp ^/api/finance/v1/commands/[0-9a-f-]+/changes$' in m.ROUTES
    assert 'method POST\n        path /api/finance/v1/commands/cancel /api/finance/v2/commands/cancel' in m.ROUTES
    assert m.ROUTES.count('header_down Cache-Control "private, no-store, no-transform"') == 2


@pytest.mark.parametrize('alter', [
    lambda raw: raw.replace(m.bank.BANK_ROUTES.encode(), b''),
    lambda raw: raw.replace(m.finance.CADDY_MARKER.encode(), b''),
    lambda raw: raw + b'\n@fh_sync68_read {\n}\n',
    lambda raw: raw.replace(b'/api/finance/v1/state', b'/api/finance/v1/*'),
    lambda raw: raw + b'\n/api/finance/v2/commands/cancel\n',
    lambda raw: raw + b' ' * 8192,
])
def test_patch_rejects_unknown_or_already_modified_configuration(alter):
    with pytest.raises(m.Hold):
        m.patch_caddy(alter(caddy_fixture()))


def test_backup_requires_exact_sha():
    with pytest.raises(m.Hold):
        m.backup_path('../other')


def fake_deployment(monkeypatch, tmp_path):
    sha = 'a' * 40
    original = caddy_fixture()
    state = {'caddy': original, 'backup': None, 'reloads': 0}
    monkeypatch.setenv('FH_SYNC68_ROUTES', 'ENABLE')
    monkeypatch.setattr(m, 'preflight', lambda _sha: (original, 0o644))
    monkeypatch.setattr(m, 'backup_path', lambda _sha: tmp_path / 'backup')
    monkeypatch.setattr(m.finance, 'caddy_snapshot', lambda: (state['caddy'], 0o644))
    monkeypatch.setattr(m.finance, 'write_exclusive', lambda _path, data, mode: state.update(backup=data))
    monkeypatch.setattr(m.finance, 'secure_file', lambda _path, _owner, _mode: state['backup'])
    monkeypatch.setattr(m.finance, 'atomic_replace', lambda _path, data, mode: state.update(caddy=data))
    monkeypatch.setattr(m, 'reload_caddy', lambda: state.update(reloads=state['reloads'] + 1))
    return sha, original, state


def test_enable_preserves_backup_and_checks_public_guards(monkeypatch, tmp_path):
    sha, original, state = fake_deployment(monkeypatch, tmp_path)
    checked = []
    monkeypatch.setattr(m, 'public_guards', lambda: checked.append(True))
    m.enable(sha)
    assert state['backup'] == original
    assert state['caddy'] == m.patch_caddy(original)
    assert state['reloads'] == 1
    assert checked == [True]


def test_failed_public_guard_restores_exact_original(monkeypatch, tmp_path):
    sha, original, state = fake_deployment(monkeypatch, tmp_path)
    def fail():
        raise m.Hold('SYNTHETIC_PUBLIC_FAILURE')
    monkeypatch.setattr(m, 'public_guards', fail)
    with pytest.raises(m.Hold, match='SYNTHETIC_PUBLIC_FAILURE'):
        m.enable(sha)
    assert state['caddy'] == original
    assert state['backup'] == original
    assert state['reloads'] == 2


def test_concurrent_change_is_never_overwritten_during_rollback(monkeypatch, tmp_path, capsys):
    sha, original, state = fake_deployment(monkeypatch, tmp_path)
    def concurrent_failure():
        state['caddy'] = b'other operator change'
        raise m.Hold('SYNTHETIC_PUBLIC_FAILURE')
    monkeypatch.setattr(m, 'public_guards', concurrent_failure)
    with pytest.raises(m.Hold):
        m.enable(sha)
    assert state['caddy'] == b'other operator change'
    assert state['backup'] == original
    assert 'MANUAL_REVIEW_REQUIRED' in capsys.readouterr().out


def test_enable_refuses_without_explicit_release_mode(monkeypatch, tmp_path):
    sha, original, state = fake_deployment(monkeypatch, tmp_path)
    monkeypatch.delenv('FH_SYNC68_ROUTES')
    with pytest.raises(m.Hold, match='EXPLICIT_SYNC_ENABLE_REQUIRED'):
        m.enable(sha)
    assert state['caddy'] == original
    assert state['backup'] is None


def test_enable_refuses_unreadable_rollback_copy_before_proxy_change(monkeypatch, tmp_path):
    sha, original, state = fake_deployment(monkeypatch, tmp_path)
    monkeypatch.setattr(m.finance, 'secure_file', lambda *_args: b'truncated')
    with pytest.raises(m.Hold, match='SYNC_ROLLBACK_BACKUP_MISMATCH'):
        m.enable(sha)
    assert state['caddy'] == original
    assert state['reloads'] == 0


def test_public_guards_check_auth_origin_and_existing_bank_routes(monkeypatch):
    calls = []
    def public_probe(path, *, method='GET', origin=None):
        calls.append((path, method, origin))
        return 403 if origin == 'https://untrusted.example' else 401
    monkeypatch.setattr(m.finance, 'public_probe', public_probe)
    monkeypatch.setattr(m.bank, 'public_negative_checks', lambda: calls.append(('bank',)))
    m.public_guards()
    assert (m.READ, 'GET', None) in calls
    assert ('bank',) in calls
    assert ('/api/finance/v1/state', 'GET', None) in calls
    for path in m.WRITES:
        assert (path, 'POST', m.finance.ORIGIN) in calls
        assert (path, 'POST', 'https://untrusted.example') in calls


def test_public_guard_rejects_unprotected_cross_origin_write(monkeypatch):
    monkeypatch.setattr(m.finance, 'public_probe', lambda *args, **kwargs: 401)
    with pytest.raises(m.Hold, match='SYNC_PUBLIC_WRITE_AUTH_OR_ORIGIN_FAILED'):
        m.public_guards()
