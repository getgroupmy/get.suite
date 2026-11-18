import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { docFromJson, jsonFromDoc } from '../src/collabdoc.js';

const doc = { type: 'doc', content: [
  { type: 'heading', attrs: { level: 2, textAlign: 'center' }, content: [{ type: 'text', text: 'Plan' }] },
  { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
    { type: 'text', text: ' and a ' }, { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.com', target: '_blank' } }, { type: 'italic' }] }] },
  { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }] }] },
  { type: 'paragraph' },
] };

test('a stored document converts to the shared form and back unchanged', () => {
  const y = docFromJson(doc);
  assert.deepEqual(jsonFromDoc(y), doc);
});

test('edits merge: two copies changed at once end up the same', () => {
  const a = docFromJson(doc);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  // A types at the start of the heading while B adds a paragraph at the end.
  a.getXmlFragment('default').get(0).get(0).insert(0, 'Q4 ');
  b.getXmlFragment('default').insert(4, [new Y.XmlElement('paragraph')]);
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const ja = jsonFromDoc(a), jb = jsonFromDoc(b);
  assert.deepEqual(ja, jb);
  assert.equal(ja.content[0].content[0].text, 'Q4 Plan');
  assert.equal(ja.content.length, 5);
});

import { sheetDocFromJson, jsonFromSheetDoc, applySheetJson } from '../src/collabdoc.js';
test('spreadsheets: stored form round-trips; different cells changed at once both stay', () => {
  const json = { sheets: [{ name: 'Prices', cells: { A1: 'Item', B1: '=SUM(B2:B3)' }, colWidths: { A: 120 }, formats: { B1: { b: 1 } } }, { name: 'Notes', cells: {}, colWidths: {} }] };
  const a = sheetDocFromJson(json);
  assert.deepEqual(jsonFromSheetDoc(a), json);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  // A types in A2 while B renames the sheet and clears B1's format.
  const ja = jsonFromSheetDoc(a); ja.sheets[0].cells.A2 = 'Bolts';
  applySheetJson(a, ja);
  const jb = jsonFromSheetDoc(b); jb.sheets[0].name = 'Prices 2026'; delete jb.sheets[0].formats.B1; jb.sheets.push({ name: 'Sheet3', cells: { A1: 'x' }, colWidths: {} });
  applySheetJson(b, jb);
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const merged = jsonFromSheetDoc(a);
  assert.deepEqual(merged, jsonFromSheetDoc(b));
  assert.equal(merged.sheets[0].name, 'Prices 2026');
  assert.equal(merged.sheets[0].cells.A2, 'Bolts');
  assert.equal(merged.sheets[0].formats, undefined);
  assert.equal(merged.sheets.length, 3);
});

import { deckDocFromJson, jsonFromDeckDoc, applyDeckJson } from '../src/collabdoc.js';
test('presentations: round-trip; different boxes and slides changed at once both stay', () => {
  const t = (id, text, x = 10) => ({ id, type: 'text', text, x, y: 10, w: 50, h: 10, size: 24 });
  const json = { theme: 'ocean', slides: [{ id: 'a', items: [t('t1', 'Title'), t('t2', 'Sub')] }, { id: 'b', bg: '#ffffff', items: [] }] };
  const a = deckDocFromJson(json);
  assert.deepEqual(jsonFromDeckDoc(a), json);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  // A edits the title box; B moves the subtitle and adds a slide.
  const ja = jsonFromDeckDoc(a); ja.slides[0].items[0] = { ...ja.slides[0].items[0], text: 'Q4 review' };
  applyDeckJson(a, ja);
  const jb = jsonFromDeckDoc(b); jb.slides[0].items[1] = { ...jb.slides[0].items[1], x: 40 }; jb.slides.push({ id: 'c', items: [t('t3', 'New')] });
  applyDeckJson(b, jb);
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const m = jsonFromDeckDoc(a);
  assert.deepEqual(m, jsonFromDeckDoc(b));
  assert.equal(m.slides[0].items[0].text, 'Q4 review');
  assert.equal(m.slides[0].items[1].x, 40);
  assert.deepEqual(m.slides.map((s) => s.id), ['a', 'b', 'c']);
});

