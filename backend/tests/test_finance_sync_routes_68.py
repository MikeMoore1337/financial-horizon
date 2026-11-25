"""#68 production route patch tests, using synthetic Caddy and fake I/O only."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import sqlite3
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
    monkeypatch.setattr(m, 'OWNER_SECRET', tmp_path / 'owner-secret')
    monkeypatch.setattr(m, 'OWNER_DROPIN', tmp_path / 'owner-dropin')
    monkeypatch.setattr(m, 'live_environment', lambda: {})
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


def test_routes_cannot_be_opened_after_owner_was_enabled(monkeypatch, tmp_path):
    sha, original, state = fake_deployment(monkeypatch, tmp_path)
    monkeypatch.setattr(m, 'live_environment', lambda: {b'FH_FINANCE_SYNC_CREDENTIAL': b'on'})
    with pytest.raises(m.Hold, match='SYNC_OWNER_MUST_BE_DISABLED_WHEN_OPENING_ROUTES'):
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


def test_disable_restores_only_original_and_rechecks_bank(monkeypatch, tmp_path):
    sha, original, state = fake_deployment(monkeypatch, tmp_path)
    state.update(caddy=m.patch_caddy(original), backup=original)
    monkeypatch.setenv('FH_SYNC68_ROUTES', 'DISABLE')
    monkeypatch.delenv('GITHUB_ACTIONS', raising=False)
    monkeypatch.setattr(m.os, 'geteuid', lambda: 0)
    monkeypatch.setattr(m.finance, 'public_probe', lambda *_args, **_kwargs: 404)
    checked = []
    monkeypatch.setattr(m.bank, 'public_negative_checks', lambda: checked.append(True))
    m.disable(sha)
    assert state['caddy'] == original
    assert state['reloads'] == 1
    assert checked == [True]


def test_disable_refuses_to_overwrite_a_concurrent_change(monkeypatch, tmp_path):
    sha, original, state = fake_deployment(monkeypatch, tmp_path)
    state.update(caddy=b'other operator change', backup=original)
    monkeypatch.setenv('FH_SYNC68_ROUTES', 'DISABLE')
    monkeypatch.delenv('GITHUB_ACTIONS', raising=False)
    monkeypatch.setattr(m.os, 'geteuid', lambda: 0)
    with pytest.raises(m.Hold, match='SYNC_CADDY_CHANGED_OR_ALREADY_DISABLED'):
        m.disable(sha)
    assert state['caddy'] == b'other operator change'
    assert state['reloads'] == 0


def test_disable_refuses_github_actions_even_with_root_and_explicit_mode(monkeypatch, tmp_path):
    sha, original, state = fake_deployment(monkeypatch, tmp_path)
    monkeypatch.setenv('FH_SYNC68_ROUTES', 'DISABLE')
    monkeypatch.setenv('GITHUB_ACTIONS', 'true')
    monkeypatch.setattr(m.os, 'geteuid', lambda: 0)
    with pytest.raises(m.Hold, match='EXPLICIT_NATIVE_SYNC_DISABLE_REQUIRED'):
        m.disable(sha)
    assert state['caddy'] == original
    assert state['reloads'] == 0


def test_google_actor_selection_requires_exactly_one_active_account(monkeypatch, tmp_path):
    path = tmp_path / 'synthetic.sqlite'
    connection = sqlite3.connect(path)
    connection.executescript('CREATE TABLE users(id TEXT, disabled INTEGER);'
                             'CREATE TABLE oauth_identities(user_id TEXT, provider TEXT);')
    connection.executemany('INSERT INTO users VALUES (?,?)', [('a' * 32, 0), ('b' * 32, 0), ('c' * 32, 1)])
    connection.executemany('INSERT INTO oauth_identities VALUES (?,?)',
                           [('a' * 32, 'google'), ('a' * 32, 'google'),
                            ('b' * 32, 'vk'), ('c' * 32, 'google')])
    connection.commit()
    monkeypatch.setattr(m, 'AUTH_DATA_ROOT', tmp_path)
    monkeypatch.setattr(m, 'live_environment', lambda: {b'FH_AUTH_DATABASE_PATH': str(path).encode()})
    assert m.unique_google_actor() == b'a' * 32
    connection.execute('INSERT INTO oauth_identities VALUES (?,?)', ('b' * 32, 'google'))
    connection.commit()
    with pytest.raises(m.Hold, match='SYNC_GOOGLE_ACTOR_NOT_UNIQUE'):
        m.unique_google_actor()
    connection.close()


def test_owner_activation_rolls_back_dropin_and_credential_on_restart_failure(monkeypatch, tmp_path):
    sha = 'a' * 40
    secret, dropin = tmp_path / 'secret', tmp_path / 'dropin'
    monkeypatch.setattr(m, 'OWNER_SECRET', secret)
    monkeypatch.setattr(m, 'OWNER_DROPIN', dropin)
    monkeypatch.setenv('FH_SYNC68_OWNER', 'ENABLE')
    monkeypatch.setattr(m, 'enabled_route_preflight', lambda _sha: None)
    monkeypatch.setattr(m, 'unique_google_actor', lambda: b'a' * 32)
    monkeypatch.setattr(m, 'check_owner_directories', lambda: None)
    monkeypatch.setattr(m, 'live_environment', lambda: {})
    monkeypatch.setattr(m.source, 'backup_live_auth_db', lambda: None)
    monkeypatch.setattr(m.finance, 'write_exclusive', lambda path, data, mode: path.write_bytes(data))
    monkeypatch.setattr(m.finance, 'secure_file', lambda path, owner, mode: path.read_bytes())
    restarts = []
    def restart():
        restarts.append(True)
        if len(restarts) == 1:
            raise m.Hold('SYNTHETIC_RESTART_FAILURE')
    monkeypatch.setattr(m, 'restart_auth', restart)
    with pytest.raises(m.Hold, match='SYNTHETIC_RESTART_FAILURE'):
        m.activate_owner(sha)
    assert not secret.exists() and not dropin.exists()
    assert len(restarts) == 2


def test_owner_activation_uses_private_credential_without_exposing_actor_in_unit(monkeypatch, tmp_path, capsys):
    sha = 'a' * 40
    actor = b'b' * 32
    secret, dropin = tmp_path / 'secret', tmp_path / 'dropin'
    monkeypatch.setattr(m, 'OWNER_SECRET', secret)
    monkeypatch.setattr(m, 'OWNER_DROPIN', dropin)
    monkeypatch.setenv('FH_SYNC68_OWNER', 'ENABLE')
    monkeypatch.setattr(m, 'enabled_route_preflight', lambda _sha: None)
    monkeypatch.setattr(m, 'unique_google_actor', lambda: actor)
    monkeypatch.setattr(m, 'check_owner_directories', lambda: None)
    running = {'enabled': False}
    monkeypatch.setattr(m, 'live_environment', lambda: {b'FH_FINANCE_SYNC_CREDENTIAL': b'on'} if running['enabled'] else {})
    monkeypatch.setattr(m.source, 'backup_live_auth_db', lambda: None)
    monkeypatch.setattr(m.finance, 'write_exclusive', lambda path, data, mode: path.write_bytes(data))
    monkeypatch.setattr(m.finance, 'secure_file', lambda path, owner, mode: path.read_bytes())
    monkeypatch.setattr(m, 'restart_auth', lambda: running.update(enabled=dropin.exists()))
    monkeypatch.setattr(m.backend, 'live_state', lambda: m.source.RELEASES / sha)
    monkeypatch.setattr(m.bank, 'postgres_ready', lambda: None)
    monkeypatch.setattr(m, 'public_guards', lambda: None)
    m.activate_owner(sha)
    assert secret.read_bytes() == actor
    assert dropin.read_bytes() == m.OWNER_UNIT
    assert actor not in dropin.read_bytes()
    assert actor.decode() not in capsys.readouterr().out


def test_routes_cannot_open_when_owner_or_runtime_changes(monkeypatch, tmp_path):
    actor = b'a' * 32
    def secure_file(path, owner, mode):
        return m.OWNER_UNIT if path == m.OWNER_DROPIN else actor
    monkeypatch.setattr(m.finance, 'secure_file', secure_file)
    monkeypatch.setattr(m, 'unique_google_actor', lambda: actor)
    monkeypatch.setattr(m, 'live_environment', lambda: {b'FH_FINANCE_SYNC_CREDENTIAL': b'on'})
    m.owner_ready()
    monkeypatch.setattr(m, 'unique_google_actor', lambda: b'b' * 32)
    with pytest.raises(m.Hold, match='SYNC_OWNER_NOT_READY'):
        m.owner_ready()
    monkeypatch.setattr(m, 'unique_google_actor', lambda: actor)
    monkeypatch.setattr(m, 'live_environment', lambda: {})
    with pytest.raises(m.Hold, match='SYNC_OWNER_NOT_READY'):
        m.owner_ready()
