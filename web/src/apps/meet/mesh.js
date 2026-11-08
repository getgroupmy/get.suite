// The connections of one meeting: a WebSocket to the server (who's here, and passing messages on) and
// a WebRTC connection to each other person, carrying our microphone and camera (or screen) both ways.
// Uses the "perfect negotiation" pattern so both sides can start a connection without tripping over
// each other. `onChange` is called whenever something visible changes.

export class Mesh {
  constructor({ code, room = 0, onBreakout, guestName = '', stream, iceServers = [], mic = true, cam = true, onChange, onChat, onReact, onClosed, onMuted, onPoll }) {
    Object.assign(this, { code, room, onBreakout, guestName, stream, iceServers, onChange, onChat, onReact, onClosed, onMuted, onPoll });
    this.polls = new Map(); // the meeting's polls, by id
    this.waiting = !!guestName; // a guest waits until someone in the meeting lets them in
    this.knocking = []; // guests waiting to be let in (shown to people from the meeting's company)
    this.state = { mic, cam, hand: false, screen: false };
    this.peers = new Map(); // id -> { id, user, state, pc, stream, polite, makingOffer, ignoreOffer }
    this.id = null;
    this.screen = null; // MediaStream while sharing
    this.left = false;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = `?mic=${this.state.mic ? 1 : 0}&cam=${this.state.cam ? 1 : 0}${this.room ? `&room=${this.room}` : ''}`;
    this.ws = new WebSocket(this.guestName
      ? `${proto}://${location.host}/ws/meet-guest/${encodeURIComponent(this.code)}${q}&name=${encodeURIComponent(this.guestName)}`
      : `${proto}://${location.host}/ws/meet/${encodeURIComponent(this.code)}${q}`);
    // One message at a time, in order: a network candidate must not be applied before the offer it belongs to.
    this.queue = Promise.resolve();
    this.ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      this.queue = this.queue.then(() => this.handle(m)).catch((err) => console.warn('meet', err));
    };
    this.ws.onclose = (e) => { if (!this.left) { this.closeAll(); this.onClosed?.(e.reason || 'The connection to the meeting was lost'); } };
  }

  send(msg) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg)); }

  /** The host: mute someone (a peer id, or 'all' for everyone else), or remove someone. */
  mute(to) { this.send({ type: 'mute', to }); }
  pollNew(question, options) { this.send({ type: 'poll-new', question, options }); }
  pollVote(id, option) { this.send({ type: 'poll-vote', id, option }); }
  pollClose(id) { this.send({ type: 'poll-close', id }); }
  remove(to) { this.send({ type: 'remove', to }); }
  /** The host: open breakout rooms ({ peerId: room }), move someone (room 0: the main room), close them. */
  breakoutOpen(count, assign) { this.send({ type: 'breakout-open', count, assign }); }
  breakoutMove(to, room) { this.send({ type: 'breakout-move', to, room }); }
  breakoutClose() { this.send({ type: 'breakout-close' }); }
  /** Let a waiting guest in, or not. */
  admit(id) { this.send({ type: 'admit', id }); }
  deny(id) { this.send({ type: 'deny', id }); }

  async handle(m) {
    if (m.type === 'welcome') {
      this.id = m.id;
      this.host = !!m.host; // whoever started the meeting: may mute and remove people
      this.you = m.you; // your account id (a guest's own id)
      this.waiting = false;
      this.room = m.room || 0; // 0: the main room
      this.breakoutCount = m.breakouts || 0;
      this.mayAdmit = !!m.admit; // people from the meeting's company let guests in
      this.knocking = m.knocking || [];
      for (const p of m.polls || []) this.polls.set(p.id, p);
      for (const p of m.peers) this.addPeer(p, { offer: true }); // the newcomer calls everyone
    } else if (m.type === 'joined') this.addPeer(m.peer, { offer: false }); // and they wait for the call
    else if (m.type === 'left') {
      const p = this.peers.get(m.id);
      if (p) { p.pc.close(); this.peers.delete(m.id); }
    } else if (m.type === 'state') {
      if (m.id === this.id) return;
      const p = this.peers.get(m.id);
      if (p) p.state = m.state;
    } else if (m.type === 'signal') await this.signal(m.from, m.data);
    else if (m.type === 'chat') { this.onChat?.({ ...m, mine: m.id === this.id }); return; }
    else if (m.type === 'knock') this.knocking = m.guests;
    else if (m.type === 'breakouts') { this.breakouts = m; this.breakoutCount = m.count; }
    else if (m.type === 'breakout') { this.onBreakout?.(m); return; }
    else if (m.type === 'waiting' || m.type === 'admitted') { /* redraw */ }
    else if (m.type === 'poll') { const isNew = !this.polls.has(m.poll.id); this.polls.set(m.poll.id, m.poll); if (isNew) this.onPoll?.(m.poll); }
    else if (m.type === 'muted') { this.setMic(false); this.onMuted?.(m.by); return; }
    else if (m.type === 'react') { this.onReact?.({ id: m.id === this.id ? 'me' : m.id, emoji: m.emoji }); return; }
    this.onChange?.();
  }

  addPeer({ id, user, state }, { offer }) {
    if (this.peers.has(id)) return;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    // Only one side makes the first offer, so the two never cross; later changes (presenting) use perfect negotiation.
    const p = { id, user, state, pc, stream: null, polite: this.id < id, makingOffer: false, ignoreOffer: false, waiting: !offer };
    this.peers.set(id, p);
    pc.onnegotiationneeded = async () => {
      if (p.waiting) return; // the browser asks again once the first offer has been answered
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        this.send({ type: 'signal', to: id, data: { description: pc.localDescription } });
      } catch (err) { console.warn('meet offer', err); } finally { p.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.send({ type: 'signal', to: id, data: { candidate } }); };
    pc.ontrack = ({ track, streams }) => {
      p.stream = streams[0] || p.stream || new MediaStream();
      if (!p.stream.getTracks().includes(track)) p.stream.addTrack(track);
      this.onChange?.();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && !p.polite) pc.restartIce(); // try again (one side asks)
      this.onChange?.();
    };
    const video = this.screen?.getVideoTracks()[0] || this.stream?.getVideoTracks()[0];
    const audio = this.stream?.getAudioTracks()[0];
    if (audio) pc.addTrack(audio, this.stream);
    if (video) p.videoSender = pc.addTrack(video, this.screen || this.stream);
    // Without a microphone or camera, still ask to receive theirs.
    if (offer && !audio) pc.addTransceiver('audio', { direction: 'recvonly' });
    if (offer && !video) pc.addTransceiver('video', { direction: 'recvonly' });
  }

  async signal(from, { description, candidate }) {
    const p = this.peers.get(from);
    if (!p) return;
    const { pc } = p;
    if (description) {
      const collision = description.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      p.waiting = false;
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        this.send({ type: 'signal', to: from, data: { description: pc.localDescription } });
      }
    } else if (candidate) {
      try { await pc.addIceCandidate(candidate); } catch (err) { if (!p.ignoreOffer) console.warn('meet ice', err); }
    }
  }

  setState(patch) {
    Object.assign(this.state, patch);
    this.send({ type: 'state', state: this.state });
    this.onChange?.();
  }

  setMic(on) { for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = on; this.setState({ mic: on }); }
  setCam(on) { for (const t of this.stream?.getVideoTracks() ?? []) t.enabled = on; this.setState({ cam: on }); }

  /** Swap what we send as video (camera <-> screen) on every connection. */
  useVideo(track, stream) {
    for (const p of this.peers.values()) {
      if (p.videoSender) p.videoSender.replaceTrack(track).catch(() => {});
      else if (track) p.videoSender = p.pc.addTrack(track, stream); // no camera: start sending video now
    }
  }

  async shareScreen() {
    const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = screen.getVideoTracks()[0];
    this.screen = screen;
    track.onended = () => this.stopScreen();
    this.useVideo(track, screen);
    this.setState({ screen: true });
  }

  stopScreen() {
    if (!this.screen) return;
    for (const t of this.screen.getTracks()) t.stop();
    this.screen = null;
    this.useVideo(this.stream?.getVideoTracks()[0] || null, this.stream);
    this.setState({ screen: false });
  }

  chat(text) { this.send({ type: 'chat', text }); }
  react(emoji) { this.send({ type: 'react', emoji }); }

  closeAll() {
    for (const p of this.peers.values()) p.pc.close();
    this.peers.clear();
    if (this.screen) for (const t of this.screen.getTracks()) t.stop();
  }

  /** Off to another room of the meeting: hang up here, but keep the camera and microphone. */
  switchAway() {
    this.left = true;
    this.closeAll();
    this.ws?.close();
  }

  leave() {
    this.left = true;
    this.closeAll();
    this.ws?.close();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
  }
}
