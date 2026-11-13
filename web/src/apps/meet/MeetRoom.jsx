// A meeting (/meet/:code): first a check of camera and microphone ("Ready to join?"), then the call:
// everyone's video in a grid, with controls for the microphone, camera, screen sharing, raising a hand,
// reactions, the meeting's chat and who's here.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { get, post, onLive } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import { Avatar, useToast } from '../../components/ui.jsx';
import { useAuth } from '../../App.jsx';
import MeetBoard from './MeetBoard.jsx';
import { Mesh } from './mesh.js';
import { columnsFor, whoIsHere, elapsed, spotlightOf, loudness, speakingNow, SPEAKING_LEVEL, countdown, TIMER_CHOICES } from './meetmath.js';
import { MeetingRecorder } from './recorder.js';
import { Attendance, KeptChat, useMeetPast } from '../../components/MeetHistory.jsx';
import { savedDevices, saveDevices, deviceAsks, deviceLists, canPickSpeaker, meterPercent } from './devices.js';
import { noPhotos } from '../../components/photos.js';

const REACTIONS = ['👍', '❤️', '😂', '😮', '👏', '🎉'];

// Polls asked during the meeting: everyone votes once (and can change it); counts show live; the asker
// or the host closes a poll. They last as long as the meeting does.
function MeetPolls({ m, user, polls }) {
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const ask = (e) => {
    e.preventDefault();
    const opts = options.map((o) => o.trim()).filter(Boolean);
    if (!question.trim() || new Set(opts).size < 2) return;
    m.pollNew(question.trim(), opts);
    setQuestion(''); setOptions(['', '']); setAsking(false);
  };
  return (
    <div className="meet-polls">
      {polls.length === 0 && !asking && <p className="muted small" style={{ margin: 0 }}>No polls yet. Ask everyone a quick question.</p>}
      <ul className="meet-poll-list">
        {[...polls].reverse().map((p) => {
          const total = p.voters || 0;
          return (
            <li key={p.id} className="meet-poll" aria-label={`Poll: ${p.question}`}>
              <strong>{p.question}</strong>
              <div className="muted small">{p.by === user.id ? 'You' : p.by_name} asked · {total} {total === 1 ? 'vote' : 'votes'}{p.closed ? ' · closed' : ''}</div>
              {p.options.map((o, i) => {
                const n = p.counts[i] || 0;
                const pct = total ? Math.round((n / total) * 100) : 0;
                return (
                  <button key={o} type="button" className={`meet-poll-opt ${p.mine === i ? 'mine' : ''}`} disabled={p.closed} aria-pressed={p.mine === i}
                    aria-label={`Vote ${o}, ${n} ${n === 1 ? 'vote' : 'votes'}`} onClick={() => m.pollVote(p.id, i)}>
                    <span className="meet-poll-bar" style={{ width: `${pct}%` }} />
                    <span className="grow">{p.mine === i ? '✓ ' : ''}{o}</span><span className="small">{n} · {pct}%</span>
                  </button>
                );
              })}
              {!p.closed && (p.by === user.id || m.host) && <button type="button" className="btn small" onClick={() => m.pollClose(p.id)}>Close poll</button>}
            </li>
          );
        })}
      </ul>
      {asking ? (
        <form className="meet-poll-form" onSubmit={ask} aria-label="New poll">
          <input value={question} onChange={(e) => setQuestion(e.target.value)} aria-label="Question" placeholder="Ask a question" maxLength={300} autoFocus />
          {options.map((o, i) => (
            <div key={i} className="row">
              <input className="grow" value={o} aria-label={`Option ${i + 1}`} placeholder={`Option ${i + 1}`} maxLength={100}
                onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} />
              {options.length > 2 && <button type="button" className="icon-btn" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions(options.filter((_, j) => j !== i))}><Icon name="close" size={14} /></button>}
            </div>
          ))}
          <div className="row">
            {options.length < 10 && <button type="button" className="btn small" onClick={() => setOptions([...options, ''])}>Add option</button>}
            <span className="grow" />
            <button type="button" className="btn small" onClick={() => setAsking(false)}>Cancel</button>
            <button className="btn primary small">Ask</button>
          </div>
        </form>
      ) : <button type="button" className="btn" onClick={() => setAsking(true)}>New poll</button>}
    </div>
  );
}

// Breakout rooms, for the host: open 2–8 rooms (people are shared out between them), move someone,
// visit a room, and bring everyone back. Guests stay in the main room.
function Breakouts({ m, goToRoom }) {
  const [count, setCount] = useState(2);
  const b = m.breakouts;
  if (!b || !b.count) {
    const people = [...m.peers.values()].filter((p) => !/\(guest\)$/.test(p.user.name));
    const open = () => {
      const assign = {};
      people.forEach((p, i) => { assign[p.id] = (i % count) + 1; });
      m.breakoutOpen(count, assign);
    };
    return (
      <div className="meet-breakouts row" aria-label="Breakout rooms">
        <span className="grow small">Breakout rooms</span>
        <select aria-label="Number of rooms" value={count} onChange={(e) => setCount(Number(e.target.value))}>
          {[2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n} rooms</option>)}
        </select>
        <button type="button" className="btn small" disabled={people.length < 1} onClick={open}>Open rooms</button>
      </div>
    );
  }
  return (
    <div className="meet-breakouts stack" aria-label="Breakout rooms">
      <div className="row"><strong className="grow small">Breakout rooms are open</strong><button type="button" className="btn small primary" onClick={() => m.breakoutClose()}>Bring everyone back</button></div>
      {b.rooms.map((r) => (
        <div key={r.n} className="meet-breakout-room" aria-label={r.n ? `Room ${r.n}` : 'Main room'}>
          <div className="row"><span className="grow small"><strong>{r.n ? `Room ${r.n}` : 'Main room'}</strong>{m.room === r.n ? ' · you’re here' : ''}</span>
            {m.room !== r.n && <button type="button" className="link-btn small" aria-label={r.n ? `Go to Room ${r.n}` : 'Go to the main room'} onClick={() => goToRoom(r.n)}>Go</button>}</div>
          {r.people.length === 0 && <div className="muted small">Nobody yet</div>}
          {r.people.filter((p) => p.id !== m.id).map((p) => (
            <div key={p.id} className="row small"><span className="grow">{p.name}</span>
              {!p.guest && <select aria-label={`Move ${p.name}`} value={r.n} onChange={(e) => m.breakoutMove(p.id, Number(e.target.value))}>
                {Array.from({ length: b.count + 1 }, (_, n) => <option key={n} value={n}>{n ? `Room ${n}` : 'Main room'}</option>)}
              </select>}</div>
          ))}
        </div>
      ))}
    </div>
  );
}

