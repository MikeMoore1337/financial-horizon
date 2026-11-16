"""Static gates for automatic production deployment after real browser CI."""
from pathlib import Path
import re
import unittest

WORKFLOW = (
    Path(__file__).resolve().parents[2]
    / ".github/workflows/production-deploy.yml"
)

class AutomaticDeployGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")
        cls.build, cls.deploy = cls.text.split("\n  deploy:\n", maxsplit=1)

    def test_auto_deploy_requires_explicit_repository_flag(self):
        self.assertIn("vars.FH_STATIC_AUTO_DEPLOY_ENABLED == 'true'", self.build)
        self.assertIn("github.event_name == 'workflow_dispatch'", self.build)
        self.assertIn("if: needs.build.result == 'success'", self.deploy)
        self.assertIn("name: production-static", self.deploy)

    def test_waits_for_long_running_exact_sha_browser_ci(self):
        timeout = re.search(r"(?m)^    timeout-minutes: (\d+)$", self.build)
        self.assertIsNotNone(timeout)
        self.assertGreaterEqual(int(timeout.group(1)), 45)
        attempts = re.search(r"for attempt in \$\(seq 1 (\d+)\)", self.build)
        self.assertIsNotNone(attempts)
        self.assertGreaterEqual(int(attempts.group(1)), 250)
        self.assertIn('[[ "$attempt" == 270 ]] || sleep 8', self.build)
        self.assertIn("head_sha=$TARGET_SHA", self.build)
        for workflow in ("tests.yml", "security-vault.yml"):
            self.assertIn(workflow, self.build)

    def test_stale_commit_or_failed_ci_cannot_deploy(self):
        self.assertIn("Superseded main", self.build)
        self.assertIn("workflow not green for exact SHA", self.build)
        self.assertIn("if [[ \"$status\" == failure", self.build)
        self.assertIn("Main superseded release", self.deploy)
        self.assertIn('StrictHostKeyChecking=yes', self.deploy)
        self.assertIn('grep -Fxq "PRODUCTION_DEPLOYED=$TARGET_SHA"', self.deploy)


if __name__ == "__main__":
    unittest.main()
