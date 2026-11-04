// Enterprise admission (contract 11) through the built public entries, in a disposable home and project. Organization
// documents are local fixture files (no GitHub reads); producer documents are Core-side fixtures, not Catalog output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, list, prepare, prepareRemoval, prepareUpdate } from '../dist/core/index.js';
import { validateFormat } from '../dist/core/contracts.js';
import { ownRequest, renderRequest } from './fixtures/plan-fixture.mjs';
import * as reader from './fixtures/catalog-node-fixture/reader.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-enterprise-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
before(() => { const home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true }); });

const SKILLS = { notes: { 'SKILL.md': '---\nname: notes\ndescription: Take notes\n---\nTake notes.\n' } };
const ORGANIZATION = 'urn:aihq:core:organization:0.1.0';
const CODEX = { id: 'codex', surface: 'cli' };
const catalog = { version: reader.FIXTURE_VERSION, renderStep: reader.renderStep, planRecipe: reader.planRecipe };
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const conforms = value => { const read = validateFormat(value); assert.equal(read.status, 'ok', JSON.stringify(read)); return value; };
let counter = 0;
function project() { const path = join(scratch, `project-${counter++}`); mkdirSync(path); return path; }
/** Writes a local organization fixture document and returns its source. */
function organization(entries, extra = {}) {
  const path = join(scratch, `org-${counter++}.json`);
  writeFileSync(path, JSON.stringify({ schema: ORGANIZATION, id: 'acme', entries, ...extra }));
  return { provider: 'local', path };
}
const enterprise = (request, client = CODEX) => ({ ...request, mode: 'enterprise', target: { ...request.target, ...(client ? { client } : {}) } });
const withKind = (request, kind) => { for (const item of request.contents[0].items) item.kind = kind; return request; };

test('sources.own denies own-content hooks for the whole request, naming the rule; skills of an allowed kind install', async () => {
  const source = organization([], { sources: { own: { kinds: ['skill', 'rule'] } } });
  const target = project();
  const denied = await prepare(enterprise(withKind(ownRequest(target, SKILLS, ['codex']), 'hook')), { organization: source });
  assert.equal(denied.status, 'blocked', JSON.stringify(denied));
  assert.equal(denied.code, 'AUTHORITY_DENIED');
  assert.match(denied.reason, /sources\.own/);
  assert.equal(denied.handle, undefined);
  conforms(denied.review);
  assert.deepEqual(denied.review.organization.denials.map(item => [item.reason, item.rule]), [['own-content', 'sources.own']]);
  assert.equal(denied.review.organization.admitted, false);

  const allowed = await prepare(enterprise(ownRequest(target, SKILLS, ['codex'])), { organization: source });
  assert.equal(allowed.status, 'ready', JSON.stringify(allowed));
  assert.equal(allowed.review.organization.admitted, true);
  assert.equal(allowed.review.organization.target.client.id, 'codex');
  const run = conforms(await apply(allowed.handle, approve(allowed.review), { organization: source }));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.deepEqual(run.organization, { id: 'acme', fulfilment: [] });
});

test('Enterprise needs both the mode and the source; neither alone is admitted', async () => {
  const target = project();
  const source = organization([]);
  const missing = await prepare(enterprise(ownRequest(target, SKILLS, ['codex'])));
  assert.deepEqual([missing.status, missing.code], ['refused', 'organization-required']);
  const vibe = await prepare(ownRequest(target, SKILLS, ['codex']), { organization: source });
  assert.equal(vibe.status, 'invalid', JSON.stringify(vibe));
  const unknownClient = await prepare(enterprise(ownRequest(target, SKILLS, ['codex']), { id: 'no-such-tool', surface: 'cli' }), { organization: source });
  assert.deepEqual([unknownClient.status, unknownClient.code], ['refused', 'tool-unknown']);
  // Other documents are bounded at 1,000,000 bytes and 32 levels (contract 15), before any effect.
  const large = organization([{ id: 'big', obligation: 'recommended', content: { item: 'x'.repeat(100) } }], { padding: 'x'.repeat(1_000_001) });
  const tooLarge = await prepare(enterprise(ownRequest(target, SKILLS, ['codex'])), { organization: large });
  assert.deepEqual([tooLarge.status, tooLarge.code, tooLarge.limit], ['refused', 'limit-exceeded', 'document-bytes']);
  let nested = {}; for (let depth = 0; depth < 40; depth += 1) nested = { nested };
  const deep = organization([], { scanSigners: { add: [{ issuer: 'i', subject: 's', extensions: nested }] } });
  const tooDeep = await prepare(enterprise(ownRequest(target, SKILLS, ['codex'])), { organization: deep });
  assert.equal(tooDeep.status, 'invalid', JSON.stringify(tooDeep));
});

