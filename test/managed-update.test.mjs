import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { prepare, apply, prepareUpdate } from '../dist/core/index.js';
import { policy } from './fixture.mjs';
import { sandbox } from './hook-group-fixture.mjs';

// Managed update preparation 1.0.0 keeps the removal safeguards per update; these cover the dispositions and member
// actions the packed consumer cannot reach without editing protected custody.
const sha = value => createHash('sha256').update(value).digest('hex');
const approve = (review, allowPartial) => ({ reviewDigest: review.reviewDigest, approved: true, origin: 'automation', ...(allowPartial ? { allowPartial } : {}) });
const request = (s, updates) => ({ target: { project: s.project }, scope: 'project', updates });
const runsDir = s => join(s.home, '.aih', 'core', 'runs');
const projectReceipt = s => join(s.home, '.aih', 'core', 'ownership', `${sha(realpathSync.native(s.project))}.json`);
const rewriteReceipt = (s, change) => { const value = JSON.parse(readFileSync(projectReceipt(s), 'utf8')); change(value); writeFileSync(projectReceipt(s), JSON.stringify(value)); };
const reasons = result => result.updates.map(entry => [entry.managementId, entry.disposition, entry.diagnostics.map(item => item.reason)]);
const actions = entry => entry.members.map(member => [member.path.split(/[\\/]/).at(-1), member.kind, member.action, member.reason ?? null]);

const fileSelection = (id, file, text) => ({ id, managementId: id, scope: 'project', configuration: {}, requires: [],
  recipe: { inline: { schema: 'urn:aihq:core:recipe:1.3.0', id, description: id, inputs: {}, materials: [], targets: ['project'], prerequisites: [], checks: [],
    operations: [{ id: 'write', purpose: 'Write', kind: 'file.write', scope: 'project', target: { root: 'project', segments: [{ literal: file }] },
      content: { literal: text }, requires: [], checks: [] }] } } });
const document = selections => ({ schema: 'urn:aihq:core:execution-policy:1.4.0', mode: 'vibe', selections });
async function install(s, selections, resolutions) {
  const prepared = await prepare({ useCase: 'policy', policy: document(selections), target: { project: s.project }, ...(resolutions ? { resolutions } : {}) }, { logging: 'off' });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
  assert.equal((await apply(prepared.prepared, approve(prepared.review), { logging: 'off' })).completion, 'complete');
}

let live = [];
const open = () => { const s = sandbox('aih-update-'); live.push(s); return s; };
afterEach(() => { for (const s of live) s.dispose(); live = []; });

test('legacy custody stays reconcile-required per update while the rest of the request is prepared', async () => {
  const s = open();
  await install(s, [fileSelection('legacy', 'LEGACY.md', 'legacy\n'), fileSelection('fresh', 'FRESH.md', 'fresh\n')]);
  rewriteReceipt(s, value => {
    for (const [key, claim] of Object.entries(value.selections ?? {})) if (claim.managementId === 'legacy') delete value.selections[key];
    for (const member of Object.values(value.members)) if (member.managementId === 'legacy') { delete member.claims; delete member.descriptor; }
  });
  const result = await prepareUpdate(request(s, [{ managementId: 'legacy', replacement: fileSelection('legacy', 'LEGACY.md', 'legacy v2\n') },
    { managementId: 'fresh', replacement: fileSelection('fresh', 'FRESH.md', 'fresh v2\n') }]), { logging: 'off' });
  assert.equal(result.disposition, 'prepared', JSON.stringify(result));
  assert.deepEqual(reasons(result), [['legacy', 'reconcile-required', ['legacy-reconcile']], ['fresh', 'prepared', []]]);
  assert.match(result.updates[0].diagnostics[0].guidance, /original recipe/);
  assert.deepEqual(result.preparation.review.operations.map(op => op.details.target), [join(realpathSync.native(s.project), 'FRESH.md')]);
  assert.deepEqual([result.updates[1].from, result.updates[1].to], [null, null], 'a selection recorded without item facts has none to show');
});

