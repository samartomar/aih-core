// Public-seam acceptance for policy Prepare `resolutionInputs`: per-operation
// digest hints a caller may copy into a fresh reviewed `resolutions` request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply, listManagedSelections, prepare } from '../dist/core/index.js';
import { SETTINGS as HOOKS, groupOf, hookOp, hookSelection, policy11, request, sandbox, settingsText, sha } from './hook-group-fixture.mjs';
import { compact, groupsOf, guard, neighbor, opOf, prep, run } from './hook-group-harness.mjs';
import { policy } from './fixture.mjs';
import { enterprisePolicy, fakeFetch, orgDocument, orgRoutes, orgSource } from './fixtures/github-org.mjs';
import prepared10Schema from '../dist/core/schemas/prepared-work/1.0.0.json' with { type: 'json' };

const controls = { logging: 'off' };

test('a ready policy Prepare reports no resolution inputs', async () => {
  const s = sandbox('aih-resolution-');
  try {
    const prepared = await prepare(request(s.project, policy()), controls);
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
    assert.deepEqual(prepared.resolutionInputs, []);
  } finally { s.dispose(); }
});

test('unowned different content offers its exact digest for a reviewed replace', async () => {
  const s = sandbox('aih-resolution-');
  try {
    s.write('TEAM.md', 'Local notes.\n');
    const blocked = await prepare(request(s.project, policy()), controls);
    assert.equal(blocked.status, 'blocked');
    assert.deepEqual(blocked.resolutionInputs, [{ selectionId: 'guidance', operationId: 'write',
      observedSha256: sha('Local notes.\n'), availableChoices: ['replace'] }]);
    const [hint] = blocked.resolutionInputs;
    const resolved = await prepare(request(s.project, policy(), [{ selectionId: hint.selectionId, operationId: hint.operationId,
      choice: 'replace', observedSha256: hint.observedSha256 }]), controls);
    assert.equal(resolved.status, 'ready', JSON.stringify(resolved.diagnostics));
    assert.equal(resolved.review.operations[0].effects, 'replace-file');
    assert.deepEqual(resolved.resolutionInputs, []);
  } finally { s.dispose(); }
});

const SETTINGS = 'settings.json';
const setEntry = (id, key, value, name = SETTINGS) => ({ id, purpose: `Set ${key}`, kind: 'config.entries', scope: 'project',
  target: { root: 'project', segments: [{ literal: name }] }, format: 'json', requires: [], checks: [],
  entries: [{ path: [key], action: 'set', value: { literal: value } }] });
const writeFile = (id, name, text) => ({ id, purpose: `Write ${name}`, kind: 'file.write', scope: 'project',
  target: { root: 'project', segments: [{ literal: name }] }, content: { literal: text }, requires: [], checks: [] });
const selection = (id, operations, prerequisites = []) => ({ id, managementId: id, scope: 'project', configuration: {}, requires: [],
  recipe: { inline: { schema: 'urn:aihq:core:recipe:1.0.0', id: `${id}-recipe`, description: 'Resolution input fixture', inputs: {},
    materials: [], targets: ['project'], prerequisites, operations, checks: [] } } });
const document10 = (selections, extra = {}) => ({ schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections, ...extra });
const authored = operations => document10([selection('edits', operations)]);
const removeFile = (id, name) => ({ id, purpose: `Remove ${name}`, kind: 'file.remove', scope: 'project',
  target: { root: 'project', segments: [{ literal: name }] }, requires: [], checks: [] });
async function establish(s, document) {
  const prepared = await prepare(request(s.project, document), controls);
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  const result = await apply(prepared.prepared, { approved: true, origin: 'automation', reviewDigest: prepared.review.reviewDigest }, controls);
  assert.equal(result.completion, 'complete', JSON.stringify(result.diagnostics));
}
const replaceWith = hint => ({ selectionId: hint.selectionId, operationId: hint.operationId, choice: 'replace', observedSha256: hint.observedSha256 });