test('a prohibition that needs an undeclared fact fails closed; a declared mismatch does not apply', async () => {
  const target = project();
  const source = organization([{ id: 'no-hooks', obligation: 'prohibited', content: { kind: 'hook' } },
    { id: 'no-team-repo', obligation: 'prohibited', repositories: ['github.com/acme/app'], content: { item: 'local-my-skills.skill.notes' } }]);
  const request = enterprise(ownRequest(target, SKILLS, ['codex']));
  delete request.contents[0].items[0].kind;
  const unknown = await prepare(request, { organization: source });
  assert.equal(unknown.status, 'blocked', JSON.stringify(unknown));
  assert.deepEqual(unknown.review.organization.denials.map(item => [item.reason, item.entry]).sort(),
    [['target-unknown', 'no-hooks'], ['target-unknown', 'no-team-repo']]);
  const declared = enterprise(ownRequest(target, SKILLS, ['codex']));
  declared.target.repository = 'github.com/acme/other';
  const fine = await prepare(declared, { organization: source });
  assert.equal(fine.status, 'ready', JSON.stringify(fine));
  const named = enterprise(ownRequest(target, SKILLS, ['codex']));
  named.target.repository = 'github.com/acme/app';
  const prohibited = await prepare(named, { organization: source });
  assert.deepEqual([prohibited.status, prohibited.review.organization.denials[0].reason, prohibited.review.organization.denials[0].entry],
    ['blocked', 'prohibited', 'no-team-repo']);
});

test('sources.published allows only listed, pinned data repositories', async () => {
  const target = project();
  const listed = organization([], { sources: { published: [{ repository: 'samartomar/aih-catalog', commit: 'd'.repeat(40) }] } });
  const other = organization([], { sources: { published: [{ repository: 'acme/catalog' }] } });
  const pinned = organization([], { sources: { published: [{ repository: 'samartomar/aih-catalog', commit: 'a'.repeat(40) }] } });
  const request = () => enterprise(renderRequest(reader, target, SKILLS, ['codex'], { recipe: true }));
  assert.equal((await prepare(request(), { organization: listed, catalog })).status, 'ready');
  const denied = await prepare(request(), { organization: other, catalog });
  assert.deepEqual([denied.status, denied.review.organization.denials[0].rule, denied.review.organization.denials[0].reason],
    ['blocked', 'sources.published', 'source-published']);
  const moved = await prepare(request(), { organization: pinned, catalog });
  assert.deepEqual([moved.status, moved.review.organization.denials[0].reason], ['blocked', 'source-pin']);
});

