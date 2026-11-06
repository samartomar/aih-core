// Shared managed content across projects and clients (contract 5 "Claim identity", "Which CLIs claim a member", 8.1
// `link`, "Shared copies", 12 removal by CLI, 18 journeys 2 and 3), through the built public entries in a disposable
// home and projects. Producer documents are Core-side fixtures (test/fixtures/plan-fixture.mjs), not Catalog output,
// and the junctions made here prove Core's placement only, never that a real client loads them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { apply, list, prepare, prepareRemoval, prepareUpdate } from '../dist/core/index.js';
import { validateFormat } from '../dist/core/contracts.js';
import { linkRequest, mergeRequest, ownContent, ownRequest, profile, sha256 } from './fixtures/plan-fixture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-share-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let home;
before(() => { home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true }); });

const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
let counter = 0;
const project = () => { const path = join(scratch, `project-${counter++}`); mkdirSync(path); return path; };
async function install(request) {
  const prepared = await prepare(request);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const run = await apply(prepared.handle, approve(prepared.review));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  return { prepared, run };
}
async function remove(target, removals, scope = 'user') {
  const removal = await prepareRemoval({ target: { project: target }, scope, removals });
  assert.equal(removal.status, 'ok', JSON.stringify(removal));
  const run = await apply(removal.handle, approve(removal.review));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  return { removal, run };
}

const GITHUB = 'local-my-setup.mcp.github';
const githubMerge = (clis = ['codex']) => ({ item: GITHUB, root: 'user', file: '.codex/config.toml', format: 'toml', key: 'mcp_servers.github',
  entry: { command: 'npx', args: ['-y', '@example/github-mcp'] }, clis });

test('two projects claim one user-scope [mcp_servers.github]: removing one project keeps it, removing the second removes it', async () => {
  const one = project(), two = project();
  const config = join(home, '.codex', 'config.toml');
  await install(mergeRequest(one, [githubMerge()], { scope: 'user' }));
  const written = readFileSync(config, 'utf8');
  assert.match(written, /\[mcp_servers\.github\]/);
  const second = await install(mergeRequest(two, [githubMerge()], { scope: 'user' }));
  assert.equal(readFileSync(config, 'utf8'), written, 'identical content is one member with two claims');
  assert.deepEqual(second.run.steps.map(step => step.application), ['already-satisfied']);

  const listed = await list({ target: { project: one }, scope: 'user' });
  const entry = listed.entries.find(item => item.managementId === GITHUB);
  assert.ok(entry, JSON.stringify(listed));
  assert.equal(listed.entries.filter(item => item.managementId === GITHUB).length, 1, 'one entry per management id and scope');
  assert.deepEqual(entry.claims.map(claim => claim.project).sort(), [realpathSync(one), realpathSync(two)].sort());
  assert.deepEqual(entry.claims.map(claim => claim.cli), ['codex', 'codex']);
  assert.deepEqual(entry.members.map(member => [member.kind, member.pointer, member.state, member.clis]),
    [['config-entry', '/mcp_servers/github/args', 'matching', ['codex']], ['config-entry', '/mcp_servers/github/command', 'matching', ['codex']]],
    'each leaf is one member, listed once although two claims hold it');

  const first = await remove(one, [{ managementId: GITHUB }]);
  assert.deepEqual(first.removal.entries[0].members.map(member => member.action), ['keep-shared', 'keep-shared']);
  assert.equal(readFileSync(config, 'utf8'), written, 'the other project still claims it');
  const after = (await list({ target: { project: two }, scope: 'user' })).entries.find(item => item.managementId === GITHUB);
  assert.deepEqual(after.claims.map(claim => claim.project), [realpathSync(two)]);
  // A project that holds no claim names an absent entry, never an error.
  const absent = await prepareRemoval({ target: { project: one }, scope: 'user', removals: [{ managementId: GITHUB }] });
  assert.equal(absent.entries[0].disposition, 'absent', JSON.stringify(absent));

  await remove(two, [{ managementId: GITHUB }]);
  assert.equal(existsSync(config) && /mcp_servers/.test(readFileSync(config, 'utf8')), false, 'the last claim takes the table with it');
  assert.equal((await list({ target: { project: two }, scope: 'user' })).entries.some(item => item.managementId === GITHUB), false);
});