test('an obsolete member another selection owns is keep-shared; one that replaced a person\'s value is restored', async () => {
  const s = open();
  const settings = join(s.project, 'settings.json');
  writeFileSync(settings, `${JSON.stringify({ tool: { mode: 'person-value' } }, null, 2)}\n`);
  const entry = { id: 'mode', purpose: 'Set', kind: 'config.entries', scope: 'project', target: { root: 'project', segments: [{ literal: 'settings.json' }] },
    format: 'json', entries: [{ path: ['tool', 'mode'], action: 'set', value: { literal: 'aih' } }], requires: [], checks: [] };
  const withEntry = fileSelection('tool', 'TOOL.md', 'tool\n');
  withEntry.recipe.inline.operations.push(entry);
  await install(s, [withEntry], [{ selectionId: 'tool', operationId: 'mode', choice: 'replace', observedSha256: sha(readFileSync(settings)) }]);
  rewriteReceipt(s, value => { const member = Object.entries(value.members).find(([key]) => key.toLowerCase().endsWith('tool.md'))[1]; member.claims.push({ ...member.claims[0], managementId: 'other-tool' }); });
  // The replacement writes another file and no longer sets the entry.
  const result = await prepareUpdate(request(s, [{ managementId: 'tool', replacement: fileSelection('tool', 'TOOL-2.md', 'tool 2\n') }]), { logging: 'off' });
  assert.equal(result.preparation.status, 'ready', JSON.stringify(result.preparation.diagnostics));
  assert.deepEqual(actions(result.updates[0]).sort(), [['TOOL-2.md', 'file', 'add', null], ['TOOL.md', 'file', 'keep-shared', 'another-selection'],
    ['settings.json', 'config-entry', 'restore', 'pre-existing-value']]);
  const run = await apply(result.preparation.prepared, approve(result.preparation.review), { logging: 'off' });
  assert.equal(run.completion, 'complete', JSON.stringify(run.diagnostics));
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), { tool: { mode: 'person-value' } });
  assert.equal(readFileSync(join(s.project, 'TOOL.md'), 'utf8'), 'tool\n', 'the shared member stays for its other owner');
});

test('an update keeps the dependency edges recorded at install, so a dependency it does not name is still retained', async () => {
  const s = open();
  const top = fileSelection('top', 'TOP.md', 'top\n'); top.requires = ['base'];
  const prepared = await prepare({ useCase: 'policy', target: { project: s.project }, policy: { ...document([top, fileSelection('base', 'BASE.md', 'base\n')]),
    managedSelections: [{ id: 'team', scope: 'project', members: ['base'] }] } }, { logging: 'off' });
  assert.equal((await apply(prepared.prepared, approve(prepared.review), { logging: 'off' })).completion, 'complete');
  const result = await prepareUpdate(request(s, [{ managementId: 'top', replacement: fileSelection('top', 'TOP.md', 'top v2\n') }]), { logging: 'off' });
  assert.equal(result.preparation.status, 'ready', JSON.stringify(result.preparation.diagnostics));
  assert.equal((await apply(result.preparation.prepared, approve(result.preparation.review), { logging: 'off' })).completion, 'complete');
  // Reconciling the set without "base" removes nothing while "top" still requires it.
  const reconcile = await prepare({ useCase: 'policy', target: { project: s.project }, policy: { ...document([]),
    managedSelections: [{ id: 'team', scope: 'project', members: [] }] } }, { logging: 'off' });
  assert.deepEqual(reconcile.review.operations.map(op => op.effects), [], JSON.stringify(reconcile.review.operations));
  assert.equal(readFileSync(join(s.project, 'BASE.md'), 'utf8'), 'base\n');
});

test('a replacement for an item recorded at install must name its item and tool', async () => {
  const s = open();
  const described = (text, itemId = 'guide') => ({ ...fileSelection('guide', 'GUIDE.md', text), item: { framework: 'fw', itemId,
    contentSha256: sha(text), behaviourSha256: sha(`b${text}`) }, tool: 'claude', name: 'Guide', kind: 'document', origins: [{ reasonIncluded: 'chosen' }] });
  await install(s, [described('v1\n')]);
  const unnamed = await prepareUpdate(request(s, [{ managementId: 'guide', replacement: fileSelection('guide', 'GUIDE.md', 'v2\n') }]), { logging: 'off' });
  assert.deepEqual(reasons(unnamed), [['guide', 'invalid', ['replacement-unnamed']]]);
  const other = await prepareUpdate(request(s, [{ managementId: 'guide', replacement: described('v2\n', 'another') }]), { logging: 'off' });
  assert.deepEqual(reasons(other), [['guide', 'invalid', ['replacement-item-changed']]]);
  const same = await prepareUpdate(request(s, [{ managementId: 'guide', replacement: described('v2\n') }]), { logging: 'off' });
  assert.deepEqual([reasons(same), same.updates[0].from.item.contentSha256, same.updates[0].to.item.contentSha256], [[['guide', 'prepared', []]], sha('v1\n'), sha('v2\n')]);
  assert.equal(readFileSync(join(s.project, 'GUIDE.md'), 'utf8'), 'v1\n');
});

