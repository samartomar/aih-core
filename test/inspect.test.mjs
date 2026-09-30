import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import tls from 'node:tls';
import { inspect } from '../dist/core/index.js';
import { contractSupport } from '../dist/core/contracts.js';
import { diagnose } from '@aihq/core/harness/runtime';

test('inspection uses installed Harness and distinguishes runnable, requested absent and unselected absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-inspect-'));
  const home = join(root, 'home'); const project = join(root, 'project'); const path = join(root, 'bin');
  for (const dir of [home, project, path]) mkdirSync(dir);
  const before = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    process.env.PATH = path; process.env.HOME = home; process.env.USERPROFILE = home;
    const result = await inspect({ targets: ['node', 'kiro'], network: 'off', project });
    assert.equal(result.package.name, '@aihq/core');
    assert.equal(result.package.version, contractSupport.package.version);
    assert.equal(result.tools.find(tool => tool.id === 'node').state, 'runnable');
    assert.deepEqual(result.tools.find(tool => tool.id === 'kiro').selection, 'requested');
    assert.equal(result.checks.find(check => check.id === 'kiro/version').outcome, 'unavailable');
    assert.equal(result.checks.find(check => check.id === 'kiro/version').reason, 'executable-missing');
    assert.equal(result.repairChoices.find(choice => choice.target === 'kiro').kind, 'manual-guidance');
    assert.deepEqual(result.tools.find(tool => tool.id === 'claude').selection, 'unselected');
    assert.equal(result.checks.some(check => check.target === 'claude'), false);
    assert.deepEqual(result.effectiveOptions.network, { value: 'off', origin: 'explicit' });
    assert.deepEqual(result.effectiveOptions.probeConfiguredMcp, { value: false, origin: 'default' });
    assert.equal(result.status, 'incomplete');
    assert.deepEqual(readdirSync(project), []);
    assert.deepEqual(readdirSync(home), []);
  } finally {
    Object.assign(process.env, before);
    rmSync(root, { recursive: true, force: true });
  }
});

test('config trace does not prove a runnable executable and offline suppresses declared npm TLS', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-inspect-config-'));
  const home = join(root, 'home'); mkdirSync(home); mkdirSync(join(home, '.claude'));
  const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PATH: process.env.PATH };
  try {
    process.env.HOME = home; process.env.USERPROFILE = home; process.env.PATH = root;
    const config = await inspect({ targets: ['claude'], network: 'off' });
    assert.equal(config.tools.find(tool => tool.id === 'claude').state, 'config-only');
    assert.equal(config.checks.find(check => check.id === 'claude/version').outcome, 'unavailable');
    process.env.PATH = original.PATH;
    const npm = await inspect({ targets: ['npm'], network: 'off' });
    assert.equal(npm.checks.find(check => check.id === 'npm/tls/os/registry.npmjs.org').outcome, 'skipped');
    assert.equal(npm.checks.find(check => check.id === 'npm/tls/node/registry.npmjs.org').reason, 'network-off');
  } finally {
    Object.assign(process.env, original);
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid targets and budgets run no diagnostics', async () => {
  for (const [request, controls] of [[{ targets: ['unknown'] }, {}], [{}, { budgetMs: 180001 }], [{ network: 'surprise' }, {}]]) {
    const result = await inspect(request, controls);
    assert.equal(result.status, 'invalid');
    assert.deepEqual(result.tools, []);
    assert.deepEqual(result.checks, []);
  }
  const targets = ['node'];
  Object.defineProperty(targets, 'extra', { enumerable: true, get() { throw new Error('getter executed'); } });
  const accessor = await inspect({ targets });
  assert.equal(accessor.status, 'invalid');
  assert.deepEqual(accessor.checks, []);
  assert.equal(JSON.stringify(accessor).includes('getter executed'), false);
});

