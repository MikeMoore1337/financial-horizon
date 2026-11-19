"""Fail-closed CI coverage for the production public-smoke workflow script."""
import ast
from html.parser import HTMLParser
import json
from pathlib import Path
import re
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


def get_edge_html_guard():
    """Exercise the actual embedded no-checkout release verification function."""
    _, source = public_smoke_source()
    tree = ast.parse(source)
    functions = [
        item
        for item in tree.body
        if isinstance(item, ast.FunctionDef) and item.name == "matches_cloudflare_html"
    ]
    if len(functions) != 1:
        raise AssertionError("Expected one strict public HTML transformation validator")
    scope = {"HTMLParser": HTMLParser, "json": json, "re": re}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(WORKFLOW), "exec"), scope)
    return scope["matches_cloudflare_html"]


def synthetic_beacon() -> bytes:
    payload = json.dumps(
        {"version": "2024.11.0", "token": "a" * 32, "r": 1, "spa": True},
        separators=(",", ":"),
    )
    return (
        '<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/v'
        + "c" * 44
        + '" integrity="sha512-'
        + "A" * 88
        + '" data-cf-beacon=\''
        + payload
        + '\' crossorigin="anonymous"></script>'
    ).encode()


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

    def test_known_edge_beacon_only_preserves_the_complete_original_html(self) -> None:
        guard = get_edge_html_guard()
        html = b"<!doctype html><html><body><p>Financial Horizon</p></body></html>\n"
        injected = html.replace(b"</body>", synthetic_beacon() + b"</body>")
        self.assertTrue(guard(html, html))
        self.assertTrue(guard(html, injected))
        self.assertFalse(guard(html, injected.replace(b"cloudflareinsights.com", b"evil.example")))
        self.assertFalse(guard(html, injected.replace(b"crossorigin=", b"onload=")))
        self.assertFalse(guard(html, injected.replace(b"token", b"other")))
        self.assertFalse(guard(html, injected.replace(b"<script ", b"<script nonce='unsafe' ", 1)))
        self.assertFalse(guard(html, injected.replace(b"</script>", b"</script><img src=x>")))
        self.assertFalse(guard(html, injected + b"<script>alert(1)</script>"))
        self.assertFalse(guard(html, injected.replace(b"<p>", b"<pre>")))

    def test_public_html_whitelist_never_skips_all_other_asset_hash_checks(self) -> None:
        _job, source = public_smoke_source()
        self.assertIn('if name not in {"index.html", "account.html"}:', source)
        self.assertIn('hashlib.sha256(public_data).digest()', source)
        self.assertIn('headers.get("CF-Cache-Status") != "DYNAMIC"', source)
        self.assertIn('"static.cloudflareinsights.com" in csp', source)
        self.assertIn('PUBLIC_HTML_EDGE_NORMALIZED=', source)


if __name__ == "__main__":
    unittest.main()
