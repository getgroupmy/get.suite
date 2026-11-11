import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setColorRules, eventColor, ruleColor } from './colorrules.js';

test('events take a rule\'s colour by a word in their title, unless they have their own', () => {
  setColorRules([{ word: '1:1', color: '#8e24aa' }, { word: 'lunch', color: '#0b8043' }, { word: 'team lunch', color: '#d50000' }]);
  assert.equal(eventColor({ title: 'Kim 1:1', color: '#1a73e8' }), '#8e24aa', 'the usual blue counts as none');
  assert.equal(eventColor({ title: 'Kim 1:1' }), '#8e24aa');
  assert.equal(eventColor({ title: 'Kim 1:1', color: '#f4511e' }), '#f4511e', 'its own colour wins');
  assert.equal(eventColor({ title: 'LUNCH with Sam' }), '#0b8043', 'any case');
  assert.equal(eventColor({ title: 'Team  lunch' }), '#0b8043', 'the first rule that matches');
  assert.equal(ruleColor('Lunchtime walk'), null, 'whole words');
  assert.equal(eventColor({ title: 'Board meeting' }), '#1a73e8');
  setColorRules([]);
  assert.equal(eventColor({ title: 'Kim 1:1' }), '#1a73e8');
});