test('configured MCP HTTPS probes require separate opt-in and offline mode suppresses them without starting commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-inspect-mcp-'));
  const home = join(root, 'home'); const project = join(root, 'project'); mkdirSync(home); mkdirSync(project);
  const sentinel = join(root, 'server-started');
  writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: {
    remote: { url: 'https://example.com/mcp' },
    local: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)},'bad')`] }
  } }));
  try {
    const without = await inspect({ targets: ['claude'], network: 'off', project });
    assert.equal(without.checks.some(check => check.target === 'mcp'), false);
    const opted = await inspect({ targets: ['claude'], network: 'off', probeConfiguredMcp: true, project });
    assert.deepEqual(opted.effectiveOptions.probeConfiguredMcp, { value: true, origin: 'explicit' });
    assert.equal(opted.checks.find(check => check.id === 'mcp/tls/1').reason, 'network-off');
    assert.equal(existsSync(sentinel), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('broken version and bounded output remain failed versus unavailable, and cancellation starts no process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-inspect-process-'));
  const home = join(root, 'home'); const bin = join(root, 'bin'); mkdirSync(home); mkdirSync(bin);
  const filename = join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  const original = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const script = code => {
    const encoded = Buffer.from(code).toString('base64');
    writeFileSync(filename, process.platform === 'win32' ?
      `@echo off\r\n"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString())"\r\n` :
      `#!/bin/sh\n"${process.execPath}" -e 'eval(Buffer.from("${encoded}","base64").toString())'\n`);
    if (process.platform !== 'win32') chmodSync(filename, 0o755);
  };
  try {
    process.env.PATH = bin; process.env.HOME = home; process.env.USERPROFILE = home;
    script('process.exit(9)');
    const broken = await inspect({ targets: ['claude'], network: 'off' });
    assert.equal(broken.tools.find(tool => tool.id === 'claude').state, 'broken', JSON.stringify(broken));
    assert.equal(broken.checks.find(check => check.id === 'claude/version').outcome, 'failed');
    assert.equal(broken.diagnostics.find(item => item.reason === 'version-exit').code, 'VERIFICATION_FAILED');
    script("process.stdout.write('x'.repeat(70000))");
    const limited = await inspect({ targets: ['claude'], network: 'off' });
    assert.equal(limited.checks.find(check => check.id === 'claude/version').outcome, 'unavailable');
    assert.equal(limited.diagnostics.find(item => item.reason === 'output-bytes').code, 'DIAGNOSTIC_LIMIT');
    script("process.stdout.write('\\u00e9'.repeat(3000))");
    const unicode = await inspect({ targets: ['claude'], network: 'off' });
    assert.ok(Buffer.byteLength(unicode.checks.find(check => check.id === 'claude/version').detail) <= 4096);
    const controller = new AbortController(); controller.abort();
    const cancelled = await inspect({ targets: ['claude'], network: 'off' }, { signal: controller.signal });
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(cancelled.checks.find(check => check.id === 'claude/version').outcome, 'skipped');
    assert.equal(cancelled.checks.find(check => check.id === 'claude/version').reason, 'cancelled');
  } finally {
    Object.assign(process.env, original);
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI and API expose the same bounded offline inspection without a policy or writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-inspect-cli-'));
  const home = join(root, 'home'); const project = join(root, 'project');
  mkdirSync(home); mkdirSync(project);
  const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));
  try {
    const child = spawnSync(process.execPath, [cli, 'inspect', '--target', 'node', '--offline', '--project', project, '--json'], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 20000
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.status, 'complete');
    assert.equal(result.package.name, '@aihq/core');
    assert.equal(result.tools.find(tool => tool.id === 'node').state, 'runnable');
    assert.deepEqual(result.effectiveOptions.network, { value: 'off', origin: 'explicit' });
    assert.equal(existsSync(join(home, '.aih')), false);
    assert.deepEqual(readdirSync(project), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the selected executable wins over a same-named command in cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-inspect-shadow-'));
  const bin = join(root, 'selected folder'); const cwd = join(root, 'shadow'); const home = join(root, 'home');
  for (const dir of [bin, cwd, home]) mkdirSync(dir);
  const name = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const selected = join(bin, name); const shadow = join(cwd, name); const sentinel = join(root, 'shadow-ran');
  const original = { cwd: process.cwd(), PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    writeFileSync(selected, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
    writeFileSync(shadow, process.platform === 'win32' ? `@echo off\r\necho bad > "${sentinel}"\r\nexit /b 9\r\n` :
      `#!/bin/sh\nprintf bad > "${sentinel}"\nexit 9\n`);
    if (process.platform !== 'win32') { chmodSync(selected, 0o755); chmodSync(shadow, 0o755); }
    process.env.PATH = bin; process.env.HOME = home; process.env.USERPROFILE = home; process.chdir(cwd);
    const result = await inspect({ targets: ['claude'], network: 'off' });
    assert.equal(result.checks.find(check => check.id === 'claude/version').outcome, 'passed', JSON.stringify(result));
    assert.equal(existsSync(sentinel), false);
  } finally {
    process.chdir(original.cwd); Object.assign(process.env, original);
    rmSync(root, { recursive: true, force: true });
  }
});

test('raw version output is never displayed and malformed opted-in MCP config is unavailable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-inspect-output-'));
  const bin = join(root, 'bin'); const home = join(root, 'home'); const project = join(root, 'project');
  for (const dir of [bin, home, project]) mkdirSync(dir);
  const name = join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  const original = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    writeFileSync(name, process.platform === 'win32' ? '@echo off\r\necho fixture-secret-version\r\nexit /b 0\r\n' :
      '#!/bin/sh\nprintf fixture-secret-version\nexit 0\n');
    if (process.platform !== 'win32') chmodSync(name, 0o755);
    process.env.PATH = bin; process.env.HOME = home; process.env.USERPROFILE = home;
    writeFileSync(join(project, '.mcp.json'), '{bad');
    const malformed = await inspect({ targets: ['claude'], network: 'off', probeConfiguredMcp: true, project });
    assert.equal(malformed.status, 'incomplete');
    assert.equal(malformed.checks.find(check => check.id === 'mcp/configuration/config-invalid').outcome, 'unavailable');
    assert.equal(JSON.stringify(malformed).includes('fixture-secret-version'), false);
    rmSync(join(project, '.mcp.json')); mkdirSync(join(project, '.mcp.json'));
    const unreadable = await inspect({ targets: ['claude'], network: 'off', probeConfiguredMcp: true, project });
    assert.equal(unreadable.status, 'incomplete');
    assert.equal(unreadable.checks.find(check => check.id === 'mcp/configuration/config-unavailable').outcome, 'unavailable');
  } finally {
    Object.assign(process.env, original);
    rmSync(root, { recursive: true, force: true });
  }
});

