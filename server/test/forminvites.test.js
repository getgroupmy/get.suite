import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inviteStatus } from '../src/routes/forms.js';

test('form invitations: who has answered, by account or by the email they gave; those waiting first', () => {
  const invites = [{ email: 'kim@acme.com', sent_at: 1 }, { email: 'pat@example.org', sent_at: 1, reminded_at: 5 }, { email: 'lee@acme.com', sent_at: 2 }];
  const responses = [{ user_email: 'kim@acme.com', email: null }, { user_email: null, email: 'Pat@Example.org' }];
  assert.deepEqual(inviteStatus({}, invites, responses).map((i) => [i.email, i.answered, i.reminded_at]), [['lee@acme.com', false, null], ['kim@acme.com', true, null], ['pat@example.org', true, 5]]);
});

