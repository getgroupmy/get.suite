import { chromium } from 'playwright';
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''); // the repository
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
let errors = [];
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
let kim, doc, kimId;
await step('a document shared with Kim', async () => {
  kimId = (await api(page, 'POST', '/users', { local: 'kim', domain: 'acme.com', name: 'Kim Park', password: 'password123' })).body.id;
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Launch plan', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Launch on the first of May.' }] }] } })).body;
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: [{ user_id: kimId, role: 'editor' }] });
});
await step('comment, mention Kim and assign it to her', async () => {
  await page.goto(`${B}/docs/${doc.id}`);
  const p = page.locator('.ProseMirror p', { hasText: 'Launch on the first of May.' });
  await p.waitFor();
  await p.evaluate((el) => { const t = el.firstChild; const r = document.createRange(); r.setStart(t, 10); r.setEnd(t, 26); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await page.keyboard.press('Control+Alt+m');
  const box = page.getByLabel('New comment');
  await box.waitFor();
  await box.fill('@kim@acme.com can you confirm the date?');
  await page.getByLabel('Assign to').selectOption({ label: 'Kim Park' });
  await page.getByRole('complementary', { name: 'Comments' }).getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByText("Assigned to Kim Park: it's on their task list").waitFor();
  await page.getByText('☑ Assigned to Kim Park').waitFor();
});
await step('Kim finds it in Tasks, linked to the comment; resolving it ticks it off', async () => {
  kim = await mk('kim'); await signIn(kim, 'kim@acme.com');
  await kim.goto(`${B}/tasks`);
  await kim.getByText('@kim@acme.com can you confirm the date?').waitFor();
  await kim.goto(`${B}/docs/${doc.id}`);
  await kim.getByRole('button', { name: 'Comments' }).first().click();
  const thread = kim.locator('.comment-thread', { hasText: 'can you confirm the date?' });
  await thread.click();
  await thread.getByRole('button', { name: 'Resolve' }).click();
  await until(async () => {
    const lists = (await api(kim, 'GET', '/tasks/lists')).body;
    const l = (lists.lists || lists)[0];
    const t = (await api(kim, 'GET', `/tasks/lists/${l.id}/tasks`)).body.find((x) => x.title.includes('confirm the date'));
    return t && (t.done || t.done_at);
  }, 10000);
});
await step('ticking the task off in Tasks resolves the comment', async () => {
  const c = (await api(page, 'GET', `/comments/${doc.id}`)).body.find((x) => x.body.includes('confirm the date'));
  await api(page, 'PATCH', `/comments/${doc.id}/${c.id}`, { resolved: false }); // reopened: the task is back
  await kim.goto(`${B}/tasks`);
  const box = kim.getByLabel('Done: @kim@acme.com can you confirm the date?');
  await box.waitFor();
  await until(async () => !(await box.isChecked()));
  await box.click();
  await until(async () => (await api(page, 'GET', `/comments/${doc.id}`)).body.find((x) => x.id === c.id).resolved === true, 10000);
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