test('direct Harness requests reject hostile arrays without running toJSON or accessors', async () => {
  const request = targets => ({ requestId: 'fixture', targets, network: 'off' });
  const cases = [];
  const accessor = ['node']; Object.defineProperty(accessor, 'extra', { get() { throw new Error('accessor ran'); } }); cases.push(accessor);
  const cycle = ['node']; cycle.extra = cycle; cases.push(cycle);
  const toJson = ['node']; toJson.toJSON = () => { throw new Error('toJSON ran'); }; cases.push(toJson);
  cases.push(new Proxy(['node'], { get() { throw new Error('proxy ran'); } }));
  for (const targets of cases) {
    const result = await diagnose(request(targets));
    assert.equal(result.status, 'invalid');
    assert.deepEqual(result.checks, []);
  }
});

test('declared network is bounded, curl ignores config and TLS failure is interpreted only with OS evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-inspect-transport-'));
  const bin = join(root, 'bin'); const home = join(root, 'home'); mkdirSync(bin); mkdirSync(home);
  for (const name of ['npm', 'curl']) writeFileSync(join(bin, process.platform === 'win32' ? name + (name === 'curl' ? '.exe' : '.cmd') : name), '');
  const original = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
    SSLKEYLOGFILE: process.env.SSLKEYLOGFILE, CURL_CA_BUNDLE: process.env.CURL_CA_BUNDLE,
    spawn: childProcess.spawn, connect: tls.connect };
  const calls = [];
  const fakeSpawn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  try {
    process.env.PATH = bin; process.env.HOME = home; process.env.USERPROFILE = home;
    process.env.SSLKEYLOGFILE = join(root, 'keylog'); process.env.CURL_CA_BUNDLE = join(root, 'ca.pem');
    childProcess.spawn = fakeSpawn; syncBuiltinESMExports();
    tls.connect = (_options, callback) => {
      const socket = new EventEmitter(); socket.destroy = () => {}; socket.authorized = false;
      queueMicrotask(() => socket.emit('error', Object.assign(new Error('private'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })));
      return socket;
    };
    const result = await diagnose({ requestId: 'fixture', targets: ['npm'], network: 'declared' });
    assert.equal(result.checks.find(check => check.id === 'npm/tls/os/registry.npmjs.org').outcome, 'passed');
    assert.equal(result.checks.find(check => check.id === 'npm/tls/node/registry.npmjs.org').reason, 'node-certificate-chain');
    const curl = calls.find(call => call.args[0] === '--disable');
    assert.ok(curl, JSON.stringify(calls.map(call => call.args)));
    assert.equal(curl.options.env.SSLKEYLOGFILE, undefined);
    assert.equal(curl.options.env.CURL_CA_BUNDLE, undefined);
    assert.equal(existsSync(join(root, 'keylog')), false);
    tls.connect = (_options, callback) => {
      const socket = new EventEmitter(); socket.destroy = () => {};
      queueMicrotask(() => socket.emit('error', Object.assign(new Error('private'), { code: 'ECONNREFUSED' })));
      return socket;
    };
    const refused = await diagnose({ requestId: 'refused', targets: ['npm'], network: 'declared' });
    assert.equal(refused.checks.find(check => check.id === 'npm/tls/node/registry.npmjs.org').reason, 'connection-failed');
    assert.equal(refused.repairChoices.some(choice => choice.reason === 'node-certificate-chain'), false);
    tls.connect = (_options, callback) => {
      const socket = new EventEmitter(); socket.destroy = () => {}; socket.authorized = true;
      setTimeout(callback, 150);
      return socket;
    };
    const late = await diagnose({ requestId: 'late', targets: ['npm'], network: 'declared' }, { budgetMs: 100 });
    const nodeCheck = late.checks.find(check => check.id === 'npm/tls/node/registry.npmjs.org');
    assert.equal(nodeCheck.outcome, 'unavailable');
    assert.equal(nodeCheck.reason, 'deadline');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(nodeCheck.outcome, 'unavailable');
    childProcess.spawn = () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
      setTimeout(() => child.emit('close', 0), 80);
      return child;
    };
    syncBuiltinESMExports();
    const elapsed = await diagnose({ requestId: 'elapsed', targets: ['node'], network: 'off' }, { budgetMs: 20 });
    assert.equal(elapsed.checks.find(check => check.id === 'node/version').reason, 'deadline');
    childProcess.spawn = () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => true; // Deliberately never emits close.
      return child;
    };
    syncBuiltinESMExports();
    const controller = new AbortController();
    const interrupted = diagnose({ requestId: 'interrupted', targets: ['node'], network: 'off' }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const cancelled = await interrupted;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.checks.find(check => check.id === 'node/version').reason, 'cancelled');
    assert.equal(cancelled.diagnostics.some(item => item.reason === 'termination-unresolved'), true);
  } finally {
    childProcess.spawn = original.spawn; syncBuiltinESMExports(); tls.connect = original.connect;
    Object.assign(process.env, { PATH: original.PATH, HOME: original.HOME, USERPROFILE: original.USERPROFILE });
    if (original.SSLKEYLOGFILE === undefined) delete process.env.SSLKEYLOGFILE; else process.env.SSLKEYLOGFILE = original.SSLKEYLOGFILE;
    if (original.CURL_CA_BUNDLE === undefined) delete process.env.CURL_CA_BUNDLE; else process.env.CURL_CA_BUNDLE = original.CURL_CA_BUNDLE;
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unconfirmed child stops all later probes, and abort during deadline cleanup wins', async () => {
  const originalSpawn = childProcess.spawn;
  let calls = 0;
  try {
    childProcess.spawn = () => {
      calls++;
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => true; // No close confirmation within the two-second cleanup window.
      queueMicrotask(() => child.stdout.emit('data', Buffer.alloc(65537)));
      return child;
    };
    syncBuiltinESMExports();
    const overflow = await inspect({ targets: ['node', 'npm', 'git'], network: 'off' }, { budgetMs: 5000 });
    assert.equal(overflow.status, 'incomplete');
    assert.equal(overflow.checks.find(check => check.id === 'node/version').reason, 'output-bytes');
    assert.equal(overflow.checks.find(check => check.id === 'npm/version').reason, 'termination-unresolved');
    assert.equal(overflow.checks.find(check => check.id === 'git/version').outcome, 'skipped');
    assert.equal(overflow.diagnostics.some(item => item.reason === 'termination-unresolved'), true);
    assert.equal(calls, 1, 'No later diagnostic child may start after uncertain termination.');

    calls = 0;
    childProcess.spawn = () => {
      calls++;
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => true;
      return child;
    };
    syncBuiltinESMExports();
    const controller = new AbortController();
    const pending = inspect({ targets: ['node', 'npm'], network: 'off' }, { signal: controller.signal, budgetMs: 20 });
    setTimeout(() => controller.abort(), 50); // Abort after deadline entered cleanup.
    const cancelled = await pending;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.checks.find(check => check.id === 'node/version').reason, 'cancelled');
    assert.equal(cancelled.checks.find(check => check.id === 'npm/version').reason, 'cancelled');
    assert.equal(cancelled.diagnostics.some(item => item.reason === 'termination-unresolved'), true);
    assert.equal(cancelled.diagnostics.some(item => item.reason === 'deadline'), true);
    assert.equal(calls, 1);
  } finally {
    childProcess.spawn = originalSpawn; syncBuiltinESMExports();
  }
});

