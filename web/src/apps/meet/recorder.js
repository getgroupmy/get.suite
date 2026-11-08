// Recording a meeting in the browser of whoever presses Record: the grid of everyone's video (as it is
// on their screen) drawn onto a canvas, with everyone's sound mixed, into a WebM file. Others are told
// (the "rec" state), and the file is saved to a "Meet recordings" folder in the recorder's Drive.
import { post, uploadFile } from '../../api.js';
import { columnsFor } from './meetmath.js';

const W = 1280, H = 720, FPS = 15;

/** Draw the meeting's tiles (in `grid`, the page's .meet-grid) onto the canvas. */
function drawGrid(ctx, grid) {
  ctx.fillStyle = '#202124';
  ctx.fillRect(0, 0, W, H);
  const tiles = [...grid.querySelectorAll('.meet-tile')];
  const n = Math.max(1, tiles.length), cols = columnsFor(n), rows = Math.ceil(n / cols);
  const tw = W / cols, th = H / rows;
  tiles.forEach((tile, i) => {
    const x = (i % cols) * tw, y = Math.floor(i / cols) * th;
    const v = tile.querySelector('video');
    ctx.fillStyle = '#3c4043';
    ctx.fillRect(x + 4, y + 4, tw - 8, th - 8);
    if (v && v.readyState >= 2 && v.videoWidth && getComputedStyle(v).display !== 'none') {
      const s = Math.min((tw - 8) / v.videoWidth, (th - 8) / v.videoHeight);
      const w = v.videoWidth * s, h = v.videoHeight * s;
      ctx.drawImage(v, x + (tw - w) / 2, y + (th - h) / 2, w, h);
    }
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(x + 8, y + th - 36, Math.min(tw - 16, 260), 26);
    ctx.fillStyle = '#fff';
    ctx.font = '16px sans-serif';
    ctx.fillText(tile.dataset.name || '', x + 16, y + th - 17, Math.min(tw - 32, 244));
  });
}

export class MeetingRecorder {
  /** `grid`: the meeting grid element; `streams()`: the meeting's MediaStreams (for their sound). */
  constructor({ grid, streams }) {
    this.grid = grid;
    this.streams = streams;
    this.canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
    this.ctx = this.canvas.getContext('2d');
    this.audio = new AudioContext();
    this.mix = this.audio.createMediaStreamDestination();
    this.heard = new Set();
    this.chunks = [];
  }

  /** Sound from anyone who joined since (each track once). */
  listen() {
    for (const s of this.streams()) {
      for (const t of s?.getAudioTracks?.() || []) {
        if (this.heard.has(t.id)) continue;
        this.heard.add(t.id);
        try { this.audio.createMediaStreamSource(new MediaStream([t])).connect(this.mix); } catch { /* a track that ended */ }
      }
    }
  }

  start() {
    this.listen();
    this.timer = setInterval(() => { drawGrid(this.ctx, this.grid); this.listen(); }, 1000 / FPS);
    drawGrid(this.ctx, this.grid);
    const stream = new MediaStream([...this.canvas.captureStream(FPS).getVideoTracks(), ...this.mix.stream.getAudioTracks()]);
    const type = ['video/webm;codecs=vp8,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    this.recorder = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 1_500_000 } : undefined);
    this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.recorder.start(1000);
    this.startedAt = Date.now();
  }

  /** Stop, and save it to Drive as `name`.webm: resolves to the uploaded file. */
  async stop(name) {
    const done = new Promise((resolve) => { this.recorder.onstop = resolve; });
    this.recorder.stop();
    await done;
    clearInterval(this.timer);
    this.audio.close().catch(() => {});
    const blob = new Blob(this.chunks, { type: 'video/webm' });
    const folder = (await post('/meet/recordings-folder')).id;
    return uploadFile(new File([blob], `${name}.webm`, { type: 'video/webm' }), folder);
  }
}
