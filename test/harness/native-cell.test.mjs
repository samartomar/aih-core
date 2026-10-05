import assert from 'node:assert/strict';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOwnedCell, stageCellFiles, observeCellConfiguration, removeOwnedCell, windowsDaclPrincipals }
  from '../../src/harness/native/cell.mjs';
import { resolveBundledFixture, verifyFixtureMaterials } from '../../src/harness/native/digest.mjs';

const fixture = () => {
  const resolved = resolveBundledFixture('claude');
  assert.equal(verifyFixtureMaterials(resolved).ok, true);
  return resolved;
};
const expectation = resolved => ({ outputPaths: resolved.outputPaths, guardrailPaths: resolved.guardrailPaths,
  outputTreeSha256: resolved.outputTreeSha256, guardrailsSha256: resolved.guardrailsSha256 });
const parentDir = () => mkdtempSync(join(tmpdir(), 'aihq-cell-parent-'));

test('a cell is an exclusive owner-only child with separated areas', () => {
  const parent = parentDir();
  try {
    const first = createOwnedCell({ parent });
    const second = createOwnedCell({ parent });
    assert.equal(first.status, 'created');
    assert.notEqual(first.cell.basename, second.cell.basename);
    assert.match(first.cell.basename, /^aihq-native-[0-9a-f]{16}$/);
    for (const area of ['home', 'project', 'scratch', 'credentials', 'observation'])
      assert.ok(lstatSync(first.cell[area]).isDirectory(), area);
    assert.ok(lstatSync(join(first.cell.scratch, 'tmp')).isDirectory());
    assert.equal(removeOwnedCell(first.cell, { processesConfirmed: true }).files, 'removed');
    assert.equal(existsSync(first.cell.path), false);
    assert.equal(existsSync(parent), true, 'the caller parent is never removed');
    assert.equal(existsSync(second.cell.path), true, 'a sibling cell is untouched');
    removeOwnedCell(second.cell, { processesConfirmed: true });
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('unusable parents are sandbox-root-unavailable without creating anything', () => {
  const parent = parentDir();
  try {
    assert.deepEqual(createOwnedCell({ parent: 'relative/path' }), { status: 'unavailable', reason: 'sandbox-root-unavailable' });
    assert.deepEqual(createOwnedCell({ parent: join(parent, 'missing') }), { status: 'unavailable', reason: 'sandbox-root-unavailable' });
    writeFileSync(join(parent, 'file'), 'x');
    assert.deepEqual(createOwnedCell({ parent: join(parent, 'file') }), { status: 'unavailable', reason: 'sandbox-root-unavailable' });
    assert.deepEqual(createOwnedCell({ parent: `${parent}\0x` }), { status: 'unavailable', reason: 'sandbox-root-unavailable' });
    assert.deepEqual(createOwnedCell({ parent: 'C'.repeat(4097) }), { status: 'unavailable', reason: 'sandbox-root-unavailable' });
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('a linked parent is rejected', t => {
  const parent = parentDir();
  try {
    try { symlinkSync(parent, join(parent, 'link'), 'junction'); } catch { t.skip('links not permitted'); return; }
    assert.deepEqual(createOwnedCell({ parent: join(parent, 'link') }), { status: 'unavailable', reason: 'sandbox-root-unavailable' });
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('staging writes pinned bytes once and observation reports them unchanged', () => {
  const parent = parentDir();
  const resolved = fixture();
  try {
    const { cell } = createOwnedCell({ parent });
    assert.deepEqual(stageCellFiles(cell, resolved.files), { status: 'staged' });
    assert.deepEqual(readFileSync(join(cell.project, 'CLAUDE.md')), Buffer.from(resolved.files.find(f => f.path === 'CLAUDE.md').bytes));
    const seen = observeCellConfiguration(cell, expectation(resolved));
    assert.equal(seen.status, 'unchanged');
    assert.match(seen.stagedConfigurationDigest, /^[0-9a-f]{64}$/);
    // never restages: a second write to an existing selected file is refused
    assert.equal(stageCellFiles(cell, resolved.files).status, 'unavailable');
    removeOwnedCell(cell, { processesConfirmed: true });
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('unsafe member paths are refused before any write', () => {
  const parent = parentDir();
  try {
    const { cell } = createOwnedCell({ parent });
    for (const path of ['../x', 'a/../x', '/abs', 'a\\b', 'C:/x', 'a/./b', '', 'a//b']) {
      assert.deepEqual(stageCellFiles(cell, [{ root: 'project', path, bytes: Buffer.from('x') }]), { status: 'unavailable', reason: 'material-path-unsafe' }, path);
    }
    assert.deepEqual(stageCellFiles(cell, [{ root: 'scratch', path: 'x', bytes: Buffer.from('x') }]), { status: 'unavailable', reason: 'material-path-unsafe' });
    removeOwnedCell(cell, { processesConfirmed: true });
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('mutation, deletion, replacement and new loading files are configuration-changed', () => {
  const parent = parentDir();
  const resolved = fixture();
  try {
    const { cell } = createOwnedCell({ parent });
    stageCellFiles(cell, resolved.files);
    const expected = expectation(resolved);
    writeFileSync(join(cell.project, 'CLAUDE.md'), 'rewritten by the client');
    assert.equal(observeCellConfiguration(cell, expected).status, 'changed');
    writeFileSync(join(cell.project, 'CLAUDE.md'), resolved.files.find(f => f.path === 'CLAUDE.md').bytes);
    assert.equal(observeCellConfiguration(cell, expected).status, 'unchanged');
    rmSync(join(cell.home, '.claude', 'settings.json'));
    assert.equal(observeCellConfiguration(cell, expected).status, 'changed');
    writeFileSync(join(cell.home, '.claude', 'settings.json'), resolved.files.find(f => f.path === '.claude/settings.json').bytes);
    assert.equal(observeCellConfiguration(cell, expected).status, 'unchanged');
    writeFileSync(join(cell.home, '.claude', 'CLAUDE.md'), 'new user instruction');
    const conflict = observeCellConfiguration(cell, expected);
    assert.equal(conflict.status, 'changed');
    assert.equal(conflict.unexpectedLoadingFiles, 1);
    rmSync(join(cell.home, '.claude', 'CLAUDE.md'));
    // client-owned state may change without affecting the configuration digest
    writeFileSync(join(cell.home, '.claude', '.credentials.json'), 'client state');
    mkdirSync(join(cell.home, '.claude', 'projects'), { recursive: true });
    assert.equal(observeCellConfiguration(cell, expected).status, 'unchanged');
    removeOwnedCell(cell, { processesConfirmed: true });
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('a hard-linked selected file is not accepted as unchanged', () => {
  const parent = parentDir();
  const resolved = fixture();
  try {
    const { cell } = createOwnedCell({ parent });
    stageCellFiles(cell, resolved.files);
    // replace the selected file with a hard link that carries the same bytes as the pin
    const bytes = resolved.files.find(f => f.path === '.mcp.json').bytes;
    writeFileSync(join(parent, 'outside.txt'), bytes);
    rmSync(join(cell.project, '.mcp.json'));
    linkSync(join(parent, 'outside.txt'), join(cell.project, '.mcp.json'));
    assert.equal(observeCellConfiguration(cell, expectation(resolved)).status, 'changed');
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('cleanup keeps the cell when processes are unconfirmed or the root was replaced', () => {
  const parent = parentDir();
  try {
    const { cell } = createOwnedCell({ parent });
    const kept = removeOwnedCell(cell, { processesConfirmed: false });
    assert.equal(kept.files, 'retained');
    assert.equal(kept.reason, 'termination-unresolved');
    assert.equal(kept.retainedCell, cell.basename);
    assert.equal(existsSync(cell.path), true);
    // replace the root: same name, different directory identity
    renameSync(cell.path, join(parent, 'moved'));
    mkdirSync(cell.path);
    writeFileSync(join(cell.path, 'precious.txt'), 'not ours');
    const replaced = removeOwnedCell(cell, { processesConfirmed: true });
    assert.equal(replaced.files, 'retained');
    assert.equal(replaced.reason, 'cleanup-unresolved');
    assert.equal(existsSync(join(cell.path, 'precious.txt')), true);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('on Windows the child DACL is limited to the owner and OS administrators', t => {
  if (process.platform !== 'win32') { t.skip('Windows only'); return; }
  const parent = parentDir();
  try {
    const { cell } = createOwnedCell({ parent });
    const principals = windowsDaclPrincipals(cell.path);
    assert.equal(principals.status, 'observed');
    const allowed = new Set(['SY', 'BA', 'LA', 'S-1-5-18', 'S-1-5-32-544']);
    const others = principals.sids.filter(sid => !allowed.has(sid));
    assert.ok(others.length <= 1, 'at most the current user SID remains besides OS administrators');
    for (const sid of others) assert.match(sid, /^S-1-5-21-/);
    for (const broad of ['WD', 'BU', 'AU', 'IU', 'S-1-1-0', 'S-1-5-32-545', 'S-1-5-11']) assert.ok(!principals.sids.includes(broad), broad);
    removeOwnedCell(cell, { processesConfirmed: true });
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
