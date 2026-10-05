import test from 'node:test';
// The Linux definition must never fall through to an unsandboxed version launch.
test('registered Linux client resolution delegates its version execution to the fixed sandbox', async () => {
  let delegated = 0, direct = 0;
  const pin = { executable: process.execPath, sha256: 'a'.repeat(64), observedVersion: '2.1.285', argv: [], runtime: [] };
  const module = { ...installed, pinExecutable: async () => ({ status: 'pinned', path: process.execPath, sha256: pin.sha256, byteLength: 1 }),
    lifecycleAvailability: async () => ({ status: 'available' }),
    resolveLinuxNativeClient: async () => { delegated++; return { status: 'resolved', pin, platform: {}, vendor: {}, runtime: {} }; },
    startLifecycle: async () => { direct++; return { status: 'unavailable', reason: 'session-launch-failed' }; } };
  const runtime = installed.createNativeRuntime(module, { readPinned: () => Buffer.from('synthetic'), Stop: class extends Error {} });
  const result = await runtime.resolveNativeClient({ client: 'claude', parserId: 'claude-stream-json.v1', identityAdapterId: 'claude-oauth-otel.v1',
    platform: { os: 'linux', execution: 'wsl2' }, lifecycleId: 'linux-srt.v1', executableNames: ['claude'],
    versionArgv: ['--version'], sessionArgv: ['-p'], isolation: { mechanism: 'vendor-runtime' } },
    { deadline: performance.now() + 5000, acquireCell: async () => ({ home: '/tmp/owned/home', scratch: '/tmp/owned/scratch', project: '/tmp/owned/project' }) });
  assert.equal(direct, 0);
  assert.equal(delegated, 1);
  assert.equal(result, pin);
});
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as installed from '../../src/harness/native/runtime.mjs';
import { nativeParserIds } from '../../src/harness/native/contracts.mjs';

