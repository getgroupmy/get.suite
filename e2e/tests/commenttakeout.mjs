// A document's comments travel in Download your data's Word file (as Drive's own download has them): brought into
// another account, the document comes back with the comment on the same words, saying who wrote it.
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (method, url, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
let zip;

await step('setup: a comment on a document’s words, then Download your data', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await api('POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const doc = (await api('POST', '/files/new', { kind: 'doc', name: 'Proposal', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The budget is ten thousand' }] }] } })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByText('The budget is ten thousand').waitFor();
  await page.locator('.paper .tiptap').click();
  await page.keyboard.press('Control+End');
  for (let i = 0; i < 'ten thousand'.length; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await page.getByLabel('New comment').fill('Is this enough?');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByLabel('New comment').waitFor({ state: 'detached' });
  await page.waitForTimeout(2500); // the comment's mark saved with the document
  const [dl] = await Promise.all([page.waitForEvent('download'), (async () => { await page.goto(`${B}/settings`); await page.getByRole('link', { name: /Download your data/ }).first().click(); })()]);
  zip = await (await import('node:fs')).promises.readFile(await dl.path());
});

await step('Kim brings it in and opens Proposal: the comment is there, on “ten thousand”, by Olivia', async () => {
  await ctx.clearCookies();
  await page.goto(B);
  await page.getByLabel(/Email/).first().fill('kim@acme.com');
  await page.getByLabel(/Password/).first().fill('password123');
  await page.getByRole('button', { name: /Sign in/ }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  await page.goto(`${B}/settings`);
  await page.getByLabel('Your data to bring in').setInputFiles({ name: 'Workspace data.zip', mimeType: 'application/zip', buffer: zip });
  const msg = page.locator('.toast', { hasText: /^Brought in / }).first();
  await msg.waitFor({ timeout: 30000 });
  const root = (await api('GET', '/files')).body;
  const from = (root.files || root).find((f) => /^From your data/.test(f.name));
  const inside = (await api('GET', `/files?parent=${from?.id}`)).body;
  const list = inside.files || inside;
  const doc = list.find((f) => f.name === 'Proposal' && f.kind === 'doc');
  if (!doc) throw new Error(JSON.stringify(list).slice(0, 300));
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByText('The budget is ten thousand').waitFor();
  await page.getByRole('button', { name: /Comments/ }).first().click();
  await page.getByText('Is this enough?').first().waitFor();
  await page.getByText(/Olivia Owner/).first().waitFor();
  const marked = await page.locator('.paper .tiptap [data-comment], .paper .tiptap .comment-mark, .paper .tiptap mark').filter({ hasText: 'ten thousand' }).count();
  if (!marked) throw new Error('the words aren’t marked');
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
