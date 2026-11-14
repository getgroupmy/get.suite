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

await step('folder ⋮ → Upload emails (.eml)… puts saved emails into it, with their own date; again is skipped', async () => {
  const eml = (n, extra = '') => Buffer.from(`From: Old Friend <friend@example.org>\nTo: olivia@acme.com\nSubject: Saved email ${n}\nDate: Tue, 03 Mar 2015 10:00:00 +0000\nMessage-ID: <saved-${n}@example.org>\n${extra}MIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\nKept since 2015 (${n}).\n`);
  await page.getByRole('button', { name: 'Options for Inbox' }).click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'Upload emails (.eml or .zip)…' }).click()]);
  await chooser.setFiles([{ name: 'one.eml', mimeType: 'message/rfc822', buffer: eml('one') }, { name: 'two.eml', mimeType: 'message/rfc822', buffer: eml('two', 'Status: O\n') }]);
  await page.getByText('2 emails added to Inbox').waitFor();
  await refreshUntil(page, page.getByText('Saved email two'));
  await page.getByText('Saved email one').first().click();
  await page.getByText('Kept since 2015 (one).').waitFor();
  await page.getByRole('button', { name: 'Options for Inbox' }).click();
  const [again] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'Upload emails (.eml or .zip)…' }).click()]);
  await again.setFiles([{ name: 'one.eml', mimeType: 'message/rfc822', buffer: eml('one') }, { name: 'notes.eml', mimeType: 'message/rfc822', buffer: Buffer.from('not an email') }]);
  await page.getByText('0 emails added to Inbox, 1 already there').waitFor();
  await page.getByText(/notes\.eml: That isn’t an email file/).waitFor();
});

const dropFiles = (selector, files) => page.evaluate(([sel, fs]) => {
  const el = document.querySelector(sel);
  const dt = new DataTransfer();
  for (const f of fs) dt.items.add(new File([f.text], f.name, { type: f.type }));
  el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
  el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
  el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, [selector, files]);
const emlText = (n) => `From: Old Friend <friend@example.org>\nTo: olivia@acme.com\nSubject: Dropped email ${n}\nDate: Wed, 04 Mar 2015 10:00:00 +0000\nMessage-ID: <dropped-${n}@example.org>\nMIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\n\nDropped in (${n}).\n`;

await step('drop .eml files on a folder in the sidebar: they go into it; other files are refused', async () => {
  await api(page, 'POST', '/mail/folders', { name: 'Old mail' });
  await page.reload();
  await page.locator('.folder-row', { hasText: 'Old mail' }).waitFor();
  const idx = await page.locator('.folder-row').evaluateAll((rows) => rows.findIndex((r) => r.textContent.includes('Old mail')));
  await page.evaluate((i) => document.querySelectorAll('.folder-row')[i].querySelector('.subnav-item').setAttribute('data-test-drop', '1'), idx);
  await dropFiles('[data-test-drop="1"]', [{ name: 'a.eml', type: 'message/rfc822', text: emlText('a') }, { name: 'photo.png', type: 'image/png', text: 'x' }]);
  await page.getByText('1 email added to Old mail').waitFor();
  await page.getByText('Only emails saved as .eml files (or a .zip of them) can be dropped here').waitFor();
  await page.locator('.folder-row', { hasText: 'Old mail' }).locator('.subnav-item').click();
  await refreshUntil(page, page.getByText('Dropped email a'));
});

await step('drop .eml files on the message list: they go into the folder being looked at', async () => {
  await dropFiles('section.mail-list', [{ name: 'b.eml', type: 'message/rfc822', text: emlText('b') }]);
  await page.getByText('1 email added to Old mail').first().waitFor();
  await refreshUntil(page, page.getByText('Dropped email b'));
});

let zipPath;
await step('select messages → Download (.zip): one .eml per message, dated and named by subject', async () => {
  await page.getByLabel('Select Dropped email a').check();
  await page.getByLabel('Select Dropped email b').check();
  await page.getByText('2 selected').waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download (.zip)' }).click()]);
  if (!/^Old mail \(2 messages\)\.zip$/.test(dl.suggestedFilename())) throw new Error(dl.suggestedFilename());
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  zipPath = await dl.path();
  const zip = await JSZip.loadAsync((await import('node:fs')).readFileSync(zipPath));
  const names = Object.keys(zip.files).sort().join(' | ');
  if (names !== '2015-03-04 Dropped email a.eml | 2015-03-04 Dropped email b.eml') throw new Error(names);
});

await step('upload that .zip into another folder: both emails come back', async () => {
  await api(page, 'POST', '/mail/folders', { name: 'Restored' });
  await page.reload();
  await page.locator('.folder-row', { hasText: 'Restored' }).hover();
  await page.getByRole('button', { name: 'Options for Restored' }).click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: 'Upload emails (.eml or .zip)…' }).click()]);
  await chooser.setFiles({ name: 'Old mail (2 messages).zip', mimeType: 'application/zip', buffer: (await import('node:fs')).readFileSync(zipPath) });
  await page.getByText('2 emails added to Restored').waitFor();
  await page.locator('.folder-row', { hasText: 'Restored' }).locator('.subnav-item').click();
  await refreshUntil(page, page.getByText('Dropped email b'));
  await page.getByText('Dropped email a').first().waitFor();
});