// This controlled helper seam never launches a client or authenticates a peer.
// It checks when the adapter considers already-received proof complete.
async function session(t, { query = 'answered', receipt = false, realParser = false, track } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aihq-adapter-')));
  const cell = { path: root, observations: join(root, 'observations'), home: join(root, 'home'), scratch: join(root, 'scratch'), project: join(root, 'project') };
  for (const directory of [cell.observations, cell.home, cell.scratch, cell.project]) mkdirSync(directory);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const telemetry = { outcome: 'unavailable', reason: 'authentication-unavailable',
    counts: { events: 0, matched: 0 }, bytes: 0 };
  let terminationCount = 0;
  const stdout = new PassThrough();
  let exit;
  const exited = new Promise(resolve => { exit = resolve; });
  let nativeFailure = null;
  const stream = { status: 'complete', sessionId: 'controlled-session', sessionIdConsistent: true,
    serverStatus: 'connected', toolsListed: true, visibleSelectedTools: ['attest', 'query'],
    builtinTools: [], unselectedTools: 0, unselectedToolUses: [], attestationReturned: true,
    answerReturned: receipt, answerSha256: receipt ? installed.sha256('leaf') : null };
  const evidence = { peer: 'authenticated', violation: null, frames: [], bytes: 0 };
  const processHandle = { pid: 1234, stdin: new PassThrough(), stdout, stderr: new PassThrough(),
    ...(track ? { track } : {}),
    get failure() { return nativeFailure; },
    exited, terminate: async () => { terminationCount++; return { processes: 'confirmed', survivors: [] }; } };
  // The adapter now creates the lifecycle context before any client and starts the client through it.
  const lifecycleContext = {
    createPipe: async () => ({ status: 'ready', transport: { endpoint: 'controlled-pipe', close: async () => {} } }),
    start: async () => ({ status: 'started', handle: processHandle }),
    terminate: async () => { terminationCount++; return { processes: 'confirmed', survivors: [] }; }
  };
  // A selected entry whose exact absolute module path is the running Node image, so the adapter's
  // selected-entry resolution accepts this controlled context.
  const serverBytes = Buffer.from('x');
  const member = { path: 'server.mjs', sha256: installed.sha256(serverBytes), byteLength: 1 };
  writeFileSync(join(cell.project, 'server.mjs'), serverBytes);
  const configurationBytes = Buffer.from(JSON.stringify({ mcpServers: { controlled: { command: 'node', args: ['server.mjs'] } } }));
  const configurationMember = { path: 'mcp.json', sha256: installed.sha256(configurationBytes), byteLength: configurationBytes.length };
  writeFileSync(join(cell.project, '.mcp.json'), configurationBytes);
  const nodeSha256 = installed.sha256(readFileSync(process.execPath));
  const module = { ...installed,
    lifecycleAvailability: async () => ({ status: 'available' }),
    observeClaudeManagedSettings: () => ({ outcome: 'clear' }),
    createClaudeCollector: () => ({ start: async () => ({ endpoint: 'controlled', token: 'controlled' }),
      bindSession() {}, snapshot: () => telemetry, drain: async () => telemetry, cancel: async () => {} }),
    startEvidenceChannel: async () => ({ endpoint: 'controlled', token: 'controlled', challenge: 'a'.repeat(64),
      snapshot: () => evidence, close: async () => evidence }),
    createClaudeStreamParser: realParser ? installed.createClaudeStreamParser : () => ({ push() {}, snapshot: () => ({ ...stream }), finish: () => ({ ...stream }) }),
    buildClaudeEnvironment: () => ({}),
    evaluateServerEvidence: () => ({ initialize: true, discovery: 'complete', attestation: 'missing',
      ambiguousBeforeAttestation: false, query, queryResultSha256: query === 'result-mismatch' ? 'b'.repeat(64) : 'c'.repeat(64),
      rejectedQueryCalls: 0, unrequestedCalls: 0 }),
    prepareLifecycleContext: async () => ({ status: 'ready', context: lifecycleContext }) };
  const runtime = installed.createNativeRuntime(module, { readPinned(path) { return readFileSync(path); },
    Stop: class extends Error { constructor(reason) { super(reason); this.reason = reason; } } });
  runtime.nativeCapabilities = () => ({ lifecycle: true, peerIdentity: true, credentialChannel: true });
  runtime.nativeServerEvidenceAvailable = () => true;
  const definition = { client: 'claude', parserId: 'claude-stream-json.v1', identityAdapterId: 'claude-oauth-otel.v1',
    platform: { os: 'win32' }, lifecycleId: 'windows-job.v1', sessionArgv: [],
    credentialDestination: { root: 'home', path: '.claude/.credentials.json' } };
  const handle = await runtime.startNativeSession({ definition, index: 1, signal: controller.signal,
    deadline: performance.now() + 5000, prompt: 'controlled', challenge: 'a'.repeat(64), environment: {},
    pin: { executable: process.execPath, sha256: nodeSha256, runtime: [{ path: process.execPath, sha256: nodeSha256 }] }, identity: { expected: {} },
    cell,
    material: { server: { name: 'controlled', evidenceAdapterId: 'controlled', toolNames: ['attest', 'query'],
      queryTool: 'query', expectedAnswer: 'leaf', expectedResultSha256: 'c'.repeat(64), runtime: [member] },
      outputTree: [{ root: 'project', path: 'server.mjs', member }, { root: 'project', path: '.mcp.json', member: configurationMember }],
      bytes: new Map([['mcp.json', configurationBytes]]),
      instructions: [{ evidence: 'marker', markerSha256: 'd'.repeat(64) }] } });
  assert.equal(typeof handle.snapshot, 'function');
  t.after(async () => { controller.abort(); await handle.observations;
    await handle.cleanup({ deadline: performance.now() + 1000, graceMs: 0 }); });
  return { handle, telemetry, stream, stdout, exit, controller, terminationCount: () => terminationCount,
    setNativeFailure(value) { nativeFailure = value; } };
}

test('partial adapter leaves a correct query response unfinished until the client receipt', async t => {
  const { handle } = await session(t);
  const observation = handle.snapshot();
  assert.equal(observation.query.resultSha256, 'c'.repeat(64));
  assert.equal(observation.query.answerSha256, null);
  assert.equal(observation.completed.includes('read-only-query'), false);
});

test('adapter refreshes owned processes without overlapping native observations', async t => {
  let active = 0, maximum = 0, calls = 0;
  await session(t, { track: async () => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 35)); active--;
  } });
  await new Promise(resolve => setTimeout(resolve, 140));
  assert.ok(calls >= 2);
  assert.equal(maximum, 1);
});

