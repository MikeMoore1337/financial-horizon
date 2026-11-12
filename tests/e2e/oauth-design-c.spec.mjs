import {test,expect} from '@playwright/test';

// Synthetic API responses verify the approved screen's real browser behavior.
// They do NOT prove any real Telegram/Google/Yandex/VK OAuth exchange.
test('disabled OAuth never exposes provider links on the account page',async({page})=>{
 await page.goto('/account.html');
 await expect(page.locator('#oauth-login')).toBeHidden();
 await expect(page.locator('.oauth-provider-link')).toHaveCount(0);
 await expect(page.locator('#auth-form')).toBeVisible();
});

test('approved C places all configured providers AFTER email and adapts to the viewport',async({page,context})=>{
 await context.addInitScript({content:"window.turnstile={render(_element,opts){queueMicrotask(()=>opts.callback('e2e-'+opts.action));return 1;},remove(){},reset(){}};"});
 await page.route('**/api/auth/providers',route=>route.fulfill({
  status:200,contentType:'application/json',
  body:JSON.stringify({enabled:true,providers:['vk','yandex','telegram','unknown','google']})
 }));
 await page.route('**/api/auth/email/me',route=>route.fulfill({
  status:200,contentType:'application/json',
  body:JSON.stringify({authenticated:false,user:null})
 }));
 await page.goto('/account.html');
 const list=page.locator('#oauth-login');
 await expect(list).toBeVisible();
 const anchors=page.locator('.oauth-provider-link');
 await expect(anchors).toHaveCount(4);
 await expect(page.locator('.oauth-provider-link[href*="telegram"]')).toHaveCount(1);
 expect(await anchors.allTextContents()).toEqual([
  'Войти через Google›',
  'Войти через Яндекс ID›','Войти через VK ID›',
  'Войти через Telegram›'
 ]);
 expect(await anchors.evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')))).toEqual([
  './api/auth/oauth/google/start',
  './api/auth/oauth/yandex/start','./api/auth/oauth/vk/start',
  './api/auth/oauth/telegram/start'
 ]);
 const position=await page.evaluate(()=>{
   const form=document.querySelector('#auth-form'),oauth=document.querySelector('#oauth-login');
   return form.compareDocumentPosition(oauth)&Node.DOCUMENT_POSITION_FOLLOWING;
 });
 expect(position).toBeTruthy();
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.locator('.auth-modes [data-mode="register"]').click();
 await expect(list).toBeHidden();
 await page.locator('.auth-modes [data-mode="login"]').click();
 await expect(list).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>[...document.querySelectorAll('.oauth-provider-icon')].every(img=>img.complete&&img.naturalWidth>0))).toBe(true);
});

test('signed-in session never offers another login route',async({page})=>{
 await page.route('**/api/auth/providers',route=>route.fulfill({
  status:200,contentType:'application/json',
  body:JSON.stringify({enabled:true,providers:['telegram','google','yandex','vk']})
 }));
 await page.route('**/api/auth/email/me',route=>route.fulfill({
  status:200,contentType:'application/json',
  body:JSON.stringify({authenticated:true,user:{id:'a'.repeat(32),email:null}})
 }));
 await page.goto('/account.html');
 await expect(page.locator('#session-panel')).toBeVisible();
 await expect(page.locator('#oauth-login')).toBeHidden();
 await expect(page.locator('.oauth-provider-link')).toHaveCount(0);
});


test('OAuth account and logout remain functional with public email-registration canary closed',async({page})=>{
 let authenticated=true;
 await page.route('**/api/auth/email/config',route=>route.fulfill({
  status:404,contentType:'application/json',body:'{"detail":"Email registration not public"}'
 }));
 await page.route('**/api/auth/providers',route=>route.fulfill({
  status:200,contentType:'application/json',
  body:JSON.stringify({enabled:true,providers:['telegram','google','yandex','vk']})
 }));
 await page.route('**/api/auth/email/me',route=>route.fulfill({
  status:200,contentType:'application/json',
  body:JSON.stringify({authenticated,
    user:authenticated?{id:'c'.repeat(32),email:null}:null})
 }));
 await page.route('**/api/auth/email/logout',route=>{
  authenticated=false;
  return route.fulfill({
   status:200,contentType:'application/json',body:'{"ok":true}'
  });
 });
 await page.goto('/account.html');
 await expect(page.locator('#session-panel')).toBeVisible();
 await expect(page.locator('#auth-form')).toBeHidden();
 await expect(page.locator('#change-email-panel')).toBeHidden();
 await expect(page.locator('#oauth-login')).toBeHidden();
 await expect(page.locator('#auth-logout-others')).toBeVisible();
 await expect(page.locator('#session-email')).toContainText('через внешний сервис');
 await page.locator('#auth-logout').click();
 await expect(page.locator('#session-panel')).toBeHidden();
 await expect(page.locator('#auth-form')).toBeVisible();
 await expect(page.locator('#auth-submit')).toBeDisabled();
 await expect(page.locator('#oauth-login')).toBeVisible();
 await expect(page.locator('.oauth-provider-link')).toHaveCount(4);
 await expect(page.locator('#auth-feedback')).toContainText('Сеанс завершён');
});
