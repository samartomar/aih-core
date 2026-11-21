// Maintainer-only reproduction of the checked-in sandbox-runtime npm input.
// Normal Core builds and installed consumers never run this script.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create, extract, list } from 'tar';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = join(root, 'vendor/sandbox-runtime');
const fromJson = file => JSON.parse(readFileSync(file, 'utf8'));
const provenance = fromJson(join(vendor, 'provenance.json'));
const filename = `anthropic-ai-sandbox-runtime-${provenance.version}.tgz`;
const target = join(vendor, filename);
const [artifactArg, sourceArg, action] = process.argv.slice(2);
assert.ok(artifactArg && sourceArg && ['--check', '--write'].includes(action) && process.argv.length === 5,
  'Expected <upstream npm archive> <upstream source archive> --check|--write');
assert.ok(process.env.npm_execpath, 'Run through npm run rebuild:sandbox-runtime');
const artifact = resolve(artifactArg), source = resolve(sourceArg);
const hash = (file, algorithm, encoding) => createHash(algorithm).update(readFileSync(file)).digest(encoding);
assert.equal(`sha512-${hash(artifact, 'sha512', 'base64')}`, provenance.upstreamNpmIntegrity);
assert.equal(hash(source, 'sha256', 'hex'), provenance.upstreamSourceSha256);

const scratch = mkdtempSync(join(tmpdir(), 'aih-sandbox-runtime-'));
try {
  const modes = new Map();
  list({ file: artifact, sync: true, onReadEntry(entry) {
    assert.equal(entry.type, 'File');
    assert.ok(!modes.has(entry.path));
    modes.set(entry.path, entry.mode);
  } });
  extract({ file: artifact, cwd: scratch, sync: true, strict: true });
  extract({ file: source, cwd: scratch, sync: true, strict: true });
  const upstream = join(scratch, `sandbox-runtime-${provenance.upstreamReleaseCommit}`);
  const packageDirectory = join(scratch, 'package');
  const manifestPath = join(packageDirectory, 'package.json');
  const manifest = fromJson(manifestPath);
  assert.equal(manifest.name, provenance.name);
  assert.equal(manifest.version, provenance.upstreamVersion);
  const upstreamManifestPath = join(upstream, 'package.json');
  const upstreamManifest = fromJson(upstreamManifestPath);
  assert.deepEqual(upstreamManifest, manifest);

  const sourceLockPath = join(upstream, 'package-lock.json');
  const sourceLock = fromJson(sourceLockPath);
  const runtimeDependencies = { ...manifest.dependencies };
  for (const [name, record] of Object.entries(provenance.patchedDependencies)) {
    sourceLock.packages[`node_modules/${name}`] = record;
    runtimeDependencies[name] = record.version;
  }
  const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  sourceLock.packages[''].dependencies = runtimeDependencies;
  writeJson(sourceLockPath, sourceLock);
  writeJson(upstreamManifestPath, { ...upstreamManifest, dependencies: runtimeDependencies });
  writeJson(manifestPath, { ...manifest, version: provenance.version, dependencies: runtimeDependencies,
    aihqPatch: `Core backport for Zod 4 and patched Forge, based on ${provenance.upstreamReleaseCommit}` });
  const readmePath = join(packageDirectory, 'README.md');
  const readme = readFileSync(readmePath, 'utf8');
  const patchedReadme = readme.replace(/^\*\*zod 4 in the same dependency tree:\*\*.*$/mu,
    '**AIH Core packaging change:** This derived distribution uses the Zod 4 schema API directly.');
  assert.notEqual(patchedReadme, readme);
  writeFileSync(readmePath, patchedReadme);

  const configPath = join(upstream, 'src/sandbox/sandbox-config.ts');
  const config = readFileSync(configPath, 'utf8');
  const migrated = config.replace(/\/\/ The 'zod\/v3' subpath[^\n]*\n(?:\/\/[^\n]*\n)+import \{ z \} from 'zod\/v3'/u,
    "// Modified by the AIH Core authors: use the patched Zod 4 implementation.\nimport { z } from 'zod'");
  assert.notEqual(migrated, config);
  writeFileSync(configPath, migrated);
  const run = args => execFileSync(process.execPath, args, { cwd: upstream, stdio: ['ignore', 2, 2], windowsHide: true });
  run([process.env.npm_execpath, 'ci', '--ignore-scripts', '--no-fund', '--no-audit']);
  run([join(upstream, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--newLine', 'lf']);

  // Retain the exact official release files outside the schema and a declaration
  // whose inferred type changes when the schema uses Zod 4.
  for (const name of ['sandbox-config.d.ts', 'sandbox-config.d.ts.map', 'sandbox-config.js', 'sandbox-config.js.map',
    'credential-aws-pairs.d.ts', 'credential-aws-pairs.d.ts.map']) {
    const path = `dist/sandbox/${name}`;
    assert.ok(modes.has(`package/${path}`));
    const built = join(upstream, path), destination = join(packageDirectory, path);
    if (name.endsWith('.d.ts')) writeFileSync(destination, readFileSync(built, 'utf8').replace('//# sourceMappingURL=',
      '// Modified by the AIH Core authors: declaration emitted against Zod 4.\n//# sourceMappingURL='));
    else copyFileSync(built, destination);
  }

  const output = join(scratch, filename);
  create({ file: output, cwd: scratch, sync: true, portable: true, mtime: new Date('1985-10-26T08:15:00Z'),
    gzip: { level: 9 }, filter(path, entry) { entry.mode = (entry.mode & ~0o7777) | modes.get(path); return true; } }, [...modes.keys()]);
  const observedModes = new Map();
  list({ file: output, sync: true, onReadEntry(entry) { observedModes.set(entry.path, entry.mode); } });
  assert.deepEqual(observedModes, modes, 'The derived archive must retain all published paths and modes');
  if (action === '--write') copyFileSync(output, target);
  else assert.ok(readFileSync(output).equals(readFileSync(target)), 'The checked-in sandbox runtime archive differs');
  console.log(JSON.stringify({ version: provenance.version, filename, sha256: hash(output, 'sha256', 'hex'),
    integrity: `sha512-${hash(output, 'sha512', 'base64')}` }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