test('partial adapter preserves an actual server-result contradiction before the client receipt', async t => {
  const { handle } = await session(t, { query: 'result-mismatch' });
  const observation = handle.snapshot();
  assert.equal(observation.query.resultSha256, 'b'.repeat(64));
  assert.equal(observation.query.answerSha256, null);
  assert.equal(observation.completed.includes('read-only-query'), true);
});

test('partial adapter completes a query only after the response and client receipt', async t => {
  const { handle } = await session(t, { receipt: true });
  assert.equal(handle.snapshot().completed.includes('read-only-query'), true);
});

test('real parser leaves a textless query receipt unavailable through cancellation', async t => {
  const { handle, stdout, controller } = await session(t, { realParser: true });
  stdout.write(JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'query-id', name: 'mcp__controlled__query' }
  ] } }) + '\n');
  stdout.write(JSON.stringify({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'query-id', is_error: false, content: [] }
  ] } }) + '\n');
  assert.equal(handle.snapshot().query.answerSha256, null);
  assert.equal(handle.snapshot().completed.includes('read-only-query'), false);
  controller.abort();
  const final = await handle.observations;
  assert.equal(final.query.answerSha256, null);
  assert.equal(final.completed.includes('read-only-query'), false);
});

test('adapter stops promptly on known identity conflict while retaining received query proof', async t => {
  const { handle, telemetry, terminationCount } = await session(t, { query: 'result-mismatch' });
  telemetry.reason = 'identity-conflict';
  const observation = await Promise.race([handle.observations,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('identity stop was not prompt')), 1000);
      timer.unref(); })]);
  assert.equal(terminationCount(), 1);
  assert.equal(observation.failure.reason, 'identity-conflict');
  assert.equal(observation.authentication, 'conflict');
  assert.equal(observation.completed.includes('provider-authentication'), true);
  assert.equal(observation.completed.includes('read-only-query'), true);
});

test('adapter stops promptly on collector overflow and retains its limit reason', async t => {
  const { handle, telemetry, terminationCount } = await session(t);
  telemetry.reason = 'limit-exceeded';
  const observation = await Promise.race([handle.observations,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('collector overflow did not stop')), 1000);
      timer.unref(); })]);
  assert.equal(terminationCount(), 1);
  assert.equal(observation.failure.reason, 'limit-exceeded');
  assert.equal(observation.authentication, 'limited');
  assert.equal(observation.completed.includes('provider-authentication'), true);
});

for (const interruption of [false, true]) test('real parser preserves a wrong selected query receipt through ' + (interruption ? 'cancellation' : 'completion'), async t => {
  const { handle, stdout, exit, controller } = await session(t, { realParser: true });
  const sessionId = '0f8fad5b-d9cb-469f-a165-70867728950e';
  for (const message of [
    { type: 'system', subtype: 'init', session_id: sessionId, tools: ['mcp__controlled__query'],
      mcp_servers: [{ name: 'controlled', status: 'connected' }] },
    { type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: 'query-id', name: 'mcp__controlled__query' }] } },
    { type: 'user', session_id: sessionId, message: { content: [{ type: 'tool_result', tool_use_id: 'query-id', is_error: false,
      content: [{ type: 'text', text: 'leaf2' }] }] } },
  ]) stdout.write(JSON.stringify(message) + '\n');
  const partial = handle.snapshot();
  assert.equal(partial.query.resultSha256, 'c'.repeat(64));
  assert.equal(partial.query.answerSha256, '5038da95330ba16edb486954197e37eb777c3047327ca54df4199c35c5edc17a');
  assert.equal(partial.completed.includes('read-only-query'), true, 'an actual receipt is complete even when it contradicts the expected answer');
  if (interruption) controller.abort(); else exit({ code: 0 });
  const observations = await handle.observations;
  assert.equal(observations.query.answerSha256, partial.query.answerSha256);
  assert.equal(observations.failure?.reason, interruption ? 'cancelled' : undefined);
});

test('wrong-session-only telemetry remains provisional while a matching event can still arrive', async t => {
  const { handle, telemetry, exit, terminationCount } = await session(t);
  telemetry.reason = 'identity-session-mismatch';
  const partial = handle.snapshot();
  assert.equal(partial.completed.includes('provider-authentication'), false);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(terminationCount(), 0, 'wrong-session-only evidence is finalized by drain');
  telemetry.outcome = 'passed'; telemetry.reason = 'observed'; telemetry.counts.matched = 1;
  exit({ code: 0 });
  const final = await handle.observations;
  assert.equal(final.authentication, 'matched');
  assert.equal(final.failure, undefined);
});

