// POSIX only: a terminal Ctrl-C to the `aih` CLI while it runs an approved program (an upstream installer here). The
// program is a Core-side PROCESS FIXTURE, a shell script that ignores SIGINT, SIGTERM and SIGHUP and starts a child that
// ignores them too, the hardest case for stopping what Core started. Disposable home and project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installerStep, programRequest } from './fixtures/program-fixture.mjs';

const windows = process.platform === 'win32';
const cli = fileURLToPath(new URL('../dist/core/cli.js', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Starts `aih install --apply` of a plan whose installer traps every signal, in its own process group like a shell job. */
async function running(root) {
  const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true });
  const home = join(root, 'home'); mkdirSync(home);
  const project = join(root, 'project'); mkdirSync(project);
  const pids = join(root, 'pids');
  writeFileSync(join(bin, 'trapper'), `#!/bin/sh\ntrap '' INT TERM HUP\n` +
    `sh -c 'trap "" INT TERM HUP; echo $$ >> "${pids}"; while :; do sleep 1; done' &\n` +
    `echo $$ >> "${pids}"\nwhile :; do sleep 1; done\n`);
  chmodSync(join(bin, 'trapper'), 0o755);
  const installer = installerStep('trapper');
  installer.step.argv = ['trapper', 'go'];
  const file = join(root, 'plan.json');
  writeFileSync(file, JSON.stringify(programRequest(project, { installers: [installer] })));
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), NODE_OPTIONS: '' };
  const child = spawn(process.execPath, [cli, 'install', file, '--apply', '--yes', '--json'], { cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  const closed = new Promise(resolve => child.once('close', code => resolve(code)));
  const listed = () => existsSync(pids) ? readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  for (let waited = 0; listed().length < 2 && waited < 200; waited++) await sleep(100);
  return { child, closed, pids: listed(), output: () => stdout };
}

test('one Ctrl-C cancels the run: the result is cancelled and nothing Core started survives', { skip: windows }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-cli-sigint-'));
  try {
    const { child, closed, pids, output } = await running(root);
    assert.equal(pids.length, 2, 'the installer and its child run');
    process.kill(-child.pid, 'SIGINT');
    const code = await Promise.race([closed, sleep(15_000).then(() => 'timeout')]);
    await sleep(500);
    const left = pids.filter(alive);
    for (const pid of left) process.kill(pid, 'SIGKILL');
    assert.equal(code, 130, output());
    assert.equal(JSON.parse(output().trim().split('\n').at(-1)).completion, 'cancelled', output());
    assert.deepEqual(left, [], 'nothing outlived the cancel');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a second Ctrl-C ends the CLI at once, after killing what Core started', { skip: windows }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-cli-sigint2-'));
  try {
    const { child, closed, pids } = await running(root);
    assert.equal(pids.length, 2);
    process.kill(-child.pid, 'SIGINT');
    await sleep(200);
    process.kill(-child.pid, 'SIGINT');
    const code = await Promise.race([closed, sleep(5_000).then(() => 'timeout')]);
    await sleep(300);
    const left = pids.filter(alive);
    for (const pid of left) process.kill(pid, 'SIGKILL');
    assert.equal(code, 130);
    assert.deepEqual(left, [], 'nothing outlived the CLI');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
