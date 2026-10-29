// Runs inside a disposable consumer with the packed @aihq/core installed; public entries only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { contractSupport as harnessSupport, deriveCellSupport, listTools, selectBindingCell, toolBindingKinds, toolBindings,
  toolRegistry, validateToolBinding } from '@aihq/core/harness';
import bindingSchema from '@aihq/core/harness/schemas/tool-binding/1.0.0.json' with { type: 'json' };
import acceptBinding from '@aihq/core/fixtures/harness/tool-binding/1.0.0/accept.json' with { type: 'json' };
import refuseBinding from '@aihq/core/fixtures/harness/tool-binding/1.0.0/refuse.json' with { type: 'json' };
import supportCases from '@aihq/core/fixtures/harness/tool-binding/1.0.0/support-cases.json' with { type: 'json' };
import runRecord from '@aihq/core/harness/run-records/canary-2026-10-23-windows-x64.json' with { type: 'json' };
import run1Record from '@aihq/core/harness/run-records/canary-run1-2026-10-29-windows-x64.json' with { type: 'json' };

const BINDING = 'urn:aihq:harness:tool-binding:1.0.0';
const RUN_RECORD = createHash('sha256')
  .update(readFileSync(new URL(import.meta.resolve('@aihq/core/harness/run-records/canary-2026-10-23-windows-x64.json')))).digest('hex');
const RUN1_RECORD = createHash('sha256')
  .update(readFileSync(new URL(import.meta.resolve('@aihq/core/harness/run-records/canary-run1-2026-10-29-windows-x64.json')))).digest('hex');
/** The 29 October run observed only Claude hooks (and the entry file, which is not a binding cell). */
const isRun1 = item => item.runRecordDigest === RUN1_RECORD;
const KINDS = ['skill', 'agent', 'command', 'rule', 'hook', 'mcp-server', 'document'];
const WINDOWS = { os: 'windows', arch: 'x64' };
const plain = value => JSON.parse(JSON.stringify(value));
const byTool = Object.fromEntries(toolBindings.map(binding => [binding.tool, binding]));
const cell = (tool, kind) => byTool[tool].layouts[kind];
const reasons = result => result.diagnostics.map(item => [item.code, item.reason]);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const observation = fields => ({ toolVersion: '1.0.0', observedAt: '2026-10-23T00:00:00.000Z', coreVersion: '1.0.0-dev.37',
  os: 'windows', arch: 'x64', isolation: 'sandbox', runRecordDigest: RUN_RECORD,
  delivered: 'delivered', registered: 'not-checked', recognised: 'not-run', ...fields });
const checks = [];
const check = (name, body) => { body(); checks.push(name); };

check('the binding table is published with its schema, one binding per observed tool', () => {
  assert.equal(bindingSchema.$id, BINDING);
  assert.partialDeepStrictEqual(harnessSupport.contracts.find(item => item.id === BINDING),
    { id: BINDING, role: 'produces', schemaExport: '@aihq/core/harness/schemas/tool-binding/1.0.0.json' });
  assert.deepEqual([...toolBindingKinds], KINDS);
  assert.deepEqual(toolBindings.map(binding => binding.tool), ['claude', 'codex', 'kiro', 'copilot', 'antigravity']);
  const ajv = new Ajv2020({ strict: true });
  const registryIds = toolRegistry.tools.map(entry => entry.id);
  for (const binding of toolBindings) {
    assert.equal(ajv.validate(bindingSchema, binding), true, JSON.stringify(ajv.errors));
    assert.deepEqual(validateToolBinding(binding), { valid: true, diagnostics: [] });
    assert.ok(registryIds.includes(binding.tool));
    assert.deepEqual(Object.keys(binding.layouts), KINDS);
    assert.ok(Object.isFrozen(binding) && Object.isFrozen(binding.layouts) && Object.values(binding.layouts).every(Object.isFrozen));
  }
  assert.ok(Object.isFrozen(toolBindings));
  assert.deepEqual(acceptBinding, plain(byTool.claude), 'the accept fixture is the shipped Claude binding');
  assert.equal(validateToolBinding(acceptBinding).valid, true);
  assert.deepEqual(reasons(validateToolBinding(refuseBinding)), [['INPUT_INVALID', 'support-not-derived']]);
});

