// Packed-consumer check of trust repairs and the certificate export through the public 0.1.0 API and the `aih` CLI.
// Runs inside an isolated consumer with a temporary HOME and a supplied CA in ./ca.pem. Admission evidence is read
// through the installed artifact's own helper module (an internal path), the same check Prepare applies.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { prepare, apply, prepareRemoval } from '@aihq/core';
import { validateFormat } from '@aihq/core/contracts';
import { trustCapabilities as published } from '@aihq/core/harness';
import { parseTrustOutput } from '@aihq/core/harness/runtime';

const installed = dirname(dirname(dirname(fileURLToPath(import.meta.resolve('@aihq/core')))));
const cli = join(installed, 'dist/core/cli.js');
const { verifyTrustAdmissionEvidence } = await import(new URL('../harness/trust.mjs', import.meta.resolve('@aihq/core')).href);
const { trustCapabilities } = await import(new URL('../harness/contracts.mjs', import.meta.resolve('@aihq/core')).href);
assert.equal(verifyTrustAdmissionEvidence({ packageRoot: installed, capabilities: trustCapabilities }).valid, true);
assert.equal(published.schema, 'urn:aihq:core:trust-capabilities:0.1.0');
assert.deepEqual(published.cells, trustCapabilities.cells);
const ok = (value, schema) => assert.deepEqual(validateFormat(value), { status: 'ok', schema });
const REVIEW = 'urn:aihq:core:review:0.1.0', RUN = 'urn:aihq:core:run:0.1.0';
const source = { os: false, supplied: [{ id: 'company', file: join(process.cwd(), 'ca.pem') }] };

const native = await prepare({ schema: 'urn:aihq:core:repair-request:0.1.0', repair: 'node-npm-ca', targets: ['node', 'npm'], route: 'native', network: 'off' }, { logging: 'off' });
assert.ok(['blocked', 'refused'].includes(native.status), JSON.stringify(native));
assert.equal(native.handle, undefined);
const repair = await prepare({ schema: 'urn:aihq:core:repair-request:0.1.0', repair: 'node-npm-ca', targets: ['npm'], sources: source, network: 'off' }, { logging: 'off' });
assert.equal(repair.status, 'ready', JSON.stringify(repair));
ok(repair.review, REVIEW);
assert.ok(repair.review.steps.every(step => step.managementId === 'node-npm-ca'));

writeFileSync(join(process.cwd(), 'user-trust-inputs.json'), JSON.stringify({ schema: 'urn:aihq:core:repair-inputs:0.1.0', route: 'file',
  sources: { os: false, supplied: [{ id: 'company', file: 'ca.pem' }] } }));
const userCli = spawnSync(process.execPath, [cli, 'repair', 'user-tools-ca', '--target', 'pip', '--inputs-file', 'user-trust-inputs.json',
  '--offline', '--no-log', '--json'], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
const userPreview = JSON.parse(userCli.stdout);
// Ready where the selected tool is installed; blocked, naming the unavailable prerequisite, where it is not.
assert.ok(['ready', 'blocked'].includes(userPreview.status), userCli.stdout + userCli.stderr);
assert.equal(userCli.status, userPreview.status === 'ready' ? 0 : 1);
ok(userPreview.review, REVIEW);
assert.equal(userPreview.review.environment.repair, 'user-tools-ca');

writeFileSync(join(process.cwd(), 'export-inputs.json'), JSON.stringify({ schema: 'urn:aihq:core:export-inputs:0.1.0',
  sources: { os: false, supplied: [{ id: 'company', file: 'ca.pem' }] } }));
let written = 0;
for (const format of ['pem', 'pkcs7-der']) {
  const output = `packed/cli.${format === 'pem' ? 'pem' : 'p7b'}`;
  const preview = await prepare({ schema: 'urn:aihq:core:export-request:0.1.0', format, output, sources: source, network: 'off' }, { logging: 'off' });
  const result = spawnSync(process.execPath, [cli, 'export-ca', '--format', format, '--output', output, '--inputs-file', 'export-inputs.json',
    '--offline', '--apply', '--yes', '--no-log', '--json'], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  const value = JSON.parse(result.stdout);
  if (preview.status !== 'ready') {
    // An export cell this host has no admission for is shown as blocked, with no effects.
    assert.equal(preview.status, 'blocked', JSON.stringify(preview));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(value.status, 'blocked'); ok(value.review, REVIEW);
    continue;
  }
  assert.equal(result.status, 0, result.stdout + result.stderr);
  ok(value, RUN); assert.equal(value.completion, 'complete');
  const target = join(process.env.HOME, ...output.split('/'));
  assert.equal(parseTrustOutput(readFileSync(target), format).status, 'parsed');
  const managementId = preview.review.steps[0].managementId;
  const removal = await prepareRemoval({ target: { project: null }, scope: 'user', removals: [{ managementId }] }, { logging: 'off' });
  assert.equal(removal.status, 'ok', JSON.stringify(removal));
  const removed = await apply(removal.handle, { approved: true, origin: 'automation', reviewDigest: removal.review.reviewDigest }, { logging: 'off' });
  assert.equal(removed.completion, 'complete', JSON.stringify(removed)); assert.equal(existsSync(target), false);
  written++;
}
console.log(`packed trust public contracts passed (${written} exports written)`);
