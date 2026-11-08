// A meeting (/meet/:code): first a check of camera and microphone ("Ready to join?"), then the call:
// everyone's video in a grid, with controls for the microphone, camera, screen sharing, raising a hand,
// reactions, the meeting's chat and who's here.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { get } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { Avatar, useToast } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';
import { Mesh } from './mesh.js';
import { columnsFor, whoIsHere, elapsed } from './meetmath.js';
import { MeetingRecorder } from './recorder.js';

const REACTIONS = ['👍', '❤️', '😂', '😮', '👏', '🎉'];

async function openDevices() {
  if (!navigator.mediaDevices?.getUserMedia) return { stream: null, error: 'This browser can’t use a camera or microphone here (Meet needs HTTPS).' };
  for (const want of [{ audio: true, video: true }, { audio: true }, { video: true }]) {
    try { return { stream: await navigator.mediaDevices.getUserMedia(want), error: null }; } catch { /* try with less */ }
  }
  return { stream: null, error: 'No camera or microphone could be used. You can still join, see and hear others, and chat.' };
}

function Video({ stream, muted, mirror, label }) {
  const ref = useRef();
  useEffect(() => { if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream || null; }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} aria-label={label} className={mirror ? 'mirror' : ''} />;
}

export default function MeetRoom() {
  const { code } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [local, setLocal] = useState(null); // { stream, error }
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [phase, setPhase] = useState('lobby'); // lobby | call | left
  const [leftWhy, setLeftWhy] = useState(''); // why the meeting ended for you (removed, full…)
  const mesh = useRef(null);
  const [, redraw] = useReducer((n) => n + 1, 0);
  const [panel, setPanel] = useState(null); // chat | people
  const [messages, setMessages] = useState([]);
  const [unread, setUnread] = useState(0);
  const [floating, setFloating] = useState([]); // reactions shown for a moment
  const [startedAt, setStartedAt] = useState(0);
  const [, tick] = useReducer((n) => n + 1, 0);
  const panelRef = useRef(panel);
  panelRef.current = panel;

  useEffect(() => { document.title = 'Meet'; get(`/meet/${code}`).then(setInfo).catch((e) => setError(e.message)); }, [code]);
  useEffect(() => { if (info?.title) document.title = `${info.title} – Meet`; }, [info?.title]);
  // The lobby asks for the camera and microphone straight away, for the preview.
  useEffect(() => { let gone = false; openDevices().then((d) => { if (gone) d.stream?.getTracks().forEach((t) => t.stop()); else setLocal(d); }); return () => { gone = true; }; }, []);
  // Who's already in the meeting, while you're in the lobby.
  useEffect(() => {
    if (phase !== 'lobby' || error) return undefined;
    const t = setInterval(() => get(`/meet/${code}`).then(setInfo).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [phase, code, error]);
  useEffect(() => () => mesh.current?.leave(), []);
  useEffect(() => { if (phase !== 'call') return undefined; const t = setInterval(tick, 1000); return () => clearInterval(t); }, [phase]);

  const toggleMic = () => { const on = !mic; setMic(on); if (mesh.current) mesh.current.setMic(on); else local?.stream?.getAudioTracks().forEach((t) => { t.enabled = on; }); };
  const toggleCam = () => { const on = !cam; setCam(on); if (mesh.current) mesh.current.setCam(on); else local?.stream?.getVideoTracks().forEach((t) => { t.enabled = on; }); };
  const hasAudio = !!local?.stream?.getAudioTracks().length;
  const hasVideo = !!local?.stream?.getVideoTracks().length;

  const join = useCallback(() => {
    const m = new Mesh({
      code, stream: local?.stream, iceServers: info?.ice_servers || [], mic: mic && hasAudio, cam: cam && hasVideo,
      onChange: redraw,
      onChat: (msg) => { setMessages((list) => [...list.slice(-199), msg]); if (panelRef.current !== 'chat' && !msg.mine) setUnread((n) => n + 1); },
      onReact: (r) => {
        const key = Math.random();
        setFloating((list) => [...list, { ...r, key }]);
        setTimeout(() => setFloating((list) => list.filter((x) => x.key !== key)), 3000);
      },
      onClosed: (reason) => { toast(reason, 'error'); setLeftWhy(reason); setPhase('left'); },
      onMuted: (by) => { setMic(false); toast(`${by} muted you. Unmute when you want to speak.`); },
    });
    mesh.current = m;
    m.connect();
    setStartedAt(Date.now());
    setPhase('call');
  }, [code, local, info, mic, cam, hasAudio, hasVideo, toast]);

  // Recording (in this browser), saved to your Drive when it stops.
  const recorder = useRef(null);
  const [saving, setSaving] = useState(false);
  const gridRef = useRef(null);
  const startRecording = () => {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) { toast('This browser can’t record', 'error'); return; }
    const m = mesh.current;
    const r = new MeetingRecorder({ grid: gridRef.current, streams: () => [m.screen?.getAudioTracks?.().length ? m.screen : null, local?.stream, ...[...m.peers.values()].map((p) => p.stream)].filter(Boolean) });
    r.start();
    recorder.current = r;
    m.setState({ rec: true });
    toast('Recording. Everyone in the meeting can see that you are.');
  };
  const stopRecording = async () => {
    const r = recorder.current;
    if (!r) return;
    recorder.current = null;
    mesh.current?.setState({ rec: false });
    setSaving(true);
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    try { const f = await r.stop(`${info?.title || code} ${stamp}`); toast(`Saved “${f.name}” to Meet recordings in your Drive`); }
    catch (e) { toast(`The recording couldn’t be saved: ${e.message}`, 'error'); }
    finally { setSaving(false); }
  };
  const leave = async () => { if (recorder.current) await stopRecording(); mesh.current?.leave(); mesh.current = null; setPhase('left'); setMessages([]); };

  if (error) {
    return (
      <div className="meet-page meet-center">
        <div className="meet-card stack" role="alert"><h1>Can’t join this meeting</h1><p className="muted">{error}</p>
          <div><button type="button" className="btn primary" onClick={() => navigate('/meet')}>Back to Meet</button></div></div>
      </div>
    );
  }

  if (phase === 'left') {
    return (
      <div className="meet-page meet-center">
        <div className="meet-card stack"><h1>{/removed you/.test(leftWhy) ? 'You were removed from the meeting' : 'You left the meeting'}</h1>
          {leftWhy && <p className="muted" role="status" style={{ margin: 0 }}>{leftWhy}</p>}
          <div className="row">{!/removed you/.test(leftWhy) && <button type="button" className="btn primary" onClick={() => { setLeftWhy(''); setLocal(null); setPhase('lobby'); openDevices().then(setLocal); }}>Rejoin</button>}
            <button type="button" className="btn" onClick={() => navigate('/meet')}>Back to Meet</button></div></div>
      </div>
    );
  }

  if (phase === 'lobby') {
    const names = (info?.people || []).map((p) => p.user.name);
    const full = info && info.people.length >= info.max;
    return (
      <div className="meet-page meet-center">
        <div className="meet-lobby">
          <div className="meet-tile meet-preview">
            {hasVideo && cam ? <Video stream={local.stream} muted mirror label="Your camera" /> : <div className="meet-avatar"><Avatar name={user.name} userId={user.id} size={88} /></div>}
            <div className="meet-lobby-controls">
              <button type="button" className={`meet-btn ${mic && hasAudio ? '' : 'off'}`} disabled={!hasAudio} aria-pressed={mic && hasAudio} aria-label={mic ? 'Turn off microphone' : 'Turn on microphone'} onClick={toggleMic}>{mic && hasAudio ? '🎙' : '🔇'}</button>
              <button type="button" className={`meet-btn ${cam && hasVideo ? '' : 'off'}`} disabled={!hasVideo} aria-pressed={cam && hasVideo} aria-label={cam ? 'Turn off camera' : 'Turn on camera'} onClick={toggleCam}>{cam && hasVideo ? '📷' : '🚫'}</button>
            </div>
          </div>
          <div className="stack meet-lobby-side">
            <h1>{info?.title || 'Ready to join?'}</h1>
            {info?.title && <p className="muted" style={{ margin: 0 }}>Ready to join?</p>}
            <p style={{ margin: 0 }}>{info ? whoIsHere(names) : 'Checking who’s here…'}</p>
            {local?.error && <p className="muted small" style={{ margin: 0 }}>{local.error}</p>}
            {full ? <p className="error">This meeting is full ({info.max} people).</p> : <div><button type="button" className="btn primary" disabled={!info || !local} onClick={join}>Join now</button></div>}
            <p className="muted small" style={{ margin: 0 }}>Code: <strong>{code}</strong> · <button type="button" className="link-btn small" onClick={() => copyLink(code, toast)}>Copy link</button></p>
            <div><button type="button" className="link-btn small" onClick={() => navigate('/meet')}>Back</button></div>
          </div>
        </div>
      </div>
    );
  }

  const m = mesh.current;
  const peers = m ? [...m.peers.values()] : [];
  const sharing = m?.state.screen;
  const tiles = [{ id: 'me', me: true, name: `${user.name} (you)`, userId: user.id, state: m?.state || {}, stream: sharing ? m.screen : local?.stream },
    ...peers.map((p) => ({ id: p.id, name: p.user.name, userId: p.user.id, state: p.state, stream: p.stream, connecting: p.pc.connectionState !== 'connected' }))];
  const sendChat = (e) => {
    e.preventDefault();
    const input = e.currentTarget.elements.msg;
    if (input.value.trim()) m.chat(input.value);
    input.value = '';
  };
  return (
    <div className="meet-page meet-call">
      {tiles.some((t) => t.state.rec) && <div className="meet-rec-banner" role="status">🔴 {tiles.filter((t) => t.state.rec).map((t) => (t.me ? 'You are' : `${t.name} is`)).join(', ')} recording this meeting</div>}
      <header className="meet-top"><strong className="grow">{info?.title || code}</strong><span className="muted small" aria-label="Time in the meeting">{elapsed(Date.now() - startedAt)}</span></header>
      <div className="meet-body">
        <div ref={gridRef} className="meet-grid" style={{ gridTemplateColumns: `repeat(${columnsFor(tiles.length)}, 1fr)` }} aria-label="People in the meeting">
          {tiles.map((t) => {
            const videoOn = t.me ? (sharing || (t.state.cam && hasVideo)) : (t.state.screen || t.state.cam);
            return (
              <div key={t.id} className={`meet-tile ${t.state.hand ? 'hand' : ''}`} data-name={t.name}>
                {t.stream && <Video stream={t.stream} muted={t.me} mirror={t.me && !sharing} label={`Video of ${t.name}`} />}
                {!videoOn && <div className="meet-avatar"><Avatar name={t.name} userId={t.userId} size={72} /></div>}
                <span className="meet-name">{t.state.mic === false && <span aria-label="muted" title="Muted">🔇 </span>}{t.name}{t.state.screen ? ' · presenting' : ''}{t.connecting ? ' · connecting…' : ''}</span>
                {t.state.hand && <span className="meet-hand" aria-label="Hand raised">✋</span>}
                <span className="meet-floats" aria-hidden="true">{floating.filter((f) => f.id === t.id).map((f) => <span key={f.key}>{f.emoji}</span>)}</span>
              </div>
            );
          })}
        </div>
        {panel && (
          <aside className="meet-panel" aria-label={panel === 'chat' ? 'Meeting chat' : 'People'}>
            <div className="row"><strong className="grow">{panel === 'chat' ? 'Messages' : `People (${tiles.length})`}</strong>
              <button type="button" className="icon-btn" aria-label="Close panel" onClick={() => setPanel(null)}><Icon name="close" size={18} /></button></div>
            {panel === 'chat' ? <>
              <p className="muted small" style={{ margin: 0 }}>Messages are only seen by people in the meeting now, and go when it ends.</p>
              <ul className="meet-chat" aria-live="polite">
                {messages.map((msg, i) => <li key={i}><strong>{msg.mine ? 'You' : msg.name}</strong> <span className="muted small">{new Date(msg.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span><div>{msg.text}</div></li>)}
              </ul>
              <form className="row" onSubmit={sendChat}><input name="msg" className="grow" aria-label="Send a message to everyone" placeholder="Send a message" maxLength={2000} autoComplete="off" /><button className="btn">Send</button></form>
            </> : (
              <ul className="meet-people">
                {m.host && tiles.length > 1 && <li className="row"><span className="grow muted small">You started this meeting.</span><button type="button" className="btn small" onClick={() => { m.mute('all'); toast('Everyone else is muted'); }}>Mute everyone</button></li>}
                {tiles.map((t) => <li key={t.id} className="row"><Avatar name={t.name} userId={t.userId} size={28} /><span className="grow">{t.name}</span>{t.state.hand && '✋'}{t.state.mic === false && '🔇'}
                  {m.host && !t.me && <>
                    {t.state.mic !== false && <button type="button" className="icon-btn" aria-label={`Mute ${t.name}`} title="Mute" onClick={() => m.mute(t.id)}>🔇</button>}
                    <button type="button" className="icon-btn" aria-label={`Remove ${t.name} from the meeting`} title="Remove from the meeting" onClick={() => { if (window.confirm(`Remove ${t.name} from the meeting? They won't be able to join again.`)) m.remove(t.id); }}><Icon name="close" size={16} /></button>
                  </>}</li>)}
              </ul>
            )}
          </aside>
        )}
      </div>
      <footer className="meet-bar" role="toolbar" aria-label="Meeting controls">
        <button type="button" className={`meet-btn ${m.state.mic ? '' : 'off'}`} disabled={!hasAudio} aria-pressed={m.state.mic} aria-label={m.state.mic ? 'Turn off microphone' : 'Turn on microphone'} onClick={toggleMic}>{m.state.mic ? '🎙' : '🔇'}</button>
        <button type="button" className={`meet-btn ${m.state.cam ? '' : 'off'}`} disabled={!hasVideo} aria-pressed={m.state.cam} aria-label={m.state.cam ? 'Turn off camera' : 'Turn on camera'} onClick={toggleCam}>{m.state.cam ? '📷' : '🚫'}</button>
        {navigator.mediaDevices?.getDisplayMedia && <button type="button" className={`meet-btn ${sharing ? 'on' : ''}`} aria-pressed={!!sharing} aria-label={sharing ? 'Stop presenting' : 'Present your screen'}
          onClick={() => (sharing ? m.stopScreen() : m.shareScreen().catch(() => {}))}>🖥</button>}
        <button type="button" className={`meet-btn ${m.state.hand ? 'on' : ''}`} aria-pressed={m.state.hand} aria-label={m.state.hand ? 'Lower hand' : 'Raise hand'} onClick={() => m.setState({ hand: !m.state.hand })}>✋</button>
        <span className="meet-reacts" role="group" aria-label="Send a reaction">{REACTIONS.map((e) => <button key={e} type="button" className="meet-react" aria-label={`React ${e}`} onClick={() => m.react(e)}>{e}</button>)}</span>
        <button type="button" className={`meet-btn ${panel === 'chat' ? 'on' : ''}`} aria-label={unread ? `Chat, ${unread} new` : 'Chat'} onClick={() => { setPanel(panel === 'chat' ? null : 'chat'); setUnread(0); }}>💬{unread > 0 && <span className="nav-badge">{unread}</span>}</button>
        <button type="button" className={`meet-btn ${panel === 'people' ? 'on' : ''}`} aria-label="People" onClick={() => setPanel(panel === 'people' ? null : 'people')}>👥</button>
        <button type="button" className={`meet-btn ${m.state.rec ? 'on rec' : ''}`} disabled={saving} aria-pressed={!!m.state.rec} aria-label={saving ? 'Saving the recording' : m.state.rec ? 'Stop recording' : 'Record the meeting'} title={m.state.rec ? 'Stop and save it to your Drive' : 'Record the meeting (saved to your Drive)'} onClick={m.state.rec ? stopRecording : startRecording}>{saving ? '…' : '⏺'}</button>
        <button type="button" className="meet-btn" aria-label="Copy meeting link" onClick={() => copyLink(code, toast)}>🔗</button>
        <button type="button" className="meet-btn leave" aria-label="Leave the meeting" onClick={leave}>Leave</button>
      </footer>
    </div>
  );
}

async function copyLink(code, toast) {
  const link = `${location.origin}/meet/${code}`;
  try { await navigator.clipboard.writeText(link); toast('Meeting link copied'); } catch { toast(link); }
}
