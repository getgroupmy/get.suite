import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownFromDoc, docFromMarkdown, inlineFromMarkdown } from '../src/office/markdown.js';

const t = (text, ...marks) => ({ type: 'text', text, ...(marks.length && { marks: marks.map((m) => (typeof m === 'string' ? { type: m } : m)) }) });
const p = (...content) => ({ type: 'paragraph', content });

test('a document as Markdown', () => {
  const doc = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [t('Plan')] },
    p(t('Some '), t('bold', 'bold'), t(' and '), t('italic ', 'italic'), t('code', 'code'), t(' and a '), t('link', { type: 'link', attrs: { href: 'https://x.example/a b' } }), t('.'), { type: 'footnote', attrs: { note: 'A note' } }),
    { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('one')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('inner'))] }] }] }, { type: 'listItem', content: [p(t('two'))] }] },
    { type: 'orderedList', content: [{ type: 'listItem', content: [p(t('first'))] }, { type: 'listItem', content: [p(t('second'))] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(t('done'))] }, { type: 'taskItem', attrs: { checked: false }, content: [p(t('todo'))] }] },
    { type: 'blockquote', content: [p(t('quoted'))] },
    { type: 'codeBlock', attrs: { language: 'js' }, content: [t('let a = 1;')] },
    { type: 'table', content: [
      { type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t('Name'))] }, { type: 'tableHeader', content: [p(t('Qty'))] }] },
      { type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('a|b'))] }, { type: 'tableCell', content: [p(t('2'))] }] }] },
    p(t('2. not a list * star')),
  ] };
  assert.equal(markdownFromDoc(doc), [
    '## Plan',
    'Some **bold** and *italic* `code` and a [link](https://x.example/a%20b).[^1]',
    '- one\n  - inner\n- two',
    '1. first\n2. second',
    '- [x] done\n- [ ] todo',
    '> quoted',
    '```js\nlet a = 1;\n```',
    '| Name | Qty |\n| --- | --- |\n| a\\|b | 2 |',
    '2\\. not a list \\* star',
    '[^1]: A note',
  ].join('\n\n') + '\n');
});

test('Markdown opened as a document', () => {
  const doc = docFromMarkdown([
    '# Title', '', 'Text with **bold**, _it_, ~~gone~~, `x`, [site](https://a.example) and a note[^n].', 'Same paragraph.', '',
    '- a', '  - b', '- c', '', '3. three', '4. four', '', '- [x] done', '- [ ] open', '', '> quote', '',
    '```py', 'print(1)', '```', '', '| A | B |', '|---|:-:|', '| 1 | 2 |', '', '---', '', '[^n]: The note.', '[bad](javascript:alert(1))',
  ].join('\n'));
  const types = doc.content.map((n) => n.type);
  assert.deepEqual(types, ['heading', 'paragraph', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'table', 'horizontalRule', 'paragraph']);
  const para = doc.content[1].content;
  assert.deepEqual(para.filter((n) => n.marks).map((n) => [n.text, n.marks.map((m) => m.type).join()]), [['bold', 'bold'], ['it', 'italic'], ['gone', 'strike'], ['x', 'code'], ['site', 'link']]);
  assert.ok(para.some((n) => n.type === 'footnote' && n.attrs.note === 'The note.'));
  assert.match(para.at(-1).text, /Same paragraph\.$/, 'lines run on in one paragraph');
  assert.equal(doc.content[2].content[0].content[1].type, 'bulletList', 'nested list');
  assert.equal(doc.content[3].attrs.start, 3);
  assert.deepEqual(doc.content[4].content.map((i) => i.attrs.checked), [true, false]);
  assert.equal(doc.content[6].attrs.language, 'py');
  assert.equal(doc.content[7].content[0].content[0].type, 'tableHeader');
  assert.ok(!JSON.stringify(doc.content[9]).includes('javascript'), 'unsafe links are dropped, text kept');
});

test('round trip keeps the text and structure', () => {
  const md = '## A\n\nSome **b** and *i*.\n\n- x\n- y\n\n1. one\n2. two\n\n> q\n';
  assert.equal(markdownFromDoc(docFromMarkdown(md)), md);
  assert.deepEqual(inlineFromMarkdown('a\\*b'), [t('a*b')]);
  assert.deepEqual(docFromMarkdown(''), { type: 'doc', content: [{ type: 'paragraph' }] });
});

test('a person mentioned in a document is written as @Name', () => {
  assert.equal(markdownFromDoc({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Ask ' }, { type: 'mention', attrs: { id: 'u1', name: 'Kim Park' } }] }] }), 'Ask @Kim Park\n');
});

test('equations: $…$ both ways; money and escaped dollars stay text', () => {
  const doc = { type: 'doc', content: [p(t('Area '), { type: 'math', attrs: { latex: '\\pi r^2' } }, t(' costs $5 to $10, and $x stays text.'))] };
  const md = markdownFromDoc(doc).trim();
  assert.equal(md, 'Area $\\pi r^2$ costs $5 to $10, and \\$x stays text.');
  const back = docFromMarkdown(md).content[0].content;
  assert.deepEqual(back.map((n) => n.type), ['text', 'math', 'text']);
  assert.equal(back[1].attrs.latex, '\\pi r^2');
  assert.equal(back[2].text, ' costs $5 to $10, and $x stays text.');
  assert.deepEqual(inlineFromMarkdown('$E = mc^2$ and $ not $ and $3$4').map((n) => n.type === 'math' ? `[${n.attrs.latex}]` : n.text), ['[E = mc^2]', ' and $ not $ and $3$4']);
});
