// Change requests (urn:aihq:core:change-request:0.1.0) through the built public entries, in a disposable home and project.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { apply, list, prepare, prepareRemoval } from '../dist/core/engine-api.js';
import { deriveChangeIdentity, refusalCodes, schemas, validateChange, validateFormat } from '../dist/core/contracts.js';
import { approvalChange, changeRequest, codexApproval, commandChange, projectSetting, teamFile, teamFolder } from './fixtures/change-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-change-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let home;
before(() => { home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true }); });

const approve = (review, extra = {}) => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest, ...extra });
const conforms = value => { const read = validateFormat(value); assert.equal(read.status, 'ok', JSON.stringify(read)); return value; };
let counter = 0;
function project() {
  const path = join(scratch, `project-${counter++}`);
  mkdirSync(path); writeFileSync(join(path, 'README.md'), 'mine\n');
  return path;
}
async function applied(request, controls) {
  const prepared = await prepare(request, controls);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  conforms(prepared.review);
  const run = conforms(await apply(prepared.handle, approve(prepared.review), controls));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  return { prepared, run };
}
async function removed(target, scope, managementIds) {
  const removal = await prepareRemoval({ target, scope, removals: managementIds.map(managementId => ({ managementId })) });
  assert.equal(removal.status, 'ok', JSON.stringify(removal));
  if (!removal.handle) return { removal };
  conforms(removal.review);
  const run = conforms(await apply(removal.handle, approve(removal.review)));
  return { removal, run };
}

test('the change formats publish one schema each with a valid and an invalid fixture, and read through validateChange', () => {
  for (const id of ['urn:aihq:core:change:0.1.0', 'urn:aihq:core:change-request:0.1.0']) {
    assert.ok(schemas[id], id);
    assert.equal(validateFormat(schemas[id].fixtures.valid).status, 'ok', id);
    assert.equal(validateFormat(schemas[id].fixtures.invalid).status, 'invalid', id);
  }
  assert.deepEqual(validateChange(codexApproval()), { status: 'ok', schema: 'urn:aihq:core:change:0.1.0' });
  const unknown = validateChange({ ...codexApproval(), operations: [{ ...codexApproval().operations[0], kind: 'file.chmod' }] });
  assert.equal(unknown.status, 'invalid');
  const older = validateChange({ ...codexApproval(), schema: 'urn:aihq:core:change:0.0.9' });
  assert.deepEqual([older.status, older.supported], ['unsupported-version', ['urn:aihq:core:change:0.1.0']]);
  // An old recipe is not a change: one version per format (C15).
  assert.equal(validateChange({ ...codexApproval(), schema: 'urn:aihq:core:recipe:1.4.0' }).status, 'unsupported-version');
  // The semantic rules of the bounded editors carry over: a TOML entry path may not overlap another.
  const overlap = codexApproval();
  overlap.operations[0].set.push({ path: ['approval_policy', 'nested'], value: 'x' });
  assert.equal(validateChange(overlap).status, 'invalid');
});

test('deriveChangeIdentity hashes the canonical change and its material closure', async () => {
  const one = await deriveChangeIdentity({ change: codexApproval() });
  assert.equal(one.status, 'ok', JSON.stringify(one));
  assert.match(one.changeIdentity, /^sha256:[a-f0-9]{64}$/);
  const reverse = value => Array.isArray(value) ? value.map(reverse) : value && typeof value === 'object' ?
    Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverse(item)])) : value;
  const reordered = reverse(codexApproval());
  assert.equal((await deriveChangeIdentity({ change: reordered })).changeIdentity, one.changeIdentity);
  const other = codexApproval(); other.operations[0].set[0].value = 'never';
  assert.notEqual((await deriveChangeIdentity({ change: other })).changeIdentity, one.changeIdentity);
  assert.equal((await deriveChangeIdentity({ change: { schema: 'urn:aihq:core:recipe:1.4.0' } })).status, 'unsupported-version');
});

