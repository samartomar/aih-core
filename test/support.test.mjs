import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build, stop } from 'esbuild';
import { getGuidance, renderSupportMarkdown } from '@aihq/core/support';
import { formatGuidanceText } from '../dist/core/internal/guidance-text.js';

const sentinel = 'SENTINEL-c0ffee-secret';
const platform = { platform: 'linux' };
const pkg = { name: '@aihq/core', version: '1.0.0-dev.4' };
const effective = value => ({ value, origin: 'default' });
const diagnostic = (reason = 'state-protection', code = 'PREREQUISITE_UNAVAILABLE') => ({ reason, code, message: sentinel });
const check = (target = 'npm', reason = 'executable-missing', id = 'npm/tls/os/registry.npmjs.org') =>
  ({ id, target, outcome: 'unavailable', reason, detail: sentinel });
const inspect = (checks = []) => ({ kind: 'inspect', result: {
  status: 'incomplete', package: { ...pkg }, tools: [], observations: [], checks, repairChoices: [], diagnostics: [],
  effectiveOptions: { targets: effective('detected'), network: effective('declared'), probeConfiguredMcp: effective(false), budgetMs: effective(180000) },
  limits: { budgetMs: 180000, elapsedMs: 1, maxActiveProbes: 2 }, followUp: []
} });
const review = (useCase = 'policy') => ({
  schema: 'urn:aihq:core:prepared-work:1.0.0', useCase, mode: useCase === 'policy' ? 'vibe' : 'standalone',
  target: { scope: 'project', project: sentinel }, inputs: useCase === 'policy' ? { policySha256: sentinel, package: { ...pkg } } :
    { sourceSha256: sentinel, helperSha256: sentinel, certificates: [sentinel], package: { ...pkg } },
  operations: [], observations: [], conflicts: [], omissions: [], effectiveOptions: { logging: effective('off'), inputs: {} }, reviewDigest: sentinel
});
const prepare = (status = 'ready', useCase = 'policy') => ({ kind: 'prepare', result: {
  status, runId: sentinel, review: review(useCase), diagnostics: [], record: { status: 'written', reference: sentinel }
} });
const run = (completion = 'complete', useCase = 'policy') => ({ kind: 'run', result: {
  schema: 'urn:aihq:core:run-result:1.0.0', completion, useCase, runId: sentinel,
  inputs: review(useCase).inputs, effectiveOptions: { logging: effective('off') }, operations: [], checks: [], diagnostics: [],
  record: { status: 'written', reference: sentinel }, recovery: sentinel, followUp: [sentinel]
} });
const decode = markdown => markdown.replace(/\\([&<>"'\\`*_[\]{}()#+.!|~\-])/g, '$1');
function privacy(input, options = platform) {
  const guidance = getGuidance(input, options), report = renderSupportMarkdown(input, options);
  assert.equal(guidance.status, 'complete'); assert.equal(report.status, 'rendered');
  assert.doesNotMatch(JSON.stringify(guidance), /SENTINEL|c0ffee/); assert.doesNotMatch(report.markdown, /SENTINEL|c0ffee/);
  return { guidance, markdown: decode(report.markdown), raw: report.markdown };
}
function invalid(input, options = platform, code = 'INPUT_INVALID') {
  const guidance = getGuidance(input, options), report = renderSupportMarkdown(input, options);
  assert.deepEqual(guidance, { status: 'invalid', items: [], diagnostics: [{ code,
    reason: code === 'INPUT_INVALID' ? 'support-input' : 'schema-id',
    message: code === 'INPUT_INVALID' ? 'Use a supported public result.' : 'This result format is not supported.' }] });
  assert.deepEqual(report, { status: 'invalid', diagnostics: guidance.diagnostics }); assert.equal(Object.hasOwn(report, 'markdown'), false);
}

test('portable curl and MCP fixtures preserve attribution and identical ordered presentation content', () => {
  const input = inspect([check(), check('mcp', 'certificate-chain', 'mcp/tls/1')]);
  const { guidance, markdown } = privacy(input);
  assert.equal(guidance.items.find(item => item.id === 'missing-curl').target, 'curl');
  assert.deepEqual(guidance.items.find(item => item.id === 'missing-curl').evidenceIds, ['/checks/0']);
  const mcp = guidance.items.find(item => item.id === 'mcp-node-trust');
  assert.deepEqual(mcp.repairs[0].targets, ['node']); assert.equal(mcp.repairs[0].requiredInputs[0].name, 'caFile');
  assert.match(markdown, /diagnostic Node TLS probe/); assert.match(markdown, /Confirm which runtime/);
  assert.match(markdown, /Application or presence is not verification/); assert.match(markdown, /Review this report before sharing/);
  assert.match(markdown, /Check 1: unavailable/); assert.doesNotMatch(markdown, /registry.npmjs.org|mcp\/tls/);
  assert.ok(markdown.indexOf('Developer actions') < markdown.indexOf('Administrator actions'));
  const human = formatGuidanceText(guidance.items);
  let humanOffset = 0, markdownOffset = 0;
  for (const item of guidance.items) {
    for (const value of [item.summary, ...item.steps]) {
      humanOffset = human.indexOf(value, humanOffset); markdownOffset = markdown.indexOf(value, markdownOffset);
      assert.ok(humanOffset >= 0 && markdownOffset >= 0, value); humanOffset += value.length; markdownOffset += value.length;
    }
    for (const repair of item.repairs) for (const value of [repair.id, ...repair.targets, ...repair.requiredInputs.flatMap(input => [input.name, input.type, input.description])]) {
      assert.ok(human.includes(value), value); assert.ok(markdown.includes(value), value);
    }
  }
  assert.deepEqual(getGuidance(input, platform), guidance); assert.equal(renderSupportMarkdown(input, platform).markdown, renderSupportMarkdown(input, platform).markdown);
});

test('all freeform result fields and unknown fields are omitted by allowlist', () => {
  const url = `https://user:${sentinel}@example.invalid/${sentinel}?token=${sentinel}`;
  const payload = `<script>${sentinel}</script>\n# [${sentinel}](${url})\u0000`;
  const input = inspect([check('npm', 'node-certificate-chain', 'npm/tls/node/registry.npmjs.org'), check(sentinel, sentinel, sentinel)]);
  input.result.tools = [{ id: 'node', label: payload, state: 'runnable', selection: 'requested', config: payload, unrelated: sentinel }];
  input.result.observations = [{ id: 'npm/resolution', target: 'npm', detail: payload }];
  input.result.checks[0].detail = payload; input.result.diagnostics = [{ ...diagnostic(sentinel, sentinel), path: payload, guidance: payload, encountered: url, supported: [url] }];
  input.result.repairChoices = [{ target: sentinel, guidance: payload, reason: sentinel }]; input.result.followUp = [payload]; input.result.unrecognized = { token: sentinel, description: payload };
  const { guidance, markdown, raw } = privacy(input);
  assert.ok(guidance.items.some(item => item.reason === 'unrecognized-diagnostic' && item.summary === 'Review the diagnostic and inspect again.'));
  assert.doesNotMatch(raw, /script|example.invalid|https:|user:|\u0000/);
  assert.match(markdown, /unrecognized diagnostic/);
  for (const input of [prepare('blocked'), run('incomplete')]) {
    input.result.diagnostics = [diagnostic('state-protection')];
    input.result.unrecognized = { args: [payload], env: { SAFE_LOOKING: sentinel }, certificate: payload, sourceId: sentinel, policyName: sentinel };
    if (input.kind === 'prepare') {
      input.result.review.mode = 'enterprise';
      input.result.review.inputs.organization = { source: { provider: 'github', repository: { owner: sentinel, name: sentinel }, path: payload,
        revision: { kind: 'branch', value: sentinel } }, policyId: sentinel, contentDigest: sentinel, resolvedCommit: sentinel, blobId: sentinel,
        helper: { id: 'github-policy-reader', package: { ...pkg } } };
      input.result.review.observations = [{ id: sentinel, reason: payload }];
      input.result.review.operations = [{ id: sentinel, purpose: payload, kind: 'process.run', scope: 'project', effects: 'unavailable', ownership: 'unowned', requires: [sentinel], checks: [],
        details: { reason: 'certificate-chain', target: payload, args: [payload], env: { SAFE: sentinel }, executable: payload, content: payload, stdin: sentinel, material: sentinel, blockId: sentinel } }];
      input.result.review.conflicts = [{ ...diagnostic(sentinel, sentinel), path: payload }]; input.result.review.omissions = [diagnostic(sentinel, sentinel)];
    } else {
      input.result.operations = [{ id: 'trust/gradle-config', application: 'failed', reason: 'certificate-chain', verification: { status: 'failed', reason: payload }, authoredId: sentinel }];
      input.result.checks = [{ id: 'npm/tls/node/registry.npmjs.org', operationId: sentinel, status: 'failed', reason: 'certificate-chain', detail: payload }];
    }
    const result = privacy(input);
    assert.equal(result.guidance.items.flatMap(item => item.repairs).length, 0, 'policy-authored identifiers must not select trust repairs');
    assert.doesNotMatch(result.raw, /script|example.invalid|https:/);
  }
});

test('complete, partial, invalid, cancelled and unknown reasons retain honest result state', () => {
  for (const status of ['complete', 'incomplete', 'invalid', 'cancelled']) {
    const input = inspect(); input.result.status = status;
    assert.match(privacy(input).markdown, new RegExp(`Status: ${status}`));
  }
  for (const status of ['ready', 'partial', 'blocked', 'invalid', 'cancelled']) {
    assert.match(privacy(prepare(status)).markdown, new RegExp(`Status: ${status}`));
  }
  for (const completion of ['complete', 'incomplete', 'cancelled', 'rejected']) {
    assert.match(privacy(run(completion)).markdown, new RegExp(`Status: ${completion}`));
  }
  assert.equal(privacy(inspect([check('npm', sentinel)])).guidance.items.at(-1).summary, 'Review the diagnostic and inspect again.');
  const unknownPassed = inspect([check('npm', sentinel)]); unknownPassed.result.checks[0].outcome = 'passed';
  assert.equal(privacy(unknownPassed).guidance.items.at(-1).summary, 'Review the diagnostic and inspect again.');
  for (const reason of ['connection-failed', 'authentication-required-or-denied']) {
    const { guidance } = privacy(inspect([check('mcp', reason, 'mcp/tls/1')]));
    assert.equal(guidance.items.flatMap(item => item.repairs).length, 0);
  }
});

test('portable adaptation retains platform, selection, PATH/loading and managed-access facts', () => {
  for (const os of ['win32', 'darwin', 'linux', 'unknown']) {
    const input = inspect([check('docker', 'version-exit', 'docker/version'), check('homebrew', 'executable-missing', 'homebrew/version'),
      check('npm', 'executable-missing', 'npm/version'), check('bash', 'wsl-launcher', 'bash/version'), check('git', 'executable-missing', 'git/version')]);
    input.result.tools = [{ id: 'node', label: sentinel, state: 'runnable', selection: 'requested', config: sentinel },
      { id: 'git', label: sentinel, state: 'absent', selection: 'unselected' }];
    input.result.observations = ['npm/resolution', 'antigravity/loading', 'zed/loading'].map(id => ({ id, target: id.split('/')[0], detail: sentinel }));
    input.result.diagnostics = [diagnostic('state-protection')];
    const { guidance, markdown } = privacy(input, { platform: os });
    assert.equal(guidance.items.some(item => item.target === 'git'), false);
    assert.match(markdown, /Node.js is runnable/); assert.match(markdown, /PATH evidence/);
    assert.equal(guidance.items.filter(item => item.id === 'client-loading').length, 2);
    assert.equal(guidance.items.filter(item => item.id === 'managed-access').length, 1);
    assert.match(markdown, os === 'win32' || os === 'darwin' ? /Docker Desktop/ : /daemon/);
    if (os === 'win32') assert.match(markdown, /Homebrew is not applicable/);
    if (os === 'darwin') { assert.match(markdown, /\/opt\/homebrew/); assert.match(markdown, /\/usr\/local/); }
    if (os === 'linux') assert.match(markdown, /\/home\/linuxbrew\/\.linuxbrew/);
    if (os === 'unknown') assert.equal(guidance.items.flatMap(item => item.repairs).length, 0);
  }
});

test('repair context is restricted to published supported targets and required metadata', () => {
  for (const os of ['win32', 'darwin', 'linux', 'unknown']) {
    for (const [id, target, names] of [['user-tools-ca', 'python', ['caFile']], ['jvm-ca', 'gradle', ['caFile', 'baselineStore']]]) {
      const input = run('incomplete', 'repair'); input.repair = { id, targets: [target] };
      input.result.checks = [{ id: `trust/${target}-behavior`, operationId: `trust/${target}-config`, status: 'failed', reason: 'certificate-chain' }];
      const { guidance } = privacy(input, { platform: os });
      const item = guidance.items.find(item => item.target === target);
      assert.ok(item); assert.equal(item.repairs.length, os === 'unknown' ? 0 : 1);
      if (os !== 'unknown') { assert.equal(item.repairs[0].id, id); assert.deepEqual(item.repairs[0].targets, [target]); assert.deepEqual(item.repairs[0].requiredInputs.map(input => input.name), names); }
    }
  }
  for (const context of [{ id: 'imaginary', targets: ['node'] }, { id: 'jvm-ca', targets: ['node'] }, { id: 'jvm-ca', targets: [] },
    { id: 'jvm-ca', targets: ['gradle', 'gradle'] }, { id: 'jvm-ca', targets: ['gradle'], inputs: { caFile: sentinel } }]) {
    const input = run('incomplete', 'repair'); input.repair = context; invalid(input);
  }
  const input = inspect(); input.repair = { id: 'node-npm-ca', targets: ['node'] }; invalid(input);
  const policy = run(); policy.repair = { id: 'node-npm-ca', targets: ['node'] };
  assert.equal(privacy(policy).guidance.items.flatMap(item => item.repairs).length, 0);
  const preparation = prepare('partial', 'repair'); preparation.repair = { id: 'jvm-ca', targets: ['maven'] };
  preparation.result.review.operations = [{ id: 'trust/maven-config', purpose: sentinel, kind: 'file.write', scope: 'user', effects: 'unavailable',
    ownership: 'unowned', requires: [], checks: [], details: { reason: 'certificate-chain', target: sentinel, content: sentinel } }];
  const item = privacy(preparation).guidance.items.find(item => item.target === 'maven');
  assert.deepEqual(item.evidenceIds, ['/review/operations/0']);
  assert.deepEqual(item.repairs[0].targets, ['maven']); assert.deepEqual(item.repairs[0].requiredInputs.map(input => input.name), ['caFile', 'baselineStore']);
  const stale = run('rejected'); stale.result.diagnostics = [diagnostic(sentinel, 'REVIEW_STALE')];
  assert.equal(privacy(stale).guidance.items.find(item => item.reason === 'review-stale').target, 'policy');
});

test('Prepare data-property live handle is never inspected and output is equivalent to its absence', () => {
  const input = prepare(); let reads = 0;
  const handle = {}; Object.defineProperty(handle, 'toJSON', { get() { reads++; throw new Error('must not read handle'); } });
  Object.defineProperty(input.result, 'prepared', { value: handle, enumerable: true });
  assert.deepEqual(getGuidance(input, platform), getGuidance(prepare(), platform));
  assert.deepEqual(renderSupportMarkdown(input, platform), renderSupportMarkdown(prepare(), platform)); assert.equal(reads, 0);
  const accessor = prepare(); Object.defineProperty(accessor.result, 'prepared', { get() { reads++; throw new Error('must not read accessor'); } }); invalid(accessor); assert.equal(reads, 0);
  for (const value of [new Date(), new Map(), () => {}]) {
    const data = prepare(); data.result.prepared = value; assert.deepEqual(getGuidance(data, platform), getGuidance(prepare(), platform));
  }
});

test('bounded strict JSON rejects accessors, nonplain objects, cycles, depth and UTF-8 byte excess', () => {
  let reads = 0;
  const input = inspect(); Object.defineProperty(input.result, 'hidden', { get() { reads++; return sentinel; }, enumerable: true }); invalid(input); assert.equal(reads, 0);
  const wrapped = {}; Object.defineProperty(wrapped, 'kind', { get() { reads++; return 'inspect'; }, enumerable: true }); invalid(wrapped); assert.equal(reads, 0);
  const option = {}; Object.defineProperty(option, 'platform', { get() { reads++; return 'linux'; }, enumerable: true }); invalid(inspect(), option); assert.equal(reads, 0);
  for (const extra of [new Date(), new Map(), new Set(), () => {}, undefined, NaN, Infinity, -0, 9007199254740992]) {
    const input = inspect(); input.result.extra = extra; invalid(input);
  }
  const cycle = inspect(); cycle.result.extra = cycle; invalid(cycle);
  const sparse = inspect(); sparse.result.extra = new Array(1); invalid(sparse);
  const symbol = inspect(); symbol.result[Symbol('x')] = sentinel; invalid(symbol);
  const nonenumerable = inspect(); Object.defineProperty(nonenumerable.result, 'x', { value: sentinel }); invalid(nonenumerable);
  const deep = inspect(); deep.result.extra = {}; let cursor = deep.result.extra;
  for (let i = 0; i < 32; i++) { cursor.child = {}; cursor = cursor.child; } invalid(deep);
  for (const extra of ['x'.repeat(1_000_001), 'é'.repeat(510_000), '\u0000'.repeat(170_000)]) { const input = inspect(); input.result.extra = extra; invalid(input); }
  const shared = inspect(); let repeated = { value: 'x'.repeat(100) };
  for (let i = 0; i < 20; i++) repeated = { a: repeated, b: repeated };
  shared.result.extra = repeated; invalid(shared);
  const ordinary = inspect(); ordinary.result.extra = 'é'.repeat(100); assert.equal(getGuidance(ordinary, platform).status, 'complete');
});

test('input wrapper/options, required public fields and unsupported schemas are rejected safely', () => {
  for (const input of [null, {}, { kind: 'inspect', result: null }, { kind: 'file-state', result: {} }, { ...inspect(), signal: {} }]) invalid(input);
  for (const options of [null, {}, { platform: 'freebsd' }, { platform: 'linux', signal: {} }]) invalid(inspect(), options);
  for (const make of [inspect, prepare, run]) {
    const fixture = make();
    const required = fixture.kind === 'prepare' ? ['status', 'runId', 'diagnostics', 'record'] : Object.keys(fixture.result).filter(key => !['inputs', 'recovery'].includes(key));
    for (const key of required) { const input = make(); delete input.result[key]; invalid(input); }
    const data = make(); data.result.diagnostics = [{}]; invalid(data);
  }
  for (const key of Object.keys(review())) { const input = prepare(); delete input.result.review[key]; invalid(input); }
  const inspectSchema = inspect(); inspectSchema.result.schema = 'unknown'; invalid(inspectSchema);
  const badRun = run(); badRun.result.schema = 'urn:aihq:core:run-result:99.0.0'; invalid(badRun, platform, 'SCHEMA_UNSUPPORTED');
  const badReview = prepare(); badReview.result.review.schema = 'urn:aihq:core:prepared-work:99.0.0'; invalid(badReview, platform, 'SCHEMA_UNSUPPORTED');
  const badCheck = inspect([check()]); badCheck.result.checks[0].outcome = 'made-up'; invalid(badCheck);
  const badOperation = run(); badOperation.result.operations = [{ id: 'x', application: 'applied', verification: {} }]; invalid(badOperation);
  const badAuthorization = run(); badAuthorization.result.authorization = { origin: 'automation', allowPartial: {} }; invalid(badAuthorization);
  const badOrganization = prepare(); badOrganization.result.review.inputs.organization = { source: {} }; invalid(badOrganization);
});

test('package identity is narrowly permitted and Markdown escapes permitted punctuation', () => {
  const { raw } = privacy(inspect([check('node', 'node-certificate-chain')]));
  assert.match(raw, /@aihq\/core 1\\\.0\\\.0\\-dev\\\.4/); assert.doesNotMatch(raw, /&#\d+;/);
  assert.doesNotMatch(raw, /Node\.js/);
  for (const packageData of [{ name: sentinel, version: '1.0.0' }, { name: '@aihq/core', version: sentinel }, { name: '<script>', version: '1.0.0' }]) {
    const input = inspect(); input.result.package = packageData; assert.match(privacy(input).markdown, /Package: unavailable/);
  }
});

test('256-item and 256-KiB bounds explicitly summarize omitted data while retaining status', () => {
  const input = inspect(Array.from({ length: 300 }, () => check('git', 'version-exit', 'git/version')));
  const { guidance, markdown } = privacy(input); assert.equal(guidance.items.length, 256);
  assert.match(guidance.items.at(-1).summary, /additional guidance items were omitted/); assert.match(markdown, /additional guidance items were omitted/);
  const large = inspect(Array.from({ length: 6500 }, () => ({ id: 'x', target: 'mcp', outcome: 'failed', reason: 'certificate-chain', detail: '' })));
  large.result.status = 'cancelled';
  const report = renderSupportMarkdown(large, platform); assert.equal(report.status, 'rendered');
  assert.ok(Buffer.byteLength(report.markdown) <= 256 * 1024); assert.match(report.markdown, /additional report sections were omitted/); assert.match(report.markdown, /Status: cancelled/);
});

test('local dist support entry bundles and runs without filesystem/process/network globals', async () => {
  try {
    const browser = await build({ stdin: { contents: `
      import {getGuidance,renderSupportMarkdown} from '@aihq/core/support';
      const input = ${JSON.stringify(inspect([check()]))};
      globalThis.presentation = [getGuidance(input,{platform:'linux'}),renderSupportMarkdown(input,{platform:'linux'})];`,
      resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', write: false, metafile: true });
    assert.equal(Object.keys(browser.metafile.inputs).some(name => /harness\/(?:runtime|ca|candidate|user-trust|jvm-trust)\.mjs$|core\/evidence\/|@sigstore\//.test(name)), false);
    assert.doesNotMatch(browser.outputFiles[0].text, /node:fs|node:process|node:net/);
    const globals = { TextEncoder, TextDecoder, atob, btoa };
    runInNewContext(browser.outputFiles[0].text, globals, { timeout: 5000 });
    assert.equal(globals.presentation[0].status, 'complete'); assert.equal(globals.presentation[1].status, 'rendered');
    assert.equal(globals.presentation[0].items.find(item => item.id === 'missing-curl').target, 'curl');
  } finally { stop(); }
});

test('policy access failures keep developer and administrator actions without tool classification', () => {
  for (const input of [run('incomplete'), prepare('blocked')]) {
    input.result.diagnostics = [diagnostic('state-protection')];
    const { guidance } = privacy(input);
    const access = guidance.items.filter(item => item.reason === 'state-protection');
    assert.deepEqual(access.map(item => [item.id, item.audience, item.target]),
      [['access-review', 'developer', 'policy'], ['managed-access', 'administrator', 'policy']]);
  }
  const tool = run('incomplete'); tool.result.diagnostics = [diagnostic('executable-missing')];
  assert.equal(privacy(tool).guidance.items.some(item => item.id === 'missing-executable'), false);
});

test('policy operations distinguish failed application, failed verification and missing verification', () => {
  const expectations = [
    [{ application: 'failed', verification: { status: 'unverified', reason: 'not-attempted' } }, 'execution-failed'],
    [{ application: 'applied', verification: { status: 'failed', reason: 'check-failed' } }, 'verification-failed'],
    [{ application: 'applied', verification: { status: 'unavailable', reason: 'offline' } }, 'verification-unavailable'],
    [{ application: 'applied', verification: { status: 'skipped', reason: 'offline' } }, 'verification-skipped'],
    [{ application: 'applied', verification: { status: 'unverified', reason: 'no-supplied-check' } }, 'verification-missing']
  ];
  for (const [operation, reason] of expectations) {
    const input = run('incomplete'); input.result.operations = [{ id: sentinel, ...operation }];
    const { guidance, markdown } = privacy(input);
    const item = guidance.items.find(entry => entry.evidenceIds.includes('/operations/0'));
    assert.equal(item.reason, reason, JSON.stringify(operation));
    if (reason !== 'verification-failed') assert.doesNotMatch(markdown, /Verification failed/);
  }
});

test('contradictory policy and repair input bindings are rejected as malformed public results', () => {
  const both = run(); both.result.inputs = { ...review('policy').inputs, ...review('repair').inputs };
  invalid(both);
  // The schemas' oneOf discriminates by property presence, so a null policy digest is still present.
  const nullPolicy = run('complete', 'repair'); nullPolicy.result.inputs = { ...review('repair').inputs, policySha256: null };
  invalid(nullPolicy);
  const partialRepair = run(); partialRepair.result.inputs = { ...review('policy').inputs, sourceSha256: 'a'.repeat(64) };
  assert.equal(getGuidance(partialRepair, platform).status, 'complete');
  const candidate = run('complete', 'repair'); candidate.result.inputs = { ...review('repair').inputs, candidateKind: 'system-ca' };
  assert.equal(getGuidance(candidate, platform).status, 'complete');
  // prepared-work admits an organization binding exactly in enterprise mode.
  const organization = { source: { provider: 'github', repository: { owner: sentinel, name: sentinel }, path: sentinel,
    revision: { kind: 'branch', value: sentinel } }, resolvedCommit: sentinel, blobId: sentinel, contentDigest: sentinel,
    policyId: sentinel, helper: { id: 'github-policy-reader', package: { ...pkg } } };
  const standalone = prepare('ready', 'repair'); standalone.result.review.inputs.organization = organization;
  invalid(standalone);
  const enterpriseWithout = prepare(); enterpriseWithout.result.review.mode = 'enterprise';
  invalid(enterpriseWithout);
  const enterprise = prepare(); enterprise.result.review.mode = 'enterprise'; enterprise.result.review.inputs.organization = organization;
  privacy(enterprise);
});
