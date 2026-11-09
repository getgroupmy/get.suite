// Paint format (Docs): copy the formatting where the cursor is (bold, italic, colours, font, size…
// and the paragraph's style: heading level, alignment, spacing, indent) and put it on other text. Links,
// comments and suggestions aren't formatting, so they stay as they are.

export const FORMAT_MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'textStyle', 'highlight', 'subscript', 'superscript'];
const BLOCKS = ['paragraph', 'heading'];
const BLOCK_ATTRS = ['level', 'textAlign', 'lineHeight', 'indent'];

/** The formatting at the start of the selection: { marks: [{ type, attrs }], block: { type, attrs } }. */
export function captureFormat(state) {
  const { $from, empty } = state.selection;
  const marks = (empty ? state.storedMarks || $from.marks() : marksAt(state.doc, $from.pos)) || [];
  const parent = $from.parent;
  const block = BLOCKS.includes(parent.type.name)
    ? { type: parent.type.name, attrs: Object.fromEntries(BLOCK_ATTRS.filter((k) => k in parent.attrs).map((k) => [k, parent.attrs[k]])) }
    : null;
  return { marks: marks.filter((m) => FORMAT_MARKS.includes(m.type.name)).map((m) => ({ type: m.type.name, attrs: { ...m.attrs } })), block };
}

// The marks of the first character from `pos` (the selection's first letter).
function marksAt(doc, pos) {
  const $pos = doc.resolve(pos);
  const after = $pos.nodeAfter;
  return after?.isText ? after.marks : $pos.marks();
}

/** The word around a position (for a click without a selection), or null. */
export function wordAt(doc, pos) {
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const text = parent.textBetween(0, parent.content.size, '￼', '￼');
  const at = $pos.parentOffset;
  const isWord = (ch) => !!ch && /[\p{L}\p{N}_'’-]/u.test(ch);
  let a = at, b = at;
  while (a > 0 && isWord(text[a - 1])) a--;
  while (b < text.length && isWord(text[b])) b++;
  if (a === b) return null;
  const start = $pos.start();
  return { from: start + a, to: start + b };
}

/** A transaction putting `fmt` on from..to: its marks replace the formatting there, and the paragraphs take its style. */
export function applyFormat(state, fmt, from, to) {
  const { schema } = state;
  let tr = state.tr;
  if (from < to) {
    for (const name of FORMAT_MARKS) if (schema.marks[name]) tr = tr.removeMark(from, to, schema.marks[name]);
    for (const m of fmt.marks) if (schema.marks[m.type]) tr = tr.addMark(from, to, schema.marks[m.type].create(m.attrs));
  }
  const type = fmt.block && schema.nodes[fmt.block.type];
  if (type) {
    state.doc.nodesBetween(from, Math.max(from, to), (node, pos) => {
      if (!BLOCKS.includes(node.type.name)) return true;
      const attrs = {};
      for (const [k, spec] of Object.entries(type.attrs)) {
        const dflt = spec.hasDefault ? spec.default : null;
        attrs[k] = BLOCK_ATTRS.includes(k) ? (fmt.block.attrs[k] ?? dflt) : (node.attrs[k] ?? dflt);
      }
      tr = tr.setNodeMarkup(pos, type, attrs);
      return false;
    });
  }
  return tr;
}
