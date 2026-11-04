// Runs inside a disposable consumer with the packed @aihq/core installed; public entries and the `aih` bin only.
// The retained editors through change requests (urn:aihq:core:change-request:0.1.0): a Codex TOML edit in the user's
// config.toml and an owned hook group in a project settings file, each beside the person's own content. Unrelated
// content stays byte for byte; removal restores the original bytes. Changes are hand-written test documents.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFormat } from '@aihq/core/contracts';
import { apply, list, prepare, prepareRemoval } from '@aihq/core';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, 'node_modules', '@aihq', 'core', 'dist', 'core', 'cli.js');
const approve = review => ({ approved: true, origin: 'automation', reviewDigest: review.reviewDigest });
const conforms = value => { const read = validateFormat(value); assert.equal(read.status, 'ok', JSON.stringify(read)); return value; };
const aih = args => {
  const run = spawnSync(process.execPath, [bin, ...args, '--json'], { encoding: 'utf8', env: process.env, timeout: 120_000 });
  return { code: run.status, result: JSON.parse(run.stdout.trim().split('\n').at(-1)), stderr: run.stderr };
};
const change = (id, scope, operations) => ({ schema: 'urn:aihq:core:change:0.1.0', id, description: `Change ${id}`, inputs: {}, materials: [],
  targets: [scope], prerequisites: [], operations, checks: [] });
const request = (changes, scope, project) => ({ schema: 'urn:aihq:core:change-request:0.1.0', mode: 'vibe', scope, target: { project },
  changes: changes.map(item => ({ managementId: item.id, change: item, inputs: {}, requires: [] })) });
const checks = [];
const check = async (name, body) => { await body(); checks.push(name); };

// The person's own Codex configuration: a comment, a root key, a table of theirs and a server Core never touches.
const codexFile = join(process.env.HOME, '.codex', 'config.toml');
const ownCodex = '# my settings\nmodel = "gpt-5"\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n\n[mcp_servers.mine]\ncommand = "mine"\n';
const codex = change('codex-github', 'user', [{ id: 'set', purpose: 'Ask before commands and add the GitHub server', kind: 'config.entries',
  scope: 'user', format: 'toml', target: { root: 'user', segments: [{ literal: '.codex' }, { literal: 'config.toml' }] },
  set: [{ path: ['approval_policy'], value: 'on-request' }, { path: ['mcp_servers', 'github', 'command'], value: 'github-mcp' },
    { path: ['mcp_servers', 'github', 'args'], value: ['--stdio'] }], requires: [], checks: [] }]);

await check('a Codex TOML change keeps the person\'s own config.toml content byte for byte, and removal restores it', async () => {
  mkdirSync(dirname(codexFile), { recursive: true }); writeFileSync(codexFile, ownCodex);
  const prepared = await prepare(request([codex], 'user', null));
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared)); conforms(prepared.review);
  const run = conforms(await apply(prepared.handle, approve(prepared.review)));
  assert.equal(run.completion, 'complete', JSON.stringify(run));
  const after = readFileSync(codexFile, 'utf8');
  // Every line the person wrote is still there, in order; Core added only its own keys and table.
  const own = ownCodex.split('\n').filter(Boolean);
  let at = -1; for (const line of own) { const next = after.split('\n').indexOf(line, at + 1); assert.ok(next > at, line); at = next; }
  assert.match(after, /approval_policy = "on-request"/); assert.match(after, /\[mcp_servers\.github\]/); assert.match(after, /command = "github-mcp"/);
  assert.ok((await list({ target: { project: null }, scope: 'user' })).entries.some(entry => entry.managementId === 'codex-github'));
  const removal = await prepareRemoval({ target: { project: null }, scope: 'user', removals: [{ managementId: 'codex-github' }] });
  assert.equal(removal.status, 'ok', JSON.stringify(removal));
  assert.equal(conforms(await apply(removal.handle, approve(removal.review))).completion, 'complete');
  assert.equal(readFileSync(codexFile, 'utf8'), ownCodex);
});

// A project settings file holding the person's own hook group and keys; Core owns one more group beside them.
const project = mkdtempSync(join(process.env.HOME, 'hooks-'));
const settings = join(project, '.claude', 'settings.json');
const ownSettings = '{\n  "model": "sonnet",\n  "hooks": {\n    "PreToolUse": [\n      { "matcher": "Edit", "hooks": [{ "type": "command", "command": "mine.sh" }] }\n    ]\n  }\n}\n';
const guard = change('bash-guard', 'project', [{ id: 'guard', purpose: 'Guard Bash with the team hook', kind: 'hook.group', scope: 'project',
  target: { root: 'project', segments: [{ literal: '.claude' }, { literal: 'settings.json' }] }, format: 'json', container: ['hooks', 'PreToolUse'],
  groupId: 'bash-guard', selector: { path: ['hooks', 0, 'command'], value: 'team/guard.sh' }, action: 'set',
  group: { literal: { matcher: 'Bash', hooks: [{ type: 'command', command: 'team/guard.sh' }] } }, requires: [], checks: [] }]);

await check('an owned hook group is added beside the person\'s own group through aih change, and aih remove restores the file', async () => {
  mkdirSync(dirname(settings), { recursive: true }); writeFileSync(settings, ownSettings);
  const file = join(project, 'guard-request.json'); writeFileSync(file, JSON.stringify(request([guard], 'project', project)));
  const preview = aih(['change', file, '--project', project]);
  assert.equal(preview.code, 0, JSON.stringify(preview)); conforms(preview.result.review);
  assert.equal(readFileSync(settings, 'utf8'), ownSettings, 'a preview changes nothing');
  const applied = aih(['change', file, '--project', project, '--apply', '--yes']);
  assert.equal(applied.code, 0, JSON.stringify(applied)); assert.equal(conforms(applied.result).completion, 'complete');
  const written = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(written.model, 'sonnet');
  assert.deepEqual(written.hooks.PreToolUse.map(group => group.hooks[0].command), ['mine.sh', 'team/guard.sh']);
  const listed = aih(['list', '--project', project, '--scope', 'project']);
  assert.deepEqual(listed.result.entries.map(entry => entry.managementId), ['bash-guard']);
  const removed = aih(['remove', 'bash-guard', '--scope', 'project', '--project', project, '--apply', '--yes']);
  assert.equal(removed.code, 0, JSON.stringify(removed)); assert.equal(conforms(removed.result).completion, 'complete');
  assert.equal(readFileSync(settings, 'utf8'), ownSettings);
});

await check('the person\'s edit to the owned group is kept and reported on removal, never overwritten', async () => {
  writeFileSync(settings, ownSettings);
  const prepared = await prepare(request([guard], 'project', project));
  assert.equal((await apply(prepared.handle, approve(prepared.review))).completion, 'complete');
  const edited = readFileSync(settings, 'utf8').replace('"Bash"', '"Bash|Write"');
  writeFileSync(settings, edited);
  const removal = await prepareRemoval({ target: { project }, scope: 'project', removals: [{ managementId: 'bash-guard' }] });
  assert.equal(removal.status, 'ok', JSON.stringify(removal));
  assert.ok(removal.entries[0].members.some(member => member.action === 'keep-changed'), JSON.stringify(removal.entries));
  if (removal.handle) await apply(removal.handle, approve(removal.review));
  assert.equal(readFileSync(settings, 'utf8'), edited);
});

console.log(JSON.stringify({ status: 'passed', checks }));