test('a native helper limit survives withheld output and a root exit', async t => {
  const { handle, setNativeFailure, exit } = await session(t);
  setNativeFailure({ reason: 'limit-exceeded', observedBytes: 2097152 + 4096, limitSource: 'output' });
  assert.equal(handle.snapshot().failure.reason, 'limit-exceeded');
  exit({ code: null, signal: null, reason: 'limit-exceeded' });
  const final = await handle.observations;
  assert.equal(final.failure.reason, 'limit-exceeded');
  assert.equal(final.counts.observedBytes, 2097152 + 4096);
});

test('the trusted adapter records an unresolved pre-client facility receipt', async () => {
  const receipt = { confirmed: false, survivors: [{ pid: 65001, role: 'helper' }] };
  const recorded = [];
  const runtime = installed.createNativeRuntime({ ...installed,
    lifecycleAvailability: async () => ({ status: 'unavailable', reason: 'windows-facility-failed', cleanup: receipt, cleanupStartedAt: 123 }) },
    { readPinned() { throw Error('no pinned file is read'); }, Stop: Error,
      recordCleanup(cleanup, startedAt) { recorded.push({ cleanup, startedAt }); } });
  const capabilities = await runtime.nativeCapabilities(installed.nativeVerificationDefinitions[0]);
  assert.equal(capabilities.lifecycle, false);
  assert.deepEqual(recorded, [{ cleanup: receipt, startedAt: 123 }]);
});

test('the shared bundled fixture binds every registered definition through its fixed parser', () => {
  const runtime = installed.createNativeRuntime(installed, { readPinned(path) { return readFileSync(path); },
    Stop: class extends Error { constructor(reason) { super(reason); this.reason = reason; } } });
  const materials = installed.nativeVerificationDefinitions.map(definition => {
    const material = runtime.nativeBundledFixture(definition, { check() {} });
    assert.equal(material.scope, 'bundled-mechanism');
    // The shared fixture names the fixed parser, never one platform definition.
    assert.equal(material.adapterId, definition.parserId, definition.id);
    assert.ok(nativeParserIds.includes(material.adapterId));
    assert.ok(runtime.nativeServerEvidenceAvailable(material), definition.id);
    return material;
  });
  assert.equal(materials.length, 2);
  assert.equal(materials[0].manifestSha256, materials[1].manifestSha256, 'one shared fixture serves both platform definitions');
  // Binding changes only the descriptor identity: the staged bytes and their tree pins are unchanged.
  const resolved = installed.resolveBundledFixture('claude');
  assert.equal(installed.verifyFixtureMaterials(resolved).ok, true);
  for (const material of materials) {
    assert.equal(material.outputTreeSha256, '4b87d67679e653aa31fc5144da156646b9214160b2e060c9650ecc19cc75d525');
    assert.equal(material.guardrailsSha256, '9feae5a2be034510e024166d57d202823a1f60c89c208ad717341a941aee5590');
    for (const file of resolved.files) assert.deepEqual(material.bytes.get([...material.outputTree, ...material.guardrails]
      .find(entry => entry.root === file.root && entry.path === file.path).member.path), file.bytes);
  }
});

