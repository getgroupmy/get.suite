// scripts/update.sh with stand-ins for docker, curl and sleep: a backup first (the real scripts/backup.sh), then
// the rebuild (with --profile https when asked), then waiting for the app; no update without a backup, and the
// way back when it doesn't come up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const script = new URL('../../scripts/update.sh', import.meta.url).pathname;
// The system's own tools (from /usr/bin or /bin first: a shell's PATH can put wrappers ahead of them).
const realTool = (t) => ['/usr/bin', '/bin'].map((d) => path.join(d, t)).find((f) => fs.existsSync(f)) || execFileSync('bash', ['-c', `command -v ${t}`]).toString().trim();
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-update-bin-'));
for (const tool of ['bash', 'awk', 'grep', 'sort', 'ls', 'mkdir', 'rm', 'head', 'tail', 'date', 'dirname', 'cat', 'sed', 'sh']) fs.symlinkSync(realTool(tool), path.join(bin, tool));
const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!${path.join(bin, 'bash')}\n${body}\n`, { mode: 0o755 });
stub('docker', `echo "$*" >> "$DOCKER_LOG"
case "$1" in
  info) exit 0 ;;
  compose) [[ "$*" == *" up "* && -n \${FAKE_BUILD_FAILS:-} ]] && exit 1; exit 0 ;;
  volume) [[ -n \${FAKE_NOVOL:-} ]] && exit 0; echo "app_\${5#label=com.docker.compose.volume=}" ;;
  ps) printf 'c1\\nc2\\n' ;;
  run) for a in "$@"; do case "$a" in *:/b) host=\${a%:/b} ;; esac; done
       for a in "$@"; do case "$a" in /b/*.tgz) echo archive > "$host/\${a#/b/}" ;; esac; done ;;
esac
exit 0`);
// Answers after FAKE_UP_AFTER calls (counted in a file), or never.
stub('curl', 'n=$(( $(cat "$CURL_COUNT" 2>/dev/null || echo 0) + 1 )); echo $n > "$CURL_COUNT"; [[ -n ${FAKE_UP_AFTER:-} ]] && (( n >= FAKE_UP_AFTER ))');
stub('sleep', 'exit 0');

const run = (env = {}, args = []) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-update-home-'));
  const log = path.join(home, 'docker.log');
  const r = spawnSync(path.join(bin, 'bash'), [script, ...args], { env: { PATH: bin, HOME: home, DOCKER_LOG: log, CURL_COUNT: path.join(home, 'curl'), ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [], home };
};

test('update script: a backup, then the rebuild, then it answers again', () => {
  const r = run({ FAKE_UP_AFTER: '3' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1\. A backup first[\s\S]*Copied to[\s\S]*2\. Building and restarting[\s\S]*Workspace is up again\.[\s\S]*Updated\./);
  const firstBackup = r.calls.findIndex((c) => c.startsWith('run ')), up = r.calls.findIndex((c) => / up -d --build$/.test(c));
  assert.ok(firstBackup >= 0 && up > firstBackup, `backup before the rebuild: ${r.calls.join(' | ')}`);
  assert.equal(r.calls[up], 'compose -f docker-compose.mac.yml up -d --build');
  assert.equal(fs.readdirSync(path.join(r.home, 'workspace-backup')).length, 1, 'one copy made');
  const h = run({ FAKE_UP_AFTER: '1' }, ['--https']);
  assert.equal(h.code, 0, h.out);
  assert.ok(h.calls.includes('compose -f docker-compose.mac.yml --profile https up -d --build'));
  assert.match(h.out, /check-setup\.sh --https/);
});

test('update script: no backup, no update; a failed build; not answering says how to go back', () => {
  let r = run({ FAKE_NOVOL: '1' });
  assert.equal(r.code, 1);
  assert.match(r.out, /The backup didn't work, so nothing was updated/);
  assert.ok(!r.calls.some((c) => / up /.test(c)), 'not rebuilt');
  r = run({ FAKE_BUILD_FAILS: '1' });
  assert.equal(r.code, 1);
  assert.match(r.out, /The build or start failed \(above\)\. Workspace's data is as it was; the backup is \d{4}-\d{2}-\d{2}-\d{4}\./);
  r = run({ WAIT: '9' });
  assert.equal(r.code, 1);
  assert.match(r.out, /It hasn't answered after 9s/);
  assert.match(r.out, /bash scripts\/backup\.sh restore \d{4}-\d{2}-\d{2}-\d{4} --yes/);
});
