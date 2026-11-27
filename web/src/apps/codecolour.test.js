import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageOf, colourLines } from './codecolour.js';

const kinds = (name, text) => colourLines(text.split('\n'), languageOf(name)).map((l) => l.filter((p) => p.k).map((p) => `${p.k}:${p.text}`));

test('Python: keywords, strings, numbers, a comment; # inside a string is not a comment', () => {
  assert.deepEqual(kinds('a.py', 'def total(xs):  # sum them\n    return "a # b" + 42'), [['keyword:def', 'comment:# sum them'], ['keyword:return', 'string:"a # b"', 'number:42']]);
});

test('JavaScript: a block comment carried over lines, a template string, an escaped quote', () => {
  assert.deepEqual(kinds('a.js', "/* one\ntwo */ const s = 'it\\'s';\nlet t = `a\nb`;"),
    [['comment:/* one'], ['comment:two */', 'keyword:const', "string:'it\\'s'"], ['keyword:let', 'string:`a'], ['string:b`']]);
});

test('YAML keys and JSON keys are told from values', () => {
  assert.deepEqual(kinds('d.yaml', 'name: shop\n  - port: 80 # web'), [['key:name'], ['key:port', 'number:80', 'comment:# web']]);
  assert.deepEqual(kinds('p.json', '{"chair": 40, "note": "ok"}'), [['key:"chair"', 'number:40', 'key:"note"', 'string:"ok"']]);
});

test('SQL keywords ignore case; -- is a comment; a Dockerfile and plain text', () => {
  assert.deepEqual(kinds('q.sql', 'SELECT name FROM orders -- all'), [['keyword:SELECT', 'keyword:FROM', 'comment:-- all']]);
  assert.deepEqual(kinds('Dockerfile', '# base\nFROM node:22'), [['comment:# base'], ['number:22']]);
  assert.equal(languageOf('notes.txt'), null);
  assert.deepEqual(colourLines(['plain'], null), [[{ text: 'plain', k: '' }]]);
});

test('every line keeps all its text', () => {
  const src = 'x = "a" # c\n\n  y: [1, 2]';
  const lines = src.split('\n');
  assert.deepEqual(colourLines(lines, languageOf('a.py')).map((l) => l.map((p) => p.text).join('')), lines);
});
