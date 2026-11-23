// scripts/check-setup.sh, run with stand-ins for docker, uname, lsof, curl, df and pmset (set by environment
// variables), on a PATH of only those and the basic tools it needs: a Mac before and after starting, a port
// taken, an image running through emulation, and no Docker at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const script = new URL('../../scripts/check-setup.sh', import.meta.url).pathname;
// The system's own tools (from /usr/bin or /bin first: a shell's PATH can put wrappers ahead of them).
const realTool = (t) => ['/usr/bin', '/bin'].map((d) => path.join(d, t)).find((f) => fs.existsSync(f)) || execFileSync('bash', ['-c', `command -v ${t}`]).toString().trim();
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-setup-'));
for (const tool of ['bash', 'awk', 'grep', 'tr', 'dirname', 'env']) {
  fs.symlinkSync(realTool(tool), path.join(bin, tool));
}
const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!${path.join(bin, 'bash')}\n${body}\n`, { mode: 0o755 });
stub('uname', '[[ $1 == -s ]] && echo "${FAKE_OS:-Darwin}" || echo "${FAKE_HW:-arm64}"');
stub('docker', `case "$1" in
  info) [[ -n \${FAKE_DOWN:-} ]] && exit 1; exit 0 ;;
  compose) [[ $2 == version ]] && exit 0; exit 0 ;;
  inspect) for n in \${FAKE_RUNNING:-}; do [[ \${@: -1} == "$n" ]] && { echo true; exit 0; }; done; echo false ;;
  exec) echo "\${FAKE_ARCH:-arm64}" ;;
esac`);
stub('lsof', 'for p in ${FAKE_TAKEN:-}; do [[ "$*" == *"-iTCP:$p "* ]] && { printf "COMMAND PID\\nmaster 12\\n"; exit 0; }; done; exit 1');
stub('df', 'printf "Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/disk3 1 1 ${FAKE_FREE_KB:-104857600} 1%% /\\n"');
stub('curl', '[[ -n ${FAKE_HEALTHY:-} ]]');
stub('pmset', 'printf " sleep                %s\\n" "${FAKE_SLEEP:-0}"');

const run = (env = {}, args = []) => {
  const r = spawnSync(path.join(bin, 'bash'), [script, ...args], { env: { PATH: bin, HOME: os.tmpdir(), ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};

test('setup check: a Mac with Apple Silicon, before the first start', () => {
  const r = run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /A Mac with Apple Silicon: the containers build for arm64/);
  assert.match(r.out, /Compose file: docker-compose\.mac\.yml/, 'the Mac file, on a Mac');
  assert.match(r.out, /! The mail hostname is still mail\.example\.com/);
  for (const p of [8080, 25, 465, 587, 993]) assert.match(r.out, new RegExp(`✓ Port ${p} is free`));
  assert.match(r.out, /✓ 100 GB free on the disk/);
  assert.match(r.out, /Start it with: {2}docker compose -f docker-compose\.mac\.yml up -d --build/);
});

test('setup check: a port taken, little disk, Docker not running, no Docker', () => {
  let r = run({ FAKE_TAKEN: '25', FAKE_FREE_KB: String(5 * 1048576) });
  assert.equal(r.code, 1);
  assert.match(r.out, /✗ Port 25 is taken by another program: master/);
  assert.match(r.out, /! Only 5 GB free on the disk/);
  r = run({ FAKE_DOWN: '1' });
  assert.equal(r.code, 1);
  assert.match(r.out, /Docker is installed but not running: open OrbStack or Docker Desktop/);
  fs.renameSync(path.join(bin, 'docker'), path.join(bin, 'docker.off'));
  try {
    r = run();
    assert.equal(r.code, 1);
    assert.match(r.out, /✗ Docker isn't installed: install OrbStack or Docker Desktop/);
  } finally { fs.renameSync(path.join(bin, 'docker.off'), path.join(bin, 'docker')); }
});

test('setup check: running natively, or through emulation', () => {
  let r = run({ FAKE_RUNNING: 'nas-workspace nas-workspace-mail', FAKE_HEALTHY: '1' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✓ It runs natively \(arm64\)/);
  assert.match(r.out, /✓ It answers at http:\/\/localhost:8080/);
  assert.match(r.out, /✓ The mail server's container is running/);
  assert.match(r.out, /✓ The Mac doesn't go to sleep/);
  assert.match(r.out, /All set\./);
  assert.doesNotMatch(r.out, /Port 8080/, 'ports aren\'t checked once it runs (it holds them itself)');
  r = run({ FAKE_RUNNING: 'nas-workspace', FAKE_ARCH: 'x64', FAKE_SLEEP: '10' });
  assert.equal(r.code, 1);
  assert.match(r.out, /✗ It runs as x64 on this arm64 machine, through emulation/);
  assert.match(r.out, /✗ It doesn't answer at http:\/\/localhost:8080/);
  assert.match(r.out, /✗ The mail server's container isn't running/);
  assert.match(r.out, /! The Mac may go to sleep/);
});

test('setup check: Linux uses docker-compose.yml; another file can be named', () => {
  let r = run({ FAKE_OS: 'Linux', FAKE_HW: 'x86_64' });
  assert.match(r.out, /✓ Linux on x86_64/);
  assert.match(r.out, /Compose file: docker-compose\.yml/);
  r = run({}, ['nope.yml']);
  assert.equal(r.code, 1);
  assert.match(r.out, /✗ There's no nope\.yml here/);
});