const PLAN = 'ecc.skill.plan';
const SHARED = '.aihq/shared/ecc/skill/plan/3f9c0a1b2d4e';
const expectedLink = process.platform === 'win32' ? 'junction' : 'symlink';
const isLink = path => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
/** Everything in the home except Core's own state. */
const homeEntries = () => readdirSync(home).filter(name => name !== '.aih').sort();

test('ECC plan on Claude and Codex, user scope: each CLI place links to one shared copy, removal by CLI releases only that CLI, the last claim removes the folder', async () => {
  const target = project();
  const start = homeEntries();
  const { prepared } = await install(linkRequest(target));
  assert.equal(existsSync(join(home, '.aihq', 'links')), false, 'link records live in Core state, not beside your content');
  const links = prepared.review.steps.filter(step => step.op === 'link');
  assert.deepEqual(links.map(step => [step.path, step.clis, step.linkType]),
    [['.agents/skills/ecc-plan', ['codex'], expectedLink], ['.claude/skills/ecc-plan', ['claude-code'], expectedLink]]);
  const writes = prepared.review.steps.filter(step => step.op === 'write');
  assert.equal(writes.length, 2, 'a write two CLIs share is one review step');
  for (const place of ['.claude/skills/ecc-plan', '.agents/skills/ecc-plan']) {
    assert.equal(isLink(join(home, place)), true, `${place} is a link`);
    assert.equal(realpathSync(join(home, place)), realpathSync(join(home, SHARED)));
    assert.match(readFileSync(join(home, place, 'SKILL.md'), 'utf8'), /Plan the work/);
  }
  const listed = (await list({ target: { project: target }, scope: 'user' })).entries.find(item => item.managementId === PLAN);
  assert.deepEqual(listed.clis, ['claude-code', 'codex']);
  assert.deepEqual(listed.claims.map(claim => claim.cli), ['claude-code', 'codex']);
  const linkMembers = listed.members.filter(member => member.kind === 'link').sort((a, b) => a.path < b.path ? -1 : 1);
  assert.deepEqual(linkMembers.map(member => [member.path, member.linkType, member.state, member.clis]),
    [['.agents/skills/ecc-plan', expectedLink, 'matching', ['codex']], ['.claude/skills/ecc-plan', expectedLink, 'matching', ['claude-code']]]);
  const sharedMembers = listed.members.filter(member => member.kind === 'file');
  assert.equal(sharedMembers.length, 2);
  assert.ok(sharedMembers.every(member => canonical(member.clis) === canonical(['claude-code', 'codex'])), JSON.stringify(sharedMembers));

  // Removing it from Codex removes Codex's link and claim and keeps the copy for Claude.
  const codex = await remove(target, [{ managementId: PLAN, clis: ['codex'] }]);
  assert.equal(codex.removal.entries.length, 1);
  assert.equal(isLink(join(home, '.agents/skills/ecc-plan')), false);
  assert.equal(existsSync(join(home, '.agents')), false, 'the parents Core created for the link go with it');
  assert.equal(isLink(join(home, '.claude/skills/ecc-plan')), true);
  assert.match(readFileSync(join(home, '.claude/skills/ecc-plan/SKILL.md'), 'utf8'), /Plan the work/);
  const kept = (await list({ target: { project: target }, scope: 'user' })).entries.find(item => item.managementId === PLAN);
  assert.deepEqual([kept.clis, kept.claims.map(claim => claim.cli)], [['claude-code'], ['claude-code']]);

  // Removing it from Claude too removes the link, the shared folder and every folder Core created for them.
  await remove(target, [{ managementId: PLAN, clis: ['claude-code'] }]);
  assert.equal(existsSync(join(home, SHARED)), false);
  assert.deepEqual(homeEntries(), start, 'nothing of the install is left in the home');
  assert.equal((await list({ target: { project: target }, scope: 'user' })).entries.some(item => item.managementId === PLAN), false);
});

