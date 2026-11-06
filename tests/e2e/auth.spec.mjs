import {test,expect} from '@playwright/test';
import {
 ORIGIN,TEST_PASSWORD,observe,visitGuest,addEntry,scopedState,
 registerViaUi,loginViaUi,logoutViaUi,currentUser,mailToken,
} from './helpers.mjs';

test('email registration, true browser cookie, logout and repeat login',async({page,context,request})=>{
 const watcher=await observe(context,page);
 const email='e2e-auth-one@example.invalid';
 await registerViaUi(page,request,email);
 const user=await currentUser(page);
 expect(user.email).toBe(email);
 expect(user.id).toMatch(/^[0-9a-f]{32}$/);
 expect((await context.cookies()).some(c=>c.name==='fh_email_session'&&c.httpOnly)).toBe(true);
 await addEntry(page,'E2E authenticated budget',{amount:'2450'});
 await logoutViaUi(page);
 expect((await currentUser(page))).toBeNull();
 await page.goto('/');
 await expect(page).toHaveURL(ORIGIN+'/account.html');
 await loginViaUi(page,email);
 expect((await currentUser(page)).id).toBe(user.id);
 expect((await scopedState(page,'account-state-v2:'+user.id)).entries.some(e=>e.title==='E2E authenticated budget')).toBe(true);
 watcher.assertClean();
});

test('two accounts + guest on same origin isolate real IndexedDB',async({page,context,request})=>{
 test.setTimeout(120_000);
 const watcher=await observe(context,page);
 const first='e2e-tenant-a@example.invalid',second='e2e-tenant-b@example.invalid';
 await visitGuest(page);
 await addEntry(page,'E2E initial guest budget');
 await registerViaUi(page,request,first);
 const a=await currentUser(page);
 await addEntry(page,'E2E tenant A only');
 await logoutViaUi(page);
 await registerViaUi(page,request,second);
 const b=await currentUser(page);
 expect(b.id).not.toBe(a.id);
 expect((await scopedState(page,'account-state-v2:'+b.id))?.entries ?? []).toHaveLength(0);
 await addEntry(page,'E2E tenant B only');
 await logoutViaUi(page);
 await visitGuest(page);
 const guest=await scopedState(page,'guest-state-v2');
 expect(guest?.entries ?? []).toHaveLength(0);
 const rows=await scopedState(page,'account-state-v2:'+a.id);
 expect(rows.entries.map(e=>e.title)).toEqual(expect.arrayContaining(['E2E initial guest budget','E2E tenant A only']));
 await loginViaUi(page,first);
 const active=await scopedState(page,'account-state-v2:'+a.id);
 expect(active.entries.some(e=>e.title==='E2E tenant B only')).toBe(false);
 expect(active.entries.some(e=>e.title==='E2E tenant A only')).toBe(true);
 watcher.assertClean();
});

test('revoke other real sessions, confirm changed email, preserve user ID',async({browser,request})=>{
 test.setTimeout(120_000);
 const ownerContext=await browser.newContext();
 const otherContext=await browser.newContext();
 try{
  const owner=await ownerContext.newPage(),other=await otherContext.newPage();
  const ownWatch=await observe(ownerContext,owner),otherWatch=await observe(otherContext,other);
  const oldEmail='e2e-session-old@example.invalid';
  const newEmail='e2e-session-new@example.invalid';
  await registerViaUi(owner,request,oldEmail);
  const identity=await currentUser(owner);
  await addEntry(owner,'E2E stable on email change');
  await loginViaUi(other,oldEmail);
  expect((await currentUser(other)).id).toBe(identity.id);
  await other.goto('/account.html');
  await expect(other.locator('#session-panel')).toBeVisible();
  await owner.goto('/account.html');
  await expect(owner.locator('#auth-logout-others')).toBeVisible();
  await owner.locator('#auth-logout-others').click();
  await expect(owner.locator('#auth-feedback')).toContainText('остальных устройствах');
  expect(await currentUser(other)).toBeNull();
  await other.goBack();
  await expect(other).toHaveURL(ORIGIN+'/account.html');
  await expect(other.locator('#auth-form')).toBeVisible();
  await expect(owner.locator('#change-email-panel')).toBeVisible();
  await owner.locator('#change-email').fill(newEmail);
  await owner.locator('#change-email-password').fill(TEST_PASSWORD);
  await expect(owner.locator('#change-email-submit')).toBeEnabled();
  await owner.locator('#change-email-submit').click();
  const token=await mailToken(request,newEmail,'email-change');
  await owner.goto('/account.html#confirm-email-change='+encodeURIComponent(token));
  await expect(owner.locator('#session-email')).toContainText(newEmail);
  expect((await currentUser(owner)).id).toBe(identity.id);
  await owner.goto('/');
  expect((await scopedState(owner,'account-state-v2:'+identity.id)).entries.some(e=>e.title==='E2E stable on email change')).toBe(true);
  await logoutViaUi(owner);
  await loginViaUi(owner,newEmail);
  expect((await currentUser(owner)).id).toBe(identity.id);
  ownWatch.assertClean();otherWatch.assertClean();
 }finally{await ownerContext.close();await otherContext.close();}
});
