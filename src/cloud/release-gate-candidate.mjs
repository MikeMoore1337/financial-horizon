/**
 * #70 - fail-closed release evidence preflight. This is NOT an independent
 * security review, production check, or approval token.
 *
 * All inputs are untrusted claims. Even a complete set of PASS claims must
 * be independently authenticated against GitHub, runtime and restore logs;
 * this helper can only produce NO_GO or NEEDS_EXTERNAL_ATTESTATION.
 */
const shaPattern = /^[0-9a-f]{40}$/;
const requiredGates = Object.freeze([
  'source_sha_and_required_ci',
  'human_independent_review',
  'email_human_security_review_51',
  'email_real_two_mailboxes_51',
  'email_real_turnstile_and_rate_limits_51',
  'postgres_luks2_encryption_66',
  'postgres_encrypted_offsite_backup_66',
  'postgres_wal_pitr_rpo_66',
  'postgres_isolated_restore_drill_66',
  'postgres_rollback_rto_66',
  'postgres_load_disk_and_observability_45',
  'api_verified_linked_void_67',
  'sync_encrypted_outbox_atomic_cas_34_68',
  'sync_two_users_two_devices_two_tabs_68',
  'import_guest_v1_v2_explicit_consent_69',
  'import_real_encrypted_restore_69',
  'browser_chromium_webkit_auth_e2e_70',
  'physical_ios_pwa_e2e_70',
  'production_exact_sha_receipt_70',
  'production_health_and_rollback_70',
]);
const gateStates = new Set(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']);
function isPlainRecord(value) {
  return value !== null && typeof value === 'object' &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
export function requiredCloudReleaseGates() {
  return [...requiredGates];
}
export function assessCloudReleaseEvidenceCandidate(input) {
  if (!isPlainRecord(input) || !shaPattern.test(input.releaseSha) ||
      !isPlainRecord(input.gates)) {
    throw new TypeError('Invalid release evidence envelope');
  }
  const actualNames = Object.keys(input.gates);
  if (actualNames.some(name => !requiredGates.includes(name))) {
    throw new TypeError('Unexpected release gate');
  }
  const missing = [], failed = [], pending = [];
  for (const name of requiredGates) {
    const entry = input.gates[name];
    if (!isPlainRecord(entry)) {
      missing.push(name);
      continue;
    }
    if (!gateStates.has(entry.status) ||
        (entry.sourceSha !== undefined && !shaPattern.test(entry.sourceSha))) {
      failed.push(name);
      continue;
    }
    if (entry.status !== 'PASS') {
      pending.push(name);
      continue;
    }
    if (entry.sourceSha !== input.releaseSha ||
        !Array.isArray(entry.evidence) || entry.evidence.length === 0 ||
        entry.evidence.some(link => typeof link !== 'string' ||
          !link.startsWith('https://') || link.length > 1024)) {
      // A successful CI on another SHA is not release acceptance.
      failed.push(name);
    }
  }
  const incomplete = missing.length > 0 || failed.length > 0 || pending.length > 0;
  return Object.freeze({
    status: incomplete ? 'NO_GO' : 'NEEDS_EXTERNAL_ATTESTATION',
    releaseSha: input.releaseSha,
    missing, failed, pending,
    evidenceIsSelfReported: true,
    publicCloudEnabled: false,
    deploymentAuthorized: false,
    // Never mistake this offline inventory for independently verified
    // GitHub review, physical inbox/phone test, LUKS2 or offsite restore.
    independentVerificationPerformed: false,
  });
}
