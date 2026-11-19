"""Fail-closed CI coverage for the production public-smoke workflow script."""
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "production-deploy.yml"


def public_smoke_source() -> tuple[str, str]:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    if workflow.count("  public-smoke:\n") != 1:
        raise AssertionError("Public smoke job missing or duplicated")
    job = workflow.split("  public-smoke:\n", 1)[1]
    marker = "          python3 - <<'PY'\n"
    if job.count(marker) != 1 or job.count("\n          PY\n") != 1:
        raise AssertionError("Public smoke Python here-document missing or duplicated")
    body = job.split(marker, 1)[1].split("\n          PY\n", 1)[0]
    lines = body.splitlines()
    if not lines or any(line.strip() and not line.startswith("          ") for line in lines):
        raise AssertionError("Public smoke Python block indentation invalid")
    source = "\n".join(line[10:] if line.startswith("          ") else "" for line in lines)
    return job, source


class TestProductionPublicSmoke(unittest.TestCase):
    def test_python_heredoc_compiles(self) -> None:
        _job, source = public_smoke_source()
        compile(source, str(WORKFLOW), "exec")

    def test_no_untrusted_checkout_or_cache_and_exact_public_manifest(self) -> None:
        job, source = public_smoke_source()
        self.assertNotIn("actions/checkout@", job)
        self.assertNotIn("actions/setup-node@", job)
        self.assertNotIn("npm ci", job)
        self.assertIn('get("/__release.json")', source)
        self.assertIn('archive_manifest.get("source_sha") != sha', source)
        self.assertIn('public_manifest) != archive_manifest', source)
        self.assertIn('hashlib.sha256(public_data)', source)
        self.assertIn('auth.get("email_only") is not True', source)

    def test_main_exact_sha_and_required_workflows_remain_mandatory(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn('[[ "$GITHUB_REF" == refs/heads/main ]]', workflow)
        self.assertIn("for workflow in tests.yml security-vault.yml", workflow)
        self.assertIn('[[ "$latest" == "$TARGET_SHA" ]]', workflow)
        self.assertIn("PRODUCTION_DEPLOYED=$TARGET_SHA", workflow)


if __name__ == "__main__":
    unittest.main()
