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

// Layouts where Core is reached through a link: pnpm's store, and `npm link` or a `file:` link to a checkout. The peer
// is loaded in a child process whose main script stands where the project's own code would.
const { spawnSync } = await import('node:child_process');
const { symlinkSync } = await import('node:fs');
const link = (target, path) => { mkdirSync(join(path, '..'), { recursive: true }); symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir'); };
const coreAt = folder => {
  mkdirSync(join(folder, 'dist', 'core', 'internal'), { recursive: true });
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: '@aihq/core', version: '0.0.0-test', type: 'module' }));
  copyFileSync(new URL('../dist/core/internal/peer.js', import.meta.url), join(folder, 'dist', 'core', 'internal', 'peer.js'));
};
/** Run `main` (a script written at that path) that loads `@aihq/scan/read` through the given Core folder. */
function loadFrom(main, core, env = {}) {
  mkdirSync(join(main, '..'), { recursive: true });
  writeFileSync(main, `const m = await import(${JSON.stringify(pathToFileURL(join(core, 'dist', 'core', 'internal', 'peer.js')).href)});\n` +
    `const r = await m.loadPeer('@aihq/scan/read'); console.log(JSON.stringify({ status: r.status, marker: r.module?.marker ?? null, version: r.version ?? null }));\n`);
  const child = spawnSync(process.execPath, [main], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim().split('\n').at(-1));
}
const layout = (name, body) => async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `aih-peer-${name}-`)));
  try { await body(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

test('a pnpm install loads the peer from its store, and still refuses one linked from outside', layout('pnpm', root => {
  const store = join(root, 'proj', 'node_modules', '.pnpm');
  const core = join(store, '@aihq+core@0.1.0', 'node_modules', '@aihq', 'core'); coreAt(core);
  scanPackage(join(store, '@aihq+scan@0.1.0', 'node_modules', '@aihq', 'scan'), 'store');
  link(join(store, '@aihq+scan@0.1.0', 'node_modules', '@aihq', 'scan'), join(store, '@aihq+core@0.1.0', 'node_modules', '@aihq', 'scan'));
  link(core, join(root, 'proj', 'node_modules', '@aihq', 'core'));
  assert.deepEqual(loadFrom(join(root, 'proj', 'app.mjs'), core), { status: 'loaded', marker: 'store', version: '0.1.0' });
  // The same layout with the peer linked to a folder outside the project's node_modules.
  const other = join(root, 'other');
  const core2 = join(other, 'proj', 'node_modules', '.pnpm', '@aihq+core@0.1.0', 'node_modules', '@aihq', 'core'); coreAt(core2);
  scanPackage(join(root, 'evil', 'scan'), 'evil');
  link(join(root, 'evil', 'scan'), join(other, 'proj', 'node_modules', '.pnpm', '@aihq+core@0.1.0', 'node_modules', '@aihq', 'scan'));
  assert.equal(loadFrom(join(other, 'proj', 'app.mjs'), core2).status, 'outside');
}));

test('a linked Core loads peers only from its own real layout, never from the project or a parent folder', layout('link', root => {
  const checkout = join(root, 'dev', 'aih-core'); coreAt(checkout);
  // A planted `node_modules/@aihq/core` link to the checkout plus a stand-in peer, in a parent of the checkout.
  link(checkout, join(root, 'dev', 'node_modules', '@aihq', 'core'));
  scanPackage(join(root, 'dev', 'node_modules', '@aihq', 'scan'), 'planted');
  assert.equal(loadFrom(join(checkout, 'scripts', 'x.mjs'), checkout).status, 'outside');
  assert.equal(loadFrom(join(root, 'dev', 'app.mjs'), checkout).status, 'outside');
  // A project whose own node_modules links to the checkout: its peer is not loaded either.
  const project = join(root, 'work', 'proj');
  link(checkout, join(project, 'node_modules', '@aihq', 'core'));
  scanPackage(join(project, 'node_modules', '@aihq', 'scan'), 'project');
  assert.notEqual(loadFrom(join(project, 'app.mjs'), checkout).status, 'loaded');
  assert.notEqual(loadFrom(join(project, 'node_modules', '@aihq', 'core', 'dist', 'core', 'bin.mjs'), checkout).status, 'loaded');
  // The checkout's own node_modules is part of its real layout and loads.
  scanPackage(join(checkout, 'node_modules', '@aihq', 'scan'), 'checkout');
  assert.deepEqual(loadFrom(join(project, 'app.mjs'), checkout), { status: 'loaded', marker: 'checkout', version: '0.1.0' });
}));
