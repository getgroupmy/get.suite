import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-'));
const { fillSignature } = await import('../src/mail/companysig.js');

test('company signature: placeholders filled and escaped; lines with nothing to show left out', () => {
  const v = { name: 'Kim <Park>', job_title: 'Designer', department: '', work_phone: '', email: 'kim@acme.com', company: 'Acme & Co' };
  assert.equal(fillSignature('{name}\n{job_title} · {department}\nPhone: {work_phone}\n{company}', v),
    '<p>Kim &lt;Park&gt;</p><p>Designer · </p><p>Acme &amp; Co</p>');
  assert.equal(fillSignature('<p><strong>{name}</strong><br>Tel {work_phone}<br>{email}</p><p>{department}</p>', v),
    '<p><strong>Kim &lt;Park&gt;</strong><br>kim@acme.com</p>');
  assert.equal(fillSignature('Hi {unknown}', v), '<p>Hi {unknown}</p>', 'other braces stay');
});
