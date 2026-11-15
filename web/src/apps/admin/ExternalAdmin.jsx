// Admin → Shared outside: the company's files and folders shared with people at other companies,
// by company, with who shared what with whom. Stop one share, or everything with one company;
// whoever shared it is told.
import { useCallback, useEffect, useState } from 'react';
import { get, post, del } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { ConfirmModal, useToast } from '../../components/ui.jsx';

const ROLE = { viewer: 'Can view', commenter: 'Can comment', editor: 'Can edit' };

export default function ExternalAdmin({ allowExternal, limitDays }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [company, setCompany] = useState('');
  const [find, setFind] = useState('');
  const [soon, setSoon] = useState(false); // only shares ending within a week
  const [stopping, setStopping] = useState(null); // one share
  const [stoppingCompany, setStoppingCompany] = useState(null);
  const [enforcing, setEnforcing] = useState(false);
  const load = useCallback(() => get('/external-shares').then(setData).catch((e) => toast(e.message, 'error')), [toast]);
  useEffect(() => { load(); }, [load]);
  // Undo on the message after a Stop: those shares back as they were (for ten minutes).
  const undoAction = (key) => (key ? { action: { label: 'Undo', onClick: async () => {
    try { const u = await post('/external-shares/undo', { undo: key }); toast(`${u.restored} ${u.restored === 1 ? 'share' : 'shares'} put back`); load(); } catch (e) { toast(e.message, 'error'); }
  } } } : undefined);
  const words = find.trim().toLowerCase();
  const weekAhead = Date.now() + 7 * 864e5;
  const endingSoon = (data?.items || []).filter((x) => x.expires_at && x.expires_at <= weekAhead).length;
  const shown = (data?.items || []).filter((x) => (!soon || (x.expires_at && x.expires_at <= weekAhead)) && (!company || x.with_org_id === company)
    && (!words || `${x.file_name} ${x.owner_name} ${x.owner_email} ${x.with_name} ${x.with_email}`.toLowerCase().includes(words)));
  const picked = data?.companies.find((c) => c.id === company);
  return (
    <div className="stack" style={{ maxWidth: 1100 }}>
      <p className="muted small" style={{ margin: 0 }}>Files and folders people in your company share with people at other companies (Drive → Share, by their exact address). Stopping a share takes their access away at once; whoever shared it is told.{allowExternal === false && ' Working with other companies is off (Company settings), so none of these can be opened now.'}</p>
      {limitDays && data && (() => {
        const over = data.items.filter((x) => !x.expires_at || x.expires_at > Date.now() + limitDays * 864e5 + 60e3).length;
        return over > 0 && (
          <div className="row wrap" role="status"><span className="grow small">{over} {over === 1 ? 'share lasts' : 'shares last'} longer than your company’s limit of {limitDays} days (made before it was set).</span>
            <button type="button" className="btn small" onClick={() => setEnforcing(true)}>Apply the limit to them…</button></div>
        );
      })()}
      {data && data.companies.length > 0 && (
        <ul className="row wrap" aria-label="Companies" style={{ listStyle: 'none', padding: 0, margin: 0, gap: 8 }}>
          {data.companies.map((c) => (
            <li key={c.id}><button type="button" className={`btn small ${company === c.id ? 'primary' : ''}`} aria-pressed={company === c.id} onClick={() => setCompany(company === c.id ? '' : c.id)}>
              {c.name} · {c.items} {c.items === 1 ? 'share' : 'shares'}, {c.people} {c.people === 1 ? 'person' : 'people'}</button></li>
          ))}
        </ul>
      )}
      <div className="row wrap" style={{ gap: 12 }}>
        <label className="field" style={{ minWidth: 260 }}><span>Find</span>
          <input type="search" value={find} placeholder="A file, or who shared it or with whom" onChange={(e) => setFind(e.target.value)} />
        </label>
        <label className="check small"><input type="checkbox" checked={soon} onChange={(e) => setSoon(e.target.checked)} /> Ending within a week{endingSoon ? ` (${endingSoon})` : ''}</label>
        {picked && <button type="button" className="btn small danger" onClick={() => setStoppingCompany(picked)}>Stop sharing everything with {picked.name}…</button>}
        <span className="grow" /><a className="btn small" href="/api/external-shares/export.csv" download><Icon name="download" size={16} /> Download (CSV)</a>
      </div>
      {data === null ? <p className="muted">Loading…</p> : !shown.length ? <p className="muted" role="status">{data.items.length ? 'Nothing matches.' : 'Nothing is shared outside the company.'}</p> : (
        <div className="card" style={{ padding: 0 }}>
          <table className="files">
            <caption className="sr-only">Shared outside the company</caption>
            <thead><tr><th>File or folder</th><th className="hide-sm">Shared by</th><th>With</th><th className="hide-sm">Access</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {shown.map((x) => (
                <tr key={`${x.file_id}-${x.user_id}`}>
                  <td className="name"><Icon name={x.kind === 'folder' ? 'folder' : 'file'} /><span>{x.file_name}{x.trashed && <span className="muted small"> (in the trash)</span>}</span></td>
                  <td className="hide-sm"><span title={x.owner_email}>{x.owner_name}</span></td>
                  <td><span title={x.with_email}>{x.with_name || x.with_email}</span> <span className="pill">{x.with_company || 'Another company'}</span></td>
                  <td className="hide-sm">{ROLE[x.role] || x.role}{x.expires_at ? <span className="muted small"> · until {new Date(x.expires_at).toLocaleDateString([], { day: 'numeric', month: 'short' })}</span> : null}</td>
                  <td className="actions"><button type="button" className="btn" aria-label={`Stop sharing ${x.file_name} with ${x.with_email}`} onClick={() => setStopping(x)}>Stop</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {stopping && <ConfirmModal title="Stop this share?" danger confirm="Stop sharing"
        message={`${stopping.with_name || stopping.with_email} (${stopping.with_company || 'another company'}) can no longer open “${stopping.file_name}”. ${stopping.owner_name} is told.`}
        onConfirm={async () => { try { const r = await del(`/external-shares/${stopping.file_id}/${stopping.user_id}`); toast('Sharing stopped', 'info', undoAction(r.undo)); load(); } catch (e) { toast(e.message, 'error'); } }}
        onClose={() => setStopping(null)} />}
      {enforcing && <ConfirmModal title="Apply the limit to existing shares?" confirm="Apply limit"
        message={`Shares with people at other companies that don't end, or end later, will end ${limitDays} days from now. Whoever shared them is told.`}
        onConfirm={async () => { try { const r = await post('/external-shares/enforce'); toast(`${r.changed} ${r.changed === 1 ? 'share now ends' : 'shares now end'} on ${new Date(r.ends_at).toLocaleDateString([], { day: 'numeric', month: 'short' })}`); load(); } catch (e) { toast(e.message, 'error'); } }}
        onClose={() => setEnforcing(false)} />}
      {stoppingCompany && <ConfirmModal title={`Stop sharing everything with ${stoppingCompany.name}?`} danger confirm="Stop all"
        message={`${stoppingCompany.items} ${stoppingCompany.items === 1 ? 'share' : 'shares'} with ${stoppingCompany.people} ${stoppingCompany.people === 1 ? 'person' : 'people'} at ${stoppingCompany.name} end at once. Whoever shared them is told. (To stop working with other companies altogether, use Company settings.)`}
        onConfirm={async () => { try { const r = await post('/external-shares/stop-company', { org_id: stoppingCompany.id }); toast(`${r.stopped} ${r.stopped === 1 ? 'share' : 'shares'} stopped`, 'info', undoAction(r.undo)); setCompany(''); load(); } catch (e) { toast(e.message, 'error'); } }}
        onClose={() => setStoppingCompany(null)} />}
    </div>
  );
}
