import { TextSelection } from '@tiptap/pm/state';

// Docs → Table → Sort A to Z / Z to A: the table's rows ordered by the column the cursor is in, the heading row staying
// first. Numbers (also with a currency sign, thousands separators or %) by value, text in the reader's alphabetical order
// (2 before 10), and empty cells last either way.

/** A cell's text as a number, or null: "1,200", "$3.50", "-4", "12%" (12), "€ 5". */
export function numberOf(text) {
  const m = /^\s*([-−]?)\s*(?:[$€£¥₹]|RM|S\$)?\s*([-−]?)\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)\s*%?\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const v = Number(m[3].replaceAll(',', ''));
  return m[1] || m[2] ? -v : v;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** The order (indexes into keys) that sorts them; desc for Z to A. Stable: equal keys keep their order. */
export function sortOrder(keys, desc = false) {
  const items = keys.map((k, i) => ({ i, text: String(k ?? '').trim(), n: numberOf(k) }));
  const cmp = (a, b) => {
    if (!a.text || !b.text) return (!a.text) - (!b.text); // (empty last, both ways)
    let c;
    if (a.n !== null && b.n !== null) c = a.n - b.n;
    else if (a.n !== null) c = -1; // (numbers before words)
    else if (b.n !== null) c = 1;
    else c = collator.compare(a.text, b.text);
    return desc ? -c : c;
  };
  return items.sort((a, b) => cmp(a, b) || a.i - b.i).map((x) => x.i);
}

/**
 * Sort the table the cursor is in by the cursor's column (one undo step, live for everyone editing). The rows keep their
 * cells' formatting; a heading row (all heading cells) stays first. Returns why it can't (merged cells), or null.
 */
export function sortTableAtCursor(editor, desc = false) {
  const { state } = editor;
  const $from = state.selection.$from;
  let d = $from.depth;
  while (d > 0 && $from.node(d).type.name !== 'table') d--;
  if (!d) return 'Put the cursor in a table first';
  const table = $from.node(d);
  const pos = $from.before(d);
  const col = $from.index(d + 1); // the cell's place in its row
  const rows = [];
  let merged = false;
  table.forEach((row) => { rows.push(row); row.forEach((cell) => { if ((cell.attrs.colspan || 1) > 1 || (cell.attrs.rowspan || 1) > 1) merged = true; }); });
  if (merged) return 'A table with merged cells can’t be sorted: unmerge them first';
  const head = rows.length && rows[0].childCount && [...Array(rows[0].childCount).keys()].every((i) => rows[0].child(i).type.name === 'tableHeader') ? 1 : 0;
  const body = rows.slice(head);
  const keys = body.map((r) => (col < r.childCount ? r.child(col).textContent : ''));
  const order = sortOrder(keys, desc);
  const sorted = table.type.create(table.attrs, [...rows.slice(0, head), ...order.map((i) => body[i])], table.marks);
  const tr = state.tr.replaceWith(pos, pos + table.nodeSize, sorted);
  // The cursor stays in its cell, wherever its row went (so sorting again works on the same column).
  const r0 = $from.index(d);
  const r1 = r0 < head ? r0 : head + order.indexOf(r0 - head);
  let at = pos + 1;
  for (let r = 0; r < r1; r++) at += sorted.child(r).nodeSize;
  at += 1; // into the row
  for (let c = 0; c < col; c++) at += sorted.child(r1).child(c).nodeSize;
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));
  editor.view.dispatch(tr.scrollIntoView());
  return null;
}
