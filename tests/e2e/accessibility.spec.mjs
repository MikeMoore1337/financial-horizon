import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {observe,visitGuest,view,addEntry} from './helpers.mjs';

const tags=['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'];

async function assertAccessible(page,scope){
 const report=await new AxeBuilder({page}).withTags(tags).analyze();
 expect(report.violations.map(v=>({
  rule:v.id,impact:v.impact,elements:v.nodes.map(n=>n.target),
 })),scope+' must not contain detectable WCAG 2.2 AA violations').toEqual([]);
}

async function syntheticSample(page){
 await visitGuest(page);
 await page.locator('#main [data-action="sample"]').first().click();
 await expect(page.locator('#confirmation-dialog')).toBeVisible();
 await page.locator('#confirm-yes').click();
 await expect(page.locator('#confirmation-dialog')).not.toBeVisible();
 await expect(page.locator('#save-indicator')).toContainText('Сохранено');
 // Inspect settled pages, not a toast halfway through its fade-out animation.
 await page.reload();
 await expect(page.locator('#main h1')).toBeVisible();
}

test('WCAG 2.2 AA: all financial screens in both themes at three representative widths',async({page,context})=>{
 const watcher=await observe(context,page);
 await syntheticSample(page);
 for(const width of [393,768,1440]){
  await page.setViewportSize({width,height:width===393?852:960});
  for(const theme of ['light','dark']){
   if((await page.locator('body').getAttribute('data-theme'))!==theme)
    await page.locator('#theme-toggle').click();
   for(const screen of ['overview','calendar','obligations','loans','settings']){
    await view(page,screen);
    await assertAccessible(page,'width='+width+', theme='+theme+', view='+screen);
    const doc=await page.evaluate(()=>({
     scroll:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),
     viewport:document.documentElement.clientWidth,
    }));
    expect(doc.scroll,'No document-level horizontal scrolling').toBeLessThanOrEqual(doc.viewport+1);
   }
  }
 }
 watcher.assertClean();
});

test('WCAG 2.2 AA: dialogs, keyboard scrolling, calendar state and account forms',async({page,context},testInfo)=>{
 const watcher=await observe(context,page);
 await page.setViewportSize({width:393,height:852});
 await visitGuest(page);
 const opener=page.locator('#top-add');
 await opener.focus();
 await page.keyboard.press('Enter');
 await expect(page.locator('#entry-dialog')).toBeVisible();
 await assertAccessible(page,'entry-dialog on mobile');
 await page.keyboard.press('Escape');
 await expect(page.locator('#entry-dialog')).not.toBeVisible();
 await expect(opener).toBeFocused();

 await view(page,'calendar');
 const date=page.locator('.cal-day:not(.selected)').first();
 await date.focus();
 await page.keyboard.press('Enter');
 const selected=page.locator('.cal-day.selected');
 await expect(selected).toHaveAttribute('aria-pressed','true');
 await expect(selected).toBeFocused();
 await expect(selected).toHaveAttribute('aria-describedby',/calendar-day-description-/);
 await assertAccessible(page,'calendar after keyboard selection');

 await view(page,'settings');
 const fixture=testInfo.outputPath('synthetic-accessibility-issue44.xlsx');
 const py=process.env.FH_E2E_PYTHON||(process.platform==='win32'?'py':'python3');
 const prefix=process.platform==='win32'&&!process.env.FH_E2E_PYTHON?['-3']:[];
 execFileSync(py,[...prefix,resolve('tests/e2e/make_xlsx.py'),fixture]);
 await page.locator('[data-action="excel-import"]').click();
 await page.locator('#excel-file').setInputFiles(fixture);
 await expect(page.locator('#excel-import-dialog')).toBeVisible();
 const items=page.locator('#excel-import-items');
 await expect(items).toHaveAttribute('role','region');
 await items.focus();
 await expect(items).toBeFocused();
 const before=await items.evaluate(el=>({top:el.scrollTop,scroll:el.scrollHeight,client:el.clientHeight}));
 if(before.scroll>before.client){
  await page.keyboard.press('PageDown');
  await expect.poll(()=>items.evaluate(el=>el.scrollTop)).toBeGreaterThan(before.top);
 }
 await assertAccessible(page,'XLSX preview with keyboard scroll');
 await page.locator('[data-action="cancel-excel-import"]').last().click();
 await expect(page.locator('#excel-import-dialog')).not.toBeVisible();

 await page.goto('/account.html');
 for(const mode of ['login','register','reset']){
  await page.locator('.auth-modes [data-mode="'+mode+'"]').click();
  await assertAccessible(page,'account mode='+mode);
 }
 watcher.assertClean();
});

test('responsive boundary regression: tablet actions remain visible up to 1150 CSS px',async({page,context})=>{
 const watcher=await observe(context,page);
 await syntheticSample(page);
 for(const width of [320,360,393,760,761,768,820,900,1000,1001,1024,1100,1120,1150,1151,1200,1440,2560]){
  await page.setViewportSize({width,height:900});
  await view(page,'obligations');
  const screen=await page.evaluate(()=>({
   width:document.documentElement.clientWidth,
   page:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),
   table:getComputedStyle(document.querySelector('.records-table')).display!=='none',
   cards:getComputedStyle(document.querySelector('.records-mobile')).display!=='none',
   actionButtons:[...document.querySelectorAll('.record-mobile-row .record-mobile-actions button')].filter(e=>{
    const s=getComputedStyle(e);return s.display!=='none'&&e.getBoundingClientRect().width>=24;
   }).length,
  }));
  expect(screen.page,'Overflow at width '+width).toBeLessThanOrEqual(screen.width+1);
  if(width>=761&&width<=1150){
   expect(screen.table,'Desktop table must collapse at width '+width).toBe(false);
   expect(screen.cards,'Existing record cards must remain visible at width '+width).toBe(true);
   expect(screen.actionButtons,'Edit, settle and archive actions retained').toBeGreaterThan(0);
  }
  if(width>=1151)expect(screen.table).toBe(true);
 }
 watcher.assertClean();
});

