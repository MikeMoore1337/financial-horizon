/**
 * #39: local acceptance of multiple owner-approved anonymized bank references.
 * No network, no stored output, no real bank inputs in CI.
 * Self-attested references are not independent proof of bank parity.
 */
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { relative, resolve, dirname, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareLocalBankCsv, readLimited } from './compare-bank-loan.mjs';
import { parseSchedule } from '../schedule.js';

const MANIFEST_LIMIT = 64 * 1024;
const CONTRACT_LIMIT = 128 * 1024;
const CSV_LIMIT = 1024 * 1024;
const MAX_REFERENCES = 12;

async function localReferencePath(base, supplied) {
  if (typeof supplied !== 'string' || !supplied.trim() ||
      supplied.includes('\0') || isAbsolute(supplied)) {
    throw new TypeError('A relative local reference path is required');
  }
  const full = resolve(base, supplied);
  const pathWithin = relative(base, full);
  if (!pathWithin || pathWithin === '..' || pathWithin.startsWith('..' + sep) ||
      isAbsolute(pathWithin)) {
    throw new TypeError('Reference files must be inside the manifest directory');
  }
  // Resolve all intermediate symlinks before opening. The lexical path alone
  // cannot constrain a symlinked parent directory to this private root.
  const realBase = await realpath(base);
  const realTarget = await realpath(full);
  const realWithin = relative(realBase, realTarget);
  if (!realWithin || realWithin === '..' || realWithin.startsWith('..' + sep) ||
      isAbsolute(realWithin)) {
    throw new TypeError('Reference path escapes the manifest root through a symlink');
  }
  return realTarget;
}

/**
 * Only bounded local file reads. Do not return names, amounts, dates, hashes,
 * individual bank rows or terms. Duplicate reference content is rejected.
 */
export async function verifyBankLoanReferences(manifestPath) {
  const fullManifestPath = resolve(manifestPath);
  const manifest = JSON.parse(await readLimited(fullManifestPath, MANIFEST_LIMIT));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      manifest.schemaVersion !== 1 || !Array.isArray(manifest.cases) ||
      manifest.cases.length < 2 || manifest.cases.length > MAX_REFERENCES) {
    throw new TypeError('Expected 2-12 versioned reference cases');
  }

  const base = dirname(fullManifestPath);
  const seenSources = new Set();
  const seenContents = new Set();
  let arithmeticMatches = 0;
  let incompleteReferences = 0;

  for (const entry of manifest.cases) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        entry.approvedForLocalAcceptance !== true) {
      throw new TypeError('Each reference must be explicitly owner-attested');
    }
    const termsFile = await localReferencePath(base, entry.contractFile);
    const bankFile = await localReferencePath(base, entry.bankCsvFile);
    if (termsFile === bankFile || seenSources.has(bankFile)) {
      throw new TypeError('Each reference must have its own bank file');
    }
    seenSources.add(bankFile);
    const contract = JSON.parse(await readLimited(termsFile, CONTRACT_LIMIT));
    const bankCsv = await readLimited(bankFile, CSV_LIMIT);
    // Normalize parsed dates, currency minor units and missing optional fields.
    // Equivalent CSVs with different formatting are the same reference.
    const normalizedRows = parseSchedule(bankCsv, { allowMissingBalance: true }).map(row => [
      row.date, row.amountCents, row.interestCents ?? null,
      row.principalCents ?? null, row.balanceCents ?? null,
    ]);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(normalizedRows)).digest('hex');
    if (seenContents.has(fingerprint)) {
      throw new TypeError('Duplicate bank reference content is not independent evidence');
    }
    seenContents.add(fingerprint);

    const result = compareLocalBankCsv(contract, bankCsv);
    if (result.arithmeticExactMatch) arithmeticMatches++;
    if (!result.comparisonComplete) incompleteReferences++;
  }

  return {
    schemaVersion: 1,
    referencesChecked: manifest.cases.length,
    arithmeticMatches,
    notExactReferences: manifest.cases.length - arithmeticMatches,
    incompleteReferences,
    allArithmeticExact: arithmeticMatches === manifest.cases.length,
    ownerAttestationOnly: true,
    bankParityVerified: false,
  };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (argv.length !== 1) throw new TypeError('Expected private manifest path');
    const result = await verifyBankLoanReferences(argv[0]);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result.allArithmeticExact ? 0 : 2;
  } catch {
    // Never echo a private CSV cell, financial value, path or JSON parser error.
    process.stderr.write('Ошибка локальной сверки: проверьте закрытые файлы и параметры.\n');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
