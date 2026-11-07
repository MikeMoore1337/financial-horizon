import {test,expect} from '@playwright/test';
import {
 observe,registerViaUi,logoutViaUi,loginViaUi,visitGuest,view,addEntry,scopedState,currentUser,
} from './helpers.mjs';

test('React calendar honors account logout, guest isolation and subsequent re-login',async({page,context,request})=>{
 const watcher=await observe(context,page);
 const email='react-calendar-'+test.info().project.name.replace(/[^a-z0-9]/gi,'')+'-'+Date.now()+'@test.invalid';
 const title='E2E account-only React calendar entry';
 await registerViaUi(page,request,email);
 const user=await currentUser(page);
 expect(user.id).toMatch(/^[0-9a-f]{32}$/);
 await addEntry(page,title,{kind:'income',amount:'777.20'});
 await view(page,'calendar');
 await page.locator('.cal-day[data-date="2026-11-15"]').click();
 await expect(page.locator('.cal-layout .plain-list')).toContainText(title);

 await logoutViaUi(page);
 await visitGuest(page);
 await view(page,'calendar');
 await page.locator('.cal-day[data-date="2026-11-15"]').click();
 await expect(page.locator('.cal-layout .plain-list')).not.toContainText(title);
 // An untouched guest has no finance record at all; that is a valid isolated state.
 const guestState=await scopedState(page,'guest-state-v2');
 expect(guestState?.entries?.some(e=>e.title===title)??false).toBe(false);

 await loginViaUi(page,email);
 expect((await currentUser(page)).id).toBe(user.id);
 await view(page,'calendar');
 await page.locator('.cal-day[data-date="2026-11-15"]').click();
 await expect(page.locator('.cal-layout .plain-list')).toContainText(title);
 expect((await scopedState(page,'account-state-v2:'+user.id)).entries.some(e=>e.title===title)).toBe(true);
 watcher.assertClean();
});
