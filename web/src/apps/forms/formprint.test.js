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
