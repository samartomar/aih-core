import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { captureInlineMaterials, captureRecipeReference, MATERIAL_LIMITS } from '../dist/internal/material.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const recipe = materials => Buffer.from(JSON.stringify({
  schema: 'urn:aihq:core:recipe:1.0.0', id: 'test', description: 'test', inputs: {},
  materials: materials.map(({ id, sha256, byteLength }) => ({ id, sha256, byteLength })),
  targets: ['project'], prerequisites: [], operations: [], checks: []
}));
const member = (id, path, bytes) => ({ id, path, sha256: sha(bytes), byteLength: bytes.length });
const localReference = (recipeBytes, materials = []) => ({
  source: { kind: 'local', input: 'source' }, path: 'recipe.json',
  sha256: sha(recipeBytes), byteLength: recipeBytes.length, materials
});
function archive(entries) {
  const blocks = [];
  for (const { path, bytes = Buffer.alloc(0), type = '0', mode = 0o644 } of entries) {
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, 'utf8');
    header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(32, 148, 156);
    header.write(type, 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const sum = header.reduce((total, value) => total + value, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
const archiveReference = (bytes, recipeBytes, materials = []) => ({
  source: { kind: 'archive', url: 'https://example.test/material.tar.gz', sha256: sha(bytes), byteLength: bytes.length },
  path: 'recipe.json', sha256: sha(recipeBytes), byteLength: recipeBytes.length, materials
});
async function withArchive(bytes, fn) {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_url, options) => {
    requests++;
    assert.equal(options.redirect, 'error');
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  };
  try { return await fn(() => requests); }
  finally { globalThis.fetch = original; }
}

test('local capture pins recipe and named material; returned byte copies cannot alter custody', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-material-'));
  const helper = Buffer.from('opaque helper bytes');
  const materials = [member('helper', 'bin/helper', helper)];
  const bytes = recipe(materials);
  try {
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'recipe.json'), bytes);
    writeFileSync(join(root, 'bin', 'helper'), helper);
    const capture = await captureRecipeReference(localReference(bytes, materials), { source: root });
    assert.deepEqual(capture.readRecipe(), bytes);
    assert.deepEqual(capture.readMaterial('helper'), helper);
    assert.equal(capture.readMaterial('unknown'), undefined);
    capture.readMaterial('helper')[0] = 0;
    assert.deepEqual(capture.readMaterial('helper'), helper);
    assert.equal(await capture.recheck(), true);
    writeFileSync(join(root, 'bin', 'helper'), Buffer.from('changed helper bytes'));
    assert.equal(await capture.recheck(), false);
    assert.deepEqual(capture.readMaterial('helper'), helper);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('local capture rejects altered bytes, absent roots and incomplete recipe closure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-material-'));
  const helper = Buffer.from('helper');
  const materials = [member('helper', 'helper.bin', helper)];
  const bytes = recipe(materials);
  try {
    writeFileSync(join(root, 'recipe.json'), bytes);
    writeFileSync(join(root, 'helper.bin'), helper);
    await assert.rejects(captureRecipeReference(localReference(bytes, materials), {}), /local-root-unavailable/);
    await assert.rejects(captureRecipeReference(localReference(bytes, []), { source: root }), /material-closure-mismatch/);
    const altered = { ...localReference(bytes, materials), sha256: sha(Buffer.from('wrong')) };
    await assert.rejects(captureRecipeReference(altered, { source: root }), /member-identity-mismatch|recipe-identity-mismatch/);
    await assert.rejects(captureRecipeReference({ ...localReference(bytes), path: '../recipe.json' }, { source: root }), /unsafe-member-path/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HTTPS tar-gzip capture validates archive identity, members and immutable recheck', async () => {
  const helper = Buffer.from('run me');
  const materials = [member('helper', 'bin/helper', helper)];
  const bytes = recipe(materials);
  const packed = archive([{ path: 'recipe.json', bytes }, { path: 'bin/', type: '5' },
    { path: 'bin/helper', bytes: helper, mode: 0o755 }]);
  await withArchive(packed, async requests => {
    const captured = await captureRecipeReference(archiveReference(packed, bytes, materials));
    assert.deepEqual(captured.readRecipe(), bytes);
    assert.deepEqual(captured.readMaterial('helper'), helper);
    assert.equal(await captured.recheck(), true);
    assert.equal(requests(), 1);
  });
  await withArchive(packed, async () => {
    const wrong = archiveReference(packed, bytes, materials);
    wrong.source.sha256 = sha(Buffer.from('different archive'));
    await assert.rejects(captureRecipeReference(wrong), /archive-identity-mismatch/);
  });
});

test('archive rejects unsafe entry types, traversal, case collision and unreferenced executable', async () => {
  const bytes = recipe([]);
  const badEntries = [
    [{ path: 'recipe.json', bytes }, { path: 'link', type: '2' }],
    [{ path: 'recipe.json', bytes }, { path: '../escape', bytes: Buffer.from('x') }],
    [{ path: 'recipe.json', bytes }, { path: 'A', bytes: Buffer.from('x') }, { path: 'a', bytes: Buffer.from('y') }],
    [{ path: 'recipe.json', bytes }, { path: 'extra.sh', bytes: Buffer.from('x'), mode: 0o755 }]
  ];
  for (const entries of badEntries) {
    const packed = archive(entries);
    await withArchive(packed, () => assert.rejects(captureRecipeReference(archiveReference(packed, bytes)),
      /unsafe-tar-entry|unsafe-member-path|duplicate-tar-target|unreferenced-executable/));
  }
});

test('declared bounds reject before fetch and cancellation starts no acquisition', async () => {
  const bytes = recipe([]);
  const packed = archive([{ path: 'recipe.json', bytes }]);
  await withArchive(packed, async requests => {
    const reference = archiveReference(packed, bytes);
    reference.source.byteLength = MATERIAL_LIMITS.compressedBytes + 1;
    await assert.rejects(captureRecipeReference(reference), /invalid-archive-source/);
    assert.equal(requests(), 0);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(captureRecipeReference(archiveReference(packed, bytes), {}, { signal: abort.signal }), /cancelled/);
    assert.equal(requests(), 0);
  });
});

test('inline members use explicit local and archive sources with shared immutable capture', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-inline-'));
  const local = Buffer.from('local');
  const remote = Buffer.from('remote');
  const packed = archive([{ path: 'remote.bin', bytes: remote }]);
  try {
    writeFileSync(join(root, 'local.bin'), local);
    await withArchive(packed, async requests => {
      const capture = await captureInlineMaterials([
        { ...member('local', 'local.bin', local), source: { kind: 'local', input: 'source' } },
        { ...member('remote', 'remote.bin', remote), source: {
          kind: 'archive', url: 'https://example.test/material.tar.gz', sha256: sha(packed), byteLength: packed.length } }
      ], { source: root });
      assert.deepEqual(capture.readMaterial('local'), local);
      assert.deepEqual(capture.readMaterial('remote'), remote);
      assert.equal(requests(), 1);
      assert.equal(await capture.recheck(), true);
      writeFileSync(join(root, 'local.bin'), Buffer.from('other'));
      assert.equal(await capture.recheck(), false);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
