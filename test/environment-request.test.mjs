// Environment work through the 0.1.0 review and run (contract 4, 7, 10): repair, certificate export and the macOS
// session. Every case runs against a disposable home; nothing reads or writes the real user's trust or configuration.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, apply } from '../dist/core/index.js';
import { validateFormat, refusalCodes, schemas } from '../dist/core/contracts.js';

const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let scratch;
function setup() {
  scratch = mkdtempSync(join(tmpdir(), 'aih-environment-'));
  const home = join(scratch, 'home'); mkdirSync(home);
  process.env.HOME = home; process.env.USERPROFILE = home;
  const file = join(scratch, 'team.pem');
  writeFileSync(file, readFileSync(new URL('./fixtures/root-a.pem', import.meta.url)));
  return { home, file };
}
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
});
const REPAIR = 'urn:aihq:core:repair-request:0.1.0';
// Git and npm keep their trust in user files; the Node target would also change the user environment, so it is not used.
const gitRepair = file => ({ schema: REPAIR, repair: 'user-tools-ca', targets: ['git'], route: 'file', network: 'off',
  sources: { os: false, supplied: [{ id: 'team', file }] } });
const approve = (preparation, extra = {}) => ({ approved: true, origin: 'automation', reviewDigest: preparation.review.reviewDigest, ...extra });

test('every environment format ships one schema with a valid and an invalid fixture', () => {
  for (const name of ['repair-request', 'repair-inputs', 'export-request', 'export-inputs', 'macos-session-request',
    'macos-session-inputs', 'trust-custody', 'macos-session-custody', 'macos-session-verification-request',
    'macos-session-verification-result', 'macos-session-profiles']) {
    const id = `urn:aihq:core:${name}:0.1.0`;
    assert.ok(schemas[id], id);
    assert.deepEqual(validateFormat(schemas[id].fixtures.valid), { status: 'ok', schema: id });
    assert.equal(validateFormat(schemas[id].fixtures.invalid).status, 'invalid', id);
  }
  for (const code of ['host-unsupported', 'resolution-unknown']) assert.ok(refusalCodes.some(entry => entry.code === code), code);
});

test('a supplied-file repair is reviewed, approved and run through the 0.1.0 review and run', async () => {
  const { home, file } = setup();
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Fixture\n');
  const request = gitRepair(file);
  const preparation = await prepare(request, { logging: 'off' });
  assert.equal(preparation.status, 'ready', JSON.stringify(preparation));
  assert.ok(preparation.handle);
  const { review } = preparation;
  assert.deepEqual(validateFormat(review), { status: 'ok', schema: 'urn:aihq:core:review:0.1.0' });
  assert.equal(review.request, 'repair');
  assert.equal(review.scope, 'user');
  assert.equal(review.environment.job, 'repair');
  assert.equal(review.environment.repair, 'user-tools-ca');
  assert.deepEqual(review.environment.targets, ['git']);
  assert.equal(review.environment.network, 'off');
  assert.deepEqual(review.environment.unavailable, []);
  // Supplied file trust stays distinct from native trust: the reviewed target is admitted for the supplied file route only.
  const target = review.environment.facts.trust.targets[0];
  assert.equal(target.route, 'file'); assert.equal(target.admission, 'admitted'); assert.equal(target.reason, null);
  assert.equal(target.verification.status, 'skipped');
  assert.ok(review.environment.facts.trust.sources.some(source => source.kind === 'supplied' && source.id === 'supplied:team'));
  assert.ok(review.steps.some(step => step.path === '.gitconfig' && step.effect === 'replace-file'), JSON.stringify(review.steps));
  assert.ok(review.steps.some(step => step.effect === 'run-process' && typeof step.cantPromise === 'string'));
  const run = await apply(preparation.handle, approve(preparation), { logging: 'off' });
  assert.deepEqual(validateFormat(run), { status: 'ok', schema: 'urn:aihq:core:run:0.1.0' });
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal(run.reviewDigest, review.reviewDigest);
  assert.ok(run.steps.length >= 2 && run.steps.every(step => step.application === 'applied'));
  assert.equal(run.environment.job, 'repair');
  assert.equal(run.environment.outputs[0].status, 'written');
  assert.equal(run.environment.targets[0].verification, 'skipped');
  const gitconfig = readFileSync(join(home, '.gitconfig'), 'utf8');
  assert.match(gitconfig, /name = Fixture/);
  assert.match(gitconfig, /sslCAInfo/);
  // Custody is the 0.1.0 environment ownership format.
  const custody = JSON.parse(readFileSync(join(home, '.aih', 'core', 'trust-custody.json'), 'utf8'));
  assert.deepEqual(validateFormat(custody), { status: 'ok', schema: 'urn:aihq:core:trust-custody:0.1.0' });
  // A consumed handle is a 0.1.0 rejection, never a throw.
  const again = await apply(preparation.handle, approve(preparation), { logging: 'off' });
  assert.equal(again.completion, 'rejected'); assert.equal(again.code, 'REVIEW_STALE'); assert.equal(again.reason, 'handle-unavailable');
});

