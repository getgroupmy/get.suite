// Email drafts in a document: "@email" puts in a block with To, Cc and Subject above a body, for
// writing an email together (everyone editing sees it live, comments and suggestions work on it).
// "Open in Mail" then opens it as a new message in Mail, ready to check and send.
import { Node } from '@tiptap/core';
import { DOMSerializer } from '@tiptap/pm/model';
import { NodeViewWrapper, NodeViewContent, ReactNodeViewRenderer } from '@tiptap/react';

import { draftMessage, DRAFT_KEY } from './emaildraftmsg.js';

export { matchBlocks } from './emaildraftmsg.js';

function DraftView({ node, editor, getPos, updateAttributes }) {
  const a = node.attrs;
  const can = editor.isEditable;
  const open = () => {
    const div = document.createElement('div');
    div.appendChild(DOMSerializer.fromSchema(editor.schema).serializeFragment(editor.state.doc.nodeAt(getPos())?.content || node.content));
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draftMessage(a, div.innerHTML, window.location.origin))); } catch { /* storage off */ }
    window.open('/mail?compose_doc=1', '_blank');
  };
  const field = (key, label, placeholder) => (
    <label className="doc-email-line">
      <span>{label}</span>
      <input type="text" value={a[key] || ''} placeholder={can ? placeholder : ''} readOnly={!can} aria-label={label}
        onChange={(e) => updateAttributes({ [key]: e.target.value.slice(0, 2000) })} />
    </label>
  );
  return (
    <NodeViewWrapper className="doc-email" role="group" aria-label="Email draft">
      <div className="doc-email-head" contentEditable={false}>
        <span className="doc-email-title">✉ Email draft</span>
        <button type="button" className="btn small primary" onClick={open}>Open in Mail</button>
      </div>
      <div className="doc-email-fields" contentEditable={false}>
        {field('to', 'To', 'name@company.com, …')}
        {field('cc', 'Cc', '')}
        {field('subject', 'Subject', 'Subject')}
      </div>
      <NodeViewContent className="doc-email-body" />
    </NodeViewWrapper>
  );
}

export const EmailDraft = Node.create({
  name: 'emailDraft',
  group: 'block',
  content: '(paragraph | heading | bulletList | orderedList | taskList | blockquote)+',
  defining: true,
  isolating: true,
  addAttributes() {
    const at = (name) => ({ default: '', parseHTML: (el) => el.getAttribute(`data-${name}`) || '', renderHTML: (x) => ({ [`data-${name}`]: x[name] || '' }) });
    return { to: at('to'), cc: at('cc'), subject: at('subject') };
  },
  parseHTML: () => [{ tag: 'div[data-email-draft]', contentElement: '.doc-email-body' }],
  renderHTML({ node, HTMLAttributes }) {
    const a = node.attrs;
    return ['div', { ...HTMLAttributes, 'data-email-draft': '', class: 'doc-email' },
      ['p', { class: 'doc-email-fields' }, `To: ${a.to || ''}${a.cc ? ` · Cc: ${a.cc}` : ''} · Subject: ${a.subject || ''}`],
      ['div', { class: 'doc-email-body' }, 0]];
  },
  addCommands() {
    return { insertEmailDraft: (attrs = {}) => ({ commands }) => commands.insertContent([{ type: this.name, attrs, content: [{ type: 'paragraph' }] }, { type: 'paragraph' }]) };
  },
  addNodeView() { return ReactNodeViewRenderer(DraftView); },
});
