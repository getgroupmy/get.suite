// Suggestions (Docs' suggesting mode) at random, through Word and OpenDocument files and through LibreOffice:
// documents with insertions, deletions and replacements by different people at different times, among plain and
// bold words, come back with the same text and the same suggestions (what, by whom, when, which belong together).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { soffice, hasSoffice } from './soffice.js';
import { wordFromDoc, docFromWord } from '../src/office/word.js';
import { odtFromDoc, docFromOdt } from '../src/office/odt.js';

let seed = Number(process.env.SEED) || 20261121;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const PEOPLE = [['u1', 'Kim Park'], ['u2', 'Olivia Owner'], ['u3', 'Zoë Ångström'], ['u4', '山田 太郎'], ['u5', "Pat O'Neil & Co"]];
const WORDS = ['the', 'meeting', 'is', 'on', 'Monday', 'Tuesday', 'at', 'noon', 'résumé', 'naïve', '“quoted”', 'a < b', '50%', 'Q3', 'café', '🙂', 'tab\tbetween', 'two  spaces'];
const words = (n) => Array.from({ length: n }, () => pick(WORDS)).join(' ');

/** n random documents: paragraphs of plain or bold words with suggestions between them (never two side by side). */
function randomDocs(n) {
  const docs = [];
  for (let d = 0; d < n; d++) {
    let id = 0;
    const content = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => {
      const kids = [{ type: 'text', text: `${words(1 + Math.floor(rnd() * 3))} ` }];
      for (let k = Math.floor(rnd() * 4); k--;) {
        const [by, name] = pick(PEOPLE);
        const at = Date.UTC(2026, Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28), Math.floor(rnd() * 24), Math.floor(rnd() * 60));
        const sid = `s${++id}`;
        const bold = rnd() < 0.3 ? [{ type: 'bold' }] : [];
        const mark = (type) => ({ type, attrs: { id: sid, by, name, at } });
        const kind = pick(['insert', 'delete', 'replace']);
        if (kind !== 'insert') kids.push({ type: 'text', text: words(1 + Math.floor(rnd() * 2)), marks: [...bold, mark('suggestDelete')] });
        if (kind !== 'delete') kids.push({ type: 'text', text: words(1 + Math.floor(rnd() * 2)), marks: [...bold, mark('suggestInsert')] });
        kids.push({ type: 'text', text: ` ${words(1 + Math.floor(rnd() * 2))} `, ...(rnd() < 0.3 && { marks: [{ type: 'bold' }] }) });
      }
      kids[kids.length - 1].text = kids[kids.length - 1].text.replace(/\s+$/, '') || 'end'; // (a space ending a paragraph isn't kept: nothing to see)
      return { type: 'paragraph', content: kids };
    });
    docs.push({ type: 'doc', content });
  }
  return docs;
}
/**
 * A document as text to compare: each paragraph's words, bold as *…*, each suggestion as +[…] or -[…] with who and when
 * (to the minute) and a number saying which belong together (a replacement's deletion and insertion share one).
 */
function show(d) {
  return (d.doc || d).content.map((p) => {
    const ids = new Map();
    const parts = [];
    for (const t of p.content || []) {
      const m = (t.marks || []).find((x) => /^suggest/.test(x.type));
      const bold = (t.marks || []).some((x) => x.type === 'bold');
      const key = m ? `${m.type === 'suggestInsert' ? '+' : '-'}|${m.attrs.name}|${new Date(m.attrs.at).toISOString().slice(0, 16)}|#${ids.get(m.attrs.id) ?? ids.set(m.attrs.id, ids.size + 1).get(m.attrs.id)}` : '';
      const last = parts[parts.length - 1];
      if (last && last.key === key && last.bold === bold) last.text += t.text; else parts.push({ key, bold, text: t.text });
    }
    return parts.map((x) => { const w = x.bold ? `*${x.text}*` : x.text; return x.key ? `${x.key[0]}[${w}${x.key.slice(1)}]` : w; }).join('');
  });
}

test('40 random documents with suggestions: the same back from .docx and from .odt', async () => {
  for (const [i, doc] of randomDocs(40).entries()) {
    assert.deepEqual(show(await docFromWord(await wordFromDoc(doc, 'T'))), show(doc), `document ${i} (.docx)`);
    assert.deepEqual(show(await docFromOdt(await odtFromDoc(doc, 'T'))), show(doc), `document ${i} (.odt)`);
  }
});

test('and 15 through LibreOffice: each format saved again by it as .docx and as .odt', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const docs = randomDocs(15);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suggest-'));
  try {
    const files = [];
    for (const [i, doc] of docs.entries()) {
      fs.writeFileSync(path.join(dir, `w${i}.docx`), await wordFromDoc(doc, 'T'));
      fs.writeFileSync(path.join(dir, `o${i}.odt`), await odtFromDoc(doc, 'T'));
      files.push(path.join(dir, `w${i}.docx`), path.join(dir, `o${i}.odt`));
    }
    for (const as of ['docx', 'odt']) soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, as), ...files]);
    for (const [i, doc] of docs.entries()) {
      for (const from of ['w', 'o']) {
        for (const as of ['docx', 'odt']) {
          const buf = fs.readFileSync(path.join(dir, as, `${from}${i}.${as}`));
          const back = as === 'docx' ? await docFromWord(buf) : await docFromOdt(buf);
          assert.deepEqual(show(back), show(doc), `document ${i}: our .${from === 'w' ? 'docx' : 'odt'} saved by LibreOffice as .${as}`);
        }
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('spaces where two pieces of text meet (plain "a " then bold " b", a space each side of a deleted word), and a plain deleted word after bold, survive LibreOffice', { skip: !hasSoffice && 'LibreOffice isn’t installed here' }, async () => {
  const m = { type: 'suggestDelete', attrs: { id: 's1', by: 'u1', name: 'Kim Park', at: Date.UTC(2026, 0, 4, 21, 13) } };
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'two ' }, { type: 'text', text: ' spaces', marks: [{ type: 'bold' }] }, { type: 'text', text: ' and\t then' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'noon ' }, { type: 'text', text: 'at', marks: [m] }, { type: 'text', text: ' then' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'a ' }, { type: 'text', text: 'bold ', marks: [{ type: 'bold' }] }, { type: 'text', text: 'gone', marks: [m] }, { type: 'text', text: ' end' }] },
  ] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.odt'), await odtFromDoc(doc, 'T'));
    for (const as of ['odt', 'docx']) soffice([`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', as, '--outdir', path.join(dir, as), path.join(dir, 'a.odt')]);
    for (const as of ['odt', 'docx']) {
      const buf = fs.readFileSync(path.join(dir, as, `a.${as}`));
      assert.deepEqual(show(as === 'odt' ? await docFromOdt(buf) : await docFromWord(buf)), ['two * spaces* and\t then', 'noon -[at|Kim Park|2026-01-04T21:13|#1] then', 'a *bold *-[gone|Kim Park|2026-01-04T21:13|#1] end'], `.odt saved by LibreOffice as .${as}`); // (were "two *spaces*…" with one space, "noon -[at…]then", and "gone" bold in .docx)
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
