import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradOf, gradValue, gradCss } from './slidegrad.js';

test('a slide gradient is a colour and an angle', () => {
  assert.deepEqual(gradOf('#0B57D0 180'), { to: '#0b57d0', angle: 180 });
  assert.equal(gradOf('blue 90'), null);
  assert.equal(gradOf('#0b57d0 400'), null);
  assert.equal(gradOf(undefined), null);
  assert.equal(gradValue('#0B57D0', 450), '#0b57d0 90');
  assert.equal(gradValue('#0b57d0'), '#0b57d0 180');
});

test('drawn from the slide colour into the gradient colour', () => {
  assert.equal(gradCss('#ffffff', '#0b57d0 135'), 'linear-gradient(135deg, #ffffff, #0b57d0)');
  assert.equal(gradCss('#ffffff', null), '#ffffff', 'none: just the colour');
});
