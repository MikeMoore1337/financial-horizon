import { MAX_TABLE_COLUMNS, MAX_TABLE_ROWS } from './csv.ts';
import type { BankTableRow, ImportWarning } from './types.ts';

const MAX_XLSX_BYTES = 6_000_000;
const MAX_ZIP_ENTRIES = 256;
const MAX_PART_BYTES = 8_000_000;
const MAX_TOTAL_UNCOMPRESSED = 24_000_000;
const MAX_CELLS = 120_000;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

interface ZipPart {
  method: number;
  plain: number;
  crc: number;
  compressed: Uint8Array;
}
interface XlsxResult {
  headers: string[];
  rows: BankTableRow[];
  warnings: ImportWarning[];
  sheetName: string;
  dateSystem: '1900' | '1904';
}

function bad(message: string): never { throw new Error(message); }
function u16(v: DataView, i: number): number { return v.getUint16(i, true); }
function u32(v: DataView, i: number): number { return v.getUint32(i, true); }

function extractEntries(bytes: Uint8Array): Map<string, ZipPart> {
  if (bytes.length < 22 || bytes.length > MAX_XLSX_BYTES) bad('XLSX пуст, повреждён или превышает 6 МБ');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(view, i) === 0x06054b50 && i + 22 + u16(view, i + 20) === bytes.length) {
      end = i; break;
    }
  }
  if (end < 0) bad('Не найден корректный каталог XLSX');
  if (u16(view, end + 4) || u16(view, end + 6)) bad('Многотомные ZIP не поддерживаются');
  const count = u16(view, end + 10), centralSize = u32(view, end + 12);
  const offset = u32(view, end + 16);
  if (!count || count > MAX_ZIP_ENTRIES || u16(view, end + 8) !== count ||
      offset === 0xffffffff || centralSize === 0xffffffff ||
      offset + centralSize > end) bad('Неподдерживаемый каталог ZIP');
  const entries = new Map<string, ZipPart>();
  let pos = offset, total = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || u32(view, pos) !== 0x02014b50) bad('Повреждён каталог ZIP');
    const flags = u16(view, pos + 8), method = u16(view, pos + 10);
    const crc = u32(view, pos + 16), zipped = u32(view, pos + 20);
    const plain = u32(view, pos + 24), nameLen = u16(view, pos + 28);
    const extraLen = u16(view, pos + 30), commentLen = u16(view, pos + 32);
    const disk = u16(view, pos + 34), local = u32(view, pos + 42);
    if (pos + 46 + nameLen + extraLen + commentLen > offset + centralSize) bad('Повреждён путь в ZIP');
    const name = UTF8.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;
    if ((flags & 1) || (flags & 0x40) || ![0, 8].includes(method) || disk) {
      bad('Зашифрованные или нестандартные архивы не поддерживаются');
    }
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') ||
        /[\u0000-\u001f]/.test(name)) bad('Небезопасный путь в XLSX');
    if (/^(?:xl\/(?:vbaProject\.bin|activeX\/|embeddings\/|externalLinks\/)|_xmlsignatures\/)/i.test(name)) {
      bad('Активное или внешнее содержимое XLSX не поддерживается');
    }
    if (plain > MAX_PART_BYTES || zipped > MAX_XLSX_BYTES) bad('Слишком большая часть XLSX');
    total += plain;
    if (total > MAX_TOTAL_UNCOMPRESSED) bad('Превышен лимит распакованных данных XLSX');
    if (entries.has(name)) bad('Повторяющиеся пути XLSX');
    if (local + 30 > offset || u32(view, local) !== 0x04034b50) bad('Повреждён заголовок части ZIP');
    if (u16(view, local + 8) !== method || u16(view, local + 6) !== flags) bad('Несогласованные заголовки ZIP');
    const localName = u16(view, local + 26), localExtra = u16(view, local + 28);
    const at = local + 30 + localName + localExtra;
    if (at + zipped > offset) bad('Часть XLSX обрезана');
    if (UTF8.decode(bytes.subarray(local + 30, local + 30 + localName)) !== name) {
      bad('Несовпадающие имена ZIP');
    }
    entries.set(name, { method, plain, crc, compressed: bytes.subarray(at, at + zipped) });
  }
  if (pos !== offset + centralSize) bad('Некорректный размер каталога ZIP');
  return entries;
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let x = i;
  for (let j = 0; j < 8; j++) x = (x >>> 1) ^ (x & 1 ? 0xedb88320 : 0);
  CRC_TABLE[i] = x >>> 0;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 255] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflate(part: ZipPart): Promise<Uint8Array> {
  if (part.method === 0) {
    if (part.compressed.length !== part.plain || crc32(part.compressed) !== part.crc) {
      bad('Неверная контрольная сумма XLSX');
    }
    return part.compressed;
  }
  if (typeof DecompressionStream !== 'function') bad('Браузер не поддерживает безопасную распаковку XLSX');
  const stream = new Blob([Uint8Array.from(part.compressed)])
    .stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > part.plain || size > MAX_PART_BYTES) bad('XLSX превышает лимит распаковки');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (size !== part.plain) bad('Недостоверный размер части XLSX');
  const output = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { output.set(chunk, at); at += chunk.length; }
  if (crc32(output) !== part.crc) bad('Контрольная сумма XLSX не совпала');
  return output;
}

