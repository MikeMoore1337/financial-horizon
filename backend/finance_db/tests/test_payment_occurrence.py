from datetime import date

import pytest

from backend.finance_db.ledger_service import _is_obligation_occurrence


@pytest.mark.parametrize("starts,unit,every,occurrence,valid", [
    ("2024-01-31", "month", 1, "2024-02-29", True),
    ("2023-01-31", "month", 1, "2023-02-28", True),
    ("2024-01-31", "month", 1, "2024-03-31", True),
    ("2024-01-31", "month", 1, "2024-03-29", False),
    ("2024-12-30", "month", 1, "2025-01-30", True),
    ("2024-02-29", "year", 1, "2025-02-28", True),
    ("2024-02-29", "year", 1, "2028-02-29", True),
    ("2024-02-29", "year", 1, "2025-03-01", False),
    ("2024-01-31", "month", 2, "2024-02-29", False),
    ("2024-01-31", "none", 1, "2024-01-31", True),
    ("2024-01-31", "none", 1, "2025-01-31", False),
])
def test_anchored_occurrence(starts, unit, every, occurrence, valid):
    assert _is_obligation_occurrence(
        date.fromisoformat(starts), unit, every, date.fromisoformat(occurrence),
    ) is valid
