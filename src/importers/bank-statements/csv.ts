import type { BankTableRow, ImportWarning } from './types.ts';

export const MAX_CSV_BYTES = 4_000_000;
export const MAX_TABLE_ROWS = 10_000;
export const MAX_TABLE_COLUMNS = 64;
const MAX_CELL_LENGTH = 16_384;

export type CsvEncoding = 'auto' | 'utf-8' | 'windows-1251' | 'windows-1252' | 'ibm866' | 'utf-16le' | 'utf-16be';
export type CsvDelimiter = ',' | ';' | '\t' | '|';

export interface ParsedCsv {
  encoding: string;
  delimiter: CsvDelimiter;
  headers: string[];
  rows: BankTableRow[];
  warnings: ImportWarning[];
  headerRowNumber: number;
}

function fail(message: string): never {
  throw new Error(message);
}

function decode(bytes: Uint8Array, encoding: CsvEncoding): { text: string; encoding: string } {
  if (!bytes.length || bytes.length > MAX_CSV_BYTES) fail('CSV пуст или превышает лимит 4 МБ');
  const bom: CsvEncoding | null =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8' :
    bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' :
    bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  const picked = encoding === 'auto' ? bom || 'utf-8' : encoding;
  let text: string;
  let actual = picked;
  try {
    text = new TextDecoder(picked, { fatal: true }).decode(bytes);
  } catch {
    if (encoding !== 'auto' || bom) fail('Некорректная кодировка CSV');
    actual = 'windows-1251';
    text = new TextDecoder(actual, { fatal: true }).decode(bytes);
  }
  text = text.replace(/^\uFEFF/, '');
  if (text.includes('\0')) fail('CSV содержит недопустимые нулевые символы');
  return { text, encoding: actual };
}

function columnsOnLine(text: string, delimiter: CsvDelimiter): number[] {
  const counts: number[] = [];
  let quoted = false, inField = false, count = 0;
  for (let i = 0; i < text.length && counts.length < 12; i++) {
    const c = text[i];
    if (c === '"' && (!inField || quoted)) {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
      inField = true;
    } else if (c === delimiter && !quoted) {
      count++; inField = false;
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (count || inField) counts.push(count);
      count = 0; inField = false;
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else if (c !== ' ' && c !== '\t') inField = true;
  }
  if ((count || inField) && counts.length < 12) counts.push(count);
  return counts;
}

function detectDelimiter(text: string): CsvDelimiter {
  let best: CsvDelimiter = ';', score = -1;
  for (const delimiter of [';', '\t', ',', '|'] as CsvDelimiter[]) {
    const counts = columnsOnLine(text, delimiter).filter(x => x > 0);
    if (!counts.length) continue;
    const frequency = new Map<number, number>();
    for (const count of counts) frequency.set(count, (frequency.get(count) || 0) + 1);
    const mode = [...frequency].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    if (!mode) continue;
    const candidate = mode[1] * 100 + Math.min(mode[0], 32) + counts.length;
    if (candidate > score) { score = candidate; best = delimiter; }
  }
  if (score < 0) fail('CSV должен содержать хотя бы две колонки');
  return best;
}

function parseDelimited(text: string, delimiter: CsvDelimiter, firstLine = 1): BankTableRow[] {
  const rows: BankTableRow[] = [];
  let row: string[] = [], cell = '', quoted = false, afterQuote = false;
  let line = firstLine, startLine = firstLine;
  const pushCell = () => {
    if (cell.length > MAX_CELL_LENGTH) fail('Слишком длинная ячейка CSV');
    row.push(cell.trim());
    if (row.length > MAX_TABLE_COLUMNS) fail('CSV превышает лимит 64 колонок');
    cell = ''; afterQuote = false;
  };
  const pushRow = () => {
    pushCell();
    if (row.some(x => x.length)) {
      rows.push({ rowNumber: startLine, cells: row });
      if (rows.length > MAX_TABLE_ROWS + 1) fail('CSV превышает лимит 10 000 операций');
    }
    row = [];
    startLine = line;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; afterQuote = true; }
      } else {
        cell += c;
        if (c === '\n') line++;
        if (c === '\r') { line++; if (text[i + 1] === '\n') { cell += text[++i]; } }
      }
    } else if (c === '"' && !cell && !afterQuote) {
      quoted = true;
    } else if (c === delimiter) {
      pushCell();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      line++; pushRow();
    } else if (afterQuote) {
      if (c !== ' ' && c !== '\t') fail('Недопустимый символ после кавычек в CSV');
    } else {
      if (c === '"') fail('Кавычки в CSV должны окружать поле');
      cell += c;
      if (cell.length > MAX_CELL_LENGTH) fail('Слишком длинная ячейка CSV');
    }
  }
  if (quoted) fail('Незакрытые кавычки в CSV');
  if (row.length || cell || afterQuote) pushRow();
  return rows;
}

/** RFC-4180 quoting + CSV dialect/encoding detection; returns data only. */
export function readBankCsv(
  data: Uint8Array | ArrayBuffer,
  options: { encoding?: CsvEncoding; delimiter?: CsvDelimiter; headerRowNumber?: number } = {},
): ParsedCsv {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const { text, encoding } = decode(bytes, options.encoding || 'auto');
  const directive = /^sep=([;,\t|])\r?\n/i.exec(text);
  const content = directive ? text.slice(directive[0].length) : text;
  const delimiter = options.delimiter || detectDelimiter(content);
  // Keep the physical line numbers from the original statement, even when
  // Excel's optional sep= directive is present at line 1.
  const rows = parseDelimited(content, delimiter, directive ? 2 : 1);
  if (rows.length < 2) fail('CSV должен содержать заголовок и хотя бы одну строку');
  const requested = options.headerRowNumber;
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > 100)) {
    fail('Некорректный номер строки заголовка CSV');
  }
  const headerIndex = requested === undefined ? 0 : rows.findIndex(r => r.rowNumber === requested);
  if (headerIndex < 0 || headerIndex >= rows.length - 1) fail('Строка заголовка CSV не найдена');
  const headerRow = rows[headerIndex];
  if (!headerRow) fail('В CSV отсутствует заголовок');
  const headers = headerRow.cells.map(x => String(x || ''));
  rows.splice(0, headerIndex + 1);
  const warnings: ImportWarning[] = [];
  if (encoding === 'windows-1251' && (!options.encoding || options.encoding === 'auto')) {
    warnings.push({ code: 'ENCODING_GUESSED', severity: 'warning',
      message: 'Предположена кодировка Windows-1251; проверьте кириллицу перед импортом' });
  }
  if (headerIndex > 0) {
    warnings.push({ code: 'SKIPPED_PREAMBLE', severity: 'info',
      message: 'Строки перед выбранным заголовком пропущены', row: headerRow.rowNumber });
  }
  if (new Set(headers.map(h => h.toLocaleLowerCase('ru-RU'))).size < headers.length) {
    warnings.push({ code: 'DUPLICATE_HEADER', severity: 'warning', message: 'Повторяющиеся названия колонок' });
  }
  for (const row of rows) {
    if (row.cells.length !== headers.length) {
      warnings.push({
        code: 'ROW_WIDTH', severity: 'warning', row: row.rowNumber,
        message: 'Количество колонок не совпадает с заголовком',
      });
    }
  }
  return { encoding, delimiter, headers, rows, warnings, headerRowNumber: headerRow.rowNumber };
}