test('presentations: a slide’s transition and "skip when presenting" go through the shared form', () => {
  const deck = { theme: 'light', slides: [{ id: 'a', items: [], transition: 'zoom' }, { id: 'b', items: [], skip: true }] };
  const doc = deckDocFromJson(deck);
  assert.deepEqual(jsonFromDeckDoc(doc), deck);
  applyDeckJson(doc, { theme: 'light', slides: [{ id: 'a', items: [] }, { id: 'b', items: [], transition: 'fade' }] });
  assert.deepEqual(jsonFromDeckDoc(doc).slides, [{ id: 'a', items: [] }, { id: 'b', items: [], transition: 'fade' }]);
});

test('sheet groups go both ways through the shared document', async () => {
  const { sheetDocFromJson, jsonFromSheetDoc, applySheetJson } = await import('../src/collabdoc.js');
  const json = { sheets: [{ name: 'S', cells: { A1: '1' }, groups: [{ axis: 'row', from: 2, to: 4, collapsed: false }] }] };
  const doc = sheetDocFromJson(json);
  assert.deepEqual(jsonFromSheetDoc(doc).sheets[0].groups, json.sheets[0].groups);
  applySheetJson(doc, { sheets: [{ ...json.sheets[0], groups: [{ axis: 'row', from: 2, to: 4, collapsed: true }] }] });
  assert.equal(jsonFromSheetDoc(doc).sheets[0].groups[0].collapsed, true);
  applySheetJson(doc, { sheets: [{ name: 'S', cells: { A1: '1' } }] });
  assert.equal(jsonFromSheetDoc(doc).sheets[0].groups, undefined);
});

test('presentations: looping and slides that move on by themselves are kept and merged', () => {
  const deck = { theme: 'light', loop: true, numbers: true, slides: [{ id: 'a', items: [], advance: 10 }, { id: 'b', items: [] }] };
  const doc = deckDocFromJson(deck);
  assert.deepEqual(jsonFromDeckDoc(doc), deck);
  applyDeckJson(doc, { theme: 'light', slides: [{ id: 'a', items: [] }, { id: 'b', items: [], advance: 5 }] });
  const after = jsonFromDeckDoc(doc);
  assert.equal(after.loop, undefined);
  assert.equal(after.numbers, undefined);
  assert.deepEqual(after.slides.map((s) => s.advance || null), [null, 5]);
});

test('spreadsheets: cell notes are shared cell by cell', () => {
  const doc = sheetDocFromJson({ sheets: [{ name: 'S', cells: { A1: '1' }, notes: { A1: 'first' } }] });
  assert.deepEqual(jsonFromSheetDoc(doc).sheets[0].notes, { A1: 'first' });
  applySheetJson(doc, { sheets: [{ name: 'S', cells: { A1: '1' }, notes: { B2: 'second' } }] });
  assert.deepEqual(jsonFromSheetDoc(doc).sheets[0].notes, { B2: 'second' });
  applySheetJson(doc, { sheets: [{ name: 'S', cells: { A1: '1' } }] });
  assert.equal(jsonFromSheetDoc(doc).sheets[0].notes, undefined);
});

test('presentations: a background picture is shared, changed and taken away like the colour', () => {
  const a = deckDocFromJson({ theme: 'light', slides: [{ id: 's', bg: '#fde293', bgImage: 'pic1', items: [] }] });
  assert.equal(jsonFromDeckDoc(a).slides[0].bgImage, 'pic1');
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const jb = jsonFromDeckDoc(b); jb.slides[0].bgImage = 'pic2';
  applyDeckJson(b, jb);
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  assert.equal(jsonFromDeckDoc(a).slides[0].bgImage, 'pic2');
  const ja = jsonFromDeckDoc(a); delete ja.slides[0].bgImage;
  applyDeckJson(a, ja);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  assert.deepEqual(jsonFromDeckDoc(b).slides[0], { id: 's', bg: '#fde293', items: [] });
});

