// Runs inside a disposable consumer with the packed @aihq/core installed; public entries and the `aih` bin only.
// Typed input bindings (contract 4.1, C59, C63). The plan, content and profile documents are Core-side FIXTURES
// (plan-fixture.mjs) in the accepted Catalog shapes; the profiles' `inputReferences` are fixture facts, not evidence of
// any client's environment expansion.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refusalCodes, validateFormat } from '@aihq/core/contracts';
import { apply, list, prepare, prepareRemoval } from '@aihq/core';
import { ENV_REFERENCE, inputProfile, mergeRequest, ownRequest, savedDocument } from './plan-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const approve = (review, extra = {}) => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest, ...extra });
const conforms = value => { assert.deepEqual(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
const project = name => mkdtempSync(join(process.env.HOME, `${name}-`));
function stateText() {
  let text = '';
  const walk = dir => { if (!existsSync(dir)) return; for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'recovery') walk(path); } else text += readFileSync(path, 'utf8');
  } };
  walk(join(process.env.HOME, '.aih', 'core'));
  return text;
}
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };

const GITHUB = 'local-my-setup.mcp.github';
const SECRET = 'ghp_packedinputsSECRETVALUE';
const declared = { [GITHUB]: { GITHUB_HOST: { description: 'Host', isRequired: true, isSecret: false },
  GITHUB_TOKEN: { description: 'Token', isRequired: true, isSecret: true } } };
const merge = { item: GITHUB, file: '.mcp.json', format: 'json', key: '/mcpServers/github',
  entry: { type: 'stdio', command: 'npx', args: ['-y', '@example/github-mcp@1.0.0', '--host', '{GITHUB_HOST}'] },
  inputs: [{ item: GITHUB, input: 'GITHUB_HOST', at: { argv: 4 } }, { item: GITHUB, input: 'GITHUB_TOKEN', at: { pointer: '/env/GITHUB_TOKEN' } }] };
const request = (target, references = {}, merges = [merge]) => ({ ...mergeRequest(target, merges, { inputs: declared,
  profiles: [inputProfile('claude-code', references)] }), inputs: { [GITHUB]: { GITHUB_HOST: 'github.example.com' } } });
const privateInputs = { [GITHUB]: { GITHUB_TOKEN: SECRET } };
const withoutDigest = ({ reviewDigest: _digest, ...review }) => review;

await check('structured and argv binding: the host lands in its argv slot; the token is the client reference where the profile declares one, else its value with the named-file warning', async () => {
  const referenced = project('reference');
  const ready = await prepare(request(referenced, { 'mcp-env': ENV_REFERENCE }));
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  conforms(ready.review);
  assert.deepEqual(ready.review.warnings, []);
  assert.equal(conforms(await apply(ready.handle, approve(ready.review))).completion, 'complete');
  const entry = JSON.parse(readFileSync(join(referenced, '.mcp.json'), 'utf8')).mcpServers.github;
  assert.deepEqual([entry.args[3], entry.env], ['github.example.com', { GITHUB_TOKEN: '${GITHUB_TOKEN}' }]);

  const valued = project('value');
  const blocked = await prepare(request(valued));
  assert.deepEqual([blocked.status, blocked.code, blocked.input], ['refused', 'input-missing', 'GITHUB_TOKEN']);
  const secret = await prepare(request(valued), { privateInputs });
  assert.equal(secret.status, 'ready', JSON.stringify(secret));
  conforms(secret.review);
  assert.match(secret.review.warnings[0], /`\.mcp\.json`: this file will hold a secret/);
  assert.equal(JSON.stringify(secret).includes(SECRET), false);
  const stale = conforms(await apply(secret.handle, approve(secret.review), { privateInputs: { [GITHUB]: { GITHUB_TOKEN: 'other' } } }));
  assert.deepEqual([stale.completion, stale.code, stale.changed], ['rejected', 'REVIEW_STALE', 'input']);
  const again = await prepare(request(valued), { privateInputs });
  assert.equal(conforms(await apply(again.handle, approve(again.review), { privateInputs })).completion, 'complete');
  assert.equal(JSON.parse(readFileSync(join(valued, '.mcp.json'), 'utf8')).mcpServers.github.env.GITHUB_TOKEN, SECRET);
  assert.equal(stateText().includes(SECRET), false, 'no receipt or history holds the secret');
  assert.equal(JSON.stringify(conforms(await list({ target: { project: valued }, scope: 'project' }))).includes(SECRET), false);
  const removal = await prepareRemoval({ target: { project: valued }, scope: 'project', removals: [{ managementId: GITHUB }] });
  assert.equal(conforms(await apply(removal.handle, approve(removal.review))).completion, 'complete');
});

