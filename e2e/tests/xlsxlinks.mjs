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
});
await step('links in Excel cells open as links in Sheets', async () => {
  const b64 = (await import('node:fs')).readFileSync(`${ROOT}/e2e/fixtures/office/links.xlsx`).toString('base64');
  const up = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const r = await fetch('/api/files/upload?name=Suppliers.xlsx', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: bytes });
    return r.json();
  }, b64);
  const opened = await api(page, 'POST', `/files/${up.id}/open-as`);
  await page.goto(`${B}/sheets/${opened.body.id}`);
  const link = page.locator('[data-k="B2"] a.cell-link');
  await link.waitFor();
  if ((await link.innerText()) !== 'acme.com' || (await link.getAttribute('href')) !== 'https://acme.com/') throw new Error(await link.getAttribute('href'));
  if ((await page.locator('[data-k="B3"] a.cell-link').getAttribute('href')) !== 'mailto:sales@acme.com') throw new Error('mail link');
  await page.locator('[data-k="B2"]').click();
  await until(async () => (await page.getByLabel('Cell contents').inputValue()) === '=HYPERLINK("https://acme.com/", "acme.com")');
});
await step('the same file saved as .ods by LibreOffice (its links as LibreOffice keeps them) opens with the same links', async () => {
  const fs = await import('node:fs'); const path = await import('node:path'); const { execFileSync } = await import('node:child_process');
  let bytes;
  try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); } catch { bytes = null; }
  if (bytes !== null) {
    const dir = fs.mkdtempSync(path.join(SP, 'lo-'));
    fs.copyFileSync(`${ROOT}/e2e/fixtures/office/links.xlsx`, path.join(dir, 'Suppliers.xlsx'));
    execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'ods', '--outdir', path.join(dir, 'out'), path.join(dir, 'Suppliers.xlsx')], { stdio: 'ignore', timeout: 120000 });
    bytes = fs.readFileSync(path.join(dir, 'out', 'Suppliers.ods'));
    fs.rmSync(dir, { recursive: true, force: true });
  } else { // without LibreOffice: an .ods with link cells written as it writes them
    console.log('(LibreOffice is not installed here: a hand-made .ods instead)');
    const JSZip = (await import('module')).createRequire(`${ROOT}/server/package.json`)('jszip');
    const zip = new JSZip();
    zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet');
    const cellOf = (t, href) => `<table:table-cell office:value-type="string"><text:p>${href ? `<text:a xlink:href="${href}" xlink:type="simple">${t}</text:a>` : t}</text:p></table:table-cell>`;
    zip.file('content.xml', `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"><office:body><office:spreadsheet><table:table table:name="Sheet1"><table:table-column table:number-columns-repeated="2"/><table:table-row>${cellOf('Name')}${cellOf('Site')}</table:table-row><table:table-row>${cellOf('Acme')}${cellOf('acme.com', 'https://acme.com/')}</table:table-row><table:table-row>${cellOf('Sales')}${cellOf('sales@acme.com', 'mailto:sales@acme.com')}</table:table-row></table:table></office:spreadsheet></office:body></office:document-content>`);
    bytes = await zip.generateAsync({ type: 'nodebuffer' });
  }
  const up = await page.evaluate(async (data) => {
    const b = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    return (await fetch('/api/files/upload?name=Suppliers.ods', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace' }, body: b })).json();
  }, bytes.toString('base64'));
  await page.goto(`${B}/drive`);
  await page.getByText('Suppliers.ods').dblclick();
  const pv = page.getByRole('dialog').filter({ hasText: 'Suppliers.ods' });
  await pv.getByRole('button', { name: 'Open as spreadsheet' }).click({ timeout: 20000 });
  await page.waitForURL(/\/sheets\//);
  if (new URL(page.url()).pathname.endsWith(up.id)) throw new Error('not a copy');
  const link = page.locator('[data-k="B2"] a.cell-link');
  await link.waitFor();
  if ((await link.innerText()) !== 'acme.com' || (await link.getAttribute('href')) !== 'https://acme.com/') throw new Error(await link.getAttribute('href'));
  if ((await page.locator('[data-k="B3"] a.cell-link').getAttribute('href')) !== 'mailto:sales@acme.com') throw new Error('mail link');
  await page.screenshot({ path: `${SP}/shots/ods-links.png` });
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
