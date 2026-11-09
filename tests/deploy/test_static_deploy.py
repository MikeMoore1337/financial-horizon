"""No-network, no-root, synthetic integration tests for the privileged deploy core."""
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest import mock
import subprocess
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'deploy'))
import fh_static_deploy as cd  # noqa: E402

SHA = 'a' * 40
OTHER = 'b' * 40
REQUIRED = {
    'index.html': b'<html>new version</html>',
    'account.html': b'<html>account</html>',
    'sw.js': b'// sw',
    'manifest.webmanifest': b'{}',
    '__release.json': json.dumps({
        'repository': cd.REPO, 'source_sha': SHA, 'run_id': 12345,
    }).encode(),
}


def archive(files=None, *, extra=None):
    files = dict(REQUIRED if files is None else files)
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w:gz') as tar:
        root = tarfile.TarInfo('dist')
        root.type = tarfile.DIRTYPE
        tar.addfile(root)
        for name, content in files.items():
            entry = tarfile.TarInfo('dist/' + name)
            entry.size = len(content)
            tar.addfile(entry, io.BytesIO(content))
        if extra is not None:
            tar.addfile(*extra)
    payload = data.getvalue()
    return payload, hashlib.sha256(payload).hexdigest()


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'www'
        self.releases = self.root / 'releases'
        self.releases.mkdir(parents=True)
        self.old = self.releases / OTHER
        self.old.mkdir()
        (self.old / 'index.html').write_text('original')
        (self.root / 'current').symlink_to(self.old)
        self.state = Path(self.tmp.name) / 'state'
        self.state.mkdir()

    def test_deploy_and_second_deploy_idempotent(self):
        data, digest = archive()
        seen = []
        health = seen.append
        result = cd.deploy(data, SHA, digest, self.root, self.state, health)
        self.assertEqual(result, 'PRODUCTION_DEPLOYED=' + SHA)
        self.assertEqual(seen, [SHA])
        self.assertEqual(cd.current_release(self.root), self.releases / SHA)
        self.assertEqual((self.releases / SHA / 'index.html').read_bytes(), REQUIRED['index.html'])
        self.assertEqual((self.state / 'last-success.sha').read_text().strip(), SHA)
        self.assertEqual(cd.deploy(data, SHA, digest, self.root, self.state, health),
                         'ALREADY_DEPLOYED=' + SHA)
        self.assertEqual(seen, [SHA, SHA])

    def test_failed_health_rolls_back_and_does_not_touch_old_files(self):
        data, digest = archive()

        def fail(_):
            raise cd.DeployFailure('HEALTH_FAILED')

        with self.assertRaisesRegex(cd.DeployFailure, 'HEALTH_FAILED'):
            cd.deploy(data, SHA, digest, self.root, self.state, fail)
        self.assertEqual(cd.current_release(self.root), self.old)
        self.assertEqual((self.old / 'index.html').read_text(), 'original')
        self.assertFalse((self.releases / SHA).exists())
        self.assertFalse((self.state / 'last-success.sha').exists())

    def test_invalid_digest_fails_before_modification(self):
        data, _ = archive()
        with self.assertRaisesRegex(cd.DeployFailure, 'ARCHIVE_HASH_MISMATCH'):
            cd.deploy(data, SHA, '0' * 64, self.root, self.state, lambda _: None)
        self.assertEqual(cd.current_release(self.root), self.old)

    def test_invalid_or_missing_manifest_rejected(self):
        for files in (
            {'index.html': b'hello'},
            {**REQUIRED, '__release.json': b'{}'},
            {**REQUIRED, '__release.json': b'{bad json'},
            {**REQUIRED, '__release.json': json.dumps({
                'repository': cd.REPO, 'source_sha': SHA, 'run_id': True,
            }).encode()},
        ):
            with self.subTest(files=files.get('__release.json')):
                data, digest = archive(files)
                with self.assertRaises(cd.DeployFailure):
                    cd.deploy(data, SHA, digest, self.root, self.state, lambda _: None)
                self.assertEqual(cd.current_release(self.root), self.old)

    def test_archive_traversal_and_tar_link_rejected(self):
        link = tarfile.TarInfo('dist/link')
        link.type = tarfile.SYMTYPE
        link.linkname = '../../etc/passwd'
        data, digest = archive(extra=(link, None))
        with self.assertRaisesRegex(cd.DeployFailure, 'ARCHIVE_UNSAFE_ENTRY'):
            cd.deploy(data, SHA, digest, self.root, self.state, lambda _: None)
        for bad in ('../evil', 'safe/../../evil', '.env', 'safe//x', 'safe\\x'):
            with self.subTest(path=bad):
                data, digest = archive({**REQUIRED, bad: b'hack'})
                with self.assertRaisesRegex(cd.DeployFailure, 'ARCHIVE_PATH_REJECTED'):
                    cd.deploy(data, SHA, digest, self.root, self.state, lambda _: None)

    def test_duplicate_tar_member_rejected(self):
        entry = tarfile.TarInfo('dist/index.html')
        entry.size = 4
        data, digest = archive(extra=(entry, io.BytesIO(b'hack')))
        with self.assertRaisesRegex(cd.DeployFailure, 'ARCHIVE_DUPLICATE_PATH'):
            cd.deploy(data, SHA, digest, self.root, self.state, lambda _: None)

    def test_non_release_symlink_refused(self):
        (self.root / 'current').unlink()
        (self.root / 'current').symlink_to(self.root)
        with self.assertRaisesRegex(cd.DeployFailure, 'RELEASE_LINK_OUTSIDE_ROOT'):
            cd.current_release(self.root)

    def test_origin_ca_trust_anchor_hash_and_symlink_guards(self):
        # Synthetic trust data; CI runner need not run as root.
        anchor = Path(self.tmp.name) / 'ca'
        anchor.mkdir()
        directory = anchor / 'certs'
        directory.mkdir()
        certificate = directory / 'cloudflare.pem'
        certificate.write_bytes(b'synthetic ca fixture')
        original_lstat = Path.lstat

        def root_owned(path):
            stat_result = original_lstat(path)
            return SimpleNamespace(
                st_mode=stat_result.st_mode,
                st_uid=0,
                st_size=stat_result.st_size,
            )

        with (
            mock.patch.object(cd, 'ORIGIN_CA', certificate),
            mock.patch.object(cd, 'ORIGIN_CA_SHA256',
                              hashlib.sha256(certificate.read_bytes()).hexdigest()),
            mock.patch.object(Path, 'lstat', root_owned),
        ):
            cd.verify_origin_ca()
            certificate.write_bytes(b'modified trust anchor')
            with self.assertRaisesRegex(cd.DeployFailure, 'ORIGIN_CA_HASH_MISMATCH'):
                cd.verify_origin_ca()
            certificate.unlink()
            certificate.symlink_to(directory / 'missing.pem')
            with self.assertRaisesRegex(cd.DeployFailure, 'ORIGIN_CA_FILE_UNSAFE'):
                cd.verify_origin_ca()

    def test_caddy_origin_https_has_ca_validation_and_correct_port(self):
        calls = []

        def run(args, **kwargs):
            calls.append(args)
            if args[0] == '/usr/bin/curl':
                if '__release.json' in args[-1]:
                    payload = json.dumps({
                        'repository': cd.REPO, 'source_sha': SHA, 'run_id': 1,
                    }).encode()
                else:
                    payload = b'nonempty static asset'
                return subprocess.CompletedProcess(args, 0, payload + b'\n200', b'')
            return subprocess.CompletedProcess(args, 0, b'', b'')

        with (
            mock.patch.object(cd, 'verify_origin_ca') as verified,
            mock.patch.object(cd.subprocess, 'run', side_effect=run),
        ):
            cd.probe_release(SHA)
        verified.assert_called_once_with()
        curls = [args for args in calls if args[0] == '/usr/bin/curl']
        self.assertEqual(len(curls), 5)
        for args in curls:
            self.assertIn('--cacert', args)
            self.assertEqual(args[args.index('--cacert')+1], str(cd.ORIGIN_CA))
            self.assertIn('--resolve', args)
            self.assertEqual(args[args.index('--resolve')+1],
                             f'{cd.HOST}:{cd.ORIGIN_PORT}:127.0.0.1')
            self.assertTrue(args[-1].startswith(f'https://{cd.HOST}:8444/'))
            self.assertNotIn('--insecure', args)
            self.assertNotIn('-k', args)

    def test_origin_tls_error_does_not_pass_smoke(self):
        with (
            mock.patch.object(cd, 'verify_origin_ca'),
            mock.patch.object(cd.subprocess, 'run', return_value=(
                subprocess.CompletedProcess(['/usr/bin/curl'], 60, b'', b'certificate error')
            )),
        ):
            with self.assertRaisesRegex(cd.DeployFailure, 'HTTPS_SMOKE_FAILED'):
                cd.probe_release(SHA)

    def test_origin_redirect_does_not_pass_smoke(self):
        with (
            mock.patch.object(cd, 'verify_origin_ca'),
            mock.patch.object(cd.subprocess, 'run', return_value=(
                subprocess.CompletedProcess(
                    ['/usr/bin/curl'], 0, b'<html>redirect</html>\n302', b''
                )
            )),
        ):
            with self.assertRaisesRegex(cd.DeployFailure, 'HTTPS_SMOKE_STATUS'):
                cd.probe_release(SHA)

    def test_denies_nonstandard_ssh_commands(self):
        valid = 'deploy ' + SHA + ' ' + ('f' * 64)
        self.assertEqual(cd.parse_command(valid), (SHA, 'f' * 64))
        for invalid in ('', 'status', valid + ' && id', 'deploy ' + SHA, valid + '\nwhoami'):
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(cd.DeployFailure, 'COMMAND_REJECTED'):
                    cd.parse_command(invalid)


if __name__ == '__main__':
    unittest.main()