test('a CLI not confirmed to load junctions gets a real copy on Windows; the copy goes with its claim', async () => {
  const target = project();
  const start = homeEntries();
  const { prepared } = await install(linkRequest(target, ['antigravity', 'codex']));
  const place = join(home, '.gemini/antigravity/skills/ecc-plan');
  const antigravity = prepared.review.steps.find(step => step.op === 'link' && step.clis[0] === 'antigravity');
  if (process.platform === 'win32') {
    assert.equal(antigravity.linkType, 'copy');
    assert.equal(isLink(place), false, 'never a junction');
    assert.equal(lstatSync(join(place, 'SKILL.md')).isFile(), true);
  } else assert.equal(antigravity.linkType, 'symlink');
  assert.match(readFileSync(join(place, 'notes', 'usage.md'), 'utf8'), /Usage/);
  const listed = (await list({ target: { project: target }, scope: 'user' })).entries.find(item => item.managementId === PLAN);
  if (process.platform === 'win32') assert.deepEqual(listed.members.filter(member => member.linkType === 'copy').map(member => member.clis),
    [['antigravity'], ['antigravity']]);
  await remove(target, [{ managementId: PLAN, clis: ['antigravity'] }]);
  assert.equal(existsSync(join(home, '.gemini')), false);
  assert.equal(isLink(join(home, '.agents/skills/ecc-plan')), true, 'Codex keeps its link');
  await remove(target, [{ managementId: PLAN }]);
  assert.deepEqual(homeEntries(), start);
});

test('a shared place whose CLIs the plan did not record refuses removal by CLI (client-attribution-missing) and is removed for every CLI', async () => {
  const target = project();
  const start = homeEntries();
  await install(linkRequest(target, ['claude-code', 'codex'], { attributed: false }));
  const listed = (await list({ target: { project: target }, scope: 'user' })).entries.find(item => item.managementId === PLAN);
  assert.deepEqual(listed.claims, [{ cli: null, project: realpathSync(target) }]);
  assert.deepEqual(listed.clis, ['claude-code', 'codex'], 'claimed by every CLI the plan was made for');
  // Unrecorded CLIs can't be confirmed to load a junction: the places are copies on Windows.
  if (process.platform === 'win32') assert.equal(isLink(join(home, '.claude/skills/ecc-plan')), false);
  const refused = await prepareRemoval({ target: { project: target }, scope: 'user', removals: [{ managementId: PLAN, clis: ['codex'] }] });
  assert.equal(refused.status, 'refused', JSON.stringify(refused));
  assert.equal(refused.code, 'client-attribution-missing');
  assert.equal(refused.handle, undefined);
  await remove(target, [{ managementId: PLAN }]);
  assert.deepEqual(homeEntries(), start);
});
const canonical = value => JSON.stringify(value);

test('a link points only into a shared version folder, never at Core\'s state or another of your folders', async () => {
  const target = project();
  for (const to of ['.aih', '.ssh', '.gnupg', '.aihq', 'Documents/notes', '.AIHQ/other/x']) {
    const request = linkRequest(target);
    for (const step of request.plan.plan) if (step.op === 'link') step.to = to;
    const result = await prepare(request);
    assert.equal(result.status, 'invalid', `${to}: ${JSON.stringify(result)}`);
    assert.equal(result.handle, undefined);
    assert.ok(result.problems.some(item => item.reason === 'link-target'), `${to}: ${JSON.stringify(result.problems)}`);
  }
  assert.equal(existsSync(join(home, '.claude', 'skills', 'ecc-plan')), false);
});