test('native state paths enumerate only fixed client-owned state, never loading surfaces', () => {
  const runtime = installed.createNativeRuntime(installed, { readPinned() { throw Error('no pinned read'); }, Stop: Error });
  // Initially loaded configuration/instruction/permission/MCP surfaces under each cell root. `*` is one client-named
  // segment: per-project auto-memory under the transcript tree is a loaded instruction source, not ordinary state.
  const loading = {
    project: ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.mcp.json', '.claude/settings.json', '.claude/settings.local.json',
      '.claude/rules', '.claude/commands', '.claude/agents', '.claude/skills', '.claude/hooks', '.claude/output-styles'],
    home: ['.claude.json', '.claude/.claude.json', '.claude/.config.json', '.claude/CLAUDE.md', '.claude/settings.json',
      '.claude/settings.local.json', '.claude/rules', '.claude/commands', '.claude/agents', '.claude/skills', '.claude/hooks',
      '.claude/output-styles', '.claude/plugins', '.claude/memory', '.claude/sessions', '.claude/session-env',
      '.claude/shell-snapshots', '.claude/policy-limits.json', '.claude/remote-settings.json', '.claude/mcp-needs-auth-cache.json',
      // Names the client reserves inside a project folder for memory and other non-transcript content.
      '.claude/projects/*/memory', '.claude/projects/*/tiny_memory', '.claude/projects/*/bagel', '.claude/projects/*/cloud-snapshots',
      '.claude/projects/*/bridge-pointer.json', '.claude/projects/*/.session-aliases']
  };
  const segments = value => value.toLowerCase().split('/');
  const prefixMatch = (pattern, path) => pattern.length <= path.length && pattern.every((part, i) => part === '*' || part === path[i]);
  const seen = [];
  for (const definition of installed.nativeVerificationDefinitions) {
    const state = runtime.nativeStatePaths(definition);
    assert.deepEqual(Object.keys(state).sort(), ['home', 'project']);
    assert.ok(state.home.length + state.project.length > 0, 'ordinary client-owned state must be allowed to change');
    for (const root of ['home', 'project']) for (const entry of state[root]) {
      assert.deepEqual(Object.keys(entry).sort(), ['exclusions', 'inspected', 'path']);
      assert.ok(/^\.?[0-9A-Za-z._-]+(\/[0-9A-Za-z._-]+)*$/.test(entry.path), entry.path);
      const at = segments(entry.path);
      for (const source of loading[root]) {
        const surface = segments(source);
        if (prefixMatch(surface, at)) {
          // Only an exact, separately inspected file may coincide with a loading surface.
          assert.ok(entry.inspected && surface.length === at.length && !surface.includes('*'), `${root}/${entry.path} is loading source ${source}`);
          assert.equal(typeof runtime.inspectNativeState, 'function');
        } else if (prefixMatch(at, surface)) {
          // A state tree containing a loading surface must exclude exactly that surface.
          const rest = surface.slice(at.length).join('/');
          assert.ok(!entry.inspected && entry.exclusions.some(value => value.toLowerCase() === rest), `${root}/${entry.path} contains ${source}`);
        }
      }
      assert.ok(!(root === 'home' && (prefixMatch(at, segments(definition.credentialDestination.path)) ||
        prefixMatch(segments(definition.credentialDestination.path), at))), 'the staged credential keeps its dedicated check');
      for (const guard of definition.guardrails)
        assert.ok(!(guard.root === root && (prefixMatch(at, segments(guard.path)) || prefixMatch(segments(guard.path), at))), `${entry.path} overlaps a guardrail`);
    }
    seen.push(state);
  }
  assert.deepEqual(seen[0], seen[1], 'both platform definitions share the same fixed state enumeration');
  assert.deepEqual(seen[0].home.map(entry => entry.path), ['.claude/projects', '.claude/.claude.json', '.claude/.claude.json.lock',
    '.claude/backups', '.claude/history.jsonl', '.claude/history.jsonl.lock', '.claude/telemetry']);
  assert.deepEqual(seen[0].project, []);
  assert.deepEqual(runtime.nativeStatePaths({ client: 'codex', parserId: 'other.v1' }), { home: [], project: [] });
});

