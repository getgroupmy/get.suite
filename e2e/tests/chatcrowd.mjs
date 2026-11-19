// Ten colleagues in #general, each with it open, each sending ten messages at the same moment: every one
// of them sees all 100, in the same order, without reloading (as they arrive, live).
import { chromium } from 'playwright';
const SP = process.argv[2];
const B = process.env.BASE || 'http://localhost:8080';
const browser = await chromium.launch();
const errors = [];
let failed = 0;
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const step = async (name, fn) => {
  try { await fn(); console.log('PASS', name); }
  catch (e) { failed++; console.log('FAIL', name, e.message.split('\n')[0]); await page.screenshot({ path: `${SP}/shots/fail-${name.replace(/\W+/g, '_')}.png` }); }
};
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, url, body]);
const N = 10, EACH = 10;
const people = [];
let general;

await step('setup: ten colleagues, each with #general open', async () => {
  await page.goto(B);
  await page.getByLabel('Your company name').fill('Acme Trading');
  await page.getByLabel('Company domain').fill('acme.com');
  await page.getByLabel('Your full name').fill('Olivia Owner');
  await page.getByLabel('Address before @').fill('olivia');
  await page.getByLabel('Password', { exact: true }).fill('password123');
  await page.getByLabel('Confirm password').fill('password123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByRole('link', { name: 'Drive', exact: true }).first().waitFor();
  general = (await api(page, 'GET', '/chat/channels')).body.channels.find((c) => c.name === 'general').id;
  for (let i = 1; i < N; i++) await api(page, 'POST', '/users', { local: `p${i}`, domain: 'acme.com', name: `Person ${i}`, password: 'password123' });
  people.push(page);
  for (let i = 1; i < N; i++) {
    const p = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage();
    p.on('pageerror', (e) => errors.push(`p${i}: ${e.message}`));
    await p.goto(B);
    await p.evaluate(async (u) => fetch('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: 'password123' }) }), `p${i}@acme.com`);
    people.push(p);
  }
  page.on('pageerror', (e) => errors.push(`olivia: ${e.message}`));
  await Promise.all(people.map(async (p) => { await p.goto(`${B}/chat/${general}`); await p.getByRole('textbox', { name: 'Message' }).waitFor(); }));
  await page.waitForTimeout(1500); // everyone's live connection is up
});

await step('everyone sends ten at once; everyone sees all 100, in the same order', async () => {
  await Promise.all(people.map((p, i) => p.evaluate(async ([g, who, each]) => {
    await Promise.all(Array.from({ length: each }, (_, k) => fetch(`/api/chat/channels/${g}/messages`, { method: 'POST', headers: { 'x-requested-with': 'nas-workspace', 'content-type': 'application/json' }, body: JSON.stringify({ body: `crowd ${who}-${k}` }) })));
  }, [general, i, EACH])));
  const want = N * EACH;
  const orders = [];
  for (const [i, p] of people.entries()) {
    const seen = await p.waitForFunction((n) => { const t = [...document.querySelectorAll('[data-mid]')].map((x) => (x.innerText.match(/crowd \d+-\d+/) || [])[0]).filter(Boolean); return new Set(t).size >= n && t; }, want, { timeout: 30000 }).then((h) => h.jsonValue()).catch(async () => {
      const t = await p.evaluate(() => [...document.querySelectorAll('[data-mid]')].map((x) => (x.innerText.match(/crowd \d+-\d+/) || [])[0]).filter(Boolean));
      throw new Error(`person ${i} sees ${new Set(t).size} of ${want}`);
    });
    if (seen.length !== new Set(seen).size) throw new Error(`person ${i} sees some twice (${seen.length} shown, ${new Set(seen).size} different)`);
    orders.push(seen.join(','));
  }
  // The same order for everyone, and the server's.
  const server = (await api(page, 'GET', `/chat/channels/${general}/messages?limit=200`)).body;
  const list = (server.messages || server).map((m) => m.body).filter((b) => /^crowd /.test(b));
  if (list.length !== want) throw new Error(`the server has ${list.length}`);
  const differ = orders.map((o, i) => [i, o]).filter(([, o]) => o !== orders[0]);
  if (differ.length) throw new Error(`people ${differ.map(([i]) => i).join(', ')} see them in another order than person 0`);
  const serverOrder = list.join(',');
  if (orders[0] !== serverOrder && orders[0] !== list.slice().reverse().join(',')) throw new Error('the screens’ order isn’t the server’s');
  await people[3].screenshot({ path: `${SP}/shots/crowd.png` });
});
await step('six of them type in one document at once: everyone ends with the same text, with all of it', async () => {
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Crowd notes', content: { type: 'doc', content: Array.from({ length: 6 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: `Line ${i}:` }] })) } })).body;
  const ids = (await api(page, 'GET', '/users')).body.filter((u) => /^Person [1-5]$/.test(u.name)).map((u) => ({ user_id: u.id, role: 'editor' }));
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: ids });
  const six = people.slice(0, 6);
  await Promise.all(six.map(async (p) => { await p.goto(`${B}/docs/${doc.id}`); await p.locator('.ProseMirror').waitFor(); }));
  await page.waitForTimeout(1500);
  // Each writes at the end of their own line, all at the same time. (Six typing at the very same spot
  // at once can have one's first characters land after another's words; not checked here.)
  for (const [i, p] of six.entries()) {
    await p.locator('.ProseMirror p').nth(i).click();
    await p.keyboard.press('End');
    const at = await p.evaluate(() => window.getSelection().anchorNode?.textContent || '');
    if (!at.startsWith(`Line ${six.indexOf(p)}:`)) throw new Error(`writer ${i}'s caret is in “${at}”`);
  }
  await page.waitForTimeout(500);
  await Promise.all(six.map(async (p, i) => {
    await p.keyboard.type(` [writer${i} was here]`, { delay: 15 });
  }));
  // The document's own text (not the other writers' carets and name labels shown in it).
  const text = async (p) => p.locator('.ProseMirror').evaluate((el) => { const c = el.cloneNode(true); c.querySelectorAll('.collaboration-carets__caret, .collaboration-carets__label').forEach((x) => x.remove()); return c.textContent; });
  let texts;
  for (let t = 0; t < 40; t++) { texts = await Promise.all(six.map(text)); if (new Set(texts).size === 1) break; await page.waitForTimeout(250); }
  if (new Set(texts).size !== 1) throw new Error(`they differ: ${texts.map((x) => JSON.stringify(x.slice(0, 120))).join(' | ')}`);
  for (let i = 0; i < 6; i++) if (!texts[0].includes(`Line ${i}: [writer${i} was here]`)) throw new Error(`writer ${i}'s words are missing or mixed: ${JSON.stringify(texts[0])}`);
  await six[2].screenshot({ path: `${SP}/shots/crowd-doc.png` });
});
await step('clicking into a line while someone else is typing elsewhere: the caret stays where you clicked', async () => {
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Click while typing', content: { type: 'doc', content: Array.from({ length: 5 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: `Row ${i}:` }] })) } })).body;
  const ids = (await api(page, 'GET', '/users')).body.filter((u) => u.name === 'Person 1').map((u) => ({ user_id: u.id, role: 'editor' }));
  await api(page, 'PUT', `/files/${doc.id}/shares`, { shares: ids });
  const [a, b] = [people[0], people[1]];
  await Promise.all([a, b].map(async (p) => { await p.goto(`${B}/docs/${doc.id}`); await p.locator('.ProseMirror p').nth(4).waitFor(); }));
  await page.waitForTimeout(1000);
  await a.locator('.ProseMirror p').nth(0).click();
  await a.keyboard.press('End');
  const typing = a.keyboard.type(' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { delay: 40 });
  await b.waitForTimeout(400);
  await b.locator('.ProseMirror p').nth(3).click();
  await b.keyboard.press('End');
  await b.keyboard.type(' bbbbbbbbbb', { delay: 40 });
  await typing;
  let t;
  for (let k = 0; k < 20; k++) { t = await b.locator('.ProseMirror').evaluate((el) => { const c = el.cloneNode(true); c.querySelectorAll('.collaboration-carets__caret, .collaboration-carets__label').forEach((x) => x.remove()); return [...c.querySelectorAll('p')].map((x) => x.textContent); }); if (t[3] === 'Row 3: bbbbbbbbbb' && t[0].endsWith('a'.repeat(40))) break; await page.waitForTimeout(250); }
  if (t[3] !== 'Row 3: bbbbbbbbbb') throw new Error(`B's words went elsewhere: ${JSON.stringify(t)}`);
});
console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
process.exit(failed ? 1 : 0);