test('spreadsheets: slicers are kept, and two people changing different slicers both keep their change', () => {
  const a = { range: 'A1:C9', col: 'A', hidden: [], x: 400, y: 20 }, b = { range: 'A1:C9', col: 'B', hidden: [], x: 400, y: 80 };
  const doc = sheetDocFromJson({ sheets: [{ name: 'S', cells: { A1: 'Region' }, slicers: { a, b } }] });
  assert.deepEqual(jsonFromSheetDoc(doc).sheets[0].slicers, { a, b });
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  const mine = jsonFromSheetDoc(doc), theirs = jsonFromSheetDoc(other);
  applySheetJson(doc, { sheets: [{ ...mine.sheets[0], slicers: { a: { ...a, hidden: ['East'] }, b } }] });
  applySheetJson(other, { sheets: [{ ...theirs.sheets[0], slicers: { a, b: { ...b, x: 600 } } }] });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
  const got = jsonFromSheetDoc(doc).sheets[0].slicers;
  assert.deepEqual([got.a.hidden, got.b.x], [['East'], 600]);
  applySheetJson(doc, { sheets: [{ ...jsonFromSheetDoc(doc).sheets[0], slicers: {} }] });
  assert.equal(jsonFromSheetDoc(doc).sheets[0].slicers, undefined, 'none left: none kept');
});

test('spreadsheets: filter views are kept, and two people changing different views both keep their change', () => {
  const a = { name: 'North', range: 'A1:C9', hidden: {} }, b = { name: 'Late', range: 'A1:C9', hidden: {} };
  const doc = sheetDocFromJson({ sheets: [{ name: 'S', cells: { A1: 'Region' }, views: { a, b } }] });
  assert.deepEqual(jsonFromSheetDoc(doc).sheets[0].views, { a, b });
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  const mine = jsonFromSheetDoc(doc), theirs = jsonFromSheetDoc(other);
  applySheetJson(doc, { sheets: [{ ...mine.sheets[0], views: { a: { ...a, hidden: { A: ['South'] } }, b } }] });
  applySheetJson(other, { sheets: [{ ...theirs.sheets[0], views: { a, b: { ...b, name: 'Overdue' } } }] });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(other));
  const got = jsonFromSheetDoc(doc).sheets[0].views;
  assert.deepEqual([got.a.hidden, got.b.name], [{ A: ['South'] }, 'Overdue']);
  assert.equal(jsonFromSheetDoc(doc).sheets[0].filter, undefined, 'the sheet\'s own filter is untouched');
  applySheetJson(doc, { sheets: [{ ...jsonFromSheetDoc(doc).sheets[0], views: {} }] });
  assert.equal(jsonFromSheetDoc(doc).sheets[0].views, undefined, 'none left: none kept');
});

test('presentations: their own theme and master (logo, footer) are kept and changed', () => {
  const custom = { bg: '#102030', text: '#ffffff', accent: '#ff8800', font: 'Georgia' }, master = { logo: 'abc', corner: 'br', footer: 'Acme' };
  const doc = deckDocFromJson({ theme: 'custom', custom, master, slides: [{ id: 's1', items: [] }] });
  const json = jsonFromDeckDoc(doc);
  assert.deepEqual([json.theme, json.custom, json.master], ['custom', custom, master]);
  applyDeckJson(doc, { ...json, master: { ...master, footer: 'Acme Trading' } });
  assert.equal(jsonFromDeckDoc(doc).master.footer, 'Acme Trading');
  applyDeckJson(doc, { ...jsonFromDeckDoc(doc), master: undefined });
  assert.equal(jsonFromDeckDoc(doc).master, undefined);
});

test('spreadsheets: a pivot\'s settings are kept whole (several values, grouping, filter, shares, order)', () => {
  const pivot = { source: 'Data', c1: 0, c2: 3, r1: 0, rows: 3, cols: null, value: 2, fn: 'sum', values: [{ col: 2, fn: 'sum' }, { col: null, fn: 'count' }], group: 'month', filter: { col: 1, hide: ['Coffee'] }, show: 'percent', sort: 'desc' };
  const doc = sheetDocFromJson({ sheets: [{ name: 'Data', cells: {} }, { name: 'Pivot table 1', cells: {}, pivot }] });
  assert.deepEqual(jsonFromSheetDoc(doc).sheets[1].pivot, pivot);
  applySheetJson(doc, { sheets: [{ name: 'Data', cells: {} }, { name: 'Pivot table 1', cells: {}, pivot: { ...pivot, show: 'value' } }] });
  assert.equal(jsonFromSheetDoc(doc).sheets[1].pivot.show, 'value');
});

