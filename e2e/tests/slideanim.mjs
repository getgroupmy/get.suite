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
await step('two text boxes, given animations in order', async () => {
  await page.getByText('Click to add title').dblclick();
  await page.keyboard.type('Agenda');
  await page.keyboard.press('Escape');
  for (const t of ['First point', 'Second point']) {
    await page.getByRole('button', { name: 'Text box' }).click();
    await page.keyboard.press('Enter').catch(() => {});
    const box = page.locator('.slide-stage .slide-item.text.sel');
    await box.dblclick();
    await page.keyboard.type(t);
    await page.keyboard.press('Escape');
    await page.locator(`.slide-stage [aria-label^="Text: ${t}"]`).click();
    await page.getByLabel('Animation').selectOption(t.startsWith('First') ? 'fade' : 'fly');
  }
  await page.locator('.slide-stage .anim-badge', { hasText: '2' }).waitFor();
  await saved();
  const items = (await content()).slides[0].items.filter((it) => it.anim);
  const got = items.sort((a, b) => a.animAt - b.animAt).map((it) => `${it.text}:${it.anim}`).join(',');
  if (got !== 'First point:fade,Second point:fly') throw new Error(got);
});
await step('presenting: each click brings in the next box, then the next slide; back takes them away', async () => {
  await page.getByRole('button', { name: 'New slide' }).click();
  await page.getByRole('menuitem', { name: 'Title and text' }).click();
  await page.getByRole('button', { name: 'Slide 1', exact: true }).click();
  await page.getByRole('button', { name: 'Present' }).first().click();
  const p = page.getByRole('dialog', { name: 'Presenting' });
  const shown = async () => p.locator('[data-built="yes"]').count();
  await p.getByText('1 / 2').waitFor();
  await p.getByText('Agenda').waitFor();
  if (await shown() !== 0) throw new Error('nothing in yet');
  if (!(await p.getByText('First point').isHidden())) throw new Error('first hidden');
  await page.keyboard.press('ArrowRight');
  await until(async () => (await shown()) === 1);
  await p.getByText('First point').waitFor();
  const anim = await p.locator('.anim-fade').evaluate((el) => getComputedStyle(el).animationName);
  if (anim !== 'slide-anim-fade') throw new Error('animation ' + anim);
  await page.keyboard.press('ArrowRight');
  await until(async () => (await shown()) === 2);
  await p.locator('.anim-fly').waitFor();
  await p.getByText('1 / 2').waitFor();
  await page.keyboard.press('ArrowRight');
  await p.getByText('2 / 2').waitFor();
  await page.keyboard.press('ArrowLeft');
  await p.getByText('1 / 2').waitFor();
  await until(async () => (await shown()) === 2);
  await page.keyboard.press('ArrowLeft');
  await until(async () => (await shown()) === 1);
  await page.keyboard.press('Escape');
  await p.waitFor({ state: 'detached' });
});
await step('No animation takes it out of the order', async () => {
  await page.locator('.slide-stage [aria-label^="Text: Second point"]').click();
  await page.getByLabel('Animation').selectOption('');
  await until(async () => (await page.locator('.slide-stage .anim-badge').count()) === 1);
  await page.locator('.slide-stage .anim-badge', { hasText: '1' }).waitFor();
});
await step('an exit animation: the box is there until its click, then fades out', async () => {
  await page.locator('.slide-stage [aria-label^="Text: Second point"]').click();
  await page.getByLabel('Animation').selectOption('fadeout');
  await page.locator('.slide-stage .anim-badge.exit', { hasText: '2' }).waitFor();
  await saved();
  const it = (await content()).slides[0].items.find((x) => x.text === 'Second point');
  if (it.anim !== 'fadeout' || it.animAt !== 2) throw new Error(JSON.stringify(it));
  await page.getByRole('button', { name: 'Slide 1', exact: true }).click();
  await page.getByRole('button', { name: 'Present' }).first().click();
  const p = page.getByRole('dialog', { name: 'Presenting' });
  await p.getByText('1 / 2').waitFor();
  await p.getByText('Second point').waitFor(); // there from the start
  if (!(await p.getByText('First point').isHidden())) throw new Error('first should wait');
  await page.keyboard.press('ArrowRight');
  await p.getByText('First point').waitFor();
  await p.getByText('Second point').waitFor();
  await page.keyboard.press('ArrowRight');
  const name = await p.locator('.anim-fadeout').evaluate((el) => getComputedStyle(el).animationName);
  if (name !== 'slide-anim-fadeout') throw new Error('animation ' + name);
  await until(async () => p.getByText('Second point').isHidden());
  await p.getByText('1 / 2').waitFor(); // still the same slide
  await page.keyboard.press('ArrowLeft'); // back: it is there again
  await p.getByText('Second point').waitFor();
  await page.keyboard.press('Escape');
  await p.waitFor({ state: 'detached' });
});
await step('Start: With previous puts a box on the same click as the one before', async () => {
  // First point (fade, click 1), Second point (fade out, click 2): Second point now goes with First point's click.
  await page.locator('.slide-stage [aria-label^="Text: Second point"]').click();
  await page.getByLabel('Starts', { exact: true }).selectOption('with');
  await until(async () => (await page.locator('.slide-stage .anim-badge').allInnerTexts()).join() === '1,1');
  await saved();
  const it = (await content()).slides[0].items.find((x) => x.text === 'Second point');
  if (it.animStart !== 'with') throw new Error(JSON.stringify(it));
  await page.getByRole('button', { name: 'Slide 1', exact: true }).click();
  await page.getByRole('button', { name: 'Present' }).first().click();
  const p = page.getByRole('dialog', { name: 'Presenting' });
  await p.getByText('Second point').waitFor();
  await page.keyboard.press('ArrowRight'); // one click: First point comes in as Second point fades out
  await p.getByText('First point').waitFor();
  await until(async () => p.getByText('Second point').isHidden());
  await p.getByText('1 / 2').waitFor();
  await page.keyboard.press('ArrowRight'); // and the next click is the next slide
  await p.getByText('2 / 2').waitFor();
  await page.keyboard.press('Escape');
  await p.waitFor({ state: 'detached' });
});
await step('By paragraph: a list comes in a line a click', async () => {
  const content = { theme: 'light', slides: [{ id: 's1', items: [
    { id: 'l', type: 'text', x: 5, y: 20, w: 60, h: 40, text: 'Plan\nHire\nBuild', anim: 'fade', animAt: 1 },
  ] }, { id: 's2', items: [] }] };
  const id = (await page.evaluate(async (c) => (await (await fetch('/api/files/new', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'slides', name: 'List', content: c }) })).json()), content)).id;
  await page.goto(`${B}/slides/${id}`);
  await page.locator('.slide-stage [aria-label^="Text: Plan"]').click();
  await page.getByLabel('By paragraph').check();
  await until(async () => (await page.evaluate(async (f) => (await (await fetch(`/api/files/${f}/content`)).json()).content.slides[0].items[0].animBy, id)) === 'para');
  await page.getByRole('button', { name: 'Present' }).first().click();
  const p = page.getByRole('dialog', { name: 'Presenting' });
  const lines = async () => p.locator('.slide-para[data-para-built="yes"]').allInnerTexts();
  await p.getByText('1 / 2').waitFor();
  if ((await lines()).length) throw new Error('nothing in yet');
  for (const want of ['Plan', 'Plan,Hire', 'Plan,Hire,Build']) {
    await page.keyboard.press('ArrowRight');
    await until(async () => (await lines()).join() === want);
    await p.getByText('1 / 2').waitFor();
  }
  if (!(await p.getByText('Build').isVisible()) || !(await p.locator('.slide-para.anim-fade').count())) throw new Error('the last line fades in');
  await page.keyboard.press('ArrowLeft');
  await until(async () => (await lines()).join() === 'Plan,Hire');
  if (!(await p.getByText('Build').isHidden())) throw new Error('back takes the last line away');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await p.getByText('2 / 2').waitFor();
  await page.keyboard.press('Escape');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
