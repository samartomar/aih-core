import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLinuxCanaries } from '../../src/harness/native/linux-canaries.mjs';

test('outside canaries cover four host locations and report host changes without returning their bytes', t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aih-canary-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const roots = Object.fromEntries(['home', 'sibling', 'temporary', 'provisioner', 'agent'].map(name => [name, join(root, name)]));
  for (const path of Object.values(roots)) mkdirSync(path, { mode: 0o700 });
  const canaries = createLinuxCanaries(roots);
  assert.deepEqual(Object.keys(canaries.files), ['home', 'sibling', 'temporary', 'provisioner']);
  assert.deepEqual(canaries.snapshot(), { readIntact: true, writeAbsent: true });
  for (const [name, path] of Object.entries(canaries.files)) {
    assert.ok(path.startsWith(roots[name])); assert.equal(readFileSync(path).length, 32);
  }
  writeFileSync(canaries.writes[0], 'synthetic-write', { flag: 'wx' });
  assert.deepEqual(canaries.snapshot(), { readIntact: true, writeAbsent: false });
  writeFileSync(canaries.files.sibling, 'changed');
  assert.deepEqual(canaries.snapshot(), { readIntact: false, writeAbsent: false });
  assert.equal(canaries.remove(), true);
  for (const path of Object.values(canaries.files)) assert.equal(existsSync(path), false);
  assert.equal(canaries.remove(), true);
});

test('canary cleanup preserves unexpected material and reports unresolved resources', t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aih-canary-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canaries = createLinuxCanaries(Object.fromEntries(['home', 'sibling', 'temporary', 'provisioner', 'agent'].map(name => [name, root])));
  const extra = join(canaries.agentDirectory, 'keep'); writeFileSync(extra, 'unowned');
  assert.equal(canaries.remove(), false); assert.equal(readFileSync(extra, 'utf8'), 'unowned');
});
