// Issue #65: architecture contract checks. NO server/DB/browser implementation is exercised.
// These synthetic tests define requirements for #66-#70; a PASS is not a live sync E2E.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const load = name => JSON.parse(readFileSync(new URL('../docs/architecture/' + name, import.meta.url), 'utf8'));
const spec = load('finance-sync-v1.openapi.json');
const samples = load('finance-sync-contract-fixtures.json');
const uu = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function eachRef(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) eachRef(child, fn); return; }
  for (const [key,value] of Object.entries(node)) {
    if (key === '$ref') fn(value);
    else eachRef(value,fn);
  }
}
function validateMoney(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) validateMoney(x); return; }
  for (const [key,value] of Object.entries(node)) {
    if (key.endsWith('_minor') || key.endsWith('Cents')) {
      assert.equal(typeof value, 'number', 'money must be a JSON number');
      assert.ok(Number.isSafeInteger(value), 'money must be a safe integer');
      assert.ok(Math.abs(value) <= 1_000_000_000_000, 'money cap');
    } else validateMoney(value);
  }
}
function validateCommand(cmd) {
  assert.equal(cmd.schema_version, 1);
  assert.match(cmd.client_mutation_id, uu);
  assert.ok(Number.isSafeInteger(cmd.base_revision) && cmd.base_revision >= 0);
  assert.ok(!Object.hasOwn(cmd, 'user_id') && !Object.hasOwn(cmd, 'owner_user_id'), 'owner from auth only');
  assert.ok(!Object.hasOwn(cmd, 'profile_id'), 'profile from authorized server scope');
  assert.ok(spec.components.schemas.Command.properties.action.enum.includes(cmd.action));
  assert.equal(cmd.action,'account.transfer');
  const x=cmd.payload;
  assert.match(x.from_account_id,uu); assert.match(x.to_account_id,uu);
  assert.notEqual(x.from_account_id,x.to_account_id);
  assert.ok(Number.isSafeInteger(x.amount_minor) && x.amount_minor > 0 && x.amount_minor<=1_000_000_000_000);
  assert.match(x.occurred_on,/^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Object.hasOwn(cmd.expected_entity_revisions,x.from_account_id));
  assert.ok(Object.hasOwn(cmd.expected_entity_revisions,x.to_account_id));
  validateMoney(cmd);
}

// Reference-only server model. Deliberately minimal and not the real FastAPI service.
function referenceModel(fixture) {
  const state=new Map(fixture.profiles.map(p=>[p.id,{
    ...p,accounts:new Map(p.accounts.map(a=>[a.id,{...a}])),
    receipts:new Map(),postings:[],revision:p.revision
  }]));
  const token = p => '"fh.1.' + p.revision + '.' + (p.label==='U1'?'0ce5':'a5b0') + '"';
  function execute(c) {
    const p=state.get(c.target_profile_id);
    if (!c.as) return {http:401,code:'unauthenticated'};
    if (!p || c.as!==p.label) return {http:403,code:'forbidden'};
    if (!c.if_match) return {http:428,code:'precondition_required'};
    assert.equal(c.idempotency_key,c.body.client_mutation_id,'idempotency header must match command UUID');
    validateCommand(c.body);
    const fingerprint=JSON.stringify({if_match:c.if_match,body:c.body});
    const prior=p.receipts.get(c.idempotency_key);
    if (prior) {
      if (prior.fingerprint!==fingerprint) return {http:409,code:'idempotency_key_reuse'};
      return {http:200,revision:prior.revision,replayed:true,posting_count_delta:0};
    }
    if (c.if_match!==token(p)) return {http:412,code:'stale_revision'};
    if (c.body.base_revision!==p.revision) return {http:409,code:'semantic_conflict'};
    const x=c.body.payload,from=p.accounts.get(x.from_account_id),to=p.accounts.get(x.to_account_id);
    if (!from || !to || from.entity_revision!==c.body.expected_entity_revisions[from.id]
      || to.entity_revision!==c.body.expected_entity_revisions[to.id])
      return {http:409,code:'semantic_conflict'};
    const before=p.postings.length;
    // One atomic transfer effect is a pair of opposite postings.
    p.postings.push({account_id:from.id,signed_minor:-x.amount_minor},{account_id:to.id,signed_minor:x.amount_minor});
    from.entity_revision++; to.entity_revision++; p.revision++;
    const revision=p.revision;
    p.receipts.set(c.idempotency_key,{fingerprint,revision});
    assert.equal(p.postings.length-before,2);
    return {http:201,revision,posted_minor_total:-x.amount_minor+x.amount_minor,posting_count:2};
  }
  return {execute,state};
}