test('a changed supplied source or a changed target rejects the reviewed repair before effects', async () => {
  const { home, file } = setup();
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Fixture\n');
  const sourceChange = await prepare(gitRepair(file), { logging: 'off' });
  assert.equal(sourceChange.status, 'ready', JSON.stringify(sourceChange));
  appendFileSync(file, '\n');
  const rejected = await apply(sourceChange.handle, approve(sourceChange), { logging: 'off' });
  assert.equal(rejected.completion, 'rejected', JSON.stringify(rejected));
  assert.equal(rejected.code, 'REVIEW_STALE');
  assert.doesNotMatch(readFileSync(join(home, '.gitconfig'), 'utf8'), /sslCAInfo/);

  writeFileSync(file, readFileSync(new URL('./fixtures/root-a.pem', import.meta.url)));
  const targetChange = await prepare(gitRepair(file), { logging: 'off' });
  assert.equal(targetChange.status, 'ready', JSON.stringify(targetChange));
  appendFileSync(join(home, '.gitconfig'), '[core]\n\teditor = vi\n');
  const stale = await apply(targetChange.handle, approve(targetChange), { logging: 'off' });
  assert.equal(stale.completion, 'rejected', JSON.stringify(stale));
  assert.equal(stale.code, 'REVIEW_STALE');
  assert.doesNotMatch(readFileSync(join(home, '.gitconfig'), 'utf8'), /sslCAInfo/);

  // The request object itself is bound: changing it after Prepare is a stale binding.
  const request = gitRepair(file);
  const bound = await prepare(request, { logging: 'off' });
  assert.equal(bound.status, 'ready', JSON.stringify(bound));
  request.network = 'declared';
  const changed = await apply(bound.handle, approve(bound), { logging: 'off' });
  assert.equal(changed.completion, 'rejected'); assert.equal(changed.changed, 'binding');
});

