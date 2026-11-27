// Packed-consumer check of trust repairs and the certificate export through the public 0.1.0 API and the `aih` CLI.
// Runs inside an isolated consumer with a temporary HOME and a supplied CA in ./ca.pem. Admission evidence is read
// through the installed artifact's own helper module (an internal path), the same check Prepare applies.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { prepare, apply, prepareRemoval } from '@aihq/core';
import { validateFormat } from '@aihq/core/contracts';
import { trustCapabilities as published } from '@aihq/core/harness';
import { parseTrustOutput } from '@aihq/core/harness/runtime';
import { disposableInstall } from './synthetic-export-admission.mjs';

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
// Whether a published export cell admits this exact host decides the route; a blocked Prepare alone never does.
const harness = name => new URL(`../harness/${name}`, import.meta.resolve('@aihq/core')).href;
const { trustPlatformMatrix } = await import(harness('trust-definitions.mjs'));
const { detectCertificateExportPlatform } = await import(harness('trust-export-platform.mjs'));
const { selectTrustCell } = await import(harness('contracts.mjs'));
const host = detectCertificateExportPlatform();
const row = trustPlatformMatrix.find(item => item.os === host.os && item.release === host.release &&
  item.architecture === host.architecture && item.projection === host.projection);
const publishedAdmits = format => !!host.release && selectTrustCell({ definitionId: 'certificate-export', route: 'export', target: null,
  platform: { os: host.os, release: host.release, architecture: host.architecture }, network: 'off', format }, published).status === 'admitted';
const publishedFormats = ['pem', 'pkcs7-der'].filter(publishedAdmits);
assert.ok(publishedFormats.length === 0 || publishedFormats.length === 2, `published export admission covers both formats or neither: ${publishedFormats}`);
let written = 0;
for (const format of ['pem', 'pkcs7-der']) {
  const output = `packed/cli.${format === 'pem' ? 'pem' : 'p7b'}`;
  const preview = await prepare({ schema: 'urn:aihq:core:export-request:0.1.0', format, output, sources: source, network: 'off' }, { logging: 'off' });
  const result = spawnSync(process.execPath, [cli, 'export-ca', '--format', format, '--output', output, '--inputs-file', 'export-inputs.json',
    '--offline', '--apply', '--yes', '--no-log', '--json'], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  const value = JSON.parse(result.stdout);
  if (!publishedAdmits(format)) {
    // An export cell this host has no published admission for is shown as blocked, with no effects.
    assert.equal(preview.status, 'blocked', JSON.stringify(preview));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(value.status, 'blocked'); ok(value.review, REVIEW);
    continue;
  }
  assert.equal(preview.status, 'ready', JSON.stringify(preview));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  ok(value.review, REVIEW); ok(value.run, RUN);
  assert.equal(value.run.completion, 'complete');
  const target = join(process.env.HOME, ...output.split('/'));
  assert.equal(parseTrustOutput(readFileSync(target), format).status, 'parsed');
  const managementId = preview.review.steps[0].managementId;
  const removal = await prepareRemoval({ target: { project: null }, scope: 'user', removals: [{ managementId }] }, { logging: 'off' });
  assert.equal(removal.status, 'ok', JSON.stringify(removal));
  const removed = await apply(removal.handle, { approved: true, origin: 'automation', reviewDigest: removal.review.reviewDigest }, { logging: 'off' });
  assert.equal(removed.completion, 'complete', JSON.stringify(removed)); assert.equal(existsSync(target), false);
  written++;
}
// Without a published export cell for this host, the same public export and removal run against a disposable copy of
// this installed artifact, with unpublished synthetic admission for the host's exact platform (never product evidence).
let synthetic = 0;
if (!publishedFormats.length) {
  if (row) {
    // The copy shares the artifact's bundled modules explicitly; its unbundled dependencies resolve from this
    // consumer's node_modules, which is why the copy must stay inside the consumer directory.
    const copyRoot = mkdtempSync(join(process.cwd(), 'synthetic-export-'));
    const inside = relative(process.cwd(), copyRoot); assert.ok(inside && !inside.startsWith('..') && !isAbsolute(inside));
    const copy = disposableInstall(installed, copyRoot, join(installed, 'node_modules'));
    const helper = new URL('./synthetic-export-admission.mjs', import.meta.url).href;
    const admit = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const { admitSyntheticExport } = await import(${JSON.stringify(helper)}); await admitSyntheticExport(${JSON.stringify(copy)}, ${JSON.stringify(row)});`],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    assert.equal(admit.status, 0, admit.stderr);
    const entry = name => JSON.stringify(pathToFileURL(join(copy, 'dist/core', name)).href);
    const script = join(process.cwd(), 'synthetic-export.mjs');
    writeFileSync(script, `
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { prepare, apply, prepareRemoval } from ${entry('index.js')};
import { validateFormat } from ${entry('contracts.js')};
const controls = { logging: 'off' };
const authorize = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
let done = 0;
for (const format of ['pem', 'pkcs7-der']) {
  const p = await prepare({ schema: 'urn:aihq:core:export-request:0.1.0', format, output: 'synthetic/api.' + (format === 'pem' ? 'pem' : 'p7b'),
    network: 'off', sources: ${JSON.stringify(source)} }, controls);
  assert.equal(p.status, 'ready', JSON.stringify(p));
  const written = await apply(p.handle, authorize(p.review), controls);
  assert.deepEqual(validateFormat(written), { status: 'ok', schema: 'urn:aihq:core:run:0.1.0' }); assert.equal(written.completion, 'complete');
  const path = written.environment.outputs[0].path; assert.equal(existsSync(path), true);
  const managementId = p.review.steps[0].managementId;
  const removal = await prepareRemoval({ target: { project: null }, scope: 'user', removals: [{ managementId }] }, controls);
  assert.equal(removal.status, 'ok', JSON.stringify(removal)); assert.ok(removal.handle, JSON.stringify(removal));
  const removed = await apply(removal.handle, authorize(removal.review), controls);
  assert.equal(removed.completion, 'complete', JSON.stringify(removed)); assert.equal(existsSync(path), false);
  done++;
}
console.log(done);
`);
    const syntheticHome = mkdtempSync(join(process.cwd(), 'synthetic-home-'));
    const ran = spawnSync(process.execPath, [script], { cwd: process.cwd(), env: { ...process.env, HOME: syntheticHome, USERPROFILE: syntheticHome },
      encoding: 'utf8', timeout: 120_000, windowsHide: true });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    synthetic = Number(ran.stdout.trim()); assert.equal(synthetic, 2);
  }
}
// An exact trust platform must actually remove both exports, published or synthetic; any other host says why it skipped.
const removalLine = row ? `export removal ran=${written + synthetic}` :
  `export removal skipped: ${host.os}/${host.architecture} ${host.release ?? 'unclassified release'} is not an exact trust platform`;
if (row) assert.equal(written + synthetic, 2, removalLine);
console.log(`packed trust public contracts passed (${written} exports written, ${synthetic} through synthetic admission); ${removalLine}`);
