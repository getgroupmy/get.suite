import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { cleanQuestions, checkAnswers, responseTable, answersText, signatureOf, MAX_SIGNATURE_BYTES } from '../src/routes/forms.js';

/** A real (tiny) PNG: 2×1 pixels. */
function png(extra = 0) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]); // CRC isn't checked here
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(3 + extra))), chunk('IEND', Buffer.alloc(0))]);
}
const url = (b) => `data:image/png;base64,${b.toString('base64')}`;

test('signature questions: a drawn PNG is kept as it is; anything else is refused', () => {
  const qs = cleanQuestions([{ id: 'name', type: 'short', title: 'Your name' }, { id: 'sig', type: 'signature', title: 'Sign here', required: true }]);
  assert.equal(qs[1].type, 'signature');
  assert.equal(qs[1].required, true);
  const sig = url(png());
  assert.equal(signatureOf(sig), sig);
  assert.deepEqual(checkAnswers(qs, { name: 'Kim', sig }), { name: 'Kim', sig });
  // Required: no drawing, no response.
  assert.throws(() => checkAnswers(qs, { name: 'Kim' }), /Sign here: this question needs an answer/);
  assert.throws(() => checkAnswers(qs, { name: 'Kim', sig: '' }), /needs an answer/);
  // Not a PNG picture: text, another kind of picture, a PNG's header with something else after the type.
  for (const bad of ['Kim Park', 'data:image/svg+xml;base64,PHN2Zz4=', `data:image/png;base64,${Buffer.from('GIF89a not a png at all, really').toString('base64')}`,
    `data:image/png;base64,${png().toString('base64')}"><script>`, { src: sig }, ['x']]) {
    assert.throws(() => checkAnswers(qs, { name: 'Kim', sig: bad }), /Sign here: draw your signature again/, String(bad).slice(0, 40));
  }
  // Too big a picture.
  const big = url(Buffer.concat([png(), Buffer.alloc(MAX_SIGNATURE_BYTES)]));
  assert.equal(signatureOf(big), null);
  // Not required: it may be left out.
  const optional = cleanQuestions([{ id: 'sig', type: 'signature', title: 'Sign' }]);
  assert.deepEqual(checkAnswers(optional, {}), {});
});

test('signature questions read as "Signed" in the CSV, the linked spreadsheet and emailed copies', () => {
  const form = { title: 'Consent', audience: 'public', questions: cleanQuestions([{ id: 'name', type: 'short', title: 'Name' }, { id: 'sig', type: 'signature', title: 'Signature' }]) };
  const sig = url(png());
  const [head, signed, unsigned] = responseTable(form, [{ created_at: 0, answers: { name: 'Kim', sig } }, { created_at: 1, answers: { name: 'Pat' } }]);
  assert.deepEqual(head.slice(1), ['Name', 'Signature']);
  assert.deepEqual(signed.slice(1), ['Kim', 'Signed']);
  assert.deepEqual(unsigned.slice(1), ['Pat', '']);
  const text = answersText(form.questions, { name: 'Kim', sig });
  assert.equal(text, 'Name: Kim\nSignature: Signed');
  assert.ok(!text.includes('base64'));
});
