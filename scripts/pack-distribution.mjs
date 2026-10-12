// Developer-only packaging: normalize the supplied executable's archive mode.
// Installed consumers never execute this script or repair package permissions.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, constants, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create, list } from 'tar';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--pack-destination'),
  'Use npm run pack:distribution -- [--pack-destination <existing directory>]');
assert.ok(process.env.npm_execpath, 'Run through npm run pack:distribution');
const destination = resolve(args[1] ?? root);
const member = 'package/dist/harness/native/linux/facility';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@aihq/core');
const filename = `aihq-core-${manifest.version}.tgz`;
const scratch = mkdtempSync(join(tmpdir(), 'aih-pack-distribution-'));

async function inventory(file) {
  const entries = [];
  await list({ file, onReadEntry(entry) {
    const hash = createHash('sha256');
    const row = {};
    for (const key of ['path', 'type', 'mode', 'uid', 'gid', 'uname', 'gname', 'size', 'mtime', 'atime', 'ctime', 'linkpath', 'devmaj', 'devmin'])
      row[key] = entry[key];
    entry.on('data', bytes => hash.update(bytes));
    entry.on('end', () => { row.sha256 = hash.digest('hex'); });
    entries.push(row);
  } });
  return entries;
}

try {
  // Send build diagnostics to stderr; stdout identifies only the final artifact.
  execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { cwd: root, stdio: ['ignore', 2, 2] });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
  const [packed] = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath,
    'pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: root, env, encoding: 'utf8', timeout: 120_000 }));
  assert.equal(packed.filename, filename);
  const input = join(scratch, filename), output = join(scratch, 'distribution.tgz');
  const before = await inventory(input);
  const helpers = before.filter(entry => entry.path === member);
  assert.equal(helpers.length, 1, 'Expected exactly one Linux facility archive entry');
  const helper = helpers[0];
  assert.equal(helper.type, 'File');
  const record = JSON.parse(readFileSync(join(root, 'dist/harness/native/linux/build-record.json'), 'utf8'));
  const pin = record.resources.find(value => value.name === 'facility');
  assert.equal(helper.size, pin.byteLength);
  assert.equal(helper.sha256, pin.sha256);
  create({ file: output, sync: true, gzip: { level: 9 }, filter(path, entry) {
    if (path === member) entry.mode = 0o755;
    return true;
  } }, [`@${input}`]);
  const after = await inventory(output);
  const expected = before.map(entry => entry.path === member ? { ...entry, mode: 0o755 } : entry);
  assert.deepEqual(after, expected, 'Packaging may change only the Linux facility archive mode');
  const bytes = readFileSync(output);
  // Exclusive copy preserves any previously qualified artifact at this name.
  const target = join(destination, filename);
  copyFileSync(output, target, constants.COPYFILE_EXCL);
  process.stdout.write(JSON.stringify([{ name: manifest.name, version: manifest.version, filename,
    size: bytes.length, sha256: sha(bytes), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    files: after.map(entry => ({ path: entry.path.replace(/^package\//, ''), size: entry.size, mode: entry.mode })) }], null, 2) + '\n');
} finally { rmSync(scratch, { recursive: true, force: true }); }