test('a required recipe is fulfilled only by a proven origin, projected at Prepare and reported after the run and a removal', async () => {
  const source = organization([{ id: 'need-notes', obligation: 'required', scopes: ['project'], clients: ['codex'], content: { recipe: { id: 'notes-base' } } },
    { id: 'try-notes', obligation: 'recommended', content: { item: 'local-my-skills.skill.notes' } }]);
  const handEdited = project();
  // A plan that claims the recipe but whose proof does not reproduce it installs as `chosen` and fulfils nothing.
  const forged = enterprise(renderRequest(reader, handEdited, SKILLS, ['codex'], { recipe: true }));
  forged.recipeProof.recipeJson = forged.recipeProof.recipeJson.replace('notes-base', 'notes-base ');
  const unproven = await prepare(forged, { organization: source, catalog });
  assert.equal(unproven.status, 'ready', JSON.stringify(unproven));
  assert.equal(unproven.review.origin, 'chosen');
  assert.deepEqual(unproven.review.organization.fulfilment.map(item => [item.entry, item.status]), [['need-notes', 'not-fulfilled']]);
  assert.deepEqual(unproven.review.organization.advisory.map(item => [item.entry, item.status]), [['try-notes', 'taken']]);
  const unprovenRun = await apply(unproven.handle, approve(unproven.review), { organization: source, catalog });
  assert.deepEqual(unprovenRun.organization.fulfilment.map(item => item.status), ['not-fulfilled']);

  const target = project();
  const proven = await prepare(enterprise(renderRequest(reader, target, SKILLS, ['codex'], { recipe: true })), { organization: source, catalog });
  assert.equal(proven.status, 'ready', JSON.stringify(proven));
  assert.notEqual(proven.review.origin, 'chosen');
  assert.deepEqual(proven.review.organization.fulfilment.map(item => [item.entry, item.status]), [['need-notes', 'fulfilled']]);
  const run = conforms(await apply(proven.handle, approve(proven.review), { organization: source, catalog }));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.deepEqual(run.organization.fulfilment.map(item => [item.entry, item.status, item.managementIds]),
    [['need-notes', 'fulfilled', ['local-my-skills.skill.notes']]]);
  const listed = await list({ target: { project: target }, scope: 'project' });
  assert.deepEqual([listed.entries[0].kind, listed.entries[0].framework], ['skill', 'local-my-skills']);

  // Removing the last receipt holding the recipe's origin reads as not fulfilled, projected and actual.
  const removal = await prepareRemoval({ target: { project: target, client: CODEX }, scope: 'project', mode: 'enterprise',
    removals: [{ managementId: 'local-my-skills.skill.notes' }] }, { organization: source });
  assert.equal(removal.status, 'ok', JSON.stringify(removal));
  conforms(removal.review);
  assert.deepEqual(removal.review.organization.fulfilment.map(item => item.status), ['not-fulfilled']);
  const removed = await apply(removal.handle, approve(removal.review), { organization: source });
  assert.equal(removed.completion, 'complete', JSON.stringify(removed));
  assert.deepEqual(removed.organization.fulfilment.map(item => item.status), ['not-fulfilled']);
});

test('without a declared client a client-narrowed obligation is judged over each claim’s recorded CLI; an undeclared repository is unknown', async () => {
  const source = organization([{ id: 'need-notes', obligation: 'required', clients: ['codex'], repositories: ['github.com/acme/app'],
    content: { item: 'local-my-skills.skill.notes' } }]);
  const target = project();
  const prepared = await prepare(enterprise(ownRequest(target, SKILLS, ['codex']), null), { organization: source });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.deepEqual(prepared.review.organization.fulfilment.map(item => [item.status, item.unknown]), [['unknown', ['repository']]]);
  const declared = enterprise(ownRequest(target, SKILLS, ['codex']), null);
  declared.target.repository = 'github.com/acme/app';
  const known = await prepare(declared, { organization: source });
  assert.deepEqual(known.review.organization.fulfilment.map(item => item.status), ['fulfilled']);
});

test('a changed organization document makes Apply rejected before anything runs; a contradictory one is invalid', async () => {
  const target = project();
  const source = organization([]);
  const prepared = await prepare(enterprise(ownRequest(target, SKILLS, ['codex'])), { organization: source });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  writeFileSync(source.path, JSON.stringify({ schema: ORGANIZATION, id: 'acme', entries: [{ id: 'no-skills', obligation: 'prohibited', content: { kind: 'skill' } }] }));
  const run = conforms(await apply(prepared.handle, approve(prepared.review), { organization: source }));
  assert.deepEqual([run.completion, run.code, run.changed], ['rejected', 'REVIEW_STALE', 'policy']);
  assert.deepEqual((await list({ target: { project: target }, scope: 'project' })).entries, []);

  const contradictory = organization([{ id: 'need', obligation: 'required', content: { item: 'x.skill.a' } },
    { id: 'ban', obligation: 'prohibited', scopes: ['project'], content: { item: 'x.skill.a', kind: 'skill' } }]);
  const invalid = await prepare(enterprise(ownRequest(target, SKILLS, ['codex'])), { organization: contradictory });
  assert.equal(invalid.status, 'invalid', JSON.stringify(invalid));
  assert.ok(invalid.problems.some(problem => problem.reason === 'obligation-contradiction'), JSON.stringify(invalid));
});

