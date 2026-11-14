import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
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
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await p.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const signIn = async (p, email) => { await p.goto(B); await p.evaluate(async (e) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: e, password: 'password123' }) }), email); };
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; for (;;) { v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKElEQVR42u3OMQEAAAgDoNm/tKbwgQJ0Uhk1NBQQEBAQEBAQEBAQEBAQ1gWjYCbJAAAAAElFTkSuQmCC', 'base64');
let kim, dm;
const msg = (p, text) => p.locator('.msg', { hasText: text }).last();
await step('setup: a direct conversation', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const dir = (await api(page, 'GET', '/users/directory')).body;
  dm = (await api(page, 'POST', '/chat/dm', { user_id: dir.find((u) => u.username === 'kim@acme.com').id })).body.id;
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/chat/${dm}`);
  await kim.getByLabel('Message', { exact: true }).waitFor();
});

await step('unread: a badge on Chat and on the conversation, cleared by reading it', async () => {
  await page.goto(`${B}/drive`);
  for (const t of ['Morning!', 'Got a minute?']) { await kim.getByLabel('Message', { exact: true }).fill(t); await kim.keyboard.press('Enter'); }
  await page.getByRole('link', { name: /Chat/ }).getByLabel('2 unread').waitFor();
  await page.getByRole('link', { name: /Chat/ }).click();
  await page.locator('.subnav-item', { hasText: 'Kim Park' }).getByText('2').waitFor();
  await page.locator('.subnav-item', { hasText: 'Kim Park' }).click();
  await page.locator('.msg', { hasText: 'Got a minute?' }).waitFor();
  await until(async () => (await page.getByRole('link', { name: /Chat/ }).getByLabel(/unread/).count()) === 0);
});

await step('react to a message; the other person sees it, and can add theirs', async () => {
  await msg(page, 'Got a minute?').hover();
  await msg(page, 'Got a minute?').getByRole('button', { name: 'React with 👍' }).click();
  await msg(kim, 'Got a minute?').getByRole('button', { name: '👍 1: Olivia Owner' }).waitFor();
  await msg(kim, 'Got a minute?').getByRole('button', { name: /^👍 1/ }).click();
  await msg(page, 'Got a minute?').getByRole('button', { name: '👍 2: Olivia Owner, Kim Park' }).waitFor();
});

await step('edit your own message', async () => {
  await msg(kim, 'Morning!').hover();
  await msg(kim, 'Morning!').getByRole('button', { name: 'Edit message' }).click();
  await kim.getByLabel('Change the message').fill('Good morning!');
  await kim.keyboard.press('Enter');
  await msg(page, 'Good morning!').getByText('(edited)').waitFor();
  await msg(page, 'Good morning!').hover();
  if (await msg(page, 'Good morning!').getByRole('button', { name: 'Edit message' }).count()) throw new Error("can edit someone else's");
});

await step('attach a picture and a file; the other person sees the picture and can download the file', async () => {
  await page.getByLabel('Files to attach').setInputFiles([{ name: 'chart.png', mimeType: 'image/png', buffer: PNG }, { name: 'notes.odt', mimeType: 'application/vnd.oasis.opendocument.text', buffer: Buffer.from('agenda') }]);
  await page.getByRole('list', { name: 'Files to send' }).getByText('notes.odt').waitFor();
  await page.getByLabel('Message', { exact: true }).fill('Here you go');
  await page.keyboard.press('Enter');
  const m = msg(kim, 'Here you go');
  await until(() => m.locator('img[alt="chart.png"]').evaluate((el) => el.complete && el.naturalWidth === 64).catch(() => false));
  await m.getByRole('link', { name: /notes\.odt/ }).click(); // opens in the viewer, which has Download
  const [dl] = await Promise.all([kim.waitForEvent('download'), kim.getByRole('dialog').getByRole('link', { name: 'Download' }).or(kim.getByRole('dialog').getByRole('button', { name: 'Download' })).first().click()]);
  await kim.keyboard.press('Escape');
  if (dl.suggestedFilename() !== 'notes.odt') throw new Error(dl.suggestedFilename());
  await kim.screenshot({ path: `${SP}/shots/chat2.png` });
});

await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
await browser.close();
process.exit(failed ? 1 : 0);
