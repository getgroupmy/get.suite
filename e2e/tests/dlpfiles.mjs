import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/40[0-4]|409|503|Content Security|sandboxed/.test(m.text()) && errors.push(m.text()));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0], (String(e.stack).match(/e2e[\w-]*\.mjs:\d+/g) || []).slice(0, 2).join(' ')); await page.screenshot({ path: `${SP}/shots/fail-${name}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
const text = async (k) => (await cell(k).innerText()).trim();
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const expectCells = async (want) => { for (const [k, v] of Object.entries(want)) { const t = await text(k); if (t !== v) throw new Error(`${k}: "${t}" not "${v}"`); } };
const typeIn = async (k, s) => { await cell(k).click(); await page.keyboard.type(s); await page.keyboard.press('Enter'); };
const upload = (p, name, text) => p.evaluate(async ([n, t]) => (await fetch(`/api/files/upload?name=${encodeURIComponent(n)}`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'text/plain' }, body: t })).json(), [name, text]);
let doc;
await step('setup: rules made in Admin (no email on this server)', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await page.goto(`${B}/admin`);
  await page.getByRole('tab', { name: 'Data protection' }).click();
  for (const [name, look, then, words] of [['Card numbers', 'card', 'block'], ['Falcon', 'words', 'warn', 'Project Falcon']]) {
    await page.getByRole('button', { name: 'Add rule' }).click();
    const d = page.getByRole('dialog', { name: 'New rule' });
    await d.getByLabel('Name').fill(name);
    await d.getByLabel('Look for').selectOption(look);
    if (words) await d.getByLabel('Words or phrases (separated by commas)').fill(words);
    await d.getByLabel('Then').selectOption(then);
    await d.getByRole('button', { name: 'Add rule' }).click();
    await page.getByRole('table', { name: 'Data protection rules' }).getByRole('cell', { name, exact: true }).waitFor();
  }
  await upload(page, 'payments.txt', 'Customer card 4111 1111 1111 1111');
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Roadmap' })).body;
  const c = (await api(page, 'GET', `/files/${doc.id}/content`)).body;
  await api(page, 'PUT', `/files/${doc.id}/content`, { version: c.file.version, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Project Falcon ships in May' }] }] } });
});
await step('a link for a file with a card number is refused, and says why', async () => {
  await page.goto(`${B}/drive`);
  await page.getByLabel('Actions for payments.txt').click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  const sec = page.getByRole('region', { name: 'Link sharing' });
  await sec.getByRole('button', { name: 'Create link' }).click();
  await page.getByText(/can’t be shared by link: it contains a credit card number \(Card numbers: …1111\)/).first().waitFor();
  if (await sec.getByLabel('Share link').count()) throw new Error('no link made');
  await page.screenshot({ path: `${SP}/shots/dlp-link.png` });
  await page.keyboard.press('Escape');
});
await step('publishing a doc that names Project Falcon asks first; Share anyway publishes it', async () => {
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Publish to the web…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Publish to the web' });
  await dlg.getByRole('button', { name: 'Publish' }).click();
  const ask = page.getByRole('dialog', { name: 'Check before sharing' });
  await ask.getByText('It contains words your company protects (Falcon: Project Falcon).').waitFor();
  await page.screenshot({ path: `${SP}/shots/dlp-publish.png` });
  await ask.getByRole('button', { name: 'Don’t share' }).click();
  if ((await api(page, 'GET', `/publish/${doc.id}`)).body.published) throw new Error('not published after Don’t share');
  await dlg.getByRole('button', { name: 'Publish' }).click();
  await ask.getByRole('button', { name: 'Share anyway' }).click();
  await page.getByText('Published', { exact: true }).first().waitFor();
  if (!(await api(page, 'GET', `/publish/${doc.id}`)).body.published) throw new Error('published');
  const log = JSON.stringify((await api(page, 'GET', '/audit?limit=50')).body);
  if (!log.includes('dlp.blocked') || !log.includes('dlp.sent_anyway')) throw new Error(log.slice(0, 200));
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