test('an update needs admission too: a prohibited new plan is blocked as a whole', async () => {
  const target = project();
  const installed = await prepare(ownRequest(target, SKILLS, ['codex']));
  assert.equal((await apply(installed.handle, approve(installed.review))).completion, 'complete');
  const source = organization([{ id: 'no-notes', obligation: 'prohibited', content: { item: 'local-my-skills.skill.notes' } }]);
  const update = await prepareUpdate({ target: { project: target }, scope: 'project',
    updates: [{ managementIds: ['local-my-skills.skill.notes'], request: enterprise(ownRequest(target, { notes: { 'SKILL.md': 'Newer.\n' } }, ['codex'])) }] },
  { organization: source });
  assert.equal(update.status, 'ok', JSON.stringify(update));
  assert.equal(update.handle, undefined);
  assert.deepEqual(update.entries.map(entry => entry.status), ['blocked']);
  assert.deepEqual(update.review.organization.denials.map(item => item.entry), ['no-notes']);
});

test('changes are admitted by identity with input and lifecycle permissions; a required change is fulfilled once installed', async () => {
  const { deriveChangeIdentity } = await import('../dist/core/contracts.js');
  const { changeRequest, teamFile } = await import('./fixtures/change-fixture.mjs');
  const change = teamFile('team-notes', 'TEAM.md');
  const identity = (await deriveChangeIdentity({ change })).changeIdentity;
  const request = (text, target) => enterprise({ ...changeRequest([{ managementId: 'team-notes', change, inputs: { text } }], { project: target }) });
  const target = project();
  const unnamed = await prepare(request('Read the guide.\n', target), { organization: organization([]) });
  assert.deepEqual([unnamed.status, unnamed.code, unnamed.review.organization.denials[0].reason], ['blocked', 'AUTHORITY_DENIED', 'change-not-admitted']);
  const source = organization([{ id: 'team-notes', obligation: 'required', change: { identity }, inputs: { text: { choices: ['Read the guide.\n'] } },
    lifecycle: { remove: false } }]);
  const other = await prepare(request('Something else.\n', target), { organization: source });
  assert.deepEqual([other.status, other.review.organization.denials.map(item => [item.reason, item.input])], ['blocked', [['input-value', 'text']]]);
  const prepared = await prepare(request('Read the guide.\n', target), { organization: source });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.deepEqual(prepared.review.organization.fulfilment.map(item => item.status), ['fulfilled']);
  const run = conforms(await apply(prepared.handle, approve(prepared.review), { organization: source }));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.deepEqual(run.organization.fulfilment.map(item => [item.status, item.managementIds]), [['fulfilled', ['team-notes']]]);
  // The entry does not permit removing the change: the removal is blocked as a whole.
  const removal = { target: { project: target }, scope: 'project', mode: 'enterprise', removals: [{ managementId: 'team-notes' }] };
  const blocked = await prepareRemoval(removal, { organization: source });
  assert.equal(blocked.status, 'ok', JSON.stringify(blocked));
  assert.deepEqual([blocked.code, blocked.handle, blocked.entries[0].status, blocked.review.organization.denials[0].reason],
    ['AUTHORITY_DENIED', undefined, 'blocked', 'lifecycle-remove']);
  const removable = organization([{ id: 'team-notes', obligation: 'permitted', change: { identity }, inputs: { text: { allowDeclared: true } }, lifecycle: { remove: true } }]);
  const allowed = await prepareRemoval(removal, { organization: removable });
  assert.ok(allowed.handle, JSON.stringify(allowed));
  assert.equal((await apply(allowed.handle, approve(allowed.review), { organization: removable })).completion, 'complete');
});

