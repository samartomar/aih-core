// Two tools' copies of one Catalog item can share a file or a configuration entry when both are chosen in one
// Prepare, exactly as when the second copy is added in a later Prepare: each copy gets its own claim, the installed
// list shows both with their item and tool, and the shared file or entry stays until the last claim is removed.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply, prepare, prepareManagedRemoval, prepareUpdate, listManagedSelections } from '../dist/core/index.js';
import { sandbox, sha } from './hook-group-fixture.mjs';

const SCRIPT = '.agents/skills/brainstorming/start.sh';
const GUIDE = '.agents/skills/brainstorming/SKILL.md';
const MCP = '.mcp.json';
const INVENTORY = 'urn:aihq:core:managed-inventory-result:1.1.0';
const POLICY = 'urn:aihq:core:execution-policy:1.5.0';
const posix = process.platform !== 'win32';
let live = [];
afterEach(() => { for (const s of live) s.dispose(); live = []; });
const open = prefix => { const s = sandbox(prefix); live.push(s); return s; };
const approve = review => ({ reviewDigest: review.reviewDigest, approved: true, origin: 'automation' });
const at = path => path.split('/').map(literal => ({ literal }));
const item = (itemId, version = 'v1') => ({ framework: 'example', itemId, contentSha256: sha(`${itemId}-${version}`), behaviourSha256: sha(`${itemId}-behaviour`) });

const skillOps = (text = 'brainstorm\n') => [
  { id: 'script', purpose: 'Write the skill script', kind: 'file.write', scope: 'project', target: { root: 'project', segments: at(SCRIPT) },
    content: { literal: '#!/bin/sh\necho start\n' }, mode: 0o755, requires: [], checks: [] },
  { id: 'guide', purpose: 'Write the skill', kind: 'file.write', scope: 'project', target: { root: 'project', segments: at(GUIDE) },
    content: { literal: text }, requires: [], checks: [] }];
const serverOps = (command = 'ecc-server') => [{ id: 'server', purpose: 'Register the server', kind: 'config.entries', scope: 'project',
  target: { root: 'project', segments: at(MCP) }, format: 'json', requires: [], checks: [],
  entries: [{ path: ['mcpServers', 'ecc'], action: 'set', value: { literal: { command } } }] }];
const selection = (id, tool, itemId, operations, version, schema = 'urn:aihq:core:recipe:1.3.0') => ({ id, managementId: id, scope: 'project', configuration: {}, requires: [],
  recipe: { inline: { schema, id: `${itemId}-${tool}`, description: itemId, inputs: {}, materials: [], targets: ['project'],
    prerequisites: [], checks: [], operations } },
  item: item(itemId, version), tool, name: itemId, kind: operations[0].kind === 'config.entries' ? 'mcp-server' : 'skill', origins: [{ reasonIncluded: 'chosen' }] });

