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
await step('three slides; skip the middle one and give the last a fade', async () => {
  for (let k = 0; k < 2; k++) {
    await page.getByRole('button', { name: 'New slide' }).click();
    await page.getByRole('menuitem', { name: 'Title and text' }).click();
    await page.getByRole('button', { name: `Slide ${k + 2}`, exact: true }).waitFor();
  }
  await page.getByRole('button', { name: 'Options for slide 2' }).click();
  await page.getByRole('menuitem', { name: 'Skip when presenting' }).click();
  await page.locator('.slide-list li.skipped').waitFor();
  await page.getByRole('button', { name: 'Options for slide 3' }).click();
  await page.getByRole('menuitem', { name: 'Transition: Fade' }).click();
  await page.locator('.slide-list li').nth(2).locator('.thumb-mark', { hasText: '✦' }).waitFor();
  await page.getByRole('button', { name: 'Options for slide 3' }).click();
  await page.getByRole('menuitem', { name: '✓ Transition: Fade' }).waitFor();
  await page.keyboard.press('Escape');
  await saved();
  const c = await content();
  const got = c.slides.map((s) => `${s.skip ? 'skip' : '-'}/${s.transition || '-'}`).join(' ');
  if (got !== '-/- skip/- -/fade') throw new Error(got);
});
await step('presenting passes over the skipped slide and fades in the last', async () => {
  await page.getByRole('button', { name: 'Slide 1', exact: true }).click();
  await page.getByRole('button', { name: 'Present' }).first().click();
  const p = page.getByRole('dialog', { name: 'Presenting' });
  await p.getByText('1 / 3').waitFor();
  await page.keyboard.press('ArrowRight');
  await p.getByText('3 / 3').waitFor();
  const anim = await p.locator('.presenter-slide').evaluate((el) => getComputedStyle(el).animationName);
  if (anim !== 'tr-fade') throw new Error('animation ' + anim);
  await page.keyboard.press('ArrowLeft');
  await p.getByText('1 / 3').waitFor();
  await page.keyboard.press('Escape');
  await p.waitFor({ state: 'detached' });
});
await step('presenting from a skipped slide starts at the next shown one; Show when presenting undoes it', async () => {
  await page.getByRole('button', { name: 'Slide 2', exact: true }).click();
  await page.getByRole('button', { name: 'Present' }).first().click();
  const p = page.getByRole('dialog', { name: 'Presenting' });
  await p.getByText('3 / 3').waitFor();
  await page.keyboard.press('Escape');
  await p.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Options for slide 2' }).click();
  await page.getByRole('menuitem', { name: 'Show when presenting' }).click();
  await until(async () => (await page.locator('.slide-list li.skipped').count()) === 0);
});
await step('PowerPoint download keeps the skipped slide hidden', async () => {
  await page.getByRole('button', { name: 'Options for slide 2' }).click();
  await page.getByRole('menuitem', { name: 'Skip when presenting' }).click();
  await saved();
  const r = await page.request.get(`${B}/api/files/${deckId}/export`);
  if (r.status() !== 200) throw new Error('export ' + r.status());
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const zip = await JSZip.loadAsync(await r.body());
  if (!/ show="0"/.test(await zip.file('ppt/slides/slide2.xml').async('string'))) throw new Error('not hidden');
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.slice(0, 3).join(' | ')); });
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(typeof errors !== 'undefined' ? errors : []));
await browser.close();
