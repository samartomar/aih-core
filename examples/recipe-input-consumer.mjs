// Run from an outside consumer containing only the installed Core distribution.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { prepare, apply, checkFileState, inspect } from '@aihq/core';
import { validateRecipe, validatePolicy, contractSupport } from '@aihq/core/contracts';
import { contractSupport as harnessSupport } from '@aihq/core/harness';
import { diagnose } from '@aihq/core/harness/runtime';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = process.cwd(), project = mkdtempSync(join(root, 'target-')), source = mkdtempSync(join(root, 'materials-'));
const target = name => ({ root: 'project', segments: [{ literal: name }] });
const payload = Buffer.from('exact independently supplied bytes\n');
const material = { id: 'payload', path: 'payload.txt', byteLength: payload.length, sha256: sha(payload) };
const recipe = {
  schema: 'urn:aihq:core:recipe:1.3.0', id: 'independent-inputs', description: 'Generic hook and file inputs',
  inputs: { command: { type: 'string', required: true, minLength: 1 },
    enabled: { type: 'boolean', required: true }, note: { type: 'string', required: true },
    count: { type: 'integer', required: true } },
  materials: [{ id: material.id, byteLength: material.byteLength, sha256: material.sha256 }],
  targets: ['project'], prerequisites: [], checks: [], operations: [
    { id: 'hook', purpose: 'Register supplied values', kind: 'hook.group', scope: 'project', target: target('settings.json'),
      format: 'json', container: ['hooks'], groupId: 'independent', selector: { path: ['command'], input: 'command' }, action: 'set',
      group: { literal: { command: '', enabled: true, note: 'placeholder', count: 1 } },
      groupBindings: ['command', 'enabled', 'note', 'count'].map(name => ({ path: [name], value: { input: name } })), requires: [], checks: [] },
    { id: 'write', purpose: 'Install exact material', kind: 'file.write', scope: 'project', target: target('payload.txt'),
      material: 'payload', requires: [], checks: [] }
  ]
};
const recipeBytes = Buffer.from(JSON.stringify(recipe));
writeFileSync(join(source, 'recipe.json'), recipeBytes);
writeFileSync(join(source, material.path), payload);
const reference = { source: { kind: 'local', input: 'supplied' }, path: 'recipe.json',
  byteLength: recipeBytes.length, sha256: sha(recipeBytes), materials: [material] };
const selection = { id: 'independent', managementId: 'independent', scope: 'project', requires: [],
  configuration: { command: 'first-command', enabled: false, note: '', count: 0 }, recipe: { reference } };
const policy = { schema: 'urn:aihq:core:execution-policy:1.3.0', mode: 'vibe', selections: [selection] };
const controls = { logging: 'off', materialRoots: { supplied: source } };
const request = () => ({ useCase: 'policy', policy, target: { project } });
const approve = prepared => ({ approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest });
assert.equal(validateRecipe(recipe).valid, true);
assert.equal(validatePolicy(policy).valid, true);
assert.equal(typeof diagnose, 'function');
assert.equal(harnessSupport.package.version, contractSupport.package.version);
const baseline = await inspect({ targets: ['node'], network: 'off' });
assert.ok(baseline.effectiveOptions);

// Same pinned recipe and materials; only declared configuration changes.
for (const command of ['first-command', 'second-command']) {
  selection.configuration.command = command;
  const prepared = await prepare(request(), controls);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const desired = prepared.review.operations.find(op => op.kind === 'hook.group').details.hookGroup.desiredGroup;
  assert.deepEqual(desired, { command, enabled: false, note: '', count: 0 });
  const result = await apply(prepared.prepared, approve(prepared), controls);
  assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
  assert.deepEqual(JSON.parse(readFileSync(join(project, 'settings.json'))).hooks,
    [{ command, enabled: false, note: '', count: 0 }]);
  assert.deepEqual(readFileSync(join(project, 'payload.txt')), payload);
  assert.equal((await checkFileState({ policy, target: { project } }, { materialRoots: controls.materialRoots })).fileState, 'match');
}
const prepared = await prepare(request(), controls);
assert.equal(prepared.status, 'ready');
writeFileSync(join(source, material.path), 'changed supplied bytes\n');
const stale = await apply(prepared.prepared, approve(prepared), controls);
assert.equal(stale.completion, 'rejected');
assert.ok(stale.diagnostics.some(item => item.code === 'REVIEW_STALE'));
assert.deepEqual(readFileSync(join(project, 'payload.txt')), payload);
const mismatch = await prepare(request(), controls);
assert.notEqual(mismatch.status, 'ready');
process.stdout.write(JSON.stringify({ package: contractSupport.package, recipeSha256: sha(recipeBytes), material,
  assertions: ['false-empty-zero', 'configuration-only-expansion', 'exact-material', 'drift-refused', 'harness-imports', 'policy-free-inspect'] }) + '\n');
