import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabOf, tabQuery, TO_PRIMARY, TO_UPDATES } from '../src/mail/tabs.js';

test('inbox tabs: what makes a message an update', () => {
  assert.equal(tabOf({ from: 'pat@acme.com' }), 'primary');
  assert.equal(tabOf({ 'list-unsubscribe': '<mailto:x@y>' }), 'updates');
  assert.equal(tabOf(new Map([['list-id', 'members.club.example']])), 'updates');
  assert.equal(tabOf({ precedence: ' Bulk ' }), 'updates');
  assert.equal(tabOf({ precedence: 'junk' }), 'primary');
  assert.equal(tabOf({ 'auto-submitted': 'auto-generated; type=receipt' }), 'updates');
  assert.equal(tabOf({ 'auto-submitted': 'no' }), 'primary');
  // An out-of-office answer to you: a person's, though vacation replies say Precedence: bulk.
  assert.equal(tabOf({ precedence: 'bulk', 'auto-submitted': 'auto-replied (vacation)' }), 'primary');
  assert.equal(tabOf({ precedence: 'bulk', 'auto-submitted': 'auto-replied', 'list-id': 'x' }), 'updates', 'a mailing list is still one');
  assert.equal(tabOf({ 'list-id': 'x' }, [TO_PRIMARY]), 'primary', 'moved by hand');
  assert.equal(tabOf({}, new Set([TO_UPDATES.toLowerCase()])), 'updates');
  // The searches: Updates is the bulk headers (not moved to Primary) or moved there; Primary is the rest.
  const u = tabQuery('updates');
  assert.equal(u.or.length, 2);
  assert.deepEqual(u.or[1], { keyword: TO_UPDATES });
  assert.equal(u.or[0].unKeyword, TO_PRIMARY);
  assert.deepEqual(tabQuery('primary'), { not: u });
});
