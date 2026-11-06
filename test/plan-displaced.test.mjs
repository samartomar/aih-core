// Displaced claims (contract 8.1 "Two plans on one place", C61, C64, C75; 18 journey 14): a reviewed replace of a value
// other plans share, honest displaced-by reporting, one level of restore and the second-displacement block, through the
// built public entries in a disposable home and projects. Producer documents are Core-side fixtures
// (test/fixtures/plan-fixture.mjs), not Catalog output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, list, prepare, prepareRemoval } from '../dist/core/index.js';
import { inputProfile, mergeRequest, sha256 } from './fixtures/plan-fixture.mjs';
import { readReceipt, writeReceipt } from './fixtures/ownership-receipt.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'aih-displaced-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let home;
before(() => { home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true }); });

/** Each test starts in its own disposable home, with no receipts from the tests before it. */
const freshHome = () => { home = mkdtempSync(join(scratch, 'home-')); process.env.HOME = home; process.env.USERPROFILE = home; };
const approve = (review, extra = {}) => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest, ...extra });
let counter = 0;
const project = () => { const path = join(scratch, `project-${counter++}`); mkdirSync(path); return path; };
const config = () => join(home, '.codex', 'config.toml');
const SHARED = 'local-team.mcp.github';
const OVERRIDE = 'local-mine.mcp.github';
const OTHER = 'local-other.mcp.github';
const server = (item, command) => ({ item, root: 'user', file: '.codex/config.toml', format: 'toml', key: 'mcp_servers.github',
  entry: { command, args: ['-y', '@example/github-mcp'] }, clis: ['codex'] });
const request = (target, item, command, resolutions) => ({ ...mergeRequest(target, [server(item, command)], { scope: 'user' }),
  ...(resolutions ? { resolutions } : {}) });
async function install(target, item, command) {
  const prepared = await prepare(request(target, item, command));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const run = await apply(prepared.handle, approve(prepared.review));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
}
/** Prepare an install that replaces what is there, with the person's reviewed choice; returns the ready result. */
async function replacing(target, item, command, build = request) {
  const blocked = await prepare(build(target, item, command));
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
  const [conflict] = blocked.review.conflicts;
  const ready = await prepare(build(target, item, command, [{ managementId: item, step: conflict.step, choice: 'replace', observedSha256: conflict.observedSha256 }]));
  return { blocked, conflict, ready };
}
async function remove(target, managementId, controls) {
  const removal = await prepareRemoval({ target: { project: target }, scope: 'user', removals: [{ managementId }] }, controls);
  assert.equal(removal.status, 'ok', JSON.stringify(removal));
  const run = await apply(removal.handle, approve(removal.review));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  return removal;
}
const entryOf = async (target, managementId) => (await list({ target: { project: target }, scope: 'user' })).entries.find(entry => entry.managementId === managementId);

test('C replaces the value A and B share after review: A and B read displaced-by C, removing A changes nothing, removing C restores A and B, removing B restores your original', async () => {
  const mine = 'model = "o5"\n\n[mcp_servers.github]\ncommand = "my-github"\nargs = ["mine"]\n';
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(config(), mine);
  const a = project(), b = project(), c = project();
  // A replaces your own table (your bytes are kept for restore); B shares A's identical value.
  const first = await replacing(a, SHARED, 'npx');
  assert.equal(first.ready.status, 'ready', JSON.stringify(first.ready));
  assert.equal((await apply(first.ready.handle, approve(first.ready.review))).completion, 'complete');
  await install(b, SHARED, 'npx');
  const shared = readFileSync(config(), 'utf8');

  const { conflict, ready } = await replacing(c, OVERRIDE, 'my-npx');
  assert.deepEqual([conflict.reason, conflict.choices], ['existing-content', ['replace', 'skip']], JSON.stringify(conflict));
  assert.deepEqual(conflict.displaces, [SHARED], 'the conflict names the installs a replace displaces');
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  const step = ready.review.steps[0];
  assert.deepEqual(step.displaces, [SHARED]);
  assert.match(step.sentence, /displacing `local-team\.mcp\.github`/);
  assert.equal((await apply(ready.handle, approve(ready.review))).completion, 'complete');
  const overridden = readFileSync(config(), 'utf8');
  assert.match(overridden, /command = "my-npx"/);

  const displaced = await entryOf(a, SHARED);
  assert.ok(displaced, 'a displaced install is still listed');
  assert.deepEqual(displaced.claims.map(claim => claim.project).sort(), [realpathSync(a), realpathSync(b)].sort());
  assert.deepEqual(displaced.members.map(member => [member.pointer, member.state, member.displacedBy]),
    [['/mcp_servers/github/args', 'displaced-by', [OVERRIDE]], ['/mcp_servers/github/command', 'displaced-by', [OVERRIDE]]]);
  assert.deepEqual((await entryOf(c, OVERRIDE)).members.map(member => member.state), ['matching', 'matching']);

  // Removing A drops only its claim; the file keeps C's value.
  const removedA = await remove(a, SHARED);
  assert.deepEqual(removedA.entries[0].members.map(member => [member.action, member.reason]), [['keep-shared', 'displaced'], ['keep-shared', 'displaced']]);
  assert.equal(readFileSync(config(), 'utf8'), overridden);
  assert.deepEqual((await entryOf(b, SHARED)).claims.map(claim => claim.project), [realpathSync(b)]);

  // Removing C writes the shared value back, and B's claim matches again.
  const removedC = await remove(c, OVERRIDE);
  assert.deepEqual(removedC.entries[0].members.map(member => member.action), ['restore', 'restore']);
  assert.equal(readFileSync(config(), 'utf8'), shared);
  assert.deepEqual((await entryOf(b, SHARED)).members.map(member => member.state), ['matching', 'matching']);
  // Removing B, the last claim, restores your original bytes.
  await remove(b, SHARED);
  assert.equal(readFileSync(config(), 'utf8'), mine);
  assert.equal((await list({ target: { project: b }, scope: 'user' })).entries.length, 0);
});