await step('folder ⋮ → Download folder (.zip): every message in it', async () => {
  await page.locator('.folder-row', { hasText: 'Restored' }).hover();
  await page.getByRole('button', { name: 'Options for Restored' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Download folder (.zip)' }).click()]);
  if (dl.suggestedFilename() !== 'Restored (2 messages).zip') throw new Error(dl.suggestedFilename());
  const JSZip = (await import(`${ROOT}/server/node_modules/jszip/lib/index.js`)).default;
  const names = Object.keys((await JSZip.loadAsync((await import('node:fs')).readFileSync(await dl.path()))).files).sort().join(' | ');
  if (names !== '2015-03-04 Dropped email a.eml | 2015-03-04 Dropped email b.eml') throw new Error(names);
});

await step('a folder emptied since the list loaded: Download folder says it is empty instead of saving an error', async () => {
  await api(page, 'POST', '/mail/folders', { name: 'Soon empty' });
  const eml = 'From: A <a@example.org>\r\nSubject: Gone soon\r\nMessage-ID: <gone-soon@example.org>\r\n\r\nx\r\n';
  await page.evaluate(async (t) => { await fetch('/api/mail/messages/upload?folder=Soon%20empty', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'message/rfc822' }, body: t }); }, eml);
  await page.reload();
  await page.locator('.folder-row', { hasText: 'Soon empty' }).hover();
  await page.getByRole('button', { name: 'Options for Soon empty' }).click();
  await page.getByRole('menuitem', { name: 'Download folder (.zip)' }).waitFor();
  await page.keyboard.press('Escape');
  const list = (await api(page, 'GET', '/mail/messages?folder=Soon%20empty')).body.messages;
  await api(page, 'POST', '/mail/messages/delete', { folder: 'Soon empty', uids: list.map((m) => m.uid) });
  await api(page, 'POST', '/mail/folders/empty', { folder: 'Trash' }).catch(() => {});
  let downloaded = false;
  page.once('download', () => { downloaded = true; });
  await page.locator('.folder-row', { hasText: 'Soon empty' }).hover();
  await page.getByRole('button', { name: 'Options for Soon empty' }).click();
  await page.getByRole('menuitem', { name: 'Download folder (.zip)' }).click();
  await page.getByText('That folder is empty').waitFor();
  await page.waitForTimeout(500);
  if (downloaded) throw new Error('an error file was downloaded');
});

await step('select messages → Print: one printout, a page each', async () => {
  await page.locator('.folder-row', { hasText: 'Old mail' }).locator('.subnav-item').click();
  await refreshUntil(page, page.getByText('Dropped email b'));
  for (const s of ['a', 'b']) { const box = page.getByLabel(`Select Dropped email ${s}`); if (!(await box.isChecked())) await box.check(); }
  await page.getByText('2 selected').waitFor();
  await page.locator('.mail-bulk').getByRole('button', { name: 'Print' }).click();
  await page.waitForFunction(() => { const f = [...document.querySelectorAll('iframe.print-frame')].pop(); return f && /<section class="msg">[\s\S]*<section class="msg">/.test(f.getAttribute('srcdoc')); });
  const html = await page.locator('iframe.print-frame').last().getAttribute('srcdoc');
  if (!/Dropped email a/.test(html) || !/Dropped email b/.test(html) || !/Dropped in \(a\)/.test(html)) throw new Error(html.slice(0, 300));
});

console.log('ERRORS:', JSON.stringify(errors));
await browser.close();