test('a settings edit lands in ~/.codex/config.toml and removal restores the original bytes, including a table Core created', async () => {
  const codex = join(home, '.codex'); mkdirSync(codex, { recursive: true });
  const original = '# mine\nmodel = "o3"\n';
  writeFileSync(join(codex, 'config.toml'), original);
  const { prepared, run } = await applied(changeRequest([{ managementId: 'codex-approval-on-request', change: codexApproval() }], { scope: 'user' }));
  assert.equal(prepared.review.request, 'change');
  const [step] = prepared.review.steps;
  assert.deepEqual([step.managementId, step.step, step.op, step.effect], ['codex-approval-on-request', 'set', 'config.entries', 'replace-file']);
  assert.match(step.sentence, /\.codex\/config\.toml/);
  assert.deepEqual(run.steps.map(item => [item.step, item.application]), [['set', 'applied']]);
  assert.equal(readFileSync(join(codex, 'config.toml'), 'utf8'),
    '# mine\nmodel = "o3"\napproval_policy = "on-request"\n[sandbox_workspace_write]\nnetwork_access = false\n');
  const inventory = conforms(await list({ target: {}, scope: 'user' }));
  const row = inventory.entries.find(entry => entry.managementId === 'codex-approval-on-request');
  assert.deepEqual([row.installState, row.members.map(member => member.state)], ['complete', ['matching', 'matching']]);
  const { run: removal } = await removed({}, 'user', ['codex-approval-on-request']);
  assert.equal(removal.completion, 'complete', JSON.stringify(removal));
  assert.equal(readFileSync(join(codex, 'config.toml'), 'utf8'), original);
});

test('a named group reconciles: an omitted member is proposed for removal after review, and an empty group removes all its members', async () => {
  const target = project();
  writeFileSync(join(target, 'NOTES.md'), 'unrelated\n');
  const changes = [{ managementId: 'team-guide', change: teamFile('team-guide', 'TEAM.md'), inputs: { text: 'Read CONTRIBUTING.md\n' } },
    { managementId: 'team-style', change: teamFile('team-style', 'STYLE.md'), inputs: { text: 'Two spaces.\n' } },
    { managementId: 'team-lint', change: projectSetting('team-lint', 'lint', true) }];
  const first = await applied(changeRequest(changes, { project: target, groups: [{ id: 'team', members: ['team-guide', 'team-style', 'team-lint'] }] }));
  assert.deepEqual(first.prepared.review.groups, [{ id: 'team', members: ['team-guide', 'team-style', 'team-lint'] }]);
  // Somebody else's key in the shared settings file stays.
  const settings = join(target, '.team', 'settings.json');
  writeFileSync(settings, readFileSync(settings, 'utf8').replace('{', '{\n  "mine": 1,'));
  const second = await prepare(changeRequest([changes[0], changes[2]], { project: target, groups: [{ id: 'team', members: ['team-guide', 'team-lint'] }] }));
  assert.equal(second.status, 'ready', JSON.stringify(second));
  const removal = second.review.steps.filter(step => step.effect === 'remove-file');
  assert.deepEqual(removal.map(step => [step.managementId, step.path]), [['team-style', 'STYLE.md']]);
  assert.match(removal[0].sentence, /no longer stated/);
  conforms(await apply(second.handle, approve(second.review)));
  assert.equal(existsSync(join(target, 'STYLE.md')), false);
  assert.equal(readFileSync(join(target, 'TEAM.md'), 'utf8'), 'Read CONTRIBUTING.md\n');
  const empty = await prepare(changeRequest([], { project: target, groups: [{ id: 'team', members: [] }] }));
  assert.equal(empty.status, 'ready', JSON.stringify(empty));
  assert.deepEqual([...new Set(empty.review.steps.map(step => step.managementId))].sort(), ['team-guide', 'team-lint']);
  assert.equal(conforms(await apply(empty.handle, approve(empty.review))).completion, 'complete');
  assert.equal(existsSync(join(target, 'TEAM.md')), false);
  assert.equal(JSON.parse(readFileSync(settings, 'utf8')).mine, 1);
  assert.equal(JSON.parse(readFileSync(settings, 'utf8')).lint, undefined);
  assert.equal(readFileSync(join(target, 'NOTES.md'), 'utf8'), 'unrelated\n');
  assert.deepEqual((await list({ target: { project: target }, scope: 'project' })).entries, []);
});

