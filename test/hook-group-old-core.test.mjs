import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { policy as legacyPolicy } from './fixture.mjs';
import { SETTINGS, hookOp, hookSelection, policy11, sandbox } from './hook-group-fixture.mjs';
import { compact, groupsOf, guard, neighbor, run } from './hook-group-harness.mjs';

// An old Core is the exact pre-feature source commit, built from the repository's own history.
const BASE = '225888273cb9b6e6222068277fbb4947b62ee313';
const root = fileURLToPath(new URL('../', import.meta.url));
const git = args => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const available = git(['cat-file', '-e', `${BASE}^{commit}`]).status === 0 && spawnSync('tar', ['--version']).status === 0;
// Keep the shared compiler's disposable build output in the worktree. Product effect targets
// still come from sandbox() outside the source checkout; this fixture only compiles old source.
mkdirSync(join(root, '.scratch'), { recursive: true });
const scratch = mkdtempSync(join(root, '.scratch', 'aih-old-core-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function buildOldCore() {
  const dir = join(scratch, 'old'); mkdirSync(dir);
  // The archive is piped through stdin so no drive-letter path reaches tar.
  const archive = execFileSync('git', ['-C', root, 'archive', '--format=tar', BASE], { maxBuffer: 256 * 1024 * 1024 });
  const extract = spawnSync('tar', ['-xf', '-'], { cwd: dir, input: archive });
  assert.equal(extract.status, 0, String(extract.stderr));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction');
  try { execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: dir, encoding: 'utf8' }); }
  catch (error) { throw new Error(`Old Core build failed:\n${error.stdout ?? ''}${error.stderr ?? ''}`); }
  writeFileSync(join(dir, 'old-run.mjs'), `
    import {readFileSync} from 'node:fs';
    import {pathToFileURL} from 'node:url';
    const [, , index, mode, project, file] = process.argv;
    const {prepare, apply} = await import(pathToFileURL(index).href);
    const p = await prepare({useCase: 'policy', policy: JSON.parse(readFileSync(file, 'utf8')), target: {project}}, {logging: 'off'});
    const out = {status: p.status, diagnostics: p.diagnostics, omissions: p.review?.omissions ?? [], schema: p.review?.schema};
    if (mode === 'apply' && p.prepared) out.completion = (await apply(p.prepared, {approved: true, origin: 'automation', reviewDigest: p.review.reviewDigest}, {logging: 'off'})).completion;
    console.log(JSON.stringify(out));`);
  return join(dir, 'dist/core/index.js');
}
const oldCore = (index, mode, project, policy) => {
  const file = join(scratch, `policy-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(policy));
  const result = spawnSync(process.execPath, [join(index, '../../../old-run.mjs'), index, mode, project, file], { encoding: 'utf8', env: process.env, timeout: 120_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
};
const ownership = s => existsSync(join(s.home, '.aih', 'core', 'ownership'));

test('an old Core fails closed on a 1.1 root, a new Core reads 1.0 roots, and the final removal restores old-Core compatibility', { skip: !available && 'the pre-feature commit is not available in this checkout' }, async () => {
  const index = buildOldCore();
  const s = sandbox();
  try {
    s.write(SETTINGS, compact([neighbor('a')]));
    // The old Core writes a 1.0 root; the new Core reads it and upgrades it on its first group write.
    assert.equal(oldCore(index, 'apply', s.project, legacyPolicy()).completion, 'complete');
    await run(s, guard());
    assert.equal(groupsOf(s).length, 2);
    const before = s.read(SETTINGS);
    const blocked = oldCore(index, 'prepare', s.project, legacyPolicy());
    assert.equal(blocked.status, 'invalid', 'the old Core cannot interpret 1.1 ownership');
    assert.equal(blocked.diagnostics[0].reason, 'ownership-invalid');
    assert.equal(oldCore(index, 'apply', s.project, legacyPolicy()).completion, undefined, 'no apply handle exists');
    assert.equal(s.read(SETTINGS), before, 'no mutation');
    // One project-scope group also withholds user-scope cleanup requested from another project.
    const other = join(s.root, 'other-project'); mkdirSync(other);
    const userRemoval = { schema: 'urn:aihq:core:execution-policy:1.0.0', mode: 'vibe', selections: [], removals: [{ managementId: 'anything', scope: 'user' }] };
    const withheld = oldCore(index, 'prepare', other, userRemoval);
    assert.ok(withheld.omissions.some(item => item.reason === 'dependency-custody-unverifiable'), JSON.stringify(withheld));
    // The reviewed removal of the final group writes 1.0 again and the old Core resumes.
    const removal = policy11([hookSelection('guard-a', [hookOp('drop', 'guard-a', { action: 'remove' })])]);
    await run(s, removal);
    assert.deepEqual(groupsOf(s), [neighbor('a')]);
    const resumed = oldCore(index, 'prepare', s.project, legacyPolicy());
    assert.equal(resumed.status, 'ready', JSON.stringify(resumed));
    assert.ok(ownership(s));
  } finally { s.dispose(); }
});