test('your own folder at a link place is never replaced:Prepare is blocked offering skip only, and a skip places the rest', async () => {
  const target = project();
  const mine = join(home, '.claude', 'skills', 'ecc-plan');
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, 'SKILL.md'), 'mine\n');
  const blocked = await prepare(linkRequest(target));
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
  assert.equal(blocked.handle, undefined);
  const [conflict] = blocked.review.conflicts;
  assert.deepEqual([conflict.reason, conflict.target, conflict.choices], ['existing-content', '.claude/skills/ecc-plan', ['skip']]);
  const skipped = await prepare({ ...linkRequest(target), resolutions: [{ managementId: PLAN, step: conflict.step, choice: 'skip', observedSha256: null }] });
  assert.equal(skipped.status, 'partial', JSON.stringify(skipped));
  const run = await apply(skipped.handle, { ...approve(skipped.review), allowPartial: true });
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  assert.equal(readFileSync(join(mine, 'SKILL.md'), 'utf8'), 'mine\n');
  assert.equal(isLink(join(home, '.agents/skills/ecc-plan')), true);
  await remove(target, [{ managementId: PLAN }]);
  assert.equal(readFileSync(join(mine, 'SKILL.md'), 'utf8'), 'mine\n');
  rmSync(join(home, '.claude'), { recursive: true });
});

test('your own file at a link place is a conflict carrying its exact bytes and their digest', async () => {
  const target = project();
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  const mine = join(home, '.claude', 'skills', 'ecc-plan');
  writeFileSync(mine, 'my own notes\n');
  const blocked = await prepare(linkRequest(target));
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
  const [conflict] = blocked.review.conflicts;
  assert.deepEqual([conflict.reason, conflict.target, conflict.choices, conflict.existing, conflict.redacted],
    ['existing-content', '.claude/skills/ecc-plan', ['skip'], 'my own notes\n', []]);
  assert.equal(conflict.observedSha256, createHash('sha256').update('my own notes\n').digest('hex'));
  assert.equal(validateFormat(blocked.review).status, 'ok');
  rmSync(join(home, '.claude'), { recursive: true });
});

test('a version folder holding a file nothing recorded is not linked, and list shows a planted file as changed', async () => {
  const target = project();
  const to = join(home, '.aihq', 'shared', 'ecc', 'skill', 'plan', '3f9c0a1b2d4e');
  mkdirSync(to, { recursive: true }); writeFileSync(join(to, 'evil.sh'), 'echo hi\n');
  const blocked = await prepare(linkRequest(target, ['claude-code']));
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
  const conflict = blocked.review.conflicts.find(item => item.target === '.aihq/shared/ecc/skill/plan/3f9c0a1b2d4e');
  assert.ok(conflict, JSON.stringify(blocked.review.conflicts));
  assert.match(conflict.detail, /evil\.sh/);
  assert.deepEqual(conflict.choices, ['skip']);
  assert.equal(validateFormat(blocked.review).status, 'ok');
  assert.equal(existsSync(join(home, '.claude', 'skills', 'ecc-plan')), false);
  rmSync(join(to, 'evil.sh'));

  await install(linkRequest(target, ['claude-code']));
  writeFileSync(join(to, 'later.sh'), 'echo hi\n');
  const listed = await list({ target: { project: target }, scope: 'user' });
  const link = listed.entries.find(entry => entry.managementId === PLAN).members.find(member => member.kind === 'link');
  assert.equal(link.state, 'changed-by-you');
  rmSync(join(to, 'later.sh'));
  await remove(target, [{ managementId: PLAN }]);
});