test('special dispositions and whole-request failures carry no preparation and write no history', async () => {
  const s = open();
  const replacement = fileSelection('team-guidance', 'TEAM.md', 'v2\n');
  for (const [body, controls, reason] of [
    [{ ...request(s, [{ managementId: 'team-guidance', replacement }]), mode: 'vibe' }, {}, 'request-shape'],
    [request(s, [{ managementId: 'team-guidance', replacement, extra: 1 }]), {}, 'request-shape'],
    [request(s, [{ managementId: 'team-guidance', replacement: [] }]), {}, 'request-shape'],
    [request(s, [{ managementId: 'team-guidance', replacement }]), { evidence: {} }, 'request-shape'],
    [request(s, [{ managementId: 'team-guidance', replacement }]), { authentication: { kind: 'none' } }, 'request-shape'],
    [{ ...request(s, [{ managementId: 'team-guidance', replacement }]), scope: 'both' }, {}, 'request-shape'],
    [request(s, [{ managementId: 'team-guidance', replacement: (({ id: _id, ...rest }) => rest)(replacement) }]), {}, 'request-shape']
  ]) {
    const result = await prepareUpdate(body, controls);
    assert.equal(result.schema, 'urn:aihq:core:managed-update-preparation:1.0.0');
    assert.deepEqual([result.disposition, result.diagnostics.map(item => item.reason)], ['invalid', [reason]], reason);
    assert.equal(Object.hasOwn(result, 'updates'), false);
  }
  const cancelled = await prepareUpdate(request(s, [{ managementId: 'team-guidance', replacement }]), { signal: AbortSignal.abort() });
  assert.deepEqual([cancelled.disposition, Object.hasOwn(cancelled, 'updates')], ['cancelled', false]);
  const absent = await prepareUpdate(request(s, [{ managementId: 'team-guidance', replacement }]), { logging: 'on' });
  assert.deepEqual([absent.disposition, reasons(absent)], ['not-prepared', [['team-guidance', 'absent', ['not-managed']]]]);
  assert.equal(existsSync(runsDir(s)), false, 'preflight-only dispositions write no history');
  const prepared = await prepare({ useCase: 'policy', policy: policy(), target: { project: s.project } }, { logging: 'off' });
  await apply(prepared.prepared, approve(prepared.review), { logging: 'off' });
  writeFileSync(projectReceipt(s), '{broken');
  const unverifiable = await prepareUpdate(request(s, [{ managementId: 'team-guidance', replacement }]));
  assert.deepEqual([unverifiable.disposition, unverifiable.diagnostics.map(item => item.reason)], ['unavailable', ['ownership-unverifiable']]);
});

test('an invalid replacement policy is not prepared: nothing is listed and every entry it held is invalid with the reason', async () => {
  const s = open();
  await install(s, [fileSelection('a', 'A.md', 'a\n')]);
  const broken = fileSelection('a', 'A.md', 'a2\n'); broken.requires = ['missing'];
  const result = await prepareUpdate(request(s, [{ managementId: 'a', replacement: broken }]), { logging: 'off' });
  assert.deepEqual([result.disposition, Object.hasOwn(result, 'preparation'), Object.hasOwn(result, 'reviewDigest'), result.updates[0].disposition, result.updates[0].members],
    ['not-prepared', false, false, 'invalid', []]);
  assert.ok(result.updates[0].diagnostics.length > 0);
  assert.equal(readFileSync(join(s.project, 'A.md'), 'utf8'), 'a\n');
});

test('the published schema describes the request, and every result shape here conforms', async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schemas = new URL('../dist/core/schemas/', import.meta.url);
  for (const family of readdirSync(schemas)) for (const file of readdirSync(new URL(`${family}/`, schemas)))
    if (file.endsWith('.json')) ajv.addSchema(JSON.parse(readFileSync(new URL(`${family}/${file}`, schemas), 'utf8')));
  const id = 'urn:aihq:core:managed-update-preparation:1.0.0';
  const requestSchema = ajv.getSchema(`${id}#/$defs/request`);
  const s = open();
  const body = request(s, [{ managementId: 'a', replacement: fileSelection('a', 'A.md', 'a2\n') }]);
  assert.equal(requestSchema(body), true, JSON.stringify(requestSchema.errors));
  assert.equal(requestSchema({ ...body, updates: [{ managementId: 'a' }] }), false);
  const validate = ajv.getSchema(id);
  await install(s, [fileSelection('a', 'A.md', 'a\n')]);
  const prepared = await prepareUpdate(body, { logging: 'off' });
  const { prepared: _handle, ...projection } = prepared.preparation;
  for (const result of [{ ...prepared, preparation: projection }, await prepareUpdate(request(s, []))])
    assert.equal(validate(JSON.parse(JSON.stringify(result))), true, JSON.stringify(validate.errors));
  assert.equal(validate(JSON.parse(readFileSync(new URL('../dist/fixtures/core/managed-update-preparation/1.0.0/refuse.json', import.meta.url), 'utf8'))), false);
});
