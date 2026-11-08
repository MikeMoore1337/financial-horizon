"""Synthetic-only tests. Mock HTTP is NOT #67 integration or production evidence."""
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
import json
import os
from threading import Lock, Thread
import unittest
from unittest.mock import patch

import api_load
import postgres_contention


class FakeAPI(BaseHTTPRequestHandler):
    revision = {"A": 1, "B": 1}
    receipts = {}
    lock = Lock()

    def log_message(self, *_args):
        pass

    def _user(self):
        cookie = self.headers.get("Cookie", "")
        return "A" if "A" * 32 in cookie else "B" if "B" * 32 in cookie else None

    def _answer(self, status, body):
        content = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "private, no-store")
        if body.get("revision") is not None:
            self.send_header("ETag", f'"test.{body["revision"]}"')
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        user = self._user()
        if user is None:
            return self._answer(401, {"code": "expired"})
        self._answer(200, {"revision": self.revision[user], "entities": []})

    def do_POST(self):
        user = self._user()
        if user is None:
            return self._answer(401, {"code": "expired"})
        command = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with self.lock:
            key = command["client_mutation_id"]
            if key in self.receipts:
                ack = {**self.receipts[key], "replayed": True}
                return self._answer(200, ack)
            if self.headers.get("If-Match") != f'"test.{self.revision[user]}"':
                return self._answer(412, {"code": "stale_revision"})
            self.revision[user] += 1
            ack = {"client_mutation_id": key, "revision": self.revision[user],
                   "replayed": False, "changes": []}
            self.receipts[key] = ack
            self._answer(201, ack)


class ApiLoadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        FakeAPI.revision, FakeAPI.receipts = {"A": 1, "B": 1}, {}
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeAPI)
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)

    def test_replay_and_stale_revision_and_two_users(self):
        report = api_load.check_replay(self.url, "A" * 32, "B" * 32, 2)
        self.assertEqual(report["gate"], "PASS")
        self.assertEqual(report["stale_precondition_status"], 412)
        self.assertTrue(report["other_user_unchanged"])

    def test_read_two_users(self):
        report = api_load.check_read(self.url, "A" * 32, "B" * 32, 2, 4, 12, 0)
        self.assertEqual(report["gate"], "PASS")
        self.assertEqual(report["requests"], 12)
        self.assertGreater(report["throughput_rps"], 0)

    def test_expired_session_unauthorized(self):
        with patch.dict(os.environ, {"FH45_EXPIRED_SESSION": "Z" * 32}):
            self.assertEqual(api_load.check_expiry(self.url, 2)["gate"], "PASS")

    def test_reject_external_targets_and_unsafe_limits(self):
        for url in ("https://example.com", "http://example.com:8080", "http://127.0.0.1:80/foo",
                    "http://user:pass@127.0.0.1:1234", "http://127.0.0.1:80?secret=yes"):
            with self.assertRaises(api_load.GateError):
                api_load.local_origin(url)
        output = StringIO()
        with contextlib.redirect_stdout(output):
            code = api_load.main(["--origin", "http://127.0.0.1:8000", "--requests", "10000"])
        self.assertEqual(code, 2)
        self.assertIn("BOUNDED_LIMITS_REQUIRED", output.getvalue())

    def test_no_credentials_in_output(self):
        capture = StringIO()
        with patch.dict(os.environ, {"FH45_SESSION_A": "A" * 32, "FH45_SESSION_B": "B" * 32}):
            with contextlib.redirect_stdout(capture):
                result = api_load.main(["--origin", self.url, "--requests", "4", "--pause-ms", "0"])
        self.assertEqual(result, 0)
        self.assertNotIn("A" * 32, capture.getvalue())
        self.assertNotIn("B" * 32, capture.getvalue())

    def test_statistical_percentiles(self):
        self.assertEqual(api_load.percentile([1, 2, 3, 4, 5], 95), 5)
        self.assertIsNone(api_load.percentile([], 95))

    def test_postgres_rejects_real_database(self):
        for dsn in ("postgresql://localhost/finance", "postgresql://db/fh_ops45_test",
                    "postgresql://localhost/fh_finance", "postgresql://localhost/postgres"):
            with self.assertRaises(postgres_contention.GateError):
                postgres_contention.assert_isolated_dsn(dsn)
        postgres_contention.assert_isolated_dsn("postgresql://localhost/fh_ops45_ci")


if __name__ == "__main__":
    unittest.main()
