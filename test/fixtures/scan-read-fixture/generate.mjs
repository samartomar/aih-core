// Regenerates the Core-side `@aihq/scan` TEST FIXTURE in this folder from a checkout of samartomar/aih-scan:
//
//   node test/fixtures/scan-read-fixture/generate.mjs --scan <aih-scan checkout or exported tree> [--commit <sha>]
//
// `read.mjs` is Scan's own `@aihq/scan/read` module (src/public/read.ts) bundled unchanged except for two things: the
// shipped Sigstore trusted root is replaced by the trusted root of a private, offline TEST-ONLY universe (Scan's own
// tests/support/sigstore-v1-universe.ts), and `smol-toml`, which the read path never calls, is a stub. `vectors.json`
// holds summaries and withdrawals signed in that universe for the content it lists. None of this is production trust,
// a published Scan artifact or real Scan output; it lets Core's tests drive the real verify/match code offline.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const at = process.argv.indexOf('--scan');
assert.ok(at > 0 && process.argv[at + 1], 'usage: generate.mjs --scan <aih-scan checkout>');
const scan = resolve(process.argv[at + 1]);
const slash = path => path.replaceAll('\\', '/');
const named = process.argv.indexOf('--commit');
const commit = named > 0 ? process.argv[named + 1] : execFileSync('git', ['-C', scan, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.match(commit, /^[a-f0-9]{40}$/);
const work = mkdtempSync(join(tmpdir(), 'scan-fixture-'));
try {
  // The signing universe and Scan's own tree-key function, for building the vectors only.
  await build({ stdin: { contents: `export * from '${slash(join(scan, 'tests/support/sigstore-v1-universe.ts'))}';\n` +
      `export { scanKeyOf } from '${slash(join(scan, 'src/contracts/git-tree.ts'))}';\n`, resolveDir: scan, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'helper.mjs'), logLevel: 'warning' });
  const helper = await import(pathToFileURL(join(work, 'helper.mjs')).href);
  const world = helper.universe();
  const rootText = JSON.stringify(world.trustedRoot());

  const banner = `// TEST FIXTURE for @aihq/core tests: @aihq/scan/read bundled from samartomar/aih-scan ${commit} (Apache-2.0).\n` +
    '// Its Sigstore trusted root is a private TEST-ONLY universe, never production trust. Not a published Scan artifact.\n';
  await build({ entryPoints: ['src/public/read.ts'], absWorkingDir: scan, bundle: true, platform: 'neutral', format: 'esm',
    outfile: join(here, 'read.mjs'), banner: { js: banner }, logLevel: 'warning', legalComments: 'none',
    plugins: [{ name: 'fixture', setup(context) {
      context.onResolve({ filter: /sigstore-trusted-root\.js$/ }, () => ({ path: 'root', namespace: 'fixture-root' }));
      context.onLoad({ filter: /.*/, namespace: 'fixture-root' }, () => ({ loader: 'js',
        contents: `export const sigstoreTrustedRootText = ${JSON.stringify(rootText)};\n` }));
      context.onResolve({ filter: /^smol-toml$/ }, () => ({ path: 'smol-toml', namespace: 'fixture-stub' }));
      context.onLoad({ filter: /.*/, namespace: 'fixture-stub' }, () => ({ loader: 'js',
        contents: 'export function parse() { throw new Error("smol-toml is not part of the Core test fixture"); }\n' }));
    } }] });

  const A = { identity: 'TEST-ONLY signer A', ...helper.signerA };
  const B = { identity: 'TEST-ONLY signer B', ...helper.signerB };
  const content = {
    notes: { 'SKILL.md': '---\nname: notes\ndescription: Take notes\n---\nTake notes.\n', 'reference.md': 'Reference.\n' },
    tools: { 'SKILL.md': '---\nname: tools\ndescription: Use tools\n---\nUse the helper.\n', 'helper.md': 'Helper.\n' }
  };
  const sha = async bytes => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const tree = async files => Promise.all(Object.entries(files).map(async ([path, text]) =>
    ({ path, mode: '100644', bytes: Buffer.from(text) })));
  const keys = {};
  for (const [name, files] of Object.entries(content)) {
    const result = await helper.scanKeyOf(await tree(files));
    assert.equal(result.status, 'ok');
    keys[name] = result.scanKey;
  }
  const template = JSON.parse(readFileSync(join(scan, 'tests/fixtures/scan-v1/clean/summary.json'), 'utf8'));
  const summary = async (name, revision, score) => Buffer.from(`${JSON.stringify({ ...template, scanKey: keys[name], revision,
    score, label: score > 50 ? 'DO NOT INSTALL' : 'CAUTION', scannedAt: '2026-11-01T00:30:00Z',
    files: await Promise.all(Object.entries(content[name]).map(async ([path, text]) =>
      ({ path, mode: '100644', part: 'text', sha256: await sha(Buffer.from(text)) }))) }, null, 2)}\n`);
  const withdrawal = (name, throughRevision) => Buffer.from(`${JSON.stringify({ format: 'aih-scan-withdrawn/1', scanKey: keys[name],
    throughRevision, at: '2026-11-02T10:00:00Z', reason: 'TEST ONLY withdrawal' }, null, 2)}\n`);
  const asB = { leaf: { subject: helper.signerB.subject } };
  const signed = (bytes, options) => ({ text: bytes.toString('utf8'), bundle: helper.signedBundle(world, bytes, options) });
  const summaries = {
    'notes-r1-a': signed(await summary('notes', 1, 0)),
    'notes-r2-a': signed(await summary('notes', 2, 90)),
    'notes-r3-a': signed(await summary('notes', 3, 0)),
    'notes-r5-a': signed(await summary('notes', 5, 0)),
    'notes-r1-b': signed(await summary('notes', 1, 0), asB),
    'tools-r1-a': signed(await summary('tools', 1, 0))
  };
  const withdrawals = {
    'notes-through-3-a': signed(withdrawal('notes', 3)),
    'notes-through-9-b': signed(withdrawal('notes', 9), asB),
    'tools-through-9-a': signed(withdrawal('tools', 9))
  };

  // The bundled reader verifies what was signed: the vectors and the root agree.
  const read = await import(pathToFileURL(join(here, 'read.mjs')).href + `?${Date.now()}`);
  for (const [name, entry] of Object.entries(summaries)) {
    const result = await read.verifySummary(Buffer.from(entry.text), entry.bundle, [A]);
    assert.equal(result.status, 'ok', `${name}: ${JSON.stringify(result)}`);
    assert.equal(result.signer.trusted, !name.endsWith('-b'), name);
  }
  writeFileSync(join(here, 'vectors.json'), `${JSON.stringify({
    note: 'TEST ONLY. Signed in a private offline universe whose root only the bundled read.mjs fixture trusts.',
    scan: commit, signers: { A, B }, content, keys, summaries, withdrawals }, null, 2)}\n`);
  console.log(JSON.stringify({ scan: commit, keys }));
} finally { rmSync(work, { recursive: true, force: true }); }
