// Runs inside a disposable consumer with the packed @aihq/core installed; public entries and the `aih` bin only.
// Displaced claims and one level of restore (contract 8.1 "Two plans on one place", C61, C64, C75; journey 14). The plan,
// content and profile documents are Core-side FIXTURES (plan-fixture.mjs) in the accepted Catalog shapes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFormat } from '@aihq/core/contracts';
import { apply, list, prepare, prepareRemoval } from '@aihq/core';
import { inputProfile, mergeRequest } from './plan-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const home = process.env.HOME;
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const conforms = value => { assert.deepEqual(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
const project = name => mkdtempSync(join(home, `${name}-`));
const cli = join(here, 'node_modules', '@aihq', 'core', 'dist', 'core', 'cli.js');
const aih = (args, env = {}) => {
  const child = spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { code: child.status, result: JSON.parse(child.stdout.trim().split('\n').at(-1)) };
};
const config = join(home, '.codex', 'config.toml');
const SHARED = 'local-team.mcp.github', OVERRIDE = 'local-mine.mcp.github', OTHER = 'local-other.mcp.github';
const SECRET = 'ghp_packedDisplacedSECRET42';
const inputs = { [SHARED]: { GITHUB_TOKEN: { description: 'Token', isRequired: true, isSecret: true } } };
const server = (item, command, extra = {}) => ({ item, root: 'user', file: '.codex/config.toml', format: 'toml', key: 'mcp_servers.github',
  entry: { command, args: ['-y', '@example/github-mcp'] }, clis: ['codex'], ...extra });
const sharedRequest = target => mergeRequest(target, [server(SHARED, 'npx', { inputs: [{ item: SHARED, input: 'GITHUB_TOKEN', at: { pointer: '/env/GITHUB_TOKEN' } }] })],
  { scope: 'user', inputs, profiles: [inputProfile('codex')] });
// Every other install names each key of the table, the token slot too, with a plain value.
const plain = (target, item, command, resolutions) => ({ ...mergeRequest(target, [server(item, command, { entry: { command, args: ['-y', '@example/github-mcp'],
  env: { GITHUB_TOKEN: 'not-a-secret' } } })], { scope: 'user' }), ...(resolutions ? { resolutions } : {}) });
const secret = { privateInputs: { [SHARED]: { GITHUB_TOKEN: SECRET } } };
const entryOf = async (target, managementId) => conforms(await list({ target: { project: target }, scope: 'user' })).entries.find(entry => entry.managementId === managementId);
function stateText() {
  let text = '';
  const walk = dir => { if (!existsSync(dir)) return; for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'recovery') walk(path); } else text += readFileSync(path, 'utf8');
  } };
  walk(join(home, '.aih', 'core'));
  return text;
}
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };

const mine = 'model = "o5"\n\n[mcp_servers.github]\ncommand = "my-github"\nargs = ["mine"]\n';
mkdirSync(join(home, '.codex'), { recursive: true });
writeFileSync(config, mine);
const a = project('a'), b = project('b'), c = project('c'), d = project('d');
let shared;

