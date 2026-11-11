import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBlocklists, lookup, isPublicV4, BLOCKLISTS } from '../src/mail/blocklists.js';

const nx = () => Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
/** A pretend DNS: listed on SpamCop, Spamhaus refuses, Barracuda times out, the rest clear. */
const fake = async (name) => {
  if (name === '4.3.2.198.bl.spamcop.net') return ['127.0.0.2'];
  if (name === '4.3.2.198.zen.spamhaus.org') return ['127.255.255.254'];
  if (name.endsWith('b.barracudacentral.org')) throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
  throw nx();
};

test('blocklists: listed, clear, and when a list won\'t say', async () => {
  const [r] = await checkBlocklists(['198.2.3.4'], fake);
  assert.equal(r.ip, '198.2.3.4');
  assert.equal(r.listed, 1);
  const by = Object.fromEntries(r.lists.map((l) => [l.zone, l]));
  assert.deepEqual([by['bl.spamcop.net'].status, by['bl.spamcop.net'].codes], ['listed', ['127.0.0.2']]);
  assert.equal(by['bl.spamcop.net'].remove, 'https://www.spamcop.net/bl.shtml', 'with where to ask to be taken off');
  assert.equal(by['zen.spamhaus.org'].status, 'unknown', 'a refusal is not a listing');
  assert.match(by['zen.spamhaus.org'].note, /MAIL_DNS_SERVERS/);
  assert.equal(by['b.barracudacentral.org'].status, 'unknown');
  assert.equal(by['psbl.surriel.com'].status, 'clear');
  assert.equal(r.lists.length, BLOCKLISTS.length);
});

test('blocklists: the reversed name, and private addresses left out', async () => {
  const asked = [];
  await lookup('203.0.113.9', { zone: 'x.example' }, async (n) => { asked.push(n); throw nx(); });
  assert.deepEqual(asked, ['9.113.0.203.x.example']);
  for (const ip of ['10.0.0.1', '192.168.1.5', '172.20.0.1', '127.0.0.1', '100.64.1.1', '169.254.1.1']) assert.equal(isPublicV4(ip), false, ip);
  assert.equal(isPublicV4('203.0.113.9'), true);
  assert.equal(isPublicV4('999.1.1.1'), false);
  assert.deepEqual(await checkBlocklists(['192.168.1.5'], fake), []);
});
