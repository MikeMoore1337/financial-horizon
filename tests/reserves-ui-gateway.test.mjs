import test from 'node:test';
import assert from 'node:assert/strict';
import { ReservesFinanceGateway, paymentReceiptIds } from '../src/react/reserves-finance-gateway.ts';

const ACTOR='a'.repeat(32);
const PROFILE='00000000-0000-4000-8000-0000000000aa';
const ACCOUNT='00000000-0000-4000-8000-0000000000ab';
const OBLIGATION='00000000-0000-4000-8000-0000000000ac';
const RESERVE='00000000-0000-4000-8000-0000000000ad';
const MUTATION='00000000-0000-4000-8000-0000000000ae';
const EVENT='00000000-0000-4000-8000-0000000000af';
const DATE='2026-11-16';

globalThis.window ??= {location:{origin:'https://fh.example'}};

function snapshot(revision=1, allocated=3000) {
  const funded=allocated!==3000;
  return {
    schema_version:1, profile_id:PROFILE, revision, currency:'RUB',
    entities:[
      {id:ACCOUNT,kind:'account',entity_revision:funded?2:1,data:{
        name:'Синтетический счёт',type:'bank',currency:'RUB',
        opening_minor:100000,balance_minor:100000,
        reserved_minor:allocated,available_minor:100000-allocated,
        archived_at:null,
      }},
      {id:OBLIGATION,kind:'obligation',entity_revision:1,data:{
        title:'Синтетическая страховка',direction:'expense',
        amount_minor:9000,starts_on:'2027-11-16',recurrence_unit:'year',
        recurrence_every:1,timezone:'UTC',deleted_at:null,
      }},
      {id:RESERVE,kind:'reserve',entity_revision:funded?2:1,data:{
        title:'Синтетическая страховка',account_id:ACCOUNT,obligation_id:OBLIGATION,
        opened_on:DATE,first_due_on:'2027-11-16',target_on:'2027-11-16',
        period_months:12,due_day:16,contribution_mode:'auto',
        fixed_monthly_minor:null,opening_reserved_minor:3000,
        opening_target_minor:9000,target_minor:9000,cycle_number:1,
        allocated_minor:allocated,
        allocations_by_account:[{account_id:ACCOUNT,allocated_minor:allocated}],
        archived_at:null,
        event_log:funded?[{
          id:EVENT,reserve_id:RESERVE,revision:2,cycle_number:1,
          kind:'contribution',occurred_on:DATE,amount_minor:2000,
          target_minor:null,reserved_used_minor:null,slot_on:null,
          target_event_id:null,allocation_id:null,transaction_id:null,note:null,
        }]:[],
      }},
    ],
  };
}

function json(body,status=200,etag='"fh.1.1.example"') {
  return new Response(JSON.stringify(body),{
    status,
    headers:{'content-type':'application/json','etag':etag},
  });
}
function transport(...items) {
  const calls=[];
  const fetcher=async (...args)=>{
    calls.push(args);
    const value=items.shift();
    if(value instanceof Error)throw value;
    if(!value)throw Error('Unexpected request');
    return value;
  };
  fetcher.calls=calls;
  return fetcher;
}

test('#6 authenticated reserves show real account, reserved and free balances',async()=>{
  const fetcher=transport(
    json({ok:true,profile_id:PROFILE}),json(snapshot()),
  );
  const gateway=new ReservesFinanceGateway(fetcher,'https://fh.example',()=>MUTATION);
  const view=await gateway.open(ACTOR,DATE);
  assert.equal(view.totalMinor,100000);
  assert.equal(view.reservedMinor,3000);
  assert.equal(view.availableMinor,97000);
  assert.equal(view.obligations[0].title,'Синтетическая страховка');
  assert.equal(view.reserves[0].projection.fundingGapCents,6000);
  assert.equal(gateway.writeBlocked,false);
  assert.equal(fetcher.calls.length,2);
  assert.equal(fetcher.calls[1][0],
    'https://fh.example/api/finance/v1/state?limit_entities=5000');
  for(const [,init] of fetcher.calls){
    assert.equal(init.credentials,'same-origin');
    assert.equal(init.redirect,'error');
    assert.equal(init.cache,'no-store');
  }
});

