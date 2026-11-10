import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originalSummary, headerFields } from '../src/mail/original.js';

const raw = [
  'Return-Path: <bob@sender.example>',
  'Received: from mail.acme.com (localhost [127.0.0.1])',
  '\tby mail.acme.com (Postfix) with ESMTP id 4F2;',
  '\tTue, 10 Nov 2026 09:00:07 +0000 (UTC)',
  'Received: from out.sender.example (out.sender.example [203.0.113.5])',
  '\tby mx.acme.com (Postfix) with ESMTPS id 1A;',
  '\tTue, 10 Nov 2026 09:00:05 +0000',
  'Authentication-Results: mail.acme.com; dkim=pass header.d=sender.example;',
  '\tspf=softfail smtp.mailfrom=bob@sender.example; dmarc=fail (p=quarantine)',
  'Authentication-Results: other.example; spf=pass',
  'Message-ID: <abc.123@sender.example>',
  'Date: Tue, 10 Nov 2026 08:59:58 +0000',
  'From: Bob <bob@sender.example>',
  'To: kim@acme.com',
  'Subject: =?UTF-8?Q?Invoice?=',
  '',
  'Body: not a header',
].join('\r\n');

test('show original: checks, hops with delays, ids; the body left out', () => {
  const s = originalSummary(Buffer.from(raw));
  assert.deepEqual([s.spf, s.dkim, s.dmarc], ['softfail', 'pass', 'fail'], 'the nearest server\'s results');
  assert.equal(s.messageId, '<abc.123@sender.example>');
  assert.equal(s.date, Date.UTC(2026, 10, 10, 8, 59, 58));
  assert.equal(s.from, 'Bob <bob@sender.example>');
  assert.deepEqual(s.hops.map((h) => [h.from, h.by, h.delay]), [['out.sender.example', 'mx.acme.com', null], ['mail.acme.com', 'mail.acme.com', 2000]]);
  assert.equal(s.hops[0].at, Date.UTC(2026, 10, 10, 9, 0, 5));
  assert.doesNotMatch(s.headers, /Body: not a header/);
  assert.match(s.headers, /^Return-Path:/);
});

test('show original: no checks recorded, Received-SPF instead, folded lines joined', () => {
  const s = originalSummary('Received-SPF: Pass (sender SPF authorized)\nSubject: Hi\n there\n\nx');
  assert.deepEqual([s.spf, s.dkim, s.dmarc, s.hops.length], ['pass', null, null, 0]);
  assert.equal(headerFields('Subject: Hi\n there\n\n').fields[0][1], 'Hi there');
});