test('identical unowned file offers an adopt hint and acquires custody only after reviewed Apply', async () => {
  const s = sandbox('aih-resolution-');
  try {
    s.write('SAME.md', 'Same.\n');
    const document = authored([writeFile('same', 'SAME.md', 'Same.\n')]);
    const preview = await prepare(request(s.project, document), controls);
    assert.equal(preview.status, 'ready', JSON.stringify(preview.diagnostics));
    assert.deepEqual(preview.resolutionInputs, [{ selectionId: 'edits', operationId: 'same',
      observedSha256: sha('Same.\n'), availableChoices: ['adopt'] }]);
    assert.deepEqual((await listManagedSelections({ target: { project: s.project }, scope: 'project' })).selections, []);
    const reviewed = await prepare(request(s.project, document, [{ ...replaceWith(preview.resolutionInputs[0]), choice: 'adopt' }]), controls);
    assert.equal(reviewed.status, 'ready', JSON.stringify(reviewed.diagnostics));
    assert.deepEqual(reviewed.resolutionInputs, []);
    const applied = await apply(reviewed.prepared, { approved: true, origin: 'automation', reviewDigest: reviewed.review.reviewDigest }, controls);
    assert.equal(applied.completion, 'complete', JSON.stringify(applied.diagnostics));
    const inventory = await listManagedSelections({ target: { project: s.project }, scope: 'project' });
    assert.deepEqual(inventory.selections.map(item => [item.managementId, item.memberCount]), [['edits', 1]]);
  } finally { s.dispose(); }
});

test('a later hint is the digest after an earlier successful overlay on the same target', async () => {
  const s = sandbox('aih-resolution-');
  try {
    const initial = '{ "x": 1 }\n';
    s.write(SETTINGS, initial);
    const document = authored([setEntry('add', 'a', 1), setEntry('change', 'x', 2)]);
    const blocked = await prepare(request(s.project, document), controls);
    assert.equal(blocked.status, 'partial', JSON.stringify(blocked.diagnostics));
    assert.deepEqual(blocked.resolutionInputs.map(({ operationId, availableChoices }) => ({ operationId, availableChoices })),
      [{ operationId: 'change', availableChoices: ['replace'] }]);
    const [hint] = blocked.resolutionInputs;
    assert.notEqual(hint.observedSha256, sha(initial), 'the hint is never the pre-run whole-file digest');
    const stale = await prepare(request(s.project, document, [{ ...replaceWith(hint), observedSha256: sha(initial) }]), controls);
    assert.equal(stale.diagnostics[0].reason, 'resolution-stale');
    const resolved = await prepare(request(s.project, document, [replaceWith(hint)]), controls);
    assert.equal(resolved.status, 'ready', JSON.stringify(resolved.diagnostics));
  } finally { s.dispose(); }
});

test('two conflicts on one target expose only the first; a fresh Prepare supplies the next digest', async () => {
  const s = sandbox('aih-resolution-');
  try {
    s.write(SETTINGS, '{ "x": 1, "y": 1 }\n');
    s.write('OTHER.md', 'Local.\n');
    const document = authored([setEntry('first', 'x', 2), setEntry('second', 'y', 2), writeFile('other', 'OTHER.md', 'Managed.\n')]);
    const blocked = await prepare(request(s.project, document), controls);
    assert.deepEqual(blocked.resolutionInputs.map(item => item.operationId), ['first', 'other'],
      'a later operation on an unresolved target has no hint; independent targets do');
    const first = blocked.resolutionInputs[0];
    const next = await prepare(request(s.project, document, [replaceWith(first)]), controls);
    assert.deepEqual(next.review.operations.map(item => item.id), ['edits/first', 'edits/other', 'edits/second']);
    assert.deepEqual(next.resolutionInputs.map(item => item.operationId), ['other', 'second'], 'rows follow review operation order');
    const second = next.resolutionInputs[1];
    assert.notEqual(second.observedSha256, first.observedSha256);
    const done = await prepare(request(s.project, document, next.resolutionInputs.map(replaceWith).concat(replaceWith(first))), controls);
    assert.equal(done.status, 'ready', JSON.stringify(done.diagnostics));
    assert.deepEqual(done.resolutionInputs, []);
  } finally { s.dispose(); }
});

test('an unresolved non-actionable conflict suppresses later hints on its target', async () => {
  const s = sandbox('aih-resolution-');
  try {
    s.write(SETTINGS, '{ "x": 1 }\n');
    const document = authored([{ ...setEntry('broken', 'x', 2), format: 'toml' }, writeFile('whole', SETTINGS, 'replacement\n')]);
    const blocked = await prepare(request(s.project, document), controls);
    assert.deepEqual(blocked.review.operations.map(item => item.effects), ['conflict', 'conflict']);
    assert.deepEqual(blocked.resolutionInputs, []);
  } finally { s.dispose(); }
});

