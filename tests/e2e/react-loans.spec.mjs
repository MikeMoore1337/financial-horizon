import {test,expect} from '@playwright/test';
import {observe,visitGuest,view,scopedState} from './helpers.mjs';

async function addLoan(page,title,opening){
  await page.locator('[data-action="new-loan"]').first().click();
  const form=page.locator('#loan-form');
  for(const [field,value] of Object.entries({
    title,opening,apr:'0',payment:'1000',
    term:'12',asOfDate:'2026-11-01',dueDay:'15',
  }))await form.locator('[name="'+field+'"]').fill(value);
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('#loan-dialog')).not.toBeVisible();
}

test('React loans: select loan, import CSV and record payment without double write',async({page,context})=>{
 const watcher=await observe(context,page);
 await visitGuest(page);
 await view(page,'loans');
 await addLoan(page,'E2E mortgage','10000');
 await addLoan(page,'E2E second credit','5000');
 await expect(page.locator('.loan-card')).toHaveCount(2);
 const second=page.locator('.loan-card').filter({hasText:'E2E second credit'});
 await second.click();
 await expect(second).toHaveAttribute('aria-pressed','true');
 await expect(page.locator('.loan-detail h2')).toHaveText('E2E second credit');
 await page.locator('.loan-detail [data-action="schedule-import"]').click();
 await page.locator('#schedule-file').setInputFiles({
   name:'synthetic-schedule.csv',mimeType:'text/csv',
   buffer:Buffer.from('date;payment;balance\n2026-12-15;1000.00;4000.00\n2027-01-15;1000.00;3000.00'),
 });
 await expect(page.locator('.loan-detail')).toContainText('2 строк');
 let stored=await scopedState(page,'state');
 expect(stored.loans.find(x=>x.title==='E2E second credit').schedule).toHaveLength(2);
 await page.locator('.loan-detail [data-action="pay"]').click();
 await page.locator('#payment-form [name="amount"]').fill('500');
 await page.locator('#payment-form [name="date"]').fill('2026-11-15');
 await page.locator('#payment-form button[type="submit"]').click();
 await expect.poll(async()=> (await scopedState(page,'state')).loanPayments.length).toBe(1);
 stored=await scopedState(page,'state');
 expect(stored.loanPayments[0].amountCents).toBe(50000);
 await page.reload(); await view(page,'loans');
 const mortgage=page.locator('.loan-card').filter({hasText:'E2E mortgage'});
 await mortgage.click();
 await expect(page.locator('.loan-detail h2')).toHaveText('E2E mortgage');
 await second.click();
 await expect(page.locator('.loan-detail')).toContainText('2 строк');
 await expect(page.locator('.loan-history')).toContainText('Учтён');
 watcher.assertClean();
});

test('React loans: controls, both themes and responsive 320-2560 CSS px',async({page,context})=>{
 const watcher=await observe(context,page);
 await visitGuest(page);
 await view(page,'loans');
 await addLoan(page,'E2E loan responsive','10000');
 for(const width of [320,360,393,768,1150,1151,1440,2560]){
   await page.setViewportSize({width,height:900});
   for(const theme of ['light','dark']){
     if(await page.locator('body').getAttribute('data-theme')!==theme)
       await page.locator('#theme-toggle').click();
     await view(page,'loans');
     await expect(page.locator('.loan-detail')).toBeVisible();
     const bounds=await page.evaluate(()=>({
       width:document.documentElement.clientWidth,
       scroll:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),
     }));
     expect(bounds.scroll,'overflow '+width+'/'+theme).toBeLessThanOrEqual(bounds.width+1);
   }
 }
 watcher.assertClean();
});
