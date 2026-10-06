import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import * as runtime from '../../src/harness/native/runtime.mjs';
import * as contracts from '../../src/harness/native/contracts.mjs';

const src = name => new URL(`../../src/harness/native/${name}`, import.meta.url);

test('the runtime entry exports exactly the documented surface', () => {
  assert.deepEqual(Object.keys(runtime).sort(), [
    'bundledNativeFixtures', 'buildClaudeEnvironment', 'canonicalJson', 'captureTestIdentity', 'claudeDeniedBuiltins',
    'claudePrompt', 'claudeSessionsAreFresh', 'claudeStreamOptions', 'configurationDigest', 'createClaudeCollector',
    'createClaudeStreamParser', 'createNativeRuntime', 'createOwnedCell', 'definitionIdentity', 'evaluateClaudeSession', 'evaluateServerEvidence',
    'fixtureServerName', 'lifecycleAvailability', 'matchClientVersion', 'nativeBounds', 'nativeClientIds',
    'nativeRunStageIds', 'nativeSessionStageIds', 'nativeStageReasons', 'nativeVerificationDefinitions',
    'observeCellConfiguration', 'observeClaudeManagedSettings', 'observeLinuxNativePolicy', 'observeNativePlatform', 'parseClaudeVersionOutput',
    'parseStrictJson', 'pinExecutable', 'prepareLifecycleContext', 'protectWindowsCell', 'removeOwnedCell', 'resolveBundledFixture', 'revalidateExecutable',
    'selectNativeCell', 'serverEvidenceSpec', 'sha256', 'stageCellFiles', 'stageCredential', 'startEvidenceChannel',
    'recorderCommand', 'recorderId', 'recorderMaterial', 'recorderPlan',
    'startLifecycle', 'validateClaudeOAuthFile', 'validateNativeTestIdentity', 'validateNativeVerificationDefinition', 'validateWindowsCell',
    'verifyFixtureMaterials', 'verifyLinuxVendorClosure', 'resolveLinuxNativeClient', 'prepareLinuxSandboxContext'].sort());
});

test('portable metadata imports no Node module and runs without Node globals', async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(src('contracts.mjs'))], metafile: true,
    bundle: true, write: false, format: 'iife', globalName: 'native', platform: 'neutral', logLevel: 'silent' });
  const imports = Object.values(bundle.metafile.inputs).flatMap(input => input.imports.map(entry => entry.path));
  assert.deepEqual(imports.filter(path => path.startsWith('node:')), []);
  assert.deepEqual(Object.keys(bundle.metafile.inputs).map(file => file.replace(/\\/g, '/').split('/').pop()).sort(),
    ['canonical.mjs', 'contracts.mjs', 'fixture-metadata.mjs']);
  const sandbox = { TextEncoder, URL };
  const context = vm.createContext(sandbox);
  vm.runInContext(`${bundle.outputFiles[0].text}; globalThis.result = { ids: native.nativeClientIds.length, fixtures: native.bundledNativeFixtures.length, valid: native.validateNativeVerificationDefinition(native.nativeVerificationDefinitions[0]).valid };`, context);
  assert.deepEqual({ ...context.result }, { ids: 11, fixtures: 1, valid: true });
});

test('importing the runtime entry starts no process, listener or file write', () => {
  const root = mkdtempSync(join(tmpdir(), 'aihq-import-'));
  try { assert.equal(typeof runtime.selectNativeCell, 'function'); } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the public evidence channel can never authenticate a helper without an OS peer facility', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aihq-chan-'));
  try {
    if (process.platform === 'win32') {
      await assert.rejects(async () => runtime.startEvidenceChannel({ directory: root, isOwnedServer: () => true }), /channel-protection-unavailable/);
      return;
    }
    const channel = await runtime.startEvidenceChannel({ directory: root, isOwnedServer: () => true });
    assert.match(channel.token, /^[0-9a-f]{64}$/);
    assert.match(channel.challenge, /^[0-9a-f]{64}$/);
    assert.notEqual(channel.token, channel.challenge);
    const result = await channel.close();
    assert.equal(result.peer, 'none');
    assert.equal(result.frames.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the production evidence entry refuses caller-fabricated platform transports', async () => {
  let opened = false;
  const transport = { endpoint: 'fabricated', onConnection() { opened = true; }, async close() {} };
  await assert.rejects(async () => runtime.startEvidenceChannel({ directory: tmpdir(), transport,
    isOwnedServer: () => true }), /channel-protection-unavailable/);
  assert.equal(opened, false);
});

test('derived options bind the fixture pins without leaking the answer into the prompt', () => {
  const resolved = runtime.resolveBundledFixture('claude');
  const options = runtime.claudeStreamOptions(resolved, 'c'.repeat(64));
  assert.equal(options.serverName, 'aihq-native-fixture');
  assert.equal(options.queryTool, 'aihq_graph_query');
  assert.equal(options.markerSha256, resolved.instructions[0].markerSha256);
  const spec = runtime.serverEvidenceSpec(resolved);
  assert.deepEqual(spec.toolNames, ['aihq_attest_instruction', 'aihq_graph_query']);
  assert.ok(runtime.claudeDeniedBuiltins.includes('Bash') && runtime.claudeDeniedBuiltins.includes('Read'));
  assert.ok(!runtime.claudePrompt('c'.repeat(64)).includes(resolved.server.expectedAnswer));
});

test('strict JSON rejects duplicates, BOM, trailing data and depth', () => {
  assert.deepEqual(runtime.parseStrictJson('{"a":[1,{"b":null}],"c":"x"}'), { a: [1, { b: null }], c: 'x' });
  for (const bad of ['{"a":1,"a":2}', '﻿{}', '{} x', '{"a":}', '[1,]', '{"a":1', 'tru', `${'['.repeat(20)}${']'.repeat(20)}`])
    assert.throws(() => runtime.parseStrictJson(bad), SyntaxError, bad);
});

test('contracts and runtime agree on shared descriptors', () => {
  assert.equal(runtime.nativeVerificationDefinitions, contracts.nativeVerificationDefinitions);
});
