#!/usr/bin/env python3
"""Bounded, local-only synthetic HTTP checks for the #65 financial API contract.

Never use this against a production proxy/tunnel. Credentials remain in memory;
only aggregate, non-identifying measurements are emitted.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
import ipaddress
import json
import math
import os
import re
import statistics
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, HTTPRedirectHandler, ProxyHandler, build_opener
from uuid import uuid4

STATE = "/api/finance/v1/state"
COMMANDS = "/api/finance/v1/commands"
COOKIE_NAME = "fh_email_session"


class GateError(Exception):
    """Expected and intentionally redacted test-gate failure."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, _req, _fp, _code, _msg, _headers, _newurl):
        return None


HTTP = build_opener(ProxyHandler({}), NoRedirect())


def local_origin(origin: str) -> str:
    parts = urlsplit(origin)
    try:
        port = parts.port
    except ValueError as exc:
        raise GateError("LOCAL_URL_REQUIRED") from exc
    if (parts.scheme != "http" or parts.username or parts.password or parts.query
            or parts.fragment or parts.path not in ("", "/") or not port):
        raise GateError("LOCAL_URL_REQUIRED")
    try:
        loopback = ipaddress.ip_address(parts.hostname or "").is_loopback
    except ValueError:
        loopback = parts.hostname == "localhost"
    if not loopback:
        raise GateError("LOCAL_URL_REQUIRED")
    return origin.rstrip("/")


def percentile(values: list[float], percentile_rank: int) -> float | None:
    if not values:
        return None
    sorted_values = sorted(values)
    return round(sorted_values[max(0, math.ceil(len(values) * percentile_rank / 100) - 1)], 3)


def summarise(records: list[dict], elapsed: float) -> dict:
    durations = [r["ms"] for r in records]
    counts: dict[str, int] = {}
    for record in records:
        key = str(record["status"])
        counts[key] = counts.get(key, 0) + 1
    return {
        "requests": len(records), "status_counts": dict(sorted(counts.items())),
        "latency_ms": {"p50": percentile(durations, 50), "p95": percentile(durations, 95),
                       "p99": percentile(durations, 99)},
        "throughput_rps": round(len(records) / max(elapsed, 0.001), 3),
        "elapsed_seconds": round(elapsed, 3),
    }


def session(name: str) -> str:
    value = os.environ.get(name, "")
    if not re.fullmatch(r"[A-Za-z0-9_~.\-]{16,512}", value):
        raise GateError("SYNTHETIC_SESSION_MISSING")
    return value


def request(origin: str, path: str, cookie: str, timeout: float,
            *, command: dict | None = None, etag: str | None = None) -> dict:
    data = json.dumps(command, separators=(",", ":")).encode() if command else None
    headers = {"Accept": "application/json", "Cache-Control": "no-store",
               "Cookie": f"{COOKIE_NAME}={cookie}", "User-Agent": "FH45-synthetic/1"}
    if data is not None:
        headers.update({"Content-Type": "application/json", "If-Match": etag or "",
                        "Idempotency-Key": command["client_mutation_id"]})
    req = Request(origin + path, data=data, headers=headers,
                  method="POST" if data is not None else "GET")
    begin = time.perf_counter()
    try:
        with HTTP.open(req, timeout=timeout) as response:
            status = response.status
            cache = response.headers.get("Cache-Control", "")
            tag = response.headers.get("ETag")
            # Response bytes never enter diagnostics. A bounded JSON read is
            # needed only for contract assertions and is not persisted.
            body = response.read(1_048_577)
            if len(body) > 1_048_576:
                raise GateError("RESPONSE_TOO_LARGE")
            value = json.loads(body)
    except HTTPError as exc:
        status, cache, tag, value = exc.code, exc.headers.get("Cache-Control", ""), None, None
        exc.close()
    except (TimeoutError, URLError, OSError):
        status, cache, tag, value = 0, "", None, None
    except (json.JSONDecodeError, UnicodeDecodeError):
        status, cache, tag, value = -1, "", None, None
    return {"status": status, "ms": round((time.perf_counter() - begin) * 1000, 3),
            "cache": cache, "etag": tag, "body": value}


def snapshot(origin: str, cookie: str, timeout: float) -> dict:
    result = request(origin, STATE, cookie, timeout)
    if result["status"] != 200 or "no-store" not in result["cache"].lower():
        raise GateError("STATE_NOT_READY")
    if not (result["etag"] and result["etag"].startswith('"')
            and result["etag"].endswith('"')):
        raise GateError("STATE_ETAG_MISSING")
    if not isinstance(result["body"], dict) or not isinstance(result["body"].get("revision"), int):
        raise GateError("STATE_CONTRACT_INVALID")
    return result


