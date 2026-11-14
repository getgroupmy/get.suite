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

await step('handle-only-when-selected', async () => {
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('gina@globex.com');
  await page.getByLabel('Subject').fill('Dragged picture');
  await page.locator('.compose-editor .tiptap').click();
  await page.keyboard.type('Picture:');
  await page.keyboard.press('Enter');
  await page.getByLabel('Picture file').setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: PNG });
  await wrap().waitFor();
  if (await page.locator('.img-handle').isVisible()) throw new Error('handle visible before selecting');
  await page.locator('.compose-editor .tiptap img').click();
  await page.locator('.img-handle').waitFor({ state: 'visible' });
});

await step('drag-to-any-width', async () => {
  await dragTo(40);
  const w = await width();
  if (Math.abs(w - 40) > 3) throw new Error(`stored ${w}%`);
  if (Math.abs((await shown()) - w) > 2) throw new Error(`shown ${await shown()}% vs stored ${w}%`);
  await page.screenshot({ path: `${SP}/shots/drag-resize.png` });
});

await step('snaps-near-presets', async () => {
  await page.locator('.compose-editor .tiptap img').click();
  await dragTo(51);
  if ((await width()) !== 50) throw new Error(`expected snap to 50, got ${await width()}`);
  if (!(await page.getByRole('button', { name: /^Medium picture/ }).getAttribute('aria-pressed') === 'true')) throw new Error('Medium preset not highlighted');
});

await step('keyboard-resizing', async () => {
  await page.locator('.compose-editor .tiptap img').click();
  await page.locator('.img-handle').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  if ((await width()) !== 60) throw new Error(`after 2x right: ${await width()}`);
  await page.locator('.img-handle').focus();
  await page.keyboard.press('Shift+ArrowLeft');
  if ((await width()) !== 59) throw new Error(`after shift+left: ${await width()}`);
  const now = await page.locator('.img-handle').getAttribute('aria-valuenow');
  if (now !== '59') throw new Error('aria-valuenow ' + now);
  await page.locator('.img-handle').focus();
  await page.keyboard.press('End');
  if ((await width()) !== 100) throw new Error('End should be full width');
  await page.locator('.img-handle').focus();
  await page.keyboard.press('Home');
  if ((await width()) !== 10) throw new Error('Home should be the smallest size');
});

await step('presets-still-work', async () => {
  await page.locator('.compose-editor .tiptap img').click();
  await page.getByRole('button', { name: /^Large picture/ }).click();
  if ((await width()) !== 75) throw new Error(`preset gave ${await width()}`);
  await page.locator('.compose-editor .tiptap img').click();
  await dragTo(33);
  if (Math.abs((await width()) - 33) > 3) throw new Error(`stored ${await width()}%`);
});

// Where the picture sits in the message: offset of its centre from the text area's centre, in px.
const offCentre = () => page.evaluate(() => {
  const w = document.querySelector('.compose-editor .tiptap .img-wrap').getBoundingClientRect();
  const e = document.querySelector('.compose-editor .tiptap'); const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
  const left = r.left + parseFloat(cs.paddingLeft), right = r.right - parseFloat(cs.paddingRight);
  return { centre: Math.round((w.left + w.right) / 2 - (left + right) / 2), leftGap: Math.round(w.left - left), rightGap: Math.round(right - w.right) };
});
await step('centre-and-right-align-the-picture', async () => {
  await page.locator('.compose-editor .tiptap img').click();
  const pick = async (item) => {
    await page.getByRole('button', { name: 'Picture alignment', exact: true }).click();
    const m = page.getByRole('menu', { name: 'Picture alignment' });
    await m.getByRole('menuitemradio', { name: item }).click();
    await m.waitFor({ state: 'detached' });
  };
  await page.getByRole('button', { name: 'Picture alignment', exact: true }).click();
  if ((await page.getByRole('menuitemradio', { name: 'Align left (picture)' }).getAttribute('aria-checked')) !== 'true') throw new Error('left by default');
  await page.keyboard.press('Escape');
  await pick('Centre (picture)');
  await page.waitForFunction(() => document.querySelector('.compose-editor .tiptap .img-wrap').dataset.align === 'center');
  if (Math.abs((await offCentre()).centre) > 2) throw new Error('not centred: ' + JSON.stringify(await offCentre()));
  await pick('Align right (picture)');
  await page.waitForFunction(() => document.querySelector('.compose-editor .tiptap .img-wrap').dataset.align === 'right');
  if ((await offCentre()).rightGap > 2) throw new Error('not right: ' + JSON.stringify(await offCentre()));
  await pick('Align left (picture)');
  await page.waitForFunction(() => !document.querySelector('.compose-editor .tiptap .img-wrap').dataset.align);
  if ((await offCentre()).leftGap > 2) throw new Error('not left: ' + JSON.stringify(await offCentre()));
  // The paragraph above is untouched: the buttons aligned only the picture.
  if (await page.evaluate(() => [...document.querySelectorAll('.compose-editor .tiptap p')].some((p) => p.style.textAlign))) throw new Error('paragraph aligned too');
  await pick('Centre (picture)');
  await page.waitForFunction(() => document.querySelector('.compose-editor .tiptap .img-wrap').dataset.align === 'center');
  await page.screenshot({ path: `${SP}/shots/centred-picture.png` });
});

let finalWidth;
await step('size-kept-in-draft-then-sent', async () => {
  finalWidth = await width();
  await page.locator('.draft-state', { hasText: 'Draft saved' }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: /^Drafts/ }).click();
  await page.locator('.msg-list li', { hasText: 'Dragged picture' }).locator('.msg-row').click();
  await wrap().waitFor();
  if ((await width()) !== finalWidth) throw new Error(`draft reopened at ${await width()}%, saved ${finalWidth}%`);
  if ((await wrap().getAttribute('data-align')) !== 'center') throw new Error('draft lost the centring');
  if (Math.abs((await offCentre()).centre) > 2) throw new Error('reopened draft not centred');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText('Sent to 1 recipient').waitFor();
});

const gina = await mk('gina');
await step('recipient-sees-same-width', async () => {
  await gina.goto(B);
  await gina.getByLabel('Email address').fill('gina@globex.com');
  await gina.getByLabel('Password').fill('password123');
  await gina.getByRole('button', { name: 'Sign in' }).click();
  await gina.getByRole('link', { name: 'Mail' }).click();
  const row = gina.locator('.msg-list li', { hasText: 'Dragged picture' });
  await refreshUntil(gina, row);
  await row.locator('.msg-row').click();
  const f = gina.frameLocator('iframe.mail-html');
  await f.locator('img').waitFor();
  const ratio = await f.locator('img').evaluate((i) => i.getBoundingClientRect().width / i.parentElement.getBoundingClientRect().width);
  if (Math.abs(ratio * 100 - finalWidth) > 3) throw new Error(`recipient sees ${Math.round(ratio * 100)}%, sent ${finalWidth}%`);
  const off = await f.locator('img').evaluate((i) => { const r = i.getBoundingClientRect(); const b = i.ownerDocument.body.getBoundingClientRect(); return Math.round((r.left + r.right) / 2 - (b.left + b.right) / 2); });
  if (Math.abs(off) > 3) throw new Error('recipient picture not centred: ' + off);
}, gina);

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
