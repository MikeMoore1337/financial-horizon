/**
 * Financial Horizon #39: explicit, local-only bank schedule acceptance helper.
 * No fetch, API key, IndexedDB access, output file or network transfer.
 * Run on an owner-controlled machine; never submit real bank data to CI.
 */
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSchedule } from '../schedule.js';
import { calculateLoan, reconcileLoanSchedule } from '../src/domain/loans/index.ts';

const CONTRACT_LIMIT = 128 * 1024;
const CSV_LIMIT = 1024 * 1024;

export async function readLimited(path, limit) {
  // Keep the read bounded even for a huge file, a FIFO or a file being edited:
  // never read the full content into memory before enforcing its byte limit.
  // Open once, non-blocking and without following symlinks where supported.
  // Validate the opened descriptor: no time-of-check/time-of-use path race.
  // O_NONBLOCK stops a FIFO without a writer from blocking at open().
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) |
    (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size === 0 || opened.size > limit) {
      throw new RangeError('Input must be a bounded regular file');
    }
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    if (count === 0 || count > limit) throw new RangeError('Input size is unsupported');
    return bytes.subarray(0, count).toString('utf8');
  } finally {
    await handle.close();
  }
}

export function compareLocalBankCsv(contract, csvText, includeDeltas = false) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract) ||
      contract.schemaVersion !== 1 || !contract.terms ||
      typeof contract.terms !== 'object' || Array.isArray(contract.terms)) {
    throw new TypeError('Expected a versioned loan contract');
  }
  const events = contract.events ?? [];
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  const options = contract.options ?? { mode: 'plan' };
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      !['plan', 'actual', 'forecast'].includes(options.mode)) {
    throw new TypeError('Invalid calculation options');
  }
  const calculated = calculateLoan(contract.terms, events, options);
  const imported = parseSchedule(csvText);
  const reconciliation = reconcileLoanSchedule(calculated, imported);
  const differences = reconciliation.rows.filter(row => row.differs);
  const missingBreakdownRows = reconciliation.rows
    .filter(row => row.missingFields.length > 0).length;
  const unallocatedRows = reconciliation.rows
    .filter(row => row.bankUnallocatedCents !== null && row.bankUnallocatedCents !== 0).length;

  const summary = {
    schemaVersion: 1,
    calculatedRows: calculated.rows.length,
    importedRows: imported.length,
    mismatchedRows: reconciliation.mismatchedRows,
    missingBreakdownRows,
    unallocatedBankRows: unallocatedRows,
    closureDateDifferenceDays: reconciliation.closureDateDifferenceDays,
    matchingKnownFields: reconciliation.matchingKnownFields,
    comparisonComplete: reconciliation.comparisonComplete,
    arithmeticExactMatch: reconciliation.exactMatch,
    bankParityVerified: false,
    factualPaymentsIgnored: options.mode === 'plan'
      ? events.filter(event => event?.type === 'payment' && !event.voidedAt).length : 0,
  };
  if (!includeDeltas) return summary;
  // Row numbers and arithmetic deltas only. Neither raw banking rows nor
  // financial amounts, user identifiers, account references or file paths
  // are copied into terminal output.
  return {
    ...summary,
    differences: differences.map(row => ({
      period: row.period,
      dateDifferenceDays: row.dateDifferenceDays,
      amountDeltaCents: row.amountDeltaCents,
      interestDeltaCents: row.interestDeltaCents,
      principalDeltaCents: row.principalDeltaCents,
      balanceDeltaCents: row.balanceDeltaCents,
      bankUnallocatedCents: row.bankUnallocatedCents,
      missingFields: row.missingFields,
    })),
  };
}

function parseArguments(argv) {
  const positional = [];
  let json = false;
  let details = false;
  for (const arg of argv) {
    if (arg === '--json' && !json) json = true;
    else if (arg === '--details' && !details) details = true;
    else if (arg.startsWith('--')) throw new TypeError('Unknown or duplicate argument');
    else positional.push(arg);
  }
  if (positional.length !== 2) throw new TypeError('Expected contract JSON and bank CSV');
  return { contractPath: positional[0], csvPath: positional[1], json, details };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { contractPath, csvPath, json, details } = parseArguments(argv);
    const contract = JSON.parse(await readLimited(contractPath, CONTRACT_LIMIT));
    const csvText = await readLimited(csvPath, CSV_LIMIT);
    const result = compareLocalBankCsv(contract, csvText, details);
    if (json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(
        'Локальная сверка графика (без отправки данных)\n' +
        'Совпало известных полей: ' + (result.matchingKnownFields ? 'да' : 'нет') + '\n' +
        'Полнота банковских колонок: ' + (result.comparisonComplete ? 'полная' : 'неполная') + '\n' +
        'Строк с расхождениями: ' + result.mismatchedRows + '\n' +
        'Строк без части показателей: ' + result.missingBreakdownRows + '\n' +
        'Строк с нераспределёнными суммами: ' + result.unallocatedBankRows + '\n' +
        'Совпадение по заданной модели: ' + (result.arithmeticExactMatch ? 'да' : 'нет') + '\n' +
        'Правила конкретного банка подтверждены: нет\n'
      );
      if (details) process.stdout.write(JSON.stringify(result.differences, null, 2) + '\n');
    }
    return result.arithmeticExactMatch ? 0 : 2;
  } catch {
    // Some CSV parsers embed invalid cell values in errors. Never echo
    // original exception messages that could reveal personal financial data.
    process.stderr.write('Ошибка: проверьте локальные файлы, формат CSV и параметры договора.\n');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
