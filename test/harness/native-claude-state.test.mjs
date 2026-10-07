import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectClaudeGlobalState } from '../../src/harness/native/claude-state.mjs';
import { createPersistenceDiagnosticClassifier } from '../../src/harness/native/persistence-diagnostics.mjs';

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