check('each digest is the SHA-256 of the canonical binding without its digest', () => {
  for (const { digest, ...rest } of toolBindings)
    assert.equal(digest, createHash('sha256').update(canonical(plain(rest))).digest('hex'), rest.tool);
  const { digest, ...changed } = structuredClone(plain(byTool.claude));
  assert.equal(createHash('sha256').update(canonical(changed)).digest('hex'), digest);
  changed.layouts.skill.reason = 'Changed.';
  assert.notEqual(createHash('sha256').update(canonical(changed)).digest('hex'), digest);
});

check('the 23 October 2026 Windows observations are seeded with scope and run record', () => {
  const versions = { claude: '2.1.308', codex: '0.163.0', kiro: '2.33.1', copilot: '1.0.103', antigravity: '1.4.6' };
  const isolation = { claude: 'env-redirect-outside-profile', codex: 'env-redirect-outside-profile',
    copilot: 'env-redirect-outside-profile', kiro: 'sandbox', antigravity: 'sandbox' };
  for (const binding of toolBindings) for (const kind of KINDS) for (const item of binding.layouts[kind].observations) {
    if (isRun1(item)) {
      assert.deepEqual([binding.tool, kind, item.os, item.arch, item.coreVersion, item.toolVersion, item.isolation, item.recognised],
        ['claude', 'hook', 'windows', 'x64', '1.0.0-dev.38', '2.1.312', 'env-redirect-outside-profile', 'recognised']);
      continue;
    }
    assert.deepEqual([item.os, item.arch, item.runRecordDigest, item.coreVersion], ['windows', 'x64', RUN_RECORD, '1.0.0-dev.37']);
    assert.ok(item.observedAt.startsWith('2026-10-23T'), item.observedAt);
    // Model-free list commands ran on the host, inside the user profile; they are kept but never count.
    if (item.isolation === 'env-redirect-inside-profile') assert.equal(item.recognised, 'not-run');
    else assert.deepEqual([item.toolVersion, item.isolation], [versions[binding.tool], isolation[binding.tool]], `${binding.tool} ${kind}`);
  }
  const supports = Object.fromEntries(toolBindings.map(binding => [binding.tool, KINDS.map(kind => binding.layouts[kind].support)]));
  assert.deepEqual(supports, {
    claude: ['native', 'unconfirmed', 'native', 'native', 'native', 'native', 'native'],
    codex: ['unconfirmed', 'unconfirmed', 'unconfirmed', 'native', 'unconfirmed', 'native', 'native'],
    kiro: ['unconfirmed', 'none', 'none', 'native', 'unconfirmed', 'unconfirmed', 'native'],
    copilot: ['native', 'none', 'none', 'native', 'unconfirmed', 'native', 'native'],
    antigravity: ['unconfirmed', 'unconfirmed', 'unconfirmed', 'native', 'unconfirmed', 'native', 'native']
  });
  assert.deepEqual(cell('antigravity', 'skill').observations.map(item => [item.isolation, item.recognised]), [['sandbox', 'listed-only']]);
  for (const [tool, kind] of Object.entries({ kiro: 'agent', copilot: 'agent' })) assert.ok(cell(tool, kind).reason.includes('converter'));
  for (const binding of toolBindings) for (const kind of KINDS) {
    const layout = binding.layouts[kind];
    if (layout.support !== 'native') assert.ok(layout.reason.length > 0);
    assert.equal(layout.convert, undefined, 'no converter output has been observed');
  }
});

