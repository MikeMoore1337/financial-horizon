"""Static regression gates for the manual, no-write SSH transport preflight."""
import unittest
from pathlib import Path

WORKFLOW = (
    Path(__file__).resolve().parents[2]
    / ".github/workflows/fh-static-ssh-preflight.yml"
)


class SshTransportWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_manual_main_only_and_scoped_secrets(self):
        text = self.workflow
        self.assertIn("  workflow_dispatch:", text)
        self.assertIn("github.ref == 'refs/heads/main'", text)
        self.assertIn("name: production-static", text)
        for key in (
            "FH_DEPLOY_KEY", "FH_DEPLOY_PORT",
            "FH_DEPLOY_TARGET", "FH_DEPLOY_KNOWN_HOSTS",
        ):
            self.assertIn("secrets." + key, text)
        self.assertNotIn("  pull_request:", text)
        self.assertNotIn("  push:", text)
        self.assertIn("permissions: {}", text)

    def test_only_forced_command_denial_is_accepted(self):
        text = self.workflow
        self.assertIn("StrictHostKeyChecking=yes", text)
        self.assertIn("UserKnownHostsFile=$hosts", text)
        self.assertIn("HostKeyAlgorithms=ssh-ed25519", text)
        self.assertIn("HOST_KEY_FINGERPRINT_MISMATCH", text)
        self.assertIn("FH_DEPLOY_FAILED=COMMAND_REJECTED", text)
        self.assertIn("SSH_FORCED_COMMAND_DENIAL=PASS", text)
        self.assertIn("PRODUCTION_DEPLOY_PERFORMED=NO", text)

    def test_cannot_deploy_or_execute_repository_source(self):
        text = self.workflow
        for forbidden in (
            "actions/checkout", "actions/download-artifact",
            "actions/upload-artifact", "git clone", "curl -k",
            "--insecure", "systemctl restart", "sudo -n",
            "deploy $TARGET_SHA", "npm ci", "npm run build",
        ):
            self.assertNotIn(forbidden, text)
        self.assertIn("'whoami'", text)


if __name__ == "__main__":
    unittest.main()
