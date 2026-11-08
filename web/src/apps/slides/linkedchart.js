// Charts from a spreadsheet on a slide: the slide keeps a copy of the chart (its type, title and
// figures), so everyone who can open the presentation sees it. Whoever can open the spreadsheet too
// is offered "Update" once its figures have changed.
import { bookEvaluator } from '../sheets/formula.js';
import { chartData } from '../sheets/charts.js';

/** The charts in a spreadsheet's content: [{ id, title, type, sheet }]. */
export function chartsIn(content) {
  return (content?.sheets || []).flatMap((s) => Object.entries(s.charts || {}).map(([id, c]) => ({ id, title: c.title || '', type: c.type || 'column', sheet: s.name })));
}

/** One chart of a spreadsheet as it is now: { title, chartType, data } (null if it's gone). */
export function chartNow(content, chartId, imports = null) {
  const sheets = content?.sheets || [];
  const i = sheets.findIndex((s) => s.charts?.[chartId]);
  if (i < 0) return null;
  const c = sheets[i].charts[chartId];
  const value = bookEvaluator(sheets, i, imports);
  const d = chartData(c.range, value);
  return { title: c.title || '', chartType: c.type || 'column', data: { categories: d.categories, series: d.series, ...(d.error && { error: d.error }) } };
}

/** Whether the copy on the slide differs from the chart as it is now. */
export const chartChanged = (item, now) => !!now && JSON.stringify([item.title || '', item.chartType, item.data]) !== JSON.stringify([now.title, now.chartType, now.data]);
