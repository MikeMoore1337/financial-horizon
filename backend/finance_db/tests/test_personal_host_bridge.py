"""#66: prove the Docker 29 loopback bridge repair refuses unsafe networks.

Tests run only synthetic Docker metadata, never modify production containers.
"""
from __future__ import annotations

from contextlib import nullcontext
import importlib.util
import os
from pathlib import Path
import subprocess
import sys

import pytest

SCRIPTS = Path(__file__).resolve().parents[3] / "deploy" / "postgres" / "scripts"
HELPER = SCRIPTS / "personal-host-bridge.py"


def load_helper():
    spec = importlib.util.spec_from_file_location("personal_host_bridge", HELPER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def bridge_metadata(module, containers=None):
    return {
        "Name": module.LOOPBACK,
        "Driver": "bridge",
        "Internal": False,
        "EnableIPv6": False,
        "Labels": {module.LABEL: module.LABEL_VALUE},
        "Options": dict(module.REQUIRED_OPTIONS),
        "Containers": containers or {},
    }


def test_dedicated_bridge_requires_loopback_binding_and_isolation_options():
    bridge = load_helper()
    bridge.verify_bridge(bridge_metadata(bridge))
    attempts = [
        {"Name": "another-project"},
        {"Driver": "host"},
        {"Internal": True},
        {"EnableIPv6": True},
        {"Labels": {}},
        {"Options": {}},
        {"Options": {**bridge.REQUIRED_OPTIONS,
                     "com.docker.network.bridge.host_binding_ipv4": "0.0.0.0"}},
        {"Options": {**bridge.REQUIRED_OPTIONS,
                     "com.docker.network.bridge.enable_icc": "true"}},
        {"Containers": {"id": {"Name": "unrelated-postgres"}}},
        {"Containers": {"1": {"Name": bridge.guard.CONTAINER},
                        "2": {"Name": "foreign"}}},
    ]
    for patch in attempts:
        with pytest.raises(bridge.NetworkNoGo):
            bridge.verify_bridge({**bridge_metadata(bridge), **patch})


def test_container_memberships_never_accept_other_networks():
    bridge = load_helper()
    internal = {bridge.PRIVATE: {}}
    attached = {bridge.PRIVATE: {}, bridge.LOOPBACK: {}}
    bridge.verify_memberships(internal, require_loopback=False)
    bridge.verify_memberships(attached, require_loopback=False)
    bridge.verify_memberships(attached, require_loopback=True)
    for wrong in ({}, {"bridge": {}}, {bridge.LOOPBACK: {}},
                  {bridge.PRIVATE: {}, "other": {}},
                  {**attached, "foreign": {}}):
        for required in (False, True):
            with pytest.raises(bridge.NetworkNoGo):
                bridge.verify_memberships(wrong, require_loopback=required)
    with pytest.raises(bridge.NetworkNoGo):
        bridge.verify_memberships(internal, require_loopback=True)


def test_original_private_network_remains_internal_only():
    bridge = load_helper()
    network = {"Name": bridge.PRIVATE, "Driver": "bridge", "Internal": True}
    bridge.verify_private(network)
    with pytest.raises(bridge.NetworkNoGo):
        bridge.verify_private({**network, "Internal": False})


def test_bridge_is_created_with_exact_loopback_and_no_inter_container_traffic(monkeypatch):
    bridge = load_helper()
    calls = []
    monkeypatch.setattr(bridge, "network_exists", lambda: False)
    monkeypatch.setattr(bridge, "inspect_network", lambda _: bridge_metadata(bridge))
    monkeypatch.setattr(bridge, "run", lambda *args: calls.append(args) or "created")
    bridge.ensure_network()
    assert calls == [(
        "network", "create", "--driver", "bridge",
        "--label", f"{bridge.LABEL}={bridge.LABEL_VALUE}",
        "--opt", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1",
        "--opt", "com.docker.network.bridge.enable_icc=false",
        bridge.LOOPBACK,
    )]


def test_existing_dedicated_bridge_does_not_recreate_it(monkeypatch):
    bridge = load_helper()
    calls = []
    monkeypatch.setattr(bridge, "network_exists", lambda: True)
    monkeypatch.setattr(bridge, "inspect_network", lambda _: bridge_metadata(bridge))
    monkeypatch.setattr(bridge, "run", lambda *args: calls.append(args))
    bridge.ensure_network()
    assert not calls


def test_verify_host_tcp_rejects_unreachable_port_without_bypassing_checker(monkeypatch):
    bridge = load_helper()
    calls = []
    monkeypatch.setattr(bridge.time, "sleep", lambda _: None)
    def denied(host, timeout):
        calls.append((host, timeout))
        raise OSError("synthetic unavailable")
    monkeypatch.setattr(bridge.socket, "create_connection", denied)
    with pytest.raises(bridge.NetworkNoGo, match="LOCALHOST_POSTGRES_TCP_UNREACHABLE"):
        bridge.verify_host_connectivity()
    assert calls and all(host == ("127.0.0.1", 54329) for host, _ in calls)


def test_local_tcp_success_requires_actual_socket(monkeypatch):
    bridge = load_helper()
    monkeypatch.setattr(bridge.socket, "create_connection", lambda *args, **kwargs: nullcontext())
    bridge.verify_host_connectivity()


def test_no_production_edits_without_explicit_owner_opt_in():
    env = dict(os.environ)
    env["GITHUB_ACTIONS"] = "true"
    for action in ("--attach", "--verify", "--verify-configured"):
        result = subprocess.run(
            ["python3", str(HELPER), action], env=env,
            capture_output=True, text=True, timeout=5, check=False,
        )
        assert result.returncode != 0
        assert not result.stdout
        assert "FINANCE_PERSONAL_HOST_BRIDGE_NO_GO:" in result.stderr


def test_startup_never_recreates_an_initialized_postgresql_container():
    startup = (SCRIPTS / "personal-start.sh").read_text(encoding="utf-8")
    bootstrap = (SCRIPTS / "personal-bootstrap.sh").read_text(encoding="utf-8")
    resume = (SCRIPTS / "personal-resume.sh").read_text(encoding="utf-8")
    assert "personal-host-bridge.py" in startup
    assert "personal-host-bridge.py" in bootstrap
    # Do not let a Compose dependency restart/recreate the just-connected DB.
    assert bootstrap.count("--no-deps") >= 2
    assert "personal-host-bridge.py" in resume
    assert "--verify-configured" in startup
    assert "--verify-configured" in resume
    assert '--verify ||' in startup
    assert 'docker start fh-finance-postgres' in startup
    assert 'docker compose' not in startup
    assert "docker compose down" not in startup
    for script in (SCRIPTS / "personal-start.sh",
                   SCRIPTS / "personal-resume.sh",
                   SCRIPTS / "personal-bootstrap.sh"):
        parsed = subprocess.run(
            ["bash", "-n", str(script)],
            capture_output=True, text=True, timeout=5, check=False,
        )
        assert parsed.returncode == 0, parsed.stderr