test('files a system or a runtime generates in a version folder never block linking, and list shows them as generated', async () => {
  const target = project();
  const { content, files } = ownContent({ plan: { 'SKILL.md': 'Plan.\n', 'tool.py': 'print(1)\n' } }, { framework: 'ecc', sourceId: 'ecc' });
  const request = linkRequest(target, ['claude-code']);
  const shared = request.plan.plan.find(step => step.op === 'link').to;
  const writes = content.items[0].files.map(file => ({ op: 'write', root: 'user', path: `${shared}/${file.sourcePath.slice('plan/'.length)}`,
    from: { item: content.items[0].id, sourcePath: file.sourcePath }, item: content.items[0].id, clis: ['claude-code'] }));
  request.plan.plan = [...writes.sort((a, b) => a.path < b.path ? -1 : 1), ...request.plan.plan.filter(step => step.op === 'link')];
  request.contents = [content];
  request.files = Object.entries(files).map(([sourcePath, bytes]) => ({ sourceId: 'ecc', sourcePath, sha256: sha256(bytes), bytes }));
  const to = join(home, ...shared.split('/'));
  const generated = ['.DS_Store', 'Thumbs.db', 'desktop.ini', '__pycache__/tool.cpython-313.pyc'];
  mkdirSync(join(to, '__pycache__'), { recursive: true });
  for (const name of generated) writeFileSync(join(to, ...name.split('/')), 'x');
  const prepared = await prepare(request);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.review?.conflicts ?? prepared));
  assert.equal((await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  const state = async () => (await list({ target: { project: target }, scope: 'user' })).entries.find(entry => entry.managementId === PLAN)
    .members.find(member => member.kind === 'link').state;
  // Compiled caches are regenerable and never trusted: the link is placed only after they are gone.
  assert.equal(existsSync(join(to, '__pycache__')), false, 'the version folder\'s compiled caches are removed before linking');
  assert.equal(await state(), 'generated');
  mkdirSync(join(to, '__pycache__'));
  writeFileSync(join(to, '__pycache__', 'tool.cpython-313.pyc'), 'x');
  assert.equal(await state(), 'generated');
  // Placing the link again (here: a second plan linking the same folder for another CLI) clears them again.
  const again = linkRequest(target, ['codex']);
  again.plan.plan = [...request.plan.plan.filter(step => step.op === 'write').map(step => ({ ...step, clis: ['codex'] })),
    ...again.plan.plan.filter(step => step.op === 'link')];
  again.contents = request.contents; again.files = request.files;
  const second = await prepare(again);
  assert.equal(second.status, 'ready', JSON.stringify(second.review?.conflicts ?? second));
  assert.equal((await apply(second.handle, approve(second.review))).completion, 'complete');
  assert.equal(existsSync(join(to, '__pycache__')), false, 're-placing a link clears the caches again');
  mkdirSync(join(to, '__pycache__'));
  // A compiled file for a module nothing recorded is not generated by it: it is yours.
  writeFileSync(join(to, '__pycache__', 'other.cpython-313.pyc'), 'x');
  assert.equal(await state(), 'changed-by-you');
  rmSync(join(to, '__pycache__'), { recursive: true });
  for (const name of generated.slice(0, 3)) rmSync(join(to, name));
  await remove(target, [{ managementId: PLAN }]);
});

test('a large file at a link place is a conflict that shows no bytes', async () => {
  const target = project();
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  writeFileSync(join(home, '.claude', 'skills', 'ecc-plan'), Buffer.alloc(50 * 1024 * 1024, 0x61));
  const blocked = await prepare(linkRequest(target));
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked).slice(0, 2000));
  const [conflict] = blocked.review.conflicts;
  assert.deepEqual([conflict.target, conflict.existing, conflict.observedSha256], ['.claude/skills/ecc-plan', null, null]);
  rmSync(join(home, '.claude'), { recursive: true });
});

test('a link parent swapped for a link to another folder after Prepare is refused, and nothing is placed there', async () => {
  const target = project();
  const prepared = await prepare(linkRequest(target, ['claude-code']));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const outside = join(scratch, `outside-${counter++}`); mkdirSync(outside);
  symlinkSync(outside, join(home, '.claude'), 'junction');
  try {
    const run = await apply(prepared.handle, approve(prepared.review));
    assert.notEqual(run.completion, 'complete', JSON.stringify(run));
    assert.deepEqual(readdirSync(outside), []);
  } finally { rmSync(join(home, '.claude')); }
  rmSync(join(home, '.aihq'), { recursive: true, force: true });
});

