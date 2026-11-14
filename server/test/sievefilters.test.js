import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeRules, userSieve, parseSize } from '../src/mail/sieve.js';

const rule = (conditions, actions, extra = {}) => ({ name: 'R', enabled: true, match: 'all', conditions, actions, ...extra });

test('filter sizes: "5 MB", "300 KB", a bare number as MB; kept as whole KB for Sieve', () => {
  assert.deepEqual(parseSize('5 MB'), { text: '5 MB', kb: 5120 });
  assert.deepEqual(parseSize('300kb'), { text: '300 KB', kb: 300 });
  assert.deepEqual(parseSize('1,5 m'), { text: '1.5 MB', kb: 1536 });
  assert.deepEqual(parseSize('2'), { text: '2 MB', kb: 2048 });
  for (const bad of ['', 'big', '0', '-5 MB', '5 GB', '200 MB']) assert.equal(parseSize(bad), null, bad);
});

test('filters on size and attachments, and filters that label mail', () => {
  const [big, plain] = normalizeRules([
    rule([{ field: 'size', op: 'over', value: '5mb' }, { field: 'attachment', op: 'has', value: 'ignored' }], { label: 'lab1', moveTo: 'Big' }),
    rule([{ field: 'attachment', op: 'has_not' }, { field: 'size', op: 'under', value: '20 KB' }], { label: 'lab2' }),
  ]);
  assert.deepEqual(big.conditions, [{ field: 'size', op: 'over', value: '5 MB' }, { field: 'attachment', op: 'has', value: '' }]);
  assert.equal(big.actions.label, 'lab1');
  assert.equal(plain.actions.label, 'lab2', 'a label alone is enough of an action');
  assert.throws(() => normalizeRules([rule([{ field: 'size', op: 'over', value: 'huge' }], { star: true })]), /give a size/);
  assert.throws(() => normalizeRules([rule([{ field: 'size', op: 'is', value: '5' }], { star: true })]), /unknown comparison/);
  assert.throws(() => normalizeRules([rule([{ field: 'attachment', op: 'maybe' }], { star: true })]), /unknown comparison/);
  assert.throws(() => normalizeRules([rule([{ field: 'subject', op: 'contains', value: 'x' }], { label: 'lab1', delete: true })]), /can't be labelled/);
  assert.equal(normalizeRules([rule([{ field: 'subject', op: 'contains', value: 'x' }], { label: 'x"; discard; "', star: true })])[0].actions.label, null, 'not an id');

  const script = userSieve({ username: 'k@acme.com', rules: [big, plain], labels: new Map([['lab1', 'nwl_abc123'], ['lab2', 'nwl_def456']]) });
  assert.match(script, /if allof\(string :is "\$\{done\}" "", allof\(size :over 5120K, header :contains "Content-Type" "multipart\/mixed"\)\) \{\n {2}addflag "nwl_abc123";\n {2}fileinto :create "Big";/);
  assert.match(script, /allof\(not header :contains "Content-Type" "multipart\/mixed", size :under 20K\)\) \{\n {2}addflag "nwl_def456";/);
  // A label that's gone: that action is left out; a filter with nothing else to do adds nothing.
  const gone = userSieve({ username: 'k@acme.com', rules: [big, plain], labels: new Map() });
  assert.ok(!/nwl_/.test(gone));
  assert.ok(!/size :under 20K/.test(gone));
  assert.match(gone, /size :over 5120K/);

  // The real Sieve compiler takes it (when Dovecot's tools are installed here).
  let sievec;
  try { sievec = execFileSync('sh', ['-c', 'command -v sievec'], { encoding: 'utf8' }).trim(); } catch { /* not installed */ }
  if (sievec) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sieve-'));
    const file = path.join(dir, 'f.sieve');
    fs.writeFileSync(file, script);
    execFileSync(sievec, [file, path.join(dir, 'f.svbin')], { stdio: 'pipe' });
    assert.ok(fs.existsSync(path.join(dir, 'f.svbin')));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('filters on the message text and on the mailing list it came through', () => {
  const rules = normalizeRules([
    rule([{ field: 'body', op: 'contains', value: ' unsubscribe ' }, { field: 'list', op: 'contains', value: 'news.acme.com' }], { moveTo: 'Lists' }),
    rule([{ field: 'body', op: 'not_contains', value: 'urgent "now"' }], { markRead: true }),
  ]);
  assert.deepEqual(rules[0].conditions, [{ field: 'body', op: 'contains', value: 'unsubscribe' }, { field: 'list', op: 'contains', value: 'news.acme.com' }]);
  assert.throws(() => normalizeRules([rule([{ field: 'body', op: 'is', value: 'x' }], { star: true })]), /unknown comparison/);
  assert.throws(() => normalizeRules([rule([{ field: 'list', op: 'contains', value: '  ' }], { star: true })]), /empty/);
  const script = userSieve({ username: 'k@acme.com', rules });
  assert.match(script, /require \[[^\]]*"body"\]/);
  assert.match(script, /allof\(body :text :contains "unsubscribe", header :contains "list-id" "news\.acme\.com"\)/);
  assert.match(script, /not body :text :contains "urgent \\"now\\""/);
  // Without a text condition, "body" isn't required.
  assert.ok(!/"body"/.test(userSieve({ username: 'k@acme.com', rules: normalizeRules([rule([{ field: 'list', op: 'contains', value: 'x' }], { star: true })]) })));
  let sievec;
  try { sievec = execFileSync('sh', ['-c', 'command -v sievec'], { encoding: 'utf8' }).trim(); } catch { /* not installed */ }
  if (sievec) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sieve-'));
    fs.writeFileSync(path.join(dir, 'f.sieve'), script);
    execFileSync(sievec, [path.join(dir, 'f.sieve'), path.join(dir, 'f.svbin')], { stdio: 'pipe' });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a filter can say which Inbox tab mail shows in', () => {
  const [toUpdates, toPrimary] = normalizeRules([
    rule([{ field: 'from', op: 'contains', value: 'notifications@' }], { tab: 'updates' }),
    rule([{ field: 'list', op: 'contains', value: 'team.acme.com' }], { tab: 'primary', markRead: false }),
  ]);
  assert.equal(toUpdates.actions.tab, 'updates');
  assert.equal(normalizeRules([rule([{ field: 'from', op: 'contains', value: 'x' }], { tab: 'spam', star: true })])[0].actions.tab, null);
  assert.throws(() => normalizeRules([rule([{ field: 'from', op: 'contains', value: 'x' }], { tab: 'updates', delete: true })]), /either a tab/);
  const script = userSieve({ username: 'k@acme.com', rules: [toUpdates, toPrimary] });
  assert.match(script, /header :contains "from" "notifications@"\) \{\n {2}addflag "\$NwUpdates";/);
  assert.match(script, /addflag "\$NwPrimary";/);
  let sievec;
  try { sievec = execFileSync('sh', ['-c', 'command -v sievec'], { encoding: 'utf8' }).trim(); } catch { /* not installed */ }
  if (sievec) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sieve-'));
    fs.writeFileSync(path.join(dir, 'f.sieve'), script);
    execFileSync(sievec, [path.join(dir, 'f.sieve'), path.join(dir, 'f.svbin')], { stdio: 'pipe' });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