async function xmlPart(entries: Map<string, ZipPart>, path: string): Promise<Document | null> {
  const part = entries.get(path);
  if (!part) return null;
  const raw = UTF8.decode(await inflate(part));
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(raw)) bad('Опасная XML-конструкция в XLSX');
  if (typeof DOMParser === 'undefined') bad('Для XLSX требуется браузерный DOMParser');
  const doc = new DOMParser().parseFromString(raw, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) bad('Повреждённый XML в XLSX');
  return doc;
}
function nodes(root: Document | Element | null, name: string): Element[] {
  return Array.from(root?.getElementsByTagNameNS('*', name) || []);
}
function child(root: Document | Element | null, name: string): Element | null {
  return nodes(root, name)[0] || null;
}
function combinedText(el: Element | null): string {
  return nodes(el, 't').map(node => node.textContent || '').join('');
}
function letterIndex(column: string): number {
  let result = 0;
  for (const letter of column) result = result * 26 + letter.charCodeAt(0) - 64;
  return result - 1;
}

function sheetRows(doc: Document, strings: string[]): { rows: BankTableRow[]; warnings: ImportWarning[] } {
  const rows: BankTableRow[] = [];
  const warnings: ImportWarning[] = [];
  let cells = 0;
  for (const row of nodes(doc, 'row')) {
    const index = Number(row.getAttribute('r'));
    if (!Number.isSafeInteger(index) || index < 1 || index > MAX_TABLE_ROWS + 1) bad('Слишком много строк XLSX');
    const values: (string | number | null)[] = [];
    const assigned = new Set<number>();
    for (const cell of nodes(row, 'c')) {
      if (++cells > MAX_CELLS) bad('Слишком много ячеек XLSX');
      const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(cell.getAttribute('r') || '');
      if (!match || Number(match[2]) !== index) bad('Некорректный адрес ячейки XLSX');
      const column = letterIndex(match[1] || '');
      if (column >= MAX_TABLE_COLUMNS || column < 0) bad('Слишком много колонок XLSX');
      if (assigned.has(column)) bad('Повторная ячейка в XLSX');
      assigned.add(column);
      const type = cell.getAttribute('t'), raw = child(cell, 'v')?.textContent || '';
      let value: string | number | null = null;
      if (child(cell, 'f')) {
        warnings.push({ code: 'FORMULA_IGNORED', severity: 'warning', row: index, column,
          message: 'Формула пропущена; её результат не используется' });
      } else if (type === 's') {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n >= strings.length) bad('Неверный индекс общей строки');
        value = strings[n] ?? null;
      } else if (type === 'inlineStr') value = combinedText(child(cell, 'is'));
      else if (type === 'str' || type === 'd') value = raw;
      else if (type === 'e') value = null;
      else if (raw !== '') {
        const n = Number(raw);
        value = Number.isFinite(n) ? n : null;
      }
      if (typeof value === 'string' && value.length > 16_384) bad('Слишком длинное поле XLSX');
      values[column] = value;
    }
    if (values.some(x => x !== null && x !== undefined && x !== '')) {
      rows.push({ rowNumber: index, cells: values });
      if (rows.length > MAX_TABLE_ROWS + 1) bad('Слишком много строк XLSX');
    }
  }
  return { rows, warnings };
}

/** Reads saved scalar cell values only. No workbook automation or formula evaluation. */
export async function readBankXlsx(
  data: Uint8Array | ArrayBuffer,
  options: { sheetName?: string } = {},
): Promise<XlsxResult> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const entries = extractEntries(bytes);
  const workbook = await xmlPart(entries, 'xl/workbook.xml');
  const relationships = await xmlPart(entries, 'xl/_rels/workbook.xml.rels');
  if (!workbook || !relationships) bad('Отсутствует структура книги XLSX');
  const allSheets = nodes(workbook, 'sheet');
  const sheet = options.sheetName
    ? allSheets.find(s => s.getAttribute('name') === options.sheetName)
    : allSheets.find(s => s.getAttribute('state') !== 'hidden' &&
      s.getAttribute('state') !== 'veryHidden');
  if (!sheet) bad('Не найден доступный лист XLSX');
  const id = sheet.getAttribute('r:id') ||
    sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
  const link = nodes(relationships, 'Relationship').find(r => r.getAttribute('Id') === id);
  if (!link || link.getAttribute('TargetMode') === 'External') bad('Неподдерживаемая ссылка на лист XLSX');
  let target = link.getAttribute('Target') || '';
  if (target.startsWith('/xl/')) target = target.slice(1);
  else if (!target.startsWith('xl/')) target = 'xl/' + target.replace(/^(?:\.\/)+/, '');
  if (!/^xl\/worksheets\/[a-zA-Z0-9_.-]+\.xml$/.test(target)) bad('Небезопасная ссылка на лист');
  const stringsXml = await xmlPart(entries, 'xl/sharedStrings.xml');
  const strings = stringsXml ? nodes(stringsXml, 'si').map(combinedText) : [];
  if (strings.length > 100_000) bad('Слишком много общих строк XLSX');
  const sheetXml = await xmlPart(entries, target);
  if (!sheetXml) bad('Лист XLSX отсутствует');
  const parsed = sheetRows(sheetXml, strings);
  if (parsed.rows.length < 2) bad('XLSX должен содержать заголовок и операции');
  const [header, ...rows] = parsed.rows;
  if (!header) bad('Отсутствует заголовок XLSX');
  const headers = header.cells.map(x => x === undefined || x === null ? '' : String(x));
  const date1904 = child(workbook, 'workbookPr')?.getAttribute('date1904');
  return {
    headers, rows, warnings: parsed.warnings,
    sheetName: sheet.getAttribute('name') || 'Лист',
    dateSystem: date1904 === '1' || date1904 === 'true' ? '1904' : '1900',
  };
}
