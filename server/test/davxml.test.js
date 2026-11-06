import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, elements, key, innerXml } from '../src/davxml.js';

test('well-formed WebDAV bodies are read with their namespaces', () => {
  const d = parseXml('<?xml version="1.0" encoding="utf-8"?>\n<propfind xmlns="DAV:"><prop>\n<prop0 xmlns="http://example.com/x/"/>\n<D:getetag xmlns:D="DAV:"/><nons xmlns=""/></prop></propfind>');
  assert.deepEqual(elements(elements(d)[0]).map(key), ['{http://example.com/x/}prop0', '{DAV:}getetag', '{}nons']);
  const v = parseXml('<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:z"><D:set><D:prop><Z:p>a &amp; <Z:b attr="1">c</Z:b></Z:p></D:prop></D:set></D:propertyupdate>');
  const p = elements(elements(elements(v)[0])[0])[0];
  assert.equal(innerXml(p), 'a &amp; <x:b xmlns:x="urn:z" attr="1">c</x:b>', 'values carry their own namespaces');
});

test('ill-formed bodies are refused', () => {
  for (const bad of ['<propfind xmlns="DAV:"><prop></propfind>', '<propfind xmlns="DAV:">', '<D:propfind/>', '<a xmlns:z=""><z:b/></a>', '<a/><b/>', 'text<a/>', '<a>1 < 2</a>']) {
    assert.equal(parseXml(bad), null, bad);
  }
});
