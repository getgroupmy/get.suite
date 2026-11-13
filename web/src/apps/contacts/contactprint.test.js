import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactsPrintHtml } from './contactprint.js';

test('an address list: each person with their addresses, numbers, company, title and address, made safe', () => {
  const html = contactsPrintHtml([
    { name: 'Ada <Lovelace>', email: 'ada@example.com', more_emails: [{ value: 'ada@home.example' }], phone: '+44 1', company: 'Analytical & Co', title: 'Engineer', address: '1 Main St\nLondon' },
    { name: 'Bo', email: null, phone: null },
  ], { title: 'My contacts', date: new Date(Date.UTC(2026, 10, 13)) });
  assert.match(html, /<title>My contacts<\/title>/);
  assert.match(html, /2 people/);
  assert.match(html, /Ada &lt;Lovelace&gt;/);
  assert.doesNotMatch(html, /<Lovelace>/);
  assert.match(html, /ada@example\.com<br>ada@home\.example/);
  assert.match(html, /Analytical &amp; Co<div class="sub">1 Main St<br>London<\/div>/);
  assert.match(html, /<div class="sub">Engineer<\/div>/);
  assert.match(contactsPrintHtml([{ name: 'X' }]), /1 person/);
});