test('previewAdmission answers all three results with no host effects; without an inventory it counts only the request', async () => {
  const { previewAdmission, validateOrganizationPolicy, schemas } = await import('../dist/core/contracts.js');
  const id = 'urn:aihq:core:organization:0.1.0';
  assert.equal(validateOrganizationPolicy(schemas[id].fixtures.valid).status, 'ok');
  assert.equal(validateOrganizationPolicy(schemas[id].fixtures.invalid).status, 'invalid');
  const document = { schema: ORGANIZATION, id: 'acme', entries: [
    { id: 'need-notes', obligation: 'required', content: { item: 'local-my-skills.skill.notes' } },
    { id: 'need-review', obligation: 'required', content: { item: 'local-my-skills.skill.review' } },
    { id: 'no-hooks', obligation: 'prohibited', content: { kind: 'hook' } }],
  scanSigners: { add: [{ issuer: 'https://token.actions.githubusercontent.com', subject: 'https://github.com/acme/scan' }] } };
  const target = project();
  const request = ({ files, ...rest }) => ({ ...rest, files: files.map(({ bytes: _bytes, ...entry }) => entry) });
  const notes = request(ownRequest(target, SKILLS, ['codex']));
  const alone = await previewAdmission({ organization: document, request: notes, target: { client: CODEX } });
  assert.equal(alone.status, 'ok', JSON.stringify(alone));
  assert.deepEqual([alone.value.admitted, alone.value.fulfilment.map(item => item.status)], [true, ['fulfilled', 'not-fulfilled']]);
  assert.deepEqual(alone.value.scanSigners, document.scanSigners);
  // With an installed inventory, what is already there counts too.
  const review = { review: { 'SKILL.md': 'Review.\n' } };
  const installed = await prepare(ownRequest(target, review, ['codex']));
  assert.equal((await apply(installed.handle, approve(installed.review))).completion, 'complete');
  const inventory = await list({ target: { project: target }, scope: 'project' });
  const both = await previewAdmission({ organization: document, request: notes, target: { client: CODEX }, installed: inventory });
  assert.deepEqual(both.value.fulfilment.map(item => item.status), ['fulfilled', 'fulfilled']);
  const hooks = await previewAdmission({ organization: document, request: request(withKind(ownRequest(target, SKILLS, ['codex']), 'hook')) });
  assert.deepEqual([hooks.value.admitted, hooks.value.denials[0].entry], [false, 'no-hooks']);
  // A preview proves no recipe origin: a required recipe reads unknown, never fulfilled.
  const recipe = { schema: ORGANIZATION, id: 'acme', entries: [{ id: 'need-recipe', obligation: 'required', content: { recipe: { id: 'notes-base' } } }] };
  const planned = await previewAdmission({ organization: recipe, request: request(renderRequest(reader, target, SKILLS, ['codex'], { recipe: true })) });
  assert.deepEqual(planned.value.fulfilment.map(item => item.status), ['unknown']);
  assert.equal((await previewAdmission({ organization: { ...document, schema: 'urn:aihq:core:organization:9.0.0' }, request: notes })).status, 'unsupported-version');
});

test('organization Scan signers are carried in the review and never gate the request', async () => {
  const signers = { replace: [{ identity: 'acme-scan', issuer: 'https://token.actions.githubusercontent.com', subject: 'https://github.com/acme/scan/.github/workflows/scan.yml@refs/heads/main' }] };
  const source = organization([], { scanSigners: signers });
  const prepared = await prepare(enterprise(ownRequest(project(), SKILLS, ['codex'])), { organization: source });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.deepEqual(prepared.review.organization.scanSigners, signers);
});

test('actual fulfilment after a failed step differs from the projection: a requirement the review projected as fulfilled reads not fulfilled', async () => {
  const { programRequest } = await import('./fixtures/program-fixture.mjs');
  const id = 'fixture.ai-setup.failing-tool';
  // A Core-side installer FIXTURE whose command exits 3: the real Node on PATH, so nothing is installed.
  const installer = { item: { id, kind: 'ai-setup', name: 'failing-tool', files: [], aiSetup: { version: '1.0.0', settings: { commands: [], files: [] } } },
    step: { op: 'upstream-installer', aiSetup: id, argv: ['node', '-e', 'process.exit(3)'], managed: false, scanned: false, approval: 'required' } };
  const target = project();
  const request = enterprise(programRequest(target, { installers: [installer] }), { id: 'claude-code', surface: 'cli' });
  const source = organization([{ id: 'need-tool', obligation: 'required', content: { item: id } }]);
  const prepared = await prepare(request, { organization: source });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  assert.deepEqual(prepared.review.organization.fulfilment.map(item => item.status), ['fulfilled']);
  const run = conforms(await apply(prepared.handle, approve(prepared.review), { organization: source }));
  assert.notEqual(run.completion, 'complete', JSON.stringify(run));
  assert.equal(run.steps[0].application, 'failed', JSON.stringify(run));
  assert.deepEqual(run.organization.fulfilment.map(item => item.status), ['not-fulfilled'], JSON.stringify(run.organization));
});
