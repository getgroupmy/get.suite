// LibreOffice for the tests: one conversion at a time across the test files (they run side by side, and several
// LibreOffice processes at once can be slow enough to time out), with time to spare.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LOCK = path.join(os.tmpdir(), 'workspace-tests-soffice.lock');
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Whether LibreOffice is installed here. */
export const hasSoffice = (() => { try { execFileSync('soffice', ['--version'], { stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; } })();

/** Run soffice with these arguments, waiting for any other test's LibreOffice to finish first. */
export function soffice(args) {
  const until = Date.now() + 600000;
  for (;;) {
    try { fs.mkdirSync(LOCK); break; } catch {
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 300000) fs.rmSync(LOCK, { recursive: true, force: true }); } catch { /* gone meanwhile */ } // (left by a test that died)
      if (Date.now() > until) throw new Error('LibreOffice busy for too long');
      nap(200);
    }
  }
  try { execFileSync('soffice', args, { stdio: 'ignore', timeout: 240000 }); } finally { fs.rmSync(LOCK, { recursive: true, force: true }); }
}
