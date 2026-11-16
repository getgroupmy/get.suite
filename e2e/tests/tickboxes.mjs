import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const mk = async (who) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/40[0-4]|503|Content Security|sandboxed/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
  return p;
};
const page = await mk('olivia');
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
});
// Tick boxes and radio buttons beside long labels keep their size (a flex row squeezes them otherwise).
const PAGES = ['/settings', ...['activity', 'announcements', 'apps', 'checkup', 'company', 'drives', 'links', 'mail', 'phishing', 'reports', 'security', 'storage', 'system', 'users'].map((t) => `/admin?tab=${t}`), '/calendar', '/mail', '/drive', '/tasks', '/notes', '/chat', '/forms'];
for (const path of process.env.ONLY ? [process.env.ONLY] : PAGES) {
  await step(`tick boxes keep their size: ${path}`, async () => {
    await page.goto(`${B}${path}`);
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
    await page.waitForTimeout(300);
    const bad = await page.evaluate(() => [...document.querySelectorAll('input[type=checkbox], input[type=radio]')]
      .filter((e) => e.offsetParent && getComputedStyle(e).appearance !== 'none' && !e.closest('[hidden]'))
      .map((e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), label: (e.closest('label')?.innerText || e.getAttribute('aria-label') || '').slice(0, 60) }; })
      .filter((x) => x.w > 0 && (x.w < 12 || Math.abs(x.w - x.h) > 2)));
    if (bad.length) throw new Error(JSON.stringify(bad.slice(0, 6)));
  });
}
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
