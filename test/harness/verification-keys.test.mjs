import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verificationKeys, verificationKeyPurposes, validateVerificationKeyRecords, selectVerificationKeys }
  from '../../dist/harness/contracts.mjs';

// Test-only keys are generated here and never shipped in src or the inventory.
const makeKey = () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    der,
    record: {
      keyId: `ed25519:${createHash('sha256').update(der).digest('hex')}`,
      algorithm: 'Ed25519',
      publicKeySpkiBase64: der.toString('base64'),
      identity: 'AIHQ Test Signing 2026',
      purposes: ['scan-report']
    }
  };
};
const keyA = makeKey();
const keyB = makeKey();
const record = overrides => ({ ...keyA.record, ...overrides });

test('a valid record validates and selects by purpose with the Scan accepted-key shape', async () => {
  const validation = await validateVerificationKeyRecords([keyA.record, keyB.record]);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  assert.deepEqual(validation.diagnostics, []);
  const selected = await selectVerificationKeys('scan-report', [keyA.record, keyB.record]);
  assert.equal(selected.status, 'selected', JSON.stringify(selected));
  assert.equal(selected.keys.length, 2);
  assert.deepEqual(selected.keys[0], {
    identity: keyA.record.identity, keyId: keyA.record.keyId, publicKeySpkiBase64: keyA.record.publicKeySpkiBase64
  });
  assert.equal('purposes' in selected.keys[0], false);
  assert.equal(Object.isFrozen(selected.keys), true);
  assert.equal(Object.isFrozen(selected.keys[0]), true);
});

test('a rotated historical key stays selectable beside its successor; records carry no expiry', async () => {
  const historical = record({ identity: 'AIHQ Test Signing 2025' });
  const selected = await selectVerificationKeys('scan-report', [historical, keyB.record]);
  assert.equal(selected.status, 'selected', JSON.stringify(selected));
  assert.deepEqual(selected.keys.map(key => key.keyId), [historical.keyId, keyB.record.keyId]);
  const expiring = await validateVerificationKeyRecords([{ ...historical, notAfter: '2026-01-01T00:00:00Z' }]);
  assert.equal(expiring.valid, false);
  assert.equal(expiring.diagnostics[0].reason, 'record-shape');
});

test('selection uses only the independently supplied records', async () => {
  // A key that would arrive inside an artifact is not trusted unless the caller supplies it.
  const embedded = makeKey();
  const selected = await selectVerificationKeys('scan-report', [keyA.record]);
  assert.equal(selected.keys.some(key => key.keyId === embedded.record.keyId), false);
  const shipped = await selectVerificationKeys('scan-report');
  assert.deepEqual(shipped, { status: 'selected', keys: [] });
});

test('an empty record set selects no keys; an unsupported purpose is invalid', async () => {
  const empty = await selectVerificationKeys('scan-report', []);
  assert.deepEqual(empty, { status: 'selected', keys: [] });
  const unsupported = await selectVerificationKeys('org-policy', [keyA.record]);
  assert.equal(unsupported.status, 'invalid');
  assert.equal(unsupported.diagnostics[0].code, 'INPUT_INVALID');
  assert.equal(unsupported.diagnostics[0].reason, 'purpose-unsupported');
});

test('a wrong keyId is invalid', async () => {
  const wrong = record({ keyId: `ed25519:${'0'.repeat(64)}` });
  const validation = await validateVerificationKeyRecords([wrong]);
  assert.equal(validation.valid, false);
  const diagnostic = validation.diagnostics.find(item => item.path === '/0/keyId');
  assert.equal(diagnostic.code, 'INPUT_INVALID');
  const selected = await selectVerificationKeys('scan-report', [keyB.record, wrong]);
  assert.equal(selected.status, 'invalid');
});

test('non-canonical base64 is invalid', async () => {
  const canonical = keyA.record.publicKeySpkiBase64;
  const newline = await validateVerificationKeyRecords([record({ publicKeySpkiBase64: `${canonical.slice(0, 10)}\n${canonical.slice(10)}` })]);
  assert.equal(newline.valid, false);
  // Same 44 decoded bytes but a non-canonical final group (non-zero pad bits).
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const last = canonical.at(-2);
  const mutated = `${canonical.slice(0, -2)}${alphabet[alphabet.indexOf(last) ^ 1]}=`;
  const recoded = await validateVerificationKeyRecords([record({ publicKeySpkiBase64: mutated })]);
  assert.equal(recoded.valid, false);
  const diagnostic = recoded.diagnostics.find(item => item.path === '/0/publicKeySpkiBase64');
  assert.ok(diagnostic);
});

