"""#70: optional personal finance runtime never enables itself via default auth.

Only synthetic/CI settings; no real production URLs, accounts or secrets.
"""
from __future__ import annotations

from uuid import UUID

import pytest

from backend.fh_email_auth.app import _personal_finance_runtime_options


NAMESPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
FAKE_POSTGRES = "postgresql+psycopg://fh_finance_runtime:synthetic@127.0.0.1:54329/fh_finance_ci"


def test_default_auth_service_has_no_finance_routes_or_postgres_dependency(monkeypatch):
    for name in ("FH_FINANCE_RUNTIME_MODE", "FH_FINANCE_V2_RUNTIME",
                 "FH_FINANCE_PROFILE_NAMESPACE", "FH_FINANCE_IMPORT_RUNTIME"):
        monkeypatch.delenv(name, raising=False)
    assert _personal_finance_runtime_options() == {}


def test_personal_finance_runtime_requires_explicit_stable_scoped_settings(monkeypatch):
    monkeypatch.setenv("FH_FINANCE_RUNTIME_MODE", "personal")
    monkeypatch.setenv("FH_FINANCE_V2_RUNTIME", "on")
    monkeypatch.setenv("FH_FINANCE_PROFILE_NAMESPACE", NAMESPACE)
    monkeypatch.setenv("FH_FINANCE_DATABASE_URL", FAKE_POSTGRES)
    options = _personal_finance_runtime_options()
    try:
        assert options["finance_profile_namespace"] == UUID(NAMESPACE)
        assert options["enable_account_v2_candidate"] is True
        assert options["enable_import_candidate"] is False
        assert options["finance_engine"].dialect.name == "postgresql"
        # SQLAlchemy engine construction is lazy; this test does not connect
        # or provision a database. DB+FH-session contract lives in #67 CI.
    finally:
        options["finance_engine"].dispose()
    monkeypatch.setenv("FH_FINANCE_V2_RUNTIME", "off")
    disabled = _personal_finance_runtime_options()
    try:
        assert disabled["enable_account_v2_candidate"] is False
        assert disabled["enable_import_candidate"] is False
    finally:
        disabled["finance_engine"].dispose()


@pytest.mark.parametrize("mode,v2,namespace,url", [
    ("unknown", "off", NAMESPACE, FAKE_POSTGRES),
    ("off", "on", NAMESPACE, FAKE_POSTGRES),
    ("personal", "invalid", NAMESPACE, FAKE_POSTGRES),
    ("personal", "on", "", FAKE_POSTGRES),
    ("personal", "on", "00000000-0000-0000-0000-000000000000", FAKE_POSTGRES),
    ("personal", "on", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", FAKE_POSTGRES),
    ("personal", "on", NAMESPACE, ""),
    ("personal", "on", NAMESPACE, "sqlite:///private.sqlite"),
])
def test_personal_feature_never_falls_back_to_unsafe_configuration(
    monkeypatch, mode, v2, namespace, url,
):
    monkeypatch.setenv("FH_FINANCE_RUNTIME_MODE", mode)
    monkeypatch.setenv("FH_FINANCE_V2_RUNTIME", v2)
    monkeypatch.setenv("FH_FINANCE_PROFILE_NAMESPACE", namespace)
    monkeypatch.setenv("FH_FINANCE_DATABASE_URL", url)
    with pytest.raises(ValueError):
        _personal_finance_runtime_options()


def test_personal_import_requires_explicit_v2_and_refuses_default(monkeypatch):
    monkeypatch.setenv("FH_FINANCE_RUNTIME_MODE", "personal")
    monkeypatch.setenv("FH_FINANCE_V2_RUNTIME", "on")
    monkeypatch.setenv("FH_FINANCE_IMPORT_RUNTIME", "on")
    monkeypatch.setenv("FH_FINANCE_PROFILE_NAMESPACE", NAMESPACE)
    monkeypatch.setenv("FH_FINANCE_DATABASE_URL", FAKE_POSTGRES)
    enabled = _personal_finance_runtime_options()
    try:
        assert enabled["enable_account_v2_candidate"] is True
        assert enabled["enable_import_candidate"] is True
    finally:
        enabled["finance_engine"].dispose()
    monkeypatch.setenv("FH_FINANCE_V2_RUNTIME", "off")
    with pytest.raises(ValueError):
        _personal_finance_runtime_options()
    monkeypatch.setenv("FH_FINANCE_RUNTIME_MODE", "off")
    monkeypatch.setenv("FH_FINANCE_V2_RUNTIME", "on")
    with pytest.raises(ValueError):
        _personal_finance_runtime_options()
    monkeypatch.setenv("FH_FINANCE_RUNTIME_MODE", "personal")
    monkeypatch.setenv("FH_FINANCE_IMPORT_RUNTIME", "invalid")
    with pytest.raises(ValueError):
        _personal_finance_runtime_options()
