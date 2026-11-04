// Plan requests (urn:aihq:core:plan-request:0.1.0) through the built public entries, in a disposable home and project.
// Producer documents are Core-side fixtures (test/fixtures/plan-fixture.mjs), not Catalog output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, list, prepare, prepareRemoval } from '../dist/core/index.js';
import { ownRequest, profile, sha256 } from './fixtures/plan-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-plan-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let home;
before(() => { home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true }); });

const SKILLS = { notes: { 'SKILL.md': '---\nname: notes\ndescription: Take notes\n---\nTake notes.\n', 'reference.md': 'Reference.\n' } };
const approve = (review, extra = {}) => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest, ...extra });
let counter = 0;
function project() {
  const path = join(scratch, `project-${counter++}`);
  mkdirSync(path);
  writeFileSync(join(path, 'README.md'), 'mine\n');
  return path;
}
/** Every file under a folder with its bytes, so a removal can be compared byte for byte. */
function snapshot(folder) {
  const out = {};
  const walk = (dir, prefix) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(join(dir, entry.name), rel); else out[rel] = readFileSync(join(dir, entry.name), 'utf8');
  } };
  walk(folder, '');
  return out;
}

test('own content installs through a frozen review, lists as chosen with data null, and removal restores the project byte for byte', async () => {
  const target = project();
  const before = snapshot(target);
  const prepared = await prepare(ownRequest(target, SKILLS));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.equal(prepared.review.schema, 'urn:aihq:core:review:0.1.0');
  assert.match(prepared.review.reviewDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(prepared.review.steps.map(step => step.sentence), [
    'Writes `.agents/skills/notes/SKILL.md`', 'Writes `.agents/skills/notes/reference.md`',
    'Writes `.claude/skills/notes/SKILL.md`', 'Writes `.claude/skills/notes/reference.md`',
    'Writes `.kiro/skills/notes/SKILL.md`', 'Writes `.kiro/skills/notes/reference.md`']);
  assert.equal(prepared.review.origin, 'chosen');
  assert.equal(prepared.review.plan.data, null);
  assert.equal(Object.isFrozen(prepared.review), true);
  assert.equal(JSON.stringify(prepared.review).includes('Take notes.'), false, 'source bytes never appear in the review');

  const run = await apply(prepared.handle, approve(prepared.review));
  assert.equal(run.schema, 'urn:aihq:core:run:0.1.0');
  assert.equal(run.status, 'ok');
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.ok(run.steps.every(step => step.application === 'applied'));
  assert.ok(run.members.every(member => member.check === 'present-matching'));
  assert.equal(readFileSync(join(target, '.claude/skills/notes/SKILL.md'), 'utf8'), SKILLS.notes['SKILL.md']);

  const listed = await list({ target: { project: target }, scope: 'project' });
  assert.equal(listed.schema, 'urn:aihq:core:inventory:0.1.0');
  assert.equal(listed.status, 'ok');
  const entry = listed.entries.find(row => row.managementId === 'local-my-skills.skill.notes');
  assert.ok(entry, JSON.stringify(listed));
  assert.deepEqual([entry.scope, entry.origin, entry.data, entry.items, entry.clis, entry.installState],
    ['project', 'chosen', null, ['local-my-skills.skill.notes'], ['claude-code', 'codex', 'kiro'], 'complete']);
  assert.equal(entry.members.length, 6);
  assert.ok(entry.members.every(member => member.state === 'matching'));

  const removal = await prepareRemoval({ target: { project: target }, scope: 'project', removals: [{ managementId: 'local-my-skills.skill.notes' }] });
  assert.equal(removal.status, 'ok', JSON.stringify(removal));
  assert.deepEqual(removal.entries.map(row => [row.managementId, row.disposition, row.status]), [['local-my-skills.skill.notes', 'prepared', 'ready']]);
  const removed = await apply(removal.handle, approve(removal.review));
  assert.equal(removed.completion, 'complete', JSON.stringify(removed));
  assert.deepEqual(snapshot(target), before);
  assert.deepEqual((await list({ target: { project: target }, scope: 'project' })).entries, []);
});

const ID = 'local-my-skills.skill.notes';
const nothingWritten = (target, before) => assert.deepEqual(snapshot(target), before, 'no target effect before a refusal');
const pick = run => [run.completion, run.code, run.changed];

test('a request is refused or invalid before any target effect, naming the cause and the step', async () => {
  const target = project();
  const before = snapshot(target);
  const cases = [
    ['source missing (no bytes)', request => { delete request.files[0].bytes; }, { status: 'refused', code: 'source-missing', step: 0 }],
    ['source missing (no entry)', request => { request.files.splice(0, 1); }, { status: 'refused', code: 'source-missing' }],
    ['source mismatch', request => { request.files[0].bytes = Buffer.from('other bytes'); }, { status: 'refused', code: 'source-mismatch' }],
    ['tool unknown in a profile', request => { request.profiles.push(profile('gemini')); }, { status: 'refused', code: 'tool-unknown', tool: 'gemini' }],
    ['tool unknown in a step', request => { request.plan.plan[0].clis = ['emacs']; }, { status: 'refused', code: 'tool-unknown', tool: 'emacs' }],
    ['a step kind not carried out yet', request => { request.plan.plan.push({ op: 'link', item: ID, root: 'user', path: 'x', to: 'y' }); }, { status: 'refused', code: 'step-unknown', op: 'link' }],
    ['an unknown step kind', request => { request.plan.plan.push({ op: 'teleport' }); }, { status: 'refused', code: 'step-unknown', op: 'teleport' }],
    ['a path leaving its root', request => { request.plan.plan[0].path = '../outside/SKILL.md'; }, { status: 'refused', code: 'path-escape', step: 0 }],
    ['an absolute path', request => { request.plan.plan[0].path = '/etc/SKILL.md'; }, { status: 'refused', code: 'path-escape' }],
    ['a target in Core state', request => { request.plan.plan[0].root = 'user'; request.plan.plan[0].path = '.aih/core/ownership/x.json'; }, { status: 'refused', code: 'state-path' }],
    ['an unresolved clash', request => { request.plan.clashes.push({ item: ID, reason: 'provides' }); }, { status: 'refused', code: 'plan-unresolved' }],
    ['a render without the Catalog', request => { request.plan.plan[0].render = 'skill-user-only'; }, { status: 'refused', code: 'catalog-required', step: 0 }],
    ['a duplicate file entry', request => { request.files.push({ ...request.files[0] }); }, { status: 'invalid' }],
    ['an undeclared files field', request => { request.files[0].extra = 1; }, { status: 'invalid' }],
    ['a project-scope request without its project', request => { delete request.target.project; }, { status: 'invalid' }],
  ];
  for (const [name, change, expected] of cases) {
    const request = ownRequest(target, SKILLS);
    change(request);
    const result = await prepare(request);
    for (const [field, value] of Object.entries(expected)) assert.equal(result[field], value, `${name}: ${JSON.stringify(result)}`);
    assert.equal(result.handle, undefined, name);
    if (expected.status === 'refused') assert.match(result.reason, /\S/, name);
  }
  const duplicate = ownRequest(target, SKILLS); duplicate.files.push({ ...duplicate.files[0] });
  assert.equal((await prepare(duplicate)).problems[0].reason, 'duplicate-file');
  assert.deepEqual(await prepare({ ...ownRequest(target, SKILLS), schema: 'urn:aihq:core:plan-request:0.2.0' }),
    { status: 'unsupported-version', encountered: 'urn:aihq:core:plan-request:0.2.0', supported: ['urn:aihq:core:plan-request:0.1.0'] });
  nothingWritten(target, before);
  // An incomplete plan whose only reasons are missing and unavailable is carried out after approval, listing them.
  const incomplete = ownRequest(target, SKILLS);
  Object.assign(incomplete.plan, { status: 'incomplete', unavailable: [{ item: 'local-my-skills.agent.x', cli: 'dsh', reason: 'no-edition' }] });
  const prepared = await prepare(incomplete);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.deepEqual(prepared.review.plan.unavailable, incomplete.plan.unavailable);
  // A file no step names is ignored and listed.
  const extra = ownRequest(target, SKILLS);
  extra.files.push({ sourceId: 'local-my-skills', sourcePath: 'unused.md', sha256: sha256('unused'), bytes: Buffer.from('unused') });
  assert.deepEqual((await prepare(extra)).review.ignoredFiles, [{ sourceId: 'local-my-skills', sourcePath: 'unused.md' }]);
  nothingWritten(target, before);
});

test('apply requires the exact approval once, and rejects a review whose request, target or ownership changed', async () => {
  const target = project();
  const before = snapshot(target);
  const fresh = async request => { const prepared = await prepare(request ?? ownRequest(target, SKILLS)); assert.equal(prepared.status, 'ready'); return prepared; };
  let prepared = await fresh();
  const wrong = await apply(prepared.handle, { ...approve(prepared.review), reviewDigest: '0'.repeat(64) });
  assert.deepEqual([wrong.completion, wrong.code, wrong.reason], ['rejected', 'REVIEW_STALE', 'digest-mismatch']);
  const again = await apply(prepared.handle, approve(prepared.review));
  assert.deepEqual([again.schema, again.completion, again.reason], ['urn:aihq:core:run:0.1.0', 'rejected', 'handle-unavailable'], 'a handle is consumed');
  // The caller changes the request (bytes or document) after Prepare.
  const request = ownRequest(target, SKILLS);
  prepared = await fresh(request);
  request.files[0].bytes = Buffer.from('changed after review');
  assert.deepEqual(pick(await apply(prepared.handle, approve(prepared.review))), ['rejected', 'REVIEW_STALE', 'binding']);
  const document = ownRequest(target, SKILLS);
  prepared = await fresh(document);
  document.plan.warnings.push('edited');
  assert.deepEqual(pick(await apply(prepared.handle, approve(prepared.review))), ['rejected', 'REVIEW_STALE', 'binding']);
  nothingWritten(target, before);
  // A target appears after Prepare.
  prepared = await fresh();
  mkdirSync(join(target, '.claude/skills/notes'), { recursive: true });
  writeFileSync(join(target, '.claude/skills/notes/SKILL.md'), 'mine now\n');
  assert.deepEqual(pick(await apply(prepared.handle, approve(prepared.review))), ['rejected', 'REVIEW_STALE', 'target-file']);
  assert.equal(readFileSync(join(target, '.claude/skills/notes/SKILL.md'), 'utf8'), 'mine now\n');
  rmSync(join(target, '.claude'), { recursive: true });
  // Receipts change after a removal was reviewed.
  const installed = await fresh();
  assert.equal((await apply(installed.handle, approve(installed.review))).completion, 'complete');
  const removal = await prepareRemoval({ target: { project: target }, scope: 'project', removals: [{ managementId: ID }] });
  const other = await prepare(ownRequest(target, { other: { 'SKILL.md': 'Other.\n' } }));
  assert.equal((await apply(other.handle, approve(other.review))).completion, 'complete');
  const stale = await apply(removal.handle, approve(removal.review));
  assert.equal(stale.completion, 'rejected', JSON.stringify(stale));
  assert.equal(stale.code, 'REVIEW_STALE');
  assert.ok(['ownership', 'target-file'].includes(stale.changed), stale.changed);
  assert.equal(existsSync(join(target, '.claude/skills/notes/SKILL.md')), true, 'a rejected removal removes nothing');
});

test('cancellation is reported before and during the work, never as success', async () => {
  const target = project();
  const before = snapshot(target);
  const aborted = new AbortController(); aborted.abort();
  const refused = await prepare(ownRequest(target, SKILLS), { signal: aborted.signal });
  assert.deepEqual([refused.status, refused.code], ['refused', 'cancelled']);
  const prepared = await prepare(ownRequest(target, SKILLS));
  const run = await apply(prepared.handle, approve(prepared.review), { signal: aborted.signal });
  assert.equal(run.completion, 'cancelled');
  nothingWritten(target, before);
});

test('removal keeps your later edits and unrelated files, unregisters missing members, and a reviewed replace is restored on removal', async () => {
  const target = project();
  const prepared = await prepare(ownRequest(target, SKILLS));
  assert.equal((await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  writeFileSync(join(target, '.claude/skills/notes/SKILL.md'), 'my edit\n');
  rmSync(join(target, '.kiro/skills/notes/reference.md'));
  writeFileSync(join(target, '.agents/skills/notes/mine.md'), 'unrelated\n');
  const relative = path => path.slice(target.length + 1).replaceAll('\\', '/');
  const states = Object.fromEntries((await list({ target: { project: target }, scope: 'project' })).entries[0].members
    .map(member => [relative(member.path), member.state]));
  assert.equal(states['.claude/skills/notes/SKILL.md'], 'changed-by-you');
  assert.equal(states['.kiro/skills/notes/reference.md'], 'missing');
  const removal = await prepareRemoval({ target: { project: target }, scope: 'project', removals: [{ managementId: ID }] });
  const actions = Object.fromEntries(removal.entries[0].members.map(member => [relative(member.path), member.action]));
  assert.equal(actions['.claude/skills/notes/SKILL.md'], 'keep-changed');
  assert.equal(actions['.kiro/skills/notes/reference.md'], 'unregister');
  assert.equal(actions['.agents/skills/notes/SKILL.md'], 'remove');
  const run = await apply(removal.handle, approve(removal.review, removal.entries[0].status === 'partial' ? { allowPartial: true } : {}));
  assert.notEqual(run.completion, 'rejected', JSON.stringify(run));
  assert.equal(readFileSync(join(target, '.claude/skills/notes/SKILL.md'), 'utf8'), 'my edit\n');
  assert.equal(readFileSync(join(target, '.agents/skills/notes/mine.md'), 'utf8'), 'unrelated\n');
  assert.equal(existsSync(join(target, '.agents/skills/notes/SKILL.md')), false);
  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), 'mine\n');

  // Your own file at a planned path: blocked with no handle, then a reviewed replace, then removal writes yours back.
  const second = project();
  mkdirSync(join(second, '.claude/skills/notes'), { recursive: true });
  writeFileSync(join(second, '.claude/skills/notes/SKILL.md'), 'my own skill\n');
  const blocked = await prepare(ownRequest(second, SKILLS));
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
  assert.equal(blocked.handle, undefined);
  const [conflict] = blocked.review.conflicts;
  assert.deepEqual([conflict.code, conflict.reason, conflict.target, conflict.observedSha256, conflict.choices.includes('replace')],
    ['STATE_CONFLICT', 'existing-content', '.claude/skills/notes/SKILL.md', sha256('my own skill\n'), true]);
  const replaced = await prepare({ ...ownRequest(second, SKILLS),
    resolutions: [{ managementId: ID, step: conflict.step, choice: 'replace', observedSha256: conflict.observedSha256 }] });
  assert.equal(replaced.status, 'ready', JSON.stringify(replaced));
  assert.equal((await apply(replaced.handle, approve(replaced.review))).completion, 'complete');
  assert.equal(readFileSync(join(second, '.claude/skills/notes/SKILL.md'), 'utf8'), SKILLS.notes['SKILL.md']);
  const undo = await prepareRemoval({ target: { project: second }, scope: 'project', removals: [{ managementId: ID }] });
  assert.equal((await apply(undo.handle, approve(undo.review))).completion, 'complete');
  assert.equal(readFileSync(join(second, '.claude/skills/notes/SKILL.md'), 'utf8'), 'my own skill\n');
  // Skip leaves that member out and needs partial approval.
  const third = project();
  mkdirSync(join(third, '.claude/skills/notes'), { recursive: true });
  writeFileSync(join(third, '.claude/skills/notes/SKILL.md'), 'mine\n');
  const skip = () => prepare({ ...ownRequest(third, SKILLS), resolutions: [{ managementId: ID, step: conflict.step, choice: 'skip', observedSha256: sha256('mine\n') }] });
  const skipped = await skip();
  assert.equal(skipped.status, 'partial', JSON.stringify(skipped));
  assert.equal(skipped.review.steps.find(step => step.step === conflict.step).effect, 'skipped');
  assert.equal((await apply(skipped.handle, approve(skipped.review))).reason, 'partial-approval-required');
  const retry = await skip();
  assert.equal((await apply(retry.handle, approve(retry.review, { allowPartial: true }))).completion, 'complete');
  assert.equal(readFileSync(join(third, '.claude/skills/notes/SKILL.md'), 'utf8'), 'mine\n');
});

test('the 0.1.0 documents conform to their published schemas', async () => {
  const { schemas, validateFormat, refusalCodes, limits } = await import('../dist/core/contracts.js');
  assert.deepEqual(Object.keys(schemas).sort(), ['urn:aihq:core:export-inputs:0.1.0', 'urn:aihq:core:export-request:0.1.0',
    'urn:aihq:core:inventory:0.1.0', 'urn:aihq:core:macos-session-custody:0.1.0', 'urn:aihq:core:macos-session-inputs:0.1.0',
    'urn:aihq:core:macos-session-profiles:0.1.0', 'urn:aihq:core:macos-session-request:0.1.0',
    'urn:aihq:core:macos-session-verification-request:0.1.0', 'urn:aihq:core:macos-session-verification-result:0.1.0', 'urn:aihq:core:plan-request:0.1.0', 'urn:aihq:core:repair-inputs:0.1.0',
    'urn:aihq:core:repair-request:0.1.0', 'urn:aihq:core:review:0.1.0', 'urn:aihq:core:run:0.1.0', 'urn:aihq:core:trust-custody:0.1.0']);
  for (const [id, entry] of Object.entries(schemas)) {
    assert.deepEqual(validateFormat(entry.fixtures.valid), { status: 'ok', schema: id });
    assert.equal(validateFormat(entry.fixtures.invalid).status, 'invalid', id);
  }
  assert.ok(refusalCodes.some(entry => entry.code === 'source-missing'));
  assert.equal(limits.find(entry => entry.name === 'request-bytes').value, 16 * 1_048_576);
  const target = project();
  const request = ownRequest(target, SKILLS);
  const { files, ...rest } = request;
  assert.equal(validateFormat({ ...rest, files: files.map(({ bytes: _b, ...entry }) => entry) }).status, 'ok');
  const prepared = await prepare(request);
  assert.equal(validateFormat(prepared.review).status, 'ok', JSON.stringify(validateFormat(prepared.review)));
  const run = await apply(prepared.handle, approve(prepared.review));
  assert.equal(validateFormat(run).status, 'ok', JSON.stringify(validateFormat(run)));
  const listed = await list({ target: { project: target }, scope: 'both' });
  assert.equal(validateFormat(listed).status, 'ok', JSON.stringify(validateFormat(listed)));
  const removal = await prepareRemoval({ target: { project: target }, scope: 'project', removals: [{ managementId: ID }, { managementId: 'not-installed' }] });
  assert.deepEqual(removal.entries.map(entry => entry.disposition), ['prepared', 'absent']);
  assert.equal(validateFormat(removal.review).status, 'ok');
  assert.equal(validateFormat(await apply(removal.handle, approve(removal.review))).status, 'ok');
});
