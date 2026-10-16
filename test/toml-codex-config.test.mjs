import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'aih-toml-codex-'));
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const home = join(root, 'home');
mkdirSync(home);
process.env.HOME = home;
process.env.USERPROFILE = home;
// Set the fixture home before loading Core; no client process is involved.
const { prepare, apply, checkFileState } = await import('../dist/core/index.js');
after(() => {
  for (const [key, value] of Object.entries(previousHome)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const original = `# Codex configuration
model = "gpt-6.1-sol"
model_reasoning_effort = "medium"

[projects."/home/u/p"]
trust_level = "trusted"

[mcp_servers."name.with.dots"]
command = "npx"
args = ["-y", "other-server"]

[tui]
notifications = true

# Trailing notes kept by the user
# second trailing line
`;
const appended = `[mcp_servers.aih]
command = "node"
args = ["server.js", "--stdio"]
[mcp_servers.aih.env]
API_URL = "https://example.test"
`;
const projectTable = '[projects."/home/u/q"]\ntrust_level = "trusted"\n';
const trailingNotes = '# Trailing notes kept by the user\n# second trailing line\n';
const controls = { logging: 'off' };
const operation = (id, path, value) => ({ id, purpose: `Manage Codex ${id}`, kind: 'config.entries', scope: 'user',
  target: { root: 'userHome', segments: [{ literal: '.codex' }, { literal: 'config.toml' }] }, format: 'toml',
  entries: [{ path, action: 'set', value: { literal: value } }], requires: [], checks: [] });
const operations = () => [
  operation('command', ['mcp_servers', 'aih', 'command'], 'node'),
  operation('args', ['mcp_servers', 'aih', 'args'], ['server.js', '--stdio']),
  operation('env', ['mcp_servers', 'aih', 'env', 'API_URL'], 'https://example.test')
];
function policy(ops) {
  return { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [{
    id: 'codex', managementId: 'codex-mcp', scope: 'user', configuration: {}, requires: [], recipe: { inline: {
      schema: 'urn:aihq:core:recipe:1.0.0', id: 'codex-mcp', description: 'Manage selected Codex MCP settings',
      inputs: {}, materials: [], targets: ['user'], prerequisites: [], operations: ops, checks: []
    } }
  }] };
}
function fixture(ops, eol = '\n') {
  // Each scenario has independent user custody, including when a prior test fails.
  const base = mkdtempSync(join(root, 'case-'));
  const fixtureHome = join(base, 'home');
  const project = join(base, 'project');
  mkdirSync(join(fixtureHome, '.codex'), { recursive: true });
  mkdirSync(project);
  process.env.HOME = fixtureHome;
  process.env.USERPROFILE = fixtureHome;
  const file = join(fixtureHome, '.codex', 'config.toml');
  const lines = text => text.replaceAll('\n', eol);
  writeFileSync(file, lines(original));
  return { file, lines, request: { useCase: 'policy', policy: policy(ops), target: { project } } };
}
async function preview(request) {
  const result = await prepare(request, controls);
  assert.equal(result.status, 'ready', JSON.stringify(result.diagnostics));
  assert.ok(result.prepared);
  return result;
}
async function execute(result) {
  const applied = await apply(result.prepared, { approved: true, origin: 'automation', reviewDigest: result.review.reviewDigest }, controls);
  assert.equal(applied.completion, 'complete', JSON.stringify(applied));
}
async function match(request) {
  const state = await checkFileState({ policy: request.policy, target: request.target });
  assert.equal(state.status, 'complete', JSON.stringify(state));
  assert.equal(state.fileState, 'match', JSON.stringify(state));
  assert.ok(state.targets.length > 0);
  assert.ok(state.targets.every(target => target.outcome === 'match'), JSON.stringify(state.targets));
}
async function repeat(f) {
  const before = readFileSync(f.file);
  const p = await preview(f.request);
  assert.deepEqual(p.review.operations.map(op => op.effects), ['already-satisfied', 'already-satisfied', 'already-satisfied']);
  await execute(p);
  assert.deepEqual(readFileSync(f.file), before, 'repeat setup preserves every byte');
}

for (const eol of ['\n', '\r\n']) {
  for (const insertion of ['before trailing comments', 'at end of file']) {
    test(`Codex TOML preserves ${eol === '\n' ? 'LF' : 'CRLF'} bytes and per-key custody after client insertion ${insertion}`, async () => {
      const f = fixture(operations(), eol);
      const first = await preview(f.request);
      assert.equal(first.review.operations.find(op => op.id === 'codex/args').details.entries[0].value, '["server.js","--stdio"]');
      assert.deepEqual(readFileSync(f.file), Buffer.from(f.lines(original)), 'Prepare is inert');
      await execute(first);
      assert.deepEqual(readFileSync(f.file), Buffer.from(f.lines(original + appended)), 'only the managed tables are appended');
      await match(f.request);
      await repeat(f);

      let clientEdited = (original + appended).replace('model = "gpt-6.1-sol"', 'model = "gpt-6-sol"');
      clientEdited = insertion === 'before trailing comments'
        ? clientEdited.replace(trailingNotes, projectTable + trailingNotes)
        : clientEdited + projectTable;
      writeFileSync(f.file, f.lines(clientEdited));
      await match(f.request);
      await repeat(f);

      const drift = f.lines(clientEdited).replace('args = ["server.js", "--stdio"]', 'args = ["server.js", "--evil"]');
      assert.notEqual(drift, f.lines(clientEdited));
      writeFileSync(f.file, drift);
      const state = await checkFileState({ policy: f.request.policy, target: f.request.target });
      assert.equal(state.status, 'complete', JSON.stringify(state));
      assert.equal(state.fileState, 'changed', JSON.stringify(state));
      assert.ok(state.targets.some(target => target.outcome === 'changed' && target.operationIds.includes('codex/args')), JSON.stringify(state.targets));
      const blocked = await prepare(f.request, controls);
      assert.equal(blocked.status, 'partial', JSON.stringify(blocked));
      assert.deepEqual(blocked.resolutionInputs.map(item => item.operationId), ['args']);
      assert.deepEqual(Object.fromEntries(blocked.review.operations.map(op => [op.id, op.effects])), {
        'codex/command': 'already-satisfied', 'codex/args': 'conflict', 'codex/env': 'already-satisfied'
      });
      assert.ok(blocked.diagnostics.some(d => d.code === 'STATE_CONFLICT'), JSON.stringify(blocked.diagnostics));
      assert.equal(readFileSync(f.file, 'utf8'), drift, 'drift inspection is inert');
    });
  }
}

for (const eol of ['\n', '\r\n']) {
  test(`a quoted table segment containing dots is one key (${eol === '\n' ? 'LF' : 'CRLF'})`, async () => {
    const f = fixture([operation('quoted-command', ['mcp_servers', 'name.with.dots', 'command'], 'node')], eol);
    const request = { ...f.request, resolutions: [{ selectionId: 'codex', operationId: 'quoted-command', choice: 'replace',
      observedSha256: createHash('sha256').update(readFileSync(f.file)).digest('hex') }] };
    await execute(await preview(request));
    const expected = f.lines(original.replace('command = "npx"', 'command = "node"'));
    assert.deepEqual(readFileSync(f.file), Buffer.from(expected), 'only the selected quoted-table value changes');
    await match(f.request);
    const again = await preview(f.request);
    assert.equal(again.review.operations[0].effects, 'already-satisfied');
    await execute(again);
    assert.deepEqual(readFileSync(f.file), Buffer.from(expected));
  });
}
