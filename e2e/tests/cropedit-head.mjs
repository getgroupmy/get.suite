import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = 'http://localhost:8080';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKElEQVR42u3OMQEAAAgDoNm/tKbwgQJ0Uhk1NBQQEBAQEBAQEBAQEBAQ1gWjYCbJAAAAAElFTkSuQmCC', 'base64');
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
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const refreshUntil = async (p, locator, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    if (await locator.count()) return;
    await p.getByRole('button', { name: 'Refresh' }).click();
    await p.waitForTimeout(700);
  }
  throw new Error('not found after refreshing');
};
const wrap = () => page.locator('.compose-editor .tiptap .img-wrap');
const width = async () => Number((await wrap().getAttribute('data-width')) || 100);
// Shown share of the message width, measured on screen.
const shown = () => page.evaluate(() => {
  const w = document.querySelector('.compose-editor .tiptap .img-wrap');
  const ed = document.querySelector('.compose-editor .tiptap');
  const cs = getComputedStyle(ed);
  return Math.round((w.getBoundingClientRect().width / (ed.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))) * 100);
});
const dragTo = async (pct) => {
  const h = await page.locator('.img-handle').boundingBox();
  const ed = await page.evaluate(() => {
    const e = document.querySelector('.compose-editor .tiptap');
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return { left: r.left + parseFloat(cs.paddingLeft), width: e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) };
  });
  const startX = h.x + h.width / 2, y = h.y + h.height / 2;
  const handleOffset = startX - (await wrap().boundingBox()).x - (await wrap().boundingBox()).width;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(ed.left + (ed.width * pct) / 100 + handleOffset - 20, y, { steps: 5 });
  await page.locator('.img-size-label').waitFor(); // live label while dragging
  await page.mouse.move(ed.left + (ed.width * pct) / 100 + handleOffset, y, { steps: 5 });
  await page.mouse.up();
};

await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Mail' }).waitFor();
  const r = await api(page, 'POST', '/orgs', { name: 'Globex Shipping', domain: 'globex.com', admin_name: 'Gina Globex', admin_local: 'gina', admin_password: 'password123' });
  if (r.status !== 201) throw new Error(JSON.stringify(r));
  await page.getByRole('link', { name: 'Mail' }).click();
  await page.getByText('Inbox is empty').waitFor({ timeout: 30000 });
});

