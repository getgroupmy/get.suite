// Built-in templates for New → From a template: ready-made documents, spreadsheets and
// presentations (content as the editors keep it).
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const p = (text) => (text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' });
const b = (label, text) => ({ type: 'paragraph', content: [{ type: 'text', text: label, marks: [{ type: 'bold' }] }, ...(text ? [{ type: 'text', text }] : [])] });
const bullets = (items) => ({ type: 'bulletList', content: items.map((t) => ({ type: 'listItem', content: [p(t)] })) });
const checks = (items) => ({ type: 'taskList', content: items.map((t) => ({ type: 'taskItem', attrs: { checked: false }, content: [p(t)] })) });
const today = () => new Date().toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });

const sheet = (name, cells, extra = {}) => ({ sheets: [{ name, cells, colWidths: {}, ...extra }] });
const bold = (keys) => Object.fromEntries(keys.map((k) => [k, { b: 1 }]));

let n = 0;
const id = () => `t${++n}`;
const text = (role, t, x, y, w, hh, size, more = {}) => ({ id: id(), type: 'text', role, text: t, x, y, w, h: hh, size, ...more });

export const BUILT_IN = [
  { key: 'meeting', kind: 'doc', name: 'Meeting notes', blurb: 'Date, attendees, agenda, notes and action items',
    content: () => ({ type: 'doc', content: [h(1, 'Meeting notes'), b('Date: ', today()), b('Attendees: ', ''), h(2, 'Agenda'), bullets(['', '']), h(2, 'Notes'), p(''), h(2, 'Action items'), checks(['', ''])] }) },
  { key: 'letter', kind: 'doc', name: 'Letter', blurb: 'A simple business letter',
    content: () => ({ type: 'doc', content: [p('Your name'), p('Your address'), p(''), p(today()), p(''), p('Their name'), p('Their address'), p(''), p('Dear …,'), p(''), p('…'), p(''), p('Yours sincerely,'), p(''), p('Your name')] }) },
  { key: 'brief', kind: 'doc', name: 'Project brief', blurb: 'Goal, scope, timeline, people and risks',
    content: () => ({ type: 'doc', content: [h(1, 'Project brief'), h(2, 'Goal'), p('What this project will achieve, and how we will know.'), h(2, 'Scope'), bullets(['In: …', 'Out: …']), h(2, 'Timeline'), bullets(['Start: …', 'Milestone: …', 'Finish: …']), h(2, 'People'), bullets(['Owner: …', 'Team: …']), h(2, 'Risks'), bullets(['…'])] }) },
  { key: 'budget', kind: 'sheet', name: 'Monthly budget', blurb: 'Income and spending, with totals',
    content: () => sheet('Budget', {
      A1: 'Item', B1: 'Planned', C1: 'Actual', D1: 'Difference',
      A2: 'Income', B2: '3000', C2: '3000', D2: '=C2-B2',
      A3: 'Rent', B3: '1000', C3: '1000', D3: '=C3-B3',
      A4: 'Food', B4: '400', C4: '', D4: '=C4-B4',
      A5: 'Transport', B5: '150', C5: '', D5: '=C5-B5',
      A6: 'Other', B6: '200', C6: '', D6: '=C6-B6',
      A8: 'Spending', B8: '=SUM(B3:B6)', C8: '=SUM(C3:C6)', D8: '=C8-B8',
      A9: 'Left over', B9: '=B2-B8', C9: '=C2-C8',
    }, { formats: { ...bold(['A1', 'B1', 'C1', 'D1', 'A8', 'A9']), ...Object.fromEntries(['B', 'C', 'D'].flatMap((c) => [2, 3, 4, 5, 6, 8, 9].map((r) => [`${c}${r}`, { num: 'currency', ...(r >= 8 && { b: 1 }) }]))) }, frozen: { rows: 1, cols: 0 } }) },
  { key: 'tracker', kind: 'sheet', name: 'Task tracker', blurb: 'Tasks with owner, due date and status',
    content: () => sheet('Tasks', { A1: 'Task', B1: 'Owner', C1: 'Due', D1: 'Status', D2: 'Not started', D3: 'Not started', D4: 'Not started' },
      { formats: bold(['A1', 'B1', 'C1', 'D1']), frozen: { rows: 1, cols: 0 },
        validations: [{ id: 'v1', range: 'D2:D200', type: 'list', values: ['Not started', 'In progress', 'Done'] }] }) },
  { key: 'update', kind: 'slides', name: 'Project update', blurb: 'Title, progress, next steps and questions',
    content: () => ({ theme: 'light', slides: [
      { id: id(), items: [text('title', 'Project update', 10, 30, 80, 20, 54, { align: 'center', bold: true }), text('subtitle', today(), 10, 55, 80, 10, 24, { align: 'center' })] },
      { id: id(), items: [text('title', 'Where we are', 6, 8, 88, 14, 40, { bold: true }), text('body', '• Done: …\n• In progress: …\n• Blocked: …', 6, 26, 88, 62, 26)] },
      { id: id(), items: [text('title', 'Next steps', 6, 8, 88, 14, 40, { bold: true }), text('body', '1. …\n2. …\n3. …', 6, 26, 88, 62, 26)] },
      { id: id(), items: [text('title', 'Questions?', 10, 38, 80, 20, 54, { align: 'center', bold: true })] },
    ] }) },
];