test('#6 allocate reserves without bank debit and only after exact receipt + state',async()=>{
  const receipt={
    schema_version:2,client_mutation_id:MUTATION,revision:2,
    replayed:false,changes:[{entity_id:RESERVE,revision:2}],
  };
  const fetcher=transport(
    json({ok:true,profile_id:PROFILE}),
    json(snapshot()),
    json(receipt,201,'"fh.1.2.example"'),
    json(snapshot(2,5000),200,'"fh.1.2.example"'),
  );
  const gateway=new ReservesFinanceGateway(fetcher,'https://fh.example',()=>MUTATION);
  await gateway.open(ACTOR,DATE);
  const view=await gateway.execute('reserve.allocate',{
    reserve_id:RESERVE,account_id:ACCOUNT,delta_minor:2000,occurred_on:DATE,
  },DATE);
  assert.equal(view.totalMinor,100000,'Allocation cannot debit the bank account');
  assert.equal(view.reservedMinor,5000);
  assert.equal(view.availableMinor,95000);
  assert.equal(view.reserves[0].projection.reservedCents,5000);
  assert.equal(fetcher.calls.length,4);
  assert.equal(fetcher.calls[2][0],'https://fh.example/api/finance/v2/commands');
  const command=JSON.parse(fetcher.calls[2][1].body);
  assert.equal(command.action,'reserve.allocate');
  assert.deepEqual(command.expected_entity_revisions,{
    [RESERVE]:1,[ACCOUNT]:1,
  });
  assert.equal(command.actor_id,undefined);
  assert.equal(command.profile_id,undefined);
  assert.equal(fetcher.calls[2][1].headers['If-Match'],'"fh.1.1.example"');
  assert.equal(fetcher.calls[2][1].headers['Idempotency-Key'],MUTATION);
  assert.equal(gateway.writeBlocked,false);
});

test('#6 ambiguous POST timeout never retries and refresh cannot permit another debit',async()=>{
  const fetcher=transport(
    json({ok:true,profile_id:PROFILE}),
    json(snapshot()),
    new Error('The request reached the server but the connection died'),
    json(snapshot()),
  );
  const gateway=new ReservesFinanceGateway(fetcher,'https://fh.example',()=>MUTATION);
  await gateway.open(ACTOR,DATE);
  const payload={reserve_id:RESERVE,account_id:ACCOUNT,delta_minor:1000,occurred_on:DATE};
  await assert.rejects(()=>gateway.execute('reserve.allocate',payload,DATE),
    {kind:'offline'});
  await gateway.refresh(ACTOR,DATE);
  assert.equal(gateway.writeBlocked,true);
  await assert.rejects(()=>gateway.execute('reserve.allocate',payload,DATE),
    {kind:'conflict'});
  assert.equal(fetcher.calls.length,4,'No duplicate mutation');
});

test('#6 fail closed on truncated snapshot, wrong profile, anonymous and disabled v2',async()=>{
  await assert.rejects(
    ()=>new ReservesFinanceGateway(transport(
      json({ok:true,profile_id:PROFILE}),
      json({...snapshot(),next_cursor:'more'},206),
    ),'https://fh.example').open(ACTOR,DATE),
    {kind:'error'},
  );
  await assert.rejects(
    ()=>new ReservesFinanceGateway(transport(
      json({ok:true,profile_id:PROFILE}),
      json({...snapshot(),profile_id:RESERVE}),
    ),'https://fh.example').open(ACTOR,DATE),
    {kind:'error'},
  );
  await assert.rejects(
    ()=>new ReservesFinanceGateway(transport(json({ok:false},401)),
      'https://fh.example').open(ACTOR,DATE),
    {kind:'locked'},
  );
  const fetcher=transport(
    json({ok:true,profile_id:PROFILE}),json(snapshot()),
    json({detail:'disabled'},404),
  );
  const gateway=new ReservesFinanceGateway(fetcher,'https://fh.example',()=>MUTATION);
  await gateway.open(ACTOR,DATE);
  await assert.rejects(
    ()=>gateway.execute('reserve.allocate',{
      reserve_id:RESERVE,account_id:ACCOUNT,delta_minor:1000,occurred_on:DATE,
    },DATE),
    {kind:'error'},
  );
  assert.equal(gateway.writeBlocked,true);
  assert.equal(fetcher.calls.length,3);
});


