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

const until = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const marks = (root) => root.locator('.slide-mark').allInnerTexts();
await step('a text box made a numbered list: i. ii. iii. before each line', async () => {
  await page.getByText('Click to add title').dblclick();
  await page.keyboard.type('Agenda');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Text box' }).click();
  await page.locator('.slide-stage .slide-item.text.sel').dblclick();
  await page.keyboard.type('Welcome');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Budget');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // an empty line: no number, and the count carries on after it
  await page.keyboard.type('Next steps');
  await page.keyboard.press('Escape');
  await page.locator('.slide-stage [aria-label^="Text: Welcome"]').click();
  if (await page.getByLabel('List', { exact: true }).inputValue() !== '') throw new Error('starts as no list');
  await page.getByLabel('List', { exact: true }).selectOption({ label: 'i. ii. iii.' });
  await until(async () => (await marks(stage())).join() === 'i.,ii.,iii.');
  await page.screenshot({ path: `${SP}/shots/slide-list.png` });
});
await step('bullets instead: ✓ on each line', async () => {
  await page.getByLabel('List', { exact: true }).selectOption({ label: '✓ Tick' });
  await until(async () => (await marks(stage())).join() === '✓,✓,✓');
  await page.getByLabel('List', { exact: true }).selectOption({ label: 'i. ii. iii.' });
  await until(async () => (await marks(stage())).join() === 'i.,ii.,iii.');
});
await step('presenting shows them too', async () => {
  await saved();
  await page.getByRole('button', { name: 'Present' }).first().click();
  const p = page.getByRole('dialog', { name: 'Presenting' });
  await p.getByText('Next steps').waitFor();
  if ((await marks(p)).join() !== 'i.,ii.,iii.') throw new Error((await marks(p)).join());
  await page.keyboard.press('Escape');
});
for (const format of ['pptx', 'odp']) await step(`${format === 'pptx' ? 'a PowerPoint' : 'an OpenDocument'} download opened again keeps the list`, async () => {
  const up = await page.evaluate(async ([id, f]) => {
    const bytes = await (await fetch(`/api/files/${id}/export?format=${f}`)).arrayBuffer();
    return (await fetch(`/api/files/upload?name=Agenda.${f}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes })).json();
  }, [deckId, format]);
  const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
  const deck = (await api(page, 'GET', `/files/${opened.body.id}/content`)).body.content;
  const box = deck.slides[0].items.find((it) => it.type === 'text' && /Welcome/.test(it.text));
  if (box?.list !== 'lower-roman' || box.text !== 'Welcome\nBudget\n\nNext steps') throw new Error(`${format}: ${JSON.stringify(box)}`);
});
if (errors.length) { failed++; console.log('FAIL console errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `FAILED ${failed}` : 'ALL PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
