import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNotionExport, cleanNotionPath, notionSkip, docFromNotion, sheetFromNotionCsv } from '../src/migrate/notion.js';
import { planExport, sourceOf } from '../src/migrate/plan.js';

const ID = '0123456789abcdef0123456789abcdef', ID2 = 'fedcba9876543210fedcba9876543210';
const NAMES = [
  `Export-x/Roadmap ${ID}.md`, `Export-x/Roadmap ${ID}/Q3 plan ${ID2}.md`, `Export-x/Roadmap ${ID}/diagram.png`,
  `Export-x/Tasks ${ID2}.csv`, `Export-x/Tasks ${ID2}_all.csv`,
];

test('a Notion export is told apart (by the ids on its pages), and its names cleaned', () => {
  assert.equal(isNotionExport(NAMES), true);
  assert.equal(isNotionExport(['Docs/Readme.md', 'Docs/notes.md']), false);
  assert.equal(sourceOf(NAMES), 'notion');
  assert.equal(cleanNotionPath(`Roadmap ${ID}/Q3 plan ${ID2}.md`), 'Roadmap/Q3 plan.md');
  assert.equal(cleanNotionPath(`Tasks ${ID2}_all.csv`), 'Tasks.csv');
  assert.equal(cleanNotionPath('Roadmap/diagram.png'), 'Roadmap/diagram.png');
  assert.equal(notionSkip(`Export-x/Tasks ${ID2}.csv`, NAMES), true, 'the _all copy is kept instead');
  assert.equal(notionSkip(`Export-x/Tasks ${ID2}_all.csv`, NAMES), false);
});

test('the plan: pages to documents, databases to spreadsheets (never contacts), pictures as files', () => {
  const { source, plan } = planExport(NAMES);
  assert.equal(source, 'notion');
  const by = Object.fromEntries(plan.map((x) => [x.name, x]));
  assert.deepEqual([by[NAMES[0]].as, by[NAMES[0]].path, by[NAMES[0]].convert], ['drive', 'Roadmap/Roadmap', 'doc'], 'a page with sub-pages goes in their folder');
  assert.deepEqual([by[NAMES[1]].path, by[NAMES[1]].convert], ['Roadmap/Q3 plan', 'doc']);
  assert.deepEqual([by[NAMES[2]].path, by[NAMES[2]].convert], ['Roadmap/diagram.png', undefined]);
  assert.equal(by[NAMES[3]].as, 'skip');
  assert.deepEqual([by[NAMES[4]].as, by[NAMES[4]].path, by[NAMES[4]].convert], ['drive', 'Tasks', 'sheet']);
});

test('a page: headings and text, a picture of its own line becomes a picture, links to pages point to their documents', () => {
  const md = `# Roadmap\n\nPlans for the year, see [Q3 plan](Roadmap%20${ID}/Q3%20plan%20${ID2}.md) and [the site](https://example.com).\n\n![diagram.png](Roadmap%20${ID}/diagram.png)\n\n![missing](nowhere.png)\n`;
  const doc = docFromNotion(md, {
    fromDir: 'Export-x',
    pictureFor: (p) => (p === `Export-x/Roadmap ${ID}/diagram.png` ? 'pic1' : null),
    pageFor: (p) => (p === `Export-x/Roadmap ${ID}/Q3 plan ${ID2}.md` ? '/docs/d2' : null),
  });
  assert.equal(doc.content[0].type, 'heading');
  const links = JSON.stringify(doc).match(/"href":"[^"]+"/g);
  assert.deepEqual(links, ['"href":"/docs/d2"', '"href":"https://example.com"']);
  assert.deepEqual(doc.content.find((n) => n.type === 'image'), { type: 'image', attrs: { fileId: 'pic1', alt: 'diagram.png' } });
  assert.match(JSON.stringify(doc), /missing/, 'a picture not in the export stays as its name');
});

test('a database: rows to cells, the heading row bold and kept in view, nothing run as a formula', () => {
  const s = sheetFromNotionCsv('﻿Name,Status,Note\nShip it,Done,"=HYPERLINK(""x"")"\nTest,-5,"two, parts"\n', 'Tasks').sheets[0];
  assert.deepEqual([s.name, s.cells.A1, s.cells.B2, s.cells.C2, s.cells.B3, s.cells.C3, s.formats.A1, s.frozen], ['Tasks', 'Name', 'Done', '\'=HYPERLINK("x")', '-5', 'two, parts', { b: true }, { rows: 1 }]);
});
