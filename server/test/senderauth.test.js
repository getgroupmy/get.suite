import { test } from 'node:test';
import assert from 'node:assert/strict';
import { senderVerdict } from '../src/mail/senderauth.js';

const ar = (v) => ({ key: 'authentication-results', line: `Authentication-Results: mail.acme.com; ${v}` });
const v = (lines, from = 'billing@initech.com') => senderVerdict(lines, from, ['acme.com']);

test('DMARC failing: forged; passing: fine', () => {
  assert.equal(v([ar('dkim=none; spf=fail (mail.acme.com: domain of billing@initech.com does not designate 1.2.3.4) smtp.mailfrom=billing@initech.com; dmarc=fail reason="No valid SPF, No valid DKIM" header.from=initech.com (policy=reject)')]), 'forged');
  assert.equal(v([ar('dkim=pass header.d=initech.com header.s=s1; spf=pass smtp.mailfrom=billing@initech.com; dmarc=pass (policy=reject) header.from=initech.com')]), null);
});

test('without DMARC: an SPF or DKIM pass for the From’s own site vouches; for another site it doesn’t', () => {
  assert.equal(v([ar('dkim=pass header.d=mail.initech.com header.s=s1; spf=none smtp.mailfrom=bounce@sendgrid.example')]), null, 'DKIM for its site');
  assert.equal(v([ar('dkim=none; spf=pass smtp.mailfrom=bounce@initech.com')]), null, 'SPF for its site');
  assert.equal(v([ar('dkim=pass header.d=sendgrid.example header.s=s1; spf=pass smtp.mailfrom=bounce@sendgrid.example; dmarc=none')]), 'unverified');
  assert.equal(v([ar('dkim=none; spf=softfail smtp.mailfrom=billing@initech.com; dmarc=none')]), 'unverified');
});

test('only the topmost (this server’s) results count; none, or the company’s own mail: nothing to say', () => {
  const forgedBelow = { key: 'authentication-results', line: 'Authentication-Results: fake; dkim=pass header.d=initech.com; dmarc=pass' };
  assert.equal(v([ar('spf=fail smtp.mailfrom=billing@initech.com; dmarc=fail header.from=initech.com'), forgedBelow]), 'forged');
  assert.equal(v([{ key: 'received', line: 'Received: from x' }]), null);
  assert.equal(v([ar('spf=fail; dmarc=fail')], 'kim@acme.com'), null);
  assert.equal(v([ar('none')]), null);
  assert.equal(v([ar('dkim=fail header.d=initech.com')], ''), null);
});

test('reads the header exactly as this server’s Rspamd writes it (folded, a comment in it)', () => {
  const line = 'Authentication-Results: vm;\r\n\tdkim=none;\r\n\tdmarc=none;\r\n\tspf=none (vm: domain of alerts@paypal.com has no SPF policy when checking 203.0.113.5) smtp.mailfrom=alerts@paypal.com';
  assert.equal(senderVerdict([{ key: 'authentication-results', line }], 'alerts@paypal.com', ['acme.com']), 'unverified');
  const fail = 'Authentication-Results: vm;\r\n\tdkim=fail (signature failed) header.d=paypal.com;\r\n\tdmarc=fail reason="No valid SPF, DKIM not aligned (relaxed)" header.from=paypal.com (policy=reject);\r\n\tspf=fail smtp.mailfrom=alerts@paypal.com';
  assert.equal(senderVerdict([{ key: 'authentication-results', line: fail }], 'alerts@paypal.com', ['acme.com']), 'forged');
});