test('#6 a valid receipt and advanced ETag do NOT prove a missing reserve allocation',async()=>{
  const receipt={
    schema_version:2,client_mutation_id:MUTATION,revision:2,
    replayed:false,changes:[{entity_id:RESERVE,revision:2}],
  };
  const fake={...snapshot(),revision:2}; // Profile changed, funds did not.
  const fetcher=transport(
    json({ok:true,profile_id:PROFILE}),json(snapshot()),
    json(receipt,201,'"fh.1.2.example"'),
    json(fake,200,'"fh.1.2.example"'),
    json(fake,200,'"fh.1.2.example"'),
  );
  const gateway=new ReservesFinanceGateway(fetcher,'https://fh.example',()=>MUTATION);
  await gateway.open(ACTOR,DATE);
  await assert.rejects(
    ()=>gateway.execute('reserve.allocate',{
      reserve_id:RESERVE,account_id:ACCOUNT,delta_minor:2000,occurred_on:DATE,
    },DATE),
    {kind:'conflict'},
  );
  await gateway.refresh(ACTOR,DATE);
  assert.equal(gateway.writeBlocked,true);
  assert.equal(fetcher.calls.length,5);
});


test('#138 reserve payment receipt binds server-minted ids to exact payment intent',()=>{
  const transaction='00000000-0000-4000-8000-0000000000b1';
  const fact='00000000-0000-4000-8000-0000000000b2';
  const payload={account_id:ACCOUNT,obligation_id:OBLIGATION,reserve_id:RESERVE,
    amount_minor:6000,reserved_used_minor:3000,paid_on:DATE,occurrence_on:'2027-11-16'};
  const tx={id:transaction,kind:'transaction',entity_revision:1,data:{kind:'payment',
    occurred_on:DATE,postings:[{account_id:ACCOUNT,signed_minor:-6000}],
    payment_link:{settlement_id:fact,loan_payment_id:null}}};
  const settled={id:fact,kind:'settlement',entity_revision:1,data:{
    obligation_id:OBLIGATION,amount_minor:6000,paid_on:DATE,
    occurrence_on:'2027-11-16',voided_at:null}};
  const change=(kind,entity)=>({kind,revision:2,entity_id:entity.id,
    entity_revision:entity.entity_revision,payload:{entity}});
  const changes=[change('ledger_posted',tx),change('upsert',settled)];
  assert.deepEqual(paymentReceiptIds(changes,payload,2),
    {...payload,transaction_id:transaction,fact_id:fact});
  const invalid=[
    [change('ledger_posted',{...tx,data:{...tx.data,postings:[{account_id:ACCOUNT,signed_minor:-5999}]}}),changes[1]],
    [changes[0],change('upsert',{...settled,data:{...settled.data,obligation_id:ACCOUNT}})],
    [changes[0],change('upsert',{...settled,data:{...settled.data,occurrence_on:'2028-11-16'}})],
    [{...changes[0],entity_id:fact},changes[1]],
    [changes[0],changes[1],changes[1]],
    [changes[0]],
  ];
  for(const altered of invalid)assert.throws(()=>paymentReceiptIds(altered,payload,2));
  assert.throws(()=>paymentReceiptIds(changes,payload,3));
});
