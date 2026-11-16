import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeText } from './changetext.js';

test('changes kept offline in words', () => {
  assert.equal(changeText({ method: 'POST', url: '/tasks/lists/abc/tasks', label: 'Buy sun cream' }), 'Add a task: “Buy sun cream”');
  assert.equal(changeText({ method: 'DELETE', url: '/notes/n1', label: 'Ferry times' }), 'Delete a note: “Ferry times”');
  assert.equal(changeText({ method: 'PATCH', url: '/events/e1', label: 'Site visit' }), 'Change an event: “Site visit”');
  assert.equal(changeText({ method: 'POST', url: '/mail/messages/flags', body: { seen: true }, label: 'a message' }), 'Mark mail read: “a message”');
  assert.equal(changeText({ method: 'POST', url: '/mail/messages/flags', body: { flagged: true }, label: '2 messages' }), 'Star mail: “2 messages”');
  assert.equal(changeText({ method: 'POST', url: '/mail/messages/move', body: { to: 'archive' }, label: 'a message' }), 'Archive mail: “a message”');
  assert.equal(changeText({ method: 'POST', url: '/chat/channels/c1/messages', body: { body: 'On my way' }, label: 'trip-plans' }), 'Send a chat message: “On my way”');
  assert.equal(changeText({ method: 'POST', url: '/mail/messages/snooze', body: { until: 1 }, label: 'a message' }), 'Snooze mail: “a message”');
  assert.equal(changeText({ method: 'POST', url: '/mail/messages/labels', body: { add: ['x'] }, label: 'a message' }), 'Label mail: “a message”');
  assert.equal(changeText({ method: 'POST', url: '/files/new', body: { kind: 'doc' }, label: 'Untitled document' }), 'Make a document: “Untitled document”');
  assert.equal(changeText({ method: 'PUT', url: '/something/else' }), 'A change');
});
