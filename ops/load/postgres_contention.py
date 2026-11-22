#!/usr/bin/env python3
"""PostgreSQL lock, rollback and idempotency probes on disposable synthetic DB.

Requires psycopg 3 and an otherwise unused local database fh_ops45_*.
It does not exercise the production finance schema or claim API conformance.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
import re
from threading import Barrier, Event, Thread
import time
from urllib.parse import urlsplit
from uuid import uuid4


class GateError(Exception):
    pass


def assert_isolated_dsn(dsn: str) -> None:
    parts = urlsplit(dsn)
    if (parts.scheme not in ("postgresql", "postgres") or parts.hostname not in
            ("localhost", "127.0.0.1", "::1") or
            not re.fullmatch(r"fh_ops45_[a-z0-9_]{1,40}", parts.path.lstrip("/"))):
        raise GateError("ISOLATED_LOCAL_DB_REQUIRED")


def run(dsn: str) -> dict:
    assert_isolated_dsn(dsn)
    if os.getenv("FH45_ISOLATED_DB") != "YES":
        raise GateError("ISOLATION_ACK_REQUIRED")
    try:
        import psycopg
    except ImportError as exc:
        raise GateError("PSYCOPG3_MISSING") from exc
    schema = "ops45_" + uuid4().hex[:16]
    measurements: list[float] = []

    def connect():
        # No DSN, query text, exception or row data is ever printed.
        return psycopg.connect(dsn, connect_timeout=3, autocommit=False)

    with connect() as admin:
        database = admin.execute("SELECT current_database()").fetchone()[0]
        if not re.fullmatch(r"fh_ops45_[a-z0-9_]{1,40}", database):
            raise GateError("DATABASE_NAME_MISMATCH")
        admin.execute(f'CREATE SCHEMA "{schema}"')
        admin.execute(f'CREATE TABLE "{schema}".account (id integer primary key, balance bigint not null)')
        admin.execute(f'CREATE TABLE "{schema}".receipt (key text primary key)')
        admin.execute(f'INSERT INTO "{schema}".account VALUES (1, 10000)')
        admin.commit()

    def balance() -> tuple[int, int]:
        with connect() as db:
            return (db.execute(f'SELECT balance FROM "{schema}".account WHERE id=1').fetchone()[0],
                    db.execute(f'SELECT count(*) FROM "{schema}".receipt').fetchone()[0])

    try:
        barrier = Barrier(2)
        key = str(uuid4())

        def replay() -> tuple[bool, float]:
            with connect() as db:
                barrier.wait(timeout=5)
                start = time.perf_counter()
                # On conflict, second writer waits for the first commit;
                # unique receipt plus update form ONE atomic transaction.
                applied = bool(db.execute(
                    f'INSERT INTO "{schema}".receipt (key) VALUES (%s) '
                    'ON CONFLICT DO NOTHING RETURNING key', (key,)).fetchone())
                if applied:
                    db.execute(f'UPDATE "{schema}".account SET balance=balance+500 WHERE id=1')
                db.commit()
                return applied, (time.perf_counter() - start) * 1000

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: replay(), range(2)))
        measurements.extend(ms for _, ms in results)
        replay_pass = sorted(applied for applied, _ in results) == [False, True] and balance() == (10500, 1)

        # Deliberate failure in a transaction: neither row may persist.
        try:
            with connect() as db:
                db.execute(f'INSERT INTO "{schema}".receipt (key) VALUES (%s)', (str(uuid4()),))
                db.execute(f'UPDATE "{schema}".account SET balance=balance+1 WHERE id=1')
                raise RuntimeError("synthetic rollback probe")
        except RuntimeError:
            pass
        rollback_pass = balance() == (10500, 1)

        locked = Event()
        release = Event()
        errors: list[str] = []

        def hold_lock():
            try:
                with connect() as db:
                    db.execute(f'SELECT balance FROM "{schema}".account WHERE id=1 FOR UPDATE')
                    locked.set()
                    if not release.wait(5):
                        errors.append("holder_timeout")
            except Exception:
                errors.append("holder_failure")
                locked.set()

        holder = Thread(target=hold_lock, daemon=True)
        holder.start()
        try:
            if not locked.wait(5):
                raise GateError("LOCK_PROBE_TIMEOUT")
            with connect() as db:
                db.execute("SET LOCAL lock_timeout = '200ms'")
                try:
                    db.execute(f'UPDATE "{schema}".account SET balance=balance+100 WHERE id=1')
                    db.commit()
                    timeout_pass = False
                except psycopg.errors.LockNotAvailable:
                    db.rollback()
                    timeout_pass = True
        finally:
            release.set()
            holder.join(timeout=6)
        timeout_pass = timeout_pass and not errors and not holder.is_alive() and balance() == (10500, 1)
        gate = "PASS" if replay_pass and rollback_pass and timeout_pass else "FAIL"
        return {"schema": 1, "scenario": "isolated_postgres_contention",
                "workers": 2, "idempotent_concurrent_writes": replay_pass,
                "transaction_rollback": rollback_pass, "lock_timeout": timeout_pass,
                "p95_write_ms": round(max(measurements), 3), "gate": gate}
    finally:
        # Only the random schema in an explicitly named scratch database is dropped.
        with connect() as admin:
            admin.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
            admin.commit()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--dsn-env", default="FH45_PG_DSN")
    args = parser.parse_args(argv)
    try:
        output = run(os.environ.get(args.dsn_env, ""))
        print(json.dumps(output, sort_keys=True))
        return 0 if output["gate"] == "PASS" else 1
    except Exception as exc:
        # Treat database driver errors as redacted test failures: DSNs can
        # appear in exception strings; never expose them in CI logs.
        code = str(exc) if isinstance(exc, GateError) else "POSTGRES_PROBE_FAILED"
        print(json.dumps({"schema": 1, "scenario": "isolated_postgres_contention",
                          "gate": "BLOCKED", "reason": code}, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
