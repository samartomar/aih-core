import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getGuidance, renderSupportMarkdown } from '../dist/core/support.js';
import { prepare, apply } from '../dist/core/index.js';
import { contractSupport, validatePreparedWork13, validatePreparedWork14 } from '../dist/core/contracts.js';
import { preparedWorkValidators, runResultValidators } from '../dist/core/internal/produced-validation.js';
import { authorize, sandbox } from './hook-group-fixture.mjs';
import { enterprisePolicy, fakeFetch, orgDocument, orgRoutes, orgSource } from './fixtures/github-org.mjs';
import { policy } from './fixture.mjs';
import { deriveGuidance } from '../dist/harness/guidance.mjs';

const options = { platform: 'darwin' };
const sentinel = 'SENTINEL-support-family-7f3a';
const trust = name => JSON.parse(readFileSync(new URL(`./fixtures/trust-contracts/${name}.json`, import.meta.url), 'utf8'));
const macos = name => JSON.parse(readFileSync(new URL(`./fixtures/macos-session/${name}.json`, import.meta.url), 'utf8'));
const wrap = (review, status = 'ready', diagnostics = []) =>
  ({ status, runId: sentinel, review, diagnostics, record: { status: 'disabled', reason: 'logging-off' } });
const decode = markdown => markdown.replace(/\\([&<>"'\\`*_[\]{}()#+.!|~\-])/g, '$1');
/** Guidance and Markdown both succeed and never repeat result free text. */
function present(input, platform = options) {
  const guidance = getGuidance(input, platform), report = renderSupportMarkdown(input, platform);
  assert.equal(guidance.status, 'complete', JSON.stringify(guidance.diagnostics));
  assert.equal(report.status, 'rendered', JSON.stringify(report.diagnostics));
  assert.doesNotMatch(JSON.stringify(guidance) + report.markdown, new RegExp(sentinel));
  return { guidance, markdown: decode(report.markdown) };
}
function refused(input, code) {
  const guidance = getGuidance(input, options), report = renderSupportMarkdown(input, options);
  assert.equal(guidance.status, 'invalid'); assert.deepEqual(guidance.items, []);
  assert.equal(guidance.diagnostics[0].code, code, JSON.stringify(input.result.schema ?? input.result.review?.schema));
  assert.deepEqual(report, { status: 'invalid', diagnostics: guidance.diagnostics });
}

test('trust repair and certificate-export families (prepared-work and run-result 1.2.0) give guidance and Markdown', () => {
  const partial = trust('run-result-1.2-partial');
  partial.diagnostics[0].message = sentinel;
  const repairRun = present({ kind: 'run', result: partial });
  assert.match(repairRun.markdown, /Package: @aihq\/core 1\.0\.0-dev\.6/);
  assert.match(repairRun.markdown, /Status: incomplete/);
  assert.ok(repairRun.guidance.items.some(item => item.id === 'result-status' && item.reason === 'incomplete'));
  assert.ok(repairRun.guidance.items.some(item => item.evidenceIds.includes('/diagnostics/0')));

  const stale = present({ kind: 'run', result: trust('run-result-1.2-stale') });
  assert.equal(stale.guidance.items[0].reason, 'rejected');
  assert.equal(stale.guidance.items.flatMap(item => item.repairs).length, 0, 'certificate export never suggests a repair');
  assert.match(stale.markdown, /Package: unavailable/);
  present({ kind: 'run', result: trust('run-result-1.2-complete') });
  present({ kind: 'run', result: trust('run-result-1.2-blocked') });

  const exportReview = present({ kind: 'prepare', result: wrap(trust('prepared-work-1.2-ready')) });
  assert.deepEqual(exportReview.guidance.items, []);
  assert.match(exportReview.markdown, /Result: prepare/);
  const blocked = present({ kind: 'prepare', result: wrap(trust('prepared-work-1.2-blocked'), 'blocked') });
  assert.equal(blocked.guidance.items[0].reason, 'blocked');

  // A Core-defined trust operation keeps its shipped target and repair suggestion.
  const review = trust('prepared-work-1.2-partial');
  review.operations[0] = { ...review.operations[0], id: 'trust/git-config', effects: 'unavailable',
    details: { ...review.operations[0].details, reason: 'certificate-chain' } };
  const suggested = present({ kind: 'prepare', result: wrap(review, 'partial'), repair: { id: 'user-tools-ca', targets: ['git'] } });
  const item = suggested.guidance.items.find(entry => entry.evidenceIds.includes('/review/operations/0'));
  assert.equal(item.target, 'git');
  assert.deepEqual(item.repairs.map(repair => [repair.id, repair.targets]), [['user-tools-ca', ['git']]]);
});

test('trust and policy reviews under prepared-work 1.4.0 are admitted by the 1.4.0 validator', async () => {
  // The 1.4.0 trust variant keeps the 1.2.0 trust review members.
  const trustReview = { ...trust('prepared-work-1.2-partial'), schema: 'urn:aihq:core:prepared-work:1.4.0' };
  assert.equal(validatePreparedWork14(trustReview).valid, true, JSON.stringify(validatePreparedWork14(trustReview).diagnostics));
  const trusted = present({ kind: 'prepare', result: wrap(trustReview, 'partial') });
  assert.match(trusted.markdown, /Package: @aihq\/core 1\.0\.0-dev\.6/);

  const s = sandbox('aih-support-14-');
  try {
    const policy = { schema: 'urn:aihq:core:execution-policy:1.2.0', mode: 'vibe', selections: [{
      id: 'ini', managementId: 'ini', scope: 'project', configuration: {}, requires: [], recipe: { inline: {
        schema: 'urn:aihq:core:recipe:1.2.0', id: 'ini-fixture', description: 'Bounded INI option',
        inputs: {}, materials: [], targets: ['project'], prerequisites: [], checks: [], operations: [{
          id: 'config', purpose: 'Set selected INI option', kind: 'config.entries', format: 'ini', scope: 'project',
          target: { root: 'project', segments: [{ literal: 'settings.ini' }] }, requires: [], checks: [],
          entries: [{ path: ['global', 'cert'], action: 'set', value: { literal: '/team.pem' } }] }] } } }] };
    const prepared = await prepare({ useCase: 'policy', target: { project: s.project }, policy }, { logging: 'off' });
    assert.equal(prepared.status, 'ready', JSON.stringify(prepared.diagnostics));
    assert.equal(prepared.review.schema, 'urn:aihq:core:prepared-work:1.4.0');
    const reviewed = present({ kind: 'prepare', result: prepared });
    assert.match(reviewed.markdown, /Status: ready/); assert.match(reviewed.markdown, /1 operations/);
    const result = await apply(prepared.prepared, authorize(prepared), { logging: 'off' });
    assert.equal(result.schema, 'urn:aihq:core:run-result:1.1.0');
    assert.match(present({ kind: 'run', result }).markdown, /Status: complete/);
  } finally { s.dispose(); }
});

test('macOS session families (prepared-work and run-result 1.3.0) give guidance and Markdown', () => {
  const review = macos('prepared-work-1.3-desktop');
  review.operations[0] = { ...review.operations[0], effects: 'unavailable', details: { ...review.operations[0].details, reason: 'certificate-chain' } };
  assert.equal(validatePreparedWork13(review).valid, true, JSON.stringify(validatePreparedWork13(review).diagnostics));
  const prepared = present({ kind: 'prepare', result: wrap(review, 'partial'), repair: { id: 'node-npm-ca', targets: ['node'] } });
  const item = prepared.guidance.items.find(entry => entry.evidenceIds.includes('/review/operations/0'));
  assert.equal(item.target, 'node', 'trust/node-config is attributed through the shipped definition');
  assert.match(prepared.markdown, /Package: @aihq\/core 1\.0\.0-dev\.9/);
  present({ kind: 'prepare', result: wrap(macos('prepared-work-1.3-blocked'), 'blocked') });

  const desktop = macos('run-result-1.3-desktop');
  desktop.diagnostics[0].message = sentinel;
  const run = present({ kind: 'run', result: desktop });
  assert.equal(run.guidance.items[0].reason, 'incomplete');
  assert.ok(run.guidance.items.some(entry => entry.evidenceIds.includes('/operations/0')), 'unavailable verification needs action');
  assert.ok(run.guidance.items.some(entry => entry.evidenceIds.includes('/diagnostics/0')));
  assert.match(run.markdown, /Package: unavailable/);
  assert.match(present({ kind: 'run', result: macos('run-result-1.3-complete') }).markdown, /Status: complete/);
});

test('targeted organization reviews (prepared-work 1.5.0) give policy guidance without authored identifiers', async () => {
  const s = sandbox('aih-support-15-');
  const originalFetch = globalThis.fetch;
  try {
    const entry = orgDocument().selections[0];
    const document = obligation => Buffer.from(JSON.stringify({ schema: 'urn:aihq:core:organization-policy:1.1.0', id: 'example-org-policy',
      selections: [{ ...entry, obligation }] }));
    const targeted = async (bytes, clients) => {
      globalThis.fetch = fakeFetch(orgRoutes({ bytes }));
      return prepare({ useCase: 'policy', policy: enterprisePolicy(), target: { project: s.project }, organizationSource: orgSource(),
        organizationTarget: { schema: 'urn:aihq:core:organization-target:1.0.0', client: 'codex' } }, { logging: 'off' });
    };
    const ready = await targeted(document('required'));
    assert.equal(ready.status, 'ready', JSON.stringify(ready.diagnostics));
    assert.equal(ready.review.schema, 'urn:aihq:core:prepared-work:1.5.0');
    const presented = present({ kind: 'prepare', result: ready });
    assert.deepEqual(presented.guidance.items, []);
    assert.match(presented.markdown, /Status: ready/);
    assert.doesNotMatch(presented.markdown, /project-guidance|example-org-policy|Example-Org/);

    const denied = await targeted(Buffer.from(JSON.stringify({ schema: 'urn:aihq:core:organization-policy:1.1.0', id: 'example-org-policy',
      selections: [{ ...entry, obligation: 'required', clients: ['claude'] }] })));
    assert.equal(denied.status, 'blocked');
    const blocked = present({ kind: 'prepare', result: denied });
    assert.deepEqual(blocked.guidance.items.filter(item => item.reason === 'authority-denied').map(item => [item.id, item.target]),
      [['access-review', 'policy'], ['managed-access', 'policy']]);
  } finally { globalThis.fetch = originalFetch; s.dispose(); }
});

test('a Core STATE_CONFLICT existing-content Prepare gets specific conflict guidance; unknown reasons still fall back', async () => {
  const s = sandbox('aih-support-conflict-');
  const originalFetch = globalThis.fetch;
  try {
    s.write('TEAM.md', `${sentinel}\n`);
    globalThis.fetch = fakeFetch(orgRoutes({ bytes: Buffer.from(JSON.stringify({ schema: 'urn:aihq:core:organization-policy:1.1.0',
      id: 'example-org-policy', selections: [{ ...orgDocument().selections[0], obligation: 'required' }] })) }));
    const blocked = await prepare({ useCase: 'policy', policy: enterprisePolicy(), target: { project: s.project }, organizationSource: orgSource(),
      organizationTarget: { schema: 'urn:aihq:core:organization-target:1.0.0', client: 'codex' } }, { logging: 'off' });
    assert.equal(blocked.review.schema, 'urn:aihq:core:prepared-work:1.5.0');
    assert.deepEqual(blocked.review.conflicts.map(item => [item.code, item.reason]), [['STATE_CONFLICT', 'existing-content']]);
    const { guidance, markdown } = present({ kind: 'prepare', result: blocked });
    assert.equal(guidance.items.some(item => item.reason === 'unrecognized-diagnostic'), false, JSON.stringify(guidance.items));
    const developer = guidance.items.filter(item => item.id === 'content-conflict');
    assert.deepEqual(developer.map(item => [item.audience, item.target, item.reason, item.evidenceIds]),
      [['developer', 'policy', 'existing-content', ['/diagnostics/0']], ['developer', 'policy', 'existing-content', ['/review/conflicts/0']]]);
    assert.match(developer[0].steps.join(' '), /exact observed digest/);
    assert.doesNotMatch(developer[0].steps.join(' '), /bypass|skip|force/i);
    assert.deepEqual(guidance.items.filter(item => item.id === 'managed-content-decision').map(item => item.audience), ['administrator', 'administrator']);
    assert.match(markdown, /Existing content at a selected target differs from the reviewed content/);
    assert.doesNotMatch(markdown, /project-guidance|example-org-policy|TEAM\.md/);

    // The same conflict in a vibe policy has no administrator decision.
    const local = await prepare({ useCase: 'policy', policy: policy(), target: { project: s.project } }, { logging: 'off' });
    assert.deepEqual(local.review.conflicts.map(item => item.reason), ['existing-content']);
    const vibe = present({ kind: 'prepare', result: local }).guidance.items;
    assert.equal(vibe.filter(item => item.id === 'content-conflict').length, 2);
    assert.equal(vibe.some(item => item.audience === 'administrator'), false);

    // An unknown Core reason, or a conflict reason under another code, still falls back to generic review.
    for (const [code, reason] of [['STATE_CONFLICT', 'future-conflict-reason'], ['INPUT_INVALID', 'existing-content']]) {
      const changed = { ...local, prepared: undefined, diagnostics: [{ code, reason, message: sentinel }] };
      const items = present({ kind: 'prepare', result: changed }).guidance.items.filter(item => item.evidenceIds.includes('/diagnostics/0'));
      assert.deepEqual(items.map(item => item.id), ['diagnostic-review'], `${code}/${reason}`);
      assert.notEqual(items[0].reason, 'existing-content');
    }

    // Other Core STATE_CONFLICT families keep their reason and get their own developer item.
    for (const [reason, id] of [['duplicate-json-key', 'target-content-unsupported'], ['unsupported-json-edit', 'target-content-unsupported'],
      ['existing-trust-uncomposable', 'target-content-unsupported'], ['managed-content-changed', 'managed-content-changed'],
      ['trust-custody-pending', 'custody-reconcile'], ['trust-custody-conflict', 'custody-reconcile']]) {
      const changed = { ...local, prepared: undefined, diagnostics: [{ code: 'STATE_CONFLICT', reason, message: sentinel }] };
      const items = present({ kind: 'prepare', result: changed }).guidance.items.filter(item => item.evidenceIds.includes('/diagnostics/0'));
      assert.deepEqual(items.map(item => [item.id, item.audience, item.reason]), [[id, 'developer', reason]], reason);
      assert.doesNotMatch(items[0].steps.join(' '), /bypass|skip|force/i);
    }

    // Outside policy, AUTHORITY_DENIED stays an access denial even when it carries a conflict reason.
    for (const code of ['AUTHORITY_DENIED', 'INPUT_INVALID', 'STATE_CONFLICT']) {
      const [item] = deriveGuidance({ kind: 'prepare', useCase: 'repair', platform: 'darwin',
        facts: [{ kind: 'diagnostic', evidenceId: '/diagnostics/0', code, reason: 'existing-content' }] });
      assert.deepEqual([item.id, item.reason], code === 'AUTHORITY_DENIED' ? ['access-review', 'authority-denied'] :
        code === 'STATE_CONFLICT' ? ['content-conflict', 'existing-content'] : ['diagnostic-review', 'unrecognized-diagnostic'], code);
    }
  } finally { globalThis.fetch = originalFetch; s.dispose(); }
});

test('every produced prepared-work and run-result format is dispatched; unknown, relabelled and malformed ones are refused', () => {
  const produced = contractSupport.contracts.filter(item => item.role !== 'accepts' && /:(?:prepared-work|run-result):/.test(item.id)).map(item => item.id).sort();
  assert.deepEqual(produced, ['urn:aihq:core:prepared-work:1.0.0', 'urn:aihq:core:prepared-work:1.1.0', 'urn:aihq:core:prepared-work:1.2.0',
    'urn:aihq:core:prepared-work:1.3.0', 'urn:aihq:core:prepared-work:1.4.0', 'urn:aihq:core:prepared-work:1.5.0', 'urn:aihq:core:prepared-work:1.6.0',
    'urn:aihq:core:run-result:1.0.0', 'urn:aihq:core:run-result:1.1.0', 'urn:aihq:core:run-result:1.2.0', 'urn:aihq:core:run-result:1.3.0',
    'urn:aihq:core:run-result:1.4.0'],
    'a newly produced family must be added to support dispatch and this test');
  assert.deepEqual([...Object.keys(preparedWorkValidators), ...Object.keys(runResultValidators)].sort(), produced,
    'support dispatch covers exactly the produced prepared-work and run-result formats');
  const run = trust('run-result-1.2-partial'), review = macos('prepared-work-1.3-desktop');
  for (const schema of ['urn:aihq:core:run-result:1.9.0', 'urn:aihq:core:run-result:2.0.0', 'urn:aihq:core:run-result:1.2.0-beta',
    'urn:aihq:core:run-result:1.2', 'URN:AIHQ:CORE:RUN-RESULT:1.2.0', 'urn:aihq:core:run-result:1.2.0 '])
    refused({ kind: 'run', result: { ...run, schema } }, 'SCHEMA_UNSUPPORTED');
  for (const schema of ['urn:aihq:core:prepared-work:1.9.0', 'urn:aihq:core:prepared-work:1.3.0.1', 'urn:aihq:core:prepared-work:1'])
    refused({ kind: 'prepare', result: wrap({ ...review, schema }) }, 'SCHEMA_UNSUPPORTED');
  // A known identity admits only its own contract: no neighbouring-version fallback.
  refused({ kind: 'run', result: { ...run, schema: 'urn:aihq:core:run-result:1.3.0' } }, 'INPUT_INVALID');
  refused({ kind: 'run', result: { ...macos('run-result-1.3-complete'), schema: 'urn:aihq:core:run-result:1.2.0' } }, 'INPUT_INVALID');
  refused({ kind: 'prepare', result: wrap({ ...review, schema: 'urn:aihq:core:prepared-work:1.2.0' }) }, 'INPUT_INVALID');
  refused({ kind: 'prepare', result: wrap({ ...trust('prepared-work-1.2-ready'), schema: 'urn:aihq:core:prepared-work:1.5.0' }) }, 'INPUT_INVALID');
  refused({ kind: 'prepare', result: wrap({ ...trust('prepared-work-1.2-ready'), schema: 'urn:aihq:core:prepared-work:1.6.0' }) }, 'INPUT_INVALID');
  refused({ kind: 'run', result: { ...run, schema: 'urn:aihq:core:run-result:1.4.0' } }, 'INPUT_INVALID');
  refused({ kind: 'run', result: { ...run, extra: sentinel } }, 'INPUT_INVALID');
  refused({ kind: 'run', result: { ...run, schema: 12 } }, 'INPUT_INVALID');
  refused({ kind: 'run', result: (({ schema, ...rest }) => rest)(run) }, 'INPUT_INVALID');
  refused({ kind: 'prepare', result: wrap({ ...review, unrecognized: sentinel }) }, 'INPUT_INVALID');
  refused({ kind: 'prepare', result: { ...wrap(review), status: 'done' } }, 'INPUT_INVALID');
  refused({ kind: 'prepare', result: wrap(sentinel) }, 'INPUT_INVALID');
  const semantic = structuredClone(trust('run-result-1.2-partial'));
  semantic.inputs.trust.sources = [...semantic.inputs.trust.sources, semantic.inputs.trust.sources[0]];
  refused({ kind: 'run', result: semantic }, 'INPUT_INVALID');
});
