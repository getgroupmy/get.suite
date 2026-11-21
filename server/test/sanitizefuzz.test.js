/* global window, document, DOMParser -- (inside the browser) */
// Signatures and quoted emails against a real browser: random HTML built from the pieces of known
// script-injection tricks (event attributes, javascript: links, <svg>, <noscript>, <template>, unclosed
// comments, entities, mismatched tags) goes through the cleaning that signatures (shown in everyone's
// pages) and replies/forwards get, and Chromium reads the result. Every element and attribute it finds
// must be one the cleaning writes, with safe links and styles, and nothing may run when it's put in a page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { forwardHtml, signatureHtml } from '../src/mail/forwardhtml.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* no browser here */ }

let seed = Number(process.env.SEED) || 20261121;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const TAGS = ['p', 'div', 'span', 'a', 'img', 'b', 'i', 'u', 'font', 'table', 'tr', 'td', 'th', 'ul', 'ol', 'li', 'blockquote', 'pre', 'h1', 'br', 'hr', 'center', 'mark',
  'svg', 'math', 'mglyph', 'style', 'script', 'noscript', 'template', 'iframe', 'object', 'xmp', 'textarea', 'title', 'plaintext', 'noembed', 'select', 'option', 'form', 'base', 'meta', 'link', 'details', 'video', 'image', 'foreignObject', 'desc'];
const ATTRS = [() => `onerror="__hit('${'e'}')"`, () => 'onload=__hit()', () => 'onmouseover="__hit()"', () => `href="${pick(['javascript:__hit()', 'JaVaScRiPt:__hit()', ' javascript:__hit()', 'java&#x09;script:__hit()', '&#106;avascript:__hit()', 'data:text/html,<script>__hit()</script>', 'vbscript:x', 'https://example.org/a"onclick="__hit()', 'mailto:x@y.org', 'https://ok.example/'])}"`,
  () => `src="${pick(['x', '/api/files/abc-1/raw', '/api/files/abc-1/raw" onerror="__hit()', 'javascript:__hit()', 'cid:pic', 'data:image/svg+xml,<svg onload=__hit()>'])}"`,
  () => `style="${pick(['color:red', 'background:url(javascript:__hit())', 'color: expression(__hit())', 'font-size:18px;color:#123456', 'background-color: #ffff00', '-moz-binding:url(x)', 'text-align:center', 'margin-left:80px', 'font-family: Georgia; x:expression(1)', 'color:red;background-image:url(https://track.example/p.gif)'])}"`,
  () => `color="${pick(['red', '#ff0000', 'x" onmouseover="__hit()'])}"`, () => `face="${pick(['Georgia', "x' onerror='__hit()"])}"`, () => 'size=4', () => 'colspan=2', () => `alt="${pick(['a"b', '<img src=x onerror=__hit()>', 'fine'])}"`, () => 'align=center', () => 'xmlns="http://www.w3.org/1999/xhtml"', () => 'role=presentation'];
const TEXT = ['hello', 'a < b', '&lt;img src=x onerror=__hit()&gt;', '&amp;', '"quoted"', "it's", '</p>', '<!--', '-->', '<![CDATA[', ']]>', '<!-->', '</style>', '</noscript>', '</title>', '</textarea>', '<img src=x onerror=__hit()>', '<<script>', '&#60;script&#62;', 'Zoë 山田 🙂', '\u0000', '\n', '  ', '<svg/onload=__hit()>', '<a href=javascript:__hit()>x</a>', '{name}', '<p', '<', '>'];
function fragment(depth = 0) {
  let out = '';
  for (let n = 1 + Math.floor(rnd() * 4); n--;) {
    if (depth > 4 || rnd() < 0.35) { out += pick(TEXT); continue; }
    const tag = pick(TAGS);
    const attrs = Array.from({ length: Math.floor(rnd() * 3) }, () => pick(ATTRS)()).join(' ');
    out += `<${rnd() < 0.1 ? tag.toUpperCase() : tag}${attrs ? ` ${attrs}` : ''}${rnd() < 0.05 ? '/' : ''}>${fragment(depth + 1)}${rnd() < 0.8 ? `</${tag}>` : ''}`;
  }
  return out;
}

// What the cleaning writes, and nothing else.
const ALLOWED = { P: ['style', 'data-indent'], STRONG: [], EM: [], U: [], S: [], SPAN: ['style'], A: ['href'], BR: [], IMG: ['src', 'alt', 'data-align'], UL: [], OL: [], LI: [],
  BLOCKQUOTE: [], TABLE: [], TBODY: [], TR: [], TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'] };
const STYLES = ['color', 'background-color', 'font-size', 'font-family', 'text-align', 'margin-left'];

test('cleaned signatures and quoted emails: Chromium finds only safe formatting, and nothing runs', { skip: !chromium && 'no browser' }, async () => {
  const inputs = Array.from({ length: 3000 }, () => fragment());
  const outputs = inputs.flatMap((h) => [signatureHtml(`<p>${h}</p>`), forwardHtml(h, (cid) => `/api/mail/pic/${encodeURIComponent(cid)}`).html]);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><body><div id="x"></div></body>');
    await page.evaluate(() => { window.__hits = []; window.__hit = (w) => window.__hits.push(w || 'ran'); });
    const found = await page.evaluate(([list, allowed, styles]) => {
      const bad = [];
      list.forEach((html, i) => {
        const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html');
        for (const el of doc.body.querySelectorAll('*')) {
          const ok = allowed[el.tagName];
          if (!ok || el.namespaceURI !== 'http://www.w3.org/1999/xhtml') { bad.push([i, `element ${el.tagName}`]); continue; }
          for (const a of el.attributes) {
            if (!ok.includes(a.name)) bad.push([i, `${el.tagName} ${a.name}`]);
            if (a.name === 'href' && !/^(https?:\/\/|mailto:)/i.test(a.value)) bad.push([i, `href ${a.value}`]);
            if (a.name === 'src' && !/^\/api\/(files\/[\w-]+\/raw|mail\/pic\/)/.test(a.value)) bad.push([i, `src ${a.value}`]);
          }
          for (const p of el.style) if (!styles.includes(p)) bad.push([i, `style ${p}`]);
          if (/url\(|expression/i.test(el.getAttribute('style') || '')) bad.push([i, `style ${el.getAttribute('style')}`]);
        }
      });
      // and in a live page, where pictures load (and fail) and links can be followed
      const box = document.getElementById('x');
      for (let k = 0; k < list.length; k += 200) { const d = document.createElement('div'); d.innerHTML = list.slice(k, k + 200).join(''); box.append(d); }
      return bad;
    }, [outputs, ALLOWED, STYLES]);
    await page.waitForTimeout(500);
    for (const a of await page.locator('#x a').all().then((l) => l.slice(0, 50))) await a.dispatchEvent('mouseover');
    const hits = await page.evaluate(() => window.__hits);
    assert.deepEqual(found.slice(0, 5).map(([i, what]) => `${what} in ${JSON.stringify(inputs[i >> 1]).slice(0, 300)} → ${JSON.stringify(outputs[i]).slice(0, 300)}`), []);
    assert.deepEqual(hits, [], 'something ran');
  } finally { await browser.close(); }
});
