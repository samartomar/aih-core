// Scan memory: entries from signers no request trusted have their own budget and can't push out trusted ones, and a
// write merges with what another operation stored meanwhile, keeping the highest values per key under the state lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryKey, mergeEntry, readMemory, rememberEntries, SCAN_MEMORY_BYTES, UNTRUSTED_MEMORY_BYTES, writeMemory } from '../dist/core/scan/memory.js';
import { forgetProvenState, lockTarget, stateRoot } from '../dist/core/internal/state.js';

function withHome(body) {
  const root = mkdtempSync(join(tmpdir(), 'aih-scan-memory-'));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const home = join(root, 'home'); mkdirSync(home);
  process.env.HOME = home; process.env.USERPROFILE = home; forgetProvenState();
  try { return body(home); } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    forgetProvenState(); rmSync(root, { recursive: true, force: true });
  }
}
const key = index => `git-sha1:${index.toString(16).padStart(40, '0')}`;
const entry = (index, { subject = 'https://signer.test.invalid/a', trusted = false, revision = 1, seen = 1 } = {}) => ({
  scanKey: key(index), issuer: 'https://issuer.test.invalid', subject, revision, withdrawnThrough: null, seen, ...(trusted ? { trusted: true } : {}) });
const mapOf = entries => new Map(entries.map(value => [memoryKey(value.scanKey, value.issuer, value.subject), value]));
const stored = () => JSON.parse(readFileSync(join(stateRoot(), 'scans.json'), 'utf8')).entries;

test('untrusted entries keep within their own budget and never push out trusted ones, even when fresh', () => withHome(() => {
  const trusted = Array.from({ length: 50 }, (_, index) => entry(index, { trusted: true, seen: 1 }));
  const noise = Array.from({ length: 6000 }, (_, index) => entry(100_000 + index, { subject: `https://test.invalid/noise-${index}-${'x'.repeat(300)}`, seen: 2 }));
  const entries = mapOf([...trusted, ...noise]);
  const fresh = new Set(noise.map(value => memoryKey(value.scanKey, value.issuer, value.subject)));
  const result = writeMemory(entries, new Set(), fresh);
  assert.equal(result.written, true);
  const kept = stored();
  assert.equal(kept.filter(row => row.trusted === true).length, 50, 'every trusted entry is kept');
  const untrustedBytes = kept.filter(row => row.trusted !== true).reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row)) + 1, 0);
  assert.ok(untrustedBytes <= UNTRUSTED_MEMORY_BYTES, String(untrustedBytes));
  assert.ok(Buffer.byteLength(readFileSync(join(stateRoot(), 'scans.json'))) <= SCAN_MEMORY_BYTES);
  assert.equal(readMemory().entries.size, kept.length);
}));

test('a write merges with what was stored meanwhile, keeping the highest revision and withdrawal per key', () => withHome(() => {
  const a = entry(1, { revision: 5, seen: 10 });
  assert.equal(writeMemory(mapOf([a, entry(2, { revision: 7, seen: 10 })]), new Set(), new Set()).written, true);
  // This operation read before the other wrote, and saw revision 3 and a withdrawal through 2 for key 1.
  const mine = { ...entry(1, { revision: 3, seen: 20 }), withdrawnThrough: 2 };
  const result = rememberEntries(mapOf([mine]), new Set(), new Set([memoryKey(mine.scanKey, mine.issuer, mine.subject)]));
  assert.equal(result.written, true);
  const rows = new Map(stored().map(row => [row.scanKey, row]));
  assert.deepEqual([rows.get(key(1)).revision, rows.get(key(1)).withdrawnThrough, rows.get(key(1)).seen], [5, 2, 20]);
  assert.equal(rows.get(key(2)).revision, 7, 'an entry this operation never touched is kept');
}));

test('trust is kept once any sighting trusted the signer', () => {
  assert.equal(mergeEntry(entry(1, { trusted: true }), entry(1)).trusted, true);
  assert.equal(mergeEntry(entry(1), entry(1)).trusted, undefined);
});

test('while another process holds the memory lock, the memory is left as it is and nothing is refused', () => withHome(() => {
  writeMemory(mapOf([entry(1, { revision: 4 })]), new Set(), new Set());
  // A lock with a holder that is still running (this test's own parent) is never taken over.
  const unlock = lockTarget('aih-core:scan-memory');
  try {
    // Name a holder that is still running (this test's parent), so the lock is not reclaimable.
    const folder = readdirSync(stateRoot()).find(name => name.startsWith('lock-'));
    writeFileSync(join(stateRoot(), folder, 'holder.json'), JSON.stringify({ pid: process.ppid, host: hostname() }));
    const result = rememberEntries(mapOf([entry(1, { revision: 9 })]), new Set(), new Set());
    assert.deepEqual(result, { written: false, heldEvicted: false });
    assert.equal(stored()[0].revision, 4);
  } finally { unlock(); }
}));
