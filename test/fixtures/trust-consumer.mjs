import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
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

// This executable proves installed-package discovery and binding only. Native
// client behavior is covered by the separate user-tool acceptance fixture.
const bin = join(process.cwd(), 'trust-bin'); mkdirSync(bin);
const pip = join(bin, process.platform === 'win32' ? 'pip.exe' : 'pip');
if (process.platform === 'win32') copyFileSync(process.execPath, pip);
else writeFileSync(pip, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.PATH = bin + delimiter + process.env.PATH;
process.env.APPDATA = join(process.env.USERPROFILE ?? process.env.HOME, 'AppData', 'Roaming');
// Bind pip's canonical configuration to this fixture home, not the CI runner.
process.env.XDG_CONFIG_HOME = join(process.env.HOME, '.config');
for (const name of ['PIP_CERT', 'PIP_CONFIG_FILE', 'PIP_TRUSTED_HOST', 'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']) delete process.env[name];
const userRequest = { schema: 'urn:aihq:core:repair-request:1.0.0', useCase: 'repair', route: 'file', sources: source,
  repairs: [{ id: 'user-tools-ca', targets: ['pip'], inputs: {} }], network: 'off' };
const userRepair = await prepare(userRequest, { logging: 'off' });
assert.equal(userRepair.status, 'ready', JSON.stringify(userRepair.diagnostics));
assert.equal(validatePreparedWork12(userRepair.review).valid, true);
assert.ok(userRepair.review.operations.some(operation => operation.id === 'trust/pip-config'));
assert.ok(userRepair.review.inputs.trust.sources.some(item => item.kind === 'supplied' && item.id === 'supplied:company'));
const userDocument = join(process.cwd(), 'user-trust-inputs.json');
writeFileSync(userDocument, JSON.stringify({ schema: 'urn:aihq:core:repair-inputs:1.0.0', route: 'file',
  repairs: { 'user-tools-ca': {} }, sources: { os: false, supplied: [{ id: 'company', file: 'ca.pem' }] } }));
const userCli = spawnSync(process.execPath, [cli, 'repair', 'user-tools-ca', '--target', 'pip',
  '--inputs-file', userDocument, '--offline', '--no-log', '--json'], {
  cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 60_000, windowsHide: true
});
assert.equal(userCli.status, 0, userCli.stdout + userCli.stderr);
const userPreview = JSON.parse(userCli.stdout);
assert.equal(userPreview.status, 'ready'); assert.equal(validatePreparedWork12(userPreview.review).valid, true);
for (const [id, targets] of [['user-tools-ca', ['python', 'pip', 'git', 'cargo', 'conda']], ['jvm-ca', ['gradle', 'maven']]]) {
  const unavailable = await prepare({ schema: userRequest.schema, useCase: 'repair', route: 'native',
    repairs: [{ id, targets, inputs: {} }], network: 'off' }, { logging: 'off' });
  assert.equal(unavailable.status, 'blocked'); assert.deepEqual(unavailable.resolutionInputs, []);
  assert.equal(validatePreparedWork12(unavailable.review).valid, true);
  assert.ok(unavailable.review.inputs.trust.targets.every(target => target.admission === 'unavailable'));
}

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
