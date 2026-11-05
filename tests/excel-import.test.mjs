import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBudgetRows,previewImportChanges,readXlsxRows} from '../excel-import.js';
import {emptyState,getMonthEvents,monthTotals} from '../finance.js';

function sampleRows(){
 const r=Array.from({length:30},()=>[]);
 r[0][0]='Кредитная нагрузка';r[0][8]='Зарплата, 15 число';
 r[1][8]='+';r[1][9]=82000;
 r[2][0]='Банк Карта';r[2][1]='Кредитная карта';r[2][2]=250000;r[2][4]=22.9;
 r[3][0]='Банк Дом';r[3][1]='Ипотека';r[3][2]=1700000;r[3][3]=21000;r[3][4]=8.5;r[3][6]=1300000;
 r[4][0]='ИТОГО';
 r[2][8]='Мобильная связь';r[2][9]=850;r[2][10]='22 число';
 r[3][8]='Ипотека';r[3][9]=21000;r[3][10]='24 число';
 r[4][8]='Отпуск';r[4][9]=4500;
 r[5][8]='Остаток:';r[5][9]=100;
 r[14][8]='Аванс, 30 число';r[15][8]='+';r[15][9]=83000;
 r[16][8]='ЖКХ';r[16][9]=7200;
 r[17][8]='Досрочная ипотека';r[17][9]=10000;r[17][10]='11 число';r[17][11]='Досрочный платёж';
 r[18][8]='Подписка';r[18][9]=500;r[18][10]='8-9 число';r[18][11]='Раз в 3 мес';
 r[19][8]='Остаток всего:';r[19][9]=10000;
 return r;
}
test('two-period spreadsheet, loans, income and expenses without duplicate mandatory loan payment',()=>{
 const p=parseBudgetRows(sampleRows(),'2026-11-05');
 assert.equal(p.loans.length,1);
 assert.equal(p.loans[0].openingCents,130000000);
 assert.equal(p.loans[0].paymentCents,2100000);
 assert.equal(p.loans[0].dueDay,24);
 assert.equal(p.entries.filter(x=>x.kind==='income').length,2);
 assert.equal(p.entries.filter(x=>x.kind==='expense').length,5);
 assert.equal(p.entries.find(x=>x.title==='Мобильная связь').date,'2026-11-22');
 assert.equal(p.entries.find(x=>x.title==='Досрочная ипотека').date,'2026-11-11');
 assert.equal(p.entries.find(x=>x.title==='Подписка').recurrence,'once');
 assert.equal(p.entries.some(x=>x.title==='Ипотека'),false);
 assert.equal(p.entries.some(x=>x.title==='Остаток всего:'),false);
 assert.ok(p.warnings.some(x=>/лимит карты/i.test(x.message)));
 assert.ok(p.warnings.some(x=>/двойной/i.test(x.message))===false);
});
test('append-only merge and duplicate detection are idempotent',()=>{
 const p=parseBudgetRows(sampleRows(),'2026-11-05');
 const state=emptyState();
 const diff=previewImportChanges(p,state);
 assert.equal(diff.entries.length,p.entries.length);
 assert.equal(diff.loans.length,1);
 state.entries=diff.entries.map((x,i)=>({...x,id:String(i)}));
 state.loans=diff.loans.map((x,i)=>({...x,id:String(i)}));
 const second=previewImportChanges(p,state);
 assert.equal(second.entries.length,0);
 assert.equal(second.loans.length,0);
 assert.equal(second.duplicates,p.entries.length+p.loans.length);
});
test('file parser rejects oversized payload and unsupported workbook format safely',async()=>{
 await assert.rejects(readXlsxRows(new Uint8Array([1,2,3,4,5])));
 await assert.rejects(readXlsxRows(new Uint8Array(4_000_001)));
 assert.throws(()=>parseBudgetRows([['not a budget']],'2026-11-05'));
});
test('February day clamps without invalid calendar dates',()=>{
 const p=parseBudgetRows(sampleRows(),'2027-02-05');
 const second=p.entries.find(x=>x.title==='Аванс');
 assert.equal(second.date,'2027-02-28');
});

test('loan due date follows second pay period when day is absent',()=>{
 const rows=sampleRows();
 rows[4][0]='Условный кредитор';rows[4][1]='Рассрочка';rows[4][3]=3000;rows[4][4]=0;rows[4][6]=60000;
 rows[5][0]='ИТОГО';
 rows[19][8]='Долг условному кредитору';rows[19][9]=3000;
 rows[20]=[];rows[20][8]='Остаток всего:';
 const p=parseBudgetRows(rows,'2026-11-05');
 const mom=p.loans.find(l=>l.title.includes('Условный кредитор'));
 assert.ok(mom);
 assert.equal(mom.dueDay,30);
 assert.equal(p.entries.some(e=>e.title==='Долг условному кредитору'),false);
});

test('total forecast counts mandatory loan once and includes extra planned payment',()=>{
 const parsed=parseBudgetRows(sampleRows(),'2026-11-05');
 const state=emptyState();
 state.entries=parsed.entries.map((x,i)=>({...x,id:'e'+i}));
 state.loans=parsed.loans.map((x,i)=>({...x,id:'l'+i}));
 const totals=monthTotals(getMonthEvents(state,'2026-11'));
 assert.equal(totals.incomeCents,16500000);
 assert.equal(totals.expenseCents,2305000+2100000);
 assert.equal(totals.netPlanCents,12095000);
});