test('the global client state inspector accepts bookkeeping and refuses loading or permission grants', () => {
  const runtime = installed.createNativeRuntime(installed, { readPinned() { throw Error('no pinned read'); }, Stop: Error });
  const definition = installed.nativeVerificationDefinitions[0];
  const inspect = (value, path = '.claude/.claude.json', root = 'home') =>
    runtime.inspectNativeState(definition, { root, path, bytes: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });
  const project = extra => ({ numStartups: 3, installMethod: 'native', autoUpdates: false, firstStartTime: '2026-10-05T00:00:00.000Z',
    firstStartVersion: { VERSION: '2.1.285' }, userID: 'a'.repeat(64), machineID: 'b'.repeat(64), summonSidKey: 'c'.repeat(64),
    hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.285', tipsHistory: { 'new-user-warmup': 1 }, seenNotifications: {},
    cachedGrowthBookFeatures: { flag: true }, cachedGrowthBookFeaturesAt: 1, cachedDynamicConfigs: {}, cachedExperimentFeatures: [],
    cachedExperimentData: {}, startupPrefetchedAt: 1, claudeCodeFirstTokenDate: null, cachedExtraUsageDisabledReason: null,
    cachedUsageUtilization: { fetchedAtMs: 1, utilization: {} }, groveConfigCache: {}, passesEligibilityCache: {},
    oauthAccount: { accountUuid: '11111111-1111-4111-8111-111111111111' }, opusProMigrationComplete: true,
    sonnet1m45MigrationComplete: true, sonnet45To46MigrationTimestamp: 1, hasResetAutoModeOptInForDefaultOffer: true,
    projects: { '/cell/project': { allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [],
      hasTrustDialogAccepted: false, projectOnboardingSeenCount: 1, hasClaudeMdExternalIncludesApproved: false,
      hasClaudeMdExternalIncludesWarningShown: false, lastSessionId: '00000000-0000-4000-8000-000000000000', lastCost: 0,
      lastModelUsage: { model: { inputTokens: 1 } }, lastGracefulShutdown: true, lastVersionBase: '2.1.285', lastSessionMetrics: {},
      exampleFiles: [], ...extra } } });
  assert.equal(inspect(project()), true);
  assert.equal(inspect({}), true);
  const refused = {
    'user MCP server': { mcpServers: { extra: { type: 'stdio', command: 'node' } } },
    'project MCP server': project({ mcpServers: { extra: { type: 'stdio', command: 'node' } } }),
    'allowed tool grant': project({ allowedTools: ['Bash'] }),
    'project MCP approval': project({ enabledMcpjsonServers: ['other'] }),
    'project MCP disable': project({ disabledMcpjsonServers: ['aihq-native-fixture'] }),
    'trust acceptance': project({ hasTrustDialogAccepted: true }),
    'external include approval': project({ hasClaudeMdExternalIncludesApproved: true }),
    'context URI': project({ mcpContextUris: ['file:///x'] }),
    'ignore patterns': project({ ignorePatterns: ['*'] }),
    'unknown project key': project({ futureLoader: {} }),
    'unknown top-level key': { futureLoader: { path: 'x' } },
    'API key': { primaryApiKey: 'not-a-real-key' },
    'API key approval': { customApiKeyResponses: { approved: ['x'], rejected: [] } },
    'environment': { env: { NODE_OPTIONS: '--require x' } },
    'bypass acceptance': { bypassPermissionsModeAccepted: true },
    'non-boolean migration marker': { opusProMigrationComplete: { load: 'x' } },
    'non-numeric migration time': { sonnet45To46MigrationTimestamp: 'x' },
    'malformed identifier': { machineID: '../x' },
    'user preference': { theme: 'dark' },
    'verbose preference': { verbose: true },
    'auto-compact preference': { autoCompactEnabled: false },
    'API key helper': { apiKeyHelper: 'x' },
    'remote control at startup': { remoteControlAtStartup: true },
    'browser integration cache': { cachedChromeExtensionInstalled: true },
    'model access cache': { s1mAccessCache: {} },
    'billing consent': { fableOverageConsentV2: true },
    'marketplace auto-install': { officialMarketplaceAutoInstallAttempted: true },
    'worktree session': project({ activeWorktreeSession: { path: '/x' } }),
    'projects not an object': { projects: [] },
    'top-level array': [],
  };
  for (const [name, value] of Object.entries(refused)) assert.equal(inspect(value), false, name);
  assert.equal(inspect('{"numStartups":1,"numStartups":2}'), false, 'duplicate keys');
  assert.equal(inspect('\ufeff{}'), false, 'byte-order mark');
  assert.equal(inspect('{"numStartups":'), false, 'truncated');
  assert.equal(runtime.inspectNativeState(definition, { root: 'home', path: '.claude/.claude.json', bytes: Buffer.from([0x7b, 0xff, 0x7d]) }), false, 'invalid UTF-8');
  let deep = '1'; for (let i = 0; i < 40; i++) deep = `{"cachedDeep":${deep}}`;
  assert.equal(inspect(deep), false, 'depth bound');
  assert.equal(inspect('{"tipsHistory":"' + 'x'.repeat(1024 * 1024) + '"}'), false, 'size bound');
  assert.equal(inspect(project(), '.claude.json'), false, 'only the redirected configuration location is state');
  assert.equal(inspect(project(), '.claude/.claude.json', 'project'), false, 'never a project file');
  assert.equal(runtime.inspectNativeState({ client: 'codex', parserId: 'other.v1' }, { root: 'home', path: '.claude/.claude.json', bytes: Buffer.from('{}') }), false);
});
