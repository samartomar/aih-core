import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectClaudeGlobalState } from '../../src/harness/native/claude-state.mjs';
import { createPersistenceDiagnosticClassifier } from '../../src/harness/native/persistence-diagnostics.mjs';

test('first start version accepts the version string written by the client', () => {
  assert.equal(inspectClaudeGlobalState(Buffer.from(JSON.stringify({
    firstStartTime: '2026-10-07T00:00:00.000Z', firstStartVersion: '2.1.285'
  }))), true);
});

test('artifact roster denial accepts the record written by the client', () => {
  assert.equal(inspectClaudeGlobalState(Buffer.from(JSON.stringify({
    artifactRosterDenied: { status: 403, deniedAt: 1000, tokenExpiresAt: 2000 }
  }))), true);
});

test('first start version refuses records and non-text or oversized values', () => {
  for (const value of [{ VERSION: '2.1.285' }, {}, null, 285, true, ['2.1.285'], 'x'.repeat(65537)])
    assert.equal(inspectClaudeGlobalState(Buffer.from(JSON.stringify({ firstStartVersion: value }))), false);
});

test('version and denial bookkeeping refuse grants at every nested location', () => {
  const inspect = value => inspectClaudeGlobalState(Buffer.from(JSON.stringify(value)));
  for (const key of ['allowedTools', 'mcpServers', 'permissions', 'hooks', 'env', 'apiKeyHelper']) {
    const grant = { [key]: { allow: ['Bash'] } };
    for (const value of [grant, { entry: grant }, { entry: [grant] }]) {
      assert.equal(inspect({ firstStartVersion: value }), false, `firstStartVersion/${key}`);
      assert.equal(inspect({ artifactRosterDenied: value }), false, `artifactRosterDenied/${key}`);
    }
    assert.equal(inspect({ artifactRosterDenied: { [key]: 'grant' } }), false, `scalar grant/${key}`);
    assert.equal(inspect({ firstStartVersion: '2.1.285', skillUsage: { entry: [grant] } }), false, `skillUsage/${key}`);
  }
});

test('artifact roster denial retains scalar admission and refuses arrays or deeper records', () => {
  const inspect = value => inspectClaudeGlobalState(Buffer.from(JSON.stringify({ artifactRosterDenied: value })));
  for (const value of [null, false, 403, 'denied']) assert.equal(inspect(value), true);
  for (const value of [[], [{ status: 403 }], { status: { code: 403 } }, { status: [403] }, { status: 'x'.repeat(65537) }])
    assert.equal(inspect(value), false);
});

test('reviewed client children disclose only at the exact immediate home location', () => {
  const entry = (root, ...segments) => createPersistenceDiagnosticClassifier().entry({ root, segments, depth: segments.length, kind: 'dir' });
  for (const [parent, names] of [
    ['.claude', ['sessions', '.last-cleanup', 'stats-cache.json', 'active-time.json', 'policy-limits.json',
      'remote-settings.json', 'remote-settings-consent.json', 'remote-settings-helper-consent', 'mcp-needs-auth-cache.json',
      'cache', 'image-cache', 'uploads', 'tasks', 'teams', 'jobs', 'state', 'startup-perf', 'traces', 'usage-data', '.config.json',
      '.update.lock', '.last-update-result.json', '.deep-link-register-failed', 'keybindings.json', 'themes', 'workflows',
      'rules', 'cowork_plugins', 'loop.md', 'daemon.json', 'scheduled_tasks.json', 'launch.json', 'memory', 'agent-memory',
      'mcp-skill-archives', 'mcp-discovery-cache', 'file-transfers', 'shares', 'feedback-bundles', 'feedback', 'dump-prompts',
      'chrome', 'seed-admin', 'daemon', 'remote-control', 'gh-pr-status-cache.json', 'hfi-auth.json', 'ccr']],
    ['.config', ['anthropic', 'git', 'gh', 'gcloud', 'glab-cli']], ['.local', ['bin']]
  ]) for (const name of names) {
    assert.equal(entry('home', parent, name), name);
    for (const parts of [[parent.toUpperCase(), name], [parent, name.toUpperCase()], [parent, 'nested', name]])
      assert.match(entry('home', ...parts), /^unknown-/);
    assert.match(entry('project', parent, name), /^unknown-/);
  }
  for (const [parent, name] of [['.local', 'anthropic'], ['.config', 'bin'], ['.claude', 'anthropic'], ['.cache', 'sessions']])
    assert.match(entry('home', parent, name), /^unknown-/);
});

test('inspected JSON diagnoses unknown keys without values or dynamic project names', () => {
  const classifier = createPersistenceDiagnosticClassifier();
  const diagnoses = [];
  const inspect = value => inspectClaudeGlobalState(Buffer.from(JSON.stringify(value)), {
    classifyKey: classifier.key, diagnose: value => diagnoses.push(value)
  });
  assert.equal(inspect({ theme: 'privacy-canary-value' }), false);
  assert.deepEqual(diagnoses.pop(), { reason: 'unknown-global-key', token: 'theme' });
  assert.equal(inspect({ 'privacy-canary-name': 'privacy-canary-value' }), false);
  assert.deepEqual(diagnoses.pop(), { reason: 'unknown-global-key', token: 'unknown-1' });
  assert.equal(inspect({ projects: { '/privacy-canary-project': { 'privacy-canary-name': 'privacy-canary-value' } } }), false);
  assert.deepEqual(diagnoses.pop(), { reason: 'unknown-project-key', token: 'unknown-2' });
});

