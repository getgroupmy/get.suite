import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardHtml, parseColor } from '../src/mail/forwardhtml.js';

const url = (cid) => (cid === 'logo@x' ? '/pic/0' : cid === 'chart@x' ? '/pic/1' : null);

test('keeps text, basic formatting and embedded pictures in place', () => {
  const { html, pictures } = forwardHtml(`<html><head><title>T</title><style>p{color:red}</style></head><body>
    <div><img src="cid:logo@x" alt="Logo" width="120"></div>
    <p>Hello <b>team</b>, see <i>the</i> <a href="https://example.com/q?a=1&amp;b=2">report</a>.</p>
    <p><img src="cid:chart@x"></p>
    <ul><li>One</li><li>Two <u>items</u></li></ul>
    <blockquote>Quoted<br>line</blockquote>
  </body></html>`, url);
  assert.equal(pictures, 2);
  assert.equal(html, '<img src="/pic/0" alt="Logo">'
    + '<p>Hello <strong>team</strong>, see <em>the</em> <a href="https://example.com/q?a=1&amp;b=2">report</a>.</p>'
    + '<img src="/pic/1" alt="">'
    + '<ul><li><p>One</p></li><li><p>Two <u>items</u></p></li></ul>'
    + '<blockquote><p>Quoted<br>line</p></blockquote>');
});

test('drops anything that could run, track or mislead', () => {
  const { html, pictures } = forwardHtml(`
    <script>alert(1)</script><p onclick="x()" style="background:url(https://t.example/p)">Hi</p>
    <img src="https://tracker.example/pixel.gif"><img src="data:image/png;base64,AAAA"><img src="cid:unknown@x">
    <a href="javascript:alert(1)">bad link</a> <a href="  https://ok.example ">ok</a>
    <form><input value="secret"><button>Go</button></form><iframe src="https://x"></iframe>
    <p>&lt;script&gt; stays text</p>`, url);
  assert.equal(pictures, 0);
  assert.doesNotMatch(html, /script>|onclick|style=|tracker|data:|javascript:|secret|iframe|<input|<form/i);
  assert.match(html, /bad link/);
  assert.match(html, /<a href="https:\/\/ok\.example">ok<\/a>/);
  assert.match(html, /&lt;script&gt; stays text/);
});

test('headings and preformatted text become readable paragraphs', () => {
  const { html } = forwardHtml(`<h2>Invoice</h2><table><tr><td>Item</td><td>Price</td></tr><tr><td>Desk</td><td>€200</td></tr></table>
    <pre>line 1
line 2</pre>`, url);
  assert.match(html, /<p><strong>Invoice<\/strong><\/p>/);
  assert.match(html, /<table><tbody><tr><td><p>Item<\/p><\/td><td><p>Price<\/p><\/td><\/tr>/, 'a two-column table stays a table');
  assert.match(html, /<p>line 1<br>line 2<\/p>/);
});

test('data tables are kept, with header cells and spans; layout tables are flattened', () => {
  const { html } = forwardHtml(`<p>Your order:</p>
    <table border="1" style="width:600px" onclick="x()"><thead><tr><th>Item</th><th>Qty</th><th>Price</th></tr></thead>
    <tbody><tr><td>Desk</td><td>1</td><td><b>€200</b></td></tr><tr><td colspan="2">Total</td><td>€200</td></tr></tbody></table>`, url);
  assert.equal(html, '<p>Your order:</p><table><tbody>'
    + '<tr><th><p>Item</p></th><th><p>Qty</p></th><th><p>Price</p></th></tr>'
    + '<tr><td><p>Desk</p></td><td><p>1</p></td><td><p><strong>€200</strong></p></td></tr>'
    + '<tr><td colspan="2"><p>Total</p></td><td><p>€200</p></td></tr></tbody></table>');

  // A newsletter: an outer layout table holding a one-column table and a table with a picture.
  const news = forwardHtml(`<table role="presentation"><tr><td>
      <table><tr><td>Big news</td></tr><tr><td>We moved.</td></tr></table>
      <table><tr><td><img src="cid:logo@x"></td><td>Visit us</td></tr></table>
    </td></tr></table>`, url).html;
  assert.equal(news.match(/<table>/g)?.length, 1, 'only the two-column table is kept');
  assert.match(news, /<p>Big news<\/p><p>We moved\.<\/p>/);
  assert.match(news, /<table><tbody><tr><td><img src="\/pic\/0" alt=""><\/td><td><p>Visit us<\/p><\/td><\/tr><\/tbody><\/table>/);
  assert.doesNotMatch(news, /role=|onclick|style=/);
});

test('colour values: only plain colours are understood', () => {
  assert.equal(parseColor('#C00'), 'cc0000');
  assert.equal(parseColor('#1a73e8'), '1a73e8');
  assert.equal(parseColor('#1a73e880'), '1a73e8');
  assert.equal(parseColor('rgb(26, 115, 232)'), '1a73e8');
  assert.equal(parseColor('rgba(100%,0%,0%,.5)'), 'ff0000');
  assert.equal(parseColor('rgb(255 0 0 / 50%)'), 'ff0000');
  assert.equal(parseColor('DarkRed !important'), '8b0000');
  for (const bad of ['var(--x)', 'url(https://t.example/x)', 'expression(alert(1))', 'red; background:url(x)', '#12', 'hsl(0 100% 50%)', '']) {
    assert.equal(parseColor(bad), null, bad);
  }
});

test('text colours are kept, inherited, and overridden; unreadable ones dropped', () => {
  const { html } = forwardHtml(`
    <p>Status: <span style="font-weight:bold; color: #C00">late</span> and <font color="green">fine</font>.</p>
    <div style="color:rgb(26,115,232)">Blue <b>bold</b> <span style="color:#000">back to normal</span></div>
    <p style="background-color:#000; color:#fff">white on black</p>
    <p><span style="color:var(--brand)">variable</span> <span style="color: red; background: url(https://t.example/p)">red</span></p>
    <ul style="color:purple"><li>purple item</li></ul>
    <table style="color:teal"><tr><td>teal</td><td style="color:orange">orange</td></tr></table>`, url);
  assert.match(html, /<p>Status: <span style="color: #cc0000">late<\/span> and <span style="color: #008000">fine<\/span>\.<\/p>/);
  assert.match(html, /<p><span style="color: #1a73e8">Blue <\/span><strong><span style="color: #1a73e8">bold<\/span><\/strong><span style="color: #1a73e8"> <\/span>back to normal<\/p>/);
  assert.match(html, /<p>white on black<\/p>/, 'near-white text would be invisible: shown in the normal colour');
  assert.match(html, /<p>variable <span style="color: #ff0000">red<\/span><\/p>/);
  assert.match(html, /<li><p><span style="color: #800080">purple item<\/span><\/p><\/li>/);
  assert.match(html, /<td><p><span style="color: #008080">teal<\/span><\/p><\/td><td><p><span style="color: #ffa500">orange<\/span><\/p><\/td>/);
  assert.doesNotMatch(html, /url\(|var\(|background/);
});
