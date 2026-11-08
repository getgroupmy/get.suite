// A chart from a spreadsheet in a document. The document keeps a copy of the chart (its type, title
// and figures, as text in the node), so everyone who can read the document sees it; whoever can
// open the spreadsheet too is offered "Update" once its figures change. In HTML it's a figure with
// the chart's title and a table of its figures.
import { Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { ChartBox, useChartNow } from '../ChartLink.jsx';
import { chartChanged } from '../slides/linkedchart.js';

const parse = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s || null; } catch { return null; } };

/** The figures of a chart as table rows: [['', …series], [category, …values]]. */
export function chartRows(data) {
  const series = data?.series || [];
  if (!series.length) return [];
  return [['', ...series.map((s) => String(s.name ?? ''))], ...(data.categories || []).map((c, i) => [String(c ?? ''), ...series.map((s) => (s.values?.[i] ?? '') === '' ? '' : String(s.values[i]))])];
}

function ChartNodeView({ node, editor, selected, updateAttributes }) {
  const a = node.attrs;
  const item = { fileId: a.fileId, chartId: a.chartId, title: a.title, chartType: a.chartType, data: parse(a.data) };
  return (
    <NodeViewWrapper className={`doc-chart ${selected ? 'sel' : ''}`} data-drag-handle="" aria-label={`Chart: ${a.title || 'Untitled'}`} role="figure">
      <div contentEditable={false} style={{ height: a.height || 320 }}><ChartBox item={item} /></div>
      {selected && editor.isEditable && <ChartBar item={item} onUpdate={(now) => updateAttributes({ title: now.title, chartType: now.chartType, data: JSON.stringify(now.data) })} />}
    </NodeViewWrapper>
  );
}

function ChartBar({ item, onUpdate }) {
  const { state, now } = useChartNow(item);
  const changed = state === 'ok' && chartChanged(item, now);
  const note = changed ? 'The spreadsheet has changed' : { ok: 'Up to date', loading: '…', 'no-access': 'Spreadsheet not shared with you', gone: 'Chart deleted in the spreadsheet' }[state];
  return (
    <div className="doc-chart-bar row small" contentEditable={false}>
      <span className="muted grow" role="status">{note}</span>
      {changed && <button type="button" className="btn small primary" onClick={() => onUpdate(now)}>↻ Update chart</button>}
      {state !== 'no-access' && <a className="btn small" href={`/sheets/${item.fileId}`} target="_blank" rel="noreferrer">Open spreadsheet</a>}
    </div>
  );
}

export const SheetChart = Node.create({
  name: 'sheetChart',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    const da = (name, attr) => ({ default: null, parseHTML: (el) => el.getAttribute(attr), renderHTML: () => ({}) });
    return { fileId: da('fileId', 'data-file'), chartId: da('chartId', 'data-chart'), title: da('title', 'data-title'), chartType: da('chartType', 'data-type'), data: da('data', 'data-figures'), height: { default: 320, renderHTML: () => ({}) } };
  },
  parseHTML: () => [{ tag: 'figure[data-sheet-chart]' }],
  renderHTML({ node }) {
    const a = node.attrs;
    const rows = chartRows(parse(a.data));
    const table = rows.length ? ['table', ['tbody', ...rows.map((r, i) => ['tr', ...r.map((t) => [i === 0 ? 'th' : 'td', t])])]] : ['p', ''];
    return ['figure', { 'data-sheet-chart': '', 'data-file': a.fileId, 'data-chart': a.chartId, 'data-title': a.title || '', 'data-type': a.chartType, 'data-figures': a.data || '', class: 'doc-chart' },
      ['figcaption', a.title || 'Chart'], table];
  },
  addCommands() {
    return { insertSheetChart: (attrs) => ({ commands }) => commands.insertContent({ type: this.name, attrs }) };
  },
  addNodeView() { return ReactNodeViewRenderer(ChartNodeView); },
});
