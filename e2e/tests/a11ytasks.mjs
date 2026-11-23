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
let doc, note, list;
await step('a document, a note and a file with tasks about them', async () => {
  doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Proposal', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Draft.' }] }] } })).body;
  note = (await api(page, 'POST', '/notes', { title: 'Offsite', body: 'Ideas' })).body;
  list = (await api(page, 'GET', '/tasks/lists')).body[0]?.id || (await api(page, 'POST', '/tasks/lists', { name: 'Work' })).body.id;
  for (const [title, url, label] of [['Review the proposal', `/docs/${doc.id}`, 'Proposal'], ['Book the venue', `/notes?note=${note.id}`, 'Note: Offsite']]) {
    const r = await api(page, 'POST', `/tasks/lists/${list}/tasks`, { title, link: { url, label } });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  }
});
await step('where tasks about a thing are counted: the editor, Drive’s list, a note’s card', async () => {
  await page.goto(`${B}/docs/${doc.id}`);
  await page.getByLabel(/1 task to do about this/).first().waitFor();
  await scan('editor header');
  await page.goto(`${B}/drive`);
  await page.getByText('Proposal').first().waitFor();
  await scan('drive list');
  await page.goto(`${B}/notes`);
  await page.getByRole('article').filter({ hasText: 'Offsite' }).waitFor();
  await scan('notes');
});
await step('the tasks themselves, and Home: links to what a task is about', async () => {
  await page.goto(`${B}/tasks/${list}`);
  await page.getByText('Review the proposal').first().waitFor();
  await scan('tasks list');
  await page.goto(`${B}/`);
  await page.waitForTimeout(1200);
  await scan('home');
});

console.log(failed ? `${failed} FAILED` : 'ALL PASSED', 'ERRORS:', JSON.stringify(errors));
await browser.close();
