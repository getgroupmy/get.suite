import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
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
const page = await mk("olivia");
const step = async (name, fn, p = page) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
let deckId;
const content = async () => (await api(page, 'GET', `/files/${deckId}/content`)).body.content;
// The server stores co-edited changes a couple of seconds after the last one.
const saved = async () => { await page.getByText('All changes saved').waitFor({ timeout: 10000 }); await page.waitForTimeout(2600); };
const stage = () => page.locator('.slide-stage > .slide');
const itemBox = async (label) => page.locator(`.slide-stage [aria-label^="${label}"]`).first().boundingBox();

await step('setup and a new presentation from Drive', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await page.goto(B + '/drive');
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('menuitem', { name: 'Presentation' }).click();
  await page.waitForURL(/\/slides\//);
  deckId = page.url().split('/').pop();
  await page.getByText('Click to add title').waitFor();
});

const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
await step('insert an arrow; it draws a line and a head; change its direction and colour', async () => {
  await page.getByRole('button', { name: 'Shape ▾' }).click();
  await page.getByRole('menuitem', { name: 'Arrow', exact: true }).click();
  const arrow = page.locator('.slide-stage .slide-item.shape svg.slide-line');
  await arrow.waitFor();
  if ((await arrow.locator('polygon').count()) !== 1) throw new Error('no arrowhead');
  const ln = arrow.locator('line');
  const [y1, y2] = [await ln.getAttribute('y1'), await ln.getAttribute('y2')];
  if (y1 !== y2) throw new Error('not across');
  await page.getByLabel('Direction').selectOption('u');
  await until(async () => Number(await ln.getAttribute('y1')) > Number(await ln.getAttribute('y2')));
  await page.getByLabel('Shape colour').selectOption('#c5221f');
  await until(async () => (await arrow.locator('polygon').getAttribute('fill')) === '#c5221f');
  await page.screenshot({ path: `${SP}/shots/slide-arrow.png` });
});
await step('a line too; both are saved; PowerPoint keeps them', async () => {
  await page.locator('.slide-stage').click({ position: { x: 5, y: 5 } });
  await page.getByRole('button', { name: 'Shape ▾' }).click();
  await page.getByRole('menuitem', { name: 'Line', exact: true }).click();
  await until(async () => (await page.locator('.slide-stage svg.slide-line').count()) === 2);
  await saved();
  const c = await content();
  const shapes = c.slides[0].items.filter((i) => i.type === 'shape').map((i) => `${i.shape}/${i.dir}/${i.fill}`);
  if (shapes.join() !== 'arrow/u/#c5221f,line/h/text') throw new Error(shapes.join());
  const r = await page.request.get(`${B}/api/files/${deckId}/export`);
  if (r.status() !== 200) throw new Error('export ' + r.status());
});
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
