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
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 150)); } };
const saved = () => page.getByText('All changes saved').waitFor({ timeout: 10000 });
let sheet;
const AXE = (await import('node:fs')).readFileSync(`${ROOT}/e2e/node_modules/axe-core/axe.min.js`, 'utf8');
const axe = async (p, label) => {
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme });
    await p.evaluate(AXE);
    const r = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes[0]?.html.slice(0, 120)}`));
    if (r.length) throw new Error(`${label} ${scheme}: ${r.join(' | ')}`);
  }
  await p.emulateMedia({ colorScheme: 'light' });
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
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  sheet = (await api(page, 'POST', '/files/new', { kind: 'sheet', name: 'Budget', content: { sheets: [{ name: 'Sheet1', colWidths: {}, cells: { A1: 'Item', B1: 'Cost', A2: 'Taxi', B2: '12' } }] } })).body;
});
let side; // another tab, for the assistant's calls (as an assistant elsewhere would)
const mcp = (token, name, args) => side.evaluate(async ([t, n, a]) => {
  const r = await fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${t}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: n, arguments: a } }) });
  return (await r.json()).result;
}, [token, name, args]);
await step('the spreadsheet is open while an assistant adds rows: they appear live under the table, no reload, what was just typed kept', async () => {
  await api(page, 'PATCH', '/orgs/current', { allow_api_tokens: true });
  const token = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Claude', scope: 'write', days: 30 })).body.token;
  if (!token) throw new Error('no token');
  side = await page.context().newPage();
  await side.goto(B);
  await page.goto(`${B}/sheets/${sheet.id}`);
  await cell('A2').getByText('Taxi').waitFor();
  await page.getByText('All changes saved').waitFor({ timeout: 10000 }).catch(() => {});
  // Something typed just now, and a mark that's lost if the page reloads.
  await cell('C2').dblclick(); await page.keyboard.type('paid'); await page.keyboard.press('Enter');
  await page.evaluate(() => { window.__stayed = true; });
  const r = await mcp(token, 'add_sheet_rows', { file: `file:${sheet.id}`, rows: [['Lunch', 18.5], ['Hotel', 240]] });
  if (r.isError || r.structuredContent.range !== 'A3:B4') throw new Error(JSON.stringify(r));
  await cell('A3').getByText('Lunch').waitFor({ timeout: 15000 });
  await cell('B4').getByText('240').waitFor();
  await cell('A2').getByText('Taxi').waitFor();
  if (!(await page.evaluate(() => window.__stayed))) throw new Error('the page reloaded');
  await cell('C2').getByText('paid').waitFor();
  await page.screenshot({ path: `${SP}/shots/assistant-rows.png` });
});
await step('a document open while an assistant adds to it: the text appears live at the end, no reload', async () => {
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Team log', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Monday: started' }] }] } })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  const body = page.locator('.ProseMirror');
  await body.getByText('Monday: started').waitFor();
  await page.evaluate(() => { window.__stayed = true; });
  const token = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Claude 2', scope: 'write', days: 30 })).body.token;
  const r = await mcp(token, 'append_to_document', { file: `file:${doc.id}`, text: '## Tuesday\nShipped the beta' });
  if (r.isError) throw new Error(JSON.stringify(r));
  await body.getByRole('heading', { name: 'Tuesday' }).waitFor({ timeout: 15000 });
  await body.getByText('Shipped the beta').waitFor();
  if (!(await page.evaluate(() => window.__stayed))) throw new Error('the page reloaded');
  await page.screenshot({ path: `${SP}/shots/assistant-append.png` });
});
await step('an assistant makes a spreadsheet: it opens in Sheets with the heading row bold and the formulas worked out', async () => {
  const token = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Claude 2', scope: 'write', days: 30 })).body.token;
  const r = await mcp(token, 'create_spreadsheet', { name: 'Q3 travel', rows: [['City', 'Nights', 'Cost'], ['Lisbon', 3, 610.5], ['Oslo', 2, 880], ['Total', '=SUM(B2:B3)', '=SUM(C2:C3)']] });
  if (r.isError) throw new Error(JSON.stringify(r));
  await page.goto(new URL(r.structuredContent.url, B).href);
  await cell('A2').getByText('Lisbon').waitFor();
  await cell('C4').getByText('1490.5').waitFor();
  const w = await cell('A1').evaluate((el) => getComputedStyle(el.querySelector('*') || el).fontWeight);
  if (+w < 600) throw new Error(`heading not bold: ${w}`);
  await page.screenshot({ path: `${SP}/shots/assistant-sheet.png` });
});
await step('an assistant organizes Drive: a new folder, a file moved into it and renamed; Drive shows it so', async () => {
  const token = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Claude 4', scope: 'write', days: 30 })).body.token;
  const folder = (await mcp(token, 'create_folder', { name: 'Travel 2026' })).structuredContent;
  const r = await mcp(token, 'move_file', { file: `file:${sheet.id}`, folder: folder.id, name: 'Travel budget' });
  if (r.isError) throw new Error(JSON.stringify(r));
  await page.goto(`${B}/drive`);
  await page.locator('table.files').getByText('Travel 2026').waitFor();
  await page.goto(`${B}/drive/folder/${folder.id.replace('file:', '')}`);
  await page.locator('table.files').getByText('Travel budget').waitFor();
  await page.screenshot({ path: `${SP}/shots/assistant-folder.png` });
});
await step('an assistant makes a presentation: it opens in Slides, a slide per heading, the bullets and the speaker notes there', async () => {
  const token = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Claude 5', scope: 'write', days: 30 })).body.token;
  const r = await mcp(token, 'create_presentation', { name: 'Launch plan', slides: [
    { title: 'Launch plan', subtitle: 'November 2026' },
    { title: 'Goals', points: ['Ship the beta', 'Ten pilot customers'], notes: 'Mention the waiting list' },
  ] });
  if (r.isError) throw new Error(JSON.stringify(r));
  await page.goto(new URL(r.structuredContent.url, B).href);
  await page.locator('.slide-stage').getByText('November 2026').waitFor();
  await page.getByRole('button', { name: 'Slide 2', exact: true }).click();
  await page.locator('.slide-stage').getByText('Ten pilot customers').waitFor();
  if ((await page.getByLabel('Speaker notes').inputValue()) !== 'Mention the waiting list') throw new Error('notes missing');
  await page.screenshot({ path: `${SP}/shots/assistant-deck.png` });
});
await step('an assistant sets the person’s status: colleagues see it in the Directory; cleared, it goes', async () => {
  const token = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Claude 6', scope: 'write', days: 30 })).body.token;
  const r = await mcp(token, 'set_status', { emoji: '🎧', text: 'Focusing', until: new Date(Date.now() + 3600e3).toISOString() });
  if (r.isError) throw new Error(JSON.stringify(r));
  await page.goto(`${B}/contacts`);
  await page.getByRole('tab', { name: /Directory/ }).click().catch(async () => { await page.getByRole('button', { name: /Directory/ }).click(); });
  await page.locator('tr', { hasText: '🎧 Focusing' }).first().waitFor();
  await mcp(token, 'set_status', { clear: true });
  await page.reload();
  await page.getByRole('tab', { name: /Directory/ }).click().catch(async () => { await page.getByRole('button', { name: /Directory/ }).click(); });
  await page.locator('table tr').nth(1).waitFor();
  if (await page.getByText('🎧 Focusing').count()) throw new Error('not cleared');
});
await step('an assistant comments on words in a document open in Docs: the words are highlighted live, the comment is in the panel', async () => {
  const token = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Claude 7', scope: 'write', days: 30 })).body.token;
  const d = (await mcp(token, 'create_document', { name: 'Launch note', text: 'The launch is on Friday.' })).structuredContent;
  await page.goto(new URL(d.url, B).href);
  await page.locator('.ProseMirror').getByText('The launch is on Friday.').waitFor();
  await page.waitForTimeout(800); // joined the live session
  const c = await mcp(token, 'comment_on_file', { file: d.id, quote: 'on Friday', text: 'Is Friday still right?' });
  if (c.isError || c.structuredContent.note) throw new Error(JSON.stringify(c));
  await page.locator('.ProseMirror .comment-mark', { hasText: 'on Friday' }).waitFor();
  const marked = await page.locator('.ProseMirror .comment-mark').allTextContents();
  if (marked.join('') !== 'on Friday') throw new Error(`marked: ${JSON.stringify(marked)}`);
  // Highlighted like a comment made in Docs: the text's own size, a yellow background.
  const look = await page.locator('.ProseMirror .comment-mark').first().evaluate((el) => { const c = getComputedStyle(el), p = getComputedStyle(el.parentElement); return { size: c.fontSize, parent: p.fontSize, bg: c.backgroundColor }; });
  if (look.size !== look.parent || !/251, 188, 4/.test(look.bg)) throw new Error(`looks wrong: ${JSON.stringify(look)}`);
  await page.getByRole('button', { name: /1\s*Comments/ }).click();
  await page.getByText('Is Friday still right?').waitFor();
  await page.screenshot({ path: `${SP}/shots/assistant-comment.png` });
});
await step('an assistant cancels a meeting: the guest’s bell says so and it leaves their calendar', async () => {
  await api(page, 'POST', '/users', { local: 'gus', domain: 'acme.com', name: 'Gus Guest', password: 'password123' });
  const gus = await mk('gus');
  await gus.goto(B);
  await gus.evaluate(async () => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'gus@acme.com', password: 'password123' }) }));
  const token = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Claude 8', scope: 'write', days: 30 })).body.token;
  const at = Date.now() + 2 * 864e5;
  const ev = (await mcp(token, 'create_event', { title: 'Supplier call', start: new Date(at).toISOString(), end: new Date(at + 36e5).toISOString(), guests: ['gus@acme.com'] })).structuredContent;
  await gus.goto(`${B}/home`);
  await gus.getByRole('button', { name: /^Notifications/ }).waitFor();
  const r = await mcp(token, 'cancel_event', { id: ev.id });
  if (r.isError || r.structuredContent.guests_told !== 1) throw new Error(JSON.stringify(r));
  const told = async () => JSON.stringify((await api(gus, 'GET', '/notifications')).body).includes('Olivia Owner cancelled “Supplier call”');
  for (let i = 0; i < 40 && !(await told()); i++) await gus.waitForTimeout(250);
  if (!(await told())) throw new Error('the server has no notice for the guest');
  await gus.getByRole('button', { name: /^Notifications/ }).click();
  const panel = gus.getByRole('dialog', { name: 'Notifications' });
  await panel.getByText('Olivia Owner cancelled “Supplier call”').waitFor({ timeout: 10000 }).catch(async (e) => {
    await gus.screenshot({ path: `${SP}/shots/fail-guest-bell.png` });
    throw new Error(`bell shows: ${(await panel.innerText().catch(() => '(no panel)')).slice(0, 300)}`);
  });
  const left = (await api(gus, 'GET', `/events?from=${at - 864e5}&to=${at + 864e5}`)).body;
  if (left.some((e) => e.title === 'Supplier call')) throw new Error('still on their calendar');
});
await step('Notes open while an assistant adds to and ticks off a list: the card shows it without a reload', async () => {
  const token = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Claude 9', scope: 'write', days: 30 })).body.token;
  await mcp(token, 'create_note', { title: 'Groceries', items: ['Bread', 'Eggs'] });
  await page.goto(`${B}/notes`);
  const card = page.locator('article.note-card', { hasText: 'Groceries' });
  await card.getByRole('checkbox', { name: /Eggs/ }).waitFor();
  await page.evaluate(() => { window.__stayed = true; });
  const r = await mcp(token, 'update_note', { note: 'Groceries', add_items: ['Milk'], tick: ['Eggs'] });
  if (r.isError) throw new Error(JSON.stringify(r));
  await card.getByRole('checkbox', { name: /Milk/ }).waitFor({ timeout: 15000 });
  await card.getByText('1 ticked item').waitFor(); // a card puts ticked items away under a count
  if (await card.getByRole('checkbox', { name: /Eggs/ }).count()) throw new Error('Eggs still among the open items');
  if (!(await page.evaluate(() => window.__stayed))) throw new Error('the page reloaded');
});
await step('Admin → Company settings: untick what assistants may do; the assistant is refused, saying why', async () => {
  await page.goto(`${B}/admin?tab=company`);
  const box = page.locator('fieldset.assistant-tools');
  await box.getByText('What AI assistants may do').waitFor();
  // Each change is tagged with what it can do: cancelling an event changes or removes, and others see it; a draft does neither.
  const label = (code) => box.locator('label', { has: page.locator('code', { hasText: new RegExp(`^${code}$`) }) });
  const tags = async (code) => (await label(code).locator('.tool-tag').allInnerTexts()).join(' | ');
  if (await tags('cancel_event') !== 'changes or removes | others see it') throw new Error(`cancel_event: ${await tags('cancel_event')}`);
  if (await tags('draft_email') !== '') throw new Error(`draft_email: ${await tags('draft_email')}`);
  if (await tags('search') !== '') throw new Error(`search: ${await tags('search')}`);
  // Long titles wrap without squeezing their tick boxes.
  const sizes = await box.locator('input[type=checkbox]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  if (new Set(sizes).size !== 1) throw new Error(`tick boxes of different sizes: ${[...new Set(sizes)].join(', ')}`);
  await box.getByRole('checkbox', { name: /Post in Chat/ }).uncheck();
  await page.getByText('Assistants can no longer post in chat').waitFor();
  await page.screenshot({ path: `${SP}/shots/assistant-tools.png` });
  await axe(page, 'assistant tools');
  const token = (await api(page, 'POST', '/tokens', { password: 'password123', name: 'Claude 3', scope: 'write', days: 30 })).body.token;
  const r = await mcp(token, 'send_chat_message', { to: '#general', text: 'hello' });
  if (!r.isError || !/admins have turned off “Post in Chat”/.test(r.content[0].text)) throw new Error(JSON.stringify(r));
  await page.reload();
  if (await page.locator('fieldset.assistant-tools').getByRole('checkbox', { name: /Post in Chat/ }).isChecked()) throw new Error('not kept');
});
await step('Activity: the assistant’s change is listed as its own', async () => {
  const log = JSON.stringify((await api(page, 'GET', '/audit?action=assistant.action')).body);
  if (!/Claude/.test(log) || !/2 rows to file:/.test(log)) throw new Error(log.slice(0, 300));
});
await step('no errors in the browser', async () => { if (errors.length) throw new Error(errors.join(' | ')); });
console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
process.exit(failed ? 1 : 0);
