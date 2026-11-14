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


const img = () => page.locator('.compose-editor .tiptap img').first();
const attrs = () => img().evaluate((i) => ({ src: i.getAttribute('src'), alt: i.alt, width: i.closest('.img-wrap').getAttribute('data-width') }));
// Natural size, type and the colour at a few points (fractions) of a picture on the server.
const probe = (p, src, points) => p.evaluate(async ([s, pts]) => {
  const b = await (await fetch(s)).blob();
  const bm = await createImageBitmap(b);
  const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height;
  const ctx = c.getContext('2d'); ctx.drawImage(bm, 0, 0);
  const name = ([r, g, bl]) => (r > 200 && g < 60 && bl < 60 ? 'red' : r < 60 && g < 60 && bl > 200 ? 'blue' : r < 60 && g > 150 && bl < 60 ? 'green' : `${r},${g},${bl}`);
  return { w: bm.width, h: bm.height, type: b.type, at: pts.map(([x, y]) => name(ctx.getImageData(Math.min(bm.width - 1, Math.floor(x * bm.width)), Math.min(bm.height - 1, Math.floor(y * bm.height)), 1, 1).data)) };
}, [src, points]);
const dialog = () => page.getByRole('dialog', { name: 'Crop and rotate picture' });
const sizeText = async () => (await dialog().locator('.crop-size').textContent()).trim();

await step('insert-test-picture', async () => {
  // 200x100: red left half, blue right half, green 10px square in the top-left corner.
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 200; c.height = 100;
    const x = c.getContext('2d');
    x.fillStyle = '#f00'; x.fillRect(0, 0, 100, 100);
    x.fillStyle = '#00f'; x.fillRect(100, 0, 100, 100);
    x.fillStyle = '#0f0'; x.fillRect(0, 0, 10, 10);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.getByRole('button', { name: 'Compose' }).click();
  await page.getByLabel('To', { exact: true }).fill('gina@globex.com');
  await page.getByLabel('Subject').fill('Edited picture');
  await page.locator('.compose-editor .tiptap').click();
  await page.keyboard.type('Picture:');
  await page.keyboard.press('Enter');
  await page.getByLabel('Picture file').setInputFiles({ name: 'halves.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
  await img().waitFor();
  await img().click();
  await page.getByRole('button', { name: /^Medium picture/ }).click();
});

let original;
await step('cancel-changes-nothing', async () => {
  original = await attrs();
  await img().dblclick();
  await dialog().waitFor();
  await page.getByRole('button', { name: 'Rotate right' }).click();
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'detached' });
  if ((await attrs()).src !== original.src) throw new Error('picture changed after cancel');
});

await step('rotate-right-with-double-click', async () => {
  await img().dblclick();
  await dialog().waitFor();
  if ((await sizeText()) !== '200 × 100 px') throw new Error('start size ' + await sizeText());
  await page.getByRole('button', { name: 'Rotate right' }).click();
  if ((await sizeText()) !== '100 × 200 px') throw new Error('rotated size ' + await sizeText());
  await page.screenshot({ path: `${SP}/shots/crop-rotate-dialog.png` });
  await dialog().getByRole('button', { name: 'Apply' }).click();
  await dialog().waitFor({ state: 'detached' });
  const rotated = await attrs();
  if (rotated.src === original.src) throw new Error('src not replaced');
  if (rotated.alt !== 'halves (edited).png') throw new Error('alt ' + rotated.alt);
  if (rotated.width !== '50') throw new Error('width lost: ' + rotated.width);
  // Clockwise: the left (red) half is now on top, the green corner at the top right.
  const p = await probe(page, rotated.src, [[0.5, 0.25], [0.5, 0.75], [0.97, 0.03]]);
  if (p.w !== 100 || p.h !== 200) throw new Error(`size ${p.w}x${p.h}`);
  if (p.at.join() !== 'red,blue,green') throw new Error('colours ' + p.at.join());
  if (p.type !== 'image/png') throw new Error('type ' + p.type);
});

await step('undo-puts-original-back', async () => {
  await page.locator('.compose-editor .tiptap').focus();
  await page.keyboard.press('Control+z');
  await page.waitForFunction((s) => document.querySelector('.compose-editor .tiptap img')?.getAttribute('src') === s, original.src, { timeout: 5000 });
  const back = await probe(page, original.src, [[0.25, 0.5]]);
  if (back.w !== 200 || back.h !== 100) throw new Error('original changed on the server');
});

