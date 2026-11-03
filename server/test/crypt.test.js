import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { sha512crypt } from '../src/mail/crypt.js';

test('SHA512-CRYPT matches the specification test vectors', () => {
  assert.equal(sha512crypt('Hello world!', 'saltstring'),
    '$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1');
  assert.equal(sha512crypt('Hello world!', 'saltstringsaltstring', 10000),
    '$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.');
  // Reference values below were produced by glibc/libxcrypt crypt(3).
  assert.equal(sha512crypt('we have a short salt string but not a short password', 'roundstoolow', 10),
    '$6$rounds=1000$roundstoolow$yjTuW7RnC.d35QcVTFIb6uvh/7IQ1.GFtFN3i/.jwmeWEhzjf4uD/OPCb4jRl6atJGYhLst8IyR6YAtTrriMU1');
  assert.equal(sha512crypt('pässwörd', 'Xy7.abc', 20000),
    '$6$rounds=20000$Xy7.abc$72uyS5s4y3tmlNnQ9O/6THVR5wjBgwDw987GG.MajHYeDNe9Q0Ep03CjzihcxQiLCNL3xOvpA2/muT74F/Oaz0');
  assert.equal(sha512crypt('This is just a test', 'rounds=5000$toolongsaltstring'.split('$')[1], 5000),
    '$6$toolongsaltstrin$lQ8jolhgVRVhY4b5pZKaysCLi0QBxGoNeKQzQ3glMhwllF7oGDZxUhx1yxdYcz/e1JSbq3y6JMxxl8audkUEm0');
});

test('agrees with OpenSSL for unicode and long passwords', { skip: !hasOpenssl() }, () => {
  for (const pw of ['pässwörd-ünïcode', 'x'.repeat(130), 'a']) {
    const expected = execFileSync('openssl', ['passwd', '-6', '-salt', 'Abc.def/123', pw]).toString().trim();
    assert.equal(sha512crypt(pw, 'Abc.def/123'), expected);
  }
});

function hasOpenssl() {
  try { execFileSync('openssl', ['version']); return true; } catch { return false; }
}
