// A chart from a spreadsheet in a document (the "sheetChart" node): the copy of its figures the
// document keeps, as a title and a table, for Word and Markdown downloads.

/** { title, rows: [[''|label, …series names], [category, …values]] } from a sheetChart node. */
export function chartTable(attrs = {}) {
  let data = attrs.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
  const series = Array.isArray(data?.series) ? data.series : [];
  const categories = Array.isArray(data?.categories) ? data.categories : [];
  const rows = series.length ? [['', ...series.map((s) => String(s.name ?? ''))], ...categories.map((c, i) => [String(c ?? ''), ...series.map((s) => (s.values?.[i] ?? '') === '' ? '' : String(s.values[i]))])] : [];
  return { title: String(attrs.title || 'Chart'), rows };
}