test('a comment’s words marked: across formatting runs, only the first place, live (Yjs) and stored alike; not across paragraphs', async () => {
  const { markQuoteInJson, markQuoteInYDoc, docFromJson, jsonFromDoc } = await import('../src/collabdoc.js');
  const json = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Ship it ' }, { type: 'text', text: 'on Fri', marks: [{ type: 'bold' }] }, { type: 'text', text: 'day, on Friday.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
  ] };
  const out = markQuoteInJson(json, 'on Friday', 'c1');
  assert.equal(out.found, true);
  assert.deepEqual(out.json.content[0].content, [
    { type: 'text', text: 'Ship it ' },
    { type: 'text', text: 'on Fri', marks: [{ type: 'bold' }, { type: 'comment', attrs: { id: 'c1' } }] },
    { type: 'text', text: 'day', marks: [{ type: 'comment', attrs: { id: 'c1' } }] },
    { type: 'text', text: ', on Friday.' },
  ]);
  assert.equal(markQuoteInJson(json, 'Friday.\nSecond', 'c2').found, false);
  // Live: the same marks end up in the shared document.
  const doc = docFromJson(json);
  assert.equal(markQuoteInYDoc(doc, 'on Friday', 'c1'), true);
  const back = jsonFromDoc(doc).content[0].content;
  assert.deepEqual(back.filter((n) => n.marks?.some((m) => m.type === 'comment')).map((n) => n.text).join(''), 'on Friday');
  assert.equal(markQuoteInYDoc(doc, 'nowhere', 'c3'), false);
});

import { replaceInYDoc, replaceInJson, suggestionsInJson, suggestionsInYDoc, resolveSuggestionsInJson, resolveSuggestionsInYDoc } from '../src/collabdoc.js';
test('find and replace in a document: live (Yjs) and stored alike; formatting of the first letter kept; first only, any case, not across objects', () => {
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'The Acme ' }, { type: 'text', text: 'Corp', marks: [{ type: 'bold' }] }, { type: 'text', text: ' plan.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'acme corp, ', marks: [{ type: 'italic' }] }, { type: 'text', text: 'Acme Corp 😀 Acme' }, { type: 'mention', attrs: { id: 'u', name: 'x' } }, { type: 'text', text: 'Corp' }] },
  ] };
  // (runs with the same formatting merged, as the editor keeps them)
  const words = (json) => json.content.map((p) => { const out = []; for (const n of p.content || []) { const tag = n.type === 'text' ? (n.marks ? `{${n.marks.map((m) => m.type)}}` : '') : null; const last = out[out.length - 1]; if (tag !== null && last && last.tag === tag) last.text += n.text; else out.push(tag === null ? { text: `[${n.type}]`, tag: '#' } : { text: n.text, tag }); } return out.map((o) => (o.tag === '#' ? o.text : `${o.text}${o.tag}`)).join('|'); });
  // Stored
  const a = replaceInJson(doc, 'Acme Corp', 'Beta Ltd');
  assert.equal(a.count, 2);
  assert.deepEqual(words(a.json), ['The Beta Ltd plan.', 'acme corp, {italic}|Beta Ltd 😀 Acme|[mention]|Corp'], 'across the bold; not across the mention');
  assert.deepEqual(words(replaceInJson(doc, 'acme corp', 'X', { matchCase: false, all: false }).json), ['The X plan.', 'acme corp, {italic}|Acme Corp 😀 Acme|[mention]|Corp']);
  assert.equal(replaceInJson(doc, 'nowhere', 'x').count, 0);
  // Live: the same changes
  const y = docFromJson(doc);
  assert.equal(replaceInYDoc(y, 'Acme Corp', 'Beta Ltd').count, 2);
  assert.deepEqual(words(jsonFromDoc(y)), words(a.json));
  const y2 = docFromJson(doc);
  assert.equal(replaceInYDoc(y2, 'ACME CORP', '', { matchCase: false }).count, 3);
  assert.deepEqual(words(jsonFromDoc(y2)), ['The  plan.', ', {italic}| 😀 Acme|[mention]|Corp']);
});