test('OpenAPI 3.1 schema, auth, endpoints and refs are internally resolvable',()=>{
  assert.equal(spec.openapi,'3.1.0');
  assert.equal(spec.components.securitySchemes.cookieAuth.name,'fh_email_session');
  for(const path of ['/api/finance/v1/state','/api/finance/v1/changes',
    '/api/finance/v1/commands','/api/finance/v1/imports','/api/finance/v1/imports/{batch_id}/commit'])
    assert.ok(spec.paths[path],'missing API route '+path);
  eachRef(spec,ref=>{
    assert.ok(ref.startsWith('#/components/schemas/'),'unexpected external ref '+ref);
    assert.ok(spec.components.schemas[ref.slice('#/components/schemas/'.length)],'missing schema '+ref);
  });
  assert.equal(spec.paths['/api/finance/v1/commands'].post.responses['409'].description.includes('конфликт'),true);
  for(const code of ['200','201','401','403','409','412','422','428','429','503'])
    assert.ok(spec.paths['/api/finance/v1/commands'].post.responses[code],'missing response '+code);
  assert.ok(spec.paths['/api/finance/v1/state'].get.responses['200'].headers.ETag);
  assert.ok(spec.paths['/api/finance/v1/state'].get.responses['200'].headers['Cache-Control']);
  assert.equal(spec.paths['/api/finance/v1/state'].get.responses['200'].headers['Cache-Control'].schema.const,'private, no-store');
  assert.equal(spec.paths['/api/finance/v1/commands'].post.parameters.some(p=>p.name==='If-Match'&&p.required),true);
  assert.equal(spec.paths['/api/finance/v1/commands'].post.parameters.some(p=>p.name==='Idempotency-Key'&&p.required),true);
  const actions=spec.components.schemas.Command.properties.action.enum;
  for(const action of ['obligation.create','account.transfer','loan.payment.record','reserve.allocate','transaction.reverse'])
    assert.ok(actions.includes(action));
});

test('synthetic 2 users x 2 devices scenarios reproduce the expected HTTP contract',()=>{
  assert.deepEqual(samples.profiles.map(p=>p.label),['U1','U2']);
  assert.deepEqual(samples.devices.map(d=>d.label),['A','B']);
  const model=referenceModel(samples);
  for(const s of samples.cases) {
    const actual=model.execute(s);
    assert.deepEqual(actual,s.expected,'synthetic reference contract case '+s.name);
  }
  for(const p of model.state.values()){
    assert.equal(p.postings.reduce((sum,r)=>sum+r.signed_minor,0),0);
    assert.ok(p.postings.every(r=>Number.isSafeInteger(r.signed_minor)));
  }
  assert.equal(model.state.get(samples.profiles[0].id).revision,8,'U1 applied exactly one command');
  assert.equal(model.state.get(samples.profiles[1].id).revision,2,'U2 only applied own command');
});

test('negative money/permission inputs fail instead of silently rounding',()=>{
  const valid=samples.cases[0].body;
  for(const money of [0,1.01,-1,Number.MAX_SAFE_INTEGER+1,'25000',null]){
    const copy=JSON.parse(JSON.stringify(valid));
    copy.payload.amount_minor=money;
    assert.throws(()=>validateCommand(copy));
  }
  const copy=JSON.parse(JSON.stringify(valid));copy.owner_user_id='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  assert.throws(()=>validateCommand(copy));
  const invalid=JSON.parse(JSON.stringify(valid));invalid.payload.to_account_id=invalid.payload.from_account_id;
  assert.throws(()=>validateCommand(invalid));
});

test('contract includes offline account separation and safe import requirements',()=>{
  const f=samples;
  assert.deepEqual(f.offline_invariants.queue_scoped_by,['user_id','profile_id']);
  assert.equal(f.offline_invariants.logout_must_not_send_pending_to_new_user,true);
  assert.equal(f.offline_invariants.expired_session_must_keep_pending,true);
  assert.equal(f.migration_invariants.overwrites_existing_cloud_budget,false);
  assert.equal(f.migration_invariants.requires_explicit_consent,true);
  assert.equal(f.migration_invariants.requires_local_decrypted_backup_verification,true);
  const sql=readFileSync(new URL('../docs/architecture/cloud-finance-schema.sql', import.meta.url),'utf8');
  const adr=readFileSync(new URL('../docs/architecture/ADR-0065-cloud-finance-sync.md',import.meta.url),'utf8');
  for(const table of ['finance_profiles','accounts','obligations','loans','reserves','ledger_transactions',
    'ledger_postings','settlements','loan_payments','ledger_payment_links','reserve_allocations',
    'command_receipts','change_log','import_batches','import_record_map'])
    assert.ok(sql.includes('CREATE TABLE '+table+' ('),'missing table '+table);
  assert.ok(sql.includes('FORCE ROW LEVEL SECURITY'));
  assert.ok(sql.includes('UNIQUE') && sql.includes('ON DELETE RESTRICT'));
  assert.ok(adr.includes('IndexedDB') && adr.includes('SQLite') && adr.includes('PostgreSQL'));
  assert.ok(adr.includes('412') && adr.includes('409'));
});

test('delta pagination rule refuses non-monotone or split revisions (reference only)',()=>{
  function consume(cursor,page) {
    assert.equal(page.from_revision,cursor);
    assert.ok(page.to_revision>=cursor);
    let last=cursor;
    for(const change of page.changes){
      assert.ok(change.revision>=last);
      assert.ok(change.revision<=page.to_revision);
      if(change.revision>last) assert.equal(change.revision,last+1,'gap');
      last=change.revision;
    }
    assert.equal(last,page.to_revision);
    return last;
  }
  assert.equal(consume(7,{from_revision:7,to_revision:9,changes:[
    {revision:8,ordinal:0},{revision:8,ordinal:1},{revision:9,ordinal:0}]}),9);
  assert.throws(()=>consume(7,{from_revision:7,to_revision:9,changes:[{revision:9,ordinal:0}]}));
  assert.throws(()=>consume(7,{from_revision:7,to_revision:8,changes:[{revision:7,ordinal:1}]}));
});
