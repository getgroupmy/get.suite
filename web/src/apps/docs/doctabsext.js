// Document tabs in the editor (see doctabs.js): the `docTab` node, a document that holds either tabs
// or blocks, and which tab is open. Only the open tab shows; when the cursor goes into another tab
// (arrow keys, find, a link to a heading there) that tab opens.
import { Node, mergeAttributes } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { newTabId, cleanTitle, MAX_TABS } from './doctabs.js';

export const TabbedDocument = Document.extend({ content: '(docTab+ | block+)' });

export const tabKey = new PluginKey('docTabs');

/** The tab (its node, position and id) that a position is in, or null. */
function tabAt(doc, pos) {
  let found = null;
  doc.forEach((node, offset) => { if (!found && node.type.name === 'docTab' && pos >= offset && pos <= offset + node.nodeSize) found = { node, pos: offset, id: node.attrs.id }; });
  return found;
}
/** Every tab: [{ node, pos, id }]. */
function allTabs(doc) {
  const out = [];
  doc.forEach((node, pos) => { if (node.type.name === 'docTab') out.push({ node, pos, id: node.attrs.id }); });
  return out;
}

export const DocTab = Node.create({
  name: 'docTab',
  content: 'block+',
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      id: { default: null, parseHTML: (el) => el.getAttribute('data-tab-id'), renderHTML: (a) => ({ 'data-tab-id': a.id }) },
      title: { default: '', parseHTML: (el) => el.getAttribute('data-tab-title') || '', renderHTML: (a) => ({ 'data-tab-title': a.title }) },
    };
  },
  parseHTML() { return [{ tag: 'section[data-tab-id]' }]; },
  renderHTML({ HTMLAttributes }) { return ['section', mergeAttributes(HTMLAttributes, { class: 'doc-tab' }), 0]; },
  addProseMirrorPlugins() {
    return [new Plugin({
      key: tabKey,
      state: {
        init: () => ({ active: null }),
        apply(tr, value, _old, state) {
          const asked = tr.getMeta(tabKey);
          if (asked !== undefined) return { active: asked };
          // The cursor went into another tab: open that one.
          if (tr.selectionSet || tr.docChanged) {
            const here = tabAt(state.doc, state.selection.from);
            if (here && here.id !== value.active) return { active: here.id };
          }
          return value;
        },
      },
      props: {
        decorations(state) {
          const tabs = allTabs(state.doc);
          if (!tabs.length) return null;
          const { active } = tabKey.getState(state);
          const open = tabs.find((t) => t.id === active) || tabs[0];
          return DecorationSet.create(state.doc, [Decoration.node(open.pos, open.pos + open.node.nodeSize, { class: 'active-tab' })]);
        },
      },
    })];
  },
});

/** The open tab's id (the first tab's when none was chosen yet), or null in a document without tabs. */
export function activeTab(state) {
  const tabs = allTabs(state.doc);
  if (!tabs.length) return null;
  const { active } = tabKey.getState(state) || {};
  return (tabs.find((t) => t.id === active) || tabs[0]).id;
}

/** Open a tab, with the cursor at its start. */
export function openTab(editor, id) {
  const t = allTabs(editor.state.doc).find((x) => x.id === id);
  if (!t) return;
  const tr = editor.state.tr.setMeta(tabKey, id).setSelection(TextSelection.near(editor.state.doc.resolve(t.pos + 1)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}

/** Add a tab after the open one (a document without tabs first becomes "Tab 1"). Returns its id. */
export function addTab(editor, title = '') {
  const { state } = editor;
  const schema = state.schema;
  const tabs = allTabs(state.doc);
  if (tabs.length >= MAX_TABS) return null;
  let tr = state.tr;
  if (!tabs.length) {
    const first = schema.nodes.docTab.create({ id: newTabId(), title: 'Tab 1' }, state.doc.content);
    tr = tr.replaceWith(0, state.doc.content.size, first);
  }
  const after = (() => {
    const list = allTabs(tr.doc);
    const open = list.find((t) => t.id === activeTab(state)) || list[list.length - 1];
    return open.pos + open.node.nodeSize;
  })();
  const id = newTabId();
  const n = allTabs(tr.doc).length + 1;
  tr = tr.insert(after, schema.nodes.docTab.create({ id, title: cleanTitle(title) || `Tab ${n}` }, schema.nodes.paragraph.create()));
  tr = tr.setMeta(tabKey, id).setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return id;
}

export function renameTab(editor, id, title) {
  const t = allTabs(editor.state.doc).find((x) => x.id === id);
  if (!t) return;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(t.pos, null, { ...t.node.attrs, title: cleanTitle(title) || t.node.attrs.title }));
}

/** Delete a tab and what's in it; with one tab left, the document goes back to having none. */
export function deleteTab(editor, id) {
  const tabs = allTabs(editor.state.doc);
  const t = tabs.find((x) => x.id === id);
  if (!t || tabs.length < 2) return;
  let tr = editor.state.tr.delete(t.pos, t.pos + t.node.nodeSize);
  const left = allTabs(tr.doc);
  if (left.length === 1) tr = tr.replaceWith(0, tr.doc.content.size, left[0].node.content).setMeta(tabKey, null);
  else {
    const next = left[Math.min(tabs.indexOf(t), left.length - 1)];
    tr = tr.setMeta(tabKey, next.id).setSelection(TextSelection.near(tr.doc.resolve(next.pos + 1)));
  }
  editor.view.dispatch(tr);
}

/** Move a tab one place up (-1) or down (+1). */
export function moveTab(editor, id, dir) {
  const tabs = allTabs(editor.state.doc);
  const i = tabs.findIndex((x) => x.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= tabs.length) return;
  const a = tabs[Math.min(i, j)], b = tabs[Math.max(i, j)];
  // Swap two neighbours: put the later one before the earlier one.
  let tr = editor.state.tr.delete(b.pos, b.pos + b.node.nodeSize).insert(a.pos, b.node);
  const moved = allTabs(tr.doc).find((x) => x.id === id);
  tr = tr.setMeta(tabKey, id).setSelection(TextSelection.near(tr.doc.resolve(moved.pos + 1)));
  editor.view.dispatch(tr);
}

/** A copy of a tab (with a new id), right after it. */
export function duplicateTab(editor, id) {
  const tabs = allTabs(editor.state.doc);
  const t = tabs.find((x) => x.id === id);
  if (!t || tabs.length >= MAX_TABS) return;
  const copy = editor.state.schema.nodes.docTab.create({ id: newTabId(), title: cleanTitle(`Copy of ${t.node.attrs.title}`) }, t.node.content);
  const at = t.pos + t.node.nodeSize;
  let tr = editor.state.tr.insert(at, copy);
  tr = tr.setMeta(tabKey, copy.attrs.id).setSelection(TextSelection.near(tr.doc.resolve(at + 1)));
  editor.view.dispatch(tr);
}

/** Open the tab a position is in, without moving the cursor (find's current match, say). */
export function revealTabAt(editor, pos) {
  const t = tabAt(editor.state.doc, pos);
  if (t && t.id !== activeTab(editor.state)) editor.view.dispatch(editor.state.tr.setMeta(tabKey, t.id));
}