test('inspected JSON distinguishes nested grants from malformed value shapes', () => {
  const diagnoses = [], classifier = createPersistenceDiagnosticClassifier();
  const inspect = value => inspectClaudeGlobalState(Buffer.from(JSON.stringify(value)), {
    classifyKey: classifier.key, diagnose: value => diagnoses.push(value)
  });
  assert.equal(inspect({ skillUsage: { entry: { hooks: { command: 'privacy-canary-value' } } } }), false);
  assert.deepEqual(diagnoses.pop(), { reason: 'grant-content', token: 'skillUsage' });
  assert.equal(inspect({ numStartups: 'privacy-canary-value' }), false);
  assert.deepEqual(diagnoses.pop(), { reason: 'value-shape', token: 'numStartups' });
});

test('inspected JSON supplies every closed diagnosis while preserving its admission decisions', () => {
  const cases = [
    [Buffer.from('{'), 'malformed-json', null],
    [Buffer.from('{"numStartups":0,"numStartups":1}'), 'malformed-json', null],
    [Buffer.from([0xff]), 'malformed-json', null],
    [Buffer.alloc(1024 * 1024 + 1), 'oversized', null],
    [null, 'read-failure', null],
    [Buffer.from('[]'), 'not-record', null],
    [Buffer.from('{"projects":[]}'), 'not-record', 'projects'],
    [Buffer.from('{"projects":{"/privacy-canary-project":[]}}'), 'not-record', 'projects'],
    [Buffer.from('{"allowedTools":["privacy-canary-value"]}'), 'grant-content', 'allowedTools'],
    [Buffer.from('{"numStartups":-1}'), 'value-shape', 'numStartups'],
    [Buffer.from('{"theme":"privacy-canary-value"}'), 'unknown-global-key', 'theme'],
    [Buffer.from('{"projects":{"/privacy-canary-project":{"permissions":{}}}}'), 'unknown-project-key', 'permissions'],
  ];
  for (const [bytes, reason, token] of cases) {
    const diagnoses = [], classifier = createPersistenceDiagnosticClassifier();
    assert.equal(inspectClaudeGlobalState(bytes), false);
    assert.equal(inspectClaudeGlobalState(bytes, { classifyKey: classifier.key, diagnose: value => diagnoses.push(value) }), false);
    assert.deepEqual(diagnoses, [{ reason, token }]);
    assert.equal(JSON.stringify(diagnoses).includes('privacy-canary'), false);
  }
  const accepted = Buffer.from('{"numStartups":2,"projects":{"/privacy-canary-project":{"allowedTools":[],"lastCost":0}}}');
  assert.equal(inspectClaudeGlobalState(accepted), true);
  assert.equal(inspectClaudeGlobalState(accepted, { diagnose() { throw Error('observer'); } }), true);
  assert.equal(inspectClaudeGlobalState(Buffer.from('{'), { diagnose() { throw Error('observer'); } }), false);
});

test('entry and key tokens match only the reviewed structural location', () => {
  const classifier = createPersistenceDiagnosticClassifier();
  const entry = (root, ...segments) => classifier.entry({ root, segments, depth: segments.length, kind: 'file' });
  assert.equal(entry('home', '.claude'), '.claude');
  assert.equal(entry('home', 'AppData'), 'AppData');
  assert.equal(entry('home', '.claude', 'todos'), 'todos');
  assert.equal(entry('home', '.claude', '.oauth_refresh.lock'), '.oauth_refresh.lock');
  assert.equal(entry('home', '.config', 'claude'), 'claude');
  assert.equal(entry('home', '.cache', 'claude-cli-nodejs'), 'claude-cli-nodejs');
  assert.equal(entry('home', '.local', 'share'), 'share');
  assert.equal(entry('project', 'CLAUDE.local.md'), 'CLAUDE.local.md');
  assert.equal(entry('project', '.mcp.json'), '.mcp.json');
  for (const [root, ...segments] of [['home', 'todos'], ['home', '.claude', 'projects', 'todos'],
    ['home', '.claude', 'projects', '/privacy-canary-project', 'CLAUDE.md'], ['project', '.claude', 'todos'],
    ['home', 'CLAUDE.local.md'], ['project', 'AppData'], ['home', '.config', 'todos'], ['home', '.claude', 'TODOS']]) {
    assert.match(entry(root, ...segments), /^unknown-[1-9][0-9]*$/);
  }
  assert.equal(classifier.key('global', 'theme'), 'theme');
  assert.equal(classifier.key('project', 'lastSessionId'), 'lastSessionId');
  assert.match(classifier.key('global', 'lastSessionId'), /^unknown-/);
  assert.match(classifier.key('nested', 'mcpServers'), /^unknown-/);
  const fresh = createPersistenceDiagnosticClassifier();
  assert.equal(fresh.key('global', 'privacy-canary-key'), 'unknown-1');
  assert.equal(fresh.key('project', 'privacy-canary-key'), 'unknown-2');
});

test('client-defined configuration keys outside admission are named in diagnostics without their values', () => {
  const classifier = createPersistenceDiagnosticClassifier();
  const diagnoses = [];
  const inspect = value => inspectClaudeGlobalState(Buffer.from(JSON.stringify(value)), {
    classifyKey: classifier.key, diagnose: value => diagnoses.push(value)
  });
  for (const key of ['verbose', 'fileCheckpointingEnabled', 'autoUploadSessions']) {
    assert.equal(inspect({ [key]: 'privacy-canary-value' }), false);
    const diagnosis = diagnoses.pop();
    assert.deepEqual(diagnosis, { reason: 'unknown-global-key', token: key });
    assert.equal(JSON.stringify(diagnosis).includes('privacy-canary'), false);
  }
  assert.equal(inspect({ projects: { '/privacy-canary-project': { lastFpsLow1Pct: 'not-a-number' } } }), false);
  assert.equal(JSON.stringify(diagnoses.pop()).includes('privacy-canary'), false);
});
