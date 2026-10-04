import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { observeOsTrust, detectTrustPlatform } from '../../src/harness/trust-os.mjs';
import { composeTrustSources } from '../../src/harness/trust-source.mjs';
import { parsePemBundle } from '../../src/harness/trust-encoding.mjs';

const read = name => readFileSync(new URL(`./fixtures/${name}.pem`, import.meta.url));
const rootA = read('root-a'); const rootB = read('root-b');

// A disposable fixture root; nothing here touches the host's trust stores.
function ubuntuRoot({ conf = 'mozilla/a.crt\n', bundle = rootA, shared = { 'mozilla/a.crt': rootA }, local = {}, release = '24.04', blocklist = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aih-trust-os-'));
  const put = (path, bytes) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), bytes); };
  put('etc/os-release', `ID=ubuntu\nVERSION_ID="${release}"\n`);
  if (conf !== null) put('etc/ca-certificates.conf', conf);
  if (bundle !== null) put('etc/ssl/certs/ca-certificates.crt', bundle);
  for (const [name, bytes] of Object.entries(shared)) put(`usr/share/ca-certificates/${name}`, bytes);
  for (const [name, bytes] of Object.entries(local)) put(`usr/local/share/ca-certificates/${name}`, bytes);
  if (blocklist) put('etc/ca-certificates/trust-source/blocklist/x.p11-kit', 'x');
  return root;
}
const env = (root, extra = {}) => ({ platform: 'linux', arch: 'x64', release: '6.8.0', root,
  readFile: path => { try { return readFileSync(path); } catch { return undefined; } }, ...extra });
const observe = async (root, extra) => observeOsTrust({ network: 'off', environment: env(root, extra) });

test('Ubuntu 24.04: a bundle that matches its regenerated source selection is complete, with candidates', async () => {
  const root = ubuntuRoot();
  try {
    const result = await observe(root);
    assert.equal(result.status, 'complete', JSON.stringify(result));
    assert.equal(result.projection, 'ubuntu-24.04-system-openssl-v1');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.adapter.id, result.projection);
    assert.match(result.adapter.sha256, /^[a-f0-9]{64}$/);
    const composed = composeTrustSources({ os: result, now: Date.UTC(2026, 9, 4) });
    assert.equal(composed.status, 'ready');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Ubuntu: stale bundle, removed (!) entry, missing files, blocklists and local additions fail closed or compose exactly', async () => {
  const cases = [
    ['stale bundle (extra cert in conf)', ubuntuRoot({ conf: 'mozilla/a.crt\nmozilla/b.crt\n', shared: { 'mozilla/a.crt': rootA, 'mozilla/b.crt': rootB } }), 'incomplete'],
    ['bundle has an unlisted cert', ubuntuRoot({ bundle: Buffer.concat([rootA, rootB]) }), 'incomplete'],
    ['missing bundle', ubuntuRoot({ bundle: null }), 'incomplete'],
    ['missing conf', ubuntuRoot({ conf: null }), 'incomplete'],
    ['blocklist present', ubuntuRoot({ blocklist: true }), 'incomplete'],
    ['unreadable listed source', ubuntuRoot({ shared: {} }), 'incomplete'],
    ['wrong release', ubuntuRoot({ release: '22.04' }), 'unavailable'],
    ['local addition included in bundle', ubuntuRoot({ bundle: Buffer.concat([rootA, rootB]), local: { 'corp/b.crt': rootB } }), 'complete'],
    ['removed entry excluded from bundle', ubuntuRoot({ conf: '!mozilla/a.crt\n', bundle: rootB, shared: { 'mozilla/a.crt': rootA }, local: { 'b.crt': rootB } }), 'complete']
  ];
  for (const [name, root, status] of cases) {
    try { assert.equal((await observe(root)).status, status, name); } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('Ubuntu: architecture and distribution outside the tested cell are unavailable, not guessed', async () => {
  const root = ubuntuRoot();
  try {
    const arm = await observe(root, { arch: 'arm64' });
    assert.deepEqual([arm.status, arm.reason], ['unavailable', 'trust-platform-unsupported']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('platform detection maps only tested releases to matrix labels', () => {
  assert.equal(detectTrustPlatform({ platform: 'win32', arch: 'x64', release: '10.0.26200' }).release, 'Windows 11 25H2');
  assert.equal(detectTrustPlatform({ platform: 'win32', arch: 'x64', release: '10.0.22631' }).release, null);
  assert.equal(detectTrustPlatform({ platform: 'darwin', arch: 'arm64', release: '25.0.0' }).projection, 'macos-effective-server-auth-v1');
  assert.equal(detectTrustPlatform({ platform: 'darwin', arch: 'x64', release: '25.0.0' }).projection, null);
  assert.equal(detectTrustPlatform({ platform: 'freebsd', arch: 'x64', release: '14' }).release, null);
});

test('Windows: store enumeration is not claimed as the effective set; read failures are unavailable', async () => {
  const win = run => ({ platform: 'win32', arch: 'x64', release: '10.0.26200', run });
  const incomplete = await observeOsTrust({ network: 'declared',
    environment: win(async () => ({ status: 'ok', stdout: '{"disableRootAutoUpdate":null,"groupPolicyRoots":0}' })) });
  assert.equal(incomplete.status, 'incomplete');
  assert.deepEqual(incomplete.reasons, ['windows-ctl-on-demand-unestablished']);
  assert.deepEqual(incomplete.candidates, []);
  const policy = await observeOsTrust({ network: 'off',
    environment: win(async () => ({ status: 'ok', stdout: '{"disableRootAutoUpdate":1,"groupPolicyRoots":2}' })) });
  assert.deepEqual(policy.reasons, ['windows-ctl-restrictions-unestablished']);
  const failed = await observeOsTrust({ network: 'off', environment: win(async () => ({ status: 'timeout' })) });
  assert.deepEqual([failed.status, failed.reason], ['unavailable', 'trust-configuration-unavailable']);
  const garbled = await observeOsTrust({ network: 'off', environment: win(async () => ({ status: 'ok', stdout: 'not json' })) });
  assert.equal(garbled.status, 'unavailable');
  const wrong = await observeOsTrust({ network: 'off', environment: { ...win(async () => ({ status: 'ok', stdout: '{}' })), release: '10.0.19045' } });
  assert.equal(wrong.reason, 'trust-platform-unsupported');
});

test('macOS has no proven adapter: unavailable with a precise reason', async () => {
  const result = await observeOsTrust({ network: 'off', environment: { platform: 'darwin', arch: 'arm64', release: '25.0.0' } });
  assert.deepEqual([result.status, result.reason, result.projection], ['unavailable', 'trust-platform-unsupported', 'macos-effective-server-auth-v1']);
  assert.equal(parsePemBundle(rootA).status, 'parsed');
});
