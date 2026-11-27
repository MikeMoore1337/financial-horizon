import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessCloudReleaseEvidenceCandidate,
  requiredCloudReleaseGates,
} from '../src/cloud/release-gate-candidate.mjs';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const gates = () => Object.fromEntries(requiredCloudReleaseGates().map(name => [name, {
  status: 'PASS', sourceSha: HEAD, evidence: ['https://example.invalid/evidence'],
}]));
const check = (state = gates(), sha = HEAD) =>
  assessCloudReleaseEvidenceCandidate({releaseSha: sha, gates: state});

test('release scope requires physical, independent and financial recovery gates', () => {
  const all = requiredCloudReleaseGates();
  assert.equal(all.length, new Set(all).size);
  for (const gate of [
    'human_independent_review',
    'accounts_real_fh_session_api_parity_33',
    'api_v2_public_contract_reviewed_67',
    'sync_explicit_conflict_resolution_68',
    'import_server_atomic_commit_and_replay_69',
    'email_real_two_mailboxes_51',
    'postgres_luks2_encryption_66',
    'postgres_wal_pitr_rpo_66',
    'postgres_isolated_restore_drill_66',
    'sync_encrypted_outbox_atomic_cas_34_68',
    'sync_two_users_two_devices_two_tabs_68',
    'import_guest_v1_v2_explicit_consent_69',
    'physical_ios_pwa_e2e_70',
    'production_exact_sha_receipt_70',
    'production_health_and_rollback_70',
  ]) assert.ok(all.includes(gate), gate);
});

test('missing, blocked, not-run, failure and prior-SHA CI all deny release', () => {
  const state = gates();
  delete state.human_independent_review;
  state.email_real_two_mailboxes_51 = {status: 'NOT_RUN'};
  state.postgres_wal_pitr_rpo_66 = {status: 'BLOCKED'};
  state.production_health_and_rollback_70 = {status: 'FAIL'};
  state.source_sha_and_required_ci = {
    status: 'PASS', sourceSha: OTHER,
    evidence: ['https://github.com/example/workflow'],
  };
  const result = check(state);
  assert.equal(result.status, 'NO_GO');
  assert.ok(result.missing.includes('human_independent_review'));
  assert.ok(result.pending.includes('email_real_two_mailboxes_51'));
  assert.ok(result.pending.includes('postgres_wal_pitr_rpo_66'));
  assert.ok(result.pending.includes('production_health_and_rollback_70'));
  assert.ok(result.failed.includes('source_sha_and_required_ci'));
  assert.equal(result.deploymentAuthorized, false);
  assert.equal(result.publicCloudEnabled, false);
});

test('even all self-reported green evidence CANNOT establish real GO', () => {
  const result = check();
  assert.equal(result.status, 'NEEDS_EXTERNAL_ATTESTATION');
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.pending, []);
  assert.equal(result.evidenceIsSelfReported, true);
  assert.equal(result.independentVerificationPerformed, false);
  assert.equal(result.deploymentAuthorized, false);
  assert.equal(result.publicCloudEnabled, false);
});

test('green generic checks cannot hide unverified public v2 and atomic import', () => {
  const supplied = gates();
  for (const name of [
    'accounts_real_fh_session_api_parity_33',
    'api_v2_public_contract_reviewed_67',
    'sync_explicit_conflict_resolution_68',
    'import_server_atomic_commit_and_replay_69',
  ]) {
    delete supplied[name];
  }
  const result = check(supplied);
  assert.equal(result.status, 'NO_GO');
  assert.equal(result.deploymentAuthorized, false);
  assert.equal(result.publicCloudEnabled, false);
  for (const required of [
    'accounts_real_fh_session_api_parity_33',
    'api_v2_public_contract_reviewed_67',
    'sync_explicit_conflict_resolution_68',
    'import_server_atomic_commit_and_replay_69',
  ]) assert.ok(result.missing.includes(required), required);
});

test('invalid evidence and non-HTTPS links fail closed', () => {
  const x = gates();
  x.human_independent_review.evidence = ['http://unsafe.invalid/approval'];
  assert.ok(check(x).failed.includes('human_independent_review'));
  x.human_independent_review.evidence = [];
  assert.ok(check(x).failed.includes('human_independent_review'));
  const y = gates();
  y.postgres_luks2_encryption_66.sourceSha = OTHER;
  assert.ok(check(y).failed.includes('postgres_luks2_encryption_66'));
  assert.throws(() => assessCloudReleaseEvidenceCandidate({
    releaseSha: 'bad', gates,
  }), TypeError);
  assert.throws(() => check({...gates(), surprise: {status:'PASS'}}), TypeError);
});


test('private owner release omits costly disk/PITR/inbox gates but never authorizes self reported claims', () => {
  const personal = requiredCloudReleaseGates('private-single-user');
  assert.ok(personal.includes('postgres_encrypted_backup_and_local_restore_66'));
  assert.ok(personal.includes('email_existing_owner_session_security_51'));
  assert.ok(personal.includes('import_server_atomic_commit_and_replay_69'));
  assert.ok(!personal.includes('postgres_luks2_encryption_66'));
  assert.ok(!personal.includes('postgres_wal_pitr_rpo_66'));
  assert.ok(!personal.includes('email_real_two_mailboxes_51'));
  assert.equal(personal.length, new Set(personal).size);

  const personalEvidence = Object.fromEntries(personal.map(name => [name, {
    status: 'PASS', sourceSha: HEAD, evidence: ['https://example.invalid/claim'],
  }]));
  const claimed = assessCloudReleaseEvidenceCandidate({
    mode: 'private-single-user', publicRegistrationEnabled: false,
    releaseSha: HEAD, gates: personalEvidence,
  });
  assert.equal(claimed.mode, 'private-single-user');
  assert.equal(claimed.status, 'NEEDS_EXTERNAL_ATTESTATION');
  assert.equal(claimed.deploymentAuthorized, false);
  assert.equal(claimed.publicCloudEnabled, false);

  for (const registration of [undefined, true]) {
    assert.throws(() => assessCloudReleaseEvidenceCandidate({
      mode: 'private-single-user', publicRegistrationEnabled: registration,
      releaseSha: HEAD, gates: personalEvidence,
    }), TypeError);
  }
  const missing = {...personalEvidence};
  delete missing.import_real_encrypted_restore_69;
  const denied = assessCloudReleaseEvidenceCandidate({
    mode: 'private-single-user', publicRegistrationEnabled: false,
    releaseSha: HEAD, gates: missing,
  });
  assert.equal(denied.status, 'NO_GO');
  assert.ok(denied.missing.includes('import_real_encrypted_restore_69'));
  assert.throws(() => requiredCloudReleaseGates('untrusted'), TypeError);
});
