#!/usr/bin/env python3
"""Read-only, redacted SRE sampling, health probes and threshold evaluation."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, HTTPRedirectHandler, ProxyHandler, build_opener


class GateError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, _req, _fp, _code, _msg, _headers, _newurl):
        return None


HTTP = build_opener(ProxyHandler({}), NoRedirect())


def cpu_ticks() -> tuple[int, int]:
    fields = Path("/proc/stat").read_text().splitlines()[0].split()
    if fields[0] != "cpu":
        raise GateError("CPU_METRICS_UNAVAILABLE")
    numbers = [int(item) for item in fields[1:]]
    return sum(numbers), numbers[3] + numbers[4]


def sample_resources(mount: Path, *, with_db: bool = False, interval: float = 0.25) -> dict:
    first_total, first_idle = cpu_ticks()
    time.sleep(interval)
    last_total, last_idle = cpu_ticks()
    if last_total <= first_total:
        raise GateError("CPU_METRICS_UNAVAILABLE")
    cpu_percent = 100 * (1 - (last_idle - first_idle) / (last_total - first_total))
    mem: dict[str, int] = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith(("MemTotal:", "MemAvailable:")):
            key, value, *_ = line.split()
            mem[key.rstrip(":")] = int(value)
    if not mem.get("MemTotal") or "MemAvailable" not in mem:
        raise GateError("MEMORY_METRICS_UNAVAILABLE")
    stat = os.statvfs(mount)
    if stat.f_blocks == 0:
        raise GateError("DISK_METRICS_UNAVAILABLE")
    output = {
        "schema": 1, "at_utc": datetime.now(timezone.utc).isoformat(),
        "cpu_percent": round(cpu_percent, 2),
        "ram_percent": round(100 * (1 - mem["MemAvailable"] / mem["MemTotal"]), 2),
        "disk_free_percent": round(100 * stat.f_bavail / stat.f_blocks, 2),
        "disk_free_bytes": stat.f_bavail * stat.f_frsize,
        "postgres": "NOT_RUN", "gate": "PASS",
    }
    if with_db:
        dsn = os.environ.get("FH45_MONITOR_PG_DSN", "")
        if not dsn:
            raise GateError("MONITOR_DATABASE_DSN_MISSING")
        try:
            import psycopg
        except ImportError as exc:
            raise GateError("PSYCOPG3_MISSING") from exc
        try:
            with psycopg.connect(dsn, connect_timeout=3, options="-c statement_timeout=3000") as db:
                with db.cursor() as cursor:
                    cursor.execute("SELECT count(*), count(*) FILTER (WHERE wait_event_type='Lock') FROM pg_stat_activity")
                    active, waiting = cursor.fetchone()
                    cursor.execute("SELECT current_setting('max_connections')::integer")
                    maximum = cursor.fetchone()[0]
            output["postgres"] = {"connections": active, "max_connections": maximum,
                                  "lock_waiters": waiting,
                                  "connections_percent": round(100 * active / maximum, 2)}
        except Exception as exc:
            # psycopg errors may interpolate credentials and infrastructure names.
            raise GateError("POSTGRES_METRICS_UNAVAILABLE") from exc
    return output


def probe(url: str, *, timeout: float = 2) -> int:
    parts = urlsplit(url)
    if (parts.scheme not in ("http", "https") or not parts.hostname
            or parts.username or parts.password or parts.query or parts.fragment
            or parts.path not in ("/healthz", "/readyz")):
        raise GateError("UNSAFE_PROBE_URL")
    req = Request(url, headers={"Accept": "application/json", "Cache-Control": "no-store"},
                  method="GET")
    try:
        with HTTP.open(req, timeout=timeout) as response:
            # Never read or print body: health endpoints must not leak details.
            return response.status
    except HTTPError as exc:
        status = exc.code
        exc.close()
        return status
    except (URLError, OSError, TimeoutError):
        return 0


def health(health_url: str, ready_url: str) -> dict:
    live, ready = probe(health_url), probe(ready_url)
    # A healthy process may be unready during a DB/auth outage.
    return {"schema": 1, "liveness_status": live, "readiness_status": ready,
            "gate": "PASS" if (live, ready) == (200, 200) else "FAIL"}


def alerts(samples: list[dict]) -> dict:
    if not samples:
        raise GateError("SAMPLES_MISSING")
    latest = samples[-1]
    findings = []

    def emit(code: str, severity: str):
        findings.append({"code": code, "severity": severity})

    free = latest.get("disk_free_percent")
    if isinstance(free, (int, float)):
        if free < 10:
            emit("DISK_CRITICAL", "critical")
        elif free < 20:
            emit("DISK_LOW", "warning")
    for field, threshold, code in [
        ("cpu_percent", 85, "CPU_SUSTAINED"),
        ("ram_percent", 85, "MEMORY_SUSTAINED"),
        ("p95_ms", 1000, "API_LATENCY_SUSTAINED"),
    ]:
        values = [item.get(field) for item in samples[-3:]]
        if len(values) == 3 and all(isinstance(x, (int, float)) and x > threshold for x in values):
            emit(code, "warning")
    pg = latest.get("postgres", {})
    if isinstance(pg, dict):
        if isinstance(pg.get("connections_percent"), (int, float)) and pg["connections_percent"] > 70:
            emit("POSTGRES_CONNECTIONS_HIGH", "warning")
        if pg.get("lock_waiters", 0) > 0 and len(samples) >= 3 and all(
                isinstance(x.get("postgres"), dict) and x["postgres"].get("lock_waiters", 0) > 0
                for x in samples[-3:]):
            emit("POSTGRES_LOCK_WAITERS", "warning")
    if isinstance(latest.get("five_xx_percent"), (int, float)) and latest["five_xx_percent"] > 1:
        emit("API_SERVER_ERRORS", "critical")
    if latest.get("backup_fresh") is False:
        emit("BACKUP_NOT_FRESH", "critical")
    return {"schema": 1, "alerts": findings,
            "gate": "FAIL" if any(x["severity"] == "critical" for x in findings)
                    else ("WARN" if findings else "PASS")}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="mode", required=True)
    resource = sub.add_parser("sample")
    resource.add_argument("--mount", type=Path, required=True)
    resource.add_argument("--with-db", action="store_true")
    health_cmd = sub.add_parser("health")
    health_cmd.add_argument("--health-url", required=True)
    health_cmd.add_argument("--ready-url", required=True)
    rule_cmd = sub.add_parser("alerts")
    rule_cmd.add_argument("--samples", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.mode == "sample":
            result = sample_resources(args.mount, with_db=args.with_db)
        elif args.mode == "health":
            result = health(args.health_url, args.ready_url)
        else:
            parsed = json.loads(args.samples.read_text(encoding="utf-8"))
            if not isinstance(parsed, list) or len(parsed) > 500:
                raise GateError("SAMPLES_INVALID")
            result = alerts(parsed)
        print(json.dumps(result, sort_keys=True))
        return 0 if result["gate"] == "PASS" else 1
    except Exception as exc:
        code = str(exc) if isinstance(exc, GateError) else "OBSERVABILITY_CHECK_FAILED"
        print(json.dumps({"schema": 1, "gate": "BLOCKED", "reason": code}, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