test('edited owned content that now equals the desired bytes offers replace and adopt', async () => {
  const s = sandbox('aih-resolution-');
  try {
    await establish(s, authored([writeFile('note', 'NOTE.md', 'First.\n')]));
    s.write('NOTE.md', 'Second.\n');
    const document = authored([writeFile('note', 'NOTE.md', 'Second.\n')]);
    const blocked = await prepare(request(s.project, document), controls);
    assert.equal(blocked.status, 'blocked', JSON.stringify(blocked.diagnostics));
    assert.deepEqual(blocked.resolutionInputs, [{ selectionId: 'edits', operationId: 'note', observedSha256: sha('Second.\n'),
      availableChoices: ['replace', 'adopt'] }]);
    for (const choice of ['replace', 'adopt']) {
      const resolved = await prepare(request(s.project, document, [{ ...replaceWith(blocked.resolutionInputs[0]), choice }]), controls);
      assert.equal(resolved.status, 'ready', `${choice}: ${JSON.stringify(resolved.diagnostics)}`);
    }
  } finally { s.dispose(); }
});

test('unowned removal, lifecycle cleanup and unavailable operations offer no hint', async () => {
  const s = sandbox('aih-resolution-');
  try {
    s.write('HUMAN.md', 'Human.\n');
    const removal = await prepare(request(s.project, authored([removeFile('drop', 'HUMAN.md')])), controls);
    assert.equal(removal.review.operations[0].effects, 'conflict');
    assert.deepEqual(removal.resolutionInputs, []);

    await establish(s, authored([writeFile('note', 'NOTE.md', 'Managed.\n')]));
    s.write('NOTE.md', 'Edited.\n');
    const cleanup = await prepare(request(s.project, document10([], { removals: [{ managementId: 'edits', scope: 'project' }] })), controls);
    assert.deepEqual(cleanup.review.conflicts.map(item => item.reason), ['managed-content-changed']);
    assert.deepEqual(cleanup.resolutionInputs, []);
    const validate10 = new Ajv2020({ strict: true }).compile(prepared10Schema);
    assert.equal(validate10(cleanup.review), true, JSON.stringify(validate10.errors));

    s.write('LOCAL.md', 'Local.\n');
    const unavailable = await prepare(request(s.project, document10([
      selection('missing', [writeFile('write', 'LOCAL.md', 'Missing.\n')], [{ kind: 'executable', name: 'aih-resolution-missing-tool' }]),
      selection('later', [writeFile('write', 'LOCAL.md', 'Later.\n')])])), controls);
    assert.deepEqual(unavailable.review.operations.map(item => item.effects), ['unavailable', 'conflict']);
    assert.deepEqual(unavailable.resolutionInputs, [], 'an unavailable earlier operation leaves the later digest unresolved');
  } finally { s.dispose(); }
});

test('a hook-group hint equals the reviewed targetBeforeSha256 and resolves an edited owned group', async () => {
  const s = sandbox('aih-resolution-');
  try {
    s.write(HOOKS, compact([neighbor('a')]));
    await run(s, guard());
    const edited = settingsText(groupsOf(s).map(group => group.hooks[0].command === 'hooks/guard-a.sh' ? { ...group, matcher: 'Edit' } : group));
    s.write(HOOKS, edited);
    const blocked = await prep(s, guard());
    assert.deepEqual(blocked.review.conflicts.map(item => item.reason), ['owned-hook-edited']);
    assert.deepEqual(blocked.resolutionInputs, [{ selectionId: 'guard-a', operationId: 'add', observedSha256: sha(edited), availableChoices: ['replace'] }]);
    assert.equal(blocked.resolutionInputs[0].observedSha256, opOf(blocked, 'guard-a/add').details.hookGroup.targetBeforeSha256);
    const resolved = await prep(s, guard(), [replaceWith(blocked.resolutionInputs[0])]);
    assert.equal(resolved.status, 'ready', JSON.stringify(resolved.diagnostics));
  } finally { s.dispose(); }
});