test('a required change is retained while its dependant stays installed', async () => {
  const target = project();
  await applied(changeRequest([{ managementId: 'base-setting', change: projectSetting('base-setting', 'base', 'on') },
    { managementId: 'guide', change: teamFile('guide', 'GUIDE.md'), inputs: { text: 'Uses base.\n' }, requires: ['base-setting'] }], { project: target }));
  const held = await prepareRemoval({ target: { project: target }, scope: 'project', removals: [{ managementId: 'base-setting' }] });
  assert.deepEqual(held.entries.map(entry => [entry.managementId, entry.disposition]), [['base-setting', 'retained']]);
  assert.equal(held.handle, undefined);
  const both = await removed({ project: target }, 'project', ['guide', 'base-setting']);
  assert.equal(both.run.completion, 'complete', JSON.stringify(both.run));
  assert.equal(existsSync(join(target, 'GUIDE.md')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(target, '.team', 'settings.json'), 'utf8')), {});
});

test('an exact approved command shows its executable, argv, folder, environment and exit codes, and a failure is reported as uncertain', async () => {
  const target = project();
  const script = 'require("fs").writeFileSync("command-output.txt", process.env.AIH_EXAMPLE)';
  const prepared = await prepare(changeRequest([{ managementId: 'touch', change: commandChange('touch', ['-e', script]) }], { project: target }));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const [step] = conforms(prepared.review).steps;
  assert.deepEqual([step.op, step.effect, step.step], ['process.run', 'opaque-process', 'run']);
  assert.match(step.cantPromise, /can't show or undo/);
  assert.equal(step.details.executable, process.execPath);
  assert.deepEqual(step.details.args, [JSON.stringify('-e'), JSON.stringify(script)]);
  assert.equal(step.details.cwd, target);
  assert.deepEqual(step.details.env, { AIH_EXAMPLE: JSON.stringify('set') });
  assert.deepEqual(step.details.acceptedExitCodes, [0]);
  assert.match(step.details.executableSha256, /^[a-f0-9]{64}$/);
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.deepEqual([run.completion, run.steps[0].application], ['complete', 'applied']);
  assert.equal(readFileSync(join(target, 'command-output.txt'), 'utf8'), 'set');
  const failing = await prepare(changeRequest([{ managementId: 'fail', change: commandChange('fail', ['-e', 'process.exit(3)']) }], { project: target }));
  const failed = conforms(await apply(failing.handle, approve(failing.review)));
  assert.deepEqual([failed.completion, failed.steps[0].application, failed.steps[0].effectsUncertain], ['incomplete', 'failed', true]);
});

test('your existing file is a conflict; a replace chosen in a second Prepare keeps your original, and removal writes it back', async () => {
  const target = project();
  writeFileSync(join(target, 'TEAM.md'), 'my own team notes\n');
  const request = changeRequest([{ managementId: 'team-guide', change: teamFile('team-guide', 'TEAM.md'), inputs: { text: 'Shared.\n' } }], { project: target });
  const blocked = await prepare(request);
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
  assert.equal(blocked.handle, undefined);
  const [conflict] = conforms(blocked.review).conflicts;
  assert.deepEqual([conflict.reason, conflict.managementId, conflict.step, conflict.target], ['existing-content', 'team-guide', 'write', 'TEAM.md']);
  assert.ok(conflict.choices.includes('replace'));
  // The conflict carries the exact bytes you have there, bound by its observed digest (contract 7).
  assert.deepEqual([conflict.existing, conflict.redacted], ['my own team notes\n', []]);
  assert.equal(conflict.observedSha256, createHash('sha256').update('my own team notes\n').digest('hex'));
  const replace = { ...request, resolutions: [{ managementId: 'team-guide', step: 'write', choice: 'replace', observedSha256: conflict.observedSha256 }] };
  await applied(replace);
  assert.equal(readFileSync(join(target, 'TEAM.md'), 'utf8'), 'Shared.\n');
  const { run } = await removed({ project: target }, 'project', ['team-guide']);
  assert.equal(run.completion, 'complete');
  assert.equal(readFileSync(join(target, 'TEAM.md'), 'utf8'), 'my own team notes\n');
});

test('a change conflict shows your existing settings with the secret slots it would fill redacted', async () => {
  const target = project();
  mkdirSync(join(target, '.team'));
  const mine = '{\n  "token": "my-own-token",\n  "other": "kept"\n}\n';
  writeFileSync(join(target, '.team', 'settings.json'), mine);
  const change = projectSetting('tokened', 'token', 'x');
  change.inputs = { token: { type: 'string', required: true, sensitive: true } };
  change.operations[0].set = [{ path: ['token'], input: 'token' }];
  const blocked = await prepare(changeRequest([{ managementId: 'tokened', change }], { project: target }),
    { privateInputs: { tokened: { token: 'hunter2-value' } } });
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
  const [conflict] = conforms(blocked.review).conflicts;
  assert.deepEqual(conflict.redacted, ['/token']);
  assert.equal(conflict.existing, '{\n  "token": "[REDACTED]",\n  "other": "kept"\n}\n');
  assert.equal(conflict.observedSha256, createHash('sha256').update(mine).digest('hex'));
  assert.equal(JSON.stringify(blocked.review).includes('my-own-token'), false);
});

test('one-server approval and its server land together, and the request a review was made from cannot change before Apply', async () => {
  const target = project();
  const { prepared } = await applied(changeRequest([{ managementId: 'docs-server', change: approvalChange() }], { project: target }));
  assert.deepEqual(prepared.review.steps.map(step => step.op), ['config.entries', 'config.member']);
  assert.deepEqual(JSON.parse(readFileSync(join(target, '.claude', 'settings.local.json'), 'utf8')).enabledMcpjsonServers, ['docs']);
  const request = changeRequest([{ managementId: 'later', change: teamFile('later', 'LATER.md'), inputs: { text: 'one\n' } }], { project: target });
  const later = await prepare(request);
  request.changes[0].inputs.text = 'two\n';
  const run = conforms(await apply(later.handle, approve(later.review)));
  assert.deepEqual([run.completion, run.code, run.changed], ['rejected', 'REVIEW_STALE', 'binding']);
  assert.equal(existsSync(join(target, 'LATER.md')), false);
});

test('a change request is refused or invalid before any effect', async () => {
  const target = project();
  const older = await prepare({ ...changeRequest([], { project: target }), schema: 'urn:aihq:core:change-request:0.0.1' });
  assert.equal(older.status, 'unsupported-version');
  const enterprise = await prepare({ ...changeRequest([{ managementId: 'x', change: projectSetting('x', 'k', 1) }], { project: target }), mode: 'enterprise' });
  assert.deepEqual([enterprise.status, enterprise.code], ['refused', 'organization-required']);
  assert.ok(refusalCodes.some(code => code.code === 'organization-required'));
  const wrong = changeRequest([{ managementId: 'x', change: { ...projectSetting('x', 'k', 1), schema: 'urn:aihq:core:recipe:1.4.0' } }], { project: target });
  const read = await prepare(wrong);
  assert.equal(read.status, 'invalid');
  assert.equal(read.problems[0].path, '/changes/0/change/schema');
  const missing = await prepare(changeRequest([{ managementId: 'x', change: projectSetting('x', 'k', 1), requires: ['nobody'] }], { project: target }));
  assert.equal(missing.status, 'invalid');
  const unstated = await prepare(changeRequest([], { project: target, groups: [{ id: 'g', members: ['nobody'] }] }));
  assert.equal(unstated.status, 'invalid');
  assert.deepEqual(readFileSync(join(target, 'README.md'), 'utf8'), 'mine\n');
  assert.equal(existsSync(join(target, '.team')), false);
});

test('a change acquired by reference from a material root edits a text block, an INI option and an owned hook group, with a secret kept out of the review', async () => {
  const target = project();
  writeFileSync(join(target, 'AGENTS.md'), '# Mine\n');
  const folder = join(scratch, `material-${counter++}`); mkdirSync(folder);
  const { reference, bytes } = teamFolder(folder, { createHash, writeFileSync, join });
  const identity = await deriveChangeIdentity({ changeBytes: bytes, reference });
  assert.equal(identity.status, 'ok', JSON.stringify(identity));
  const secret = 'https://user:hunter2@index.example/simple';
  const controls = { materialRoots: { team: folder }, privateInputs: { 'team-folder': { index: secret } } };
  const { prepared, run } = await applied(changeRequest([{ managementId: 'team-folder', reference }], { project: target }), controls);
  assert.deepEqual(prepared.review.steps.map(step => step.op).sort(), ['config.entries', 'file.write', 'hook.group', 'text.block']);
  assert.equal(JSON.stringify(prepared.review).includes('hunter2'), false, 'a secret never appears in the review');
  assert.equal(JSON.stringify(run).includes('hunter2'), false);
  assert.equal(readFileSync(join(target, 'RULES.md'), 'utf8'), 'Use the team rules.\n');
  assert.match(readFileSync(join(target, 'AGENTS.md'), 'utf8'), /^# Mine\n<!-- aih:begin team-rules -->\nSee RULES\.md\.\n<!-- aih:end team-rules -->\n$/);
  assert.match(readFileSync(join(target, 'pip.ini'), 'utf8'), /^\[global\]\nindex-url=https:\/\/user:hunter2@/);
  assert.equal(JSON.parse(readFileSync(join(target, '.tool', 'settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command, 'hooks/team-check.sh');
  assert.equal(run.steps.find(step => step.step === 'rules').verification.status, 'passed');
  const { run: removal } = await removed({ project: target }, 'project', ['team-folder']);
  assert.equal(removal.completion, 'complete', JSON.stringify(removal));
  assert.equal(readFileSync(join(target, 'AGENTS.md'), 'utf8'), '# Mine\n');
  assert.equal(existsSync(join(target, 'RULES.md')), false);
});

test('a change names roots `project` and `user`, sets keys with `set: [{ path, value }]` and removes them with `remove: [{ path }]`', async () => {
  const engineRoot = codexApproval(); engineRoot.operations[0].target.root = 'userHome';
  assert.equal(validateChange(engineRoot).status, 'invalid');
  const engineEntries = codexApproval(); engineEntries.operations[0].entries = [{ path: ['x'], action: 'set', value: { literal: 1 } }];
  delete engineEntries.operations[0].set;
  assert.equal(validateChange(engineEntries).status, 'invalid');
  const empty = codexApproval(); empty.operations[0].set = [];
  assert.deepEqual(validateChange(empty).problems.map(problem => problem.reason), ['entries-empty']);
  const overlap = codexApproval(); overlap.operations[0].remove = [{ path: ['approval_policy'] }];
  assert.ok(validateChange(overlap).problems.some(problem => problem.path === '/operations/0/remove/0'), JSON.stringify(validateChange(overlap)));
  const target = project();
  mkdirSync(join(target, '.team')); writeFileSync(join(target, '.team', 'settings.json'), '{\n  "legacy": true,\n  "mine": 1\n}\n');
  const change = projectSetting('tidy', 'lint', true);
  change.operations[0].remove = [{ path: ['legacy'] }];
  // Removing a key Core does not own is your content: a conflict, applied only after a reviewed replace.
  const request = changeRequest([{ managementId: 'tidy', change }], { project: target });
  const blocked = await prepare(request);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.review.steps[0].sentence, 'Sets `lint` and removes `legacy` in `.team/settings.json`');
  const [conflict] = blocked.review.conflicts;
  await applied({ ...request, resolutions: [{ managementId: 'tidy', step: 'set', choice: 'replace', observedSha256: conflict.observedSha256 }] });
  assert.deepEqual(JSON.parse(readFileSync(join(target, '.team', 'settings.json'), 'utf8')), { mine: 1, lint: true });
});

test('skip leaves out a conflicting operation and what waits for it; the review is partial and needs allowPartial', async () => {
  const target = project();
  writeFileSync(join(target, 'TEAM.md'), 'mine\n');
  const change = teamFile('pair', 'TEAM.md');
  change.operations.push({ id: 'also', purpose: 'Write also', kind: 'file.write', scope: 'project', target: { root: 'project', segments: [{ literal: 'ALSO.md' }] },
    content: { literal: 'also\n' }, requires: ['write'], checks: [] },
  { id: 'other', purpose: 'Write other', kind: 'file.write', scope: 'project', target: { root: 'project', segments: [{ literal: 'OTHER.md' }] },
    content: { literal: 'other\n' }, requires: [], checks: [] });
  const request = changeRequest([{ managementId: 'pair', change, inputs: { text: 'shared\n' } }], { project: target });
  const blocked = await prepare(request);
  assert.equal(blocked.status, 'blocked');
  const [conflict] = blocked.review.conflicts;
  assert.ok(conflict.choices.includes('skip'), JSON.stringify(conflict));
  const skipped = await prepare({ ...request, resolutions: [{ managementId: 'pair', step: 'write', choice: 'skip', observedSha256: conflict.observedSha256 }] });
  assert.equal(skipped.status, 'partial', JSON.stringify(skipped));
  conforms(skipped.review);
  assert.deepEqual(skipped.review.steps.filter(step => step.effect === 'skipped').map(step => step.step).sort(), ['also', 'write']);
  const refused = conforms(await apply(skipped.handle, approve(skipped.review)));
  assert.equal(refused.completion, 'rejected');
  const again = await prepare({ ...request, resolutions: [{ managementId: 'pair', step: 'write', choice: 'skip', observedSha256: conflict.observedSha256 }] });
  assert.equal(conforms(await apply(again.handle, approve(again.review, { allowPartial: true }))).completion, 'complete');
  assert.equal(readFileSync(join(target, 'TEAM.md'), 'utf8'), 'mine\n');
  assert.equal(readFileSync(join(target, 'OTHER.md'), 'utf8'), 'other\n');
  assert.equal(existsSync(join(target, 'ALSO.md')), false);
  const unknown = await prepare({ ...request, resolutions: [{ managementId: 'pair', step: 'nobody', choice: 'skip', observedSha256: null }] });
  assert.deepEqual([unknown.status, unknown.problems[0].reason], ['invalid', 'resolution-unknown']);
});

test('a user-scope change made for two projects is two claims: removing one project keeps it, removing the second restores the file', async () => {
  const codex = join(home, '.codex'); mkdirSync(codex, { recursive: true });
  const original = '# mine\n';
  writeFileSync(join(codex, 'config.toml'), original);
  const one = project(), two = project();
  const request = target => changeRequest([{ managementId: 'codex-approval-on-request', change: codexApproval() }], { scope: 'user', project: target });
  await applied(request(one));
  const written = readFileSync(join(codex, 'config.toml'), 'utf8');
  const second = await applied(request(two));
  assert.deepEqual(second.run.steps.map(step => step.application), ['already-satisfied']);
  const row = conforms(await list({ target: { project: one }, scope: 'user' })).entries.filter(entry => entry.managementId === 'codex-approval-on-request');
  assert.equal(row.length, 1, JSON.stringify(await list({ target: { project: one }, scope: 'user' })));
  assert.deepEqual(row[0].claims.map(claim => claim.project).sort(), [realpathSync(one), realpathSync(two)].sort());
  const first = await removed({ project: one }, 'user', ['codex-approval-on-request']);
  assert.equal(first.run.completion, 'complete', JSON.stringify(first.run));
  assert.equal(readFileSync(join(codex, 'config.toml'), 'utf8'), written, 'the other project still claims the change');
  const last = await removed({ project: two }, 'user', ['codex-approval-on-request']);
  assert.equal(last.run.completion, 'complete', JSON.stringify(last.run));
  assert.equal(readFileSync(join(codex, 'config.toml'), 'utf8'), original);
});
