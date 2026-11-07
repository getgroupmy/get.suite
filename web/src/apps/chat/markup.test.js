import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inline, blocks } from './markup.js';

const show = (nodes) => nodes.map((n) => (n.t === 'text' ? n.v : n.t === 'code' ? `<code>${n.v}</code>` : `<${n.t}>${show(n.c)}</${n.t}>`)).join('');

test('bold, italic, strike and code inline', () => {
  assert.equal(show(inline('This is *very* important')), 'This is <b>very</b> important');
  assert.equal(show(inline('_maybe_ and ~not~ and `x = 1`')), '<i>maybe</i> and <s>not</s> and <code>x = 1</code>');
  assert.equal(show(inline('*bold with _italic_ inside*!')), '<b>bold with <i>italic</i> inside</b>!');
  assert.equal(show(inline('`*not bold*`')), '<code>*not bold*</code>');
});

test('ordinary text is left alone', () => {
  for (const t of ['2 * 3 * 4 = 24', 'snake_case_name', 'a*b*c', 'price ~5 or ~6', 'trailing * star', '** empty', 'it costs $5*', 'unclosed `code']) assert.equal(show(inline(t)), t, t);
  assert.equal(show(inline('see https://example.com/a_b_c~d and mail ann_lee@example.com')), 'see https://example.com/a_b_c~d and mail ann_lee@example.com');
  assert.equal(show(inline('ask @kim_lee@acme.com about _this_')), 'ask @kim_lee@acme.com about <i>this</i>');
});

test('code blocks and quotes', () => {
  const b = blocks('Look:\n```\nconst a = *b*;\n  indented\n```\n> quoted *line*\n> second\nafter');
  assert.deepEqual(b.map((x) => x.t), ['line', 'code', 'quote', 'line']);
  assert.equal(b[1].v, 'const a = *b*;\n  indented');
  assert.equal(b[2].lines.length, 2);
  assert.equal(show(b[2].lines[0]), 'quoted <b>line</b>');
  assert.deepEqual(blocks('```one line```').map((x) => [x.t, x.v]), [['code', 'one line']]);
  assert.deepEqual(blocks('```\nnever closed').map((x) => [x.t, x.v]), [['code', 'never closed']]);
  assert.deepEqual(blocks('').map((x) => x.t), ['line']);
});
