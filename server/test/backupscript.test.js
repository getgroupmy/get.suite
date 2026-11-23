// scripts/backup.sh with a stand-in for docker that logs what it's asked and, for a copy, writes the archive where
// the real tar would: volumes found by their compose labels, the containers stopped around the copy and started
// again, old copies pruned, and a restore that needs --yes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const script = new URL('../../scripts/backup.sh', import.meta.url).pathname;
// The system's own tools (from /usr/bin or /bin first: a shell's PATH can put wrappers ahead of them).
const realTool = (t) => ['/usr/bin', '/bin'].map((d) => path.join(d, t)).find((f) => fs.existsSync(f)) || execFileSync('bash', ['-c', `command -v ${t}`]).toString().trim();
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-backup-bin-'));
for (const tool of ['bash', 'awk', 'grep', 'sort', 'ls', 'mkdir', 'rm', 'head', 'date', 'dirname', 'cat', 'touch', 'sh']) {
  fs.symlinkSync(realTool(tool), path.join(bin, tool));
}
fs.writeFileSync(path.join(bin, 'docker'), `#!${path.join(bin, 'bash')}
echo "$*" >> "$DOCKER_LOG"
case "$1" in
  info) exit 0 ;;
  volume) [[ -n \${FAKE_NOVOL:-} ]] && exit 0; label=\${5#label=com.docker.compose.volume=}; echo "app_$label" ;;
  ps) [[ $2 == -a || -n \${FAKE_RUNNING:-} ]] && printf 'c1\\nc2\\n' ;;
  run) for a in "$@"; do case "$a" in *:/b) host=\${a%:/b} ;; esac; done
       for a in "$@"; do case "$a" in /b/*.tgz) [[ -n \${FAKE_FAIL:-} ]] && exit 1; echo archive > "$host/\${a#/b/}" ;; esac; done ;;
esac
exit 0
`, { mode: 0o755 });

const setup = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-backup-home-'));
  return { home, dir: path.join(home, 'workspace-backup'), log: path.join(home, 'docker.log') };
};
const run = (t, args = [], env = {}) => {
  const r = spawnSync(path.join(bin, 'bash'), [script, ...args], { env: { PATH: bin, HOME: t.home, DOCKER_LOG: t.log, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr, calls: fs.existsSync(t.log) ? fs.readFileSync(t.log, 'utf8').trim().split('\n') : [] };
};

test('backup script: a dated copy of each volume, Workspace stopped around it and started again', () => {
  const t = setup();
  const r = run(t, [], { FAKE_RUNNING: '1' });
  assert.equal(r.code, 0, r.out);
  const [copy] = fs.readdirSync(t.dir);
  assert.match(copy, /^\d{4}-\d{2}-\d{2}-\d{4}$/);
  assert.deepEqual(fs.readdirSync(path.join(t.dir, copy)).sort(), ['data.tgz', 'mail-config.tgz', 'mailboxes.tgz']);
  const stop = r.calls.findIndex((c) => c.startsWith('stop c1 c2')), start = r.calls.findIndex((c) => c.startsWith('start c1 c2'));
  const runs = r.calls.map((c, i) => [c, i]).filter(([c]) => c.startsWith('run '));
  assert.ok(stop >= 0 && start > stop && runs.every(([, i]) => i > stop && i < start), `stopped, copied, started: ${r.calls.join(' | ')}`);
  assert.ok(runs.some(([c]) => c.includes('app_workspace-data:/v:ro')), 'the volume found by its label, read-only');
  assert.match(r.out, /Workspace is running again\.[\s\S]*Copied to/);
  // Not running: it isn't stopped or started.
  const t2 = setup();
  const r2 = run(t2);
  assert.equal(r2.code, 0, r2.out);
  assert.ok(!r2.calls.some((c) => /^(stop|start) /.test(c)));
});

test('backup script: only the last KEEP copies are kept; list shows them', () => {
  const t = setup();
  fs.mkdirSync(t.dir);
  for (const d of ['2026-01-01-0300', '2026-01-02-0300', '2026-01-03-0300', 'notes']) fs.mkdirSync(path.join(t.dir, d));
  const r = run(t, [], { KEEP: '2' });
  assert.equal(r.code, 0, r.out);
  const left = fs.readdirSync(t.dir).sort();
  assert.equal(left.length, 3, left.join());
  assert.ok(left.includes('2026-01-03-0300') && left.includes('notes') && !left.includes('2026-01-01-0300'), 'the newest two, and nothing else of yours touched');
  assert.match(r.out, /Removed the old copy 2026-01-01-0300/);
  const l = run(t, ['list']);
  assert.equal(l.out.trim().split('\n').length, 2);
});

test('backup script: no volumes, a failed copy, and restore', () => {
  const t = setup();
  let r = run(t, [], { FAKE_NOVOL: '1' });
  assert.equal(r.code, 1);
  assert.match(r.out, /No volume for data/);
  r = run(t, [], { FAKE_FAIL: '1', FAKE_RUNNING: '1' });
  assert.equal(r.code, 1);
  assert.match(r.out, /incomplete/);
  assert.ok(r.calls.some((c) => c.startsWith('start c1 c2')), 'started again even so');
  // Restore: which copy, and --yes.
  const ok = setup();
  run(ok);
  const [copy] = fs.readdirSync(ok.dir);
  fs.rmSync(ok.log);
  assert.match(run(ok, ['restore']).out, /Which copy\?/);
  r = run(ok, ['restore', copy]);
  assert.equal(r.code, 1);
  assert.match(r.out, /Add --yes to go ahead/);
  assert.deepEqual(r.calls, [], 'nothing done without --yes');
  r = run(ok, ['restore', copy, '--yes']);
  assert.equal(r.code, 0, r.out);
  const runs = r.calls.filter((c) => c.startsWith('run '));
  assert.equal(runs.length, 3);
  assert.ok(runs.every((c) => c.includes(`${path.join(ok.dir, copy)}:/b:ro`) && /find \/v -mindepth 1 -delete && tar xzf \/b\/[a-z-]+\.tgz -C \/v/.test(c)));
  assert.ok(r.calls[r.calls.findIndex((c) => c.startsWith('stop'))] && r.calls.at(-1).startsWith('start'), r.calls.join(' | '));
});
