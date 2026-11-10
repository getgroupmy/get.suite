// Event drafts in a document: "@event" puts in a block with a title, a day and times, guests and a
// place above notes, for planning a meeting together. "Add to Calendar" opens it in Calendar as a new
// event (with the document attached and linked), ready to check and save, which sends the invitations.
import { Node } from '@tiptap/core';
import { NodeViewWrapper, NodeViewContent, ReactNodeViewRenderer } from '@tiptap/react';
import { eventFromDraft, whenText, EVENT_KEY } from './blocks.js';
import { useToast } from '../../components/ui.jsx';

function EventView({ node, editor, getPos, updateAttributes, extension }) {
  const a = node.attrs;
  const can = editor.isEditable;
  const toast = useToast();
  const add = () => {
    const now = editor.state.doc.nodeAt(getPos()) || node;
    const ev = eventFromDraft(now.attrs, now.textContent, extension.options.doc?.(), window.location.origin);
    if (ev.error) { toast(ev.error, 'error'); return; }
    try { localStorage.setItem(EVENT_KEY, JSON.stringify(ev)); } catch { /* storage off */ }
    window.open('/calendar?new_doc=1', '_blank');
  };
  const field = (key, label, props = {}) => (
    <label className="doc-email-line">
      <span>{label}</span>
      <input type="text" value={a[key] || ''} readOnly={!can} aria-label={label} {...props}
        onChange={(e) => updateAttributes({ [key]: e.target.value.slice(0, 2000) })} />
    </label>
  );
  return (
    <NodeViewWrapper className="doc-email doc-event" role="group" aria-label="Event draft">
      <div className="doc-email-head" contentEditable={false}>
        <span className="doc-email-title">📅 Event draft</span>
        <button type="button" className="btn small primary" onClick={add}>Add to Calendar</button>
      </div>
      <div className="doc-email-fields" contentEditable={false}>
        {field('title', 'Title', { placeholder: can ? 'What it is' : '' })}
        <div className="doc-email-line doc-event-when">
          <span>When</span>
          <input type="date" value={a.date || ''} readOnly={!can} aria-label="Day" onChange={(e) => updateAttributes({ date: e.target.value })} />
          <input type="time" value={a.start || ''} readOnly={!can} aria-label="Starts" onChange={(e) => updateAttributes({ start: e.target.value })} />
          <span className="muted" aria-hidden="true">–</span>
          <input type="time" value={a.end || ''} readOnly={!can} aria-label="Ends" onChange={(e) => updateAttributes({ end: e.target.value })} />
        </div>
        {field('guests', 'Guests', { placeholder: can ? 'name@company.com, …' : '' })}
        {field('location', 'Where', { placeholder: can ? 'A room, an address' : '' })}
      </div>
      <NodeViewContent className="doc-email-body" />
    </NodeViewWrapper>
  );
}

export const EventDraft = Node.create({
  name: 'eventDraft',
  group: 'block',
  content: '(paragraph | heading | bulletList | orderedList | taskList | blockquote)+',
  defining: true,
  isolating: true,
  addOptions: () => ({ doc: () => null }), // the document it's in: { id, name }
  addAttributes() {
    const at = (name) => ({ default: '', parseHTML: (el) => el.getAttribute(`data-${name}`) || '', renderHTML: (x) => ({ [`data-${name}`]: x[name] || '' }) });
    return { title: at('title'), date: at('date'), start: at('start'), end: at('end'), guests: at('guests'), location: at('location') };
  },
  parseHTML: () => [{ tag: 'div[data-event-draft]', contentElement: '.doc-email-body' }],
  renderHTML({ node, HTMLAttributes }) {
    const a = node.attrs;
    return ['div', { ...HTMLAttributes, 'data-event-draft': '', class: 'doc-email doc-event' },
      ['p', { class: 'doc-email-fields' }, [`📅 ${a.title || 'Event'}`, whenText(a), a.location, a.guests].filter(Boolean).join(' · ')],
      ['div', { class: 'doc-email-body' }, 0]];
  },
  addCommands() {
    return { insertEventDraft: (attrs = {}) => ({ commands }) => commands.insertContent([{ type: this.name, attrs, content: [{ type: 'paragraph' }] }, { type: 'paragraph' }]) };
  },
  addNodeView() { return ReactNodeViewRenderer(EventView); },
});