test('an identical unowned hook group offers only adopt; different unowned content offers nothing', async () => {
  const s = sandbox('aih-resolution-');
  try {
    const text = compact([neighbor('a'), groupOf('guard-a')]);
    s.write(HOOKS, text);
    const identical = await prep(s, guard());
    assert.deepEqual(identical.resolutionInputs, [{ selectionId: 'guard-a', operationId: 'add', observedSha256: sha(text), availableChoices: ['adopt'] }]);
    const adopted = await prep(s, guard(), [{ ...replaceWith(identical.resolutionInputs[0]), choice: 'adopt' }]);
    assert.equal(adopted.status, 'ready', JSON.stringify(adopted.diagnostics));
    s.write(HOOKS, compact([groupOf('guard-a', { matcher: 'Different' })]));
    const different = await prep(s, guard());
    assert.deepEqual(different.review.conflicts.map(item => item.reason), ['existing-content']);
    assert.deepEqual(different.resolutionInputs, []);
  } finally { s.dispose(); }
});

test('descriptor overlap and shared-member change offer no hook hint', async () => {
  const s = sandbox('aih-resolution-');
  try {
    await run(s, policy11([hookSelection('first', [hookOp('add', 'shared', { format: 'json' })])]));
    const overlap = await prep(s, policy11([hookSelection('second', [hookOp('add', 'shared', { format: 'jsonc' })])]));
    assert.equal(overlap.status, 'blocked');
    assert.deepEqual(overlap.resolutionInputs, []);
  } finally { s.dispose(); }
  const t = sandbox('aih-resolution-');
  try {
    const select = (id, group) => hookSelection(id, [hookOp('add', 'shared', group ? { group } : {})]);
    await run(t, policy11([select('one'), select('two')]));
    const changed = await prep(t, policy11([select('one', groupOf('shared', { matcher: 'Edit' })), select('two')]));
    assert.ok(changed.review.conflicts.some(item => item.reason === 'hook-shared-change'), JSON.stringify(changed.review.conflicts));
    assert.deepEqual(changed.resolutionInputs, []);
  } finally { t.dispose(); }
});

test('invalid and cancelled policy Prepare report no resolution inputs', async () => {
  const s = sandbox('aih-resolution-');
  try {
    const invalid = await prepare(request(s.project, { ...policy(), mode: 'unknown' }), controls);
    assert.equal(invalid.status, 'invalid');
    assert.deepEqual(invalid.resolutionInputs, []);
    const cancelled = await prepare(request(s.project, policy()), { ...controls, signal: AbortSignal.abort() });
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(cancelled.resolutionInputs, []);
  } finally { s.dispose(); }
});

test('repair Prepare keeps its own contract and omits resolution inputs', async () => {
  const s = sandbox('aih-resolution-');
  try {
    const source = join(s.root, 'root.pem');
    writeFileSync(source, readFileSync(new URL('./fixtures/root-a.pem', import.meta.url)));
    const prepared = await prepare({ useCase: 'repair', network: 'off',
      repairs: [{ id: 'node-npm-ca', targets: ['npm'], inputs: { caFile: source } }] }, controls);
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
    assert.equal(Object.hasOwn(prepared, 'resolutionInputs'), false);
  } finally { s.dispose(); }
});

test('an Enterprise hint is local semantics only: the organization can still deny the offered choice', async () => {
  const original = globalThis.fetch;
  const s = sandbox('aih-resolution-');
  try {
    s.write('TEAM.md', 'Local notes.\n');
    const document = enterprisePolicy();
    const enterprise = (resolutions, grant) => {
      globalThis.fetch = fakeFetch(orgRoutes({ bytes: Buffer.from(JSON.stringify(orgDocument(document, grant ? { lifecycle: { replace: true } } : {}))) }));
      return prepare({ ...request(s.project, document, resolutions), organizationSource: orgSource() }, controls);
    };
    const blocked = await enterprise(undefined, false);
    assert.equal(blocked.status, 'blocked', JSON.stringify(blocked.diagnostics));
    assert.deepEqual(blocked.resolutionInputs, [{ selectionId: 'guidance', operationId: 'write', observedSha256: sha('Local notes.\n'), availableChoices: ['replace'] }]);
    const [hint] = blocked.resolutionInputs;
    const denied = await enterprise([replaceWith(hint)], false);
    assert.equal(denied.status, 'blocked');
    assert.equal(denied.prepared, undefined);
    assert.deepEqual(denied.diagnostics.map(item => [item.code, item.reason]), [['AUTHORITY_DENIED', 'lifecycle-replace']]);
    const granted = await enterprise([replaceWith(hint)], true);
    assert.equal(granted.status, 'ready', JSON.stringify(granted.diagnostics));
  } finally { globalThis.fetch = original; s.dispose(); }
});