test('long synthetic names wrap without document overflow in both themes and engines',async({page,context})=>{
 const watcher=await observe(context,page);
 await visitGuest(page);
 const title=('СинтетическоеНазваниеБезПробелов').repeat(4).slice(0,100);
 await addEntry(page,title);
 for(const theme of ['light','dark']){
  if((await page.locator('body').getAttribute('data-theme'))!==theme)
   await page.locator('#theme-toggle').click();
  for(const width of [320,360,393,760,761,768,820,1024,1150,1151,1440,2560]){
   await page.setViewportSize({width,height:width<=393?852:960});
   await view(page,'obligations');
   const state=await page.evaluate(()=>({
    viewport:document.documentElement.clientWidth,
    document:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),
    titleVisible:document.querySelector('#main')?.textContent.includes('СинтетическоеНазваниеБезПробелов'),
   }));
   expect(state.document,'Long title overflow at '+width+'px in '+theme).toBeLessThanOrEqual(state.viewport+1);
   expect(state.titleVisible).toBe(true);
  }
 }
 watcher.assertClean();
});

test('long unbroken loan and category labels do not overflow the page',async({page,context})=>{
 const watcher=await observe(context,page);
 await visitGuest(page);
 await view(page,'loans');
 await page.locator('[data-action="new-loan"]').first().click();
 const form=page.locator('#loan-form');
 const title=('СинтетическийКредитБезПробелов').repeat(4).slice(0,100);
 for(const [name,value] of Object.entries({
  title,opening:'10000',apr:'0',payment:'1000',term:'10',
  asOfDate:'2026-11-01',dueDay:'15',
 }))await form.locator('[name="'+name+'"]').fill(value);
 await form.locator('button[type="submit"]').click();
 await expect(page.locator('#loan-dialog')).not.toBeVisible();
 for(const theme of ['light','dark']){
  if((await page.locator('body').getAttribute('data-theme'))!==theme)
   await page.locator('#theme-toggle').click();
  for(const width of [320,360,393,768,1024,1150,1151,1440,2560]){
   await page.setViewportSize({width,height:width<=393?852:960});
   await view(page,'loans');
   const state=await page.evaluate(()=>{
    const label=document.querySelector('.loan-card .title');
    const card=document.querySelector('.loan-card');
    return {
     viewport:document.documentElement.clientWidth,
     document:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),
     titleVisible:document.querySelector('#main')?.textContent.includes('СинтетическийКредитБезПробелов'),
     titleWithinCard:!!label&&!!card&&label.getBoundingClientRect().right<=card.getBoundingClientRect().right+1,
     maxLoanStatRight:Math.max(...[...document.querySelectorAll('.loan-stats>div')].map(el=>el.getBoundingClientRect().right)),
    };
   });
   if(state.document>state.viewport+1){
    const diagnostic=await page.evaluate(()=>{
     const vw=document.documentElement.clientWidth;
     return [...document.querySelectorAll('body *')].map(el=>{
      const rect=el.getBoundingClientRect(),style=getComputedStyle(el);
      return {
       tag:el.tagName,cls:String(el.className||'').slice(0,80),
       text:el.innerText?.slice(0,60),
       left:+rect.left.toFixed(2),right:+rect.right.toFixed(2),
       width:+rect.width.toFixed(2),scroll:el.scrollWidth,
       overflow:style.overflowX,display:style.display,
       position:style.position
      };
     }).filter(x=>x.right>vw+0.7)
       .sort((a,b)=>b.right-a.right).slice(0,25);
    });
    console.log('ISSUE44_REFLOW_DIAG',JSON.stringify({engine:process.platform,width,theme,state,diagnostic}));
   }
   expect(state.document,'Loan title overflow at '+width+'px in '+theme).toBeLessThanOrEqual(state.viewport+1);
   expect(state.titleVisible).toBe(true);
   expect(state.titleWithinCard).toBe(true);
   expect(state.maxLoanStatRight,'Loan stat grid overflow at '+width+'px').toBeLessThanOrEqual(state.viewport+1);
  }
 }
 await view(page,'settings');
 const category=('КатегорияБезПробелов').repeat(3).slice(0,40);
 await page.locator('#category-form [name="name"]').fill(category);
 await page.locator('#category-form button[type="submit"]').click();
 for(const width of [320,393,768]){
  await page.setViewportSize({width,height:852});
  await view(page,'settings');
  const geometry=await page.evaluate(()=>({
   viewport:document.documentElement.clientWidth,
   document:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth),
  }));
  expect(geometry.document,'Category overflow at '+width+'px').toBeLessThanOrEqual(geometry.viewport+1);
 }
 watcher.assertClean();
});
