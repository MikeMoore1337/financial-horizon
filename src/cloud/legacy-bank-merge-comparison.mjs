import {guestBankBalance,validateGuestBankLedger} from '../../finance.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash=/^[0-9a-f]{64}$/;
const etag=/^"[^"\r\n]{1,254}"$/;
const name=value=>typeof value==='string'?value.normalize('NFKC').trim().toLocaleLowerCase('ru-RU'):'';
const hold=()=>{throw Error('IMPORT_HOLD: Неполная или несогласованная банковская история');};

/** Read-only comparison; every account and operation still requires owner review. */
export function compareGuestBankHistory({ledger,sourceRevision,snapshot,bankHistory,snapshotEtag,bankEtag}){
 try { validateGuestBankLedger(ledger); } catch { hold(); }
 if(!Number.isSafeInteger(sourceRevision) || sourceRevision<0 || ledger.batches.some(batch=>
    batch.committedStateRevision>sourceRevision ||
    (batch.cancelledStateRevision!==null && batch.cancelledStateRevision>sourceRevision))) hold();
 if(!snapshot || snapshot.schema_version!==1 || snapshot.currency!=='RUB' ||
    !uuid.test(snapshot.profile_id||'') || !Number.isSafeInteger(snapshot.revision) || snapshot.revision<0 ||
    !Array.isArray(snapshot.entities) || snapshot.entities.length>5000 || snapshot.next_cursor!=null ||
    !bankHistory || bankHistory.schema_version!==1 || bankHistory.revision!==snapshot.revision ||
    bankHistory.next_cursor!=null || bankHistory.has_more===true ||
    !Array.isArray(bankHistory.rows) || bankHistory.rows.length>5000 ||
    !etag.test(snapshotEtag||'') || bankEtag!==snapshotEtag) hold();
 const entities=new Map();
 for(const entity of snapshot.entities){
  if(!entity || !uuid.test(entity.id||'') || entities.has(entity.id) ||
     !Number.isSafeInteger(entity.entity_revision) || entity.entity_revision<1 ||
     entity.entity_revision>snapshot.revision || !entity.data || typeof entity.data!=='object' ||
     Array.isArray(entity.data)) hold();
  entities.set(entity.id,entity);
 }
 const accounts=[...entities.values()].filter(item=>item.kind==='account');
 for(const account of accounts){
  const data=account.data;
  if(!name(data.name) || data.name.length>160 || data.currency!=='RUB' || !Number.isSafeInteger(data.opening_minor) ||
     Math.abs(data.opening_minor)>1_000_000_000_000 ||
     !Number.isSafeInteger(data.balance_minor) || !Number.isSafeInteger(data.reserved_minor) ||
     !Number.isSafeInteger(data.available_minor)) hold();
 }
 const rowKeys=new Set(), transactionIds=new Set(), externalAccounts=new Set(), bySource=new Map(), byExternal=new Map();
 const reversals=new Map();
 for(const entity of entities.values()){
  if(entity.kind==='transaction' && entity.data.reversed_transaction_id!=null){
   const id=entity.data.reversed_transaction_id;
   if(reversals.has(id))hold();
   reversals.set(id,entity);
  }
 }
 for(const row of bankHistory.rows){
  if(!row || !hash.test(row.source_key||'') || !hash.test(row.fingerprint||'') || rowKeys.has(row.source_key) ||
     !uuid.test(row.account_id||'') || entities.get(row.account_id)?.kind!=='account' ||
     !uuid.test(row.transaction_id||'') || transactionIds.has(row.transaction_id) ||
     !['committed','cancelled'].includes(row.status) || !['income','expense','transfer'].includes(row.kind) ||
     !Number.isSafeInteger(row.amount_minor) || row.amount_minor<1 || row.amount_minor>1_000_000_000_000 ||
     typeof row.occurred_on!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.occurred_on) ||
     typeof row.description!=='string' || row.description.length>500 ||
     (row.category!==null && (typeof row.category!=='string' || !row.category || row.category.length>160)) ||
     (row.external_id!==null && (typeof row.external_id!=='string' || !row.external_id || row.external_id.length>150))) hold();
  if(row.kind==='transfer' ? (!uuid.test(row.target_account_id||'') || row.target_account_id===row.account_id ||
     entities.get(row.target_account_id)?.kind!=='account') : row.target_account_id!==null) hold();
  const transaction=entities.get(row.transaction_id), postings=transaction?.data?.postings;
  if(transaction?.kind!=='transaction' || transaction.data.kind!==row.kind ||
     transaction.data.occurred_on!==row.occurred_on || transaction.data.note!==row.description || !Array.isArray(postings)) hold();
  const expected=row.kind==='transfer' ? [[row.account_id,-row.amount_minor],[row.target_account_id,row.amount_minor]] :
   [[row.account_id,row.kind==='income'?row.amount_minor:-row.amount_minor]];
  const actual=postings.map(p=>[p?.account_id,p?.signed_minor]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  expected.sort((a,b)=>a[0].localeCompare(b[0]));
  if(JSON.stringify(actual)!==JSON.stringify(expected))hold();
  const reversal=reversals.get(row.transaction_id);
  if(row.status==='cancelled' && !reversal)hold();
  if(reversal){
   if(reversal.data.kind!=='reversal' || !Array.isArray(reversal.data.postings))hold();
   const inverse=reversal.data.postings.map(p=>[p?.account_id,p?.signed_minor]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
   if(JSON.stringify(inverse)!==JSON.stringify(expected.map(([id,amount])=>[id,-amount])))hold();
  }
  rowKeys.add(row.source_key);transactionIds.add(row.transaction_id);bySource.set(row.source_key,row);
  if(row.external_id!==null){
   const unique=JSON.stringify([row.account_id,row.external_id]);
   if(externalAccounts.has(unique))hold();
   externalAccounts.add(unique);
   if(!byExternal.has(row.external_id))byExternal.set(row.external_id,[]);
   byExternal.get(row.external_id).push(row);
  }
 }
 const batches=new Map(ledger.batches.map(batch=>[batch.batchKey,batch]));
 const sourceAccounts=ledger.accounts.map(account=>({
  sourceId:account.id,openingMinor:account.openingMinor,balanceMinor:guestBankBalance(ledger,account.id),
  candidateIds:accounts.filter(target=>name(target.data.name)===name(account.name)).map(target=>target.id).sort(),
 }));
 let candidatePairs=0;
 const operations=ledger.operations.map(op=>{
  const status=batches.get(op.batchKey).cancelledStateRevision===null?'committed':'cancelled';
  const exact=bySource.get(op.sourceKey), candidates=new Set();
  if(exact)candidates.add(exact.transaction_id);
  if(op.externalId!==null)for(const row of byExternal.get(op.externalId)||[])candidates.add(row.transaction_id);
  candidatePairs+=candidates.size;if(candidatePairs>100_000)hold();
  const conflict=Boolean(exact && (exact.fingerprint!==op.fingerprint || exact.external_id!==op.externalId ||
   exact.kind!==op.kind || exact.occurred_on!==op.date || exact.amount_minor!==op.amountCents ||
   exact.description!==op.description || exact.category!==op.category || exact.status!==status ||
   (status==='committed' && reversals.has(exact.transaction_id))));
  return {sourceKey:op.sourceKey,status,identityConflict:conflict,candidateIds:[...candidates].sort()};
 });
 return {status:'NEEDS_OWNER_DECISIONS',revision:snapshot.revision,sourceAccounts,operations,candidatePairs};
}