await check('rendered-file placeholders and unmarked inputs: a declared marker takes the value, an input the plan marks nowhere is input-binding-missing', async () => {
  assert.ok(['input-missing', 'input-binding-missing'].every(code => refusalCodes.some(entry => entry.code === code)));
  const target = project('placeholder');
  const built = ownRequest(target, { notes: { 'SKILL.md': '---\nname: notes\n---\nPost to {{TEAM}}.\n' } }, ['claude-code']);
  const item = built.contents[0].items[0];
  item.requirements = { inputs: { TEAM: { description: 'Team', isRequired: true, isSecret: false, placeholder: { sourcePath: 'notes/SKILL.md', marker: '{{TEAM}}' } } } };
  const unmarked = await prepare(built);
  assert.deepEqual([unmarked.status, unmarked.code, unmarked.item, unmarked.input], ['refused', 'input-binding-missing', item.id, 'TEAM']);
  built.plan.plan[0].inputs = [{ item: item.id, input: 'TEAM', at: { placeholder: '{{TEAM}}' } }];
  built.inputs = { [item.id]: { TEAM: 'core-infra' } };
  const ready = await prepare(built);
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  assert.equal(conforms(await apply(ready.handle, approve(ready.review))).completion, 'complete');
  assert.equal(readFileSync(join(target, '.claude/skills/notes/SKILL.md'), 'utf8'), '---\nname: notes\n---\nPost to core-infra.\n');
});

await check('the aih CLI with --private-input gives the API\'s review and file, and refuses a missing secret with input-missing', async () => {
  const cli = join(here, 'node_modules', '@aihq', 'core', 'dist', 'core', 'cli.js');
  const aih = (args, env = {}) => {
    const child = spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    return { code: child.status, result: JSON.parse(child.stdout.trim().split('\n').at(-1)) };
  };
  const viaApi = project('api');
  const api = await prepare(request(viaApi), { privateInputs });
  assert.equal(conforms(await apply(api.handle, approve(api.review), { privateInputs })).completion, 'complete');
  const target = project('cli');
  const folder = mkdtempSync(join(process.env.HOME, 'requests-'));
  const document = join(folder, 'plan-request.json');
  writeFileSync(document, JSON.stringify(savedDocument(request(target))));
  const missing = aih(['install', document, '--json']);
  assert.deepEqual([missing.code, missing.result.code, missing.result.input], [2, 'input-missing', 'GITHUB_TOKEN']);
  const mapping = `${GITHUB}.GITHUB_TOKEN=AIH_TEST_GITHUB_TOKEN`;
  const env = { AIH_TEST_GITHUB_TOKEN: SECRET };
  const preview = aih(['install', document, '--private-input', mapping, '--json'], env);
  assert.deepEqual([preview.code, preview.result.status], [0, 'ready'], JSON.stringify(preview));
  const normalize = review => JSON.parse(JSON.stringify(withoutDigest(review)).replaceAll(JSON.stringify(target).slice(1, -1), '<project>')
    .replaceAll(JSON.stringify(viaApi).slice(1, -1), '<project>'));
  assert.deepEqual(normalize(preview.result.review), normalize(api.review), 'the CLI and the API present the same review');
  assert.equal(JSON.stringify(preview).includes(SECRET), false);
  const unset = aih(['install', document, '--private-input', `${GITHUB}.GITHUB_TOKEN=AIH_TEST_UNSET_VARIABLE`, '--json']);
  assert.deepEqual([unset.code, unset.result.code], [2, 'usage']);
  const installed = aih(['install', document, '--private-input', mapping, '--apply', '--yes', '--json'], env);
  assert.deepEqual([installed.code, installed.result.completion], [0, 'complete'], JSON.stringify(installed));
  assert.equal(readFileSync(join(target, '.mcp.json'), 'utf8'), readFileSync(join(viaApi, '.mcp.json'), 'utf8'));
  assert.equal(stateText().includes(SECRET), false);
  const removed = aih(['remove', GITHUB, '--scope', 'project', '--project', target, '--apply', '--yes', '--json']);
  assert.deepEqual([removed.code, removed.result.completion], [0, 'complete'], JSON.stringify(removed));
});

console.log(JSON.stringify({ status: 'passed', checks }));
