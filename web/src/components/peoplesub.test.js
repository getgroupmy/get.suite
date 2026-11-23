import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personSub, personFields, contactSub } from './peoplesub.js';
import { matchesFilter } from '../apps/contacts/contactfilter.js';

test('a colleague\'s line, and what finds them', () => {
  assert.equal(personSub({ username: 'kim@acme.com' }), 'kim@acme.com');
  assert.equal(personSub({ username: 'kim@acme.com', job_title: 'Accountant', department: 'Finance', status: { emoji: '🌴', text: 'On holiday' } }), 'Accountant · Finance · 🌴 On holiday · kim@acme.com');
  const kim = { name: 'Kim Park', username: 'kim@acme.com', job_title: 'Accountant', department: 'Finance' };
  assert.ok(matchesFilter(personFields(kim), 'finance'), 'by department');
  assert.ok(matchesFilter(personFields(kim), 'accountant kim'), 'by title and name together');
  assert.ok(!matchesFilter(personFields(kim), 'marketing'));
});

test('a contact\'s line', () => {
  assert.equal(contactSub({ email: 'bob@initrode.com' }), 'bob@initrode.com');
  assert.equal(contactSub({ email: 'bob@initrode.com', company: 'Initrode' }), 'Initrode · bob@initrode.com');
  assert.equal(contactSub({ email: 'bob@initrode.com', company: 'Initrode', title: 'Buyer' }), 'Buyer at Initrode · bob@initrode.com');
  assert.equal(contactSub({ title: 'Plumber' }), 'Plumber');
});
