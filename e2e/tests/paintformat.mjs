import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
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
let doc;
const t = (text, marks) => ({ type: 'text', text, ...(marks && { marks }) });
const ed = () => page.locator('.ProseMirror').first();
const word = (w) => ed().getByText(w, { exact: false }).first();
const clickWord = async (w) => {
  const box = await page.evaluate((w) => {
    const walker = document.createTreeWalker(document.querySelector('.ProseMirror'), NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) { const i = n.data.indexOf(w); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 2); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; } }
    return null;
  }, w);
  if (!box) throw new Error('no ' + w);
  await page.mouse.click(box.x, box.y);
};
const shape = () => page.evaluate(() => [...document.querySelector('.ProseMirror').children].map((el) => `${el.tagName}:${[...el.querySelectorAll('strong,em')].map((x) => `${x.tagName}(${x.textContent})`).join('')}:${el.textContent}`).join(' | '));
const brush = () => page.getByRole('button', { name: 'Paint format' });
await step('copy a heading\'s formatting and click a word: it takes the style', async () => {
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Paint', content: { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [t('Big', [{ type: 'bold' }, { type: 'textStyle', attrs: { color: '#ff0000' } }]), t(' title')] },
    { type: 'paragraph', content: [t('alpha beta')] },
    { type: 'paragraph', content: [t('gamma delta')] },
    { type: 'paragraph', content: [t('epsilon', [{ type: 'italic' }])] },
  ] } })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await word('epsilon').waitFor();
  await clickWord('Big');
  await brush().click();
  if ((await brush().getAttribute('aria-pressed')) !== 'true') throw new Error('not on');
  await clickWord('beta');
  await until(async () => (await shape()).includes('H2:STRONG(beta):alpha beta'));
  const color = await page.evaluate(() => getComputedStyle([...document.querySelectorAll('.ProseMirror strong')].find((x) => x.textContent === 'beta')).color);
  if (color !== 'rgb(255, 0, 0)') throw new Error('colour ' + color);
  if ((await brush().getAttribute('aria-pressed')) !== 'false') throw new Error('one use: off again');
  await page.screenshot({ path: `${SP}/shots/paintformat.png` });
});
await step('double-click keeps it on: plain text paints several places until Esc', async () => {
  await clickWord('gamma');
  await brush().dblclick();
  if ((await brush().getAttribute('aria-pressed')) !== 'true') throw new Error('not on');
  await clickWord('beta');
  await until(async () => (await shape()).includes('P::alpha beta'));
  await clickWord('epsilon');
  await until(async () => (await shape()).includes('P::epsilon'));
  if ((await brush().getAttribute('aria-pressed')) !== 'true') throw new Error('should stay on');
  await page.keyboard.press('Escape');
  await until(async () => (await brush().getAttribute('aria-pressed')) === 'false');
});
await step('a selection takes it too, and it is saved', async () => {
  await clickWord('Big');
  await brush().click();
  const ends = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.querySelector('.ProseMirror'), NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) if (n.data === 'gamma delta') { const r = document.createRange(); r.selectNodeContents(n); const b = r.getBoundingClientRect(); return { x1: b.left + 1, x2: b.right - 1, y: b.y + b.height / 2 }; }
    return null;
  });
  await page.mouse.move(ends.x1, ends.y); await page.mouse.down(); await page.mouse.move(ends.x2, ends.y, { steps: 5 }); await page.mouse.up();
  await until(async () => (await shape()).includes('H2:STRONG(gamma delta):gamma delta'));
  await until(async () => JSON.stringify((await api(page, 'GET', `/files/${doc.id}/content`)).body).includes('"text":"gamma delta","marks":[{"type":"bold"}'), 10000).catch(async () => {
    const c = JSON.stringify((await api(page, 'GET', `/files/${doc.id}/content`)).body); if (!/gamma delta/.test(c) || !/heading/.test(c)) throw new Error(c.slice(0, 400));
  });
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
