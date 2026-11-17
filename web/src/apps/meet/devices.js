// Which camera, microphone and speaker Meet uses: chosen in the lobby or the meeting's ⚙ settings, remembered in this browser.
const KEY = 'nw-meet-devices';

/** The saved choice: { mic, cam, spk } device ids (empty: the browser's default), and original: sound as it is (see below). */
export function savedDevices(storage = globalThis.localStorage) {
  try { const v = JSON.parse(storage?.getItem(KEY) || '{}'); return { mic: String(v.mic || ''), cam: String(v.cam || ''), spk: String(v.spk || ''), original: !!v.original }; } catch { return { mic: '', cam: '', spk: '', original: false }; }
}
export function saveDevices(choice, storage = globalThis.localStorage) {
  try { storage?.setItem(KEY, JSON.stringify({ mic: choice.mic || '', cam: choice.cam || '', spk: choice.spk || '', original: !!choice.original })); } catch { /* private mode */ }
}

/**
 * What to ask getUserMedia for, most first: the chosen devices (asked for as "ideal", so one that's gone
 * falls back to another rather than failing), then sound only, then picture only.
 */
export function deviceAsks({ mic = '', cam = '', original = false } = {}) {
  // Original sound (for music: an instrument, a singing lesson): the browser's noise suppression, echo cancellation and
  // automatic volume off, which otherwise treat music as noise. Headphones then keep others from hearing themselves.
  const clean = original ? { noiseSuppression: false, echoCancellation: false, autoGainControl: false } : {};
  const audio = mic || original ? { ...(mic && { deviceId: { ideal: mic } }), ...clean } : true;
  const video = cam ? { deviceId: { ideal: cam } } : true;
  return [{ audio, video }, { audio }, { video }];
}

/** The cameras, microphones and speakers from enumerateDevices, named (an unnamed one: "Camera 2"). */
export function deviceLists(devices = []) {
  const of = (kind, word) => devices.filter((d) => d.kind === kind && d.deviceId).map((d, i) => ({ id: d.deviceId, label: d.label || `${word} ${i + 1}` }));
  return { mics: of('audioinput', 'Microphone'), cams: of('videoinput', 'Camera'), spks: of('audiooutput', 'Speaker') };
}

/** Whether this browser can choose where sound plays (setSinkId; not every browser can). */
export const canPickSpeaker = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

/** A microphone's loudness (RMS, 0–1) as a 0–100 level for the meter: speech fills most of it, silence none. */
export const meterPercent = (rms) => Math.max(0, Math.min(100, Math.round((Number(rms) || 0) / 0.25 * 100)));
