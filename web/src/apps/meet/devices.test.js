import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savedDevices, saveDevices, deviceAsks, deviceLists } from './devices.js';

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };

test('the choice is remembered; nothing saved means the defaults', () => {
  const s = mem();
  assert.deepEqual(savedDevices(s), { mic: '', cam: '' });
  saveDevices({ mic: 'm1', cam: 'c2' }, s);
  assert.deepEqual(savedDevices(s), { mic: 'm1', cam: 'c2' });
  s.setItem('nw-meet-devices', 'not json');
  assert.deepEqual(savedDevices(s), { mic: '', cam: '' });
});

test('asks for the chosen devices as ideal, then less', () => {
  assert.deepEqual(deviceAsks(), [{ audio: true, video: true }, { audio: true }, { video: true }]);
  assert.deepEqual(deviceAsks({ mic: 'm1', cam: 'c2' })[0], { audio: { deviceId: { ideal: 'm1' } }, video: { deviceId: { ideal: 'c2' } } });
});

test('lists cameras and microphones, naming those without a label', () => {
  const l = deviceLists([{ kind: 'audioinput', deviceId: 'a', label: 'Headset' }, { kind: 'videoinput', deviceId: 'v', label: '' }, { kind: 'audiooutput', deviceId: 'o', label: 'Speakers' }, { kind: 'audioinput', deviceId: '', label: 'hidden' }]);
  assert.deepEqual(l, { mics: [{ id: 'a', label: 'Headset' }], cams: [{ id: 'v', label: 'Camera 1' }] });
});