test('an edited managed output is a conflict whose reviewed replacement is a second Prepare', async () => {
  const { file } = setup();
  const first = await prepare(gitRepair(file), { logging: 'off' });
  const run = await apply(first.handle, approve(first), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  const output = run.environment.outputs[0].path;
  // Bytes Core cannot read back as certificates are kept: a conflict with no replacement on offer.
  const managed = readFileSync(output);
  appendFileSync(output, '\n# edited by hand\n');
  const kept = await prepare(gitRepair(file), { logging: 'off' });
  assert.equal(kept.status, 'blocked', JSON.stringify(kept));
  assert.equal(kept.review.conflicts[0].reason, 'managed-content-changed');
  assert.deepEqual(kept.review.conflicts[0].choices, []);
  // A readable edit (here: only the supplied certificate, without the bundled roots) is offered for reviewed replacement.
  writeFileSync(output, readFileSync(file));
  const blocked = await prepare(gitRepair(file), { logging: 'off' });
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
  assert.equal(blocked.handle, undefined);
  assert.deepEqual(validateFormat(blocked.review), { status: 'ok', schema: 'urn:aihq:core:review:0.1.0' });
  const [conflict] = blocked.review.conflicts;
  assert.equal(conflict.code, 'STATE_CONFLICT');
  assert.equal(conflict.reason, 'existing-content');
  assert.deepEqual(conflict.choices, ['replace']);
  assert.match(conflict.observedSha256, /^[a-f0-9]{64}$/);
  // A resolution naming no reviewed conflict is refused, not guessed.
  const unknown = await prepare({ ...gitRepair(file), resolutions: [{ managementId: 'other', step: conflict.step, choice: 'replace',
    observedSha256: conflict.observedSha256 }] }, { logging: 'off' });
  assert.equal(unknown.status, 'refused'); assert.equal(unknown.code, 'resolution-unknown');
  const resolved = await prepare({ ...gitRepair(file), resolutions: [{ managementId: conflict.managementId, step: conflict.step,
    choice: 'replace', observedSha256: conflict.observedSha256 }] }, { logging: 'off' });
  assert.equal(resolved.status, 'ready', JSON.stringify(resolved));
  const replaced = await apply(resolved.handle, approve(resolved), { logging: 'off' });
  assert.equal(replaced.completion, 'complete', JSON.stringify(replaced));
  assert.deepEqual(readFileSync(output), managed);
});

test('unsupported hosts, routes and versions stay explicit', async () => {
  const { home, file } = setup();
  // Native routes need an admitted client binding; none is admitted, so the review says so and offers no handle.
  const native = await prepare({ schema: REPAIR, repair: 'node-npm-ca', targets: ['npm'], route: 'native' }, { logging: 'off' });
  assert.equal(native.status, 'blocked', JSON.stringify(native));
  assert.equal(native.handle, undefined);
  assert.deepEqual(validateFormat(native.review), { status: 'ok', schema: 'urn:aihq:core:review:0.1.0' });
  assert.ok(native.review.environment.unavailable.some(problem => problem.reason === 'native-route-unsupported'));
  assert.ok(native.review.environment.facts.trust.targets.every(target => target.admission === 'unavailable'));
  // A certificate export runs only on an admitted export cell; elsewhere it is explicit and has no effects.
  const exported = await prepare({ schema: 'urn:aihq:core:export-request:0.1.0', format: 'pem', network: 'off',
    sources: { os: false, supplied: [{ id: 'team', file }] } }, { logging: 'off' });
  assert.ok(['ready', 'blocked'].includes(exported.status), JSON.stringify(exported));
  assert.deepEqual(validateFormat(exported.review), { status: 'ok', schema: 'urn:aihq:core:review:0.1.0' });
  assert.equal(exported.review.request, 'export');
  if (exported.status === 'blocked')
    assert.ok(exported.review.environment.unavailable.some(problem => ['trust-platform-unsupported', 'trust-format-unavailable'].includes(problem.reason)));
  // The macOS session is admitted only on macOS with an admitted profile.
  const session = await prepare({ schema: 'urn:aihq:core:macos-session-request:0.1.0', repair: 'node-npm-ca', targets: ['npm'],
    route: 'file', network: 'off', sources: { os: false, supplied: [{ id: 'team', file }] }, session: { context: 'terminal', applications: [] } },
  { logging: 'off' });
  if (process.platform !== 'darwin') {
    assert.equal(session.status, 'blocked', JSON.stringify(session));
    assert.equal(session.review.request, 'macos-session');
    assert.ok(session.review.environment.unavailable.length > 0);
  }
  assert.equal(existsSync(join(home, '.gitconfig')), false);
  const future = await prepare({ schema: 'urn:aihq:core:export-request:9.0.0' }, { logging: 'off' });
  assert.equal(future.status, 'unsupported-version');
  assert.deepEqual(future.supported, ['urn:aihq:core:export-request:0.1.0']);
  const invalid = await prepare({ schema: REPAIR, repair: 'node-npm-ca', targets: ['gradle'] }, { logging: 'off' });
  assert.equal(invalid.status, 'invalid');
  const caFile = await prepare({ schema: REPAIR, repair: 'node-npm-ca', targets: ['npm'], inputs: { caFile: file } }, { logging: 'off' });
  assert.equal(caFile.status, 'invalid');
});

test('standalone repair takes no organization controls', async () => {
  const { file } = setup();
  const result = await prepare(gitRepair(file), { logging: 'off', organization: { kind: 'local', file } });
  assert.equal(result.status, 'invalid');
});

test('the macOS session check answers the 0.1.0 request with the 0.1.0 result and names an unsupported host', async () => {
  setup();
  const { verifyMacosSession } = await import('../dist/core/index.js');
  const { macosSessionProfiles } = await import('../dist/harness/contracts.mjs');
  const result = await verifyMacosSession({ schema: 'urn:aihq:core:macos-session-verification-request:0.1.0', managementId: 'node-npm-trust' },
    { logging: 'off' });
  assert.deepEqual(validateFormat(result), { status: 'ok', schema: 'urn:aihq:core:macos-session-verification-result:0.1.0' });
  if (process.platform !== 'darwin') {
    assert.equal(result.status, 'incomplete');
    assert.equal(result.configuration, 'not-applied');
    assert.equal(result.diagnostics[0].code, 'PREREQUISITE_UNAVAILABLE');
  }
  const invalid = await verifyMacosSession({ schema: 'urn:aihq:core:macos-session-verification-request:0.1.0', managementId: 'x', extra: 1 });
  assert.equal(invalid.status, 'invalid'); assert.equal(invalid.schema, 'urn:aihq:core:macos-session-verification-result:0.1.0');
  // The bundled profiles (none admitted) read as the 0.1.0 profiles format.
  assert.equal(validateFormat({ ...macosSessionProfiles, schema: 'urn:aihq:core:macos-session-profiles:0.1.0' }).status, 'ok');
  assert.deepEqual(macosSessionProfiles.profiles, []);
});
