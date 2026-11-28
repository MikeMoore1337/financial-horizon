"""Server-side validation of the existing goal journal wire format.

The TypeScript engine remains the forecast/presentation implementation. This
module independently enforces monetary, calendar and lifecycle invariants for
untrusted commands before any SQL posting. No forecast arithmetic is stored.
"""
from calendar import monthrange
from datetime import date
from typing import Any

from .ledger_service import MAX_MINOR, _date, _integer, _reject, _shape, _uuid

MAX_EVENTS = 25_000
MAX_GOALS = 500
# A bounded whole-journal entity travels through the existing snapshot/delta.
MAX_JOURNAL_BYTES = 256_000
MAX_PROFILE_JOURNAL_BYTES = 1_000_000
CATEGORIES = ("emergency", "travel", "purchase", "education", "other")
FUNDING = ("virtual", "account-transfer")
USAGE = ("virtual-release", "account-transfer", "expense")
BASE = {"id", "type", "on"}
CONFIG = {"title", "category", "targetCents", "targetDate", "monthlyCents", "plannedFunding"}
CREATE = BASE | CONFIG | {"openingCents"}


def day(value: object) -> date:
    parsed = _date(value)
    if not 1900 <= parsed.year <= 2200:
        raise _reject("Дата цели вне допустимого диапазона")
    return parsed


