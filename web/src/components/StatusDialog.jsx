// Set your status: what colleagues see next to your name (in Chat and Contacts), cleared by itself.
import { useEffect, useState } from 'react';
import { get, put, post, del, onLive } from '../api.js';
import { Modal, useToast } from './ui.jsx';
import EmojiPicker from './EmojiPicker.jsx';
import { PRESETS, CLEAR_AFTER, untilFor, untilText, statusLine } from './status.js';

/** Your own status, kept up to date (other tabs and devices too). */
export function useMyStatus(userId) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    const load = () => get('/users/me/status').then((r) => setStatus(r.status)).catch(() => {});
    load();
    const off = onLive((m) => { if (m.type === 'status-changed' && m.user_id === userId) load(); });
    // It clears by itself: look again when it's due.
    return off;
  }, [userId]);
  useEffect(() => {
    if (!status?.until) return undefined;
    const t = setTimeout(() => setStatus(null), Math.max(0, Math.min(status.until - Date.now(), 2 ** 31 - 1)));
    return () => clearTimeout(t);
  }, [status]);
  return [status, setStatus];
}

export function StatusDialog({ current, onClose, onSaved }) {
  const toast = useToast();
  const [emoji, setEmoji] = useState(current?.emoji || '💬');
  const [text, setText] = useState(current?.text || '');
  const [clear, setClear] = useState('today');
  // The statuses you set lately (not the suggestions below, which are always there).
  const [recent, setRecent] = useState([]);
  useEffect(() => { get('/users/me/status').then((r) => setRecent(r.recent || [])).catch(() => {}); }, []);
  const shownRecent = recent.filter((r) => !PRESETS.some(([em, words]) => em === r.emoji && words === r.text));
  const forget = (r) => post('/users/me/status/recent/forget', { emoji: r.emoji || '', text: r.text || '' }).then((x) => setRecent(x.recent)).catch((e) => toast(e.message, 'error'));
  async function save(e) {
    e?.preventDefault();
    try {
      const r = await put('/users/me/status', { emoji, text: text.trim(), until: untilFor(clear), clear });
      onSaved(r.status);
      toast(`Status set: ${statusLine(r.status)}${r.status.until ? ` ${untilText(r.status.until)}` : ''}`);
      onClose();
    } catch (err) { toast(err.message, 'error'); }
  }
  async function clearNow() {
    try { await del('/users/me/status'); onSaved(null); toast('Status cleared'); onClose(); } catch (err) { toast(err.message, 'error'); }
  }
  return (
    <Modal title="Your status" onClose={onClose}>
      <form className="stack status-form" onSubmit={save}>
        <div className="row">
          <span className="status-emoji" aria-label={`Emoji ${emoji}`}>{emoji}</span>
          <EmojiPicker className="btn small" label="Choose an emoji" onPick={setEmoji} />
          <input className="grow" autoFocus value={text} onChange={(e) => setText(e.target.value)} maxLength={100} placeholder="What’s your status?" aria-label="Status" />
        </div>
        {shownRecent.length > 0 && <div className="status-presets" role="group" aria-label="Recent">
          <span className="muted small status-presets-title">Recent</span>
          {shownRecent.map((r) => (
            <span key={`${r.emoji}|${r.text}`} className="status-recent">
              <button type="button" className="btn small" onClick={() => { setEmoji(r.emoji || ''); setText(r.text || ''); setClear(r.clear); }}>{statusLine(r)}</button>
              <button type="button" className="icon-btn" aria-label={`Forget ${statusLine(r)}`} title="Forget it" onClick={() => forget(r)}>×</button>
            </span>
          ))}
        </div>}
        <div className="status-presets" role="group" aria-label="Suggestions">
          {PRESETS.map(([em, words, after]) => (
            <button key={words} type="button" className="btn small" onClick={() => { setEmoji(em); setText(words); setClear(after); }}>{em} {words}</button>
          ))}
        </div>
        <label className="field"><span>Clear after</span>
          <select value={clear} onChange={(e) => setClear(e.target.value)} aria-label="Clear after">
            {CLEAR_AFTER.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
          </select></label>
        <p className="muted small" style={{ margin: 0 }}>Colleagues see it next to your name in Chat and Contacts.</p>
        <div className="row end">
          {current && <button type="button" className="btn" onClick={clearNow}>Clear status</button>}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!text.trim() && !emoji}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
