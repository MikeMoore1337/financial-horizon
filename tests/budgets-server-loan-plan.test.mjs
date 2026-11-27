import test from 'node:test';
import assert from 'node:assert/strict';
import {projectServerBudgetLoans} from '../src/domain/budgets/server-loan-plan.mjs';
const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const loan={id:id(1),kind:'loan',entity_revision:1,data:{title:'Тестовый кредит',opening_minor:1000000,
 payment_minor:100000,apr_basis_points:0,term_months:10,due_day:31,as_of_date:'2026-01-01',
 calculation_version:1,imported_schedule:null,deleted_at:null}};
const fact=(n,amount,strategy='term',voided_at=null)=>({id:id(n),kind:'loan_payment',entity_revision:1,
 data:{loan_id:loan.id,paid_on:'2026-01-15',amount_minor:amount,strategy,voided_at}});
test('server loan plan uses version-one calendar calculation and does not count a fact as a new expense',()=>{
 const result=projectServerBudgetLoans([loan,fact(2,200000,'amount')],'2026-02');
 assert.equal(result.missing,false);assert.equal(result.events.length,1);
 assert.equal(result.events[0].plannedCents,88889);assert.equal(result.events[0].paidCents,0);
 assert.equal(result.events[0].date,'2026-02-28');assert.equal(result.events[0].category,'Кредиты');
 assert.equal(projectServerBudgetLoans([loan,fact(2,1000000)],'2026-02').events.length,0);
 assert.equal(projectServerBudgetLoans([loan,fact(2,1000000,'term','2026-01-20T12:00:00Z')],'2026-02').events[0].plannedCents,100000);
});
test('ambiguous or unsupported loan plans are explicitly incomplete instead of fabricated',()=>{
 assert.equal(projectServerBudgetLoans([loan,fact(2,1000,'amount'),fact(3,1000)],'2026-02').missing,true);
 const unknown={...loan,data:{...loan.data,calculation_version:2}};
 assert.deepEqual(projectServerBudgetLoans([unknown],'2026-02'),{events:[],missing:true});
 assert.throws(()=>projectServerBudgetLoans([fact(2,1000)],'2026-02'));
});
