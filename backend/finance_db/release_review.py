"""Fail-closed reviewer gate for finance PostgreSQL production deploy.

Comments do not resolve prior CHANGES_REQUESTED. Only a later formal
APPROVED, CHANGES_REQUESTED, or DISMISSED changes a reviewer's decision.
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping

TRUSTED_ASSOCIATIONS = frozenset({"COLLABORATOR", "MEMBER", "OWNER"})
DECISIONS = frozenset({"APPROVED", "CHANGES_REQUESTED", "DISMISSED"})


def independent_review_gate(
    reviews: Iterable[Mapping[str, Any]],
    *,
    reviewed_head: str,
    author_login: str = "MikeMoore1337",
) -> str | None:
    """Return a rejection reason, or None only when an independent review passes."""
    latest: dict[str, Mapping[str, Any]] = {}
    # GitHub reviews are normally chronological; sort defensively so a
    # COMMENTED response cannot move or hide the last binding decision.
    for item in sorted(
        reviews,
        key=lambda r: (str(r.get("submitted_at") or ""), int(r.get("id") or 0)),
    ):
        author = item.get("user") or {}
        username = author.get("login") or ""
        if (
            not username
            or username == author_login
            or author.get("type") == "Bot"
            or username.endswith("[bot]")
            or item.get("author_association") not in TRUSTED_ASSOCIATIONS
        ):
            continue
        if item.get("state") in DECISIONS:
            latest[username] = item

    if any(r.get("state") == "CHANGES_REQUESTED" for r in latest.values()):
        return "An independent reviewer still requests changes"
    if not any(
        r.get("state") == "APPROVED" and r.get("commit_id") == reviewed_head
        for r in latest.values()
    ):
        return "No independent APPROVED review for the exact financial PR HEAD"
    return None