test('a different D over C, while C displaces A, is blocked with no handle and names the fix; identical sharing and C\'s own update stay allowed; after removing C, D prepares fresh', async () => {
  freshHome();
  const a = project(), c = project(), d = project();
  await install(a, SHARED, 'npx');
  const override = await replacing(c, OVERRIDE, 'my-npx');
  assert.equal((await apply(override.ready.handle, approve(override.ready.review))).completion, 'complete');

  const before = readFileSync(config(), 'utf8');
  const second = await prepare(request(d, OTHER, 'other-npx'));
  assert.equal(second.status, 'blocked', JSON.stringify(second));
  assert.equal(second.handle, undefined);
  const [conflict] = second.review.conflicts;
  assert.deepEqual([conflict.reason, conflict.choices, conflict.displacedBy, conflict.displaced],
    ['second-displacement', [], [OVERRIDE], [SHARED]], JSON.stringify(conflict));
  assert.match(conflict.fix, /Remove `local-mine\.mcp\.github` through a reviewed removal first, which gives `local-team\.mcp\.github` their value back, then prepare this install again/);
  // A resolution naming the observed bytes doesn't get past the block either.
  const forced = await prepare(request(d, OTHER, 'other-npx', [{ managementId: OTHER, step: 0, choice: 'replace', observedSha256: conflict.observedSha256 }]));
  assert.deepEqual([forced.status, forced.handle, forced.review.conflicts[0].reason], ['blocked', undefined, 'second-displacement']);
  assert.equal(readFileSync(config(), 'utf8'), before);

  // C's own update changes its value and keeps one level: A is still displaced, now by the updated value.
  const updated = await prepare(request(c, OVERRIDE, 'my-npx-2'));
  assert.equal(updated.status, 'ready', JSON.stringify(updated));
  assert.equal((await apply(updated.handle, approve(updated.review))).completion, 'complete');
  assert.match(readFileSync(config(), 'utf8'), /command = "my-npx-2"/);
  assert.deepEqual((await entryOf(a, SHARED)).members.map(member => member.state), ['displaced-by', 'displaced-by']);

  // Removing C through review restores A; D then prepares fresh, offering the replace that displaces A.
  await remove(c, OVERRIDE);
  assert.match(readFileSync(config(), 'utf8'), /command = "npx"/);
  const fresh = await replacing(d, OTHER, 'other-npx');
  assert.deepEqual([fresh.conflict.reason, fresh.conflict.displaces, fresh.ready.status], ['existing-content', [SHARED], 'ready']);
  fresh.ready.handle && await apply(fresh.ready.handle, approve(fresh.ready.review));
  await remove(d, OTHER); await remove(a, SHARED);
  assert.equal(existsSync(config()) && /mcp_servers/.test(readFileSync(config(), 'utf8')), false);
});

