export class ApiError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}

const HEADERS = { 'x-requested-with': 'nas-workspace' };

export async function api(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? HEADERS : { ...HEADERS, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/auth/')) window.dispatchEvent(new Event('nw:signed-out'));
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data);
  }
  return data;
}

export const get = (url) => api('GET', url);
export const post = (url, body = {}) => api('POST', url, body);
export const patch = (url, body) => api('PATCH', url, body);
export const put = (url, body) => api('PUT', url, body);
export const del = (url) => api('DELETE', url);

/** Upload one file with progress. Resolves to the created file record. */
export function uploadFile(file, parentId, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const qs = new URLSearchParams({ name: file.name, ...(parentId && { parent: parentId }) });
    xhr.open('POST', `/api/files/upload?${qs}`);
    xhr.setRequestHeader('x-requested-with', 'nas-workspace');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error || 'Upload failed'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error during upload'));
    xhr.send(file);
  });
}

// ---------- live events over WebSocket (auto-reconnecting) ----------
const listeners = new Set();
let socket = null;
let retry = 0;
let wanted = false;

function connect() {
  if (!wanted) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.onopen = () => { retry = 0; emit({ type: 'live-connected' }); };
  socket.onmessage = (e) => { try { emit(JSON.parse(e.data)); } catch {} };
  socket.onclose = () => {
    socket = null;
    if (wanted) setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
  };
}
function emit(msg) { for (const fn of listeners) fn(msg); }

export function startLive() { if (!wanted) { wanted = true; connect(); } }
export function stopLive() { wanted = false; socket?.close(); }
export function onLive(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ---------- formatting helpers ----------
export function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function formatDate(ms) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() && { year: 'numeric' }) });
}
