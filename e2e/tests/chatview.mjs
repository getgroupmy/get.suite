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
const req = (await import('module')).createRequire(`${ROOT}/server/package.json`);
const { Document, Packer, Paragraph } = req('docx');
const JSZip = req('jszip');
const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Agenda for Thursday')] }] }));
const zz = new JSZip(); zz.file('logos/main.png', 'x'); const zipBuf = await zz.generateAsync({ type: 'nodebuffer' });
const dlg = (p) => p.getByRole('dialog');
await step('files sent in chat open in the viewer for the other person, arrows go through them', async () => {
  const folder = (await api(page, 'POST', '/chat/files-folder')).body.id;
  const up = (name, b64) => page.evaluate(async ([n, f, d]) => (await (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}&parent=${f}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: Uint8Array.from(atob(d), (c) => c.charCodeAt(0)) })).json()).id, [name, folder, b64]);
  const ids = [await up('banner.png', PNG.toString('base64')), await up('notes.txt', Buffer.from('Bring the samples').toString('base64')),
    await up('Agenda.docx', docx.toString('base64')), await up('Logos.zip', zipBuf.toString('base64')), await up('tool.exe', Buffer.from('MZ').toString('base64'))];
  await api(page, 'POST', `/chat/channels/${dm}/messages`, { body: 'For the meeting', files: ids });
  const m = msg(kim, 'For the meeting');
  await m.getByRole('img', { name: 'banner.png' }).click();
  await dlg(kim).getByRole('img', { name: 'banner.png' }).waitFor();
  await dlg(kim).getByText('1 of 4').waitFor();
  await kim.keyboard.press('ArrowRight');
  await kim.frameLocator('iframe[title="notes.txt"]').getByText('Bring the samples').waitFor();
  await dlg(kim).getByRole('button', { name: 'Next file' }).click();
  await dlg(kim).getByText('Agenda for Thursday').waitFor();
  await kim.keyboard.press('ArrowRight');
  await dlg(kim).getByRole('list', { name: 'Inside the zip' }).getByText('main.png').waitFor();
  // Someone else's file sent in chat: Save to Drive keeps a copy of your own (added after this test was first written).
  if (!(await dlg(kim).getByRole('button', { name: 'Save to Drive' }).count())) throw new Error('no Save to Drive for a file sent to you');
  const [dl] = await Promise.all([kim.waitForEvent('download'), dlg(kim).getByRole('link', { name: 'Download' }).click()]);
  if (dl.suggestedFilename() !== 'Logos.zip') throw new Error(dl.suggestedFilename());
  await kim.keyboard.press('Escape');
  await dlg(kim).waitFor({ state: 'detached' });
});
await step('other kinds still download, and Shift+click downloads anything', async () => {
  const m = msg(kim, 'For the meeting');
  const [dl] = await Promise.all([kim.waitForEvent('download'), m.getByRole('link', { name: /tool\.exe/ }).click()]);
  if (dl.suggestedFilename() !== 'tool.exe') throw new Error(dl.suggestedFilename());
  const link = m.getByRole('link', { name: /notes\.txt/ });
  if (!(await link.getAttribute('href')).endsWith('?download')) throw new Error('href');
  const popup = kim.context().waitForEvent('page', { timeout: 5000 }).catch(() => null);
  await link.click({ modifiers: ['Shift'] });
  await popup;
  await kim.waitForTimeout(300);
  if (await dlg(kim).count()) throw new Error('no viewer');
});
if (errors.length) { failed++; console.log('FAIL errors', errors.join(' | ').slice(0, 400)); }
await browser.close();
process.exit(failed ? 1 : 0);
