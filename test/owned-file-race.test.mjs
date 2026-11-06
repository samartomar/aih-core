// The owned-file transaction places a file's final name in the folder it checked: a parent swapped for a link after the
// check is refused, and nothing lands outside the root. Built-artifact fault injection: no public entry can swap a
// folder at that instant.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnedFileTransaction } from '../dist/core/internal/owned-file-transaction.js';

const scratch = mkdtempSync(join(tmpdir(), 'aih-owned-race-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('a parent folder swapped for a link to another folder after it was checked is refused, and nothing is written there', () => {
  const root = join(scratch, 'root'); const outside = join(scratch, 'outside');
  mkdirSync(join(root, 'sub'), { recursive: true }); mkdirSync(outside);
  const tx = new OwnedFileTransaction(root, { label: 'test', maxFileBytes: 1024, contentDirectoryMode: 0o700, stateDirectoryMode: 0o700,
    statePaths: new Set(), assertOwnedPath() {}, assertResolvedSegments() {} });
  const prepare = tx.prepareDirectory;
  tx.prepareDirectory = function (path) {
    const directory = prepare.call(this, path);
    renameSync(join(root, 'sub'), join(scratch, 'moved'));
    symlinkSync(outside, join(root, 'sub'), 'junction');
    return directory;
  };
  assert.throws(() => tx.commit([{ action: 'write', path: 'sub/file.txt', mode: 0o600, contents: Buffer.from('one'), expect: { absent: true } }]));
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(existsSync(join(scratch, 'moved', 'file.txt')), false);
});
