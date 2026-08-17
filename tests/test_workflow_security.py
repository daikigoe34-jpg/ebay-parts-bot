from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
SHA_PIN = re.compile(r"^\s*uses:\s*[^@\s]+@[0-9a-f]{40}\s*$", re.MULTILINE)
USES_LINE = re.compile(r"^\s*uses:\s*\S+\s*$", re.MULTILINE)
PUBLIC_SECRET_PATTERNS = (
    re.compile(r"\$\{\{\s*secrets\.", re.IGNORECASE),
    re.compile(r"\$\{\{\s*github\.token\s*\}\}", re.IGNORECASE),
    re.compile(r"authorization\s*[:=]\s*['\"]?(?:bearer|basic)\s+[A-Za-z0-9._+/=-]{12,}", re.IGNORECASE),
    re.compile(r"(?:EBAY_CLIENT_SECRET|RAKUTEN_ACCESS_KEY|GH_TOKEN)\s*[:=]\s*['\"][^'\"]{8,}['\"]", re.IGNORECASE),
)


def test_all_external_actions_are_pinned_to_full_commit_sha() -> None:
    for path in sorted(WORKFLOWS.glob("*.yml")):
        text = path.read_text(encoding="utf-8")
        uses = USES_LINE.findall(text)
        assert uses, f"{path.name} has no actions to validate"
        pinned = SHA_PIN.findall(text)
        assert len(pinned) == len(uses), f"{path.name} contains a mutable Action ref"


def test_verification_ci_is_read_only_and_does_not_persist_checkout_credentials() -> None:
    text = (WORKFLOWS / "ci-zero-tap.yml").read_text(encoding="utf-8")
    assert "contents: read" in text
    assert "contents: write" not in text
    assert "persist-credentials: false" in text


def test_api_secrets_are_scoped_only_to_the_research_step() -> None:
    text = (WORKFLOWS / "research.yml").read_text(encoding="utf-8")
    step_marker = "- name: Production Browse API・楽天・為替を自動調査"
    assert step_marker in text
    before, after = text.split(step_marker, 1)
    assert "secrets.EBAY_CLIENT_ID" not in before
    assert "secrets.EBAY_CLIENT_SECRET" not in before
    assert "secrets.RAKUTEN_APPLICATION_ID" not in before
    assert "secrets.RAKUTEN_ACCESS_KEY" not in before
    assert "secrets.EBAY_CLIENT_ID" in after
    assert "secrets.EBAY_CLIENT_SECRET" in after
    assert "persist-credentials: false" in text


def test_public_web_assets_do_not_contain_secret_values_or_secret_expressions() -> None:
    for path in (ROOT / "web").rglob("*"):
        if not path.is_file() or path.suffix.lower() not in {".js", ".html", ".json", ".css", ".webmanifest"}:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for pattern in PUBLIC_SECRET_PATTERNS:
            assert not pattern.search(text), (
                f"possible secret value/expression leaked into public asset {path.relative_to(ROOT)}: {pattern.pattern}"
            )


def test_python_dependencies_are_exactly_pinned() -> None:
    lines = [
        line.strip()
        for line in (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    assert lines
    assert all(re.fullmatch(r"[A-Za-z0-9_.-]+==[^=<>!~\s]+", line) for line in lines)
