// A config entry that Core wrote into a file it created takes the file with it when the entry is removed, the same
// as an owned hook group: nothing but the empty containers Core wrote is left behind. A file the person already had
// keeps its own content.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { apply, prepare, prepareManagedRemoval } from '../dist/core/index.js';
import { sandbox, sha } from './hook-group-fixture.mjs';
import { fileTree } from './real-catalog-fixture.mjs';

const PATH = '.tool/mcp.json';
let live = [];
afterEach(() => { for (const s of live) s.dispose(); live = []; });
const approve = review => ({ reviewDigest: review.reviewDigest, approved: true, origin: 'automation' });
const recipe = { schema: 'urn:aihq:core:recipe:1.0.0', id: 'mcp-entry', description: 'One MCP server entry', inputs: {}, materials: [],
  targets: ['project'], prerequisites: [], checks: [], operations: [{ id: 'entry', purpose: 'Register one MCP server', kind: 'config.entries',
    scope: 'project', target: { root: 'project', segments: PATH.split('/').map(literal => ({ literal })) }, requires: [], checks: [], format: 'json',
    entries: [{ path: ['mcpServers', 'example'], action: 'set', value: { literal: { command: 'example-server' } } }] }] };
const selection = { id: 'mcp', managementId: 'mcp', scope: 'project', configuration: {}, requires: [], recipe: { inline: recipe },
  item: { framework: 'example', itemId: 'example.mcp.server', contentSha256: sha('content'), behaviourSha256: sha('behaviour') },
  tool: 'claude', name: 'Example server', kind: 'mcp-server', origins: [{ reasonIncluded: 'chosen' }] };

async function install(s) {
  const prepared = await prepare({ useCase: 'policy', policy: { schema: 'urn:aihq:core:execution-policy:1.5.0', mode: 'vibe', selections: [selection] },
    target: { project: s.project } }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const run = await apply(prepared.prepared, approve(prepared.review), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
}
async function remove(s) {
  const result = await prepareManagedRemoval({ target: { project: s.project }, scope: 'project', removals: [{ managementId: 'mcp' }] }, { logging: 'off' });
  assert.equal(result.disposition, 'prepared', JSON.stringify(result));
  const run = await apply(result.preparation.prepared, approve({ reviewDigest: result.reviewDigest }), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
}

test('removing the only entry of a file Core created removes the file', async () => {
  const s = sandbox('aih-entry-created-'); live.push(s);
  const before = fileTree(s.project);
  await install(s);
  assert.deepEqual(JSON.parse(s.read(PATH)), { mcpServers: { example: { command: 'example-server' } } });
  await remove(s);
  assert.equal(existsSync(s.file(PATH)), false, `left behind: ${JSON.stringify(s.read(PATH))}`);
  assert.deepEqual(fileTree(s.project), before);
});

test('removing an entry from a file the person already had keeps the file and its content', async () => {
  const s = sandbox('aih-entry-existing-'); live.push(s);
  s.write(PATH, '{}\n');
  await install(s);
  await remove(s);
  assert.equal(existsSync(s.file(PATH)), true);
  assert.equal(JSON.parse(s.read(PATH)).mcpServers?.example, undefined);
});
