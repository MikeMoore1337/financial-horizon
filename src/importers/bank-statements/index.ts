import { readBankCsv, type CsvDelimiter, type CsvEncoding } from './csv.ts';
import { readBankXlsx } from './xlsx.ts';
import { sha256 } from './normalize.ts';
import type { BankStatementTable } from './types.ts';

export { readBankCsv } from './csv.ts';
export { readBankXlsx } from './xlsx.ts';
export { sha256, suggestColumnMapping, normalizeBankStatement } from './normalize.ts';
export {
  reconcileBankStatement, draftBankImportBatch, draftBankImportUndo, projectAccountBalances,
} from './reconcile.ts';
export type * from './types.ts';

export interface ReadStatementOptions {
  filename?: string;
  format?: 'csv' | 'xlsx';
  csvEncoding?: CsvEncoding;
  csvDelimiter?: CsvDelimiter;
  sheetName?: string;
  /** One-based physical row number, allowing bank-generated report preambles. */
  headerRowNumber?: number;
}

/**
 * Runs only in the calling browser. The caller obtains file.arrayBuffer()
 * from a user-selected File; this module never uses fetch, storage, or APIs.
 */
export async function readBankStatementFile(
  payload: ArrayBuffer | Uint8Array, options: ReadStatementOptions = {},
): Promise<BankStatementTable> {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const filename = (options.filename || 'statement').split(/[\\/]/).pop()?.slice(0, 160) || 'statement';
  if (/\.(?:xlsm|xlsb|xls)$/i.test(filename)) {
    throw new Error('Макросы и старые форматы Excel не поддерживаются. Используйте .xlsx или .csv');
  }
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const format = options.format || (/\.xlsx$/i.test(filename) ? 'xlsx' : zip ? 'xlsx' : 'csv');
  if (format === 'xlsx' && !zip) throw new Error('Файл не является XLSX-архивом');
  if (format === 'csv' && zip) throw new Error('ZIP-архив нельзя обработать как CSV');
  // Enforce limits before hashing: crypto.subtle.digest buffers the entire input.
  const maxBytes = format === 'xlsx' ? 6_000_000 : 4_000_000;
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw new Error('Файл пуст или превышает лимит ' + (format === 'xlsx' ? '6 МБ' : '4 МБ'));
  }
  const fileDigest = await sha256(bytes);
  if (format === 'xlsx') {
    const parsed = await readBankXlsx(bytes, { sheetName: options.sheetName, headerRowNumber: options.headerRowNumber });
    return { format, fileDigest, filename, ...parsed };
  }
  const parsed = readBankCsv(bytes, {
    encoding: options.csvEncoding,
    delimiter: options.csvDelimiter,
    headerRowNumber: options.headerRowNumber,
  });
  return {
    format, fileDigest, filename, headers: parsed.headers,
    rows: parsed.rows, warnings: parsed.warnings, headerRowNumber: parsed.headerRowNumber,
  };
}
