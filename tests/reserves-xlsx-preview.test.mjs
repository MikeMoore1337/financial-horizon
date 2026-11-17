import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBudgetRows } from '../excel-import.js';
import { previewXlsxReserves, confirmXlsxReservePreview } from '../src/domain/reserves/xlsx-preview.ts';

const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';
const C='33333333-3333-4333-8333-333333333333';

function sample() {
  const rows=Array.from({length:30},()=>[]);
  rows[0][0]='Кредитная нагрузка'; rows[0][8]='Зарплата 15 число';
  rows[1][8]='+'; rows[1][9]=50000;
  rows[14][8]='Аванс 30 число'; rows[15][8]='+'; rows[15][9]=20000;
  rows[16][8]='Хостинг'; rows[16][9]=9600;
  rows[16][11]='Раз в 12 месяцев';
  rows[17][8]='Интернет'; rows[17][9]=1200; rows[17][11]='Раз в 3 месяца или 6 месяцев';
  rows[18][8]='Страхование'; rows[18][9]=4800; rows[18][11]='Ежегодно';
  rows[19][8]='Остаток всего:'; rows[19][9]=1;
  return rows;
}

test('actual legacy XLSX parser rows yield advisory-only suggestions with source rows intact',()=>{
  const rows=sample();
  const before=JSON.stringify(rows);
  const parsed=parseBudgetRows(rows,'2026-11-16');
  const proposals=previewXlsxReserves(rows,parsed.entries);
  assert.equal(JSON.stringify(rows),before);
  assert.equal(proposals.length,3);
  assert.deepEqual(proposals.map(p=>[p.source,p.status]),
    [['I17','suggestion'],['I18','invalid'],['I19','suggestion']]);
  assert.equal(proposals[0].periodMonths,12);
  assert.equal(proposals[0].importedAmountCents,960000);
  assert.equal(proposals[1].reason,'ambiguous');
  assert.equal(proposals[2].periodMonths,12);
  assert.equal(proposals[0].rawCells[11],'Раз в 12 месяцев');
  assert.equal(proposals[0].confirmationRequired,true);
  assert.ok(!('accountId' in proposals[0]));
  assert.ok(!('created' in proposals[0]));
});

test('no automatic reserve or bank operation is generated without explicit user confirmation',()=>{
  const rows=sample(), imported=parseBudgetRows(rows,'2026-11-16').entries;
  const [preview,invalid]=previewXlsxReserves(rows,imported);
  assert.throws(()=>confirmXlsxReservePreview(preview,{}),/подтверждение/);
  assert.throws(()=>confirmXlsxReservePreview(invalid,{}),/подтверждение/);
  const base={
    obligationId:B,accountId:A,reserveId:C,openedOn:'2026-11-16',
    firstDueOn:'2027-11-16',dueDay:16,targetCents:960000,
    openingReservedCents:0,contributionMode:'auto',confirmed:true,
    sourceHandling:'keep-original-unchanged',
  };
  const draft=confirmXlsxReservePreview(preview,base);
  assert.equal(draft.source,'I17');
  assert.equal(draft.payload.obligation_id,B);
  assert.equal(draft.payload.account_id,A);
  assert.equal(draft.payload.target_minor,960000);
  assert.equal(draft.payload.period_months,12);
  assert.equal(draft.payload.opening_reserved_minor,0);
  assert.equal(draft.payload.fixed_monthly_minor,null);
  assert.equal(draft.payload.first_due_on,'2027-11-16');
  assert.equal(JSON.stringify(rows),JSON.stringify(sample()));
  assert.throws(()=>confirmXlsxReservePreview(preview,{...base,confirmed:false}));
  assert.throws(()=>confirmXlsxReservePreview(preview,{...base,obligationId:'some-new-obligation'}));
  assert.throws(()=>confirmXlsxReservePreview(preview,{...base,sourceHandling:'replace-old-expense'}));
  assert.throws(()=>confirmXlsxReservePreview(preview,{...base,firstDueOn:'2028-11-16'}));
  assert.throws(()=>confirmXlsxReservePreview(preview,{...base,targetCents:0}));
});

test('periodic reserve import preserves deliberate short-month anchor, never guesses ambiguous date',()=>{
  const rows=sample(), [preview]=previewXlsxReserves(rows,parseBudgetRows(rows,'2026-11-16').entries);
  const decision={
    obligationId:B,accountId:A,reserveId:C,openedOn:'2028-01-31',
    firstDueOn:'2028-02-29',dueDay:31,targetCents:960000,
    openingReservedCents:15000,contributionMode:'fixed',fixedMonthlyCents:80000,
    confirmed:true,sourceHandling:'keep-original-unchanged',
  };
  // A yearly reserve cannot imply that Feb 2028 is its next due date from Jan 2028
  // unless the given dates fit the domain's 12-month initial cycle.
  const payload=confirmXlsxReservePreview(preview,decision).payload;
  assert.equal(payload.first_due_on,'2028-02-29');
  assert.equal(payload.due_day,31);
  assert.equal(payload.fixed_monthly_minor,80000);
  assert.throws(()=>confirmXlsxReservePreview(preview,{...decision,firstDueOn:'2028-02-28'}));
  assert.throws(()=>confirmXlsxReservePreview(preview,{...decision,firstDueOn:'2029-04-30'}));
});

test('XLSX source row mismatch and duplicate imported expense are rejected',()=>{
  const rows=sample();
  const parsed=parseBudgetRows(rows,'2026-11-16').entries;
  const changed=rows.map(row=>[...row]);changed[16][8]='Чужое обязательство';
  assert.throws(()=>previewXlsxReserves(changed,parsed));
  const expenses=parsed.filter(e=>e.kind==='expense');
  assert.throws(()=>previewXlsxReserves(rows,[expenses[0],expenses[0]]));
});
