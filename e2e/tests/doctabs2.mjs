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
let id;
const ed = () => page.locator('.doc-scroll .ProseMirror');
const panel = () => page.getByRole('navigation', { name: 'Document tabs' });
const outline = () => page.getByRole('navigation', { name: 'Outline' });
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const p = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
await step('the outline shows the open tab\'s headings', async () => {
  const content = { type: 'doc', content: [
    { type: 'docTab', attrs: { id: 'plan', title: 'Plan' }, content: [h(1, 'Goals'), p('Open two shops this spring.')] },
    { type: 'docTab', attrs: { id: 'money', title: 'Budget' }, content: [h(1, 'Costs'), p('Rent and staff come to four thousand.'), h(2, 'Savings')] },
  ] };
  id = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Spring', content })).body.id;
  await page.goto(`${B}/docs/${id}`);
  await ed().getByText('Open two shops this spring.').waitFor({ state: 'visible' });
  if (!(await outline().count())) await page.getByRole('button', { name: 'Outline', exact: true }).click();
  await outline().getByRole('button', { name: 'Goals', exact: true }).waitFor();
  if (await outline().getByRole('button', { name: 'Costs', exact: true }).count()) throw new Error('another tab\'s heading');
  await panel().getByRole('button', { name: 'Budget', exact: true }).click();
  await outline().getByRole('button', { name: 'Savings', exact: true }).waitFor();
  if (await outline().getByRole('button', { name: 'Goals', exact: true }).count()) throw new Error('the first tab\'s heading');
});
await step('a link to a tab opens the document there', async () => {
  await page.goto(`${B}/docs/${id}#tab=money`);
  await ed().getByText('Rent and staff come to four thousand.').waitFor({ state: 'visible' });
  if (await ed().getByText('Open two shops this spring.').isVisible()) throw new Error('first tab shown');
  // A link to another of its tabs opened while it's open goes there
  await page.evaluate(() => { window.location.hash = '#tab=plan'; });
  await ed().getByText('Open two shops this spring.').waitFor({ state: 'visible' });
  if (await ed().getByText('Rent and staff come to four thousand.').isVisible()) throw new Error('still on Budget');
  await page.evaluate(() => { window.location.hash = '#tab=money'; }); // (back, as the steps after expect)
  await ed().getByText('Rent and staff come to four thousand.').waitFor({ state: 'visible' });
});
await step('a comment in a tab is kept there, and opening it from the list opens its tab', async () => {
  await ed().getByText('Rent and staff come to four thousand.').click();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft'); // before the full stop
  for (let i = 0; i < 13; i++) await page.keyboard.press('Shift+ArrowLeft'); // "four thousand"
  await page.getByRole('button', { name: 'Add comment' }).click();
  await page.getByText('On “four thousand”').waitFor();
  await page.getByLabel('New comment').fill('Is this with the new hires?');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.locator('.comment-thread', { hasText: 'Is this with the new hires?' }).waitFor();
  await panel().getByRole('button', { name: 'Plan', exact: true }).click();
  await ed().getByText('Open two shops this spring.').waitFor({ state: 'visible' });
  await page.locator('.comment-thread').getByText('Is this with the new hires?').click();
  await ed().locator('[data-comment]', { hasText: 'four thousand' }).waitFor({ state: 'visible' });
});
await step('suggesting works in a tab; word count covers every tab', async () => {
  await page.getByLabel('Editing mode').selectOption('suggest');
  await ed().getByText('Rent and staff come to four thousand.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Maybe less.');
  await ed().locator('ins', { hasText: 'Maybe less.' }).waitFor();
  await page.getByLabel('Editing mode').selectOption('edit');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Word count' }).click();
  const dlg = page.getByRole('dialog', { name: 'Word count' });
  const words = () => dlg.locator('tr:has(th:text-is("Words"))').locator('td').last().innerText();
  // Goals(1) Open two shops this spring(5) Costs(1) Rent and staff come to four thousand(7) Savings(1) [+ the suggestion, 2]
  await until(async () => Number(await words()) >= 15);
  await page.screenshot({ path: `${SP}/shots/doctabs-comment.png` });
});
await step('Copy to another document…: Budget into “Archive” (no tabs yet), which Kim has open, where it arrives at once', async () => {
  await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' });
  const kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  const archive = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Archive', content: { type: 'doc', content: [p('Old notes from last year.')] } })).body;
  const kimId = (await api(page, 'GET', '/users/directory')).body.find((u) => u.username === 'kim@acme.com').id;
  await api(page, 'PUT', `/files/${archive.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
  await kim.goto(`${B}/docs/${archive.id}`);
  const kimEd = kim.locator('.doc-scroll .ProseMirror');
  await kimEd.getByText('Old notes from last year.').waitFor({ state: 'visible' });
  await page.goto(`${B}/docs/${id}`);
  await ed().getByText('Open two shops this spring.').waitFor({ state: 'visible' });
  await panel().getByRole('button', { name: 'Options for tab Budget' }).click();
  await page.getByRole('menuitem', { name: 'Copy to another document…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Copy “Budget” to a document' });
  await dlg.getByLabel('Search your files').fill('Archive');
  await dlg.getByRole('button', { name: /Archive/ }).click();
  await page.locator('.toast', { hasText: 'Copied to “Archive” as “Budget”' }).waitFor();
  // Kim: the document now has tabs, what it had as Tab 1, then Budget
  const kimPanel = kim.getByRole('navigation', { name: 'Document tabs' });
  await kimPanel.getByRole('button', { name: 'Budget', exact: true }).waitFor({ timeout: 10000 });
  await kimPanel.getByRole('button', { name: 'Tab 1', exact: true }).waitFor();
  await kimPanel.getByRole('button', { name: 'Budget', exact: true }).click();
  await kimEd.getByText('Rent and staff come to four thousand.').waitFor({ state: 'visible' });
  await kimPanel.getByRole('button', { name: 'Tab 1', exact: true }).click();
  await kimEd.getByText('Old notes from last year.').waitFor({ state: 'visible' });
  // The original still has its two tabs; Open it goes to the copy
  await panel().getByRole('button', { name: 'Budget', exact: true }).waitFor();
  if ((await panel().getByRole('listitem').count()) !== 2) throw new Error('the original changed');
  await page.locator('.toast', { hasText: 'Copied to' }).getByRole('button', { name: 'Open it' }).click();
  await page.waitForURL(new RegExp(`/docs/${archive.id}`));
  await ed().getByText('Rent and staff come to four thousand.').waitFor({ state: 'visible' });
  await kim.close();
});
await step('Copy to a new document: the Plan tab as a document of its own', async () => {
  await page.goto(`${B}/docs/${id}`);
  await ed().getByText('Open two shops this spring.').waitFor({ state: 'visible' });
  await panel().getByRole('button', { name: 'Options for tab Plan' }).click();
  await page.getByRole('menuitem', { name: 'Copy to a new document' }).click();
  const t = page.locator('.toast', { hasText: 'Copied to a new document, “Spring – Plan”' });
  await t.waitFor();
  await t.getByRole('button', { name: 'Open it' }).click();
  await page.waitForURL((u) => !u.pathname.endsWith(id));
  await ed().getByText('Open two shops this spring.').waitFor({ state: 'visible' });
  if (await ed().getByText('Rent and staff come to four thousand.').count()) throw new Error('another tab came too');
});
await step('a copied tab\'s links: to its own heading there, to another tab\'s heading in the original', async () => {
  const link = (text, href) => ({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] });
  const linked = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Linked', content: { type: 'doc', content: [
    { type: 'docTab', attrs: { id: 'ta', title: 'Intro' }, content: [h(1, 'Aims'), { type: 'paragraph', content: [link('back to aims', '#aims'), { type: 'text', text: ' and ' }, link('see the money', '#spend')] }] },
    { type: 'docTab', attrs: { id: 'tb', title: 'Money' }, content: [h(1, 'Spend'), p('Four thousand.')] },
  ] } })).body;
  await page.goto(`${B}/docs/${linked.id}`);
  await ed().getByText('back to aims').waitFor({ state: 'visible' });
  await panel().getByRole('button', { name: 'Options for tab Intro' }).click();
  await page.getByRole('menuitem', { name: 'Copy to a new document' }).click();
  const t = page.locator('.toast', { hasText: 'Copied to a new document, “Linked – Intro”' });
  await t.waitFor();
  await t.getByRole('button', { name: 'Open it' }).click();
  await page.waitForURL((u) => !u.pathname.endsWith(linked.id));
  await ed().getByText('back to aims').waitFor({ state: 'visible' });
  const hrefs = await ed().locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  if (JSON.stringify(hrefs) !== JSON.stringify(['#aims', `/docs/${linked.id}#spend`])) throw new Error(JSON.stringify(hrefs));
  // Following it opens the original on that heading's tab
  await page.goto(`${B}${hrefs[1]}`);
  await ed().getByText('Four thousand.').waitFor({ state: 'visible' });
});
console.log(errors.length ? 'ERRORS ' + errors.join(' | ') : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
