import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLinks, siteOf, shownSite } from '../src/mail/linkcheck.js';

test('siteOf: the registered part of a host name', () => {
  assert.equal(siteOf('mail.google.com'), 'google.com');
  assert.equal(siteOf('shop.example.co.uk'), 'example.co.uk');
  assert.equal(siteOf('example.com'), 'example.com');
  assert.equal(siteOf('a.b.example.com.'), 'example.com');
});

test('shownSite: only link text that is itself a web address', () => {
  assert.equal(shownSite('www.paypal.com'), 'www.paypal.com');
  assert.equal(shownSite('<b>https://Www.PayPal.com/signin?x=1</b>'), 'www.paypal.com');
  assert.equal(shownSite('apple.com.'), 'apple.com');
  assert.equal(shownSite('Click here'), null);
  assert.equal(shownSite('see example.com now'), null);
  assert.equal(shownSite('kim@example.com'), null);
  assert.equal(shownSite('1.5'), null);
  assert.equal(shownSite('www&#46;bank&#46;com'), 'www.bank.com');
});

test('checkLinks marks links that go somewhere other than they say, and only those', () => {
  const { html, links } = checkLinks(`
    <a href="https://evil.example/login">www.mybank.com</a>
    <a href="https://www.mybank.com/x">mybank.com</a>
    <a href='https://login.bbc.co.uk/'>https://www.bbc.co.uk/news</a>
    <a href="https://x.example">Click here</a>
    <a href="mailto:a@b.com">b.com</a>
    <a href="https://xn--pple-43d.com/">apple.com</a>
    <a href="https://evil.example/2">www.mybank.com</a>`);
  assert.deepEqual(links, [{ shown: 'www.mybank.com', real: 'evil.example' }, { shown: 'apple.com', real: 'xn--pple-43d.com' }]);
  assert.equal((html.match(/data-nw-real=/g) || []).length, 3);
  assert.match(html, /<a data-nw-real="evil.example" data-nw-shown="www.mybank.com" href="https:\/\/evil.example\/login">www.mybank.com<\/a>/);
  assert.match(html, /<a href="https:\/\/www.mybank.com\/x">/);
});

test('checkLinks keeps odd HTML as it was', () => {
  assert.deepEqual(checkLinks('<a>no href</a><a href="not a url">x.com</a>'), { html: '<a>no href</a><a href="not a url">x.com</a>', links: [] });
  assert.equal(checkLinks('').html, '');
});

test('checkLinks with likeOf: links to a site made to look like one you know are marked too (once per site in the list)', () => {
  const likeOf = (host) => (/acme-login\.com$|^acme\.com\.verify/.test(host) ? { domain: 'acme.com', kind: 'company' } : null);
  const { html, links } = checkLinks('<a href="https://acme-login.com/signin">Sign in</a> <a href="https://www.acme-login.com/x">again</a> <a href="https://acme.com.verify-account.example/">Verify</a> <a href="https://shop.example/">Shop</a>', { likeOf });
  assert.deepEqual(links, [{ real: 'acme-login.com', like: 'acme.com' }, { real: 'acme.com.verify-account.example', like: 'acme.com' }]);
  assert.equal((html.match(/data-nw-like="acme.com"/g) || []).length, 3);
  assert.match(html, /<a href="https:\/\/shop.example\/">Shop<\/a>/);
});