check('every observation names the published run record and claims no more than it shows', () => {
  assert.equal(runRecord.run, 'canary-2026-10-23-windows-x64');
  assert.deepEqual(runRecord.platform, WINDOWS);
  assert.equal(runRecord.coreVersion, '1.0.0-dev.37');
  const session = tool => runRecord.sessions.find(item => item.tool === tool);
  for (const binding of toolBindings) for (const kind of KINDS) for (const item of binding.layouts[kind].observations) {
    if (isRun1(item)) {
      // The 29 October record: session A started at the observation time; its hook cell shows the level claimed.
      assert.equal(run1Record.run, 'canary-run1-2026-10-29-windows-x64');
      assert.deepEqual(run1Record.realProfilePathsTouched, []);
      assert.ok(run1Record.sessions[0].startedAt.startsWith(item.observedAt.slice(0, 23)), item.observedAt);
      assert.equal(item.recognised, run1Record.cells.find(entry => entry.tool === binding.tool && entry.kind === kind).recognised);
      assert.equal(item.registered, 'not-checked');
      continue;
    }
    assert.equal(item.runRecordDigest, RUN_RECORD);
    if (item.isolation === 'env-redirect-inside-profile') {
      const listing = runRecord.listings.find(entry => entry.tool === binding.tool && entry.kind === kind);
      assert.deepEqual([item.toolVersion, item.observedAt, item.registered], [listing.toolVersion, listing.observedAt, listing.registered]);
      continue;
    }
    const run = session(binding.tool);
    assert.deepEqual([item.toolVersion, item.isolation, item.observedAt], [run.toolVersion, run.isolation, run.startedAt]);
    const recorded = runRecord.cells.find(entry => entry.tool === binding.tool && entry.kind === (kind === 'document' ? 'skill' : kind));
    if (kind === 'document') assert.ok(recorded.delivered.some(file => file.path.endsWith('/LICENSE')));
    else assert.equal(item.recognised, recorded.recognised, `${binding.tool} ${kind}`);
    // In a session the only registration shown is an MCP server the tool started.
    if (item.registered !== 'not-checked') assert.ok(kind === 'mcp-server' && run.mcpEvents.includes('started'));
  }
  assert.deepEqual(cell('codex', 'skill').observations.map(item => [item.isolation, item.registered, item.recognised]),
    [['env-redirect-outside-profile', 'not-checked', 'listed-only'], ['env-redirect-inside-profile', 'visible-to-model', 'not-run']]);
});

check('support is derived only from qualifying observations', () => {
  const derive = (kind, ...observations) => deriveCellSupport({ kind, observations }).support;
  assert.equal(derive('skill', observation({ recognised: 'listed-only' })), 'unconfirmed', 'listed-only alone never counts');
  assert.equal(derive('skill', observation({ recognised: 'contaminated' })), 'unconfirmed');
  assert.equal(derive('skill', observation({ registered: 'registered' })), 'native');
  assert.equal(derive('skill', observation({ registered: 'visible-to-model', recognised: 'listed-only' })), 'native');
  assert.equal(derive('mcp-server', observation({ registered: 'registered-pending-approval' })), 'native');
  assert.equal(derive('rule', observation({ recognised: 'recognised' })), 'native');
  assert.equal(derive('rule', observation({ recognised: 'recognised', isolation: 'env-redirect-inside-profile' })), 'unconfirmed');
  assert.equal(derive('rule', observation({ recognised: 'recognised', isolation: 'os-account' })), 'native');
  assert.equal(derive('rule', observation({ recognised: 'recognised', isolation: 'env-redirect-outside-profile' })), 'native');
  assert.equal(derive('document', observation({})), 'native', 'documents need only delivery');
  assert.equal(derive('document', observation({ delivered: 'not-delivered' })), 'unconfirmed');
  assert.equal(derive('skill', observation({})), 'unconfirmed', 'other kinds are not proven by delivery');
  assert.equal(derive('agent', observation({ recognised: 'not-recognised' })), 'none');
  assert.equal(derive('command', observation({ registered: 'not-registered' })), 'none');
  assert.equal(derive('command', observation({ registered: 'not-registered', isolation: 'env-redirect-inside-profile' })), 'unconfirmed');
  assert.equal(derive('hook'), 'unconfirmed', 'no observation gives unconfirmed');
  assert.throws(() => deriveCellSupport({ kind: 'reference', observations: [] }), TypeError);
  assert.equal(derive('skill', observation({ delivered: 'not-delivered', recognised: 'recognised' })), 'unconfirmed');
  assert.throws(() => deriveCellSupport({ kind: 'skill', observations: [{ recognised: 'recognised' }], installedVersion: '1.0' }), TypeError);
});

