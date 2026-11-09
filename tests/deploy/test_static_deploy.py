"""No-network, no-root, synthetic integration tests for the privileged deploy core."""
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

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

    def test_denies_nonstandard_ssh_commands(self):
        valid = 'deploy ' + SHA + ' ' + ('f' * 64)
        self.assertEqual(cd.parse_command(valid), (SHA, 'f' * 64))
        for invalid in ('', 'status', valid + ' && id', 'deploy ' + SHA, valid + '\nwhoami'):
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(cd.DeployFailure, 'COMMAND_REJECTED'):
                    cd.parse_command(invalid)


if __name__ == '__main__':
    unittest.main()