await check('A replaces your table after review and B shares it; C replaces the shared value and A and B read displaced-by C', async () => {
  const blocked = await prepare(sharedRequest(a), secret);
  conforms(blocked.review);
  assert.equal(blocked.status, 'blocked', JSON.stringify(blocked));
  const [own] = blocked.review.conflicts;
  const ready = await prepare({ ...sharedRequest(a), resolutions: [{ managementId: SHARED, step: 0, choice: 'replace', observedSha256: own.observedSha256 }] }, secret);
  assert.equal(conforms(await apply(ready.handle, approve(ready.review), secret)).completion, 'complete');
  const second = await prepare(sharedRequest(b), secret);
  assert.equal(second.status, 'ready', JSON.stringify(second));
  assert.equal((await apply(second.handle, approve(second.review), secret)).completion, 'complete');
  shared = readFileSync(config, 'utf8');

  const conflicted = await prepare(plain(c, OVERRIDE, 'my-npx'));
  conforms(conflicted.review);
  const [conflict] = conflicted.review.conflicts;
  assert.deepEqual([conflicted.status, conflict.choices, conflict.displaces], ['blocked', ['replace', 'skip'], [SHARED]]);
  const override = await prepare(plain(c, OVERRIDE, 'my-npx', [{ managementId: OVERRIDE, step: 0, choice: 'replace', observedSha256: conflict.observedSha256 }]));
  assert.equal(override.status, 'ready', JSON.stringify(override));
  assert.deepEqual(conforms(override.review).steps[0].displaces, [SHARED]);
  assert.equal((await apply(override.handle, approve(override.review))).completion, 'complete');
  assert.match(readFileSync(config, 'utf8'), /command = "my-npx"/);
  assert.ok((await entryOf(a, SHARED)).members.every(member => member.state === 'displaced-by' && member.displacedBy[0] === OVERRIDE));
  assert.equal(stateText().includes(SECRET), false, 'receipts keep the displaced value without its secret');
});

await check('a different D is blocked as a second displacement with no handle; aih install names the fix', async () => {
  const blocked = await prepare(plain(d, OTHER, 'other-npx'));
  conforms(blocked.review);
  assert.deepEqual([blocked.status, blocked.handle, blocked.review.conflicts[0].reason, blocked.review.conflicts[0].displacedBy],
    ['blocked', undefined, 'second-displacement', [OVERRIDE]]);
  const request = join(d, 'request.json');
  writeFileSync(request, JSON.stringify(plain(d, OTHER, 'other-npx')));
  const shown = aih(['install', request, '--json']);
  assert.notEqual(shown.code, 0);
  assert.equal(shown.result.review?.conflicts?.[0]?.reason ?? shown.result.conflicts?.[0]?.reason, 'second-displacement', JSON.stringify(shown.result));
});

await check('removing A changes nothing on disk; aih remove of C without the secret is input-missing, with --private-input it restores B byte for byte', async () => {
  const before = readFileSync(config, 'utf8');
  const removal = await prepareRemoval({ target: { project: a }, scope: 'user', removals: [{ managementId: SHARED }] });
  assert.equal((await apply(removal.handle, approve(removal.review))).completion, 'complete');
  assert.equal(readFileSync(config, 'utf8'), before);
  const missing = aih(['remove', OVERRIDE, '--scope', 'user', '--project', c, '--json']);
  assert.deepEqual([missing.result.status, missing.result.code, missing.result.item, missing.result.input], ['refused', 'input-missing', SHARED, 'GITHUB_TOKEN'], JSON.stringify(missing.result));
  const restored = aih(['remove', OVERRIDE, '--scope', 'user', '--project', c, '--private-input', `${SHARED}.GITHUB_TOKEN=AIH_TOKEN`, '--apply', '--yes', '--json'], { AIH_TOKEN: SECRET });
  assert.equal(restored.code, 0, JSON.stringify(restored.result));
  assert.equal(readFileSync(config, 'utf8'), shared);
  assert.ok((await entryOf(b, SHARED)).members.every(member => member.state === 'matching'));
});

await check('removing B, the last claim, restores your original bytes; D then prepares fresh', async () => {
  const removal = await prepareRemoval({ target: { project: b }, scope: 'user', removals: [{ managementId: SHARED }] });
  assert.equal((await apply(removal.handle, approve(removal.review))).completion, 'complete');
  assert.equal(readFileSync(config, 'utf8'), mine);
  const fresh = await prepare(plain(d, OTHER, 'other-npx'));
  assert.deepEqual([fresh.status, fresh.review.conflicts[0].reason, fresh.review.conflicts[0].displaces], ['blocked', 'existing-content', undefined]);
});

console.log(JSON.stringify({ status: 'passed', checks }));