check('support is scoped to the observed platform', () => {
  const observations = [observation({ recognised: 'recognised' })];
  assert.equal(deriveCellSupport({ kind: 'rule', observations, platform: WINDOWS }).support, 'native');
  for (const platform of [{ os: 'linux', arch: 'x64' }, { os: 'macos', arch: 'arm64' }, { os: 'windows', arch: 'arm64' }])
    assert.deepEqual(deriveCellSupport({ kind: 'rule', observations, platform }), { support: 'unconfirmed', observed: 'none', stale: false });
});

check('a different installed version has no qualifying observation in either version direction', () => {
  const observations = [observation({ toolVersion: '2.1.308', recognised: 'recognised' })];
  const at = installedVersion => deriveCellSupport({ kind: 'skill', observations, platform: WINDOWS, installedVersion });
  assert.partialDeepStrictEqual(at('2.1.308'), { support: 'native', observed: 'recognised', stale: false });
  assert.deepEqual(at('2.1.200'), { support: 'unconfirmed', observed: 'none', stale: true });
  assert.deepEqual(at('2.1.309'), { support: 'unconfirmed', observed: 'none', stale: true });
  assert.deepEqual(at('3.0'), { support: 'unconfirmed', observed: 'none', stale: true });
  assert.equal(at('2.1.309').observedOn, undefined, 'a historical observation is never attributed to a different selected version');
  assert.throws(() => at('latest'), TypeError);
  const mixed = [observation({ toolVersion: '2.1.308', recognised: 'recognised' }),
    observation({ toolVersion: '2.1.309', registered: 'not-registered' })];
  assert.partialDeepStrictEqual(deriveCellSupport({ kind: 'skill', observations: mixed, platform: WINDOWS, installedVersion: '2.1.309' }),
    { support: 'none', observed: 'delivered', stale: false, observedOn: { toolVersion: '2.1.309' } });
  assert.partialDeepStrictEqual(selectBindingCell({ tool: 'codex', kind: 'rule', platform: WINDOWS, installedVersion: '0.164.0' }),
    { status: 'refused', reason: 'kind-not-native', cell: { support: 'unconfirmed' } });

});

check('the published support cases hold for the shipped table', () => {
  const expected = supportCases.cases.map(item => item.expect);
  assert.ok(expected.some(item => item.stale) && expected.some(item => item.support === 'unconfirmed'));
  for (const { expect, ...query } of supportCases.cases) {
    const derived = deriveCellSupport({ kind: query.kind, observations: cell(query.tool, query.kind).observations,
      platform: query.platform, installedVersion: query.installedVersion });
    assert.deepEqual({ support: derived.support, observed: derived.observed, stale: derived.stale }, expect, JSON.stringify(query));
  }
});

