// Your own replacements (a short form and what it becomes: "addr" → your address), set in Docs → Preferences,
// applied in plain text boxes too (Chat): the word is replaced when a space or punctuation follows it.

/** Your replacement for a word (exactly as typed), or null. */
export const replacementFor = (word, subs) => (subs || []).find((s) => s.from === word)?.to ?? null;

/**
 * After a character was typed at `caret` (just before it) in `value`: when it's a space or punctuation and the
 * word before it is one of yours, { value, caret } with it replaced; otherwise null.
 */
export function replaceTyped(value, caret, subs) {
  if (!subs?.length || caret < 2) return null;
  const typed = value[caret - 1];
  if (!/[ \t.,;:!?]/.test(typed)) return null;
  const m = /(?:^|\s)(\S+)$/.exec(value.slice(0, caret - 1));
  if (!m) return null;
  const to = replacementFor(m[1], subs);
  if (to === null) return null;
  const start = caret - 1 - m[1].length;
  return { value: value.slice(0, start) + to + value.slice(caret - 1), caret: start + to.length + 1 };
}

/** In a text box's change event: when a space or punctuation was just typed after one of your words, replace it there. */
export function replaceInBox(e, subs) {
  if (e.nativeEvent?.inputType !== 'insertText') return;
  const t = e.target;
  const r = replaceTyped(t.value, t.selectionStart, subs);
  if (!r) return;
  t.value = r.value;
  t.setSelectionRange(r.caret, r.caret);
}