def check_read(origin: str, a: str, b: str, timeout: float,
               workers: int, count: int, pause_ms: int) -> dict:
    def work(i: int) -> dict:
        if pause_ms:
            time.sleep((i // workers) * pause_ms / 1000)
        return request(origin, STATE, a if i % 2 == 0 else b, timeout)
    start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        completed = list(pool.map(work, range(count)))
    elapsed = time.perf_counter() - start
    report = summarise(completed, elapsed)
    report["gate"] = ("PASS" if all(r["status"] == 200 and
                   "no-store" in r["cache"].lower() and r["etag"] for r in completed)
                      else "FAIL")
    return report


def check_replay(origin: str, a: str, b: str, timeout: float) -> dict:
    before_a, before_b = snapshot(origin, a, timeout), snapshot(origin, b, timeout)
    mutation_id = str(uuid4())
    command = {"schema_version": 1, "client_mutation_id": mutation_id,
               "base_revision": before_a["body"]["revision"],
               "action": "obligation.create", "expected_entity_revisions": {},
               "payload": {"title": "Synthetic FH45 fixture", "direction": "expense",
                           "amount_minor": 1, "starts_on": date.today().isoformat(),
                           "timezone": "UTC", "recurrence_unit": "none", "recurrence_every": 1}}
    start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(request, origin, COMMANDS, a, timeout, command=command,
                               etag=before_a["etag"]) for _ in range(2)]
        replies = [future.result() for future in futures]
    elapsed = time.perf_counter() - start
    # Stale-revision mutation has a DIFFERENT idempotency key; no effect allowed.
    stale_command = {**command, "client_mutation_id": str(uuid4())}
    stale = request(origin, COMMANDS, a, timeout, command=stale_command,
                    etag=before_a["etag"])
    after_a, after_b = snapshot(origin, a, timeout), snapshot(origin, b, timeout)
    acknowledgements = [r["body"] for r in replies]
    valid_acks = all(
        isinstance(ack, dict) and ack.get("client_mutation_id") == mutation_id
        and isinstance(ack.get("revision"), int) and isinstance(ack.get("replayed"), bool)
        for ack in acknowledgements)
    passed = (valid_acks and sorted(r["status"] for r in replies) == [200, 201]
              and sorted(ack["replayed"] for ack in acknowledgements) == [False, True]
              and len({ack["revision"] for ack in acknowledgements}) == 1
              and acknowledgements[0]["revision"] == before_a["body"]["revision"] + 1
              and after_a["body"]["revision"] == before_a["body"]["revision"] + 1
              and after_b["body"]["revision"] == before_b["body"]["revision"]
              and stale["status"] == 412)
    return {**summarise(replies, elapsed), "stale_precondition_status": stale["status"],
            "other_user_unchanged": after_b["body"]["revision"] == before_b["body"]["revision"],
            "gate": "PASS" if passed else "FAIL"}


def check_expiry(origin: str, timeout: float) -> dict:
    expired = session("FH45_EXPIRED_SESSION")
    result = request(origin, STATE, expired, timeout)
    return {"requests": 1, "status_counts": {str(result["status"]): 1},
            "gate": "PASS" if result["status"] == 401 else "FAIL"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="FH45 isolated synthetic API measurement")
    parser.add_argument("--origin", default="http://127.0.0.1:8000")
    parser.add_argument("--mode", choices=["read", "replay", "expiry"], default="read")
    parser.add_argument("--requests", type=int, default=40)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=float, default=3)
    parser.add_argument("--pause-ms", type=int, default=50)
    parser.add_argument("--ack-isolated", action="store_true")
    args = parser.parse_args(argv)
    try:
        origin = local_origin(args.origin)
        if not (2 <= args.requests <= 500 and 2 <= args.workers <= 16
                and 0.2 <= args.timeout <= 10 and 0 <= args.pause_ms <= 5000):
            raise GateError("BOUNDED_LIMITS_REQUIRED")
        if args.mode == "expiry":
            report = check_expiry(origin, args.timeout)
        else:
            user_a, user_b = session("FH45_SESSION_A"), session("FH45_SESSION_B")
            if user_a == user_b:
                raise GateError("TWO_DISTINCT_SESSIONS_REQUIRED")
            if args.mode == "replay":
                if not args.ack_isolated or os.environ.get("FH45_ISOLATED_DB") != "YES":
                    raise GateError("ISOLATION_ACK_REQUIRED")
                report = check_replay(origin, user_a, user_b, args.timeout)
            else:
                report = check_read(origin, user_a, user_b, args.timeout,
                                    args.workers, args.requests, args.pause_ms)
        print(json.dumps({"schema": 1, "scenario": args.mode,
                          "at_utc": datetime.now(timezone.utc).isoformat(), **report},
                         sort_keys=True))
        return 0 if report["gate"] == "PASS" else 1
    except GateError as exc:
        print(json.dumps({"schema": 1, "scenario": args.mode,
                          "gate": "BLOCKED", "reason": str(exc)}, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
