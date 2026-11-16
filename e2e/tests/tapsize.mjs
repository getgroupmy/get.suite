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
// On a phone, everything you tap is at least 24 × 24 px (WCAG 2.2 target size), or has room around it:
// links inside running text and controls with 24 px of space around them don't count.
const PAGES = ['/home', '/drive', '/mail', '/calendar', '/tasks', '/notes', '/chat', '/contacts', '/forms', '/settings', ...['company', 'security', 'users', 'storage', 'activity'].map((t) => `/admin?tab=${t}`)];
let phone;
await step('a phone, signed in', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  phone = await ctx.newPage();
  phone.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
  await phone.goto(B);
  await phone.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'olivia@acme.com', password: 'password123' }) }));
});
for (const path of process.env.ONLY ? [process.env.ONLY] : PAGES) {
  await step(`targets big enough to tap: ${path}`, async () => {
    await phone.goto(`${B}${path}`);
    await phone.waitForTimeout(1500);
    const small = await phone.evaluate(() => {
      const els = [...document.querySelectorAll('button, a[href], [role=button], [role=tab], [role=menuitem], input:not([type=hidden]), select, summary')]
        .filter((e) => e.offsetParent && !e.closest('[hidden], [aria-hidden=true]'));
      const boxes = els.map((e) => ({ e, r: e.getBoundingClientRect() })).filter(({ r }) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight * 3);
      const out = [];
      for (const { e, r } of boxes) {
        if (r.width >= 24 && r.height >= 24) continue;
        if (/^(checkbox|radio)$/.test(e.type) && e.closest('label')) continue; // its label is tapped too
        if (e.tagName === 'A' && e.closest('p, li') && getComputedStyle(e).display === 'inline') continue; // a link in a sentence
        // Spacing exception: a 24 px circle centred on it doesn't reach any other target.
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const crowded = boxes.some(({ e: o, r: q }) => o !== e && !o.contains(e) && !e.contains(o)
          && Math.max(q.left - cx, 0, cx - q.right) ** 2 + Math.max(q.top - cy, 0, cy - q.bottom) ** 2 < 12 * 12);
        if (crowded) out.push(`${e.tagName.toLowerCase()} “${(e.getAttribute('aria-label') || e.innerText || e.title || '').trim().slice(0, 30)}” ${Math.round(r.width)}×${Math.round(r.height)}`);
      }
      return [...new Set(out)];
    });
    if (small.length) throw new Error(`${small.length}: ${small.slice(0, 10).join(' ; ')}`);
  }, phone);
}
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
