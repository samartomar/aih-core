import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import test from 'node:test';
import { candidateOrigins, selectTrustCandidateWith } from '../candidate.mjs';
import { getRepairRecipe, prepareRepairDefinition } from '../runtime.mjs';
import { repairIndex } from '../contracts.mjs';

const read = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const rootA = read('root-a.pem'), rootB = read('root-b.pem');
const leafA = read('leaf-a.pem'), leafB = read('leaf-b.pem');
const raw = pem => new X509Certificate(pem).raw;
const one = 'https://one.example.test', two = 'https://two.example.test';

test('candidate origins are bounded exact HTTPS origins', () => {
  assert.deepEqual(candidateOrigins([one, one]), [one]);
  for (const value of ['http://one.example.test', `${one}/path`, `${one}?x=1`,
    'https://u:p@one.example.test', 'https://one.example.test#x'])
    assert.equal(candidateOrigins([value]), undefined);
  assert.equal(candidateOrigins(Array(7).fill(one)), undefined);
});

test('system CA is selected before root inventory when OS passes and Node rejects the chain', async () => {
  const calls = [];
  const result = await selectTrustCandidateWith([one], {
    probe: async kind => { calls.push(kind); return kind === 'node' ?
      { kind: 'failed', reason: 'certificate-chain' } : { kind: 'passed' }; },
    systemRoots: async () => { throw Error('root inventory must not run'); }
  });
  assert.equal(result.kind, 'system-ca');
  assert.deepEqual(calls, ['os', 'node', 'system-ca']);
});

test('extra CA search selects only valid OS roots signing every peer chain', async () => {
  const calls = [];
  const result = await selectTrustCandidateWith([one, two], {
    probe: async (kind, origin, roots) => {
      calls.push([kind, origin, roots.length]);
      if (kind === 'node') return { kind: 'failed', reason: 'certificate-chain' };
      if (kind === 'system-ca') return { kind: 'failed', reason: 'certificate-chain' };
      if (kind === 'capture') return { kind: 'captured', chain: [raw(origin === one ? leafA : leafB)] };
      return { kind: 'passed' };
    },
    systemRoots: async () => ({ kind: 'completed', roots: [rootB, rootA, rootA, read('not-ca.pem')] })
  });
  assert.equal(result.kind, 'extra-ca');
  assert.deepEqual(new Set(result.certs.map(cert => cert.fingerprint)), new Set([rootA, rootB].map(pem =>
    new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase())));
  assert.equal(calls.filter(call => call[0] === 'extra-ca').length, 2);
});

test('root ceiling and unavailable inventory remain distinct unresolved assessments', async () => {
  const probe = async kind => kind === 'node' ? { kind: 'failed', reason: 'certificate-chain' } :
    kind === 'capture' ? { kind: 'captured', chain: [raw(leafA)] } :
    kind === 'system-ca' ? { kind: 'failed', reason: 'certificate-chain' } : { kind: 'passed' };
  const limit = await selectTrustCandidateWith([one], { probe,
    systemRoots: async () => ({ kind: 'completed', roots: Array(1025).fill(rootA) }) });
  assert.equal(limit.reason, 'root-count');
  const unavailable = await selectTrustCandidateWith([one], { probe,
    systemRoots: async () => ({ kind: 'unavailable', reason: 'root-inventory' }) });
  assert.equal(unavailable.reason, 'root-inventory');
  const oversized = await selectTrustCandidateWith([one], { probe,
    systemRoots: async () => ({ kind: 'completed', roots: [rootA, 'X'.repeat(65537)] }) });
  assert.equal(oversized.reason, 'root-bytes');
  const overlongChain = await selectTrustCandidateWith([one], {
    probe: async kind => kind === 'node' ? { kind: 'failed', reason: 'certificate-chain' } :
      kind === 'system-ca' ? { kind: 'failed', reason: 'certificate-chain' } :
        kind === 'capture' ? { kind: 'captured', chain: Array(9).fill(raw(leafA)) } : { kind: 'passed' },
    systemRoots: async () => { throw Error('overlong chain must not reach root inventory'); }
  });
  assert.equal(overlongChain.reason, 'peer-count');
});

test('late probe and late root inventory cannot turn an expired assessment into success', async () => {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const lateProbe = await selectTrustCandidateWith([one], {
    probe: async kind => {
      if (kind === 'node') return { kind: 'failed', reason: 'certificate-chain' };
      if (kind === 'system-ca') await delay(30);
      return { kind: 'passed' };
    }, systemRoots: async () => { throw Error('inventory must not run'); }
  }, { budgetMs: 10 });
  assert.equal(lateProbe.kind, 'unresolved');
  assert.equal(lateProbe.reason, 'deadline');
  const lateInventory = await selectTrustCandidateWith([one], {
    probe: async kind => kind === 'node' || kind === 'system-ca' ?
      { kind: 'failed', reason: 'certificate-chain' } : kind === 'capture' ?
        { kind: 'captured', chain: [raw(leafA)] } : { kind: 'passed' },
    systemRoots: async () => { await delay(30); return { kind: 'completed', roots: [rootA] }; }
  }, { budgetMs: 10 });
  assert.equal(lateInventory.kind, 'unresolved');
  assert.equal(lateInventory.reason, 'deadline');
});

test('cancellation during a pending system probe stays cancelled after its late success', async () => {
  const controller = new AbortController();
  const result = await selectTrustCandidateWith([one], {
    probe: async kind => {
      if (kind === 'node') return { kind: 'failed', reason: 'certificate-chain' };
      if (kind === 'system-ca') {
        setTimeout(() => controller.abort(), 5);
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      return { kind: 'passed' };
    }, systemRoots: async () => { throw Error('inventory must not run'); }
  }, { signal: controller.signal, budgetMs: 1000 });
  assert.equal(result.kind, 'unresolved');
  assert.equal(result.reason, 'cancelled');
});

test('finite system and extra recipes bind the selected OS candidate without changing graphs', () => {
  const variants = repairIndex.find(item => item.id === 'node-os-trust').variants
    .filter(item => item.os === process.platform && item.architectures.includes(process.arch));
  assert.equal(variants.length, 2);
  for (const variant of variants) {
    const before = getRepairRecipe(variant.recipeRef);
    const candidate = variant.candidate === 'system-ca' ? { kind: 'system-ca', origins: [one] } :
      { kind: 'extra-ca', origins: [one], certs: [{
        fingerprint: new X509Certificate(rootA).fingerprint256.replaceAll(':', '').toLowerCase(), pem: rootA }] };
    const result = prepareRepairDefinition({ id: 'node-os-trust', variantRef: variant.recipeRef,
      targets: ['node'], files: {}, candidate, managedPath: '/managed/trust.pem', offline: false });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.bundle === undefined, variant.candidate === 'system-ca');
    assert.deepEqual(Object.keys(result.bindings).sort(),
      Object.keys(before.inputs).filter(name => !before.inputs[name].sensitive).sort());
    assert.deepEqual(getRepairRecipe(variant.recipeRef), before);
  }
});
