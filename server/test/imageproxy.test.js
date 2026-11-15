import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { proxyImages, fetchImage, checkImageSig, signImage } from '../src/mail/imageproxy.js';

const urlsIn = (html) => [...html.matchAll(/\/api\/mail\/image\?u=([^&"]+)&amp;s=/g)].map((m) => decodeURIComponent(m[1]));

test('pictures from the internet are rewritten; links, data: and cid: pictures are not', () => {
  const { html, count } = proxyImages(`<p><a href="https://shop.example.com/sale"><img src="https://img.example.com/a.png?x=1&amp;y=2" alt="A"></a>
    <img src='http://track.example.com/open.gif'> <img src="cid:logo@x"> <img src="data:image/png;base64,AAAA">
    <table background="https://img.example.com/bg.jpg"><tr><td style="background-image: url('https://img.example.com/td.png')">x</td></tr></table>
    <img srcset="https://img.example.com/s1.png 1x, https://img.example.com/s2.png 2x">
    <style>.h{background:url(//img.example.com/css.png)}</style><svg><image href="https://img.example.com/svg.png"/></svg></p>`, 'user1');
  assert.equal(count, 8);
  assert.deepEqual(urlsIn(html).sort(), ['http://track.example.com/open.gif', 'https://img.example.com/a.png?x=1&y=2', 'https://img.example.com/bg.jpg', 'https://img.example.com/css.png',
    'https://img.example.com/s1.png', 'https://img.example.com/s2.png', 'https://img.example.com/svg.png', 'https://img.example.com/td.png']);
  assert.match(html, /<a href="https:\/\/shop\.example\.com\/sale">/, 'links untouched');
  assert.match(html, /src="cid:logo@x"/);
  assert.match(html, /src="data:image\/png;base64,AAAA"/);
  assert.doesNotMatch(html, /src=["']https?:/, 'no picture left pointing outside');
});

test('the links are signed for one person', () => {
  const s = signImage('u1', 'https://a.example/x.png');
  assert.equal(checkImageSig('u1', 'https://a.example/x.png', s), true);
  assert.equal(checkImageSig('u2', 'https://a.example/x.png', s), false);
  assert.equal(checkImageSig('u1', 'https://a.example/y.png', s), false);
  assert.equal(checkImageSig('u1', 'https://a.example/x.png', 'nope'), false);
});

let server, port;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/pic.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47])); }
    if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<p>hi</p>'); }
    if (req.url === '/hop') { res.writeHead(302, { location: '/pic.png' }); return res.end(); }
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.alloc(11 * 1024 * 1024)); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => server.close());

test('only public addresses: this machine and the local network are refused', async () => {
  delete process.env.MAIL_IMAGE_ALLOW_PRIVATE;
  process.env.MAIL_IMAGE_ALLOW_PORTS = String(port);
  await assert.rejects(fetchImage(`http://127.0.0.1:${port}/pic.png`), (e) => e.status === 403);
  await assert.rejects(fetchImage(`http://localhost:${port}/pic.png`), (e) => e.status === 403);
  await assert.rejects(fetchImage('http://10.0.0.1/pic.png'), (e) => e.status === 403);
  await assert.rejects(fetchImage('ftp://example.com/x.png'), (e) => e.status === 400);
  await assert.rejects(fetchImage('http://user:pw@example.com/x.png'), (e) => e.status === 400);
  await assert.rejects(fetchImage('http://example.com:8080/x.png'), (e) => e.status === 400, 'unusual ports');
});

test('pictures only, with redirects followed (a few), and a size limit', async () => {
  process.env.MAIL_IMAGE_ALLOW_PRIVATE = '1'; // this test's own server
  process.env.MAIL_IMAGE_ALLOW_PORTS = String(port);
  const b = `http://127.0.0.1:${port}`;
  const got = await fetchImage(`${b}/pic.png`);
  assert.equal(got.type, 'image/png');
  assert.equal(got.body.length, 4);
  assert.equal((await fetchImage(`${b}/hop`)).type, 'image/png');
  await assert.rejects(fetchImage(`${b}/page`), (e) => e.status === 415);
  await assert.rejects(fetchImage(`${b}/loop`), (e) => e.status === 502 && /redirects/.test(e.message));
  await assert.rejects(fetchImage(`${b}/big`), (e) => e.status === 413);
  await assert.rejects(fetchImage(`${b}/missing`), (e) => e.status === 502);
  delete process.env.MAIL_IMAGE_ALLOW_PRIVATE;
  delete process.env.MAIL_IMAGE_ALLOW_PORTS;
});
