import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import tls from 'node:tls';
import { inspect } from '../dist/core/index.js';
import { getGuidance } from '@aihq/core/support';

const guidancePlatform = ['win32', 'darwin', 'linux'].includes(process.platform) ? process.platform : 'unknown';

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'aih-guidance-'));
  const bin = join(root, 'bin'), home = join(root, 'home'), project = join(root, 'project');
  for (const dir of [bin, home, project]) mkdirSync(dir);
  writeFileSync(join(bin, process.platform === 'win32' ? 'npm.cmd' : 'npm'), '');
  writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { remote: { url: 'https://example.invalid/mcp' } } }));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const spawn = childProcess.spawn, connect = tls.connect;
  try {
    Object.assign(process.env, { PATH: bin, HOME: home, USERPROFILE: home });
    childProcess.spawn = () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.kill = () => true; queueMicrotask(() => child.emit('close', 0)); return child;
    };
    syncBuiltinESMExports();
    tls.connect = () => {
      const socket = new EventEmitter(); socket.destroy = () => {};
      queueMicrotask(() => socket.emit('error', Object.assign(new Error('private'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })));
      return socket;
    };
    await run({ project });
  } finally {
    childProcess.spawn = spawn; syncBuiltinESMExports(); tls.connect = connect;
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
}

test('OS TLS missing prerequisite remains a npm check but manual guidance names curl', async () => {
  await fixture(async () => {
    const result = await inspect({ targets: ['npm'], network: 'declared' });
    const check = result.checks.find(check => check.id === 'npm/tls/os/registry.npmjs.org');
    assert.deepEqual({ target: check.target, outcome: check.outcome, reason: check.reason },
      { target: 'npm', outcome: 'unavailable', reason: 'executable-missing' });
    const choice = result.repairChoices.find(choice => choice.reason === 'executable-missing');
    assert.equal(choice.kind, 'manual-guidance');
    assert.equal(choice.target, 'curl');
    assert.match(choice.guidance, /curl/);
    assert.doesNotMatch(choice.guidance, /npm.*(?:absent|missing)|requested tool is absent/i);
    const item = getGuidance({ kind: 'inspect', result }, { platform: guidancePlatform }).items.find(item => item.id === 'missing-curl');
    assert.equal(choice.guidance, [item.summary, ...item.steps].join(' '));
  });
});

test('configured MCP certificate evidence receives diagnostic Node guidance without a loading claim', async () => {
  await fixture(async ({ project }) => {
    const result = await inspect({ targets: ['claude'], network: 'declared', probeConfiguredMcp: true, project });
    assert.equal(result.checks.find(check => check.id === 'mcp/tls/1').reason, 'certificate-chain');
    const choice = result.repairChoices.find(choice => choice.target === 'mcp' && choice.reason === 'certificate-chain');
    assert.ok(choice, 'MCP certificate-chain must have manual guidance');
    assert.equal(choice.kind, 'manual-guidance');
    assert.match(choice.guidance, /diagnostic Node TLS probe/);
    assert.match(choice.guidance, /Confirm which runtime/);
    assert.match(choice.guidance, /does not prove/);
    const item = getGuidance({ kind: 'inspect', result }, { platform: guidancePlatform }).items.find(item => item.id === 'mcp-node-trust');
    assert.equal(choice.guidance, [item.summary, ...item.steps].join(' '));
  });
});
