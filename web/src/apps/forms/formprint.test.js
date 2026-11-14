import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerText, responsesPrintHtml } from './formprint.js';

test('answers as text: grids, rankings, files, lists, none', () => {
  assert.equal(answerText({ type: 'grid', rows: ['Food', 'Room'] }, { Food: 'Good', Room: 'Poor' }), 'Food: Good\nRoom: Poor');
  assert.equal(answerText({ type: 'rank' }, ['B', 'A']), '1. B\n2. A');
  assert.equal(answerText({ type: 'file' }, [{ name: 'cv.pdf' }]), '📎 cv.pdf');
  assert.equal(answerText({ type: 'checkbox' }, ['x', 'y']), 'x, y');
  assert.equal(answerText({ type: 'short' }, undefined), null);
});

test('responses print one to a page, with who, when, the score and every question', () => {
  const form = { title: 'Lunch <poll>', questions: [{ id: 'a', type: 'short', title: 'Name' }, { id: 's', type: 'section', title: 'Part 2' }, { id: 'b', type: 'paragraph', title: 'Notes' }] };
  const html = responsesPrintHtml(form, [
    { created_at: 0, user: { name: 'Ann', email: 'ann@x' }, answers: { a: 'Ann', b: 'line 1\nline 2' }, score: 1, max: 2, right: { a: true } },
    { created_at: 0, email: 'bo@x', answers: {} },
  ], { when: () => 'today' });
  assert.equal((html.match(/<section class="r">/g) || []).length, 2);
  assert.match(html, /Lunch &lt;poll&gt;/);
  assert.match(html, /Response 1 of 2 · today · Ann \(ann@x\) · 1 \/ 2/);
  assert.match(html, /Name ✓/);
  assert.match(html, /line 1<br>line 2/);
  assert.doesNotMatch(html, /Part 2/, 'section headings are not questions');
  assert.match(html, /Response 2 of 2 · today · bo@x/);
  assert.match(html, /class="a none">No answer/);
});

test('a blank form to fill in on paper: circles, boxes, lines, grids, scales; sections start a page', async () => {
  const { blankFormHtml } = await import('./formprint.js');
  const html = blankFormHtml({ title: 'Event <feedback>', description: 'Thanks!', questions: [
    { id: 'a', type: 'short', title: 'Name', required: true },
    { id: 'b', type: 'choice', title: 'Came by', options: ['Car', 'Train'], other: true },
    { id: 'c', type: 'checkbox', title: 'Sessions', options: ['Morning'] },
    { id: 's', type: 'section', title: 'Part two' },
    { id: 'd', type: 'grid', title: 'Rate', rows: ['Food'], columns: ['Good', 'Poor'] },
    { id: 'e', type: 'scale', title: 'Overall', max: 5, low: 'Bad', high: 'Great' },
    { id: 'f', type: 'paragraph', title: 'Comments' },
  ] });
  assert.match(html, /<h1>Event &lt;feedback&gt;<\/h1>/);
  assert.match(html, /1\. Name <span class="req">\*<\/span>/);
  assert.match(html, /<span class="o"><\/span> Car/);
  assert.match(html, /Other: <span class="fill">/);
  assert.match(html, /<span class="b"><\/span> Morning/);
  assert.match(html, /<h2 class="section">Part two<\/h2>/);
  assert.match(html, /4\. Rate/, 'sections are not numbered');
  assert.match(html, /<th>Food<\/th><td><span class="o"><\/span><\/td><td><span class="o"><\/span><\/td>/);
  assert.match(html, /<span>Bad<\/span>[\s\S]*5<\/span><span>Great<\/span>/);
  assert.equal((html.match(/class="line"/g) || []).length, 1 + 4);
});

test('the summary as a report: counts with shares, grids, averages, written answers', async () => {
  const { summaryPrintHtml } = await import('./formprint.js');
  const html = summaryPrintHtml({ title: 'Lunch' }, [
    { id: 'a', title: 'Pick', answered: 4, bars: [{ label: 'Soup <hot>', count: 3, share: 0.75 }, { label: 'Salad', count: 1, share: 0.25 }] },
    { id: 'b', title: 'Rate', answered: 2, grid: [{ row: 'Food', bars: [{ label: 'Good', count: 2 }, { label: 'Poor', count: 0 }] }] },
    { id: 'c', title: 'Score', answered: 2, average: 4.5, bars: [] },
    { id: 'd', title: 'Notes', answered: 1, texts: ['line 1\nline 2'] },
  ], { count: 4 });
  assert.match(html, /4 responses/);
  assert.match(html, /Soup &lt;hot&gt;<\/td><td class="bar"><span style="width:75%"><\/span><\/td><td class="n">3 \(75%\)/);
  assert.match(html, /<th>Food<\/th><td>2<\/td><td>0<\/td>/);
  assert.match(html, /2 answers · average 4\.5/);
  assert.match(html, /line 1<br>line 2/);
});

test('signature answers: "Signed" as text; the picture when printed, and only a PNG picture', async () => {
  const { isSignature, summaryPrintHtml } = await import('./formprint.js');
  const sig = 'data:image/png;base64,iVBORw0KGgo=';
  const q = { id: 's', type: 'signature', title: 'Sign here' };
  assert.equal(answerText(q, sig), 'Signed');
  assert.equal(answerText(q, undefined), null);
  assert.ok(isSignature(sig));
  for (const bad of ['data:image/svg+xml;base64,PHN2Zz4=', 'javascript:alert(1)', `${sig}" onerror="x`, 42]) assert.ok(!isSignature(bad));
  const html = responsesPrintHtml({ title: 'Consent', questions: [q] }, [{ created_at: 0, answers: { s: sig } }, { created_at: 1, answers: { s: `${sig}" onerror="alert(1)` } }]);
  assert.ok(html.includes(`<img class="sig" src="${sig}" alt="Signature">`));
  assert.ok(!html.includes('onerror="alert'));
  assert.ok(html.includes('Signed')); // the one that isn't a picture reads as text
  const sum = summaryPrintHtml({ title: 'Consent', questions: [q] }, [{ id: 's', title: 'Sign here', type: 'signature', answered: 2, signatures: [sig, 'javascript:x'] }], 2);
  assert.equal(sum.match(/<img class="sig"/g).length, 1);
});