// Q&A: questions for whoever is presenting; people upvote the ones they want answered (most votes
// first), and the asker or the host marks them answered. They last as long as the meeting does.
function MeetQA({ m }) {
  const [text, setText] = useState('');
  const list = [...m.questions.values()].sort((a, b) => (a.answered - b.answered) || (b.votes - a.votes) || (a.at - b.at));
  const ask = (e) => { e.preventDefault(); if (text.trim()) { m.ask(text.trim()); setText(''); } };
  return (
    <div className="meet-polls">
      <form className="meet-poll-form" onSubmit={ask}>
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} aria-label="Your question" placeholder="Ask a question" maxLength={500}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) ask(e); }} />
        <div className="row"><span className="grow muted small">Everyone in the meeting sees who asked.</span><button className="btn primary small" disabled={!text.trim()}>Ask</button></div>
      </form>
      {list.length === 0 && <p className="muted small" style={{ margin: 0 }}>No questions yet.</p>}
      <ul className="meet-poll-list">
        {list.map((x) => (
          <li key={x.id} className={`meet-question ${x.answered ? 'answered' : ''}`} aria-label={`Question: ${x.text}`}>
            <div>{x.text}</div>
            <div className="row small">
              <span className="grow muted">{x.mine ? 'You' : x.by_name}{x.answered ? ' · answered' : ''}</span>
              <button type="button" className={`meet-upvote ${x.voted ? 'on' : ''}`} disabled={x.mine || x.answered} aria-pressed={x.voted}
                aria-label={`Upvote, ${x.votes} ${x.votes === 1 ? 'vote' : 'votes'}`} title={x.mine ? 'Your question' : 'Upvote'} onClick={() => m.upvote(x.id, !x.voted)}>👍 {x.votes}</button>
              {(x.mine || m.host) && <>
                <button type="button" className="link-btn small" onClick={() => m.markAnswered(x.id, !x.answered)}>{x.answered ? 'Not answered' : 'Mark answered'}</button>
                <button type="button" className="icon-btn" aria-label="Take the question away" onClick={() => m.unask(x.id)}><Icon name="close" size={14} /></button>
              </>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Ask a colleague to join from inside the meeting: their screen rings (as a call from Chat does). */
function AskToJoin({ code, here }) {
  const toast = useToast();
  const [people, setPeople] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { get('/users/directory').then(setPeople).catch(() => setPeople([])); }, []);
  const choices = people.filter((p) => !here.includes(p.id));
  const ask = async (e) => {
    e.preventDefault();
    const t = text.trim().toLowerCase();
    const who = choices.find((p) => p.name.toLowerCase() === t || p.username.toLowerCase() === t || `${p.name} (${p.username})`.toLowerCase() === t);
    if (!who) { toast('Pick a colleague from the list', 'error'); return; }
    setBusy(true);
    try { await post(`/meet/${code}/invite`, { user_ids: [who.id] }); toast(`Ringing ${who.name}…`); setText(''); } catch (err) { toast(err.message, 'error'); }
    setBusy(false);
  };
  return (
    <form className="row meet-ask" onSubmit={ask}>
      <input className="grow" list="meet-ask-people" aria-label="Ask someone to join" placeholder="Ask someone to join…" value={text} onChange={(e) => setText(e.target.value)} />
      <datalist id="meet-ask-people">{choices.map((p) => <option key={p.id} value={`${p.name} (${p.username})`} />)}</datalist>
      <button type="submit" className="btn small" disabled={busy || !text.trim()}>📞 Ring</button>
    </form>
  );
}

/** How loud your microphone is, live (so you can see it hears you before joining). */
function MicMeter({ stream }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    const track = stream?.getAudioTracks()[0];
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!track || !AC) return undefined;
    let ctx, raf, last = 0;
    try {
      ctx = new AC();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(new MediaStream([track])).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const loop = (t) => {
        if (t - last > 100) { last = t; an.getByteTimeDomainData(buf); setLevel(track.enabled ? meterPercent(loudness(buf)) : 0); }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    } catch { return undefined; }
    return () => { cancelAnimationFrame(raf); ctx?.close().catch(() => {}); };
  }, [stream]);
  if (!stream?.getAudioTracks().length) return null;
  return <meter className="mic-meter" min={0} max={100} low={5} value={level} aria-label="Microphone level" title={level ? 'Your microphone hears you' : 'Say something to check your microphone'} />;
}

/** A short tone on the chosen speaker, to check you'll hear the others. */
function SpeakerTest({ sink }) {
  const [playing, setPlaying] = useState(false);
  const ref = useRef();
  const play = async () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || playing) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();
    osc.frequency.value = 660; gain.gain.value = 0.2;
    osc.connect(gain).connect(dest);
    setPlaying(true);
    const el = ref.current;
    try { if (sink && el.setSinkId) await el.setSinkId(sink); } catch { /* the default speaker */ }
    el.srcObject = dest.stream;
    osc.start();
    el.play().catch(() => {});
    setTimeout(() => { osc.stop(); ctx.close().catch(() => {}); setPlaying(false); }, 800);
  };
  return (
    <span className="row" style={{ gap: 8 }}>
      <button type="button" className="btn small" onClick={play} disabled={playing}>{playing ? '🔊 Playing…' : '🔊 Test speaker'}</button>
      <audio ref={ref} aria-label="Speaker test" />
    </span>
  );
}

