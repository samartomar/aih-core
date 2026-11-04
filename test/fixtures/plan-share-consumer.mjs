// Runs inside a disposable consumer with the packed @aihq/core installed; public entries and the `aih` bin only.
// Shared managed content across projects and CLIs (contract 5, 8.1 `link`, 12, journeys 2 and 3). The plan, content and
// profile documents are Core-side FIXTURES (plan-fixture.mjs) in the accepted Catalog shapes; the links made here show
// Core's placement only, never that a real client loads them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFormat } from '@aihq/core/contracts';
import { apply, list, prepare, prepareRemoval } from '@aihq/core';
import { linkRequest, mergeRequest } from './plan-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const home = process.env.HOME;
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const conforms = value => { assert.deepEqual(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
const project = name => mkdtempSync(join(home, `${name}-`));
const isLink = path => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
const cli = join(here, 'node_modules', '@aihq', 'core', 'dist', 'core', 'cli.js');
const aih = args => {
  const child = spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { code: child.status, result: JSON.parse(child.stdout.trim().split('\n').at(-1)) };
};
async function install(request) {
  const prepared = await prepare(request);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  conforms(prepared.review);
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  return prepared;
}
async function remove(target, removals) {
  const removal = await prepareRemoval({ target: { project: target }, scope: 'user', removals });
  assert.equal(removal.status, 'ok', JSON.stringify(removal));
  const run = conforms(await apply(removal.handle, approve(removal.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
}
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };
const PLAN = 'ecc.skill.plan';
const SHARED = join(home, '.aihq', 'shared', 'ecc', 'skill', 'plan', '3f9c0a1b2d4e');

await check('ECC plan on Claude and Codex: one shared copy, a link per CLI, aih remove --cli codex keeps Claude, the last claim removes the folder', async () => {
  const target = project('ecc');
  const prepared = await install(linkRequest(target));
  const expected = process.platform === 'win32' ? 'junction' : 'symlink';
  assert.deepEqual(prepared.review.steps.filter(step => step.op === 'link').map(step => step.linkType), [expected, expected]);
  for (const place of ['.claude/skills/ecc-plan', '.agents/skills/ecc-plan']) {
    assert.equal(isLink(join(home, place)), true, place);
    assert.equal(realpathSync(join(home, place)), realpathSync(SHARED));
  }
  const inventory = conforms(await list({ target: { project: target }, scope: 'user' }));
  const entry = inventory.entries.find(item => item.managementId === PLAN);
  assert.deepEqual(entry.claims.map(claim => claim.cli), ['claude-code', 'codex']);
  assert.ok(entry.members.filter(member => member.kind === 'link').every(member => member.linkType === expected && member.state === 'matching'));
  const codex = aih(['remove', PLAN, '--scope', 'user', '--project', target, '--cli', 'codex', '--apply', '--yes', '--json']);
  assert.deepEqual([codex.code, codex.result.completion], [0, 'complete'], JSON.stringify(codex));
  assert.equal(existsSync(join(home, '.agents')), false);
  assert.equal(isLink(join(home, '.claude/skills/ecc-plan')), true);
  assert.match(readFileSync(join(home, '.claude/skills/ecc-plan/SKILL.md'), 'utf8'), /Plan the work/);
  await remove(target, [{ managementId: PLAN, clis: ['claude-code'] }]);
  assert.equal(existsSync(join(home, '.aihq')), false, 'the shared folder and its link records go with the last claim');
  assert.equal(existsSync(join(home, '.claude')), false);
});

await check('without recorded CLIs, aih remove --cli is refused client-attribution-missing and removal for every CLI passes', async () => {
  const target = project('unattributed');
  await install(linkRequest(target, ['claude-code', 'codex'], { attributed: false }));
  const refused = aih(['remove', PLAN, '--scope', 'user', '--project', target, '--cli', 'codex', '--json']);
  assert.deepEqual([refused.code, refused.result.status, refused.result.code], [2, 'refused', 'client-attribution-missing'], JSON.stringify(refused));
  await remove(target, [{ managementId: PLAN }]);
  assert.equal(existsSync(join(home, '.aihq')), false);
});

await check('two projects claim one user-scope [mcp_servers.github]: removing one keeps it, removing the second removes it', async () => {
  const one = project('one'), two = project('two');
  const merge = { item: 'local-my-setup.mcp.github', root: 'user', file: '.codex/config.toml', format: 'toml', key: 'mcp_servers.github',
    entry: { command: 'npx', args: ['-y', '@example/github-mcp'] }, clis: ['codex'] };
  await install(mergeRequest(one, [merge], { scope: 'user' }));
  await install(mergeRequest(two, [merge], { scope: 'user' }));
  const config = join(home, '.codex', 'config.toml');
  const entry = conforms(await list({ target: { project: two }, scope: 'user' })).entries.find(item => item.managementId === merge.item);
  assert.deepEqual(entry.claims.map(claim => claim.project).sort(), [realpathSync(one), realpathSync(two)].sort());
  await remove(one, [{ managementId: merge.item }]);
  assert.match(readFileSync(config, 'utf8'), /\[mcp_servers\.github\]/);
  await remove(two, [{ managementId: merge.item }]);
  assert.doesNotMatch(readFileSync(config, 'utf8'), /mcp_servers/);
  assert.equal(readdirSync(home).includes('.aihq'), false);
});

console.log(JSON.stringify({ status: 'passed', checks }));
