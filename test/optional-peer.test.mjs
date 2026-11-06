// Optional peers (`@aihq/scan/read`, `@aihq/catalog/*`) are loaded only from Core's own package folder or the
// `node_modules` holding `@aihq/core`; a same-named package in a parent folder is not loaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const scanPackage = (folder, marker) => {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: '@aihq/scan', version: '0.1.0', type: 'module', exports: { './read': './read.mjs' } }));
  writeFileSync(join(folder, 'read.mjs'), `export const marker = ${JSON.stringify(marker)};\nexport async function verifySummary() { return { status: 'stand-in', verified: false }; }\nexport async function matchScan() { return { status: 'stand-in' }; }\n`);
};
const catalogPackage = folder => {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: '@aihq/catalog', version: '9.8.7', type: 'module', exports: { './reader': './reader.mjs' } }));
  writeFileSync(join(folder, 'reader.mjs'), 'export function renderStep() { return {}; }\n');
};
// A copy of Core's built loader at its installed place: `<app>/node_modules/@aihq/core/dist/core/internal/peer.js`.
const installedCore = app => {
  const core = join(app, 'node_modules', '@aihq', 'core');
  mkdirSync(join(core, 'dist', 'core', 'internal'), { recursive: true });
  writeFileSync(join(core, 'package.json'), JSON.stringify({ name: '@aihq/core', version: '0.0.0-test', type: 'module' }));
  copyFileSync(new URL('../dist/core/internal/peer.js', import.meta.url), join(core, 'dist', 'core', 'internal', 'peer.js'));
  return pathToFileURL(join(core, 'dist', 'core', 'internal', 'peer.js')).href;
};

test('a stand-in peer in a parent folder is not loaded', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aih-peer-parent-')));
  try {
    scanPackage(join(root, 'node_modules', '@aihq', 'scan'), 'parent');
    catalogPackage(join(root, 'node_modules', '@aihq', 'catalog'));
    const { loadPeer } = await import(installedCore(join(root, 'app')));
    assert.deepEqual(await loadPeer('@aihq/scan/read'), { status: 'outside' });
    assert.deepEqual(await loadPeer('@aihq/catalog/reader'), { status: 'outside' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a peer beside Core in the same node_modules is loaded by its file URL, with its own version', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aih-peer-sibling-')));
  try {
    scanPackage(join(root, 'node_modules', '@aihq', 'scan'), 'parent');
    scanPackage(join(root, 'app', 'node_modules', '@aihq', 'scan'), 'sibling');
    catalogPackage(join(root, 'app', 'node_modules', '@aihq', 'catalog'));
    const { loadPeer } = await import(installedCore(join(root, 'app')));
    const scan = await loadPeer('@aihq/scan/read');
    assert.equal(scan.status, 'loaded');
    assert.equal(scan.module.marker, 'sibling');
    assert.equal(scan.version, '0.1.0');
    const reader = await loadPeer('@aihq/catalog/reader');
    assert.equal(reader.status, 'loaded');
    assert.equal(reader.version, '9.8.7');
    assert.equal(typeof reader.module.renderStep, 'function');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an absent peer or an unexported subpath is reported, not thrown', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aih-peer-absent-')));
  try {
    catalogPackage(join(root, 'app', 'node_modules', '@aihq', 'catalog'));
    const { loadPeer } = await import(installedCore(join(root, 'app')));
    assert.deepEqual(await loadPeer('@aihq/scan/read'), { status: 'missing' });
    assert.deepEqual(await loadPeer('@aihq/catalog/node'), { status: 'not-exported' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
