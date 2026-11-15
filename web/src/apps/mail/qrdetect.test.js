import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { hasQrCode, toGray } from './qrdetect.js';

/** A QR code drawn as a picture: `scale` pixels a module, a quiet zone, on a canvas of w × h at (ox, oy). */
function draw(text, { scale = 4, w = 300, h = 300, ox = 20, oy = 20, rotate = false, noise = 0 } = {}) {
  const q = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = q.modules.size;
  const g = new Uint8Array(w * h).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!q.modules.get(r, c)) continue;
    const [rr, cc] = rotate ? [c, n - 1 - r] : [r, c];
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const px = ox + cc * scale + x, py = oy + rr * scale + y;
      if (px < w && py < h) g[py * w + px] = 0;
    }
  }
  if (noise) for (let i = 0; i < g.length; i++) g[i] = Math.max(0, Math.min(255, g[i] + Math.round((Math.sin(i * 12.9898) * 43758.5453 % 1) * noise)));
  return { g, w, h };
}

test('finds QR codes: small and large, off-centre, turned, a little noisy', () => {
  for (const opts of [{}, { scale: 2, w: 120, h: 120, ox: 8, oy: 8 }, { scale: 9, w: 600, h: 500, ox: 150, oy: 40 }, { rotate: true }, { noise: 60 }]) {
    const { g, w, h } = draw('https://evil.example/login?id=12345', opts);
    assert.equal(hasQrCode(g, w, h), true, JSON.stringify(opts));
  }
});

test('not in ordinary pictures: blank, stripes, a chessboard, a single square, text-like blocks', () => {
  const w = 200, h = 200;
  const blank = new Uint8Array(w * h).fill(255);
  assert.equal(hasQrCode(blank, w, h), false);
  const stripes = new Uint8Array(w * h).map((_, i) => ((i % w) % 10 < 5 ? 0 : 255));
  assert.equal(hasQrCode(stripes, w, h), false);
  const chess = new Uint8Array(w * h).map((_, i) => (((Math.floor((i % w) / 8) + Math.floor(i / w / 8)) % 2) ? 0 : 255));
  assert.equal(hasQrCode(chess, w, h), false);
  // One finder-like square (a logo) is not a code.
  const one = new Uint8Array(w * h).fill(255);
  const sq = (x0, y0, s, v) => { for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) one[y * w + x] = v; };
  sq(20, 20, 70, 0); sq(30, 30, 50, 255); sq(50, 50, 10, 0); sq(40, 40, 30, 0);
  assert.equal(hasQrCode(one, w, h), false);
  // Lines of "text".
  const text = new Uint8Array(w * h).fill(255);
  for (let line = 0; line < 8; line++) for (let x = 10; x < 190; x++) for (let y = 15 + line * 22; y < 25 + line * 22; y++) if ((x * 7 + line) % 11 < 6) text[y * w + x] = 0;
  assert.equal(hasQrCode(text, w, h), false);
});

test('toGray: colours and transparency', () => {
  const g = toGray(new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0]), 3, 1);
  assert.deepEqual([...g], [0, 255, 255]);
});
