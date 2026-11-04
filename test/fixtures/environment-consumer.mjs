// Runs inside a disposable consumer with the packed @aihq/core installed; public entries and the `aih` bin only.
// Environment work through the 0.1.0 review and run: a supplied-file Git trust repair (API and CLI), its stale-source
// and stale-target rejections, managed removal of what it wrote, and the explicit outcomes of routes and hosts that are
// not admitted here. The CA is a test fixture; no real proxy, platform trust store or native client is exercised.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFormat } from '@aihq/core/contracts';
import { apply, list, prepare, prepareRemoval } from '@aihq/core';

const here = dirname(fileURLToPath(import.meta.url));
const home = process.env.HOME;
const conforms = value => { assert.equal(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const cli = join(here, 'node_modules', '@aihq', 'core', 'dist', 'core', 'cli.js');
const aih = args => spawnSync(process.execPath, [cli, ...args], { cwd: here, env: process.env, encoding: 'utf8', timeout: 120_000, windowsHide: true });
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };
const ca = join(here, 'team.pem');
const request = () => ({ schema: 'urn:aihq:core:repair-request:0.1.0', repair: 'user-tools-ca', targets: ['git'], route: 'file',
  network: 'off', sources: { os: false, supplied: [{ id: 'team', file: ca }] } });
const gitconfig = join(home, '.gitconfig');

await check('repair is reviewed and run through the 0.1.0 review and run, keeping your own settings', async () => {
  writeFileSync(gitconfig, '[user]\n\tname = Fixture\n');
  const preparation = await prepare(request(), { logging: 'off' });
  assert.equal(preparation.status, 'ready', JSON.stringify(preparation));
  conforms(preparation.review);
  assert.equal(preparation.review.environment.facts.trust.targets[0].admission, 'admitted');
  const run = conforms(await apply(preparation.handle, approve(preparation.review), { logging: 'off' }));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.match(readFileSync(gitconfig, 'utf8'), /name = Fixture[\s\S]*sslCAInfo/);
  conforms(JSON.parse(readFileSync(join(home, '.aih', 'core', 'trust-custody.json'), 'utf8')));
});

await check('a changed source or target after review is rejected without effects', async () => {
  const source = await prepare(request(), { logging: 'off' });
  const before = readFileSync(gitconfig, 'utf8');
  appendFileSync(ca, '\n');
  const stale = conforms(await apply(source.handle, approve(source.review), { logging: 'off' }));
  assert.equal(stale.completion, 'rejected'); assert.equal(stale.code, 'REVIEW_STALE');
  assert.equal(readFileSync(gitconfig, 'utf8'), before);
  const target = await prepare(request(), { logging: 'off' });
  assert.equal(target.status, 'ready', JSON.stringify(target));
  appendFileSync(gitconfig, '[core]\n\teditor = vi\n');
  const changed = conforms(await apply(target.handle, approve(target.review), { logging: 'off' }));
  assert.equal(changed.completion, 'rejected'); assert.equal(changed.code, 'REVIEW_STALE');
});

await check('the aih CLI reads a 0.1.0 inputs file with paths relative to it and prints the 0.1.0 review and run', async () => {
  writeFileSync(join(here, 'repair-inputs.json'), JSON.stringify({ schema: 'urn:aihq:core:repair-inputs:0.1.0', route: 'file',
    sources: { os: false, supplied: [{ id: 'team', file: 'team.pem' }] } }));
  const preview = aih(['repair', 'user-tools-ca', '--target', 'git', '--inputs-file', 'repair-inputs.json', '--offline', '--no-log', '--json']);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  const review = conforms(JSON.parse(preview.stdout).review);
  assert.equal(review.request, 'repair');
  const applied = aih(['repair', 'user-tools-ca', '--target', 'git', '--inputs-file', 'repair-inputs.json', '--offline', '--apply', '--yes', '--no-log', '--json']);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.equal(conforms(JSON.parse(applied.stdout)).completion, 'complete');
  const unknown = aih(['repair', 'user-tools-ca', '--target', 'gradle', '--offline', '--no-log', '--json']);
  assert.equal(unknown.status, 2, unknown.stdout + unknown.stderr);
  assert.equal(JSON.parse(unknown.stdout).status, 'invalid');
});

await check('removal by the repair id retires the repair and restores your own settings', async () => {
  assert.ok((await list({ target: { project: null }, scope: 'user' })).entries.some(entry => entry.managementId === 'user-tools-ca'));
  const removal = await prepareRemoval({ target: { project: null }, scope: 'user', removals: [{ managementId: 'user-tools-ca' }] }, { logging: 'off' });
  assert.equal(removal.status, 'ok', JSON.stringify(removal));
  const removed = await apply(removal.handle, approve(removal.review), { logging: 'off' });
  assert.equal(removed.completion, 'complete', JSON.stringify(removed));
  assert.doesNotMatch(readFileSync(gitconfig, 'utf8'), /sslCAInfo/);
  assert.match(readFileSync(gitconfig, 'utf8'), /name = Fixture/);
});

await check('routes and hosts without admission stay explicit, with no effects', async () => {
  const native = await prepare({ schema: 'urn:aihq:core:repair-request:0.1.0', repair: 'node-npm-ca', targets: ['npm'], route: 'native' }, { logging: 'off' });
  assert.equal(native.status, 'blocked'); assert.equal(native.handle, undefined);
  assert.ok(conforms(native.review).environment.unavailable.some(problem => problem.reason === 'native-route-unsupported'));
  writeFileSync(join(here, 'export-inputs.json'), JSON.stringify({ schema: 'urn:aihq:core:export-inputs:0.1.0',
    sources: { os: false, supplied: [{ id: 'team', file: 'team.pem' }] } }));
  const exported = aih(['export-ca', '--format', 'pem', '--output', 'exports/team.pem', '--inputs-file', 'export-inputs.json', '--offline', '--no-log', '--json']);
  const value = JSON.parse(exported.stdout);
  conforms(value.review);
  assert.equal(value.review.request, 'export');
  if (value.status === 'blocked') {
    assert.equal(exported.status, 1);
    assert.ok(value.review.environment.unavailable.some(problem => ['trust-platform-unsupported', 'trust-format-unavailable'].includes(problem.reason)));
    assert.equal(existsSync(join(home, 'exports')), false);
  } else assert.equal(value.status, 'ready');
});

await check('the macOS session check answers the 0.1.0 request with the 0.1.0 result', async () => {
  const { verifyMacosSession } = await import('@aihq/core');
  const result = conforms(await verifyMacosSession({ schema: 'urn:aihq:core:macos-session-verification-request:0.1.0', managementId: 'node-npm-ca' }, { logging: 'off' }));
  assert.equal(result.schema, 'urn:aihq:core:macos-session-verification-result:0.1.0');
  if (process.platform !== 'darwin') { assert.equal(result.status, 'incomplete'); assert.equal(result.configuration, 'not-applied'); }
});

console.log(JSON.stringify({ status: 'passed', checks }));
