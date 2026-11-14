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
const upload = (p, name, b64, parent) => p.evaluate(async ([n, d, par]) => {
  const bytes = Uint8Array.from(atob(d), (c) => c.charCodeAt(0));
  const r = await fetch(`/api/files/upload?name=${encodeURIComponent(n)}${par ? `&parent=${par}` : ''}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/octet-stream' }, body: bytes });
  return r.json();
}, [name, b64, parent]);
const anonCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const anon = await anonCtx.newPage();
anon.on('pageerror', (e) => errors.push(`anon: ${e.message}`));
anon.on('console', (m) => m.type() === 'error' && !/40[0-4]|410|Content Security|sandboxed/.test(m.text()) && errors.push(`anon: ${m.text()}`));
await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: B });

await step('setup', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await upload(page, 'photo.png', PNG.toString('base64'));
  const f = (await api(page, 'POST', '/files/folder', { name: 'For client' })).body;
  const sub = (await api(page, 'POST', '/files/folder', { name: 'Drawings', parent_id: f.id })).body;
  await upload(page, 'brief.txt', Buffer.from('Project brief, version 2').toString('base64'), f.id);
  await upload(page, 'plan.txt', Buffer.from('Ground floor plan').toString('base64'), sub.id);
});

let fileLink, folderLink;
await step('create a link for a file and copy it', async () => {
  await page.goto(B + '/drive');
  await page.getByLabel('Actions for photo.png').click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  const sec = page.getByRole('region', { name: 'Link sharing' });
  await sec.getByText('Anyone with a link can view and download this file').waitFor();
  await sec.getByLabel('Link expiry').selectOption('');
  await sec.getByRole('button', { name: 'Create link' }).click();
  await page.getByText('Link created and copied').waitFor();
  fileLink = await sec.getByLabel('Share link').inputValue();
  if (!/\/s\/[A-Za-z0-9_-]{24}$/.test(fileLink)) throw new Error(fileLink);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  if (clip !== fileLink) throw new Error(`clipboard: ${clip}`);
  await sec.getByText('No expiry · Not opened yet').waitFor();
  await page.screenshot({ path: `${SP}/shots/links-dialog.png` });
  await page.keyboard.press('Escape');
});

await step('someone without an account opens the file link', async () => {
  await anon.goto(fileLink);
  await anon.getByRole('heading', { name: 'photo.png' }).waitFor();
  await anon.getByText('Shared by Olivia Owner · Acme Trading').waitFor();
  await anon.locator('img.preview-media').waitFor();
  const ok = await anon.locator('img.preview-media').evaluate((i) => i.complete && i.naturalWidth === 64);
  if (!ok) throw new Error('picture did not load');
  const href = await anon.getByRole('link', { name: 'Download' }).getAttribute('href');
  const [dl] = await Promise.all([anon.waitForEvent('download'), anon.getByRole('link', { name: 'Download' }).click()]);
  if (dl.suggestedFilename() !== 'photo.png') throw new Error(dl.suggestedFilename() + ' ' + href);
  if ((await anon.title()) !== 'photo.png') throw new Error(await anon.title());
  await anon.screenshot({ path: `${SP}/shots/links-file.png` });
});

await step('the owner sees it was opened', async () => {
  await page.getByLabel('Actions for photo.png').click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  await page.getByText('No expiry · Opened once').waitFor();
  await page.keyboard.press('Escape');
});

await step('password-protected folder link', async () => {
  await page.getByLabel('Actions for For client').click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  const sec = page.getByRole('region', { name: 'Link sharing' });
  await sec.getByText('this folder and everything in it').waitFor();
  await sec.getByLabel('Password', { exact: true }).check();
  await sec.getByLabel('Link password').fill('abc');
  if (await sec.getByRole('button', { name: 'Create link' }).isEnabled()) throw new Error('short password allowed');
  await sec.getByLabel('Link password').fill('blueprint');
  await sec.getByRole('button', { name: 'Create link' }).click();
  await page.getByText('Link created and copied').waitFor();
  folderLink = await sec.getByLabel('Share link').inputValue();
  await sec.getByText(/^Until .* · Password · Not opened yet$/).waitFor();
  await page.keyboard.press('Escape');

  await anon.goto(folderLink);
  await anon.getByText('Olivia Owner protected this folder with a password.').waitFor();
  await anon.getByLabel('Password').fill('wrong-pass');
  await anon.getByRole('button', { name: 'Open' }).click();
  await anon.getByRole('alert').getByText('That password is not right').waitFor();
  await anon.getByLabel('Password').fill('blueprint');
  await anon.getByRole('button', { name: 'Open' }).click();
  await anon.getByRole('heading', { name: 'For client' }).waitFor();
  await anon.getByText(/This link works until/).waitFor();
  await anon.locator('.link-items').waitFor();
  const names = await anon.locator('.link-items li .link-btn').allInnerTexts();
  if (names.join() !== 'Drawings,brief.txt') throw new Error(names.join());
  await anon.screenshot({ path: `${SP}/shots/links-folder.png` });
});

await step('browse the folder, view and download files inside', async () => {
  await anon.getByRole('button', { name: 'Drawings' }).click();
  await anon.getByRole('heading', { name: 'Drawings' }).waitFor();
  await anon.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'For client' }).waitFor();
  const [dl] = await Promise.all([anon.waitForEvent('download'), anon.getByLabel('Download plan.txt').click()]);
  if (dl.suggestedFilename() !== 'plan.txt') throw new Error(dl.suggestedFilename());
  await anon.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'For client' }).click();
  await anon.getByRole('button', { name: 'brief.txt' }).click();
  await anon.getByRole('heading', { name: 'brief.txt' }).waitFor();
  await anon.frameLocator('iframe.preview-frame').getByText('Project brief, version 2').waitFor();
  await anon.getByRole('button', { name: 'Back to For client' }).click();
  await anon.getByRole('button', { name: 'Drawings' }).waitFor();
  // Reloading keeps the typed password for this tab.
  await anon.reload();
  await anon.getByRole('heading', { name: 'For client' }).waitFor();
});

await step('phone width', async () => {
  await anon.setViewportSize({ width: 375, height: 740 });
  await anon.goto(fileLink);
  await anon.getByRole('heading', { name: 'photo.png' }).waitFor();
  const over = await anon.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (over) throw new Error('horizontal scroll');
  await anon.screenshot({ path: `${SP}/shots/links-phone.png` });
  await anon.setViewportSize({ width: 1280, height: 900 });
});

await step('company switch turns links off and on', async () => {
  await page.goto(B + '/admin');
  await page.getByRole('tab', { name: 'Company settings' }).click();
  await page.getByLabel('Allow people to share files and folders by link with anyone, such as clients').uncheck();
  await page.getByText('Share links are off').waitFor();
  await anon.goto(fileLink);
  await anon.getByRole('heading', { name: 'Link not available' }).waitFor();
  await page.goto(B + '/drive');
  await page.getByLabel('Actions for photo.png').click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  await page.getByText('Your company has turned off links for people without an account.').waitFor();
  await page.keyboard.press('Escape');
  await page.goto(B + '/admin');
  await page.getByRole('tab', { name: 'Company settings' }).click();
  await page.getByLabel('Allow people to share files and folders by link with anyone, such as clients').check();
  await page.getByText('Share links are on').waitFor();
  await anon.goto(fileLink);
  await anon.getByRole('heading', { name: 'photo.png' }).waitFor();
});

await step('removing a link stops it at once', async () => {
  await page.goto(B + '/drive');
  await page.getByLabel('Actions for photo.png').click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  await page.getByRole('button', { name: 'Remove link' }).click();
  await page.getByText('Link removed: it no longer works').waitFor();
  await page.keyboard.press('Escape');
  await anon.reload();
  await anon.getByRole('heading', { name: 'Link not available' }).waitFor();
  await anon.getByText(/may have been removed/).waitFor();
});

await step('signed-in people can open links too', async () => {
  await page.goto(folderLink);
  await page.getByLabel('Password').fill('blueprint');
  await page.getByRole('button', { name: 'Open' }).click();
  await page.getByRole('heading', { name: 'For client' }).waitFor();
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
