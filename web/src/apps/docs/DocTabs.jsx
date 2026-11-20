// The tabs of a document, beside it: click one to open it; + adds one; each tab's ⋮ renames,
// duplicates, copies to another document, moves or deletes it. Everyone sees the same tabs (they're part of the document); which
// one is open is each person's own.
import { useEffect, useState } from 'react';
import { Menu, ConfirmModal, PromptModal, useToast } from '../../components/ui.jsx';
import DrivePicker from '../../components/DrivePicker.jsx';
import { post } from '../../api.js';
import { tabsOf } from './doctabs.js';
import { activeTab, openTab, addTab, renameTab, deleteTab, moveTab, duplicateTab } from './doctabsext.js';

export function useTabs(editor) {
  const read = () => (editor ? { tabs: tabsOf(editor.getJSON()), active: activeTab(editor.state) } : { tabs: [], active: null });
  const [now, setNow] = useState(read);
  useEffect(() => {
    if (!editor) return undefined;
    let last = '';
    const f = () => {
      const next = read();
      const key = JSON.stringify(next);
      if (key !== last) { last = key; setNow(next); }
    };
    f();
    editor.on('transaction', f);
    return () => editor.off('transaction', f);
  }, [editor]); // eslint-disable-line react-hooks/exhaustive-deps
  return now;
}

export function DocTabs({ editor, canEdit, onClose, fileId, onCopied }) {
  const { tabs, active } = useTabs(editor);
  const [dialog, setDialog] = useState(null);
  const toast = useToast();
  // A link that opens the document on this tab, for sending to someone.
  const copyLink = async (t) => {
    const url = `${window.location.origin}/docs/${fileId}#tab=${t.id}`;
    try { await navigator.clipboard.writeText(url); onCopied?.(`Link to “${t.title}” copied`); } catch { window.prompt('Copy this link', url); }
  };
  const list = tabs.length ? tabs : [{ id: null, title: 'Tab 1', index: 0 }]; // a document without tabs is one tab
  return (
    <nav className="doc-tabs" aria-label="Document tabs">
      <div className="doc-tabs-head">
        <strong>Tabs</strong>
        {canEdit && <button type="button" className="icon-btn" aria-label="Add tab" title="Add a tab" onClick={() => addTab(editor)}>＋</button>}
        {onClose && <button type="button" className="icon-btn" aria-label="Close tabs" title="Close" onClick={onClose}>×</button>}
      </div>
      <ul>
        {list.map((t, i) => (
          <li key={t.id || 'only'} className={t.id === active || !t.id ? 'on' : ''}>
            <button type="button" className="doc-tab-name" aria-current={t.id === active || !t.id ? 'page' : undefined} onClick={() => t.id && openTab(editor, t.id)} title={t.title}>
              <span aria-hidden="true">▤</span> {t.title}
            </button>
            {t.id && (fileId || canEdit) && (
              <Menu trigger={(p) => <button type="button" className="icon-btn doc-tab-more" aria-label={`Options for tab ${t.title}`} {...p}>⋮</button>} items={[
                fileId && { label: 'Copy link to tab', icon: 'link', onClick: () => copyLink(t) },
                canEdit && { label: 'Rename', icon: 'edit', onClick: () => setDialog({ type: 'rename', tab: t }) },
                canEdit && { label: 'Duplicate', onClick: () => duplicateTab(editor, t.id) },
                canEdit && fileId && { label: 'Copy to another document…', onClick: () => setDialog({ type: 'copy-to', tab: t }) },
                canEdit && fileId && { label: 'Copy to a new document', onClick: async () => {
                  try {
                    const r = await post(`/files/${fileId}/doc-tabs/${encodeURIComponent(t.id)}/copy-to`, { new: true });
                    toast(`Copied to a new document, “${r.name}”`, 'info', { action: { label: 'Open it', onClick: () => { window.location.href = `/docs/${r.id}`; } } });
                  } catch (e) { toast(e.message || 'Couldn’t copy the tab', 'error'); }
                } },
                canEdit && i > 0 && { label: 'Move up', onClick: () => moveTab(editor, t.id, -1) },
                canEdit && i < list.length - 1 && { label: 'Move down', onClick: () => moveTab(editor, t.id, 1) },
                canEdit && list.length > 1 && '-',
                canEdit && list.length > 1 && { label: 'Delete', icon: 'trash', danger: true, onClick: () => setDialog({ type: 'delete', tab: t }) },
              ].filter(Boolean)} />
            )}
          </li>
        ))}
      </ul>
      {dialog?.type === 'rename' && <PromptModal title="Rename tab" label="Tab name" initial={dialog.tab.title} confirm="Rename"
        onClose={() => setDialog(null)} onSubmit={(v) => renameTab(editor, dialog.tab.id, v)} />}
      {dialog?.type === 'copy-to' && <DrivePicker title={`Copy “${dialog.tab.title}” to a document`} empty="No documents you can edit."
        accept={(x) => x.kind === 'doc' && (x.role === 'owner' || x.role === 'editor')}
        onClose={() => setDialog(null)} onPick={async (d) => {
          const tab = dialog.tab;
          setDialog(null);
          try {
            const r = await post(`/files/${fileId}/doc-tabs/${encodeURIComponent(tab.id)}/copy-to`, { target: d.id });
            toast(`Copied to “${r.name}” as “${r.tab}”`, 'info', { action: { label: 'Open it', onClick: () => { window.location.href = `/docs/${r.id}#tab=${r.tab_id}`; } } });
          } catch (e) { toast(e.message || 'Couldn’t copy the tab', 'error'); }
        }} />}
      {dialog?.type === 'delete' && <ConfirmModal title={`Delete “${dialog.tab.title}”?`} confirm="Delete tab"
        message="The tab and everything in it are deleted for everyone. Undo (Ctrl+Z) or version history brings it back."
        onClose={() => setDialog(null)} onConfirm={() => deleteTab(editor, dialog.tab.id)} />}
    </nav>
  );
}
