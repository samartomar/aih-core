import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { prepare, apply, prepareManagedRemoval } from '@aihq/core';
import { validatePreparedWork12, validateRunResult12 } from '@aihq/core/contracts';
import { trustCapabilities, selectTrustCell } from '@aihq/core/harness';
import { detectTrustPlatform, parseTrustOutput, verifyTrustAdmissionEvidence } from '@aihq/core/harness/runtime';

const installed = dirname(dirname(dirname(fileURLToPath(import.meta.resolve('@aihq/core')))));
const cli = join(installed, 'dist/core/cli.js');
assert.equal(verifyTrustAdmissionEvidence({ packageRoot: installed, capabilities: trustCapabilities }).valid, true);
const file = join(process.cwd(), 'ca.pem');
const source = { os: false, supplied: [{ id: 'company', file }] };
const native = await prepare({ schema: 'urn:aihq:core:repair-request:1.0.0', useCase: 'repair', route: 'native',
  repairs: [{ id: 'node-npm-ca', targets: ['node', 'npm'], inputs: {} }], network: 'off' }, { logging: 'off' });
assert.equal(native.status, 'blocked'); assert.deepEqual(native.resolutionInputs, []);
assert.equal(validatePreparedWork12(native.review).valid, true);
assert.ok(native.review.inputs.trust.targets.every(target => target.admission === 'unavailable'));

const repair = await prepare({ schema: 'urn:aihq:core:repair-request:1.0.0', useCase: 'repair', route: 'file', sources: source,
  repairs: [{ id: 'node-npm-ca', targets: ['npm'], inputs: {} }], network: 'off' }, { logging: 'off' });
assert.equal(repair.status, 'ready', JSON.stringify(repair.diagnostics));
assert.equal(validatePreparedWork12(repair.review).valid, true);
assert.equal(repair.review.inputs.trust.targets[0].verification.status, 'skipped');

const document = join(process.cwd(), 'trust-inputs.json');
writeFileSync(document, JSON.stringify({ schema: 'urn:aihq:core:certificate-export-inputs:1.0.0',
  sources: { os: false, supplied: [{ id: 'company', file: 'ca.pem' }] } }));
let written = 0;
for (const format of ['pem', 'pkcs7-der']) {
  const request = { schema: 'urn:aihq:core:certificate-export-request:1.0.0', useCase: 'certificate-export', format,
    output: `packed/cli.${format === 'pem' ? 'pem' : 'p7b'}`, sources: source, network: 'off' };
  const platform = detectTrustPlatform();
  const cell = selectTrustCell({ definitionId: 'certificate-export', route: 'export', target: null, platform, network: 'off', format }, trustCapabilities);
  const result = spawnSync(process.execPath, [cli, 'export-ca', '--format', format, '--output', request.output,
    '--inputs-file', document, '--offline', '--apply', '--yes', '--no-log', '--json'], {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 60_000, windowsHide: true
  });
  const value = JSON.parse(result.stdout);
  if (cell.status === 'unavailable') {
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(value.status, 'blocked'); assert.equal(validatePreparedWork12(value.review).valid, true);
    assert.deepEqual(value.resolutionInputs, []);
    continue;
  }
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(value.completion, 'complete'); assert.equal(validateRunResult12(value).valid, true);
  assert.equal(value.trust.outputs.length, 1);
  assert.equal(parseTrustOutput(readFileSync(value.trust.outputs[0].path), format).status, 'parsed');
  const retained = await prepare({ ...request, sources: { os: false, supplied: [] } }, { logging: 'off' });
  assert.equal(retained.status, 'ready', JSON.stringify(retained.diagnostics));
  assert.equal(validatePreparedWork12(retained.review).valid, true);
  const rerun = await apply(retained.prepared, { approved: true, origin: 'automation', reviewDigest: retained.review.reviewDigest }, { logging: 'off' });
  assert.equal(rerun.completion, 'complete'); assert.equal(rerun.trust.outputs[0].status, 'unchanged');
  const removal = await prepareManagedRemoval({ target: { project: process.env.TEST_PROJECT },
    managementId: retained.review.inputs.trust.outputs[0].managementId, scope: 'user', mode: 'vibe' }, { logging: 'off' });
  assert.equal(removal.disposition, 'prepared', JSON.stringify(removal));
  const removed = await apply(removal.preparation.prepared, { approved: true, origin: 'automation', reviewDigest: removal.preparation.review.reviewDigest }, { logging: 'off' });
  assert.equal(removed.completion, 'complete'); assert.equal(existsSync(value.trust.outputs[0].path), false);
  written++;
}
console.log(`packed trust public contracts passed; export formats written=${written}`);
