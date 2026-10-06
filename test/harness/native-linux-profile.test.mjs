import assert from 'node:assert/strict';
import test from 'node:test';
import { createLinuxBaseProfile, deriveLinuxSessionProfile, verifyLinuxSessionProfile,
  fixedLinuxCommand, initializeLinuxProfile } from '../../src/harness/native/linux-profile.mjs';

const root = '/tmp/aih-native-0123456789abcdef0123456789abcdef';
const input = () => ({
  cell: { path: root, home: `${root}/home`, project: `${root}/project`, scratch: `${root}/scratch`, observations: `${root}/observations` },
  runtime: { node: '/opt/aih-node/bin/node', client: '/opt/aih-client/claude', bash: '/usr/bin/bash',
    env: '/usr/bin/env', bwrap: '/usr/bin/bwrap', socat: '/usr/bin/socat', rg: '/usr/bin/rg',
    libraries: ['/usr/lib/x86_64-linux-gnu'], readFiles: [] },
  workload: '/opt/aih/dist/harness/native/linux-workload.mjs',
  plan: `${root}/observations/workload.json`,
  selectedPaths: [`${root}/project/CLAUDE.md`, `${root}/project/.mcp.json`, `${root}/project/.aihq-native/server.mjs`, `${root}/home/.claude/settings.json`]
});
const slots = () => ({ collector: 'http://127.0.0.1:43210/v1/logs', evidence: `${root}/observations/e1`,
  probe: `${root}/observations/e2`, http: `${root}/observations/s1/claude-http-0123456789abcdef.sock`,
  socks: `${root}/observations/s1/claude-socks-0123456789abcdef.sock` });

test('fixed profile denies the host root and permits only owned writable roots and pinned runtime reads', () => {
  const base = createLinuxBaseProfile(input());
  assert.deepEqual(base.filesystem.denyRead, ['/']);
  assert.deepEqual(base.filesystem.allowWrite, [`${root}/home`, `${root}/project`, `${root}/scratch`]);
  assert.deepEqual(base.filesystem.denyWrite, input().selectedPaths);
  assert.equal(base.network.strictAllowlist, true);
  assert.deepEqual(base.network.allowedDomains, ['api.anthropic.com:443', 'claude.ai:443', 'platform.claude.com:443']);
  assert.equal(base.network.allowAllUnixSockets, true);
  assert.equal(base.enableWeakerNestedSandbox, false);
  assert.equal(base.enableWeakerNetworkIsolation, false);
  assert.equal(Object.isFrozen(base.filesystem.allowRead), true);
});

test('an installed scoped package layout is an accepted workload and read path', () => {
  const value = input();
  value.workload = '/home/u/app/node_modules/@aihq/core/dist/harness/native/linux-workload.mjs';
  value.runtime.readFiles = ['/home/u/app/node_modules/@aihq/core/dist/harness/native/linux/facility'];
  const base = createLinuxBaseProfile(value);
  for (const path of [value.workload, ...value.runtime.readFiles]) assert.equal(base.filesystem.allowRead.includes(path), true);
});

test('profile refuses scope-like injection and shell metacharacters in workload and read paths', () => {
  for (const path of ['/x/node_modules/@(x)/y', '/x/a@b', '/x/@', '/x/@/y', '/x/*', "/x/'", '/x/!', '/x/{a}', '/x/[a]']) {
    const workload = input(); workload.workload = path;
    assert.throws(() => createLinuxBaseProfile(workload), /isolation-unobserved/);
    const read = input(); read.runtime.readFiles = [path];
    assert.throws(() => createLinuxBaseProfile(read), /isolation-unobserved/);
  }
});

test('session derivation permits only the exact collector and individually owned sockets', () => {
  const base = createLinuxBaseProfile(input()), before = JSON.stringify(base);
  const profile = deriveLinuxSessionProfile(base, slots());
  const initial = initializeLinuxProfile(base, slots().collector);
  assert.deepEqual(initial.network, profile.network);
  assert.deepEqual(initial.filesystem, base.filesystem);
  assert.throws(() => initializeLinuxProfile(structuredClone(base), slots().collector));
  assert.equal(JSON.stringify(base), before);
  assert.deepEqual(profile.network.allowedDomains.slice(-1), ['127.0.0.1:43210']);
  assert.equal(profile.filesystem.allowRead.includes(root), false);
  assert.equal(profile.filesystem.allowRead.includes(`${root}/observations`), false);
  for (const key of ['evidence', 'probe', 'http', 'socks']) assert.equal(profile.filesystem.allowRead.includes(slots()[key]), true);
  assert.equal(verifyLinuxSessionProfile(base, slots(), JSON.stringify(profile)), true);
  for (const mutate of [p => p.network.allowedDomains.push('127.0.0.1'), p => p.filesystem.allowRead.push('/home'),
    p => { p.network.httpProxyPort = 1234; }, p => { p.credentials = {}; }, p => { p.network.allowAllUnixSockets = false; }]) {
    const changed = structuredClone(profile); mutate(changed);
    assert.equal(verifyLinuxSessionProfile(base, slots(), JSON.stringify(changed)), false);
  }
});

test('profile refuses injection, path escapes, extra derivation slots and ambiguous endpoints', () => {
  for (const path of ['/tmp/a b', '/tmp/x;id', '/tmp/x$(id)', '/tmp/x/../y', '/tmp/x\\y', '/tmp/x\n']) {
    const value = input(); value.runtime.node = path;
    assert.throws(() => createLinuxBaseProfile(value));
  }
  const base = createLinuxBaseProfile(input());
  for (const collector of ['http://localhost:1234/v1/logs', 'http://127.0.0.1:1234/', 'https://127.0.0.1:1234/v1/logs',
    'http://user:pass@127.0.0.1:1234/v1/logs', 'http://127.0.0.1:1234/v1/logs?q=1'])
    assert.throws(() => deriveLinuxSessionProfile(base, { ...slots(), collector }));
  assert.throws(() => deriveLinuxSessionProfile(base, { ...slots(), other: '/tmp/other' }));
  assert.throws(() => deriveLinuxSessionProfile(base, { ...slots(), evidence: '/run/user/1000/agent' }));
  assert.throws(() => deriveLinuxSessionProfile(base, { ...slots(), evidence: `${root}/observations/` }));
  assert.throws(() => deriveLinuxSessionProfile(base, { ...slots(), http: `${root}/scratch/agent.sock` }));
});

test('fixed command clears only loopback bypass variables and preserves the literal empty tools value', () => {
  assert.equal(fixedLinuxCommand('/usr/bin/env', '/opt/client/claude', ['-p', '--tools', '']),
    "'/usr/bin/env' '-u' 'NO_PROXY' '-u' 'no_proxy' '/opt/client/claude' '-p' '--tools' ''");
  for (const argument of ['x y', '$(id)', ';id', 'x\n', "x'y"]) assert.throws(() => fixedLinuxCommand('/usr/bin/env', '/opt/client/claude', [argument]));
});
