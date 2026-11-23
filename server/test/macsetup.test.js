// docker-compose.mac.yml as Docker reads it: without --profile https it's the app and the mail server only, and
// leaves ports 80 and 443 alone; with it, Caddy is added on 80 and 443, passing everything to the app under the
// hostname set at the top of the file. (Skipped where the docker command isn't installed.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('../../', import.meta.url).pathname;
const compose = (...args) => spawnSync('docker', ['compose', '-f', 'docker-compose.mac.yml', ...args, 'config', '--format', 'json'], { cwd: root, encoding: 'utf8' });
const has = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

test('Mac compose file: the app and mail only, unless HTTPS is asked for', { skip: !has && 'no docker compose here' }, () => {
  const r = compose();
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(c.services).sort(), ['mail', 'workspace']);
  const published = Object.values(c.services).flatMap((s) => (s.ports || []).map((p) => Number(p.published)));
  assert.ok(!published.includes(80) && !published.includes(443), 'ports 80 and 443 left alone');
  assert.ok(c.services.workspace.volumes.some((v) => v.type === 'volume' && v.target === '/data'), 'the data in a Docker volume');
  assert.ok(!c.services.workspace.user, 'no Synology user ID');
});

test('Mac compose file with --profile https: Caddy on 80 and 443, in front of the app', { skip: !has && 'no docker compose here' }, () => {
  const r = compose('--profile', 'https');
  assert.equal(r.status, 0, r.stderr);
  const caddy = JSON.parse(r.stdout).services.caddy;
  assert.ok(caddy, 'Caddy is there');
  assert.deepEqual(caddy.ports.map((p) => Number(p.published)).sort((a, b) => a - b), [80, 443]);
  assert.equal(caddy.environment.WORKSPACE_HOST, 'workspace.example.com', 'the hostname from the top of the file');
  assert.ok(caddy.volumes.some((v) => v.target === '/etc/caddy/Caddyfile' && v.read_only));
  assert.ok(caddy.volumes.some((v) => v.type === 'volume' && v.target === '/data'), 'its certificates kept in a volume');
});

test('Caddyfile: the hostname from the environment, passed on to the app', () => {
  const f = fs.readFileSync(new URL('../../caddy/Caddyfile', import.meta.url), 'utf8').replace(/^#.*$/gm, '');
  assert.match(f, /^\{\$WORKSPACE_HOST\} \{$/m);
  assert.match(f, /^\treverse_proxy workspace:8080$/m);
  assert.equal((f.match(/\{/g) || []).length, (f.match(/\}/g) || []).length, 'braces balance');
});