// A shared plan step (C48, contract 5 "Shared copies"): its member is claimed by that step's items only. Identical bytes
// another plan wrote for one item alone are that plan's file, never a shared copy.
const NOTICE = 'MIT License\n';
function noticeRequest(where, items, path, { sourceId = 'local-notices', extra = {} } = {}) {
  const bytes = Buffer.from(NOTICE);
  const files = [{ sourceId, sourcePath: 'LICENSE', sha256: sha256(bytes), bytes }];
  const contentItems = items.map(id => ({ id, kind: 'skill', name: id.split('.').at(-1), description: `Fixture item ${id}`, files: [],
    contentSha256: sha256(id), behaviourSha256: sha256(id) }));
  const plan = [{ op: 'write', root: 'project', path, from: { sourceId, sourcePath: 'LICENSE', sha256: sha256(bytes) }, items, clis: ['claude-code'] }];
  for (const [id, text] of Object.entries(extra)) {
    const own = Buffer.from(text); const sourcePath = `${id.split('.').at(-1)}/SKILL.md`;
    contentItems.find(item => item.id === id).files.push({ sourceId, sourcePath, sha256: sha256(own), bytes: own.length, executable: false, role: 'content' });
    files.push({ sourceId, sourcePath, sha256: sha256(own), bytes: own });
    plan.push({ op: 'write', item: id, root: 'project', path: `.claude/skills/${id.split('.').at(-1)}/SKILL.md`, from: { item: id, sourcePath }, clis: ['claude-code'] });
  }
  return { schema: 'urn:aihq:core:plan-request:0.1.0', scope: 'project', target: { project: where },
    plan: { status: 'ok', data: null, plan, missing: [], unavailable: [], clashes: [], duplicates: [], references: [], warnings: [] },
    contents: [{ schema: 'urn:aihq:catalog:content:0.1.0', framework: { id: 'local-notices', name: 'Notices' },
      sources: [{ id: sourceId, kind: 'local', notices: [{ sourcePath: 'LICENSE', sha256: sha256(bytes) }] }], items: contentItems }],
    profiles: [profile('claude-code')], files };
}
const OWN = name => `local-my-skills.skill.${name}`;

test('a shared step never shares a file another plan wrote for one item alone: it is a conflict, and that item still updates', async () => {
  const where = project();
  const license = join(where, '.claude/skills/x/LICENSE');
  await install(ownRequest(where, { x: { LICENSE: NOTICE } }, ['claude-code']));
  const items = ['local-notices.skill.y', 'local-notices.skill.z'];
  const blocked = await prepare(noticeRequest(where, items, '.claude/skills/x/LICENSE', { extra: { [items[0]]: 'Y\n' } }));
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked.review?.steps ?? blocked));
  const [conflict] = blocked.review.conflicts;
  assert.equal(conflict.target, '.claude/skills/x/LICENSE');
  assert.deepEqual([conflict.reason, conflict.choices], ['existing-content', ['adopt', 'skip']], 'identical bytes: adopting it is a choice the review offers');
  const skipped = await prepare({ ...noticeRequest(where, items, '.claude/skills/x/LICENSE', { extra: { [items[0]]: 'Y\n' } }),
    resolutions: [{ managementId: conflict.managementId, step: conflict.step, choice: 'skip', observedSha256: conflict.observedSha256 }] });
  assert.equal(skipped.status, 'partial', JSON.stringify(skipped));
  assert.equal((await apply(skipped.handle, { ...approve(skipped.review), allowPartial: true })).completion, 'complete');

  const update = await prepareUpdate({ target: { project: where }, scope: 'project',
    updates: [{ managementIds: [OWN('x')], request: ownRequest(where, { x: { LICENSE: 'MIT License, 2026\n' } }, ['claude-code']) }] });
  assert.equal(update.status, 'ok', JSON.stringify(update));
  assert.deepEqual(update.review.conflicts, [], 'the other plan holds no claim on it');
  assert.equal((await apply(update.handle, approve(update.review))).completion, 'complete');
  assert.equal(readFileSync(license, 'utf8'), 'MIT License, 2026\n');
});

test('another plan\'s shared step with the same source facts shares the member a shared step wrote', async () => {
  const where = project();
  const path = '.aihq/notices/local-notices/LICENSE';
  await install(noticeRequest(where, ['local-notices.skill.y', 'local-notices.skill.z'], path));
  const second = await install(noticeRequest(where, ['local-notices.skill.v', 'local-notices.skill.w'], path));
  assert.deepEqual(second.run.steps.map(step => step.application), ['already-satisfied', 'already-satisfied']);
  const listed = await list({ target: { project: where }, scope: 'project' });
  assert.deepEqual(listed.entries.map(entry => entry.managementId).sort(),
    ['local-notices.skill.v', 'local-notices.skill.w', 'local-notices.skill.y', 'local-notices.skill.z']);
});