def label(value: object, limit: int = 160) -> None:
    if (not isinstance(value, str) or not value.strip() or len(value) > limit
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise _reject("Недопустимый текст цели")


def config(changes: dict[str, Any]) -> None:
    if not changes or set(changes) - CONFIG:
        raise _reject("Недопустимые параметры цели")
    if "title" in changes:
        label(changes["title"])
    if "category" in changes and changes["category"] not in CATEGORIES:
        raise _reject("Неизвестная категория цели")
    if "targetCents" in changes:
        _integer(changes["targetCents"], 1, MAX_MINOR)
    if "targetDate" in changes:
        day(changes["targetDate"])
    if "monthlyCents" in changes and changes["monthlyCents"] is not None:
        _integer(changes["monthlyCents"], 0, MAX_MINOR)
    if "plannedFunding" in changes and changes["plannedFunding"] not in FUNDING:
        raise _reject("Недопустимый тип взноса")


def validate_event(event: object, *, public: bool) -> dict[str, Any]:
    if not isinstance(event, dict) or not isinstance(event.get("type"), str):
        raise _reject("Некорректное событие цели")
    kind = event["type"]
    fields, optional = BASE, set()
    if kind == "create":
        fields = CREATE
    elif kind == "update":
        fields = BASE | {"changes"}
    elif kind == "contribution":
        fields = BASE | {"amountCents", "funding"}
        optional = {"forDueOn"} | (set() if public else {"ledgerMovementId"})
    elif kind == "use":
        fields = BASE | {"amountCents", "usage"}
        optional = set() if public else {"ledgerMovementId"}
    elif kind == "skip":
        fields = BASE | {"dueOn"}
        optional = {"reason"}
    elif kind == "void":
        fields = BASE | {"eventId", "reason"}
        optional = set() if public else {"ledgerReversalId"}
    elif kind not in ("complete", "reopen", "archive", "restore"):
        raise _reject("Неизвестное событие цели")
    _shape(event, fields | optional, fields)
    _uuid(event["id"])
    day(event["on"])
    if kind == "create":
        config({k: event[k] for k in CONFIG})
        _integer(event["openingCents"], 0, MAX_MINOR)
    elif kind == "update":
        changes = _shape(event["changes"], CONFIG, set())
        config(dict(changes))
    elif kind in ("contribution", "use"):
        _integer(event["amountCents"], 1, MAX_MINOR)
        mode = event["funding"] if kind == "contribution" else event["usage"]
        if mode not in (FUNDING if kind == "contribution" else USAGE):
            raise _reject("Недопустимый тип движения")
        if "forDueOn" in event:
            day(event["forDueOn"])
        if not public:
            linked = mode not in ("virtual", "virtual-release")
            if linked != ("ledgerMovementId" in event):
                raise _reject("Отсутствует подтверждённая проводка")
            if linked:
                _uuid(event["ledgerMovementId"])
    elif kind == "skip":
        day(event["dueOn"])
        if "reason" in event:
            label(event["reason"], 500)
    elif kind == "void":
        _uuid(event["eventId"])
        label(event["reason"], 500)
        if "ledgerReversalId" in event:
            _uuid(event["ledgerReversalId"])
    return dict(event)


def month_due(start: date, offset: int) -> date | None:
    if not 1 <= offset <= 1200:
        return None
    year, month = divmod(start.year * 12 + start.month - 1 + offset, 12)
    if year > 2200:
        return None
    month += 1
    return date(year, month, min(start.day, monthrange(year, month)[1]))


def offset_between(start: date, other: date) -> int:
    return (other.year - start.year) * 12 + other.month - start.month


def due_anchor(start: date, target: object) -> date:
    parsed = day(target)
    if month_due(start, offset_between(start, parsed)) != parsed:
        raise _reject("Дата не соответствует ежемесячному взносу")
    return parsed


def deadline(start: date, target: object) -> None:
    parsed = day(target)
    limit = month_due(start, 1200)
    if parsed < start or (limit is not None and parsed > limit):
        raise _reject("Недопустимый срок цели")


def due_assignment(start: date, event: dict[str, Any]) -> date | None:
    if "forDueOn" in event:
        return due_anchor(start, event["forDueOn"])
    when = day(event["on"])
    offset = max(1, offset_between(start, when))
    for candidate in (month_due(start, offset), month_due(start, offset + 1)):
        if candidate is not None and candidate >= when:
            return candidate
    return None


def replay(events: list[dict[str, Any]]) -> dict[str, Any]:
    if not 1 <= len(events) <= MAX_EVENTS or events[0].get("type") != "create":
        raise _reject("Отсутствует создание цели или превышен журнал")
    by_id = {}
    order = {}
    refs = set()
    for index, event in enumerate(events):
        validate_event(event, public=False)
        if event["id"] in by_id or (index and event["type"] == "create"):
            raise _reject("Повтор события цели")
        by_id[event["id"]] = event
        order[event["id"]] = index
        ref = event.get("ledgerMovementId") or event.get("ledgerReversalId")
        if ref is not None:
            if ref in refs:
                raise _reject("Проводка уже связана с целью")
            refs.add(ref)
    created = events[0]
    start = day(created["on"])
    state = {k: created[k] for k in CONFIG}
    deadline(start, state["targetDate"])
    saved = 0
    status = "active"
    skipped = set()
    voided = set()
    installment_totals: dict[date, int] = {}
    for event in sorted(events, key=lambda row: row["on"]):
        kind, when = event["type"], day(event["on"])
        if when < start:
            raise _reject("Событие раньше создания цели")
        if kind in ("update", "contribution", "use", "skip", "void") and status != "active":
            raise _reject("Сначала возобновите цель")
        if kind == "create":
            saved += event["openingCents"]
        elif kind == "update":
            state.update(event["changes"])
            deadline(start, state["targetDate"])
        elif kind == "contribution":
            saved += event["amountCents"]
            due = due_assignment(start, event)
            if due is not None:
                installment_totals[due] = installment_totals.get(due, 0) + event["amountCents"]
                _integer(installment_totals[due], 0, MAX_MINOR)
        elif kind == "use":
            saved -= event["amountCents"]
        elif kind == "skip":
            due = due_anchor(start, event["dueOn"])
            if due in skipped:
                raise _reject("Взнос уже пропущен")
            skipped.add(due)
        elif kind == "void":
            target = by_id.get(event["eventId"])
            if (target is None or target["type"] not in ("contribution", "use", "skip")
                    or target["on"] > event["on"] or order[target["id"]] >= order[event["id"]]
                    or target["id"] in voided):
                raise _reject("Нельзя отменить это событие")
            if ("ledgerMovementId" in target) != ("ledgerReversalId" in event):
                raise _reject("Отмена требует связанной компенсирующей проводки")
            voided.add(target["id"])
            if target["type"] == "contribution":
                saved -= target["amountCents"]
                due = due_assignment(start, target)
                if due is not None:
                    installment_totals[due] -= target["amountCents"]
            elif target["type"] == "use":
                saved += target["amountCents"]
            else:
                skipped.remove(due_anchor(start, target["dueOn"]))
        elif kind == "complete":
            if status != "active" or saved < state["targetCents"]:
                raise _reject("Цель ещё не достигнута")
            status = "completed"
        elif kind == "reopen":
            if status != "completed":
                raise _reject("Цель не завершена")
            status = "active"
        elif kind == "archive":
            if status == "archived":
                raise _reject("Цель уже в архиве")
            status = "archived"
        elif kind == "restore":
            if status != "archived":
                raise _reject("Цель не в архиве")
            status = "active"
        _integer(saved, 0, MAX_MINOR)
    return {**state, "saved_minor": saved, "status": status}
