import { useEffect, useState } from 'react';
import { get, post, patch, del, formatBytes } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { Avatar, ConfirmModal, Menu, Modal, useToast } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';

export default function Admin() {
  const toast = useToast();
  const { user: me } = useAuth();
  const [users, setUsers] = useState(null);
  const [dialog, setDialog] = useState(null);

  const load = () => get('/users').then(setUsers).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const act = (fn, msg) => async () => { try { await fn(); toast(msg); load(); } catch (e) { toast(e.message, 'error'); } };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Users</h1>
        <div className="grow" />
        <button className="btn primary" onClick={() => setDialog({ type: 'new' })}><Icon name="plus" size={18} /> Add user</button>
      </div>
      <table className="files">
        <thead><tr><th>Name</th><th className="hide-sm">Username</th><th className="hide-sm">Role</th><th className="hide-sm">Storage</th><th aria-label="Actions" /></tr></thead>
        <tbody>
          {users?.map((u) => (
            <tr key={u.id} className={u.disabled ? 'dim' : ''}>
              <td className="name"><Avatar name={u.name} size={28} /><span>{u.name}{u.disabled ? ' (disabled)' : ''}</span></td>
              <td className="hide-sm muted">@{u.username}</td>
              <td className="hide-sm">{u.is_admin ? <span className="pill">Admin</span> : 'User'}</td>
              <td className="hide-sm muted">{formatBytes(u.storage_used)}</td>
              <td className="actions">
                <Menu trigger={(p) => <button className="icon-btn" aria-label={`Actions for ${u.name}`} {...p}><Icon name="more" /></button>} items={[
                  { label: 'Reset password', icon: 'edit', onClick: () => setDialog({ type: 'password', user: u }) },
                  u.id !== me.id && { label: u.is_admin ? 'Remove admin' : 'Make admin', icon: 'shield', onClick: act(() => patch(`/users/${u.id}`, { is_admin: !u.is_admin }), 'Role updated') },
                  u.id !== me.id && { label: u.disabled ? 'Enable account' : 'Disable account', icon: 'logout', onClick: act(() => patch(`/users/${u.id}`, { disabled: !u.disabled }), u.disabled ? 'Account enabled' : 'Account disabled') },
                  u.id !== me.id && '-',
                  u.id !== me.id && { label: 'Delete user and their files', icon: 'trash', danger: true, onClick: () => setDialog({ type: 'delete', user: u }) },
                ]} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {dialog?.type === 'new' && <NewUser onClose={() => setDialog(null)} onSaved={() => { setDialog(null); toast('User created'); load(); }} />}
      {dialog?.type === 'password' && <ResetPassword user={dialog.user} onClose={() => setDialog(null)} />}
      {dialog?.type === 'delete' && (
        <ConfirmModal title={`Delete ${dialog.user.name}?`} confirm="Delete user"
          message={`This permanently deletes @${dialog.user.username}, their files (${formatBytes(dialog.user.storage_used)}), calendar, contacts and messages. Consider disabling the account instead.`}
          onClose={() => setDialog(null)} onConfirm={async () => { await del(`/users/${dialog.user.id}`); toast('User deleted'); load(); }} />
      )}
    </div>
  );
}

function NewUser({ onClose, onSaved }) {
  const [f, setF] = useState({ name: '', username: '', email: '', password: '', is_admin: false });
  const [error, setError] = useState('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Modal title="Add user" onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        try { await post('/users', f); onSaved(); } catch (err) { setError(err.message); }
      }}>
        <label className="field"><span>Full name</span><input autoFocus required value={f.name} onChange={set('name')} /></label>
        <label className="field"><span>Username</span><input required autoCapitalize="none" value={f.username} onChange={set('username')} /></label>
        <label className="field"><span>Email (optional)</span><input type="email" value={f.email} onChange={set('email')} /></label>
        <label className="field"><span>Temporary password</span><input required minLength={8} type="text" autoComplete="off" value={f.password} onChange={set('password')} /></label>
        <label className="check"><input type="checkbox" checked={f.is_admin} onChange={set('is_admin')} /> Administrator</label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Create user</button></div>
      </form>
    </Modal>
  );
}

function ResetPassword({ user, onClose }) {
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  return (
    <Modal title={`Reset password for ${user.name}`} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        try { await patch(`/users/${user.id}`, { password: pw }); toast('Password reset. The user was signed out everywhere.'); onClose(); }
        catch (err) { setError(err.message); }
      }}>
        <label className="field"><span>New password</span><input autoFocus required minLength={8} type="text" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <div className="row end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Reset password</button></div>
      </form>
    </Modal>
  );
}