test('a wrong algorithm, DER prefix or DER length is invalid', async () => {
  assert.equal((await validateVerificationKeyRecords([record({ algorithm: 'ed25519' })])).valid, false);
  assert.equal((await validateVerificationKeyRecords([record({ algorithm: 'RSA' })])).valid, false);
  const tamper = (mutate, path) => {
    const der = Buffer.from(keyA.der);
    mutate(der);
    return validateVerificationKeyRecords([record({
      publicKeySpkiBase64: der.toString('base64'),
      keyId: `ed25519:${createHash('sha256').update(der).digest('hex')}`
    })]).then(result => ({ result, path }));
  };
  const prefix = await tamper(der => { der[7] ^= 1; }, '/0/publicKeySpkiBase64');
  assert.equal(prefix.result.valid, false);
  assert.ok(prefix.result.diagnostics.some(item => item.path === prefix.path));
  const truncated = await tamper(() => {}, '/0/publicKeySpkiBase64');
  assert.equal(truncated.result.valid, true);
  const short = Buffer.from(keyA.der).subarray(0, 43);
  const shortResult = await validateVerificationKeyRecords([record({
    publicKeySpkiBase64: short.toString('base64'),
    keyId: `ed25519:${createHash('sha256').update(short).digest('hex')}`
  })]);
  assert.equal(shortResult.valid, false);
});

test('identity, purposes and record-shape violations are invalid with indexed paths', async () => {
  const cases = [
    ['empty identity', record({ identity: '' }), '/0/identity'],
    ['control identity', record({ identity: 'key\none' }), '/0/identity'],
    ['oversized identity', record({ identity: 'x'.repeat(300) }), '/0/identity'],
    ['empty purposes', record({ purposes: [] }), '/0/purposes'],
    ['duplicate purposes', record({ purposes: ['scan-report', 'scan-report'] }), '/0/purposes'],
    ['unknown purpose', record({ purposes: ['other'] }), '/0/purposes'],
    ['extra record key', { ...record(), extra: 1 }, '/0'],
    ['missing record key', (({ keyId, ...rest }) => rest)(record()), '/0'],
    ['non-object record', 'not-a-record', '/0']
  ];
  for (const [label, bad, path] of cases) {
    const validation = await validateVerificationKeyRecords([bad]);
    assert.equal(validation.valid, false, label);
    assert.ok(validation.diagnostics.some(item => item.code === 'INPUT_INVALID' && item.path === path),
      `${label}: ${JSON.stringify(validation.diagnostics)}`);
  }
  assert.equal((await validateVerificationKeyRecords('nope')).valid, false);
});

test('duplicate keyIds across records are invalid and block selection entirely', async () => {
  const duplicate = { ...keyB.record, keyId: keyA.record.keyId };
  const validation = await validateVerificationKeyRecords([keyA.record, duplicate]);
  assert.equal(validation.valid, false);
  assert.ok(validation.diagnostics.some(item => item.path === '/1/keyId'));
  const selected = await selectVerificationKeys('scan-report', [keyA.record, duplicate]);
  assert.equal(selected.status, 'invalid');
});

test('the shipped inventory is an explicitly empty frozen array with the documented purposes', async () => {
  assert.deepEqual(verificationKeys, []);
  assert.equal(Object.isFrozen(verificationKeys), true);
  assert.deepEqual([...verificationKeyPurposes], ['scan-report']);
  assert.equal(Object.isFrozen(verificationKeyPurposes), true);
  assert.deepEqual(await selectVerificationKeys('scan-report'), { status: 'selected', keys: [] });
  assert.equal((await validateVerificationKeyRecords(verificationKeys)).valid, true);
});

test('importing contracts.mjs pulls no node: built-ins through its import chain', () => {
  const seen = new Set();
  const visit = url => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    let text;
    try {
      text = readFileSync(url, 'utf8');
    } catch {
      return; // generated-at-build modules such as distribution.mjs have no src copy
    }
    assert.equal(/from\s+['"]node:|require\(\s*['"]node:|import\s*\(\s*['"]node:/.test(text), false, url.href);
    for (const match of text.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g))
      visit(new URL(match[1], url));
  };
  visit(new URL('../../src/harness/contracts.mjs', import.meta.url));
});
