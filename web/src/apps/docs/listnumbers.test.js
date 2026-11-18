import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '@tiptap/pm/model';
import { cleanStart, listAt } from './listnumbers.js';

const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, text: {},
  paragraph: { group: 'block', content: 'text*' },
  orderedList: { group: 'block', content: 'listItem+', attrs: { start: { default: 1 } } },
  listItem: { content: 'paragraph block*' },
} });
const p = (t) => schema.node('paragraph', null, t ? [schema.text(t)] : []);
const ol = (start, items, nested) => schema.node('orderedList', { start }, items.map((t, i) => schema.node('listItem', null, [p(t), ...(nested && i === 0 ? [nested] : [])])));

test('a list’s first number is a whole number from 1 to 9999', () => {
  assert.equal(cleanStart('3'), 3);
  assert.equal(cleanStart(0), 1);
  assert.equal(cleanStart('x'), 1);
  assert.equal(cleanStart(2.6), 3);
  assert.equal(cleanStart(123456), 9999);
});

test('the list the cursor is in, and the number carrying on from the one before', () => {
  const doc = schema.node('doc', null, [ol(1, ['One', 'Two', 'Three'], ol(1, ['a', 'b'])), p('Between'), ol(1, ['Again']), p('End')]);
  const at = (text) => { let pos = null; doc.descendants((n, q) => { if (pos === null && n.isText && n.text === text) pos = q; }); return listAt(doc.resolve(pos)); };
  const again = at('Again');
  assert.deepEqual([again.start, again.next], [1, 4], 'after a list of three from 1: 4');
  assert.equal(at('One').next, null, 'nothing before the first');
  assert.equal(at('b').next, null, 'the inner list: none before it at its level');
  assert.equal(at('b').node.childCount, 2, 'the innermost list');
  assert.equal(at('End'), null, 'not in a list');
  const later = schema.node('doc', null, [ol(5, ['x', 'y']), ol(1, ['z'])]);
  let pos = null; later.descendants((n, q) => { if (n.isText && n.text === 'z') pos = q; });
  assert.equal(listAt(later.resolve(pos)).next, 7, 'from 5, two items: 7');
});
