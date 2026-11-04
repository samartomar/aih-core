// Runs inside a disposable consumer with the packed @aihq/core installed; public entries and the `aih` bin only.
// Plan `merge` steps with reviewed conflict choices (contract 7, 8.1, 14). The plan, content and profile documents are
// Core-side FIXTURES (plan-fixture.mjs) in the accepted Catalog shapes; they establish Core behaviour, not Catalog or
// client compatibility.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refusalCodes, validateFormat } from '@aihq/core/contracts';
import { apply, list, prepare, prepareRemoval } from '@aihq/core';
import { ENV_REFERENCE, inputProfile, mergeRequest as fixtureMergeRequest, savedDocument, sha256 } from './plan-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const approve = (review, extra = {}) => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest, ...extra });
const conforms = value => { assert.deepEqual(validateFormat(value).status, 'ok', JSON.stringify(validateFormat(value))); return value; };
function project(name, files = {}) {
  const path = mkdtempSync(join(process.env.HOME, `${name}-`));
  for (const [file, text] of Object.entries(files)) { mkdirSync(dirname(join(path, file)), { recursive: true }); writeFileSync(join(path, file), text); }
  return path;
}
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
const SECRET = 'ghp_packedconsumerSECRET';
const MINE = '{\n  "mcpServers": {\n    "github": { "command": "my-github", "env": { "GITHUB_TOKEN": "' + SECRET + '" } },\n    "other": {"command":"keep-me"}\n  }\n}\n';
const merge = { item: GITHUB, file: '.mcp.json', format: 'json', key: '/mcpServers/github',
  entry: { command: 'npx', args: ['-y', '@example/github-mcp'] },
  inputs: [{ item: GITHUB, input: 'GITHUB_TOKEN', at: { pointer: '/env/GITHUB_TOKEN' } }] };
const inputs = { [GITHUB]: { GITHUB_TOKEN: { description: 'Token', isRequired: true, isSecret: true } } };
// The fixture profile declares Claude's `${NAME}` reference for MCP environment values, so the token is written as one.
const mergeRequest = (target, merges, options = {}) => fixtureMergeRequest(target, merges,
  merges.some(item => item.inputs) ? { ...options, profiles: [inputProfile('claude-code', { 'mcp-env': ENV_REFERENCE })] } : options);
const written = { ...merge.entry, env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } };

await check('your own .mcp.json entry: blocked with its redacted exact bytes, replace through a second Prepare, an edit before Apply rejects it, removal writes your bytes back', async () => {
  const target = project('mcp', { '.mcp.json': MINE });
  const blocked = await prepare(mergeRequest(target, [merge], { inputs }));
  assert.deepEqual([blocked.status, blocked.handle], ['blocked', undefined], JSON.stringify(blocked));
  conforms(blocked.review);
  const [conflict] = blocked.review.conflicts;
  assert.deepEqual([conflict.reason, conflict.observedSha256, conflict.choices, conflict.redacted],
    ['existing-content', sha256(MINE), ['replace', 'skip'], ['/mcpServers/github/env/GITHUB_TOKEN']]);
  assert.match(conflict.existing, /my-github/);
  assert.equal(JSON.stringify(blocked).includes(SECRET), false);
  const resolutions = [{ managementId: GITHUB, step: conflict.step, choice: 'replace', observedSha256: conflict.observedSha256 }];
  const first = await prepare({ ...mergeRequest(target, [merge], { inputs }), resolutions });
  assert.equal(first.status, 'ready', JSON.stringify(first));
  writeFileSync(join(target, '.mcp.json'), MINE.replace('keep-me', 'edited'));
  const stale = conforms(await apply(first.handle, approve(first.review)));
  assert.deepEqual([stale.completion, stale.code, stale.changed], ['rejected', 'REVIEW_STALE', 'target-file']);
  writeFileSync(join(target, '.mcp.json'), MINE);
  const ready = await prepare({ ...mergeRequest(target, [merge], { inputs }), resolutions });
  assert.equal(conforms(await apply(ready.handle, approve(ready.review))).completion, 'complete');
  assert.deepEqual(JSON.parse(readFileSync(join(target, '.mcp.json'), 'utf8')).mcpServers.github, written);
  assert.equal(stateText().includes(SECRET), false, 'receipts and history hold no secret');
  const listed = conforms(await list({ target: { project: target }, scope: 'project' }));
  assert.equal(listed.entries[0].members[0].state, 'matching');
  const removal = await prepareRemoval({ target: { project: target }, scope: 'project', removals: [{ managementId: GITHUB }] });
  assert.equal(conforms(await apply(removal.handle, approve(removal.review))).completion, 'complete');
  assert.equal(readFileSync(join(target, '.mcp.json'), 'utf8'), MINE);
});