check('a hook requested for Kiro CLI is refused with that cell\'s reason', () => {
  const refused = selectBindingCell({ tool: 'kiro', kind: 'hook', platform: WINDOWS });
  assert.deepEqual(plain(refused), { status: 'refused', code: 'PREREQUISITE_UNAVAILABLE', reason: 'kind-not-native', tool: 'kiro', kind: 'hook',
    cell: { support: 'unconfirmed', reason: cell('kiro', 'hook').reason } });
  assert.partialDeepStrictEqual(selectBindingCell({ tool: 'copilot', kind: 'agent', platform: WINDOWS }),
    { status: 'refused', cell: { support: 'none' } });
  assert.partialDeepStrictEqual(selectBindingCell({ tool: 'claude', kind: 'skill', platform: { os: 'linux', arch: 'x64' } }),
    { status: 'refused', cell: { support: 'unconfirmed' } });
  // A Windows-only reason is never shown for another platform.
  assert.deepEqual(plain(selectBindingCell({ tool: 'claude', kind: 'agent', platform: { os: 'linux', arch: 'x64' } }).cell),
    { support: 'unconfirmed', reason: 'Not observed on linux x64; observations from another platform do not count.' });
  const selected = selectBindingCell({ tool: 'claude-code', kind: 'hook', platform: WINDOWS, installedVersion: '2.1.308' });
  assert.partialDeepStrictEqual(selected, { status: 'selected', tool: 'claude', kind: 'hook', support: 'native', observed: 'recognised',
    stale: false, digest: byTool.claude.digest });
  assert.equal(selected.layout, cell('claude', 'hook'));
  assert.partialDeepStrictEqual(selectBindingCell({ tool: 'cursor', kind: 'skill', platform: WINDOWS }),
    { status: 'refused', code: 'PREREQUISITE_UNAVAILABLE', reason: 'tool-not-observed' });
  assert.partialDeepStrictEqual(selectBindingCell({ tool: 'nope', kind: 'skill', platform: WINDOWS }),
    { status: 'refused', code: 'INPUT_INVALID', reason: 'unknown-tool' });
  assert.throws(() => selectBindingCell({ tool: 'kiro', kind: 'reference', platform: WINDOWS }), TypeError);
  assert.throws(() => selectBindingCell({ tool: 'kiro', kind: 'hook' }), TypeError);
  assert.throws(() => selectBindingCell({ tool: 'kiro', kind: 'hook', platform: { os: 'win32', arch: 'x64' } }), TypeError);
});

check('the validator refuses claims observations do not support', () => {
  const claude = () => structuredClone(plain(byTool.claude));
  const listedOnly = claude(); listedOnly.layouts.agent.support = 'native';
  assert.deepEqual(reasons(validateToolBinding(listedOnly)), [['INPUT_INVALID', 'support-not-derived']]);
  const unproven = claude(); unproven.layouts.skill.observations = [];
  assert.deepEqual(reasons(validateToolBinding(unproven)), [['INPUT_INVALID', 'support-not-derived']]);
  const noReason = claude(); noReason.layouts.agent.reason = '';
  assert.deepEqual(reasons(validateToolBinding(noReason)).map(([code]) => code), ['INPUT_INVALID']);
  const converted = claude(); converted.layouts.agent.convert = { to: 'toml', converter: 'example' };
  assert.deepEqual(reasons(validateToolBinding(converted)), [['INPUT_INVALID', 'convert-not-observed']]);
  const unknown = claude(); unknown.tool = 'claude-code';
  assert.deepEqual(reasons(validateToolBinding(unknown)), [['INPUT_INVALID', 'unknown-tool']]);
  const missing = claude(); delete missing.layouts.document;
  assert.deepEqual(reasons(validateToolBinding(missing)).map(([code]) => code), ['INPUT_INVALID']);
  const contradiction = claude(); contradiction.layouts.skill.observations[0].delivered = 'not-delivered';
  assert.deepEqual(reasons(validateToolBinding(contradiction)),
    [['INPUT_INVALID', 'observation-inconsistent'], ['INPUT_INVALID', 'support-not-derived']]);
  const isolation = claude(); isolation.layouts.rule.observations[0].isolation = 'container';
  assert.equal(validateToolBinding(isolation).valid, false);
  assert.deepEqual(reasons(validateToolBinding({ ...claude(), schema: 'urn:aihq:harness:tool-binding:2.0.0' })),
    [['SCHEMA_UNSUPPORTED', 'schema-unsupported']]);
});

check('listTools offers exactly the tools the binding table observes', () => {
  const observed = toolBindings.filter(binding => Object.values(binding.layouts).some(layout => layout.observations.length > 0))
    .map(binding => binding.tool);
  assert.deepEqual(listTools().map(entry => entry.id), observed);
});

console.log(JSON.stringify({ status: 'passed', checks }));