/** Camera and microphone choices (the lobby, and ⚙ in the meeting). The list follows devices plugged in or out. */
function DevicePicker({ stream, onPick, sink, onSpeaker }) {
  const [lists, setLists] = useState({ mics: [], cams: [], spks: [] });
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return undefined;
    const load = () => md.enumerateDevices().then((d) => setLists(deviceLists(d))).catch(() => {});
    load();
    md.addEventListener?.('devicechange', load);
    return () => md.removeEventListener?.('devicechange', load);
  }, [stream]);
  const using = (kind) => stream?.[kind === 'mic' ? 'getAudioTracks' : 'getVideoTracks']()[0]?.getSettings?.().deviceId || '';
  const pick = (kind, id) => { const next = { ...savedDevices(), [kind]: id }; saveDevices(next); if (kind === 'spk') onSpeaker?.(id); else onPick(next); };
  return (
    <div className="stack meet-devices" style={{ gap: 6 }}>
      <label className="field"><span className="small">Camera</span>
        <select aria-label="Camera" value={using('cam')} onChange={(e) => pick('cam', e.target.value)} disabled={!lists.cams.length}>
          {!lists.cams.length && <option value="">No camera found</option>}
          {lists.cams.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select></label>
      <label className="field"><span className="small">Microphone</span>
        <select aria-label="Microphone" value={using('mic')} onChange={(e) => pick('mic', e.target.value)} disabled={!lists.mics.length}>
          {!lists.mics.length && <option value="">No microphone found</option>}
          {lists.mics.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select></label>
      <MicMeter stream={stream} />
      {onSpeaker && canPickSpeaker() && lists.spks.length > 0 && <label className="field"><span className="small">Speaker</span>
        <select aria-label="Speaker" value={lists.spks.some((d) => d.id === sink) ? sink : lists.spks[0].id} onChange={(e) => pick('spk', e.target.value)}>
          {lists.spks.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select></label>}
      {onSpeaker && <SpeakerTest sink={sink} />}
    </div>
  );
}

async function openDevices(choice = savedDevices()) {
  if (!navigator.mediaDevices?.getUserMedia) return { stream: null, error: 'This browser can’t use a camera or microphone here (Meet needs HTTPS).' };
  for (const want of deviceAsks(choice)) {
    try { return { stream: await navigator.mediaDevices.getUserMedia(want), error: null }; } catch { /* try with less */ }
  }
  return { stream: null, error: 'No camera or microphone could be used. You can still join, see and hear others, and chat.' };
}

const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

function Video({ stream, muted, mirror, label, sink }) {
  const ref = useRef();
  useEffect(() => { if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream || null; }, [stream]);
  // The speaker chosen in ⚙ (where the browser can choose; '' is its default).
  useEffect(() => { if (!muted && sink !== undefined && ref.current?.setSinkId && ref.current.sinkId !== sink) ref.current.setSinkId(sink).catch(() => {}); }, [sink, muted, stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} aria-label={label} className={mirror ? 'mirror' : ''} />;
}

export default function MeetRoom({ guest = false, onSignIn }) {
  const { code } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  // Someone you rang can't talk (they pressed Can't talk): say so while you wait here.
  useEffect(() => onLive((x) => { if (x.type === 'ring-declined' && x.code === code) toast(`${x.by} can’t talk right now`); }), [code, toast]);
  const mesh = useRef(null);
  const { user: account } = useAuth();
  // A guest (no account) gives their name in the lobby; everyone sees "Name (guest)".
  // A guest's name: from the link (?name=, as in a booking confirmation), or the one they used last time.
  const [guestName, setGuestName] = useState(() => { const fromLink = new URLSearchParams(window.location.search).get('name'); if (fromLink) return fromLink.slice(0, 60); try { return localStorage.getItem('nw-guest-name') || ''; } catch { return ''; } });
  if (guest) noPhotos();
  const user = guest ? { id: mesh.current?.you || 'guest', name: guestName.trim() || 'Guest' } : account;
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [local, setLocal] = useState(null); // { stream, error }
  const [sink, setSink] = useState(() => savedDevices().spk); // the speaker others are heard on
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [phase, setPhase] = useState('lobby'); // lobby | call | left
  const [leftWhy, setLeftWhy] = useState(''); // why the meeting ended for you (removed, full…)
  const [, redraw] = useReducer((n) => n + 1, 0);
  const [panel, setPanel] = useState(null); // chat | people
  const [messages, setMessages] = useState([]);
  const [unread, setUnread] = useState(0);
  const [newQs, setNewQs] = useState(0); // questions asked while Q&A was closed
  const [pinned, setPinned] = useState(null); // shown big, just for you
  const [board, setBoard] = useState(false); // the whiteboard is open
  const [boardNew, setBoardNew] = useState(0); // strokes others drew while it was closed
  const boardRef = useRef(board);
  boardRef.current = board;
  const [floating, setFloating] = useState([]); // reactions shown for a moment
  const [startedAt, setStartedAt] = useState(0);
  const startedRef = useRef(0);
  startedRef.current = startedAt;
  const [stayed, setStayed] = useState(0); // how long you were in the meeting, for the screen after it
  const [leftAt, setLeftAt] = useState(0);
  const [past] = useMeetPast(phase === 'left' && !guest ? code : null, leftAt);
  const [showing, setShowing] = useState(null); // after the meeting: 'people' | 'chat'
  const noteLeft = () => { setStayed(startedRef.current ? Date.now() - startedRef.current : 0); setTimeout(() => setLeftAt(Date.now()), 600); };
  const [, tick] = useReducer((n) => n + 1, 0);
  const panelRef = useRef(panel);
  panelRef.current = panel;

  useEffect(() => { document.title = 'Meet'; get(`${guest ? '/public' : ''}/meet/${code}`).then(setInfo).catch((e) => setError(e.message)); }, [code, guest]);
  useEffect(() => { if (info?.title) document.title = `${info.title} – Meet`; }, [info?.title]);
  // The lobby asks for the camera and microphone straight away, for the preview.
  useEffect(() => { let gone = false; openDevices().then((d) => { if (gone) d.stream?.getTracks().forEach((t) => t.stop()); else setLocal(d); }); return () => { gone = true; }; }, []);
  // Who's already in the meeting, while you're in the lobby.
  useEffect(() => {
    if (phase !== 'lobby' || error) return undefined;
    const t = setInterval(() => get(`${guest ? '/public' : ''}/meet/${code}`).then(setInfo).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [phase, code, error, guest]);
  useEffect(() => () => mesh.current?.leave(), []);
  useEffect(() => { if (phase !== 'call') return undefined; const t = setInterval(tick, 1000); return () => clearInterval(t); }, [phase]);

  const toggleMic = () => { const on = !mic; setMic(on); if (mesh.current) mesh.current.setMic(on); else local?.stream?.getAudioTracks().forEach((t) => { t.enabled = on; }); };
  const toggleCam = () => { const on = !cam; setCam(on); if (mesh.current) mesh.current.setCam(on); else local?.stream?.getVideoTracks().forEach((t) => { t.enabled = on; }); };
  const hasAudio = !!local?.stream?.getAudioTracks().length;
  const hasVideo = !!local?.stream?.getVideoTracks().length;
  // Another camera or microphone: open it, and in the meeting send it in place of the old one.
  const changeDevices = async (choice) => {
    const d = await openDevices(choice);
    if (!d.stream) { toast(d.error, 'error'); return; }
    d.stream.getAudioTracks().forEach((t) => { t.enabled = mic; });
    d.stream.getVideoTracks().forEach((t) => { t.enabled = cam; });
    if (mesh.current) mesh.current.swapStream(d.stream);
    else local?.stream?.getTracks().forEach((t) => t.stop());
    setLocal(d);
  };

  const joinRef = useRef(null);
  const join = useCallback((room = 0) => {
    if (guest) { try { localStorage.setItem('nw-guest-name', guestName.trim()); } catch { /* private mode */ } }
    const m = new Mesh({
      code, room, guestName: guest ? guestName.trim() : '', stream: local?.stream, iceServers: info?.ice_servers || [], mic: mic && hasAudio, cam: cam && hasVideo,
      onChange: redraw,
      onChat: (msg) => { setMessages((list) => [...list.slice(-199), msg]); if (panelRef.current !== 'chat' && !msg.mine) setUnread((n) => n + 1); },
      onReact: (r) => {
        const key = Math.random();
        setFloating((list) => [...list, { ...r, key }]);
        setTimeout(() => setFloating((list) => list.filter((x) => x.key !== key)), 3000);
      },
      onClosed: (reason) => { toast(reason, /ended the meeting/.test(reason) ? undefined : 'error'); noteLeft(); setLeftWhy(reason); setPhase('left'); },
      onLocked: (l) => toast(l.on ? `${l.by === user?.name ? 'You' : l.by} locked the meeting: nobody new can join` : `${l.by === user?.name ? 'You' : l.by} opened the meeting again`),
      // The whiteboard: someone else drew while it's closed here; the first time, say who.
      onBoard: (msg) => {
        if (msg.type !== 'wb-stroke' || boardRef.current || msg.stroke.by === mesh.current?.id) return;
        setBoardNew((n) => { if (!n) toast(`${msg.name} is drawing on the whiteboard`); return n + 1; });
      },
      onQuestion: (x) => { if (panelRef.current !== 'qa' && !x.mine) setNewQs((n) => n + 1); },
      onPoll: (p) => { if (panelRef.current !== 'polls') toast(`${p.by_name} asked: ${p.question}`); },
      // Breakout rooms: off to another room (or back to the main one), keeping camera and microphone.
      onBreakout: ({ room: to, by }) => { toast(to ? `${by} moved you to Room ${to}` : `${by} brought everyone back to the main room`); goToRoom(to); },
      onMuted: (by) => { setMic(false); toast(by ? `${by} muted you. Unmute when you want to speak.` : 'You joined muted (the host asks everyone to). Unmute when you want to speak.'); },
      onStopPresent: (reason) => toast(reason),
      onHost: (x) => toast(x.host ? `${x.by} made you a co-host: you have the host’s controls` : `${x.by} took back your co-host controls`),
      onLowered: (by) => toast(`${by} lowered your hand`),
    });
    mesh.current = m;
    m.connect();
    setStartedAt((t) => t || Date.now()); // the time in the meeting carries on across rooms
    setPhase('call');
  }, [code, local, info, mic, cam, hasAudio, hasVideo, toast, guest, guestName]);
  joinRef.current = join;
  function goToRoom(n) {
    const old = mesh.current;
    if (old) { old.switchAway(); mesh.current = null; }
    setMessages([]); setUnread(0);
    joinRef.current(n);
  }

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
  const leave = async () => { if (recorder.current) await stopRecording(); noteLeft(); mesh.current?.leave(); mesh.current = null; setStartedAt(0); setPhase('left'); setMessages([]); };

  const m = mesh.current;
  const peers = m ? [...m.peers.values()] : [];
  const sharing = m?.state.screen;
  // Everyone in the call (you first), who's shown big, and who's talking.
  const tiles = [{ id: 'me', me: true, name: `${user.name} (you)`, userId: user.id, state: m?.state || {}, stream: sharing ? m.screen : local?.stream },
    ...peers.map((p) => ({ id: p.id, name: p.user.name, userId: p.user.id, state: p.state, stream: p.stream, connecting: p.pc.connectionState !== 'connected' }))];
  // Raised hands, first up first: everyone sees the same order.
  const hands = tiles.filter((t) => t.state.hand).sort((a, b) => (a.state.hand_at || 0) - (b.state.hand_at || 0));
  const handNo = (t) => hands.indexOf(t) + 1;
  const cd = countdown(m?.timer);
  const hostSpot = m?.spotlight ? (m.spotlight.id === m.id ? 'me' : m.spotlight.id) : null;
  const spot = spotlightOf(tiles, pinned, hostSpot); // who is shown big (pinned, or presenting)
  const speaking = useSpeaking(tiles);
  if (error) {
    return (
      <div className="meet-page meet-center">
        <div className="meet-card stack" role="alert"><h1>Can’t join this meeting</h1><p className="muted">{error}</p>
          {!guest && <div><button type="button" className="btn primary" onClick={() => navigate('/meet')}>Back to Meet</button></div>}</div>
      </div>
    );
  }

  if (phase === 'left') {
    return (
      <div className="meet-page meet-center">
        <div className="meet-card stack"><h1>{/ended the meeting/.test(leftWhy) ? 'The meeting has ended' : /removed you/.test(leftWhy) ? 'You were removed from the meeting' : /let you in/.test(leftWhy) ? 'You weren’t let in' : /locked/.test(leftWhy) ? 'The meeting is locked' : 'You left the meeting'}</h1>
          {leftWhy && <p className="muted" role="status" style={{ margin: 0 }}>{leftWhy}</p>}
          {stayed >= 1000 && <p className="muted" style={{ margin: 0 }}>You were in it for {elapsed(stayed)}.</p>}
          {past && <div className="row wrap">
            <button type="button" className="btn small" onClick={() => setShowing('people')}>👥 Who joined ({past.people})</button>
            {past.chat > 0 && <button type="button" className="btn small" onClick={() => setShowing('chat')}>💬 Meeting chat ({past.chat})</button>}
          </div>}
          {showing === 'people' && past && <Attendance meeting={past.meeting} onClose={() => setShowing(null)} />}
          {showing === 'chat' && past && <KeptChat meeting={past.meeting} onClose={() => setShowing(null)} />}
          <div className="row">{!/removed you/.test(leftWhy) && <button type="button" className="btn primary" onClick={() => { setLeftWhy(''); setLocal(null); setPhase('lobby'); openDevices().then(setLocal); }}>Rejoin</button>}
            {!guest && <button type="button" className="btn" onClick={() => navigate('/meet')}>Back to Meet</button>}</div></div>
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
            {local?.stream && <DevicePicker stream={local.stream} onPick={changeDevices} sink={sink} onSpeaker={setSink} />}
            {guest && <>
              {info?.company && <p className="muted small" style={{ margin: 0 }}>A meeting at {info.company}. You’re joining as a guest: someone in the meeting lets you in.</p>}
              <label className="stack" style={{ gap: 4 }}><span className="small">Your name</span>
                <input value={guestName} onChange={(e) => setGuestName(e.target.value)} maxLength={60} autoComplete="name" placeholder="So people know who you are" /></label>
            </>}
            {full ? <p className="error">This meeting is full ({info.max} people).</p> : <div><button type="button" className="btn primary" disabled={!info || !local || (guest && !guestName.trim())} onClick={() => join(0)}>{guest ? 'Ask to join' : 'Join now'}</button></div>}
            <p className="muted small" style={{ margin: 0 }}>Code: <strong>{code}</strong> · <button type="button" className="link-btn small" onClick={() => copyLink(code, toast)}>Copy link</button></p>
            {guest ? <p className="muted small" style={{ margin: 0 }}>Have an account here? <button type="button" className="link-btn small" onClick={onSignIn}>Sign in</button></p>
              : <div><button type="button" className="link-btn small" onClick={() => navigate('/meet')}>Back</button></div>}
          </div>
        </div>
      </div>
    );
  }

  if (m?.waiting) {
    return (
      <div className="meet-page meet-center">
        <div className="meet-card stack" role="status"><h1>Asking to join…</h1>
          <p className="muted" style={{ margin: 0 }}>You’ll join {info?.title ? `“${info.title}”` : 'the meeting'} as soon as someone in it lets you in.</p>
          {m.hostTold && <p style={{ margin: 0 }}>Nobody’s in the meeting yet: <strong>{m.hostTold}</strong> has been told you’re here.</p>}
          <div><button type="button" className="btn" onClick={leave}>Cancel</button></div></div>
      </div>
    );
  }
  const polls = m ? [...m.polls.values()] : [];
  const toVote = polls.filter((p) => !p.closed && p.mine === null).length;
  const sendChat = (e) => {
    e.preventDefault();
    const input = e.currentTarget.elements.msg;
    if (input.value.trim()) m.chat(input.value);
    input.value = '';
  };
  return (
    <div className="meet-page meet-call">
      {tiles.some((t) => t.state.rec) && <div className="meet-rec-banner" role="status">🔴 {tiles.filter((t) => t.state.rec).map((t) => (t.me ? 'You are' : `${t.name} is`)).join(', ')} recording this meeting</div>}
      {m.mayAdmit && m.knocking.length > 0 && <div className="meet-knock" role="region" aria-label="Waiting to join">
        {m.knocking.map((g) => <div key={g.id} className="row"><span className="grow"><strong>{g.name}</strong> (guest) wants to join</span>
          <button type="button" className="btn primary small" aria-label={`Let ${g.name} in`} onClick={() => m.admit(g.id)}>Let in</button>
          <button type="button" className="btn small" aria-label={`Don’t let ${g.name} in`} onClick={() => m.deny(g.id)}>Don’t let in</button></div>)}
      </div>}
      {m.room > 0 && !m.host && <div className="meet-room-banner" role="status">You’re in breakout Room {m.room}. The host will bring everyone back to the main room.</div>}
      <header className="meet-top"><strong className="grow">{info?.title || code}{m.room ? ` · Room ${m.room}` : ''}</strong>{cd && <span className={`meet-timer ${cd.up ? 'up' : cd.soon ? 'soon' : ''}`} role="timer" aria-label={cd.up ? 'Time’s up' : `Timer: ${cd.left} left`} title={`Timer started by ${m.timer.by}`}>⏱ {cd.up ? 'Time’s up' : cd.left}</span>}
        {m.host && (cd ? <button type="button" className="btn small meet-timer-btn" onClick={() => m.setTimer(0)}>{cd.up ? 'Clear timer' : 'Stop timer'}</button>
          : <select className="meet-timer-btn" aria-label="Start a timer for everyone" value="" onChange={(e) => { if (e.target.value) m.setTimer(Number(e.target.value)); }}>
            <option value="">⏱ Timer…</option>{TIMER_CHOICES.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>)}
        <span className="muted small" aria-label="Time in the meeting">{elapsed(Date.now() - startedAt)}</span></header>
      <div className="meet-body">
        {board && <MeetBoard m={m} title={info?.title || code} canSave={!guest} onClose={() => setBoard(false)} />}
        <div ref={gridRef} className={`meet-grid ${board ? 'with-board' : ''} ${spot && !board ? 'spotlight' : ''}`} style={spot && !board ? { gridTemplateRows: `repeat(${Math.max(3, tiles.length - 1)}, minmax(0, 1fr))` } : { gridTemplateColumns: `repeat(${columnsFor(tiles.length)}, 1fr)` }} aria-label="People in the meeting">
          {(spot && !board ? [...tiles.filter((t) => t.id === spot), ...tiles.filter((t) => t.id !== spot)] : tiles).map((t) => {
            const videoOn = t.me ? (sharing || (t.state.cam && hasVideo)) : (t.state.screen || t.state.cam);
            const big = spot === t.id && !board;
            return (
              <div key={t.id} className={`meet-tile ${t.state.hand ? 'hand' : ''} ${big ? 'big' : ''} ${speaking.has(t.id) && t.state.mic !== false ? 'speaking' : ''}`} data-name={t.name}>
                {tiles.length > 1 && <button type="button" className={`meet-pin ${pinned === t.id ? 'on' : ''}`} aria-pressed={pinned === t.id}
                  aria-label={pinned === t.id ? `Unpin ${t.me ? 'yourself' : t.name}` : `Pin ${t.me ? 'yourself' : t.name}`} title={pinned === t.id ? 'Unpin' : 'Pin: show big (only for you)'}
                  onClick={() => setPinned(pinned === t.id ? null : t.id)}>📌</button>}
                {m.host && tiles.length > 1 && <button type="button" className={`meet-pin meet-spot-btn ${hostSpot === t.id ? 'on' : ''}`} aria-pressed={hostSpot === t.id}
                  aria-label={hostSpot === t.id ? 'Stop the spotlight' : `Spotlight ${t.me ? 'yourself' : t.name} for everyone`} title={hostSpot === t.id ? 'Stop the spotlight' : 'Spotlight: show big for everyone'}
                  onClick={() => m.setSpotlight(hostSpot === t.id ? null : (t.me ? m.id : t.id))}>🔦</button>}
                {hostSpot === t.id && <span className="meet-spot-tag">Spotlight</span>}
                {t.stream && <Video stream={t.stream} muted={t.me} mirror={t.me && !sharing} label={`Video of ${t.name}`} sink={t.me ? undefined : sink} />}
                {!videoOn && <div className="meet-avatar"><Avatar name={t.name} userId={t.userId} size={72} /></div>}
                <span className="meet-name">{t.state.mic === false && <span aria-label="muted" title="Muted">🔇 </span>}{t.name}{t.state.screen ? ' · presenting' : ''}{t.connecting ? ' · connecting…' : ''}</span>
                {t.state.hand && <span className="meet-hand" aria-label={`Hand raised, ${ordinal(handNo(t))}`} title={`Raised ${ordinal(handNo(t))}`}>✋<small>{handNo(t)}</small></span>}
                <span className="meet-floats" aria-hidden="true">{floating.filter((f) => f.id === t.id).map((f) => <span key={f.key}>{f.emoji}</span>)}</span>
              </div>
            );
          })}
        </div>
        {panel && (
          <aside className="meet-panel" aria-label={panel === 'chat' ? 'Meeting chat' : panel === 'polls' ? 'Polls' : panel === 'qa' ? 'Questions' : panel === 'devices' ? 'Audio and video settings' : 'People'}>
            <div className="row"><strong className="grow">{panel === 'chat' ? 'Messages' : panel === 'polls' ? 'Polls' : panel === 'qa' ? 'Questions' : panel === 'devices' ? 'Audio and video' : `People (${tiles.length})`}</strong>
              <button type="button" className="icon-btn" aria-label="Close panel" onClick={() => setPanel(null)}><Icon name="close" size={18} /></button></div>
            {panel === 'chat' ? <>
              <p className="muted small" style={{ margin: 0 }}>{m.settings?.keep_chat ? '💾 This chat is being kept: the people in the meeting can read it afterwards (Meet → Recent meetings → Chat).' : 'Messages are only seen by people in the meeting now, and go when it ends.'}</p>
              <ul className="meet-chat" aria-live="polite">
                {messages.map((msg, i) => (msg.system ? <li key={i} className="muted small meet-chat-note">{msg.text}</li> : <li key={i}><strong>{msg.mine ? 'You' : msg.name}</strong> <span className="muted small">{new Date(msg.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span><div>{msg.text}</div></li>))}
              </ul>
              <form className="row" onSubmit={sendChat}><input name="msg" className="grow" aria-label="Send a message to everyone" placeholder="Send a message" maxLength={2000} autoComplete="off" /><button className="btn">Send</button></form>
            </> : panel === 'polls' ? <MeetPolls m={m} user={user} polls={polls} /> : panel === 'qa' ? <MeetQA m={m} /> : panel === 'devices' ? (
              local?.stream ? <DevicePicker stream={local.stream} onPick={changeDevices} sink={sink} onSpeaker={setSink} /> : <p className="muted small">{local?.error || 'No camera or microphone is in use.'}</p>
            ) : (<>
              {!guest && <AskToJoin code={code} here={tiles.map((t) => t.userId)} />}
              {m.host && !guest && <Breakouts m={m} goToRoom={goToRoom} />}
              <ul className="meet-people">
                {m.host && <li className="row"><span className="grow muted small">{m.locked ? '🔒 Locked: nobody new can join. Those here can come back if they drop out.' : 'Lock the meeting to stop anyone new from joining.'}</span>
                  <button type="button" className="btn small" aria-pressed={!!m.locked} onClick={() => m.lock(!m.locked)}>{m.locked ? '🔓 Unlock meeting' : '🔒 Lock meeting'}</button></li>}
                {!m.host && m.locked && <li className="muted small">🔒 The host has locked the meeting: nobody new can join.</li>}
                {m.host && <li className="meet-settings stack" aria-label="Meeting settings">
                  <label className="row small"><input type="checkbox" checked={!!m.settings?.muted_entry} onChange={(e) => m.setSettings({ muted_entry: e.target.checked })} /> Everyone joins muted</label>
                  <label className="row small"><input type="checkbox" checked={!!m.settings?.host_present} onChange={(e) => m.setSettings({ host_present: e.target.checked })} /> Only hosts can present</label>
                  {!guest && <label className="row small"><input type="checkbox" checked={!!m.settings?.keep_chat} onChange={(e) => m.setSettings({ keep_chat: e.target.checked })} /> Keep the meeting chat</label>}
                </li>}
                {m.host && tiles.length > 1 && <li className="row"><span className="grow muted small">{m.organiser ? 'You started this meeting.' : 'You’re a co-host.'}</span><button type="button" className="btn small" onClick={() => { m.mute('all'); toast('Everyone else is muted'); }}>Mute everyone</button></li>}
                {hands.length > 0 && <li className="meet-hands" aria-label="Raised hands">
                  <div className="row"><strong className="grow small">✋ Raised hands ({hands.length})</strong>
                    {m.host && hands.length > 1 && <button type="button" className="btn small" onClick={() => m.lower('all')}>Lower all</button>}</div>
                  <ol>{hands.map((t, i) => <li key={t.id} className="row"><span className="meet-hand-no" aria-hidden="true">{i + 1}</span><span className="grow">{t.name}</span>
                    {m.host && <button type="button" className="btn small" aria-label={`Lower ${t.me ? 'your' : `${t.name}’s`} hand`} onClick={() => (t.me ? m.setState({ hand: false }) : m.lower(t.id))}>Lower</button>}</li>)}</ol>
                </li>}
                {tiles.map((t) => <li key={t.id} className="row"><Avatar name={t.name} userId={t.userId} size={28} /><span className="grow">{t.name}{m.cohosts?.includes(t.userId) && <span className="meet-cohost">Co-host</span>}</span>
                  {m.organiser && !t.me && !/\(guest\)$/.test(t.name) && (m.cohosts?.includes(t.userId)
                    ? <button type="button" className="btn small" aria-label={`Remove ${t.name} as co-host`} onClick={() => m.setCohost(t.id, false)}>Remove co-host</button>
                    : <button type="button" className="btn small" aria-label={`Make ${t.name} a co-host`} title="Give them the host’s controls for this meeting" onClick={() => m.setCohost(t.id, true)}>Make co-host</button>)}{t.state.hand && '✋'}{t.state.mic === false && '🔇'}
                  {m.host && !t.me && (m.organiser || t.userId !== m.organiserId) && <>
                    {t.state.mic !== false && <button type="button" className="icon-btn" aria-label={`Mute ${t.name}`} title="Mute" onClick={() => m.mute(t.id)}>🔇</button>}
                    <button type="button" className="icon-btn" aria-label={`Remove ${t.name} from the meeting`} title="Remove from the meeting" onClick={() => { if (window.confirm(`Remove ${t.name} from the meeting? They won't be able to join again.`)) m.remove(t.id); }}><Icon name="close" size={16} /></button>
                  </>}</li>)}
              </ul>
            </>)}
          </aside>
        )}
      </div>
      <footer className="meet-bar" role="toolbar" aria-label="Meeting controls">
        <button type="button" className={`meet-btn ${m.state.mic ? '' : 'off'}`} disabled={!hasAudio} aria-pressed={m.state.mic} aria-label={m.state.mic ? 'Turn off microphone' : 'Turn on microphone'} onClick={toggleMic}>{m.state.mic ? '🎙' : '🔇'}</button>
        <button type="button" className={`meet-btn ${m.state.cam ? '' : 'off'}`} disabled={!hasVideo} aria-pressed={m.state.cam} aria-label={m.state.cam ? 'Turn off camera' : 'Turn on camera'} onClick={toggleCam}>{m.state.cam ? '📷' : '🚫'}</button>
        {navigator.mediaDevices?.getDisplayMedia && <button type="button" className={`meet-btn ${sharing ? 'on' : ''}`} aria-pressed={!!sharing} aria-label={sharing ? 'Stop presenting' : 'Present your screen'}
          disabled={!sharing && !m.host && !!m.settings?.host_present} title={!sharing && !m.host && m.settings?.host_present ? 'Only the host can present in this meeting' : undefined}
          onClick={() => (sharing ? m.stopScreen() : m.shareScreen().catch(() => {}))}>🖥</button>}
        <button type="button" className={`meet-btn ${m.state.hand ? 'on' : ''}`} aria-pressed={m.state.hand} aria-label={m.state.hand ? 'Lower hand' : 'Raise hand'} onClick={() => m.setState({ hand: !m.state.hand })}>✋</button>
        <span className="meet-reacts" role="group" aria-label="Send a reaction">{REACTIONS.map((e) => <button key={e} type="button" className="meet-react" aria-label={`React ${e}`} onClick={() => m.react(e)}>{e}</button>)}</span>
        <button type="button" className={`meet-btn ${panel === 'devices' ? 'on' : ''}`} aria-label="Audio and video settings" title="Camera and microphone" onClick={() => setPanel(panel === 'devices' ? null : 'devices')}>⚙</button>
        <button type="button" className={`meet-btn ${panel === 'chat' ? 'on' : ''}`} aria-label={unread ? `Chat, ${unread} new` : 'Chat'} onClick={() => { setPanel(panel === 'chat' ? null : 'chat'); setUnread(0); }}>💬{unread > 0 && <span className="nav-badge">{unread}</span>}</button>
        <button type="button" className={`meet-btn ${panel === 'qa' ? 'on' : ''}`} aria-label={newQs ? `Questions, ${newQs} new` : 'Questions'} onClick={() => { setPanel(panel === 'qa' ? null : 'qa'); setNewQs(0); }}>❓{newQs > 0 && <span className="nav-badge">{newQs}</span>}</button>
        <button type="button" className={`meet-btn ${panel === 'polls' ? 'on' : ''}`} aria-label={toVote ? `Polls, ${toVote} to answer` : 'Polls'} onClick={() => setPanel(panel === 'polls' ? null : 'polls')}>📊{toVote > 0 && <span className="nav-badge">{toVote}</span>}</button>
        <button type="button" className={`meet-btn ${board ? 'on' : ''}`} aria-pressed={board} aria-label={boardNew && !board ? `Whiteboard, ${boardNew} new` : 'Whiteboard'} title="A whiteboard everyone in the meeting draws on" onClick={() => { setBoard(!board); setBoardNew(0); }}>🖍{boardNew > 0 && !board && <span className="nav-badge">{boardNew}</span>}</button>
        <button type="button" className={`meet-btn ${panel === 'people' ? 'on' : ''}`} aria-label="People" onClick={() => setPanel(panel === 'people' ? null : 'people')}>👥</button>
        {!guest && <button type="button" className={`meet-btn ${m.state.rec ? 'on rec' : ''}`} disabled={saving} aria-pressed={!!m.state.rec} aria-label={saving ? 'Saving the recording' : m.state.rec ? 'Stop recording' : 'Record the meeting'} title={m.state.rec ? 'Stop and save it to your Drive' : 'Record the meeting (saved to your Drive)'} onClick={m.state.rec ? stopRecording : startRecording}>{saving ? '…' : '⏺'}</button>}
        <button type="button" className="meet-btn" aria-label="Copy meeting link" onClick={() => copyLink(code, toast)}>🔗</button>
        <button type="button" className="meet-btn leave" aria-label="Leave the meeting" onClick={leave}>Leave</button>
        {m.host && <button type="button" className="meet-btn end-all" aria-label="End the meeting for everyone" title="End the meeting for everyone"
          onClick={() => { if (window.confirm('End the meeting for everyone? Everyone in it (breakout rooms too) leaves.')) m.endForAll(); }}>End for all</button>}
      </footer>
    </div>
  );
}

async function copyLink(code, toast) {
  const link = `${location.origin}/meet/${code}`;
  try { await navigator.clipboard.writeText(link); toast('Meeting link copied'); } catch { toast(link); }
}

/**
 * Who is talking: each person's sound is measured a few times a second (in this browser, nothing is
 * sent anywhere), and those loud enough get a ring around their video.
 */
function useSpeaking(tiles) {
  const [speaking, setSpeaking] = useState(() => new Set());
  const key = tiles.map((t) => `${t.id}:${t.stream?.id || ''}:${t.stream?.getAudioTracks().length || 0}`).join('|');
  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  useEffect(() => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return undefined;
    const ctx = new AC();
    ctx.resume?.().catch(() => {});
    const meters = [];
    for (const t of tilesRef.current) {
      if (!t.stream?.getAudioTracks().length) continue;
      try {
        const src = ctx.createMediaStreamSource(t.stream);
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        src.connect(an); // not to the speakers: only measured
        meters.push({ id: t.id, an, buf: new Uint8Array(an.fftSize) });
      } catch { /* a stream without sound */ }
    }
    const heard = {};
    let last = '';
    const timer = setInterval(() => {
      const at = Date.now();
      for (const m of meters) { m.an.getByteTimeDomainData(m.buf); if (loudness(m.buf) > SPEAKING_LEVEL) heard[m.id] = at; }
      const now = speakingNow(heard, at);
      const sig = [...now].sort().join(',');
      if (sig !== last) { last = sig; setSpeaking(now); }
    }, 150);
    return () => { clearInterval(timer); ctx.close().catch(() => {}); };
  }, [key]);
  return speaking;
}
