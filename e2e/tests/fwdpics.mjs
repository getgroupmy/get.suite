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



const gina = await mk('gina');
await step('gina-sends-a-picture-mail', async () => {
  await gina.goto(B);
  await gina.getByLabel('Email address').fill('gina@globex.com');
  await gina.getByLabel('Password').fill('password123');
  await gina.getByRole('button', { name: 'Sign in' }).click();
  await gina.getByRole('link', { name: 'Mail' }).waitFor();
  // 120x60 picture: green, uploaded to her Drive and put in an HTML mail with some formatting.
  const id = await gina.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 120; c.height = 60;
    const x = c.getContext('2d'); x.fillStyle = '#0a0'; x.fillRect(0, 0, 120, 60);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const res = await fetch('/api/files/upload?name=plan.png', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' }, body: blob });
    return (await res.json()).id;
  });
  const html = `<p style="text-align:center">The <b>floor plan</b>:</p><p align="center"><img src="/api/files/${id}/raw" alt="plan.png"></p><p>Questions? <a href="https://example.com/faq">FAQ</a></p><script>alert(1)</script>`;
  const r = await api(gina, 'POST', '/mail/send', { to: 'olivia@acme.com', subject: 'Floor plan', text: 'The floor plan', html });
  if (r.status !== 200) throw new Error(JSON.stringify(r));
}, gina);

await step('forward-shows-the-picture-in-the-editor', async () => {
  const row = page.locator('.msg-list li', { hasText: 'Floor plan' });
  await refreshUntil(page, row);
  await row.locator('.msg-row').click();
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  const img = page.locator('.compose-editor .tiptap img');
  await img.waitFor();
  await page.waitForFunction(() => document.querySelector('.compose-editor .tiptap img')?.naturalWidth === 120, null, { timeout: 10000 });
  const text = await page.locator('.compose-editor .tiptap').innerText();
  if (!/Forwarded message/.test(text) || !/The floor plan:/.test(text) || !/Questions\? FAQ/.test(text)) throw new Error('text: ' + text);
  if (!(await page.locator('.compose-editor .tiptap strong', { hasText: 'floor plan' }).count())) throw new Error('bold lost');
  if (!(await page.locator('.compose-editor .tiptap a[href="https://example.com/faq"]').count())) throw new Error('link lost');
  // Centred in the original: the line and the picture stay centred.
  if ((await page.locator('.compose-editor .tiptap p', { hasText: 'The floor plan' }).evaluate((el) => el.style.textAlign)) !== 'center') throw new Error('text alignment lost');
  if ((await page.locator('.compose-editor .tiptap .img-wrap').getAttribute('data-align')) !== 'center') throw new Error('picture alignment lost');
  // Forwarded pictures can be resized and edited like your own.
  await img.click();
  await page.getByRole('button', { name: 'Picture alignment', exact: true }).click();
  if ((await page.getByRole('menuitemradio', { name: 'Centre (picture)' }).getAttribute('aria-checked')) !== 'true') throw new Error('Centre not shown for the picture');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Medium picture/ }).click();
  await page.getByRole('button', { name: 'Crop or rotate picture' }).waitFor();
  await page.screenshot({ path: `${SP}/shots/forward-pictures.png` });
});

await step('send-the-forward', async () => {
  await page.getByLabel('To', { exact: true }).fill('gina@globex.com');
  await page.locator('.draft-state', { hasText: 'Draft saved' }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Sent to 1 recipient').waitFor();
});

await step('recipient-sees-the-picture', async () => {
  await gina.getByRole('link', { name: 'Mail' }).click();
  const row = gina.locator('.msg-list li', { hasText: 'Fwd: Floor plan' });
  await refreshUntil(gina, row);
  await row.locator('.msg-row').click();
  const f = gina.frameLocator('iframe.mail-html');
  await f.locator('img').waitFor();
  await gina.waitForTimeout(500);
  const info = await f.locator('img').evaluate((i) => ({ w: i.naturalWidth, src: i.getAttribute('src').slice(0, 14), pct: i.getAttribute('width') }));
  if (info.w !== 120 || info.src !== 'data:image/png' || info.pct !== '50%') throw new Error(JSON.stringify(info));
  const off = await f.locator('img').evaluate((i) => { const r = i.getBoundingClientRect(); const b = i.ownerDocument.body.getBoundingClientRect(); return Math.round((r.left + r.right) / 2 - (b.left + b.right) / 2); });
  if (Math.abs(off) > 3) throw new Error('recipient picture not centred: ' + off);
  const ta = await f.locator('p', { hasText: 'The floor plan' }).evaluate((el) => getComputedStyle(el).textAlign);
  if (ta !== 'center') throw new Error('recipient text alignment ' + ta);
}, gina);

await step('reply-quotes-the-picture', async () => {
  await page.locator('.msg-list li', { hasText: 'Floor plan' }).first().locator('.msg-row').click();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.compose-editor .tiptap blockquote img')?.naturalWidth === 120, null, { timeout: 10000 });
  const quote = await page.locator('.compose-editor .tiptap blockquote').innerText();
  if (!/The floor plan:/.test(quote)) throw new Error('quote: ' + quote);
  await page.locator('.compose-editor .tiptap > p').first().click();
  await page.keyboard.type('Looks great.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Sent to 1 recipient').waitFor();
  await gina.getByRole('button', { name: 'Refresh' }).click();
  const row = gina.locator('.msg-list li', { hasText: 'Re: Floor plan' });
  await refreshUntil(gina, row);
  await row.locator('.msg-row').click();
  { const q = gina.getByRole('button', { name: 'Show quoted text' }); await q.waitFor({ timeout: 5000 }).catch(() => {}); if (await q.count()) await q.click(); } // quoted history is folded away at first
  const f = gina.frameLocator('iframe.mail-html');
  await f.locator('blockquote img').waitFor();
  await gina.waitForTimeout(500);
  const w = await f.locator('blockquote img').evaluate((i) => i.naturalWidth);
  if (w !== 120) throw new Error('recipient picture width ' + w);
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
