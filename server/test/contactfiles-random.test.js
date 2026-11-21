// Random contacts (names with commas, semicolons, a line break, accents, Hebrew, Chinese and emoji; companies, notes and
// titles with ; , \\ and tabs; addresses over several lines; birthdays with and without a year; other emails, numbers,
// dates and fields of your own) out as a .vcf and a .csv and back in. The test found a company with a semicolon in it
// ("R&D; Labs") coming back cut at it, and a field of your own whose label had one ("Desk;No") too: a vCard's escaped \\;
// and a ; inside a quoted parameter were read as separators. (The calendar's .ics reader shares the line reader:
// CN="Doe; Jo" is one name now.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactsToVcf, contactsFromVcards, contactsToCsv, contactsFromCsv } from '../src/contactfiles.js';
import { contentLines } from '../src/ics.js';

function contacts(n, start) {
  let seed = start; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const S = ['Ada Lovelace', 'Zoë O\'Brien-Smith', 'Li, Wei', 'Anna; Maria', 'José García Márquez', '王小明', 'שלום כהן', 'Dr. Kim', 'a\\b', '  spaced  name ', 'Line\nBreak', 'Émile Zola Jr.', 'x,y;z:w', '😀 Smiley'];
  const T = ['Acme, Inc.', 'Café & Co', 'R&D; Labs', 'note with\nnew line', 'semi;colon', 'back\\slash', 'comma, here', 'tab\there', 'ÆØÅ', 'quote "q"', '=SUM(1)', '+1 starts', 'long ' + 'x'.repeat(100)];
  return Array.from({ length: n }, (_, k) => ({
    id: `c${k}`, name: pick(S), email: rnd() < 0.8 ? pick(['ada@x.example', 'zoe.obrien@ex.example', 'li+tag@ex.example', 'UPPER@Ex.Example']) : null,
    phone: rnd() < 0.6 ? pick(['+44 20 7946 0958', '(555) 123-4567', '+60 12-345 6789', '0123']) : null,
    company: rnd() < 0.5 ? pick(T) : null, notes: rnd() < 0.5 ? pick(T) : null, title: rnd() < 0.4 ? pick(T) : null,
    address: rnd() < 0.4 ? pick(['1 Main St\nSpringfield', '10 Downing St, London', 'Jalan 1; KL', 'Rue de la Paix 3\n75002 Paris\nFrance']) : null,
    website: rnd() < 0.3 ? pick(['https://ex.example/a?b=1&c=2', 'http://x.example']) : null,
    birthday: rnd() < 0.4 ? pick(['1990-05-17', '--05-17', '2000-02-29']) : null,
    more_emails: rnd() < 0.3 ? [{ type: pick(['work', 'home', 'other']), value: 'second@ex.example' }] : [],
    more_phones: rnd() < 0.3 ? [{ type: pick(['work', 'home', 'mobile']), value: '+1 555 0100' }] : [],
    dates: rnd() < 0.2 ? [{ label: pick(['Anniversary', 'Started', 'Hired; first']), date: pick(['2015-06-01', '--12-25']) }] : [],
    custom_fields: rnd() < 0.2 ? [{ label: pick(['Pronouns', 'Team, B', 'Desk;No']), value: pick(['they/them', '4F; east', 'A,B']) }] : [],
  }));
}
const FIELDS = ['name', 'email', 'phone', 'company', 'notes', 'title', 'address', 'website', 'birthday', 'more_emails', 'more_phones', 'dates', 'custom_fields'];
// What comes back by design: a name trimmed, the first other address or number made the contact's own when it has none,
// an email in small letters from a .csv, and text starting = + - @ written with ' before it in a .csv (so a spreadsheet
// opening it doesn't run it as a formula).
function expected(c, csv) {
  const e = { ...c, name: c.name.trim() };
  if (!e.email && e.more_emails?.length) { e.email = e.more_emails[0].value; e.more_emails = e.more_emails.slice(1); }
  if (!e.phone && e.more_phones?.length) { e.phone = e.more_phones[0].value; e.more_phones = e.more_phones.slice(1); }
  if (csv) {
    if (e.email) e.email = e.email.toLowerCase();
    for (const f of ['name', 'company', 'notes', 'title', 'address']) if (/^[=+\-@]/.test(e[f] || '') && !/^[+-]?[\d\s().-]+$/.test(e[f])) e[f] = `'${e[f]}`;
  }
  return e;
}
const value = (c, f) => { const v = c[f]; return Array.isArray(v) ? JSON.stringify(v.map((o) => Object.fromEntries(Object.entries(o).sort()))) : v ?? null; };
for (const [name, to, from, csv] of [['vCard (.vcf)', contactsToVcf, contactsFromVcards, false], ['CSV', contactsToCsv, contactsFromCsv, true]]) {
  test(`60 random contacts out as ${name} and back: every field the same`, () => {
    const list = contacts(60, csv ? 2 : 1);
    const back = from(to(list));
    assert.equal(back.length, list.length);
    const wrong = [];
    list.forEach((c, i) => {
      const e = expected(c, csv);
      for (const f of FIELDS) {
        const a = value(e, f), z = value(back[i], f);
        if (a !== z && !([null, '[]'].includes(a) && [null, '[]'].includes(z))) wrong.push(`#${i} ${f}: ${a} came back ${z}`);
      }
    });
    assert.deepEqual(wrong, []);
  });
}

test('a ; inside a quoted parameter is the parameter\'s own (vCard and .ics alike)', () => {
  const [l] = contentLines('ATTENDEE;CN="Doe; Jo";ROLE=REQ-PARTICIPANT:mailto:jo@ex.example');
  assert.deepEqual(l.params, { CN: 'Doe; Jo', ROLE: 'REQ-PARTICIPANT' });
  assert.equal(l.value, 'mailto:jo@ex.example');
});
