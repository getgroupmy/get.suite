import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { parseDmarc, parseTlsrpt, unpack, summarize } from '../src/mail/reports.js';
import { DMARC, TLS } from './fixtures/reports.js';

test('reports: DMARC XML and TLS JSON are read', () => {
  const d = parseDmarc(DMARC);
  assert.deepEqual([d.org, d.id, d.domain, d.policy, d.records.length, d.begin], ['google.com', '123456', 'acme.com', 'quarantine', 3, 1762646400000]);
  assert.deepEqual(d.records[1], { ip: '198.51.100.7', count: 3, disposition: 'quarantine', dkim: 'fail', spf: 'fail', from: 'acme.com' });
  const t = parseTlsrpt(TLS);
  assert.deepEqual([t.org, t.policies[0].domain, t.policies[0].success, t.policies[0].failure, t.policies[0].failures[0].result], ['Microsoft Corporation', 'acme.com', 120, 2, 'certificate-expired']);
  assert.equal(parseDmarc('<html>no</html>'), null);
  assert.equal(parseTlsrpt('{"x":1}'), null);
});

test('reports: unpacked from .gz and .zip; added up per domain, the same report once', async () => {
  const gz = zlib.gzipSync(Buffer.from(DMARC));
  assert.equal(await unpack('google.com!acme.com!1!2.xml.gz', gz), DMARC);
  const zip = new JSZip(); zip.file('report.xml', DMARC);
  assert.equal(await unpack('x.zip', await zip.generateAsync({ type: 'nodebuffer' })), DMARC);
  assert.equal(await unpack('photo.jpg', Buffer.from('xx')), null);
  const [acme] = summarize([parseDmarc(DMARC), parseDmarc(DMARC), parseTlsrpt(TLS)]);
  assert.deepEqual([acme.domain, acme.dmarc.messages, acme.dmarc.pass, acme.dmarc.fail], ['acme.com', 50, 47, 3], 'counted once');
  assert.deepEqual(acme.dmarc.sources.map((s) => [s.ip, s.messages, s.pass, s.fail, s.dkim, s.spf, s.quarantined]), [['203.0.113.10', 47, 47, 0, 47, 42, 0], ['198.51.100.7', 3, 0, 3, 0, 0, 3]]);
  assert.deepEqual([acme.tls.success, acme.tls.failure, acme.tls.reasons], [120, 2, [{ result: 'certificate-expired', count: 2 }]]);
  assert.deepEqual(acme.tls.reporters, ['Microsoft Corporation']);
});
