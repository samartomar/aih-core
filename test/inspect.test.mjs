import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspect } from '../dist/index.js';

test('inspection uses installed Harness and distinguishes runnable, requested absent and unselected absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-inspect-'));
  const home = join(root, 'home'); const project = join(root, 'project'); const path = join(root, 'bin');
  for (const dir of [home, project, path]) mkdirSync(dir);
  const before = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    process.env.PATH = path; process.env.HOME = home; process.env.USERPROFILE = home;
    const result = await inspect({ targets: ['node', 'kiro'], network: 'off', project });
    assert.equal(result.package.name, '@aihq/harness');
    assert.equal(result.package.version, '2.0.0-dev.0');
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
    writeFileSync(filename, process.platform === 'win32' ? `@echo off\r\n"${process.execPath}" -e "${code}"\r\n` :
      `#!/bin/sh\n"${process.execPath}" -e '${code}'\n`);
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
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  try {
    const child = spawnSync(process.execPath, [cli, 'inspect', '--target', 'node', '--offline', '--project', project, '--json'], {
      env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 20000
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.status, 'complete');
    assert.equal(result.package.name, '@aihq/harness');
    assert.equal(result.tools.find(tool => tool.id === 'node').state, 'runnable');
    assert.deepEqual(result.effectiveOptions.network, { value: 'off', origin: 'explicit' });
    assert.equal(existsSync(join(home, '.aih')), false);
    assert.deepEqual(readdirSync(project), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
