// Autocorrect while typing (Docs): smart quotes, dashes, ellipsis, arrows, symbols and fractions, plus
// your own replacements (Tools → Preferences). Backspace straight after a change puts back what you typed.
import { Extension, InputRule } from '@tiptap/core';

/** The built-in replacements: [what you type (ends the rule), what it becomes]. */
export const BUILT_IN = [
  ['--', '—'], ['...', '…'], ['->', '→'], ['<-', '←'], ['=>', '⇒'], ['!=', '≠'], ['<=', '≤'], ['>=', '≥'], ['+-', '±'],
  ['(c)', '©'], ['(r)', '®'], ['(tm)', '™'], ['1/2', '½'], ['1/4', '¼'], ['3/4', '¾'],
];

/** A straight quote as a curly one, by what comes before it: an opening quote after a space or bracket. */
export function curly(quote, before) {
  const open = !before || /[\s([{—–-]$/.test(before);
  return quote === '"' ? (open ? '“' : '”') : (open ? '‘' : '’');
}

/** Your own replacement for the word just typed (before a space or punctuation), or null. */
export function substitute(word, subs) {
  return (subs || []).find((s) => s.from === word)?.to ?? null;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The extension: options.enabled() and options.subs() are read each time, so changes apply at once. */
export const Autocorrect = Extension.create({
  name: 'autocorrect',
  addOptions() { return { enabled: () => true, subs: () => [] }; },
  addInputRules() {
    const on = () => this.options.enabled();
    const rules = BUILT_IN.map(([from, to]) => new InputRule({
      // "1/2" only as a fraction on its own, not inside 11/2 or a date
      find: from.includes('/') ? new RegExp(`(?:^|[^\\d/])(${escape(from)})$`) : new RegExp(`${escape(from)}$`),
      handler: ({ state, range, match }) => {
        if (!on()) return null;
        // range covers the whole match, the character just typed included (for fractions, also the one before it)
        const start = range.from + (from.includes('/') ? match[0].length - match[1].length : 0);
        state.tr.insertText(to, start, range.to);
      },
    }));
    rules.push(new InputRule({
      find: /["']$/,
      handler: ({ state, range, match }) => {
        if (!on()) return null;
        const $from = state.doc.resolve(range.from);
        const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset, null, ' ');
        state.tr.insertText(curly(match[0], before), range.from, range.to);
      },
    }));
    // Your own: the word is replaced when a space or punctuation follows it.
    rules.push(new InputRule({
      find: /(?:^|\s)(\S+)([\s.,;:!?])$/,
      handler: ({ state, range, match }) => {
        if (!on()) return null;
        const to = substitute(match[1], this.options.subs());
        if (to === null) return null;
        // range covers the space (or line start) before the word, the word and the mark just typed: only the word changes
        const start = range.from + match[0].length - match[1].length - match[2].length;
        state.tr.insertText(to, start, start + match[1].length);
      },
    }));
    return rules;
  },
});