let cropped;
await step('square-crop-moved-to-the-left', async () => {
  await img().click();
  await page.getByRole('button', { name: 'Crop or rotate picture' }).click();
  await dialog().waitFor();
  await dialog().getByRole('button', { name: 'Square' }).click();
  if ((await sizeText()) !== '100 × 100 px') throw new Error('square size ' + await sizeText());
  // Drag the frame far to the left: it stops at the edge.
  const f = await dialog().locator('.crop-frame').boundingBox();
  await page.mouse.move(f.x + f.width / 2, f.y + f.height / 2);
  await page.mouse.down();
  await page.mouse.move(f.x - 400, f.y + f.height / 2, { steps: 6 });
  await page.mouse.up();
  await dialog().getByRole('button', { name: 'Apply' }).click();
  await dialog().waitFor({ state: 'detached' });
  cropped = await attrs();
  const p = await probe(page, cropped.src, [[0.02, 0.02], [0.5, 0.5], [0.97, 0.97]]);
  if (p.w !== 100 || p.h !== 100) throw new Error(`size ${p.w}x${p.h}`);
  if (p.at.join() !== 'green,red,red') throw new Error('colours ' + p.at.join());
});

await step('handle-and-keyboard-crop', async () => {
  await img().dblclick();
  await dialog().waitFor();
  // Drag the right edge in to about half the width.
  const h = await dialog().locator('.crop-handle.e').boundingBox();
  const f = await dialog().locator('.crop-frame').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 - f.width / 2, h.y + h.height / 2, { steps: 6 });
  await page.mouse.up();
  const [w] = (await sizeText()).match(/\d+/g).map(Number);
  if (Math.abs(w - 50) > 3) throw new Error('after handle drag ' + await sizeText());
  // Keyboard: Shift+Up shrinks the height 1% at a time; arrows move the frame.
  await dialog().locator('.crop-frame').focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowUp');
  const [w2, h2] = (await sizeText()).match(/\d+/g).map(Number);
  if (h2 !== 90 || w2 !== w) throw new Error('after keyboard ' + await sizeText());
  await page.keyboard.press('ArrowRight');
  await dialog().getByRole('button', { name: 'Cancel' }).click();
  await dialog().waitFor({ state: 'detached' });
  if ((await attrs()).src !== cropped.src) throw new Error('cancel changed the picture');
});

await step('jpeg-stays-jpeg', async () => {
  const b64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 80; c.height = 40; const x = c.getContext('2d'); x.fillStyle = '#00f'; x.fillRect(0, 0, 80, 40); return c.toDataURL('image/jpeg').split(',')[1]; });
  await page.locator('.compose-editor .tiptap > p').last().click();
  await page.getByLabel('Picture file').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') });
  const second = page.locator('.compose-editor .tiptap img').nth(1);
  await second.waitFor();
  await second.dblclick();
  await dialog().waitFor();
  await page.getByRole('button', { name: 'Rotate left' }).click();
  await dialog().getByRole('button', { name: 'Apply' }).click();
  await dialog().waitFor({ state: 'detached' });
  const a = await second.evaluate((i) => ({ src: i.getAttribute('src'), alt: i.alt }));
  if (a.alt !== 'photo (edited).jpg') throw new Error('alt ' + a.alt);
  const p = await probe(page, a.src, [[0.5, 0.5]]);
  if (p.type !== 'image/jpeg' || p.w !== 40 || p.h !== 80 || p.at[0] !== 'blue') throw new Error(JSON.stringify(p));
});

await step('send-edited', async () => {
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText('Sent to 1 recipient').waitFor();
});

const gina = await mk('gina');
await step('recipient-gets-edited-pictures', async () => {
  await gina.goto(B);
  await gina.getByLabel('Email address').fill('gina@globex.com');
  await gina.getByLabel('Password').fill('password123');
  await gina.getByRole('button', { name: 'Sign in' }).click();
  await gina.getByRole('link', { name: 'Mail' }).click();
  const row = gina.locator('.msg-list li', { hasText: 'Edited picture' });
  await refreshUntil(gina, row);
  await row.locator('.msg-row').click();
  const f = gina.frameLocator('iframe.mail-html');
  await f.locator('img').nth(1).waitFor();
  await gina.waitForTimeout(800);
  const sizes = await f.locator('img').evaluateAll((list) => list.map((i) => `${i.naturalWidth}x${i.naturalHeight}`));
  if (sizes.join() !== '100x100,40x80') throw new Error('recipient sizes ' + sizes.join());
}, gina);

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
