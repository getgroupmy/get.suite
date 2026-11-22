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

/** How a cell writes its number: { prefix, suffix, dp, commas }, from "$1,200.00", "12%", "€ 5", "350". */
function styleOf(text) {
  const t = String(text ?? '').trim();
  const m = /^([-−]?\s*(?:[$€£¥₹]|RM|S\$)?\s*[-−]?)\s*([\d,]*\d(?:\.(\d+))?)\s*(%?)$/.exec(t);
  if (!m) return null;
  return { prefix: m[1].replace(/[-−]/g, '').trim(), suffix: m[4], dp: (m[3] || '').length, commas: m[2].includes(',') };
}

/**
 * A totals row for rows of cell texts (the heading row left out when `head`): each column with numbers in it added up,
 * written the way its numbers are ($, %, thousands separators, the most decimals used); "Total" in the first column when
 * it has no numbers. null when no column has numbers.
 */
export function totalsRow(rows, head = false) {
  const body = rows.slice(head ? 1 : 0);
  const width = Math.max(0, ...rows.map((r) => r.length));
  const out = [];
  let any = false;
  for (let c = 0; c < width; c++) {
    const cells = body.map((r) => r[c]).filter((t) => numberOf(t) !== null);
    if (!cells.length) { out.push(''); continue; }
    any = true;
    const styles = cells.map(styleOf).filter(Boolean);
    const dp = Math.max(0, ...styles.map((s) => s.dp));
    const sum = cells.reduce((a, t) => a + numberOf(t), 0);
    const s0 = styles[0] || { prefix: '', suffix: '', commas: false };
    const abs = Math.abs(sum).toFixed(dp);
    const [int, frac] = abs.split('.');
    const grouped = styles.some((s) => s.commas) ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : int;
    out.push(`${sum < 0 ? '-' : ''}${s0.prefix}${grouped}${frac ? `.${frac}` : ''}${s0.suffix}`);
  }
  if (!any) return null;
  if (!out[0]) out[0] = 'Total';
  return out;
}

/** Add a totals row (bold) at the end of the table the cursor is in. Returns why it can't, or null. */
export function addTotalsAtCursor(editor) {
  const { state } = editor;
  const $from = state.selection.$from;
  let d = $from.depth;
  while (d > 0 && $from.node(d).type.name !== 'table') d--;
  if (!d) return 'Put the cursor in a table first';
  const table = $from.node(d);
  const texts = [];
  let merged = false, head = true;
  table.forEach((row, _o, i) => {
    const r = [];
    row.forEach((cell) => { r.push(cell.textContent); if ((cell.attrs.colspan || 1) > 1 || (cell.attrs.rowspan || 1) > 1) merged = true; if (i === 0 && cell.type.name !== 'tableHeader') head = false; });
    texts.push(r);
  });
  if (merged) return 'A table with merged cells can’t be added up: unmerge them first';
  const totals = totalsRow(texts, head && texts.length > 1);
  if (!totals) return 'There are no figures in this table to add up';
  const { schema } = state;
  const cellOf = (t) => schema.nodes.tableCell.create(null, schema.nodes.paragraph.create(null, t ? schema.text(t, [schema.marks.bold.create()]) : null));
  const row = schema.nodes.tableRow.create(null, totals.map(cellOf));
  const end = $from.before(d) + table.nodeSize - 1; // (inside the table, after its last row)
  editor.view.dispatch(state.tr.insert(end, row).scrollIntoView());
  return null;
}
