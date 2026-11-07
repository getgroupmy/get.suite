// Formatting in chat messages, written the way people type it: *bold*, _italic_, ~strike~,
// `code`, ```code blocks``` and "> " quotes. Messages stay plain text; this only says how to show
// them, as a tree the app renders (never HTML), so nothing typed can become markup.

const MARKS = { '*': 'b', _: 'i', '~': 's' };
const URL_RE = /https?:\/\/[^\s<>"]+/y;
const EMAIL_RE = /@?[\w.+-]+@[\w.-]+\.[a-z]{2,}/iy;
const edge = (ch) => ch === undefined || /[\s.,;:!?()[\]{}"'/-]/.test(ch);

/** Inline pieces: [{ t: 'text', v }, { t: 'code', v }, { t: 'b' | 'i' | 's', c: [...] }]. */
export function inline(text) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  for (let i = 0; i < text.length;) {
    // Web addresses and email addresses are kept whole (their _ and ~ aren't formatting).
    for (const re of [URL_RE, EMAIL_RE]) {
      re.lastIndex = i;
      const m = (i === 0 || edge(text[i - 1]) || text[i - 1] === '@') && re.exec(text);
      if (m) { buf += m[0]; i += m[0].length; break; }
    }
    if (i >= text.length) break;
    const ch = text[i];
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) { flush(); out.push({ t: 'code', v: text.slice(i + 1, end) }); i = end + 1; continue; }
    }
    if (MARKS[ch] && edge(text[i - 1]) && text[i + 1] && !/\s/.test(text[i + 1]) && text[i + 1] !== ch) {
      // The closing mark: not after a space, and followed by an edge.
      let end = -1;
      for (let j = i + 2; j < text.length; j++) if (text[j] === ch && !/\s/.test(text[j - 1]) && edge(text[j + 1])) { end = j; break; }
      if (end > 0) { flush(); out.push({ t: MARKS[ch], c: inline(text.slice(i + 1, end)) }); i = end + 1; continue; }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** Blocks: [{ t: 'code', v }, { t: 'quote', lines: [inline...] }, { t: 'line', c: inline }]. */
export function blocks(text) {
  const out = [];
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      // A code block runs to the next ``` (or the end); text on the opening line after ``` is code too.
      const first = line.trimStart().slice(3);
      const code = first.includes('```') ? [first.slice(0, first.indexOf('```'))] : [first];
      let j = i + (first.includes('```') ? 0 : 1);
      if (!first.includes('```')) {
        for (; j < lines.length; j++) {
          const k = lines[j].indexOf('```');
          if (k >= 0) { code.push(lines[j].slice(0, k)); break; }
          code.push(lines[j]);
        }
      }
      out.push({ t: 'code', v: code.join('\n').replace(/^\n+|\n+$/g, '') });
      i = Math.min(j, lines.length - 1);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q = out[out.length - 1]?.t === 'quote' ? out[out.length - 1] : (out.push({ t: 'quote', lines: [] }), out[out.length - 1]);
      q.lines.push(inline(line.replace(/^>\s?/, '')));
      continue;
    }
    out.push({ t: 'line', c: inline(line) });
  }
  return out;
}

/** True when a message has any formatting worth drawing (plain messages render as before). */
export const hasMarkup = (text) => /[*_~`]|^>/m.test(String(text ?? ''));
