#!/usr/bin/env python3
"""#66: attach the existing personal PostgreSQL to a dedicated localhost bridge.

Docker Engine 29 may ignore requested port publishing when a container is
connected exclusively to an internal bridge. Keep the internal finance network
and add a distinct, access-controlled ordinary bridge WITHOUT recreating DB.
Never relax the exact 127.0.0.1:54329 mapping or touch PostgreSQL data.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import personal_port_check as guard

PRIVATE = "fh-finance_finance_private"
LOOPBACK = "fh-finance_host_loopback"
LABEL = "com.financial-horizon.purpose"
LABEL_VALUE = "personal-postgres-loopback"
REQUIRED_OPTIONS = {
    "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1",
    "com.docker.network.bridge.enable_icc": "false",
}


class NetworkNoGo(ValueError):
    pass


def deny(reason: str) -> None:
    raise NetworkNoGo(reason)


def run(*argv: str) -> str:
    result = subprocess.run(
        ["docker", *argv], capture_output=True, text=True,
        timeout=20, check=True,
    )
    if len(result.stdout) > 65536:
        deny("DOCKER_OUTPUT_TOO_LARGE")
    return result.stdout.strip()


def json_docker(*argv: str) -> object:
    try:
        return json.loads(run(*argv))
    except json.JSONDecodeError as error:
        raise NetworkNoGo("UNEXPECTED_DOCKER_METADATA") from error


def inspect_network(name: str) -> dict:
    result = json_docker("network", "inspect", name)
    if not isinstance(result, list) or len(result) != 1 or not isinstance(result[0], dict):
        deny("UNEXPECTED_NETWORK_INSPECT")
    return result[0]


def verify_bridge(net: dict) -> None:
    if net.get("Name") != LOOPBACK or net.get("Driver") != "bridge" or (
        net.get("Internal") is not False or net.get("EnableIPv6") is not False
    ):
        deny("UNEXPECTED_LOOPBACK_NETWORK")
    labels = net.get("Labels") or {}
    options = net.get("Options") or {}
    if not isinstance(labels, dict) or labels.get(LABEL) != LABEL_VALUE or (
        not isinstance(options, dict)
    ) or any(options.get(k) != v for k, v in REQUIRED_OPTIONS.items()):
        deny("UNTRUSTED_LOOPBACK_NETWORK_OPTIONS")
    attached = net.get("Containers") or {}
    if not isinstance(attached, dict) or any(
        not isinstance(container, dict) or
        container.get("Name") != guard.CONTAINER
        for container in attached.values()
    ) or len(attached) > 1:
        deny("LOOPBACK_BRIDGE_SHARED_WITH_OTHER_CONTAINERS")


def verify_private(net: dict) -> None:
    if net.get("Name") != PRIVATE or net.get("Driver") != "bridge" or (
        net.get("Internal") is not True
    ):
        deny("ORIGINAL_PRIVATE_NETWORK_CHANGED")


def verify_memberships(names: object, *, require_loopback: bool) -> None:
    if not isinstance(names, dict):
        deny("UNKNOWN_CONTAINER_NETWORKS")
    present = set(names)
    expected = {PRIVATE, LOOPBACK} if require_loopback else {PRIVATE}
    if present not in (expected, {PRIVATE, LOOPBACK}) or (
        require_loopback and present != {PRIVATE, LOOPBACK}
    ):
        deny("UNKNOWN_OR_MISSING_CONTAINER_NETWORK")


def container_metadata(*, require_loopback: bool, require_running: bool) -> None:
    configured = json_docker("inspect", "--format", "{{json .HostConfig.PortBindings}}", guard.CONTAINER)
    mounts = json_docker("inspect", "--format", "{{json .Mounts}}", guard.CONTAINER)
    image = run("inspect", "--format", "{{.Config.Image}}", guard.CONTAINER)
    network = run("inspect", "--format", "{{.HostConfig.NetworkMode}}", guard.CONTAINER)
    active = run("inspect", "--format", "{{.State.Running}}", guard.CONTAINER) == "true"
    health = run("inspect", "--format", "{{.State.Health.Status}}", guard.CONTAINER)
    names = json_docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", guard.CONTAINER)
    verify_memberships(names, require_loopback=require_loopback)
    if run("inspect", "--format", "{{.HostConfig.RestartPolicy.Name}}", guard.CONTAINER) != "no":
        deny("UNEXPECTED_RESTART_POLICY")
    if require_running and (not active or health != "healthy"):
        deny("POSTGRES_NOT_HEALTHY")
    effective = json_docker("inspect", "--format", "{{json .NetworkSettings.Ports}}", guard.CONTAINER) if require_running and require_loopback else None
    guard.verify(
        configured, effective, mounts, image, network, active,
        configured_only=not (require_running and require_loopback),
    )
    verify_private(inspect_network(PRIVATE))
    if require_loopback:
        verify_bridge(inspect_network(LOOPBACK))


def network_exists() -> bool:
    names = run("network", "ls", "--filter", f"name=^{LOOPBACK}$", "--format", "{{.Name}}")
    return LOOPBACK in names.splitlines()


def ensure_network() -> None:
    if not network_exists():
        run(
            "network", "create", "--driver", "bridge",
            "--label", f"{LABEL}={LABEL_VALUE}",
            "--opt", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1",
            "--opt", "com.docker.network.bridge.enable_icc=false",
            LOOPBACK,
        )
    verify_bridge(inspect_network(LOOPBACK))


def verify_host_connectivity() -> None:
    for _ in range(10):
        try:
            with socket.create_connection(("127.0.0.1", 54329), timeout=2):
                return
        except OSError:
            time.sleep(0.2)
    deny("LOCALHOST_POSTGRES_TCP_UNREACHABLE")


def main() -> int:
    try:
        mode = sys.argv[1:] 
        if mode not in (["--attach"], ["--verify"], ["--verify-configured"]):
            deny("UNKNOWN_OPERATION")
        if os.geteuid() != 0 or os.environ.get("GITHUB_ACTIONS") == "true":
            deny("PRODUCTION_ROOT_ONLY")
        if os.environ.get("FH_FINANCE_PERSONAL_MODE") != "YES" or (
            os.environ.get("FH_FINANCE_DATA_DIR") != guard.DATA_DIR
        ):
            deny("PERSONAL_MODE_AND_PRIVATE_DATA_DIR_REQUIRED")
        if mode == ["--attach"]:
            if os.environ.get("FH_FINANCE_ATTACH_HOST_LOOPBACK") != "YES":
                deny("EXPLICIT_HOST_LOOPBACK_APPROVAL_REQUIRED")
            container_metadata(require_loopback=False, require_running=True)
            ensure_network()
            current = json_docker(
                "inspect", "--format", "{{json .NetworkSettings.Networks}}",
                guard.CONTAINER,
            )
            if LOOPBACK not in current:
                run("network", "connect", LOOPBACK, guard.CONTAINER)
            container_metadata(require_loopback=True, require_running=True)
            verify_host_connectivity()
            print("FINANCE_PERSONAL_HOST_BRIDGE_ATTACHED=PASS")
        elif mode == ["--verify"]:
            container_metadata(require_loopback=True, require_running=True)
            verify_host_connectivity()
            print("FINANCE_PERSONAL_HOST_LOOPBACK=PASS")
        else:
            container_metadata(require_loopback=True, require_running=False)
            print("FINANCE_PERSONAL_HOST_BRIDGE_CONFIGURED=PASS")
        return 0
    except (NetworkNoGo, guard.UnsafeBinding, OSError,
            subprocess.SubprocessError, json.JSONDecodeError) as error:
        message = str(error) if isinstance(error, (NetworkNoGo, guard.UnsafeBinding)) else "DOCKER_NETWORK_CHECK_UNAVAILABLE"
        print("FINANCE_PERSONAL_HOST_BRIDGE_NO_GO: " + message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