async function install(s, selections) {
  const prepared = await prepare({ useCase: 'policy', policy: { schema: POLICY, mode: 'vibe', selections }, target: { project: s.project } }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const run = await apply(prepared.prepared, approve(prepared.review), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  return prepared;
}
async function remove(s, managementId) {
  const result = await prepareManagedRemoval({ target: { project: s.project }, scope: 'project', removals: [{ managementId }] }, { logging: 'off' });
  assert.equal(result.disposition, 'prepared', JSON.stringify(result));
  const run = await apply(result.preparation.prepared, approve({ reviewDigest: result.reviewDigest }), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  return result;
}
async function installed(s) {
  const result = await listManagedSelections({ target: { project: s.project }, scope: 'project', format: INVENTORY });
  assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
  return result.selections.map(row => [row.managementId, row.tool, row.item?.itemId ?? null, row.memberCount]).sort((a, b) => a[0].localeCompare(b[0]));
}
const receipt = s => join(s.home, '.aih', 'core', 'ownership', `${sha(realpathSync.native(s.project))}.json`);
const withinLimit = s => assert.ok(statSync(receipt(s)).size <= 2 * 1024 * 1024, 'the ownership record stays within 2 MiB');
const server = s => JSON.parse(readFileSync(s.file(MCP), 'utf8')).mcpServers?.ecc;

test('two tools\' copies of one skill with an executable script share its files in one Prepare', async () => {
  const s = open('aih-shared-exec-');
  const prepared = await install(s, [selection('codex', 'codex', 'brainstorming', skillOps()), selection('antigravity', 'antigravity', 'brainstorming', skillOps())]);
  // The second copy writes nothing: it claims the files the first copy plans, executable mode included.
  assert.deepEqual(prepared.review.operations.map(op => [op.selectionId, op.details.target.split(/[\\/]/).at(-1), op.effects, op.ownership]),
    [['codex', 'start.sh', 'create-file', 'unowned'], ['codex', 'SKILL.md', 'create-file', 'unowned'],
      ['antigravity', 'start.sh', 'already-satisfied', 'managed'], ['antigravity', 'SKILL.md', 'already-satisfied', 'managed']]);
  if (posix) assert.equal(statSync(s.file(SCRIPT)).mode & 0o777, 0o755);
  assert.deepEqual(await installed(s), [['antigravity', 'antigravity', 'brainstorming', 2], ['codex', 'codex', 'brainstorming', 2]]);
  withinLimit(s);
  const first = await remove(s, 'codex');
  assert.deepEqual([...new Set(first.removals[0].members.map(member => `${member.action}/${member.reason}`))], ['keep-shared/another-selection']);
  assert.equal(s.read(SCRIPT), '#!/bin/sh\necho start\n');
  assert.equal(s.read(GUIDE), 'brainstorm\n');
  assert.deepEqual(await installed(s), [['antigravity', 'antigravity', 'brainstorming', 2]]);
  await remove(s, 'antigravity');
  assert.deepEqual([existsSync(s.file(SCRIPT)), existsSync(s.file(GUIDE))], [false, false]);
  assert.deepEqual(await installed(s), []);
});

test('the same holds when the executable copy is added in a later Prepare', async () => {
  const s = open('aih-shared-exec-later-');
  await install(s, [selection('codex', 'codex', 'brainstorming', skillOps())]);
  await install(s, [selection('codex', 'codex', 'brainstorming', skillOps()), selection('antigravity', 'antigravity', 'brainstorming', skillOps())]);
  assert.deepEqual(await installed(s), [['antigravity', 'antigravity', 'brainstorming', 2], ['codex', 'codex', 'brainstorming', 2]]);
});

test('another item\'s identical executable file is never claimed, in one Prepare as in a later one', async () => {
  for (const order of ['one Prepare', 'a later Prepare']) {
    const s = open('aih-shared-exec-other-');
    const codex = selection('codex', 'codex', 'brainstorming', skillOps());
    if (order === 'a later Prepare') await install(s, [codex]);
    const prepared = await install(s, [codex, selection('other', 'antigravity', 'other-skill', skillOps())]);
    assert.deepEqual(prepared.review.operations.filter(op => op.selectionId === 'other').map(op => [op.effects, op.ownership]),
      [['already-satisfied', 'unowned'], ['already-satisfied', 'unowned']], order);
    assert.deepEqual(await installed(s), [['codex', 'codex', 'brainstorming', 2]], order);
  }
});

for (const order of ['one Prepare', 'a later Prepare']) test(`two tools' copies of one MCP server share its configuration entry (${order})`, async () => {
  const s = open('aih-shared-entry-');
  const claude = selection('claude', 'claude', 'ecc', serverOps()); const copilot = selection('copilot', 'copilot', 'ecc', serverOps());
  if (order === 'a later Prepare') await install(s, [claude]);
  await install(s, [claude, copilot]);
  assert.deepEqual(server(s), { command: 'ecc-server' });
  assert.deepEqual(await installed(s), [['claude', 'claude', 'ecc', 1], ['copilot', 'copilot', 'ecc', 1]]);
  withinLimit(s);
  const first = await remove(s, 'claude');
  assert.deepEqual(first.removals[0].members.map(member => `${member.action}/${member.reason}`), ['keep-shared/another-selection']);
  assert.deepEqual(server(s), { command: 'ecc-server' }, 'the other tool keeps its server');
  assert.deepEqual(await installed(s), [['copilot', 'copilot', 'ecc', 1]]);
  await remove(s, 'copilot');
  assert.equal(existsSync(s.file(MCP)), false, `left behind: ${s.read(MCP)}`);
  assert.deepEqual(await installed(s), []);
});

test('updating both copies of a shared entry together changes it; updating one alone is a conflict', async () => {
  const s = open('aih-shared-entry-update-');
  await install(s, [selection('claude', 'claude', 'ecc', serverOps()), selection('copilot', 'copilot', 'ecc', serverOps())]);
  const update = ids => prepareUpdate({ target: { project: s.project }, scope: 'project',
    updates: ids.map(id => ({ managementId: id, replacement: selection(id, id, 'ecc', serverOps('ecc-server-2'), 'v2') })) }, { logging: 'off' });
  const alone = await update(['claude']);
  assert.equal(alone.preparation.status, 'blocked');
  assert.deepEqual(alone.preparation.review.operations.map(op => op.effects), ['conflict']);
  assert.deepEqual(alone.preparation.diagnostics.map(item => [item.code, item.path]), [['STATE_CONFLICT', MCP]]);
  const both = await update(['claude', 'copilot']);
  assert.equal(both.preparation.status, 'ready', JSON.stringify(both.preparation.diagnostics));
  assert.equal((await apply(both.preparation.prepared, approve(both.preparation.review), { logging: 'off' })).completion, 'complete');
  assert.deepEqual(server(s), { command: 'ecc-server-2' });
  assert.deepEqual(await installed(s), [['claude', 'claude', 'ecc', 1], ['copilot', 'copilot', 'ecc', 1]]);
  await remove(s, 'claude');
  assert.deepEqual(server(s), { command: 'ecc-server-2' });
  await remove(s, 'copilot');
  assert.equal(existsSync(s.file(MCP)), false);
});

test('the second copy of a shared entry can be removed first; the entry stays for the first until it goes', async () => {
  const s = open('aih-shared-entry-reverse-');
  await install(s, [selection('claude', 'claude', 'ecc', serverOps()), selection('copilot', 'copilot', 'ecc', serverOps())]);
  const second = await remove(s, 'copilot');
  assert.deepEqual(second.removals[0].members.map(member => `${member.action}/${member.reason}`), ['keep-shared/another-selection']);
  assert.deepEqual(server(s), { command: 'ecc-server' });
  assert.deepEqual(await installed(s), [['claude', 'claude', 'ecc', 1]]);
  const first = await remove(s, 'claude');
  assert.deepEqual(first.removals[0].members.map(member => member.action), ['remove']);
  assert.equal(existsSync(s.file(MCP)), false, `left behind: ${s.read(MCP)}`);
  assert.deepEqual(await installed(s), []);
});

test('a person\'s edit of a shared entry is drift for both copies: neither replaces it and removal keeps their value', async () => {
  const s = open('aih-shared-entry-drift-');
  const both = [selection('claude', 'claude', 'ecc', serverOps()), selection('copilot', 'copilot', 'ecc', serverOps())];
  await install(s, both);
  writeFileSync(s.file(MCP), JSON.stringify({ mcpServers: { ecc: { command: 'my-own-server' } } }, null, 2) + '\n');
  const again = await prepare({ useCase: 'policy', policy: { schema: POLICY, mode: 'vibe', selections: both }, target: { project: s.project } }, { logging: 'off' });
  assert.equal(again.status, 'blocked');
  assert.deepEqual(again.review.operations.map(op => [op.selectionId, op.effects]), [['claude', 'conflict'], ['copilot', 'conflict']]);
  assert.deepEqual(again.diagnostics.map(item => [item.code, item.path]), [['STATE_CONFLICT', MCP], ['STATE_CONFLICT', MCP]]);
  for (const id of ['claude', 'copilot']) {
    const removal = await remove(s, id);
    assert.deepEqual(removal.removals[0].members.map(member => `${member.action}/${member.reason}`), ['keep-changed/managed-content-changed'], id);
    assert.deepEqual(server(s), { command: 'my-own-server' }, `the person's value stays after removing ${id}`);
  }
  // As for one copy, a changed entry keeps its record: the person decides what happens to it.
  assert.deepEqual(await installed(s), [['claude', 'claude', 'ecc', 1], ['copilot', 'copilot', 'ecc', 1]]);
});

for (const order of ['one Prepare', 'a later Prepare']) test(`an entry the earlier copy writes as a tool's approval is never shared (${order})`, async () => {
  const s = open('aih-shared-entry-approval-');
  const allow = approval => ({ id: 'allow', purpose: 'Allow the server', kind: 'config.entries', scope: 'project',
    target: { root: 'project', segments: at('.tool/settings.json') }, format: 'json', requires: approval ? ['server'] : [], checks: [],
    entries: [{ path: ['allowed', 'ecc'], action: 'set', value: { literal: true } }], ...(approval ? { approval } : {}) });
  const claude = selection('claude', 'claude', 'ecc', [...serverOps(), allow({ tool: 'claude' })], 'v1', 'urn:aihq:core:recipe:1.4.0');
  const copilot = selection('copilot', 'copilot', 'ecc', [allow()], 'v1', 'urn:aihq:core:recipe:1.4.0');
  if (order === 'a later Prepare') await install(s, [claude]);
  const prepared = await prepare({ useCase: 'policy', policy: { schema: POLICY, mode: 'vibe', selections: [claude, copilot] }, target: { project: s.project } }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.deepEqual(prepared.review.operations.filter(op => op.selectionId === 'copilot').map(op => [op.effects, op.ownership]), [['already-satisfied', 'unowned']]);
  assert.equal((await apply(prepared.prepared, approve(prepared.review), { logging: 'off' })).completion, 'complete');
  assert.deepEqual(await installed(s), [['claude', 'claude', 'ecc', 2]]);
});
