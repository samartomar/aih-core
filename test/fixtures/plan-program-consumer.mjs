// Runs inside a disposable consumer with the packed @aihq/core installed; public entries and the `aih` bin only.
// Program steps through plan requests (contract 8.1, 12, C30, C60): an acquired tool, its input-bearing tool-command and
// the MCP entry that starts it; a forced failure beside an unrelated item; the restore with its prior value at removal; a killed
// command; an upstream setup and an upstream installer. Every program is a `fake-tool.cjs` PROCESS FIXTURE, artifacts
// come from a local HTTPS FIXTURE server and the upstream repository is a local git FIXTURE.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { artifactServer } from './acquire-fixture.mjs';
import { fakeState, installFakePrograms, installerStep, programEnvironment, programRequest, toolSetup, upstreamRepository } from './program-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });

// Child mode: the public API in a process whose PATH, trust and fakes the parent chose.
if (process.argv[2] === 'child') {
  const { apply, list, prepare, prepareRemoval } = await import('@aihq/core');
  const { validateFormat } = await import('@aihq/core/contracts');
  const conforms = value => { assert.equal(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
  const [, , , mode, file, project, scope] = process.argv;
  // A saved request carries source bytes as JSON's Buffer form; the API takes them as bytes.
  const read = path => { const request = JSON.parse(readFileSync(path, 'utf8'));
    for (const entry of request.files ?? []) if (entry.bytes?.type === 'Buffer') entry.bytes = Uint8Array.from(entry.bytes.data);
    return request; };
  let out;
  if (mode === 'install' || mode === 'review') {
    const prepared = await prepare(read(file));
    if (prepared.status !== 'ready' || mode === 'review') { console.log(JSON.stringify({ prepared })); process.exit(0); }
    const run = conforms(await apply(prepared.handle, approve(conforms(prepared.review))));
    out = { review: prepared.review, run, list: conforms(await list({ target: { project }, scope: 'both' })) };
  } else if (mode === 'resume') {
    const prepared = await prepare(read(file));
    out = { review: prepared.review, run: conforms(await apply(prepared.handle, approve(prepared.review))),
      list: conforms(await list({ target: { project }, scope: 'both' })) };
  } else {
    const removal = await prepareRemoval({ target: { project }, scope, removals: [{ managementId: file }] });
    out = { review: removal.review && conforms(removal.review), removed: conforms(await apply(removal.handle, approve(removal.review))) };
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

const certificates = JSON.parse(readFileSync(join(here, 'certificates.json'), 'utf8'));
const home = process.env.HOME;
const root = mkdtempSync(join(home, 'program-'));
const caFile = join(root, 'ca.pem'); writeFileSync(caFile, certificates.caPem);
const server = await artifactServer({}, certificates);
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };
try {
  const bin = join(root, 'bin'); const state = join(root, 'state');
  installFakePrograms(bin);
  const project = join(root, 'project'); mkdirSync(project);
  const write = (name, request) => { const path = join(root, `${name}.json`); writeFileSync(path, JSON.stringify(request)); return path; };
  const environment = (mode = '', extra = {}) => ({ ...process.env, ...programEnvironment(bin, state, mode), NODE_EXTRA_CA_CERTS: caFile, ...extra });
  const cli = join(here, 'node_modules', '@aihq', 'core', 'dist', 'core', 'cli.js');
  // Asynchronous: the fixture server in this process must keep answering while the child runs.
  const exec = (args, env, onSpawn) => new Promise((resolve, reject) => {
    const spawned = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn?.(spawned);
    let stdout = '', stderr = '';
    spawned.stdout.on('data', chunk => { stdout += chunk; }); spawned.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => spawned.kill(), 600_000);
    spawned.once('error', reject);
    spawned.once('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
  const child = async (args, env) => {
    const result = await exec([fileURLToPath(import.meta.url), 'child', ...args], env);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
  };
  const step = (run, index) => run.steps.find(entry => entry.step === index);
  const secret = 'packed-token-0123456789';

  const journey = toolSetup(server, { name: 'packed-graph', token: true });
  await check('cli-acquired-tool-input-command-and-mcp', async () => {
    const file = write('journey', programRequest(project, { setups: [journey] }));
    const result = await exec([cli, 'install', file, '--apply', '--yes', '--json', '--private-input', `${journey.id}.TOOL_TOKEN=PACKED_TOKEN`],
      environment('', { PACKED_TOKEN: secret }));
    const run = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.deepEqual([result.status, run.completion], [0, 'complete'], result.stdout + result.stderr);
    assert.deepEqual(step(run, 2).verification, { status: 'passed', reason: 'readback-matched' });
    assert.ok(!result.stdout.includes(secret), 'the CLI output never shows the secret');
    const [prior, set] = fakeState(state, 'fake-tool').calls;
    assert.deepEqual(prior.argv, ['config', 'get', 'auto_index'], 'the readback runs first: its output is the prior value');
    assert.deepEqual(set.argv, ['config', 'set', 'auto_index', 'false']);
    assert.equal(set.tokenSha256, createHash('sha256').update(secret).digest('hex'));
    assert.ok(JSON.parse(readFileSync(join(project, '.mcp.json'), 'utf8')).mcpServers['packed-graph']);
  });
  await check('forced-failure-skips-item-and-mcp-consumer', async () => {
    // A forced hash failure on the download (journey 16): its MCP entry and tool-command are not attempted.
    const failing = toolSetup(server, { name: 'packed-fail' });
    server.serve(`/${failing.acquire.distribution.file}`, Buffer.from('not the qualified archive'));
    const out = await child(['install', write('failing', programRequest(project, { setups: [failing], skills: [{ name: 'other', text: '# other\n' }] })), project],
      environment());
    assert.equal(out.run?.completion, 'incomplete', JSON.stringify(out));
    assert.deepEqual([step(out.run, 0).application, step(out.run, 3).application, step(out.run, 2).application, step(out.run, 1).application],
      ['failed', 'not-attempted', 'not-attempted', 'applied']);
  });
  await check('removal-runs-restore-with-prior-and-readback', async () => {
    const mcp = await child(['remove', journey.mcpItem, project, 'project'], environment());
    assert.equal(mcp.removed.completion, 'complete', JSON.stringify(mcp));
    const out = await child(['remove', journey.id, project, 'user'], environment());
    assert.equal(out.removed.completion, 'complete', JSON.stringify(out));
    assert.deepEqual(out.review.steps.find(entry => entry.op === 'tool-command').program.argv, ['config', 'set', 'auto_index', 'unset']);
    assert.ok(out.removed.steps.some(entry => entry.verification.reason === 'readback-matched'));
    assert.equal(existsSync(join(home, ...journey.folder.split('/'))), false);
  });
  await check('killed-command-is-uncertain-and-reviewed-again', async () => {
    const hang = toolSetup(server, { name: 'packed-hang' });
    const file = write('hang', programRequest(project, { setups: [hang] }));
    const started = join(state, 'fake-tool.started');
    const killed = await exec([fileURLToPath(import.meta.url), 'child', 'install', file, project], environment('set-hang'), spawned => {
      const watch = setInterval(() => { if (existsSync(started)) { clearInterval(watch); spawned.kill('SIGKILL'); } }, 50);
      spawned.once('close', () => clearInterval(watch));
    });
    assert.notEqual(killed.status, 0, 'the host was killed mid-command');
    const again = await child(['resume', file, project], environment());
    const shown = again.review.steps.find(entry => entry.op === 'tool-command');
    assert.equal(shown.previous, 'interrupted', JSON.stringify(again.review));
    assert.equal(again.run.completion, 'complete', JSON.stringify(again.run));
    assert.equal(again.list.entries.find(entry => entry.managementId === hang.id).installState, 'complete');
  });
  await check('upstream-setup-clone-and-installer-unmanaged', async () => {
    const upstream = upstreamRepository(root, home);
    const installer = installerStep('packed-other');
    const out = await child(['install', write('upstream', programRequest(project, { upstream: [upstream], installers: [installer] })), project], environment());
    assert.equal(out.run?.completion, 'complete', JSON.stringify(out));
    assert.ok(existsSync(join(home, '.claude', 'skills', 'gstack', 'built.txt')));
    assert.equal(out.review.steps.find(entry => entry.op === 'upstream-installer').program.managed, false);
    const removed = await child(['remove', 'gstack', project, 'user'], environment());
    assert.equal(removed.removed.completion, 'complete', JSON.stringify(removed));
    assert.equal(existsSync(join(home, '.claude', 'skills', 'gstack')), false);
    const unmanaged = await child(['remove', installer.id, project, 'user'], environment());
    assert.match(unmanaged.review.steps.find(entry => entry.op === 'upstream-installer').cantPromise, /can't remove/);
    assert.ok(existsSync(join(home, '.fake-installed')), 'what the installer wrote stays');
  });
} finally { await server.close(); }
console.log(JSON.stringify({ status: 'passed', checks }));
