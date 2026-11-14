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
await step('three slides; the first two move on by themselves, and the deck loops', async () => {
  for (let k = 0; k < 2; k++) {
    await page.getByRole('button', { name: 'New slide' }).click();
    await page.getByRole('menuitem', { name: 'Title and text' }).click();
    await page.getByRole('button', { name: `Slide ${k + 2}`, exact: true }).waitFor();
  }
  for (const n of [1, 2]) {
    await page.getByRole('button', { name: `Options for slide ${n}` }).click();
    await page.getByRole('menuitem', { name: 'Move on by itself: after 5 seconds' }).click();
    await page.locator('.slide-list li').nth(n - 1).locator('.thumb-mark', { hasText: '⏱' }).waitFor();
  }
  await page.getByRole('button', { name: 'Options for slide 1' }).click();
  await page.getByRole('menuitem', { name: '✓ Move on by itself: after 5 seconds' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: /^Loop: start again after the last slide$/ }).click();
  await saved();
  const c = await content();
  const got = `${c.loop ? 'loop' : '-'} ${c.slides.map((s) => s.advance || '-').join(' ')}`;
  if (got !== 'loop 5 5 -') throw new Error(got);
});
await step('presenting moves on by itself, P pauses, and the last slide goes back to the first', async () => {
  await page.getByRole('button', { name: 'Slide 1', exact: true }).click();
  await page.getByRole('button', { name: 'Present' }).first().click();
  const p = page.getByRole('dialog', { name: 'Presenting' });
  await p.getByText('1 / 3').waitFor();
  await p.getByText('2 / 3').waitFor({ timeout: 8000 }); // after about 5 seconds
  await page.keyboard.press('p');
  await p.getByRole('button', { name: 'Resume moving on by itself' }).waitFor();
  await page.waitForTimeout(6000);
  if (!(await p.getByText('2 / 3').count())) throw new Error('moved while paused');
  await page.keyboard.press('p');
  await p.getByText('3 / 3').waitFor({ timeout: 8000 });
  // The last slide doesn't move on by itself; going on from it starts again.
  await page.waitForTimeout(6000);
  if (!(await p.getByText('3 / 3').count())) throw new Error('the last slide moved by itself');
  await page.keyboard.press('ArrowRight');
  await p.getByText('1 / 3').waitFor();
  await page.keyboard.press('Escape');
});
await step('the PowerPoint download keeps the timings and the loop', async () => {
  await page.getByRole('button', { name: 'More' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /PowerPoint/ }).click()]);
  const JSZip = (await import('module')).createRequire(`${ROOT}/server/package.json`)('jszip');
  const zip = await JSZip.loadAsync((await import('node:fs')).readFileSync(await dl.path()));
  if (!/advTm="5000"/.test(await zip.file('ppt/slides/slide2.xml').async('string'))) throw new Error('slide 2 timing');
  if (!/loop="1"/.test(await zip.file('ppt/presProps.xml').async('string'))) throw new Error('loop');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