test('your later edits are never taken for a displacement: an edited shared value is not displaced, and an edited override stays when it is removed', async () => {
  freshHome();
  const a = project(), c = project();
  await install(a, SHARED, 'npx');
  const edited = readFileSync(config(), 'utf8').replace('"npx"', '"npx-edited"');
  writeFileSync(config(), edited);
  const blocked = await prepare(request(c, OVERRIDE, 'my-npx', [{ managementId: OVERRIDE, step: 0, choice: 'replace', observedSha256: sha256(edited) }]));
  assert.notEqual(blocked.status, 'ready', JSON.stringify(blocked));
  assert.deepEqual([blocked.review.conflicts[0].reason, blocked.review.conflicts[0].choices], ['managed-content-changed', []]);
  if (blocked.handle) await apply(blocked.handle, approve(blocked.review, { allowPartial: true }));
  assert.equal(readFileSync(config(), 'utf8'), edited, 'your edit is not overwritten');

  // Put A's value back, let C displace it, then edit C's value: removing C keeps your edit, and A stays displaced.
  writeFileSync(config(), edited.replace('"npx-edited"', '"npx"'));
  const override = await replacing(c, OVERRIDE, 'my-npx');
  assert.equal((await apply(override.ready.handle, approve(override.ready.review))).completion, 'complete');
  const mine = readFileSync(config(), 'utf8').replace('"my-npx"', '"my-own"');
  writeFileSync(config(), mine);
  const removal = await prepareRemoval({ target: { project: c }, scope: 'user', removals: [{ managementId: OVERRIDE }] });
  assert.ok(removal.entries[0].members.some(member => member.action === 'keep-changed'), JSON.stringify(removal.entries));
  if (removal.handle) await apply(removal.handle, approve(removal.review, { allowPartial: true }));
  assert.equal(readFileSync(config(), 'utf8'), mine);
  // Member by member: your edited command stays C's and A's claim on it stays displaced; the unchanged args go back to A.
  const states = Object.fromEntries((await entryOf(a, SHARED)).members.map(member => [member.pointer, member.state]));
  assert.deepEqual(states, { '/mcp_servers/github/args': 'matching', '/mcp_servers/github/command': 'displaced-by' });
});

test('the restored holder keeps its own owner facts: what the overriding install created is not for the holder to delete', async () => {
  freshHome();
  // Your own settings file: the holder adds its entry to it, it does not create the file.
  const file = join(home, '.claude.json');
  writeFileSync(file, '{}');
  const jsonServer = (item, command) => ({ item, root: 'user', file: '.claude.json', format: 'json', key: '/mcpServers/github',
    entry: { command, args: ['-y', '@example/github-mcp'] }, clis: ['claude-code'] });
  const build = (target, item, command, resolutions) => ({ ...mergeRequest(target, [jsonServer(item, command)], { scope: 'user' }),
    ...(resolutions ? { resolutions } : {}) });
  const a = project(), c = project();
  const installed = await prepare(build(a, SHARED, 'npx'));
  assert.equal(installed.status, 'ready', JSON.stringify(installed));
  assert.equal((await apply(installed.handle, approve(installed.review))).completion, 'complete');
  const override = await replacing(c, OVERRIDE, 'my-npx', build);
  assert.equal(override.ready.status, 'ready', JSON.stringify(override.ready));
  assert.equal((await apply(override.ready.handle, approve(override.ready.review))).completion, 'complete');
  // The overriding install's member records that it created the file (as when it is the one that wrote it first).
  const receipt = join(home, '.aih', 'core', 'ownership', `${sha256(realpathSync(home))}.json`);
  const record = readReceipt(receipt);
  const overriding = Object.values(record.members).filter(member => member.displaced);
  assert.equal(overriding.length, 1, 'the overriding member displaces the holder');
  for (const member of overriding) member.createdFile = true;
  writeReceipt(receipt, record);
  // Removing the overrider gives the holder its value back, with the holder's own facts, not the overrider's.
  await remove(c, OVERRIDE);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).mcpServers.github.command, 'npx');
  // Removing the holder then takes away only its entry: your file stays.
  await remove(a, SHARED);
  assert.equal(existsSync(file), true, 'the holder never created the file, so its removal keeps it');
});

const SECRET = 'ghp_displacedSECRET0123456789';
const tokenInputs = { [SHARED]: { GITHUB_TOKEN: { description: 'Token', isRequired: true, isSecret: true } } };
const secretRequest = target => mergeRequest(target, [{ ...server(SHARED, 'npx'),
  inputs: [{ item: SHARED, input: 'GITHUB_TOKEN', at: { pointer: '/env/GITHUB_TOKEN' } }] }],
  { scope: 'user', inputs: tokenInputs, profiles: [inputProfile('codex')] });
