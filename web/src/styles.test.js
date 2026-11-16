// A class defined twice at the top level of styles.css with the same properties: the later rule silently
// restyles everything using the class, on every screen. That's how Drive's "new comments" pill shrank
// commented words in Docs, and the room-usage bar squeezed the Admin storage bar. New screens should use a
// class of their own, or scope the rule (.data-table .usage-bar).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Duplicates checked and harmless (the same look, or the later rule only adds to it).
const KNOWN = new Set(['.chat-main', '.ok', '.swatch', '.rule-list', '.qa-x', '.collaboration-carets__label', '.scheduled-list', '.bell-body', '.note-card', '.tl-name']);

test('no class is styled twice at the top level of styles.css (one screen’s look leaking into another)', () => {
  const css = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const seen = new Map();
  let depth = 0, start = 0, sel = '', body = 0;
  const clashes = [];
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') { if (depth === 0) { sel = css.slice(start, i).trim(); body = i + 1; } depth++; }
    else if (css[i] === '}') {
      depth--;
      if (depth !== 0) continue;
      start = i + 1;
      if (sel.startsWith('@')) continue;
      const props = new Set(css.slice(body, i).split(';').map((p) => p.split(':')[0].trim()).filter(Boolean));
      for (const one of sel.split(',').map((s) => s.trim())) {
        if (!/^\.[\w-]+$/.test(one)) continue;
        const before = seen.get(one);
        if (before && !KNOWN.has(one) && [...props].some((p) => before.has(p))) clashes.push(one);
        seen.set(one, new Set([...(before || []), ...props]));
      }
    }
  }
  assert.deepEqual(clashes, []);
});
