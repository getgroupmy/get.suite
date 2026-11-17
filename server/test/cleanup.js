// Loaded before every test file (npm test: --import): the temporary folders a test process makes with
// fs.mkdtempSync / fs.promises.mkdtemp under the system temp folder are removed when that process ends, so runs
// don't pile up data folders (a full run used to leave about 60 behind).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const made = new Set();
const tmp = path.resolve(os.tmpdir());
const keep = (dir) => { if (typeof dir === 'string' && path.resolve(dir).startsWith(tmp + path.sep)) made.add(dir); return dir; };
const sync = fs.mkdtempSync;
fs.mkdtempSync = (...a) => keep(sync(...a));
const cb = fs.mkdtemp;
fs.mkdtemp = (prefix, ...rest) => { const done = rest.pop(); return cb(prefix, ...rest, (err, dir) => done(err, err ? dir : keep(dir))); };
const prom = fs.promises.mkdtemp;
fs.promises.mkdtemp = async (...a) => keep(await prom(...a));
process.on('exit', () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* still in use: left */ } } });
