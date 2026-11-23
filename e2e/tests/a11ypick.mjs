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
const cell = (k) => page.locator(`.grid td[data-k="${k}"]`);
const style = (k, prop) => cell(k).evaluate((el, p) => getComputedStyle(el)[p], prop);
const saved = () => page.getByText('All changes saved').waitFor({ timeout: 10000 });
let sheet;

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

const AXE = (await import('node:fs')).readFileSync(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const scan = async (label) => {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(350);
    await page.evaluate(AXE);
    const res = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0]?.target.join(' ')} ${v.nodes[0]?.html.slice(0, 160)}`));
    if (res.length) throw new Error(`${label} (${scheme}): ${res.join(' | ')}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
};
const NAMES = ['Kim Park', 'Raj Patel', 'Nora Quill', 'Eddie Stone', 'Ana Lima', 'Bo Chen', 'Cy Marsh', 'Dee Holt', 'Finn Oak', 'Gus Vale'];
await step('people and things to pick from', async () => {
  for (const name of NAMES) if ((await api(page, 'POST', '/users', { local: name.split(' ')[0].toLowerCase(), domain: 'acme.com', name, password: 'password123' })).status !== 201) throw new Error('user');
  for (const [name, email] of [['Ada Stone', 'ada@initrode.example'], ['Ben Vale', 'ben.vale@post.example']]) await api(page, 'POST', '/contacts', { name, email, company: 'Initrode Works' });
});
await step('Calendar: the Guests box with its suggestions open', async () => {
  await page.goto(`${B}/calendar`);
  await page.getByRole('button', { name: 'Create' }).click();
  const d = page.getByRole('dialog', { name: 'New event' });
  await d.locator('#guest-input').pressSequentially('initrode');
  await d.getByRole('listbox', { name: 'People to invite' }).getByRole('option').first().waitFor();
  await scan('guest suggestions');
  await d.locator('#guest-input').press('Enter');
  await d.getByRole('list', { name: 'Invited guests' }).getByRole('listitem').first().waitFor();
  await scan('guest chips by name');
});
await step('Drive: the Share window with people listed', async () => {
  await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Plan' });
  await page.goto(`${B}/drive`);
  await page.getByRole('button', { name: 'Actions for Plan' }).click();
  await page.getByRole('menuitem', { name: 'Share' }).click();
  const dlg = page.getByRole('dialog', { name: /Share “Plan”/ });
  await dlg.getByLabel('Email address').pressSequentially('k');
  await dlg.getByRole('listbox', { name: 'People to share with' }).getByRole('option').first().waitFor();
  await scan('share by name');
});
await step('Notes: Share note with Find people; Forms: an editor by name', async () => {
  await api(page, 'POST', '/notes', { title: 'Offsite', body: 'Ideas' });
  await page.goto(`${B}/notes`);
  await page.getByRole('article').filter({ hasText: 'Offsite' }).getByRole('button', { name: 'Share note' }).click();
  const dlg = page.getByRole('dialog', { name: 'Share note' });
  await dlg.getByPlaceholder('Find people').fill('park');
  await dlg.getByLabel(/Kim Park/).check();
  await scan('find people');
  const f = (await api(page, 'POST', '/forms', { title: 'Offsite form' })).body;
  await page.goto(`${B}/forms/${f.id}?tab=settings`);
  await page.getByLabel('Add an editor').pressSequentially('pat');
  await page.getByRole('listbox', { name: 'Matching people' }).getByRole('option').first().waitFor();
  await scan('colleague box');
});
await step('Chat: Message someone, with who is online', async () => {
  await page.goto(`${B}/chat`);
  await page.getByLabel('Start a direct message').pressSequentially('k');
  await page.getByRole('listbox', { name: 'Matching people' }).getByRole('option').first().waitFor();
  await scan('chat message someone');
  await page.getByLabel('Start a direct message').fill('');
});
await step('Contacts: Also at…; Sheets: Find with Also in and Options', async () => {
  await page.goto(`${B}/contacts`);
  await page.getByRole('button', { name: 'Edit Ada Stone' }).click();
  await page.getByRole('dialog').locator('.also-at').waitFor();
  await scan('also at');
  const sh = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Year', content: { sheets: [{ name: 'Jan', cells: { A1: 'Rent' } }, { name: 'Feb', cells: { A1: 'rent' } }] } })).body;
  await page.goto(`${B}/sheets/${sh.id}`);
  await page.locator('.grid td[data-k="A1"]').click();
  await page.keyboard.press('Control+h');
  const bar = page.getByRole('search', { name: 'Find in sheet' });
  await bar.getByLabel('Find', { exact: true }).fill('rent');
  await bar.getByRole('group', { name: 'Also found in other sheets' }).waitFor();
  await bar.getByLabel('Regular expression').check();
  await scan('sheet find');
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
