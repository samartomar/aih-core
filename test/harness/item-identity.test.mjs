// Catalog release 1.7.0 item identities: Core recomputes both hashes exactly as the contract states them, from golden
// vectors computed independently of Core and Catalog. Frozen release 1.6 items keep their line hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { renderDelivery, toolBindings } from '../../dist/harness/contracts.mjs';

const vectors = JSON.parse(readFileSync(new URL('../fixtures/item-identity-1.7.0-vectors.json', import.meta.url), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const claude = toolBindings.find(binding => binding.tool === 'claude');
const BYTES = { 'hooks/guard.mjs': 'console.log("guard");\n', LICENSE: 'MIT\n' };

/** A release item for one vector: content files, the behaviour file's bytes, and the given identities. */
function item(input, identities, { role = 'choosable' } = {}) {
  const content = input.materials.map(({ relPath, sha256: digest }) => ({ id: relPath === 'LICENSE' ? 'license' : 'm0', relPath,
    packagePath: `release/items/guard/${relPath}`, sha256: digest, byteLength: Buffer.byteLength(BYTES[relPath]),
    executable: input.executable[relPath], sourceId: 'upstream', role: 'content' }));
  // The behaviour file stays a material: its bytes are the item's canonical behaviour without the content lines.
  const { materials: _lines, ...behaviourValue } = JSON.parse(vectors.cases.find(entry => entry.input === input).canonical);
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
  const text = `${canonical(behaviourValue)}\n`;
  const behaviour = { id: 'behaviour', relPath: 'aih-behaviour.json', packagePath: 'release/items/guard/aih-behaviour.json',
    sha256: sha256(text), byteLength: Buffer.byteLength(text), executable: false, sourceId: 'example-framework', role: 'behaviour' };
  return { id: 'guard', label: 'guard', kind: input.kind, ...(role ? { role } : {}), sourceIds: ['upstream'], targets: [], scopes: ['project'],
    inputs: {}, payload: input.payload, requirements: input.requirements, dependencies: input.dependencies, executable: input.executable,
    materials: [...content, behaviour], ...identities };
}
const render = candidate => renderDelivery({ tool: 'claude', item: candidate, binding: claude, scope: 'project' });

test('every golden vector renders with its contract identities; a payload, dependency or executable change moves only behaviourSha256', () => {
  const [base, ...changes] = vectors.cases;
  assert.deepEqual(changes.map(entry => entry.name), ['payload-only', 'dependency-only', 'executable-bit']);
  for (const entry of vectors.cases) {
    const rendered = render(item(entry.input, entry.expect));
    assert.equal(rendered.status, 'rendered', `${entry.name}: ${JSON.stringify(rendered)}`);
  }
  for (const entry of changes) {
    assert.equal(entry.expect.contentSha256, base.expect.contentSha256, `${entry.name} changes no file`);
    assert.notEqual(entry.expect.behaviourSha256, base.expect.behaviourSha256, `${entry.name} changes behaviour`);
    // The changed item under the unchanged item's identities is refused.
    const stale = render(item(entry.input, base.expect));
    assert.deepEqual([stale.status, stale.reason], ['refused', 'item-identity-mismatch'], entry.name);
  }
});

test('a release 1.7 item never passes with the 1.6 line hash, and a 1.6 item keeps it', () => {
  const [base] = vectors.cases;
  const lines = members => members.map(member => `${member.relPath}\t${member.sha256}\n`).sort().join('');
  const legacy = candidate => ({ contentSha256: base.expect.contentSha256, behaviourSha256: sha256(lines(candidate.materials)) });
  const release17 = item(base.input, base.expect);
  const refused = render({ ...release17, ...legacy(release17) });
  assert.deepEqual([refused.status, refused.reason], ['refused', 'item-identity-mismatch']);
  const release16 = item(base.input, {}, { role: null });
  assert.equal(render({ ...release16, ...legacy(release16) }).status, 'rendered');
  const contractOn16 = render({ ...release16, ...base.expect });
  assert.deepEqual([contractOn16.status, contractOn16.reason], ['refused', 'item-identity-mismatch']);
});
