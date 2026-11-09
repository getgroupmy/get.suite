import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avatarColor, colorForHue, whiteContrast } from './avatarcolor.js';

test('avatar colours: the same for the same name, and white initials readable on every hue', () => {
  assert.equal(avatarColor('Kim Park'), avatarColor('Kim Park'));
  assert.match(avatarColor('Kim Park'), /^hsl\(\d+ 55% \d+%\)$/);
  for (let h = 0; h < 360; h++) {
    const c = colorForHue(h);
    assert.ok(whiteContrast(c.h, c.s, c.l) >= 4.5, `hue ${h}`);
  }
  assert.ok(whiteContrast(60, 55, 45) < 4.5, 'a yellow at the old lightness was too light');
  assert.ok(colorForHue(60).l < 45, 'so yellows are darker now');
  assert.equal(colorForHue(230).l, 45, 'a blue that was already fine is unchanged');
});
