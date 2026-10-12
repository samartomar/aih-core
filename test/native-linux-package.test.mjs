import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { list } from 'tar';

test('the Linux facility remains executable in the archive and clean scripts-disabled installs', { timeout: 300_000 }, async t => {
  assert.ok(process.env.npm_execpath, 'Run with npm test so the npm CLI is known.');
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'aih-linux-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const producer = join(root, 'producer'); mkdirSync(producer);
  copyFileSync(join(packageRoot, 'package.json'), join(producer, 'package.json'));
  for (const name of ['package-lock.json', 'tsconfig.json']) copyFileSync(join(packageRoot, name), join(producer, name));
  for (const name of ['src', 'scripts']) cpSync(join(packageRoot, name), join(producer, name), { recursive: true });
  symlinkSync(join(packageRoot, 'node_modules'), join(producer, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const member = 'dist/harness/native/linux/facility';
  // A Windows producer does not supply POSIX executable bits. Do not let the
  // developer checkout's executable bit hide that packaging requirement.
  chmodSync(join(producer, 'src/harness/native/linux/facility'), 0o644);
  const env = { ...process.env, HOME: join(root, 'home'), USERPROFILE: join(root, 'home') };
  mkdirSync(env.HOME);
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
  const run = (args, cwd, mask) => {
    // Set umask in the child alone; other package tests may run concurrently.
    const launcher = 'import{pathToFileURL}from"node:url";if(process.platform!=="win32")process.umask(Number(process.argv[1]));process.argv.splice(1,1);await import(pathToFileURL(process.argv[1]));';
    return execFileSync(process.execPath, ['--input-type=module', '-e', launcher, String(mask), ...args],
      { cwd, env, encoding: 'utf8', timeout: 120_000, windowsHide: true });
  };
  const npm = (args, cwd, mask) => run([process.env.npm_execpath, ...args], cwd, mask);
  const pack = args => run([join(producer, 'scripts/pack-distribution.mjs'), ...args], producer, 0o022);
  const packed = JSON.parse(pack(['--build', '--pack-destination', root]))[0];
  assert.equal(packed.files.find(value => value.path === member)?.mode, 0o755,
    'the archive must declare the facility executable even when producer files have no executable bits');
  // Read the actual archive header independently of the packaging summary.
  const headers = [];
  list({ file: join(root, packed.filename), sync: true, onReadEntry: entry => {
    if (entry.path === `package/${member}`) headers.push({ mode: entry.mode, type: entry.type });
  } });
  assert.deepEqual(headers, [{ mode: 0o755, type: 'File' }]);
  // Packing an already-built tree must not rebuild it: other test processes
  // and consumers may be reading the same output at the same time.
  const identityFile = join(producer, 'dist/distribution.mjs');
  const identityBefore = lstatSync(identityFile, { bigint: true });
  const secondDestination = join(root, 'second'); mkdirSync(secondDestination);
  pack(['--pack-destination', secondDestination]);
  const identityAfter = lstatSync(identityFile, { bigint: true });
  assert.deepEqual([identityAfter.ino, identityAfter.mtimeNs, identityAfter.ctimeNs],
    [identityBefore.ino, identityBefore.mtimeNs, identityBefore.ctimeNs], 'packing must leave built inputs untouched');
  if (process.platform !== 'linux' || process.arch !== 'x64') return;
  const record = JSON.parse(readFileSync(join(producer, 'dist/harness/native/linux/build-record.json'), 'utf8'));
  const pin = record.resources.find(value => value.name === 'facility');
  for (const mask of [0o077, 0o022]) await t.test(`clean install with umask ${mask.toString(8)}`, () => {
    const consumer = join(root, `consumer-${mask.toString(8)}`); mkdirSync(consumer);
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(root, packed.filename)], consumer, mask);
    const facility = join(consumer, 'node_modules/@aihq/core', member);
    const info = lstatSync(facility), bytes = readFileSync(facility);
    assert.ok(info.isFile() && !info.isSymbolicLink()); assert.equal(info.nlink, 1);
    assert.equal(info.mode & 0o7022, 0, 'no set-id bits or group/other writes');
    assert.equal(bytes.length, pin.byteLength);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256);
    accessSync(facility, constants.X_OK);
    // EOF terminates only the helper protocol; no client, sandbox or model runs.
    const result = spawnSync(facility, [], { input: '', timeout: 5000 });
    assert.ifError(result.error); assert.equal(result.status, 0);
  });
});
