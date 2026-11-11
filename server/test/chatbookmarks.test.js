import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-chatbm-')); // a database of its own
const { cleanBookmark } = await import('../src/chatbookmarks.js');

test('a bookmark: a web address or a page in Workspace, with a title (or one from the link)', () => {
  assert.deepEqual(cleanBookmark({ title: '  Q3   plan ', url: ' /docs/abc ' }), { title: 'Q3 plan', url: '/docs/abc' });
  assert.deepEqual(cleanBookmark({ url: 'https://www.example.com/handbook/' }), { title: 'example.com/handbook', url: 'https://www.example.com/handbook/' });
  assert.match(cleanBookmark({ url: 'javascript:alert(1)' }).error, /https:\/\//);
  assert.match(cleanBookmark({ url: '//evil.example' }).error, /https:\/\//, 'not a link to another site by the back door');
  assert.match(cleanBookmark({ url: '' }).error, /Add a link/);
  assert.equal(cleanBookmark({ title: 'x'.repeat(200), url: '/drive' }).title.length, 80);
});