test('replace as suggestions: the words struck through, the new ones after them, one id and who for both; live and stored alike; not twice', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Due in ' }, { type: 'text', text: 'March', marks: [{ type: 'bold' }] }, { type: 'text', text: ', not March.' }] }] };
  const who = { by: 'u1', name: 'Olivia Owner', at: 1700000000000 };
  const shape = (json) => json.content[0].content.map((n) => {
    const s = (n.marks || []).find((m) => m.type.startsWith('suggest'));
    return [n.text, (n.marks || []).filter((m) => !m.type.startsWith('suggest')).map((m) => m.type).join(), s ? `${s.type}:${s.attrs.name}` : ''];
  });
  const ids = (json) => json.content[0].content.flatMap((n) => (n.marks || []).filter((m) => m.type.startsWith('suggest')).map((m) => m.attrs.id));
  const a = replaceInJson(doc, 'March', 'April', { suggest: who, all: false });
  assert.equal(a.count, 1);
  const want = [['Due in ', '', ''], ['March', 'bold', 'suggestDelete:Olivia Owner'], ['April', 'bold', 'suggestInsert:Olivia Owner'], [', not March.', '', '']];
  assert.deepEqual(shape(a.json), want);
  const [d, i] = ids(a.json);
  assert.ok(d && d === i, 'one suggestion: a replacement');
  assert.equal(a.json.content[0].content[1].marks.find((m) => m.type === 'suggestDelete').attrs.by, 'u1');
  // Again, everywhere: only the March not already in a suggestion.
  const b = replaceInJson(a.json, 'March', 'April', { suggest: who });
  assert.equal(b.count, 1);
  assert.equal(new Set(ids(b.json)).size, 2, 'its own suggestion');
  // Live: the same
  const y = docFromJson(doc);
  assert.equal(replaceInYDoc(y, 'March', 'April', { suggest: who, all: false }).count, 1);
  const live = jsonFromDoc(y);
  assert.deepEqual(shape(live), want);
  assert.equal(new Set(ids(live)).size, 1);
  assert.equal(replaceInYDoc(y, 'March', 'April', { suggest: who }).count, 1);
  // A deletion suggested: just struck through.
  assert.deepEqual(shape(replaceInJson(doc, ', not March', '', { suggest: who }).json).map((r) => r[2]), ['', '', 'suggestDelete:Olivia Owner', '']);
});

test('suggestions listed, accepted and rejected: chosen ones, one person\'s, live and stored alike', () => {
  const ana = { by: 'a', name: 'Ana', at: 1 }, ben = { by: 'b', name: 'Ben', at: 2 };
  let doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ship in ' }, { type: 'text', text: 'March', marks: [{ type: 'bold' }] }, { type: 'text', text: ' to Paris now.' }] }] };
  doc = replaceInJson(doc, 'March', 'April', { suggest: ana }).json;
  doc = replaceInJson(doc, 'Paris', 'Lyon', { suggest: ben }).json;
  doc = replaceInJson(doc, ' now', '', { suggest: ben }).json;
  const text = (json) => json.content[0].content.map((n) => n.text).join('');
  const list = suggestionsInJson(doc);
  assert.deepEqual(list.map((x) => [x.name, x.deleted, x.inserted]), [['Ana', 'March', 'April'], ['Ben', 'Paris', 'Lyon'], ['Ben', ' now', '']]);
  // Accept Ben's: Lyon in, " now" gone; Ana's still pending.
  const a = resolveSuggestionsInJson(doc, (x) => x.name === 'Ben', true);
  assert.equal(a.count, 2);
  assert.equal(text(a.json), 'Ship in MarchApril to Lyon.');
  assert.deepEqual(suggestionsInJson(a.json).map((x) => x.name), ['Ana']);
  // Reject Ana's: March kept (bold), April gone, no marks left.
  const b = resolveSuggestionsInJson(a.json, () => true, false);
  assert.deepEqual(b.json.content[0].content, [{ type: 'text', text: 'Ship in ' }, { type: 'text', text: 'March', marks: [{ type: 'bold' }] }, { type: 'text', text: ' to Lyon.' }]);
  assert.equal(resolveSuggestionsInJson(b.json, () => true, true).count, 0);
  // Live: the same
  const y = docFromJson(doc);
  assert.deepEqual(suggestionsInYDoc(y).map((x) => x.id), list.map((x) => x.id));
  assert.equal(resolveSuggestionsInYDoc(y, (x) => x.name === 'Ben', true).count, 2);
  assert.equal(text(jsonFromDoc(y)), 'Ship in MarchApril to Lyon.');
  assert.equal(resolveSuggestionsInYDoc(y, (x) => x.id === list[0].id, true).count, 1);
  assert.deepEqual(jsonFromDoc(y).content[0].content.map((n) => [n.text, (n.marks || []).map((m) => m.type).join()]), [['Ship in ', ''], ['April', 'bold'], [' to Lyon.', '']]);
  assert.deepEqual(suggestionsInYDoc(y), []);
});
