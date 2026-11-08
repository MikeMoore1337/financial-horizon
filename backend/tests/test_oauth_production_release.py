"""Offline checks of the guarded OAuth production release helper.

No real service, network call, database or production filesystem is modified.
"""
from __future__ import annotations

from contextlib import redirect_stdout
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[2] / "scripts/fh_oauth_production_release.py"
spec = importlib.util.spec_from_file_location("fh_oauth_production_release", SOURCE)
assert spec is not None and spec.loader is not None
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

SHA = "a" * 40
STAGED = "\n".join([
    "FH_ENABLE_CLOUD_AUTH=false",
    "FH_TELEGRAM_OAUTH_ENABLED=false",
    "FH_GOOGLE_OAUTH_ENABLED=false",
    "FH_YANDEX_OAUTH_ENABLED=false",
    "FH_VK_OAUTH_ENABLED=false",
    "FH_AUTH_DATABASE_PATH=/some/protected/live-auth.sqlite3",
    "",
]).encode()


class ReleaseContracts(unittest.TestCase):
    def test_only_three_provider_flags_enabled_and_telegram_stays_off(self):
        changed = release.replace_flags(STAGED)
        self.assertEqual(release.assignment(changed, "FH_ENABLE_CLOUD_AUTH"), ["true"])
        self.assertEqual(release.assignment(changed, "FH_TELEGRAM_OAUTH_ENABLED"), ["false"])
        for name in ("GOOGLE", "YANDEX", "VK"):
            self.assertEqual(
                release.assignment(changed, f"FH_{name}_OAUTH_ENABLED"), ["true"]
            )
        self.assertEqual(release.assignment(changed, "FH_AUTH_DATABASE_PATH"),
                         ["/some/protected/live-auth.sqlite3"])
        self.assertNotEqual(changed, STAGED)
        with self.assertRaises(release.Gate):
            release.replace_flags(changed)

    def test_reject_duplicate_and_enabled_preexisting_flags(self):
        with self.assertRaises(release.Gate):
            release.replace_flags(STAGED + b"FH_GOOGLE_OAUTH_ENABLED=false\n")
        with self.assertRaises(release.Gate):
            release.replace_flags(STAGED.replace(
                b"FH_TELEGRAM_OAUTH_ENABLED=false",
                b"FH_TELEGRAM_OAUTH_ENABLED=true"
            ))

    def test_caddy_routing_fixes_only_public_oauth_and_session_paths(self):
        original = """fin-horizon.mikemoore.top {
    @owner_oauth_canary {
        path /api/auth/providers /api/auth/oauth/*
    }
    handle @owner_oauth_canary {
        reverse_proxy 127.0.0.1:9139
    }
    @any_oauth_canary {
        path /api/auth/providers /api/auth/oauth/*
    }
    handle @any_oauth_canary {
        respond "Forbidden" 403
    }
}
"""
        updated = release.public_caddy_config(original, 9141)
        self.assertIn("handle @fh_oauth_live_get {", updated)
        self.assertIn("handle @fh_oauth_live_post {", updated)
        self.assertIn("reverse_proxy 127.0.0.1:9141", updated)
        self.assertIn("log_skip @fh_oauth_callback_log_skip", updated)
        self.assertIn("handle @owner_oauth_canary {", updated)
        self.assertIn("handle @any_oauth_canary {", updated)
        self.assertIn("respond \"Forbidden\" 403", updated)
        self.assertIn("/api/auth/email/logout-others", updated)
        self.assertNotIn("/api/auth/email/register", updated)
        self.assertNotIn("/api/auth/oauth/telegram/start", updated)
        self.assertLess(updated.index("handle @fh_oauth_live_get"),
                        updated.index("handle @owner_oauth_canary"))
        with self.assertRaises(release.Gate):
            release.public_caddy_config(updated, 9141)

    def test_session_and_provider_readiness_have_explicit_negative_checks(self):
        def fake_http(_port, path):
            if path == "/api/auth/providers":
                return 200, b'{"enabled":true,"providers":["google","yandex","vk"]}'
            if path == "/api/auth/oauth/telegram/start":
                return 404, b'{"detail":"not available"}'
            if path == "/api/auth/email/me":
                return 200, b'{"authenticated":false,"user":null}'
            raise AssertionError(path)

        with mock.patch.object(release, "http_probe", side_effect=fake_http):
            release.validate_running_oauth(9141, release.PROVIDERS)
        def bad_telegram(_port, path):
            if path == "/api/auth/oauth/telegram/start":
                return 303, b""
            return fake_http(_port, path)
        with mock.patch.object(release, "http_probe", side_effect=bad_telegram):
            with self.assertRaises(release.Gate) as result:
                release.validate_running_oauth(9141, release.PROVIDERS)
            self.assertEqual(result.exception.code, "TELEGRAM_NOT_DISABLED")

    def test_release_switch_keeps_previous_tree_for_rollback(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            releases = base / "releases"
            releases.mkdir()
            previous = releases / ("a" * 40)
            current = releases / ("b" * 40)
            previous.mkdir()
            current.mkdir()
            (base / "current").symlink_to(previous)
            self.assertEqual(release.current_release(base), previous)
            release.switch_release(base, current)
            self.assertEqual(release.current_release(base), current)
            release.switch_release(base, previous)
            self.assertEqual(release.current_release(base), previous)

    def test_archive_rejects_mismatched_prefix_without_extracting(self):
        with tempfile.TemporaryDirectory() as root:
            package = io.BytesIO()
            with tarfile.open(fileobj=package, mode="w:gz") as archive:
                payload = b"not an official release"
                member = tarfile.TarInfo("evil-root/app.py")
                member.size = len(payload)
                archive.addfile(member, io.BytesIO(payload))
            package.seek(0)
            with mock.patch.object(release, "urlopen", return_value=package):
                with self.assertRaises(release.Gate) as result:
                    release.source_archive(SHA, Path(root))
            self.assertEqual(result.exception.code, "SOURCE_ARCHIVE_UNEXPECTED")

    def test_caddy_atomic_update_preserves_permissions(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "site.caddy"
            path.write_text("before")
            path.chmod(0o640)
            release.atomic_file(path, b"after", None)
            self.assertEqual(path.read_bytes(), b"after")
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)

    def test_rollback_backups_are_unique_and_root_only_mode(self):
        with tempfile.TemporaryDirectory() as root:
            with mock.patch.object(release, "BACKUPS", Path(root)):
                release.save_private_release_receipt("caddy", b"BEFORE\n")
                release.save_private_release_receipt("caddy", b"AGAIN\n")
            files = list(Path(root).glob("fh-oauth-release-caddy-*.backup"))
            self.assertEqual(len(files), 2)
            self.assertEqual({p.read_bytes() for p in files},
                             {b"BEFORE\n", b"AGAIN\n"})
            self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600
                                for p in files))

    def test_one_command_without_apply_only_checks_preflight(self):
        with mock.patch.object(release, "preflight", return_value=None) as check, \
             mock.patch.object(release, "rollout") as deployed, \
             mock.patch("sys.argv", ["release", "--sha", SHA]), \
             redirect_stdout(io.StringIO()) as output:
            self.assertEqual(release.main(), 0)
            check.assert_called_once_with(SHA)
            deployed.assert_not_called()
            self.assertIn("DEPLOYMENT_NOT_STARTED=YES", output.getvalue())


if __name__ == "__main__":
    unittest.main()
