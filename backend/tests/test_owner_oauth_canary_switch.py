"""Offline security tests; never execute the live canary or contact OAuth providers."""
from __future__ import annotations

import importlib.util
import io
import os
from pathlib import Path
from unittest import mock
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/fh_oauth_owner_canary_switch.py'
spec = importlib.util.spec_from_file_location('fh_oauth_owner_canary_switch', SCRIPT)
assert spec is not None and spec.loader is not None
switcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(switcher)

CANARY_SOURCE = '''# Private isolated test only
FH_AUTH_DATABASE_PATH=/var/lib/financial-horizon/oauth-canary/auth.sqlite3
FH_ENABLE_CLOUD_AUTH=true
FH_TELEGRAM_OAUTH_ENABLED=true
FH_GOOGLE_OAUTH_ENABLED=false
FH_YANDEX_OAUTH_ENABLED=false
FH_VK_OAUTH_ENABLED=false
'''


class ProviderSwitchTests(unittest.TestCase):
    def test_google_disables_telegram_and_other_idps(self):
        result = switcher.rewrite_flags(CANARY_SOURCE, 'google')
        self.assertIn('FH_GOOGLE_OAUTH_ENABLED=true', result)
        for p in ('telegram', 'yandex', 'vk'):
            self.assertIn(f'FH_{p.upper()}_OAUTH_ENABLED=false', result)
        self.assertEqual(result.count('# Private isolated test only'), 1)
        self.assertNotIn('SECRET=', result)

    def test_yandex_is_only_enabled_provider(self):
        changed = switcher.rewrite_flags(CANARY_SOURCE, 'yandex')
        self.assertEqual([x for x in changed.splitlines() if x.endswith('=true')],
                         ['FH_ENABLE_CLOUD_AUTH=true', 'FH_YANDEX_OAUTH_ENABLED=true'])

    def test_vk_is_only_enabled_provider(self):
        changed = switcher.rewrite_flags(CANARY_SOURCE, 'vk')
        self.assertEqual([x for x in changed.splitlines() if x.endswith('=true')],
                         ['FH_ENABLE_CLOUD_AUTH=true', 'FH_VK_OAUTH_ENABLED=true'])

    def test_telegram_cannot_be_selected(self):
        with self.assertRaises(switcher.CheckFailed):
            switcher.rewrite_flags(CANARY_SOURCE, 'telegram')

    def test_unknown_provider_rejected(self):
        with self.assertRaises(switcher.CheckFailed):
            switcher.rewrite_flags(CANARY_SOURCE, 'openid')

    def test_missing_flag_rejected(self):
        with self.assertRaises(switcher.CheckFailed):
            switcher.rewrite_flags(CANARY_SOURCE.replace('FH_VK_OAUTH_ENABLED=false\n', ''), 'google')

    def test_duplicate_flag_rejected(self):
        with self.assertRaises(switcher.CheckFailed):
            switcher.rewrite_flags(CANARY_SOURCE + 'FH_GOOGLE_OAUTH_ENABLED=true\n', 'google')

    def test_live_database_swap_rejected(self):
        with self.assertRaises(switcher.CheckFailed):
            switcher.rewrite_flags(CANARY_SOURCE.replace(
                '/var/lib/financial-horizon/oauth-canary/auth.sqlite3',
                '/var/lib/financial-horizon/auth.sqlite3'), 'google')

    def test_global_flag_closed_rejected(self):
        with self.assertRaises(switcher.CheckFailed):
            switcher.rewrite_flags(CANARY_SOURCE.replace('FH_ENABLE_CLOUD_AUTH=true',
                                                          'FH_ENABLE_CLOUD_AUTH=false'), 'google')

    def test_unexpected_line_rejected(self):
        with self.assertRaises(switcher.CheckFailed):
            switcher.parse_env(CANARY_SOURCE + 'source /etc/environment\n')

    def test_different_settings_preserved(self):
        source = CANARY_SOURCE + 'OTHER_SAFE_SETTING=yes\n'
        changed = switcher.rewrite_flags(source, 'google')
        self.assertTrue(changed.endswith('OTHER_SAFE_SETTING=yes\n'))
        self.assertEqual(switcher.parse_env(changed)['OTHER_SAFE_SETTING'], 'yes')

    def test_staged_secrets_would_not_be_printed(self):
        source = CANARY_SOURCE + 'NOT_LOGGED_SECRET=synthetic-only\n'
        changed = switcher.rewrite_flags(source, 'google')
        self.assertEqual(switcher.parse_env(changed)['NOT_LOGGED_SECRET'], 'synthetic-only')
        self.assertNotIn('synthetic-only', str(switcher.CheckFailed('provider denied')))

    def test_check_valid_redirect_and_telegram_closed(self):
        def request(path):
            if path == '/api/auth/providers':
                return 200, {}, b'{"enabled":true,"providers":["google"]}'
            if path == '/api/auth/oauth/google/start':
                return 303, {'location': 'https://accounts.google.com/o/oauth2/v2/auth'}, b''
            return 404, {}, b'Not available'
        with mock.patch.object(switcher, 'request', side_effect=request):
            switcher.verify_target('google')

    def test_cross_provider_redirect_rejected(self):
        def request(path):
            if path == '/api/auth/providers':
                return 200, {}, b'{"enabled":true,"providers":["google"]}'
            if path == '/api/auth/oauth/google/start':
                return 303, {'location': 'https://evil.example.org/auth'}, b''
            return 404, {}, b'Not available'
        with mock.patch.object(switcher, 'request', side_effect=request):
            with self.assertRaises(switcher.CheckFailed):
                switcher.verify_target('google')

    def test_telegram_must_be_404(self):
        def request(path):
            if path == '/api/auth/providers':
                return 200, {}, b'{"enabled":true,"providers":["google"]}'
            if path == '/api/auth/oauth/google/start':
                return 303, {'location': 'https://accounts.google.com/auth'}, b''
            return 303, {'location': 'https://oauth.telegram.org/auth'}, b''
        with mock.patch.object(switcher, 'request', side_effect=request):
            with self.assertRaises(switcher.CheckFailed):
                switcher.verify_target('google')

    @unittest.skipIf(os.name == 'nt' or not hasattr(os, 'O_NOFOLLOW'),
                     'Operator script requires Linux filesystem APIs')
    def test_atomic_replace_preserves_0600(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'canary.env'
            file.write_text(CANARY_SOURCE)
            switcher.atomic_replace(file, switcher.rewrite_flags(CANARY_SOURCE, 'google'))
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            self.assertIn('FH_GOOGLE_OAUTH_ENABLED=true', file.read_text())

    @unittest.skipIf(os.name == 'nt', 'Operator backup requires Linux fs permissions')
    def test_repeated_target_switches_preserve_private_backups(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(switcher, 'ROOT_ONLY_BACKUPS', Path(directory)):
                first = switcher.write_private_backup('google', 'FIRST-SYNTHETIC-ONLY\\n')
                second = switcher.write_private_backup('google', 'SECOND-SYNTHETIC-ONLY\\n')
                self.assertNotEqual(first, second)
                self.assertEqual(first.read_text(), 'FIRST-SYNTHETIC-ONLY\\n')
                self.assertEqual(second.read_text(), 'SECOND-SYNTHETIC-ONLY\\n')
                self.assertEqual(first.stat().st_mode & 0o777, 0o600)
                self.assertEqual(second.stat().st_mode & 0o777, 0o600)
                self.assertFalse(first.is_symlink())
                self.assertFalse(second.is_symlink())

    def test_preflight_is_read_only_and_has_no_secrets_in_output(self):
        with mock.patch.object(switcher, 'check_static_guards', return_value=CANARY_SOURCE) as guard, \\
                mock.patch.object(switcher, 'restart') as restart, \\
                mock.patch('sys.stdout', new_callable=io.StringIO) as output:
            switcher.preflight('google')
            guard.assert_called_once_with('google')
            restart.assert_not_called()
            self.assertIn('CANARY_PREFLIGHT=PASS', output.getvalue())
            self.assertIn('CURRENT_PROVIDER=telegram', output.getvalue())
            self.assertIn('TARGET_PROVIDER=google', output.getvalue())
            self.assertNotIn('FH_AUTH_DATABASE_PATH=', output.getvalue())

    def test_failure_codes_never_echo_unknown_private_exception(self):
        secret = 'sensitive-token-must-not-be-printed'
        with mock.patch('sys.argv', ['switcher', '--provider', 'google', '--preflight']), \\
                mock.patch.object(switcher, 'preflight', side_effect=switcher.CheckFailed(secret)), \\
                mock.patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertEqual(switcher.main(), 1)
            self.assertIn('FAILURE_CODE=OTHER_CHECK_FAILED', output.getvalue())
            self.assertNotIn(secret, output.getvalue())
        self.assertEqual(switcher.SAFE_FAILURE_CODES['Target provider credentials not staged'],
                         'TARGET_CREDENTIALS_NOT_STAGED')

    def test_no_side_effects_at_import_time(self):
        self.assertTrue(callable(switcher.main))
        self.assertEqual(switcher.PROVIDERS, ('telegram', 'google', 'yandex', 'vk'))
        self.assertEqual(switcher.TESTABLE, ('google', 'yandex', 'vk'))


if __name__ == '__main__':
    unittest.main()
