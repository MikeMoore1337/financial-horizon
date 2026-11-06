/**
 * Financial Horizon #44 - opt-in browser acceptance guard.
 * Run on a locally served checkout with ONLY synthetic guest data.
 * Example: node docs/ux-audits/verify-issue-44.mjs http://127.0.0.1:8765
 * Current known P1 defects produce FAIL. Not a substitute for axe/Safari/VoiceOver.
 */
import { chromium } from '@playwright/test';

const base = (process.argv[2] || 'http://127.0.0.1:8765').replace(/\/+$/, '');
const widths = [320, 360, 393, 768, 1440, 2560];
const themes = ['light', 'dark'];
const views = ['overview', 'calendar', 'obligations', 'loans', 'settings'];
const failures = [];
const results = [];
const channel = process.env.FH_UX44_CHROMIUM_CHANNEL;
const browser = await chromium.launch({ headless: true, ...(channel ? {channel} : {}) });

function rgb(hex) {
  let s = hex.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) s = '#' + [...s.slice(1)].map(c => c + c).join('');
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return null;
  return [1, 3, 5].map(i => Number.parseInt(s.slice(i, i + 2), 16) / 255);
}
function luminance(hex) {
  const values = rgb(hex);
  if (!values) return null;
  const channels = values.map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
function contrast(fg, bg) {
  const a = luminance(fg), b = luminance(bg);
  if (a === null || b === null) return null;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function fail(code, record, detail) {
  failures.push({ code, width: record.width, theme: record.theme, view: record.view, ...detail });
}

try {
  for (const width of widths) {
    const context = await browser.newContext({
      viewport: { width, height: width <= 393 ? 852 : 960 },
      locale: 'ru-RU',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(base + '/?guest=1', { waitUntil: 'domcontentloaded' });
      await page.locator('#main h1').waitFor();
      const sample = page.locator('#main [data-action="sample"]:visible').first();
      if (await sample.count()) {
        await sample.click();
        const confirm = page.locator('#confirmation-dialog[open]');
        if (await confirm.count()) {
          await page.locator('#confirm-yes').click();
          await confirm.waitFor({ state: 'hidden' });
        }
      }
      for (const theme of themes) {
        if ((await page.evaluate(() => document.body.dataset.theme)) !== theme) {
          await page.locator('#theme-toggle').click();
        }
        for (const view of views) {
          const state = { width, theme, view };
          try {
            const selector = '.bottom-nav [data-view="' + view + '"]:visible, .sidebar [data-view="' + view + '"]:visible';
            await page.locator(selector).first().click();
            const info = await page.evaluate(() => {
              const doc = document.documentElement;
              const bodyStyle = getComputedStyle(document.body);
              const dock = document.querySelector('.bottom-nav');
              const dockStyle = dock ? getComputedStyle(dock) : null;
              const dockVisible = Boolean(dock && dockStyle.display !== 'none');
              const dockHits = dockVisible ? [...dock.querySelectorAll('button')].map(button => {
                const r = button.getBoundingClientRect();
                const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return button === target || button.contains(target);
              }) : [];
              return {
                viewportWidth: doc.clientWidth,
                documentWidth: Math.max(doc.scrollWidth, document.body.scrollWidth),
                metaTheme: document.querySelector('meta[name="theme-color"]')?.content,
                htmlTheme: doc.dataset.theme,
                bodyTheme: document.body.dataset.theme,
                visibleAddText: document.querySelector('#top-add')?.innerText.trim() || '',
                addLabel: document.querySelector('#top-add')?.getAttribute('aria-label') || '',
                colors: {
                  accent: bodyStyle.getPropertyValue('--accent').trim(),
                  onaccent: bodyStyle.getPropertyValue('--onaccent').trim(),
                  green: bodyStyle.getPropertyValue('--green').trim(),
                  surface: bodyStyle.getPropertyValue('--surface').trim(),
                },
                dockHits,
              };
            });
            results.push({ ...state, ...info });
            if (info.documentWidth > info.viewportWidth + 1) {
              fail('horizontal-overflow', state, { documentWidth: info.documentWidth, viewportWidth: info.viewportWidth });
            }
            if (info.htmlTheme !== theme || info.bodyTheme !== theme) {
              fail('theme-unsynced', state, { htmlTheme: info.htmlTheme, bodyTheme: info.bodyTheme });
            }
            if (info.dockHits.some(hit => !hit)) {
              fail('dock-pointer-obstructed', state, { hitTests: info.dockHits });
            }
            if (width <= 760 && !info.visibleAddText && !info.addLabel) {
              fail('add-button-unnamed', state, {});
            }
            if (theme === 'light' && view === 'overview') {
              const primaryContrast = contrast(info.colors.onaccent, info.colors.accent);
              const incomeContrast = contrast(info.colors.green, info.colors.surface);
              if (primaryContrast !== null && primaryContrast < 4.5) {
                fail('primary-text-contrast', state, { ratio: +primaryContrast.toFixed(3) });
              }
              if (incomeContrast !== null && incomeContrast < 4.5) {
                fail('income-text-contrast', state, { ratio: +incomeContrast.toFixed(3) });
              }
            }
          } catch (error) {
            fail('scenario-error', state, { error: String(error.message).slice(0, 300) });
          }
        }
      }
      if (errors.length) failures.push({ code: 'javascript-errors', width, errors });
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
const summary = {
  tool: 'Playwright / native Chromium',
  origin: base,
  scenarios: results.length,
  failures,
  note: 'Only synthetic guest records. No production writes. axe-core/Safari/VoiceOver not included.',
};
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 1;
