import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstLink, readPreview } from '../src/linkpreview.js';

test('the first web link in a message, trailing punctuation left off; none into this Workspace', () => {
  assert.equal(firstLink('See https://example.com/a?b=1, then reply.'), 'https://example.com/a?b=1');
  assert.equal(firstLink('(http://news.example.org/story)'), 'http://news.example.org/story');
  assert.equal(firstLink('no links here, ftp://x.example too'), null);
  assert.equal(firstLink('https://user:pw@example.com/'), null, 'no credentials');
  assert.equal(firstLink('open https://ws.acme.com/docs/abc please', 'ws.acme.com'), null);
});

test('a page\'s title, description and site name (Open Graph first, entities decoded, no scripts)', () => {
  const html = `<html><head><title>Fallback &amp; title</title>
    <meta property="og:title" content="Q3 results: revenue up 12%">
    <meta name="description" content="Plain description">
    <meta property="og:description" content="Revenue rose &#8212; again &quot;strongly&quot;.">
    <meta property="og:site_name" content="Acme News"><script>alert(1)</script></head><body><title>not this</title></body></html>`;
  assert.deepEqual(readPreview(html, 'https://news.example.com/q3'), { url: 'https://news.example.com/q3', title: 'Q3 results: revenue up 12%', description: 'Revenue rose — again "strongly".', site: 'Acme News' });
  assert.deepEqual(readPreview('<title> Just a <b>title</b> </title>', 'https://www.example.org/x'), { url: 'https://www.example.org/x', title: 'Just a title', description: null, site: 'example.org' });
  assert.equal(readPreview('<html><body>nothing</body></html>', 'https://example.org/'), null);
});
