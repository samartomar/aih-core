import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { sha256Hex, canonicalJson } from '../../src/harness/native/canonical.mjs';
import { resolveBundledFixture, verifyFixtureMaterials, configurationDigest, definitionIdentity }
  from '../../src/harness/native/digest.mjs';
import { nativeVerificationDefinitions } from '../../src/harness/native/contracts.mjs';

const nodeSha = value => createHash('sha256').update(value).digest('hex');

test('portable sha256 agrees with Node across padding boundaries', () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const bytes = Buffer.alloc(length, 0x61 + (length % 7));
    assert.equal(sha256Hex(bytes), nodeSha(bytes), String(length));
  }
  assert.equal(sha256Hex('é✓'), nodeSha('é✓'));
});

test('canonical JSON orders keys by code unit and rejects non-JSON', () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, 'x'], B: 2 }), '{"B":2,"a":[true,null,"x"],"b":1}');
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson(NaN));
});

test('bundled Claude fixture resolves with verified pinned bytes', () => {
  const resolved = resolveBundledFixture('claude');
  assert.equal(resolved.outcome, 'selected');
  assert.equal(resolved.proofScope, 'bundled-mechanism');
  assert.equal(resolved.archiveSha256, null);
  assert.deepEqual(resolved.files.map(f => f.path).sort(),
    ['.aihq-native/server.mjs', '.claude/settings.json', '.mcp.json', 'CLAUDE.md']);
  assert.equal(verifyFixtureMaterials(resolved).ok, true);
  for (const file of resolved.files) assert.equal(nodeSha(file.bytes), file.sha256);
  // the marker is only in the exact instruction file
  const marker = 'fde7a948';
  const holders = resolved.files.filter(f => Buffer.from(f.bytes).toString('utf8').includes(marker)).map(f => f.path);
  assert.deepEqual(holders, ['CLAUDE.md']);
});

test('changed fixture bytes are fixture-bytes-mismatch', () => {
  const resolved = resolveBundledFixture('claude');
  const tampered = { ...resolved, files: resolved.files.map((f, i) => i === 0
    ? { ...f, bytes: Buffer.concat([Buffer.from(f.bytes), Buffer.from(' ')]) } : f) };
  assert.deepEqual(verifyFixtureMaterials(tampered), { ok: false, reason: 'fixture-bytes-mismatch' });
});

test('every roster client but Claude is client-unsupported for the fixture', () => {
  for (const client of ['codex', 'cursor', 'gemini', 'copilot', 'windsurf', 'opencode', 'kimi', 'kiro', 'antigravity', 'zed'])
    assert.deepEqual(resolveBundledFixture(client), { outcome: 'unsupported', reason: 'client-unsupported' });
});

test('configuration digest hashes the output and guardrail digests together', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  assert.equal(configurationDigest({ outputTreeSha256: a, guardrailsSha256: b }),
    nodeSha(`{"guardrailsSha256":"${b}","outputTreeSha256":"${a}"}`));
});

test('definition identity is the canonical definition hash', () => {
  const definition = nativeVerificationDefinitions[0];
  const identity = definitionIdentity(definition);
  assert.equal(identity.id, definition.id);
  assert.equal(identity.sha256, nodeSha(canonicalJson(definition)));
});
