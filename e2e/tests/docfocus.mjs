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
await step('Focus mode shows only the page; writing goes on; Esc or the button brings everything back', async () => {
  const doc = (await api(page, 'POST', '/files/new', { kind: 'doc', name: 'Essay', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First line.' }] }] } })).body;
  await page.goto(`${B}/docs/${doc.id}`);
  const ed = page.locator('.ProseMirror').first();
  await ed.getByText('First line.').waitFor();
  await page.getByRole('toolbar', { name: 'Formatting' }).waitFor();
  await page.locator('.editor-head').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Focus mode' }).click();
  await page.getByRole('button', { name: 'Exit focus mode' }).waitFor();
  if (await page.getByRole('toolbar', { name: 'Formatting' }).isVisible()) throw new Error('toolbar still shown');
  if (await page.locator('.editor-head').isVisible()) throw new Error('header still shown');
  await page.screenshot({ path: `${SP}/shots/docfocus.png` });
  await ed.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Still writing.');
  await ed.getByText('First line. Still writing.').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('toolbar', { name: 'Formatting' }).waitFor();
  await page.getByRole('button', { name: 'Exit focus mode' }).waitFor({ state: 'detached' });
  // Again, left with the button.
  await page.locator('.editor-head').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Focus mode' }).click();
  await page.getByRole('button', { name: 'Exit focus mode' }).click();
  await page.getByRole('toolbar', { name: 'Formatting' }).waitFor();
});
await step('Typewriter (in focus mode) keeps the line being written in the middle of the screen, and is remembered', async () => {
  await page.locator('.editor-head').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Focus mode' }).click();
  await page.getByRole('button', { name: 'Typewriter' }).click();
  const ed = page.locator('.ProseMirror').first();
  await ed.click();
  await page.keyboard.press('Control+End');
  for (let i = 1; i <= 40; i++) { await page.keyboard.press('Enter'); await page.keyboard.type(`Line ${i}`); }
  await page.waitForTimeout(300);
  const off = await page.evaluate(() => { const r = window.getSelection().getRangeAt(0).getBoundingClientRect(); return Math.abs((r.top + r.bottom) / 2 - window.innerHeight / 2); });
  if (off > 80) throw new Error(`the caret is ${Math.round(off)}px from the middle`);
  await page.getByRole('button', { name: 'Exit focus mode' }).click();
  await page.reload();
  await page.locator('.editor-head').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Focus mode' }).click();
  if ((await page.getByRole('button', { name: 'Typewriter' }).getAttribute('aria-pressed')) !== 'true') throw new Error('not remembered');
});
await step('Dim (in focus mode) fades all but the paragraph being written', async () => {
  await page.getByRole('button', { name: 'Typewriter' }).click(); // off: not needed here
  await page.getByRole('button', { name: 'Dim' }).click();
  const ed = page.locator('.ProseMirror').first();
  await ed.getByText('Line 3', { exact: true }).click();
  const op = (text) => ed.getByText(text, { exact: true }).evaluate((el) => Number(getComputedStyle(el.closest('p')).opacity));
  await page.waitForTimeout(300);
  if ((await op('Line 3')) !== 1) throw new Error('the current paragraph is faded');
  if ((await op('Line 10')) >= 0.5) throw new Error('another paragraph is not faded');
  await ed.getByText('Line 10', { exact: true }).click();
  await page.waitForTimeout(300);
  if ((await op('Line 10')) !== 1 || (await op('Line 3')) >= 0.5) throw new Error('the dimming didn’t follow the caret');
  await page.screenshot({ path: `${SP}/shots/docfocus-dim.png` });
  await page.getByRole('button', { name: 'Exit focus mode' }).click();
  if ((await op('Line 3')) !== 1) throw new Error('still faded outside focus mode');
});
await step('a writing sprint counts the words added and says when the time is up', async () => {
  await page.evaluate(() => localStorage.setItem('nw-sprint-seconds', '1')); // minutes as seconds, to see it end
  await page.locator('.editor-head').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Focus mode' }).click();
  await page.getByRole('button', { name: 'Sprint' }).click();
  await page.getByRole('menuitem', { name: '10 minutes' }).click();
  const clock = page.getByRole('timer', { name: 'Writing sprint' });
  await clock.getByText(/^\+0 words · 0:(10|09)/).waitFor();
  const ed = page.locator('.ProseMirror').first();
  await ed.getByText('Line 40', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' three more words');
  await clock.getByText(/^\+3 words/).waitFor();
  await page.getByText('Sprint done: +3 words').waitFor({ timeout: 15000 });
  await clock.waitFor({ state: 'detached' });
  await page.evaluate(() => localStorage.removeItem('nw-sprint-seconds'));
  await page.getByRole('button', { name: 'Exit focus mode' }).click();
});
await step('a sprint carries on after reloading (back in focus mode), and × stops it', async () => {
  await page.evaluate(() => localStorage.setItem('nw-sprint-seconds', '1'));
  await page.locator('.editor-head').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Focus mode' }).click();
  await page.getByRole('button', { name: 'Sprint' }).click();
  await page.getByRole('menuitem', { name: '45 minutes' }).click(); // 45 seconds here
  const ed = page.locator('.ProseMirror').first();
  await ed.getByText('Line 39', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' two words');
  const clock = page.getByRole('timer', { name: 'Writing sprint' });
  await clock.getByText(/^\+2 words/).waitFor();
  await page.waitForTimeout(1200);
  await page.reload();
  await clock.getByText(/^\+2 words · 0:[1-4]\d/).waitFor({ timeout: 15000 }); // the same sprint, counting from its start
  await page.getByRole('button', { name: 'Exit focus mode' }).waitFor(); // in focus mode again
  await clock.getByRole('button', { name: 'Stop the sprint' }).click();
  await clock.waitFor({ state: 'detached' });
  await page.reload();
  await page.getByRole('toolbar', { name: 'Formatting' }).waitFor(); // stopped: an ordinary reload
  if (await page.getByRole('button', { name: 'Exit focus mode' }).count()) throw new Error('focus mode came back without a sprint');
  await page.evaluate(() => localStorage.removeItem('nw-sprint-seconds'));
});
await step('a sprint that ended while the document was closed is told on the next visit', async () => {
  const id = new URL(page.url()).pathname.split('/').pop();
  const ended = (words) => page.evaluate(([k, w]) => localStorage.setItem(k, JSON.stringify({ ends: Date.now() - 60e3, words: w })), [`nw-sprint:${id}`, words]);
  const told = async () => {
    const note = page.getByText(/Your sprint ended while you were away: [+−]\d+ words/);
    await note.waitFor({ timeout: 15000 });
    const t = await note.innerText();
    return (t.includes('−') ? -1 : 1) * Number(t.match(/(\d+) words/)[1]);
  };
  await ended(100);
  await page.reload();
  const a = await told();
  await page.getByRole('toolbar', { name: 'Formatting' }).waitFor(); // not back in focus mode
  await ended(90); // began 10 words earlier
  await page.reload();
  const b = await told();
  if (b - a !== 10) throw new Error(`${a} then ${b}`);
  await page.reload();
  await page.getByRole('toolbar', { name: 'Formatting' }).waitFor();
  await page.waitForTimeout(1000);
  if (await page.getByText('Your sprint ended while you were away').count()) throw new Error('told twice');
});
await step('Ctrl+Shift+F turns focus mode on and off; the shortcuts list says so', async () => {
  await page.locator('.ProseMirror').first().click();
  await page.keyboard.press('Control+Shift+F');
  await page.getByRole('button', { name: 'Exit focus mode' }).waitFor();
  await page.keyboard.press('Control+Shift+F');
  await page.getByRole('toolbar', { name: 'Formatting' }).waitFor();
  await page.keyboard.press('Control+/');
  await page.getByText('Focus mode on or off').waitFor({ timeout: 5000 });
});
await step('a sprint can pause notifications until it ends; stopping it turns them back on', async () => {
  await page.evaluate(() => localStorage.setItem('nw-sprint-seconds', '1'));
  await page.keyboard.press('Escape'); // the shortcuts list from the step before
  await page.getByRole('dialog').waitFor({ state: 'detached' }).catch(() => {});
  await page.locator('.ProseMirror').first().click();
  await page.keyboard.press('Control+Shift+F');
  await page.getByRole('button', { name: 'Sprint' }).click();
  await page.getByRole('menuitem', { name: 'Pause notifications during sprints' }).click();
  await page.getByRole('button', { name: 'Sprint' }).click();
  await page.getByRole('menuitem', { name: '45 minutes' }).click();
  await page.getByText('Notifications paused until the sprint ends').waitFor();
  const pause = async () => (await api(page, 'GET', '/users/me/pause')).body.paused_until;
  const at = await pause();
  if (!at || at < Date.now() + 30e3 || at > Date.now() + 50e3) throw new Error(`paused until ${at}`);
  await page.getByRole('timer', { name: 'Writing sprint' }).getByRole('button', { name: 'Stop the sprint' }).click();
  await until(async () => !(await pause()));
  await page.evaluate(() => { localStorage.removeItem('nw-sprint-seconds'); localStorage.removeItem('nw-sprint-quiet'); });
  await page.keyboard.press('Control+Shift+F');
});
await step('a sprint can show “✍️ Writing” as your status until it ends, not over your own', async () => {
  await page.evaluate(() => localStorage.setItem('nw-sprint-seconds', '1'));
  const status = async () => (await api(page, 'GET', '/users/me/status')).body.status;
  await page.locator('.ProseMirror').first().click();
  await page.keyboard.press('Control+Shift+F');
  await page.getByRole('button', { name: 'Sprint' }).click();
  await page.getByRole('menuitem', { name: /Show “✍️ Writing” as my status during sprints/ }).click();
  await page.getByRole('button', { name: 'Sprint' }).click();
  await page.getByRole('menuitem', { name: '45 minutes' }).click();
  await until(async () => (await status())?.text === 'Writing');
  const s1 = await status();
  if (s1.emoji !== '✍️' || !s1.until || s1.until > Date.now() + 50e3) throw new Error(JSON.stringify(s1));
  await page.getByRole('timer', { name: 'Writing sprint' }).getByRole('button', { name: 'Stop the sprint' }).click();
  await until(async () => !(await status()));
  // A status of your own stays as it is.
  await api(page, 'PUT', '/users/me/status', { emoji: '🏖️', text: 'On leave' });
  await page.getByRole('button', { name: 'Sprint' }).click();
  await page.getByRole('menuitem', { name: '10 minutes' }).click();
  await page.getByRole('timer', { name: 'Writing sprint' }).waitFor();
  await page.waitForTimeout(800);
  if ((await status())?.text !== 'On leave') throw new Error('your own status was replaced');
  await page.getByRole('timer', { name: 'Writing sprint' }).getByRole('button', { name: 'Stop the sprint' }).click();
  await page.waitForTimeout(800);
  if ((await status())?.text !== 'On leave') throw new Error('your own status was cleared');
  await page.evaluate(() => { localStorage.removeItem('nw-sprint-seconds'); localStorage.removeItem('nw-sprint-status'); });
  await page.keyboard.press('Control+Shift+F');
});
if (errors.length) { failed++; console.log('FAIL page errors', errors.slice(0, 5).join(' | ')); }
console.log(failed ? `${failed} failed` : 'all passed');
await browser.close();
