"""Security regression tests for the independent GitHub review release gate."""
from backend.finance_db.release_review import independent_review_gate

HEAD = "a" * 40
OLD = "b" * 40


def review(user, state, *, sha=HEAD, order=1, association="COLLABORATOR", user_type="User"):
    return {
        "id": order,
        "submitted_at": f"2026-11-07T11:{order:02d}:00Z",
        "user": {"login": user, "type": user_type},
        "author_association": association,
        "state": state,
        "commit_id": sha,
    }


def test_rejects_requested_changes_even_after_comment_and_other_approval():
    rows = [
        review("reviewer1", "CHANGES_REQUESTED", order=1),
        review("reviewer2", "APPROVED", order=2),
        review("reviewer1", "COMMENTED", order=3),
    ]
    assert "requests changes" in independent_review_gate(rows, reviewed_head=HEAD)


def test_approval_by_same_reviewer_resolves_requested_changes():
    rows = [
        review("reviewer1", "CHANGES_REQUESTED", order=1),
        review("reviewer1", "APPROVED", order=2),
    ]
    assert independent_review_gate(rows, reviewed_head=HEAD) is None


def test_comment_after_approval_does_not_revoke_it():
    rows = [review("reviewer1", "APPROVED", order=1), review("reviewer1", "COMMENTED", order=2)]
    assert independent_review_gate(rows, reviewed_head=HEAD) is None


def test_dismissal_revokes_existing_approval():
    rows = [review("reviewer1", "APPROVED", order=1), review("reviewer1", "DISMISSED", order=2)]
    assert "No independent APPROVED" in independent_review_gate(rows, reviewed_head=HEAD)


def test_wrong_commit_approval_is_not_accepted():
    assert "No independent APPROVED" in independent_review_gate(
        [review("reviewer1", "APPROVED", sha=OLD)], reviewed_head=HEAD
    )


def test_rejects_approval_from_owner_bot_and_outsider():
    rows = [
        review("MikeMoore1337", "APPROVED", order=1, association="OWNER"),
        review("security[bot]", "APPROVED", order=2, user_type="Bot"),
        review("untrusted", "APPROVED", order=3, association="NONE"),
    ]
    assert "No independent APPROVED" in independent_review_gate(rows, reviewed_head=HEAD)


def test_input_order_cannot_hide_prior_requested_changes():
    rows = [
        review("reviewer1", "COMMENTED", order=3),
        review("reviewer1", "CHANGES_REQUESTED", order=1),
        review("reviewer2", "APPROVED", order=2),
    ]
    assert "requests changes" in independent_review_gate(rows, reviewed_head=HEAD)
