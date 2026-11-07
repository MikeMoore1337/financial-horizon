"""Generate synthetic bank XLSX fixtures. Never use personal statements in tests."""
from __future__ import annotations

from datetime import date
from html import escape
from pathlib import Path
import sys
from zipfile import ZipFile, ZIP_DEFLATED


HEADERS = [
    "Дата", "Сумма", "Описание", "Счёт", "Счёт назначения",
    "Тип", "Категория", "ID",
]


def cell(ref: str, value: str, *, numeric: bool = False) -> str:
    if numeric:
        return f'<c r="{ref}"><v>{value}</v></c>'
    return f'<c r="{ref}" t="inlineStr"><is><t>{escape(value)}</t></is></c>'


def row(number: int, values: list[str], *, numeric: set[int] | None = None) -> str:
    numeric = numeric or set()
    return f'<row r="{number}">' + "".join(
        cell(f"{chr(65 + i)}{number}", value, numeric=i in numeric)
        for i, value in enumerate(values)
    ) + "</row>"


def date_serial(when: date) -> str:
    return str((when - date(1899, 12, 30)).days)


def main() -> None:
    if len(sys.argv) not in (2, 3):
        raise SystemExit("usage: make_bank_xlsx.py OUTPUT [--bomb|--doctype|--external|--corrupt]")
    path = Path(sys.argv[1])
    variant = sys.argv[2] if len(sys.argv) == 3 else ""
    path.parent.mkdir(parents=True, exist_ok=True)
    workbook = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Выписка" sheetId="1" r:id="rId1"/></sheets></workbook>'
    )
    relationships = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1"'
        ' Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"'
        ' Target="worksheets/sheet1.xml"/></Relationships>'
    )
    rows = [
        row(1, HEADERS),
        row(2, [
            date_serial(date(2026, 11, 7)), "-1234.50",
            "Синтетическая покупка", "Основной", "", "расход", "Питание", "SYN-001",
        ], numeric={0, 1}),
        row(3, [
            "08.11.2026", "1500.25", "Тестовое поступление", "Основной", "",
            "доход", "Зарплата", "SYN-002",
        ], numeric={1}),
        '<row r="4">' + cell("A4", "09.11.2026")
        + '<c r="B4"><f>100+200</f><v>300</v></c>'
        + ''.join(cell(f"{chr(65 + i)}4", val) for i, val in enumerate(
            ["Формула не должна использоваться", "Основной", "", "доход", "Зарплата", "SYN-003"], 2))
        + '</row>',
        row(5, [
            "10.11.2026", "-500", "Между своими счетами", "Основной",
            "Накопительный", "перевод", "", "SYN-004",
        ], numeric={1}),
    ]
    worksheet = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<sheetData>' + ''.join(rows) + '</sheetData></worksheet>'
    )
    if variant == "--doctype":
        worksheet = '<!DOCTYPE worksheet [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' + worksheet
    with ZipFile(path, "w", compression=ZIP_DEFLATED) as zf:
        zf.writestr("xl/workbook.xml", workbook)
        zf.writestr("xl/_rels/workbook.xml.rels", relationships)
        zf.writestr("xl/worksheets/sheet1.xml", worksheet)
        if variant == "--external":
            zf.writestr("xl/externalLinks/externalLink1.xml", "<externalLink/>")
        if variant == "--bomb":
            zf.writestr("xl/worksheets/bomb.xml", "A" * 8_000_001)
    if variant == "--corrupt":
        buf = bytearray(path.read_bytes())
        # Corrupt compressed bytes while keeping central directory intact.
        index = buf.find(b"PK\x03\x04")
        if index >= 0 and len(buf) > index + 44:
            buf[index + 44] ^= 1
        path.write_bytes(buf)


if __name__ == "__main__":
    main()
