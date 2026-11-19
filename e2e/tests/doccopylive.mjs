// A document someone is typing in, copied or downloaded straight away: what was just typed is in the copy and in
// Download your data (not only what was saved a moment before).
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
page.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
await step('typed, then copied straight away: the copy has it', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  const doc = (await api('POST', '/files/new', { kind: 'doc', name: 'Minutes' })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').first().click();
  await page.keyboard.type('Decided: we move the launch to March.');
  await page.waitForTimeout(700); // reached the server, not yet written down
  const copy = (await api('POST', `/files/${doc.id}/copy`, {})).body;
  const text = JSON.stringify((await api('GET', `/files/${copy.id}/content`)).body);
  if (!text.includes('we move the launch to March')) throw new Error('the copy doesn’t have what was just typed');
});
await step('typed, then Download your data straight away: the Word file has it', async () => {
  const doc = (await api('POST', '/files/new', { kind: 'doc', name: 'Board notes' })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.locator('.ProseMirror').first().click();
  await page.keyboard.type('Approved the budget for next year.');
  await page.waitForTimeout(700);
  const res = await page.request.get(`${B}/api/takeout`, { headers: { 'x-requested-with': 'nas-workspace' } });
  const { default: JSZip } = await import('../../server/node_modules/jszip/lib/index.js');
  const zip = await JSZip.loadAsync(await res.body());
  const entry = Object.keys(zip.files).find((n) => /Drive\/Board notes\.(docx|odt)$/.test(n));
  if (!entry) throw new Error(`not in the .zip: ${Object.keys(zip.files).filter((n) => n.startsWith('Drive/')).join(', ')}`);
  const inner = await JSZip.loadAsync(await zip.file(entry).async('nodebuffer'));
  const xml = await (inner.file('word/document.xml') || inner.file('content.xml')).async('string');
  if (!xml.includes('Approved the budget for next year.')) throw new Error('the downloaded document doesn’t have what was just typed');
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