const withSecret = (value = SECRET) => ({ privateInputs: { [SHARED]: { GITHUB_TOKEN: value } } });
/** Every byte Core keeps in its state (receipts, history), except its protected recovery material. */
function stateText() {
  let text = '';
  const walk = dir => { if (!existsSync(dir)) return; for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'recovery') walk(path); } else text += readFileSync(path, 'utf8');
  } };
  walk(join(home, '.aih', 'core'));
  return text;
}

test('a displaced value holding a secret written by value keeps no secret in receipts; writing it back asks for the secret again (input-missing) and restores the exact bytes', async () => {
  freshHome();
  const a = project(), b = project(), c = project();
  for (const target of [a, b]) {
    const prepared = await prepare(secretRequest(target), withSecret());
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
    assert.equal((await apply(prepared.handle, approve(prepared.review), withSecret())).completion, 'complete');
  }
  const shared = readFileSync(config(), 'utf8');
  assert.match(shared, new RegExp(SECRET));
  // C names every key of the table, the token slot too, with its own plain value.
  const withEnv = (target, item, command, resolutions) => ({ ...mergeRequest(target, [{ ...server(item, command),
    entry: { command, args: ['-y', '@example/github-mcp'], env: { GITHUB_TOKEN: 'not-a-secret' } } }], { scope: 'user' }), ...(resolutions ? { resolutions } : {}) });
  const override = await replacing(c, OVERRIDE, 'my-npx', withEnv);
  assert.deepEqual(override.conflict.displaces, [SHARED], JSON.stringify(override.conflict));
  assert.equal(override.ready.status, 'ready', JSON.stringify(override.ready));
  assert.equal(JSON.stringify(override.ready.review).includes(SECRET), false);
  assert.equal((await apply(override.ready.handle, approve(override.ready.review))).completion, 'complete');
  assert.equal(readFileSync(config(), 'utf8').includes(SECRET), false, 'C replaced the whole table');
  assert.equal(stateText().includes(SECRET), false, 'the displaced value is kept without its secret');

  // Removing A needs nothing: the disk doesn't change.
  await remove(a, SHARED);
  // Removing C writes B's value back, so it needs the secret again.
  const missing = await prepareRemoval({ target: { project: c }, scope: 'user', removals: [{ managementId: OVERRIDE }] });
  assert.deepEqual([missing.status, missing.code, missing.item, missing.input, missing.handle], ['refused', 'input-missing', SHARED, 'GITHUB_TOKEN', undefined], JSON.stringify(missing));
  const removal = await prepareRemoval({ target: { project: c }, scope: 'user', removals: [{ managementId: OVERRIDE }] }, withSecret());
  assert.equal(removal.status, 'ok', JSON.stringify(removal));
  assert.equal(JSON.stringify(removal).includes(SECRET), false, 'the removal review never shows the secret');
  assert.equal((await apply(removal.handle, approve(removal.review), withSecret())).completion, 'complete');
  assert.equal(readFileSync(config(), 'utf8'), shared, 'the shared value comes back byte for byte');
  assert.equal(stateText().includes(SECRET), false);
  assert.deepEqual((await entryOf(b, SHARED)).members.map(member => member.state), ['matching', 'matching', 'matching']);
  await remove(b, SHARED);
});

test('competing applies on one root are serialized: the later one, prepared before the first changed the value, is rejected stale and overwrites nothing', async () => {
  freshHome();
  const a = project(), c = project(), d = project();
  await install(a, SHARED, 'npx');
  const first = await replacing(c, OVERRIDE, 'my-npx');
  const second = await replacing(d, OTHER, 'other-npx');
  assert.deepEqual([first.ready.status, second.ready.status], ['ready', 'ready']);
  const runs = await Promise.all([apply(first.ready.handle, approve(first.ready.review)), apply(second.ready.handle, approve(second.ready.review))]);
  const completions = runs.map(run => run.completion).sort();
  assert.deepEqual(completions, ['complete', 'rejected'], JSON.stringify(runs));
  const rejected = runs.find(run => run.completion === 'rejected');
  assert.equal(rejected.code, 'REVIEW_STALE', JSON.stringify(rejected));
  const winner = runs[0].completion === 'complete' ? 'my-npx' : 'other-npx';
  assert.match(readFileSync(config(), 'utf8'), new RegExp(`command = "${winner}"`));
  // Only one level was recorded: A is displaced by the winner alone.
  assert.deepEqual((await entryOf(a, SHARED)).members.map(member => member.displacedBy),
    [[winner === 'my-npx' ? OVERRIDE : OTHER], [winner === 'my-npx' ? OVERRIDE : OTHER]]);
});