test('an unconfirmed curl probe prevents Node TLS and subsequent selected tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-inspect-curl-hung-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  for (const name of ['npm', 'curl', 'git']) {
    const suffix = process.platform === 'win32' ? name === 'npm' ? '.cmd' : '.exe' : '';
    writeFileSync(join(bin, name + suffix), '');
  }
  const original = { PATH: process.env.PATH, spawn: childProcess.spawn, connect: tls.connect };
  let spawns = 0; let sockets = 0;
  try {
    process.env.PATH = bin;
    childProcess.spawn = () => {
      spawns++;
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => true;
      if (spawns === 1) queueMicrotask(() => child.emit('close', 0));
      else queueMicrotask(() => child.stdout.emit('data', Buffer.alloc(65537)));
      return child;
    };
    syncBuiltinESMExports();
    tls.connect = () => { sockets++; throw new Error('TLS must not start after uncertain curl termination'); };
    const result = await inspect({ targets: ['npm', 'git'], network: 'declared', probeConfiguredMcp: true }, { budgetMs: 5000 });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.checks.find(check => check.id === 'npm/tls/os/registry.npmjs.org').reason, 'output-bytes');
    assert.equal(result.checks.find(check => check.id === 'npm/tls/node/registry.npmjs.org').reason, 'termination-unresolved');
    assert.equal(result.checks.find(check => check.id === 'git/version').outcome, 'skipped');
    assert.equal(result.checks.find(check => check.id === 'mcp/configuration').reason, 'termination-unresolved');
    assert.equal(spawns, 2); assert.equal(sockets, 0);
  } finally {
    process.env.PATH = original.PATH; childProcess.spawn = original.spawn; syncBuiltinESMExports();
    tls.connect = original.connect; rmSync(root, { recursive: true, force: true });
  }
});