await check('the published refusal codes name file-too-large-for-client, and a Codex AGENTS.md that would pass 32 KiB is refused before any write', async () => {
  assert.ok(refusalCodes.some(entry => entry.code === 'file-too-large-for-client'));
  const large = '# Mine\n' + 'x'.repeat(30 * 1024) + '\n';
  const target = project('agents', { 'AGENTS.md': large });
  const rule = { item: 'local-my-setup.rule.style', file: 'AGENTS.md', format: 'markdown', key: 'local-my-setup.rule.style', clis: ['codex'],
    entry: 'y'.repeat(4 * 1024) + '\n' };
  const refused = await prepare(mergeRequest(target, [rule]));
  assert.deepEqual([refused.status, refused.code, refused.file], ['refused', 'file-too-large-for-client', 'AGENTS.md']);
  assert.equal(readFileSync(join(target, 'AGENTS.md'), 'utf8'), large);
});

await check('the aih CLI: blocked exits 1, --resolutions replace applies, skip needs --allow-partial, and removal restores your bytes', async () => {
  const cli = join(here, 'node_modules', '@aihq', 'core', 'dist', 'core', 'cli.js');
  const aih = args => {
    const child = spawnSync(process.execPath, [cli, ...args], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    return { code: child.status, result: JSON.parse(child.stdout.trim().split('\n').at(-1)) };
  };
  const target = project('cli', { '.mcp.json': MINE });
  const folder = mkdtempSync(join(process.env.HOME, 'requests-'));
  const document = join(folder, 'plan-request.json');
  writeFileSync(document, JSON.stringify(savedDocument(mergeRequest(target, [merge], { inputs }))));
  const blocked = aih(['install', document, '--json']);
  assert.deepEqual([blocked.code, blocked.result.status], [1, 'blocked'], JSON.stringify(blocked));
  const [conflict] = blocked.result.review.conflicts;
  const choose = choice => { const file = join(folder, `${choice}.json`);
    writeFileSync(file, JSON.stringify({ resolutions: [{ managementId: GITHUB, step: conflict.step, choice, observedSha256: conflict.observedSha256 }] }));
    return file; };
  const skipped = aih(['install', document, '--resolutions', choose('skip'), '--apply', '--yes', '--json']);
  assert.deepEqual([skipped.code, skipped.result.completion, skipped.result.reason], [2, 'rejected', 'partial-approval-required'], JSON.stringify(skipped));
  const partial = aih(['install', document, '--resolutions', choose('skip'), '--apply', '--yes', '--allow-partial', '--json']);
  assert.notEqual(partial.result.completion, 'rejected', JSON.stringify(partial));
  assert.equal(readFileSync(join(target, '.mcp.json'), 'utf8'), MINE, 'a skipped entry leaves your file');
  const preview = aih(['install', document, '--resolutions', choose('replace'), '--json']);
  assert.deepEqual([preview.code, preview.result.status], [0, 'ready'], JSON.stringify(preview));
  const installed = aih(['install', document, '--resolutions', choose('replace'), '--apply', '--yes', '--json']);
  assert.deepEqual([installed.code, installed.result.completion], [0, 'complete'], JSON.stringify(installed));
  const removed = aih(['remove', GITHUB, '--scope', 'project', '--project', target, '--apply', '--yes', '--json']);
  assert.deepEqual([removed.code, removed.result.completion], [0, 'complete'], JSON.stringify(removed));
  assert.equal(readFileSync(join(target, '.mcp.json'), 'utf8'), MINE);
});

console.log(JSON.stringify({ status: 'passed', checks }));
