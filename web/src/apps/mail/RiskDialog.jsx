// A warning before downloading an attachment that may harm a computer (a program, macros, a disguised
// name: the server's attachrisk.js decides). The download only starts after ticking "I understand".
import { useState } from 'react';
import { Modal } from '../../components/ui.jsx';

/** The address with ?confirm=1 (the server hands risky files over only with it). */
export const confirmed = (url) => `${url}${url.includes('?') ? '&' : '?'}confirm=1`;

/** risky: { name, reasons: [...], level, href } (href already confirmed), or a message from the server instead of reasons. */
export default function RiskDialog({ risky, onClose }) {
  const [sure, setSure] = useState(false);
  const danger = risky.level === 'danger';
  return (
    <Modal title={danger ? 'This attachment may be harmful' : 'Be careful with this attachment'} onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>Don’t download</button>
        {sure ? <a className={`btn ${danger ? 'danger' : 'primary'}`} href={risky.href} download={risky.download || undefined} onClick={() => setTimeout(onClose, 300)}>Download anyway</a>
          : <button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} disabled title="Tick “I understand the risk” first">Download anyway</button>}
      </>}>
      <div className="stack-tight risk-dialog">
        <p style={{ margin: 0 }}><strong className="ellipsis" style={{ display: 'block' }}>{risky.name}</strong></p>
        {risky.reasons?.length ? <ul className="risk-reasons">{risky.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : <p style={{ margin: 0 }}>{risky.message}</p>}
        <p className="muted small" style={{ margin: 0 }}>Senders can be faked. If you weren’t expecting it, check with the sender another way (a call, a chat) before opening it. Saving it to Drive is safe: nothing runs there.</p>
        <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> <span>I understand the risk and want to download it</span></label>
      </div>
    </Modal>
  );
}
