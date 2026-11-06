// An update's new data and origin are recorded under the target's state lock; a record that cannot be written is
// reported on the run, never swallowed. Built-artifact coverage: no public entry can hold the lock at that instant.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordUpdate } from '../dist/core/plan/update.js';

const scratch = mkdtempSync(join(tmpdir(), 'aih-update-record-'));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let home;
before(() => { home = join(scratch, 'home'); mkdirSync(home); process.env.HOME = home; process.env.USERPROFILE = home; });
after(() => { for (const [key, value] of Object.entries(previous)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
} rmSync(scratch, { recursive: true, force: true }); });

const sha256 = value => createHash('sha256').update(value).digest('hex');

test('an update whose record cannot be written while another process holds the lock is incomplete, never silently complete', async () => {
  const target = join(scratch, 'project'); mkdirSync(target);
  const { realpathSync } = await import('node:fs');
  const root = realpathSync.native(target);
  const state = join(home, '.aih', 'core'); mkdirSync(state, { recursive: true, mode: 0o700 });
  const lock = join(state, `lock-${sha256(root)}`);
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'holder.json'), JSON.stringify({ pid: process.ppid, host: hostname() }), { mode: 0o600 });
  try {
    const run = { completion: 'complete', steps: [] };
    await recordUpdate(run, { data: { repository: 'https://example.invalid/data', commit: 'b'.repeat(40) }, origin: 'chosen',
      claims: [{ root, identity: 'x' }], kept: [] }, AbortSignal.timeout(400));
    assert.deepEqual([run.completion, run.reason], ['incomplete', 'record-not-updated']);
  } finally { rmSync(join(lock, 'holder.json')); rmdirSync(lock); }
});
