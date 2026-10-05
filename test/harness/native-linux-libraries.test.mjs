import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageLinuxLibraryClosure } from '../../src/harness/native/linux-libraries.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const setup = t => {
  const directory = mkdtempSync(join(tmpdir(), 'aih-libraries-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'libsample.so.1.2'); writeFileSync(source, 'synthetic-lib');
  const pin = { source, sha256: hash('synthetic-lib'), byteLength: 13, names: ['libsample.so.1.2', 'libsample.so.1'] };
  return { directory, source, pin };
};
test('a fixed library closure exposes regular pinned bytes at each recorded soname', t => {
  const { directory, pin } = setup(t);
  const staged = stageLinuxLibraryClosure({ directory, closure: [pin] });
  assert.deepEqual(readdirSync(staged.directory).sort(), ['libsample.so.1', 'libsample.so.1.2']);
  for (const member of staged.pins) { assert.equal(readFileSync(member.path, 'utf8'), 'synthetic-lib'); assert.equal(member.sha256, pin.sha256); }
  assert.equal(staged.pins.length, 2);
  assert.equal(staged.remove(), true);
  assert.deepEqual(readdirSync(directory), ['libsample.so.1.2']);
});
test('changed source bytes never produce a staged library', t => {
  const { directory, source, pin } = setup(t); writeFileSync(source, 'changed-bytes');
  assert.throws(() => stageLinuxLibraryClosure({ directory, closure: [pin] }), /runtime-changed/);
  assert.deepEqual(readdirSync(directory), ['libsample.so.1.2']);
});
test('library aliases cannot escape their directory or conceal conflicting bytes', t => {
  const { directory, source, pin } = setup(t);
  assert.throws(() => stageLinuxLibraryClosure({ directory, closure: [{ ...pin, names: ['../outside'] }] }), /runtime-changed/);
  const other = join(directory, 'other'); writeFileSync(other, 'different-lib');
  assert.throws(() => stageLinuxLibraryClosure({ directory, closure: [pin,
    { source: other, sha256: hash('different-lib'), byteLength: 13, names: ['libsample.so.1'] }] }), /runtime-changed/);
  assert.deepEqual(readdirSync(directory).sort(), ['libsample.so.1.2', 'other']);
  assert.equal(readFileSync(source, 'utf8'), 'synthetic-lib');
});
