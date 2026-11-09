"""Offline checks of the guarded OAuth production release helper.

No real service, network call, database or production filesystem is modified.
"""
from __future__ import annotations

from contextlib import redirect_stdout, ExitStack
import importlib.util
import io
import os
import sqlite3
from types import SimpleNamespace
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
    def test_all_four_provider_flags_enabled_in_production_release(self):
        changed = release.replace_flags(STAGED)
        self.assertEqual(release.assignment(changed, "FH_ENABLE_CLOUD_AUTH"), ["true"])
        self.assertEqual(release.assignment(changed, "FH_TELEGRAM_OAUTH_ENABLED"), ["true"])
        for name in ("GOOGLE", "YANDEX", "VK", "TELEGRAM"):
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
        self.assertIn("/api/auth/oauth/telegram/start", updated)
        self.assertIn("/api/auth/oauth/telegram/callback", updated)
        self.assertLess(updated.index("handle @fh_oauth_live_get"),
                        updated.index("handle @owner_oauth_canary"))
        with self.assertRaises(release.Gate):
            release.public_caddy_config(updated, 9141)

    def test_session_and_provider_readiness_have_explicit_negative_checks(self):
        def fake_http(_port, path):
            if path == "/api/auth/providers":
                return 200, b'{"enabled":true,"providers":["telegram","google","yandex","vk"]}'
            if path == "/api/auth/oauth/telegram/start":
                return 303, b""
            if path == "/api/auth/email/me":
                return 200, b'{"authenticated":false,"user":null}'
            raise AssertionError(path)

        with mock.patch.object(release, "http_probe", side_effect=fake_http):
            release.validate_running_oauth(9141, release.PROVIDERS)
        def bad_telegram(_port, path):
            if path == "/api/auth/oauth/telegram/start":
                return 404, b""
            return fake_http(_port, path)
        with mock.patch.object(release, "http_probe", side_effect=bad_telegram):
            with self.assertRaises(release.Gate) as result:
                release.validate_running_oauth(9141, release.PROVIDERS)
            self.assertEqual(result.exception.code, "TELEGRAM_START_UNAVAILABLE")

        def missing_telegram(_port, path):
            if path == "/api/auth/providers":
                return 200, b'{"enabled":true,"providers":["google","yandex","vk"]}'
            return fake_http(_port, path)
        with mock.patch.object(release, "http_probe", side_effect=missing_telegram):
            with self.assertRaises(release.Gate) as result:
                release.validate_running_oauth(9141, release.PROVIDERS)
            self.assertEqual(result.exception.code, "OAUTH_PROVIDERS_UNEXPECTED")

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

    def test_dependencies_are_installed_only_in_new_release_venv(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            release_dir = base / "releases" / SHA
            release_dir.mkdir(parents=True)
            source = base / "src"
            requirements = source / "backend" / "requirements.txt"
            requirements.parent.mkdir(parents=True)
            requirements.write_text("fastapi>=0.115,<1\njoserfc>=1.8,<2\n")
            active = base / "running-venv" / "bin" / "python"
            isolated = release_dir / ".oauth-venv"
            staged_py = isolated / "bin" / "python"
            site = isolated / "lib" / "python3.12" / "site-packages"
            calls = []

            def fake_command(args, **kwargs):
                calls.append((args, kwargs))
                if args[1:3] == ["-m", "venv"]:
                    staged_py.parent.mkdir(parents=True)
                    staged_py.touch()
                    site.mkdir(parents=True)
                if len(args) > 2 and args[1] == "-c" and "sysconfig.get_path" in args[2]:
                    return str(site).encode("utf-8") + b"\n"
                return b""

            with mock.patch.object(release, "command", side_effect=fake_command), \
                    mock.patch.object(release.shutil, "which", return_value=None):
                result = release.stage_isolated_python(active, release_dir, source)
            self.assertEqual(result, str(site))
            installs = [args for args, _ in calls if "-m" in args and "pip" in args]
            self.assertEqual(len(installs), 1)
            self.assertEqual(installs[0][0], str(staged_py))
            self.assertIn("--require-virtualenv", installs[0])
            self.assertFalse(any(args[0] == str(active) and "pip" in args
                                 for args, _ in calls))

    def test_failed_staging_removes_private_venv(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            source = base / "src"
            path = source / "backend" / "requirements.txt"
            path.parent.mkdir(parents=True)
            path.write_text("fastapi>=0.115,<1\n")
            dest = base / "releases" / SHA
            dest.mkdir(parents=True)
            venv = dest / ".oauth-venv"

            def fail(args, **kwargs):
                venv.mkdir()
                raise release.Gate("ISOLATED_VENV_CREATION_FAILED")

            with mock.patch.object(release, "command", side_effect=fail), \
                    mock.patch.object(release.shutil, "which", return_value=None):
                with self.assertRaises(release.Gate) as raised:
                    release.stage_isolated_python(Path("/tmp/old/python"), dest, source)
            self.assertEqual(raised.exception.code, "ISOLATED_VENV_CREATION_FAILED")
            self.assertFalse(venv.exists())

    def test_uv_install_works_without_pip_on_active_python(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            release_dir = base / "releases" / SHA
            release_dir.mkdir(parents=True)
            source = base / "src"
            requirements = source / "backend" / "requirements.txt"
            requirements.parent.mkdir(parents=True)
            requirements.write_text("fastapi>=0.115,<1\n")
            active = base / "running-venv" / "bin" / "python"
            target = release_dir / ".oauth-venv"
            staged_py = target / "bin" / "python"
            site = target / "lib" / "python3.12" / "site-packages"
            calls = []

            def fake(args, **kwargs):
                calls.append(args)
                if len(args) > 1 and args[1] == "venv":
                    staged_py.parent.mkdir(parents=True)
                    staged_py.touch()
                    site.mkdir(parents=True)
                if len(args) > 2 and args[1] == "-c" and "sysconfig.get_path" in args[2]:
                    return (str(site) + "\n").encode("utf-8")
                return b""

            with mock.patch.object(release, "command", side_effect=fake), \
                    mock.patch.object(release.shutil, "which", return_value="/usr/local/bin/uv"):
                resolved = release.stage_isolated_python(active, release_dir, source)
            self.assertEqual(resolved, str(site))
            self.assertIn(
                ["/usr/local/bin/uv", "venv", "--python", str(active), str(target)],
                calls,
            )
            self.assertIn(
                ["/usr/local/bin/uv", "pip", "install", "--python",
                 str(staged_py), "--link-mode", "copy",
                 "--no-progress", "-r", str(requirements)],
                calls,
            )
            self.assertFalse(any(args[0] == str(active) and "pip" in args
                                 for args in calls))

    def test_staged_pythonpath_keeps_original_import_path(self):
        site = "/opt/financial-horizon-auth/releases/" + SHA + "/.oauth-venv/lib/python3.12/site-packages"
        self.assertEqual(
            release.service_python_path(site, {"PYTHONPATH": "/opt/financial-horizon-auth/current/backend"}),
            site + ":/opt/financial-horizon-auth/current/backend",
        )
        self.assertEqual(release.service_python_path(site, {}), site)
        with self.assertRaises(release.Gate):
            release.service_python_path(site, {"PYTHONPATH": "unexpected path with spaces"})

    def test_python_failures_receive_stable_diagnostic_code(self):
        result = mock.Mock(returncode=1, stdout=b"private data, never display")
        with mock.patch.object(release.subprocess, "run", return_value=result):
            with self.assertRaises(release.Gate) as error:
                release.command(["/fake/venv/bin/python", "-m", "pip", "install"],
                                failure_code="ISOLATED_DEPS_INSTALL_FAILED")
            self.assertEqual(error.exception.code, "ISOLATED_DEPS_INSTALL_FAILED")

    def test_nullable_auth_db_is_accepted_without_repeating_live_migration(self):
        with tempfile.TemporaryDirectory() as root:
            db = Path(root) / "auth.sqlite3"
            with sqlite3.connect(db) as conn:
                conn.execute("""
                    CREATE TABLE users (
                        id TEXT PRIMARY KEY,
                        email TEXT UNIQUE,
                        password_hash TEXT NOT NULL DEFAULT '',
                        verified_at INTEGER,
                        password_changed_at INTEGER,
                        disabled INTEGER NOT NULL DEFAULT 0,
                        created_at INTEGER NOT NULL
                    )
                """)
            self.assertTrue(release.schema_is_nullable(db))
            with mock.patch.object(release, "command", side_effect=AssertionError(
                "No migration of an already nullable production database"
            )), redirect_stdout(io.StringIO()) as printed:
                self.assertFalse(release.migrate_live_database(Path("/no-source"), db))
            self.assertIn("DB_SCHEMA_MIGRATION=ALREADY_READY", printed.getvalue())
            self.assertTrue(release.schema_is_nullable(db))

    def test_legacy_auth_schema_still_requires_migration(self):
        with tempfile.TemporaryDirectory() as root:
            db = Path(root) / "legacy.sqlite3"
            with sqlite3.connect(db) as conn:
                conn.execute("""
                    CREATE TABLE users (
                        id TEXT PRIMARY KEY,
                        email TEXT UNIQUE NOT NULL,
                        password_hash TEXT NOT NULL DEFAULT '',
                        verified_at INTEGER,
                        password_changed_at INTEGER,
                        disabled INTEGER NOT NULL DEFAULT 0,
                        created_at INTEGER NOT NULL
                    )
                """)
            self.assertFalse(release.schema_is_nullable(db))
            with sqlite3.connect(db) as conn:
                conn.execute("CREATE TRIGGER user_write_event AFTER INSERT ON users "
                             "BEGIN SELECT 1; END")
            with self.assertRaises(release.Gate) as error:
                release.schema_is_nullable(db)
            self.assertEqual(error.exception.code, "USERS_SCHEMA_CUSTOMIZATION_UNEXPECTED")

    def test_staged_source_root_shadows_old_auth_modules(self):
        with tempfile.TemporaryDirectory() as root:
            stage = Path(root) / "releases" / SHA
            for package in ("fh_auth", "fh_email_auth"):
                folder = stage / "backend" / package
                folder.mkdir(parents=True)
                (folder / "app.py").write_text("# synthetic\n")
            module_root = release.staged_modules_root(stage)
            self.assertEqual(module_root, stage / "backend")
            site = "/tmp/synthetic/lib/site-packages"
            previous = "/opt/financial-horizon-auth/current/backend"
            result = release.service_python_path(
                site, {"PYTHONPATH": previous}, str(module_root)
            )
            self.assertEqual(result, f"{module_root}:{site}:{previous}")

    def test_systemd_dropin_uses_new_private_python_not_missing_old_venv(self):
        with tempfile.TemporaryDirectory() as root:
            stage = Path(root) / "releases" / SHA
            modules = stage / "backend"
            modules.mkdir(parents=True)
            runtime = stage / ".oauth-venv" / "bin" / "python"
            runtime.parent.mkdir(parents=True)
            runtime.write_text("# synthetic interpreter")
            runtime.chmod(0o755)
            pythonpath = str(modules) + ":" + str(stage / ".oauth-venv" / "lib" / "site-packages")
            args = release.safe_uvicorn_argv([
                "/opt/financial-horizon-auth/current/.venv/bin/python",
                "-m", "uvicorn", "fh_email_auth.app:app",
                "--host", "127.0.0.1", "--port", "9141",
                "--no-access-log", "--proxy-headers",
            ], 9141)
            rendered = release.systemd_oauth_dropin(
                modules, pythonpath, runtime, args
            ).decode()
            self.assertIn("ExecStart=\nExecStart=" + str(runtime) +
                          " -m uvicorn fh_email_auth.app:app", rendered)
            self.assertNotIn("/current/.venv/", rendered)
            self.assertIn("--host 127.0.0.1 --port 9141", rendered)
            self.assertIn("--no-access-log", rendered)
            self.assertIn("WorkingDirectory=" + str(modules) + "\n", rendered)
            self.assertIn('Environment="PYTHONPATH=' + pythonpath + '"\n', rendered)
            self.assertIn("EnvironmentFile=/etc/financial-horizon/oauth.env\n", rendered)
            self.assertNotIn("telegram", rendered.lower())
            with self.assertRaises(release.Gate):
                release.systemd_oauth_dropin(
                    modules, "unsafe path with whitespace", runtime, args
                )
            with self.assertRaises(release.Gate):
                release.systemd_oauth_dropin(
                    modules, pythonpath, modules / "python", args
                )

    def test_shebang_launcher_uses_new_private_runtime_not_old_script(self):
        # Linux /proc/PID/cmdline for a console script may be:
        # python /old/current/.venv/bin/uvicorn app:app --flags...
        argv = [
            "/opt/financial-horizon-auth/current/.venv/bin/python",
            "/opt/financial-horizon-auth/current/.venv/bin/uvicorn",
            "fh_email_auth.app:app", "--host", "127.0.0.1",
            "--port", "9141", "--no-access-log",
        ]
        normalized = release.safe_uvicorn_argv(argv, 9141)
        self.assertEqual(normalized, [
            "fh_email_auth.app:app", "--host", "127.0.0.1",
            "--port", "9141", "--no-access-log",
        ])
        self.assertNotIn("/current/", " ".join(normalized))

    def test_unknown_or_insecure_launchers_block_before_downtime(self):
        base = ["-m", "uvicorn", "fh_email_auth.app:app",
                "--host", "127.0.0.1", "--port", "9141", "--no-access-log"]
        examples = [
            ["/bin/sh", "-c", "echo test"],
            ["/usr/bin/python3", "-m", "gunicorn", "fh_email_auth.app:app",
             "--host", "127.0.0.1", "--port", "9141", "--no-access-log"],
            ["/usr/bin/python3", *base[:-1], "--reload"],
            ["/usr/bin/python3", *base[:-1]],
            ["/usr/bin/python3", *base, "--port", "9141"],
            ["/usr/bin/python3", *base, "--host", "0.0.0.0"],
            ["/usr/bin/python3", "-m", "uvicorn", "fh_auth.app:app",
             "--host", "127.0.0.1", "--port", "9141", "--no-access-log"],
        ]
        for args in examples:
            with self.subTest(args=args), self.assertRaises(release.Gate):
                release.safe_uvicorn_argv(args, 9141)

    def test_approved_existing_launch_flags_are_preserved(self):
        start = [
            "/opt/financial-horizon-auth/venv/bin/uvicorn",
            "fh_email_auth.app:app", "--host=127.0.0.1",
            "--port=9141", "--no-access-log", "--log-level", "warning",
        ]
        output = release.safe_uvicorn_argv(start, 9141)
        self.assertEqual(output, [
            "fh_email_auth.app:app", "--host", "127.0.0.1",
            "--port", "9141", "--no-access-log", "--log-level", "warning",
        ])

    def test_service_launch_type_must_support_single_exec(self):
        with mock.patch.object(release, "command", return_value=b"simple\n"):
            release.ensure_supported_systemd_launch()
        with mock.patch.object(release, "command", return_value=b"notify\n"):
            with self.assertRaises(release.Gate):
                release.ensure_supported_systemd_launch()


    def test_service_user_source_access_preflight_never_starts_backend(self):
        source = Path("/opt/financial-horizon-auth/releases/" + SHA + "/backend")
        python = Path("/opt/financial-horizon-auth/venv/bin/python")
        env = {"PYTHONPATH": str(source) + ":/tmp/site"}
        calls = []

        def fake_command(args, **kwargs):
            calls.append((args, kwargs))
            if args[:4] == ["systemctl", "show", "--value", "-p"]:
                return b"fh-email-auth\n"
            return b""

        account = SimpleNamespace(pw_uid=9001, pw_gid=9002,
                                  pw_dir="/nonexistent")
        with mock.patch.object(release, "command", side_effect=fake_command), \
                mock.patch.object(release.pwd, "getpwnam", return_value=account):
            release.verify_service_user_module_access(python, source, env)
        self.assertEqual(len(calls), 5)
        self.assertEqual(calls[-1][0][:2], [str(python), "-c"])
        self.assertEqual(calls[1][0][:2], ["test", "-x"])
        self.assertEqual(calls[2][0][:2], ["test", "-r"])
        self.assertTrue(all(call[1]["cwd"] == source for call in calls[1:]))
        self.assertTrue(all(call[1]["run_as"] == (9001, 9002)
                            for call in calls[1:]))
        self.assertFalse(any(args[0] == "runuser" for args, _ in calls))
        self.assertEqual(calls[1][1]["failure_code"],
                         "STAGED_SOURCE_NOT_TRAVERSABLE")
        self.assertEqual(calls[2][1]["failure_code"],
                         "STAGED_SOURCE_NOT_READABLE")
        self.assertEqual(calls[-1][1]["failure_code"],
                         "STAGED_AUTH_IMPORT_AS_SERVICE_USER_FAILED")
        service_env = calls[-1][1]["env"]
        self.assertEqual(service_env["PYTHONPATH"], env["PYTHONPATH"])
        self.assertEqual(service_env["PYTHONNOUSERSITE"], "1")
        self.assertEqual(service_env["HOME"], "/nonexistent")
        self.assertNotIn("FH_SESSION_SECRET", service_env)

    def test_service_user_checks_drop_privileges_without_external_runuser(self):
        process = SimpleNamespace(returncode=0, stdout=b"ok")
        with mock.patch.object(release.subprocess, "run", return_value=process) as invoke, \
                mock.patch.object(release.os, "geteuid", return_value=0):
            self.assertEqual(
                release.command(["/usr/bin/python3", "-c", "pass"],
                                run_as=(9001, 9002)), b"ok"
            )
        self.assertEqual(invoke.call_args.args[0],
                         ["/usr/bin/python3", "-c", "pass"])
        opts = invoke.call_args.kwargs
        self.assertEqual(opts["user"], 9001)
        self.assertEqual(opts["group"], 9002)
        self.assertEqual(opts["extra_groups"], [])
        self.assertFalse(opts["check"])

    def test_service_user_checks_refuse_root_or_unsafe_identity(self):
        with mock.patch.object(release.subprocess, "run") as invoke, \
                mock.patch.object(release.os, "geteuid", return_value=0):
            for identity in ((0, 9002), (9001, 0), (-1, 9002),
                             ("9001", 9002), (True, 9002)):
                with self.subTest(identity=identity), self.assertRaises(release.Gate) as result:
                    release.command(["test", "-x", "/tmp"], run_as=identity)
                self.assertEqual(result.exception.code, "SERVICE_IDENTITY_UNSAFE")
        invoke.assert_not_called()
        with mock.patch.object(release.subprocess, "run") as invoke, \
                mock.patch.object(release.os, "geteuid", return_value=1000):
            with self.assertRaises(release.Gate) as result:
                release.command(["test", "-x", "/tmp"], run_as=(9001, 9002))
            self.assertEqual(result.exception.code, "SERVICE_IDENTITY_UNSAFE")
        invoke.assert_not_called()

    def test_only_new_backend_gets_group_read_without_service_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            releases = base / "releases"
            releases.mkdir()
            stage = releases / SHA
            stage.mkdir(mode=0o700)
            module = stage / "fh_auth"
            module.mkdir(mode=0o700)
            code = module / "__init__.py"
            code.write_text("synthetic = True")
            code.chmod(0o600)
            external = base / "external-private"
            external.write_text("keep this private")
            external.chmod(0o600)
            (stage / "external-link").symlink_to(external)
            account = SimpleNamespace(pw_uid=9001, pw_gid=9002,
                                      pw_dir="/nonexistent")
            with mock.patch.object(release, "BACKEND_ROOT", base), \
                    mock.patch.object(release.pwd, "getpwnam",
                                      return_value=account), \
                    mock.patch.object(release.os, "chown") as chown, \
                    mock.patch.object(release.os, "chmod") as chmod:
                release.grant_staged_release_read_access(
                    stage, user="fh-email-auth"
                )
            owner_targets = [x.args[0] for x in chown.call_args_list]
            self.assertIn(stage, owner_targets)
            self.assertIn(module, owner_targets)
            self.assertIn(code, owner_targets)
            self.assertNotIn(external, owner_targets)
            self.assertNotIn(stage / "external-link", owner_targets)
            self.assertTrue(all(x.args[1] == -1 and x.args[2] == 9002
                                for x in chown.call_args_list))
            modes = {call.args[0]:call.args[1] for call in chmod.call_args_list}
            self.assertEqual(modes[stage], 0o750)
            self.assertEqual(modes[module], 0o750)
            self.assertEqual(modes[code], 0o640)
            self.assertEqual(external.stat().st_mode & 0o777, 0o600)

    def test_shared_hardlinks_block_permission_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            releases = base / "releases"
            releases.mkdir()
            stage = releases / SHA
            stage.mkdir()
            code = stage / "shared.py"
            code.write_text("synthetic")
            os.link(code, base / "other-shared.py")
            with mock.patch.object(release, "BACKEND_ROOT", base), \
                    mock.patch.object(release.pwd, "getpwnam",
                                      return_value=SimpleNamespace(
                                          pw_uid=9001, pw_gid=9002,
                                          pw_dir="/nonexistent")), \
                    mock.patch.object(release.os, "chown") as chown:
                with self.assertRaises(release.Gate) as error:
                    release.grant_staged_release_read_access(
                        stage, user="fh-email-auth"
                    )
            self.assertEqual(error.exception.code,
                             "STAGED_RELEASE_SHARED_HARDLINK")
            chown.assert_not_called()

    def test_service_user_source_access_rejects_unconfigured_user(self):
        with mock.patch.object(release, "command", return_value=b""):
            with self.assertRaises(release.Gate) as error:
                release.verify_service_user_module_access(
                    Path("/usr/bin/python"), Path("/tmp/source"), {}
                )
        self.assertEqual(error.exception.code, "SERVICE_USER_INVALID")

    def test_missing_staged_module_blocks_deployment(self):
        with tempfile.TemporaryDirectory() as root:
            stage = Path(root)
            folder = stage / "backend" / "fh_email_auth"
            folder.mkdir(parents=True)
            (folder / "app.py").write_text("# synthetic\n")
            with self.assertRaises(release.Gate) as error:
                release.staged_modules_root(stage)
            self.assertEqual(error.exception.code, "STAGED_AUTH_PACKAGES_NOT_FOUND")

    def test_recent_logs_return_only_allowlisted_error_category(self):
        data = "PII-NOT-FOR-OUTPUT\nModuleNotFoundError: No module named 'fh_auth'\n"
        with mock.patch.object(release.subprocess, "run", return_value=mock.Mock(
            returncode=0, stdout=data,
        )):
            result = release.safe_recent_service_error()
        self.assertEqual(result, "MODULE_NOT_FOUND")
        self.assertNotIn("PII", result)

    def test_stage_only_prepares_same_release_then_cleans_without_downtime(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            backend = base / "auth"
            static = base / "static"
            for folder in (backend, static):
                (folder / "releases").mkdir(parents=True)
            old_backend = backend / "releases" / "previous"
            old_static = static / "releases" / "previous"
            old_backend.mkdir()
            old_static.mkdir()
            (backend / "current").symlink_to(old_backend)
            (static / "current").symlink_to(old_static)
            site = base / "site.caddy"
            site.write_text("original", encoding="utf-8")
            source = base / "source"
            source.mkdir()
            db = base / "auth.sqlite3"
            old_env = b"TEST_ENV_DISABLED=true\n"
            old_args = [
                "/usr/bin/python3", "-m", "uvicorn", "fh_email_auth.app:app",
                "--host", "127.0.0.1", "--port", "9141", "--no-access-log",
            ]
            approved = release.safe_uvicorn_argv(old_args, 9141)
            calls = []

            def fake_backend(src, sha, existing):
                candidate = backend / "releases" / sha
                (candidate / ".oauth-venv" / "bin").mkdir(parents=True)
                (candidate / ".oauth-venv" / "bin" / "python").write_text(
                    "fake executable"
                )
                (candidate / "backend").mkdir()
                return candidate

            def fake_static(src, sha):
                candidate = static / "releases" / sha
                candidate.mkdir()
                return candidate

            def fake_command(args, **kwargs):
                calls.append(args)
                if args[:4] == ["systemctl", "show", "--value", "-p"]:
                    return b"fh-email-auth\n"
                if args[:2] == ["systemctl", "stop"]:
                    raise AssertionError("stage-only must not stop production")
                return b""

            preflight = (
                old_backend, old_static, db, old_env, "original", "new",
                9141, Path("/usr/bin/python3"), approved,
            )
            with ExitStack() as stack:
                def patch(name, value):
                    return stack.enter_context(mock.patch.object(release, name, value))

                patch("BACKEND_ROOT", backend)
                patch("STATIC_ROOT", static)
                patch("CADDY_SITE", site)
                patch("OAUTH_ENV", base / "oauth.env")
                patch("preflight", mock.Mock(return_value=preflight))
                patch("source_archive", mock.Mock(return_value=source))
                patch("stage_backend", fake_backend)
                patch("stage_static", fake_static)
                patch("stage_isolated_python",
                      mock.Mock(return_value=str(base / "synthetic-site")))
                patch("running_process", mock.Mock(return_value=(
                    123, old_args, {"FH_AUTH_DATABASE_PATH": str(db)}
                )))
                patch("staged_modules_root", lambda candidate: candidate / "backend")
                patch("private_file", lambda path: old_env)
                patch("verify_service_user_module_access", mock.Mock())
                patch("systemd_oauth_dropin", mock.Mock(return_value=b"TEST_ONLY\n"))
                patch("command", fake_command)
                stack.enter_context(mock.patch.object(
                    release.pwd, "getpwnam",
                    return_value=SimpleNamespace(pw_uid=9001, pw_gid=9002,
                                                 pw_dir="/nonexistent"),
                ))
                patch("save_private_release_receipt",
                      mock.Mock(side_effect=AssertionError(
                          "stage-only may not save production config"
                      )))
                with redirect_stdout(io.StringIO()) as output:
                    release.rollout(SHA, stage_only=True)
            self.assertIn("STAGE_ONLY=PASS", output.getvalue())
            self.assertIn("LIVE_SERVICE_STOPPED=NO", output.getvalue())
            self.assertEqual(release.current_release(backend), old_backend)
            self.assertEqual(release.current_release(static), old_static)
            self.assertFalse((backend / "releases" / SHA).exists())
            self.assertFalse((static / "releases" / SHA).exists())
            self.assertEqual(site.read_text(), "original")
            self.assertFalse(any(args[:2] == ["systemctl", "stop"]
                                 for args in calls))

    def test_stage_only_cli_never_calls_apply_branch(self):
        with mock.patch.object(release, "rollout") as rollout, \
             mock.patch.object(release, "preflight") as preflight, \
             mock.patch("sys.argv", [
                 "release", "--sha", SHA, "--stage-only",
             ]):
            self.assertEqual(release.main(), 0)
        rollout.assert_called_once_with(SHA, stage_only=True, backend_only=False)
        preflight.assert_not_called()

    def test_unexpected_runtime_prints_only_safe_category(self):
        for exc, expected in (
            (PermissionError("SECRET PII /root/private"), "OS_PERMISSION_DENIED"),
            (FileNotFoundError("SECRET PII"), "OS_FILE_NOT_FOUND"),
            (NotImplementedError("SECRET PII"), "UNSUPPORTED_OS_OPERATION"),
        ):
            with self.subTest(category=expected), \
                 mock.patch.object(release, "rollout", side_effect=exc), \
                 mock.patch("sys.argv", ["release", "--sha", SHA, "--apply"]), \
                 redirect_stdout(io.StringIO()) as output:
                self.assertEqual(release.main(), 1)
            printed = output.getvalue()
            self.assertIn("SAFE_EXCEPTION_CATEGORY=" + expected, printed)
            self.assertIn("SAFE_EXCEPTION_STAGE=UNKNOWN", printed)
            self.assertIn("SAFE_EXCEPTION_LINE=0", printed)
            self.assertIn("SAFE_ROLLOUT_LINE=0", printed)
            self.assertIn("RAW_EXCEPTION_PRINTED=NO", printed)
            self.assertIn("FAILURE_CODE=UNEXPECTED_RUNTIME", printed)
            self.assertNotIn("SECRET", printed)
            self.assertNotIn("/root", printed)

    def test_missing_subprocess_command_has_redacted_specific_function_and_line(self):
        missing = FileNotFoundError(
            2, "SENSITIVE private failure",
            "/hidden/secret/bin/test",
        )
        with mock.patch.object(release.subprocess, "run",
                               side_effect=missing):
            try:
                release.command(["test", "-x", "/staged/module"])
            except FileNotFoundError as exc:
                category, stage, line, caller, target = \
                    release.safe_runtime_diagnostics(exc)
            else:
                self.fail("Missing command was not detected")
        self.assertEqual(category, "OS_FILE_NOT_FOUND")
        self.assertEqual(stage, "COMMAND")
        self.assertGreater(line, 0)
        self.assertEqual(caller, 0)
        self.assertEqual(target, "COMMAND_TEST")
        self.assertNotIn("SENSITIVE", target)
        self.assertNotIn("secret", target)

    def test_staging_missing_resource_emits_exact_phase_without_downtime(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root)
            backend, static = base / "auth", base / "static"
            for folder in (backend, static):
                previous = folder / "releases" / "previous"
                previous.mkdir(parents=True)
                (folder / "current").symlink_to(previous)
            db = base / "sqlite.db"
            original = [
                "/usr/bin/python3", "-m", "uvicorn", "fh_email_auth.app:app",
                "--host", "127.0.0.1", "--port", "9141",
                "--no-access-log",
            ]
            safe_args = release.safe_uvicorn_argv(original, 9141)
            state = (
                backend / "releases" / "previous",
                static / "releases" / "previous",
                db, b"OFF=true", "old-caddy", "new-caddy", 9141,
                Path("/usr/bin/python3"), safe_args,
            )
            with ExitStack() as stack:
                def p(name, obj):
                    stack.enter_context(mock.patch.object(release, name, obj))
                p("BACKEND_ROOT", backend)
                p("STATIC_ROOT", static)
                p("preflight", mock.Mock(return_value=state))
                p("source_archive", mock.Mock(return_value=base))
                p("stage_backend", mock.Mock(side_effect=FileNotFoundError(
                    2, "secret-error", "/hidden/secret/filename"
                )))
                stop = mock.Mock(side_effect=AssertionError("service must stay alive"))
                p("command", stop)
                with redirect_stdout(io.StringIO()) as output:
                    try:
                        release.rollout(SHA, stage_only=True)
                    except FileNotFoundError as exc:
                        diagnosis = release.safe_runtime_diagnostics(exc)
                    else:
                        self.fail("Expected the missing staged backend to fail")
            self.assertIn("FAILED_STAGING_STEP=COPY_BACKEND", output.getvalue())
            self.assertIn("FAILED_STAGING_CLEANED=YES", output.getvalue())
            self.assertEqual(release.current_release(backend), state[0])
            self.assertEqual(release.current_release(static), state[1])
            stop.assert_not_called()
            self.assertEqual(diagnosis[0], "OS_FILE_NOT_FOUND")
            self.assertEqual(diagnosis[1], "ROLLOUT")
            self.assertGreater(diagnosis[2], 0)
            self.assertGreater(diagnosis[3], 0)
            self.assertEqual(diagnosis[4], "OTHER")

    def test_public_oauth_smoke_uses_verified_caddy_8444_and_pinned_ca(self):
        answer = b'{"enabled":true,"providers":["google","yandex","vk","telegram"]}\n200'
        with mock.patch.object(
            release, "verified_origin_ca", return_value=release.ORIGIN_CA
        ) as ca, mock.patch.object(
            release, "command", return_value=answer
        ) as transport:
            self.assertEqual(release.public_oauth_providers_over_verified_origin(),
                             answer.partition(b"\n")[0])
        ca.assert_called_once()
        args = transport.call_args.args[0]
        self.assertEqual(args[0], "/usr/bin/curl")
        self.assertEqual(args[args.index("--resolve") + 1],
                         "fin-horizon.mikemoore.top:8444:127.0.0.1")
        self.assertEqual(args[args.index("--cacert") + 1], str(release.ORIGIN_CA))
        self.assertEqual(args[-1],
                         "https://fin-horizon.mikemoore.top:8444/api/auth/providers")
        self.assertNotIn("--insecure", args)
        self.assertNotIn("-k", args)
        self.assertIn("--noproxy", args)
        self.assertEqual(transport.call_args.kwargs["failure_code"],
                         "PUBLIC_CADDY_HTTPS_FAILED")

    def test_public_oauth_rejects_http_error_and_tls_failure(self):
        with mock.patch.object(release, "verified_origin_ca",
                               return_value=release.ORIGIN_CA):
            for result in (
                b'{"enabled":true}\n403',
                b'{"enabled":true}\n302',
                b'{"enabled":true}',
                b'\n200',
            ):
                with self.subTest(result=result), mock.patch.object(
                    release, "command", return_value=result
                ), self.assertRaisesRegex(release.Gate,
                                          "PUBLIC_CADDY_HTTPS_STATUS"):
                    release.public_oauth_providers_over_verified_origin()
            with mock.patch.object(
                release, "command",
                side_effect=release.Gate("PUBLIC_CADDY_HTTPS_FAILED"),
            ), self.assertRaisesRegex(release.Gate, "PUBLIC_CADDY_HTTPS_FAILED"):
                release.public_oauth_providers_over_verified_origin()

    def test_cloudflare_origin_ca_untrusted_file_fails_closed(self):
        import hashlib
        import stat
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / "financial-horizon" / "certs" / "root.pem"
            file.parent.mkdir(parents=True)
            file.write_bytes(b"test-pinned-origin-ca")
            digest = hashlib.sha256(file.read_bytes()).hexdigest()
            directory = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
            regular = SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0,
                                      st_size=file.stat().st_size)
            def safe_metadata(path):
                return regular if path == file else directory
            with mock.patch.object(release, "ORIGIN_CA", file), \
                 mock.patch.object(release, "ORIGIN_CA_SHA256", digest), \
                 mock.patch.object(Path, "lstat", autospec=True,
                                   side_effect=safe_metadata):
                self.assertEqual(release.verified_origin_ca(), file)
                with mock.patch.object(release, "ORIGIN_CA_SHA256", "0" * 64), \
                     self.assertRaisesRegex(release.Gate, "ORIGIN_CA_HASH_MISMATCH"):
                    release.verified_origin_ca()
            unsafe = SimpleNamespace(st_mode=stat.S_IFREG | 0o666,
                                     st_uid=0, st_size=file.stat().st_size)
            def unsafe_metadata(path):
                return unsafe if path == file else directory
            # Do not apply autospec over an already-patched Path.lstat Mock.
            with mock.patch.object(release, "ORIGIN_CA", file), \
                 mock.patch.object(release, "ORIGIN_CA_SHA256", digest), \
                 mock.patch.object(Path, "lstat", autospec=True,
                                   side_effect=unsafe_metadata), \
                 self.assertRaisesRegex(release.Gate, "ORIGIN_CA_FILE_UNSAFE"):
                release.verified_origin_ca()

    def test_backend_only_static_must_match_verified_published_ui(self):
        import json
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / "source"
            active = base / "releases" / SHA
            for path in (source, active):
                path.mkdir(parents=True)
                (path / "assets/providers").mkdir(parents=True)
                for name in (
                    "account-oauth.js", "auth-ui.js",
                    "assets/providers/google.svg", "assets/providers/yandex.svg",
                    "assets/providers/vk.svg", "assets/providers/telegram.svg",
                    "index.html", "account.html", "sw.js", "manifest.webmanifest",
                ):
                    file = path / name
                    file.write_text("synthetic " + name, encoding="utf-8")
            (active / "__release.json").write_text(json.dumps({
                "repository": "MikeMoore1337/financial-horizon",
                "source_sha": SHA, "run_id": 12345,
            }))
            release.verify_predeployed_four_provider_ui(source, active)
            (active / "assets/providers/telegram.svg").write_text("tampered")
            with self.assertRaisesRegex(
                release.Gate, "ACTIVE_OAUTH_UI_SOURCE_MISMATCH"
            ):
                release.verify_predeployed_four_provider_ui(source, active)
            (active / "assets/providers/telegram.svg").write_text(
                "synthetic assets/providers/telegram.svg"
            )
            (active / "__release.json").write_text(json.dumps({
                "repository": "MikeMoore1337/financial-horizon",
                "source_sha": "f" * 40, "run_id": 12345,
            }))
            with self.assertRaisesRegex(
                release.Gate, "ACTIVE_STATIC_MANIFEST_MISMATCH"
            ):
                release.verify_predeployed_four_provider_ui(source, active)

    def test_backend_only_stage_only_cannot_replace_live_static_pwa(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            backend, static = base / "auth", base / "static"
            for folder in (backend, static):
                (folder / "releases").mkdir(parents=True)
            old_backend = backend / "releases" / "previous"
            old_static = static / "releases" / "previous"
            old_backend.mkdir()
            old_static.mkdir()
            (backend / "current").symlink_to(old_backend)
            (static / "current").symlink_to(old_static)
            site = base / "site.caddy"
            site.write_text("unchanged")
            db = base / "auth.sqlite3"
            source = base / "source"
            source.mkdir()
            old_env = b"TEST_ENV_DISABLED=true\n"
            args = [
                "/usr/bin/python3", "-m", "uvicorn", "fh_email_auth.app:app",
                "--host", "127.0.0.1", "--port", "9141", "--no-access-log",
            ]
            approved = release.safe_uvicorn_argv(args, 9141)
            preflight = (old_backend, old_static, db, old_env, "unchanged",
                         "new", 9141, Path("/usr/bin/python3"), approved)
            verify = mock.Mock()
            def fake_backend(src, sha, existing):
                candidate = backend / "releases" / sha
                (candidate / ".oauth-venv/bin").mkdir(parents=True)
                (candidate / ".oauth-venv/bin/python").write_text("synthetic")
                (candidate / "backend").mkdir()
                return candidate
            def fake_command(command, **kwargs):
                if command[:4] == ["systemctl", "show", "--value", "-p"]:
                    return b"fh-email-auth\n"
                if command[:2] == ["systemctl", "stop"]:
                    raise AssertionError("No downtime in stage-only")
                return b""
            with ExitStack() as stack:
                def patch(name, value):
                    return stack.enter_context(mock.patch.object(release, name, value))
                patch("BACKEND_ROOT", backend)
                patch("STATIC_ROOT", static)
                patch("CADDY_SITE", site)
                patch("OAUTH_ENV", base / "oauth.env")
                patch("preflight", mock.Mock(return_value=preflight))
                patch("source_archive", mock.Mock(return_value=source))
                patch("verify_predeployed_four_provider_ui", verify)
                patch("stage_backend", fake_backend)
                patch("stage_static", mock.Mock(
                    side_effect=AssertionError("Do not build/redeploy static")))
                patch("stage_isolated_python",
                      mock.Mock(return_value=str(base / "synthetic-site")))
                patch("running_process", mock.Mock(return_value=(
                    123, args, {"FH_AUTH_DATABASE_PATH": str(db)}
                )))
                patch("staged_modules_root", lambda value: value / "backend")
                patch("private_file", lambda value: old_env)
                patch("verify_service_user_module_access", mock.Mock())
                patch("systemd_oauth_dropin", mock.Mock(return_value=b"TEST_ONLY"))
                patch("command", fake_command)
                patch("switch_release", mock.Mock(
                    side_effect=AssertionError("No live release switch")))
                stack.enter_context(mock.patch.object(
                    release.pwd, "getpwnam",
                    return_value=SimpleNamespace(pw_uid=9001, pw_gid=9002)
                ))
                with redirect_stdout(io.StringIO()) as output:
                    release.rollout(SHA, stage_only=True, backend_only=True)
            verify.assert_called_once_with(source, old_static)
            self.assertIn("STAGE_ONLY=PASS", output.getvalue())
            self.assertEqual(release.current_release(backend), old_backend)
            self.assertEqual(release.current_release(static), old_static)
            self.assertFalse((backend / "releases" / SHA).exists())
            self.assertFalse((static / "releases" / SHA).exists())
            self.assertEqual(site.read_text(), "unchanged")

    def test_backend_only_cli_is_explicit_and_cannot_be_standalone(self):
        with mock.patch.object(release, "rollout") as run, \
             mock.patch("sys.argv", [
                 "release", "--sha", SHA, "--backend-only", "--stage-only",
             ]):
            self.assertEqual(release.main(), 0)
        run.assert_called_once_with(SHA, stage_only=True, backend_only=True)
        with mock.patch("sys.argv", ["release", "--sha", SHA,
                                     "--backend-only"]), \
             redirect_stdout(io.StringIO()) as output:
            self.assertEqual(release.main(), 1)
        self.assertIn("BACKEND_ONLY_ACTION_REQUIRED", output.getvalue())

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
