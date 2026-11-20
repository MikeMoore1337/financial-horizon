#!/usr/bin/env python3
"""Verify Docker's exact effective PostgreSQL loopback mapping, not CLI text.

No user data, tokens, environment secrets or full docker inspect JSON are logged.
--configured-only is required BEFORE starting an existing stopped container.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

CONTAINER = "fh-finance-postgres"
IMAGE = "postgres:17@sha256:5b96f1a16bd9768b060dd2ffe55cb6225c4d9ef4d214a8b21eb08134869a97e4"
DATA_DIR = "/srv/financial-horizon-finance/pgdata"
EXPECTED = {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": "54329"}]}
NETWORK = "fh-finance_finance_private"


class UnsafeBinding(ValueError):
    pass


def verify(configured: object, effective: object | None, mounts: object,
           image: str, network: str, running: bool, *, configured_only: bool) -> None:
    """Fail closed on wildcard, IPv6, extra port, wrong image/mount or network."""
    if configured != EXPECTED:
        raise UnsafeBinding("UNSAFE_CONFIGURED_PORT")
    if image != IMAGE or network != NETWORK:
        raise UnsafeBinding("UNEXPECTED_CONTAINER_IDENTITY")
    if not isinstance(mounts, list):
        raise UnsafeBinding("MISSING_MOUNTS")
    data = [
        mount for mount in mounts
        if isinstance(mount, dict)
        and mount.get("Destination") == "/var/lib/postgresql/data"
    ]
    if len(data) != 1 or data[0].get("Source") != DATA_DIR or (
        data[0].get("Type") != "bind" or data[0].get("RW") is not True
    ):
        raise UnsafeBinding("UNEXPECTED_FINANCE_DATA_MOUNT")
    if any(
        isinstance(mount, dict)
        and isinstance(mount.get("Destination"), str)
        and mount["Destination"].startswith("/var/lib/postgresql/data/")
        for mount in mounts
    ):
        raise UnsafeBinding("NESTED_DATA_MOUNT_FORBIDDEN")
    if not configured_only and (not running or effective != EXPECTED):
        raise UnsafeBinding("UNSAFE_EFFECTIVE_PORT")


def docker_field(template: str) -> str:
    proc = subprocess.run(
        ["docker", "inspect", "--format", template, CONTAINER],
        capture_output=True, text=True, timeout=12, check=True,
    )
    if len(proc.stdout) > 32768:
        raise UnsafeBinding("INSPECT_OUTPUT_TOO_LARGE")
    return proc.stdout.strip()


def main() -> int:
    try:
        if sys.argv[1:] not in ([], ["--configured-only"]):
            raise UnsafeBinding("UNEXPECTED_ARGUMENT")
        if os.getenv("FH_FINANCE_DATA_DIR") != DATA_DIR:
            raise UnsafeBinding("UNEXPECTED_DATA_DIR")
        configured_only = sys.argv[1:] == ["--configured-only"]
        configured = json.loads(docker_field("{{json .HostConfig.PortBindings}}"))
        mounts = json.loads(docker_field("{{json .Mounts}}"))
        image = docker_field("{{.Config.Image}}")
        network = docker_field("{{.HostConfig.NetworkMode}}")
        running = docker_field("{{.State.Running}}") == "true"
        effective = None
        if not configured_only:
            effective = json.loads(docker_field("{{json .NetworkSettings.Ports}}"))
        verify(configured, effective, mounts, image, network, running,
               configured_only=configured_only)
    except (UnsafeBinding, json.JSONDecodeError, subprocess.SubprocessError,
            OSError, ValueError) as exc:
        code = str(exc) if isinstance(exc, UnsafeBinding) else "INSPECT_UNAVAILABLE"
        print("FINANCE_PERSONAL_LOOPBACK_NO_GO: " + code, file=sys.stderr)
        return 1
    print("FINANCE_PERSONAL_" +
          ("CONFIGURED_" if configured_only else "") +
          "LOOPBACK_BINDING=PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
