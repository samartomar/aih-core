// Controlled Windows consumer only. OS/tool doubles are not native acceptance evidence.
import assert from 'node:assert/strict';
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [scenario, packageRoot, certificatePath] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
os.release = () => '10.0.26340';
let changed = false; let observations = 0;
const nativeSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (executable, args, options) => {
  // Only replace the new read-only identity collector. Core's private-state ACL
  // protection still runs normally against this test's temporary home.
  if (!args.some(arg => typeof arg === 'string' && arg.includes('Win32_OperatingSystem'))) return nativeSpawnSync(executable, args, options);
  assert.equal(executable, 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
  assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
  assert.equal(options.env.SystemRoot, 'C:/Windows');
  assert.equal(options.env.PSModulePath, 'C:/Windows/System32/WindowsPowerShell/v1.0/Modules');
  assert.deepEqual(Object.keys(options.env).sort(), ['PATH','PSModulePath','SystemRoot','WINDIR']);
  assert.ok(args.includes('-NoProfile'));
  observations++;
  if (changed && scenario === 'identity-failure') return { status: 1, stdout: '', stderr: 'controlled collector failure' };
  return { status: 0, stdout: JSON.stringify({ cimVersion: '10.0.26340', currentBuild: '26340',
    ubr: changed && scenario === 'identity-change' ? 9768 : 9767, displayVersion: '26H2', architecture: 'AMD64',
    caption: 'Microsoft Windows 11 Pro Insider Preview' }), stderr: '' };
};
syncBuiltinESMExports();
assert.ok(fileURLToPath(import.meta.resolve('@aihq/core')).toLowerCase().startsWith((packageRoot + '\\').toLowerCase()), 'the test must use its isolated installed consumer');
const home = process.env.USERPROFILE;
mkdirSync(home, { recursive: true });
const { prepare, apply } = await import('@aihq/core');
const input = join(home, 'fixture.pem'); writeFileSync(input, readFileSync(certificatePath));
const preparation = await prepare({ schema: 'urn:aihq:core:certificate-export-request:1.0.0', useCase: 'certificate-export',
  format: 'pem', network: 'off', output: 'proof/controlled.pem', sources: { os: false, supplied: [{ id: 'fixture', file: input }] } }, { logging: 'off' });
assert.equal(preparation.status, 'ready', JSON.stringify(preparation.diagnostics));
assert.ok(observations > 0, 'new export classifier was used by public Prepare');
changed = true;
if (scenario === 'policy-change' || scenario === 'helper-change') {
  const file = join(packageRoot, 'dist/harness', scenario === 'policy-change' ? 'trust-migration-policy.mjs' : 'trust-export-platform.mjs');
  writeFileSync(file, readFileSync(file, 'utf8') + '\n// controlled post-Prepare change\n');
}
const result = await apply(preparation.prepared, { approved: true, origin: 'automation', reviewDigest: preparation.review.reviewDigest }, { logging: 'off' });
assert.ok(result.diagnostics.some(item => item.code === 'REVIEW_STALE'), JSON.stringify(result.diagnostics));
assert.equal(existsSync(join(home, 'proof/controlled.pem')), false, 'no export output after stale identity or bytes');
console.log(JSON.stringify({ scenario, outcome: 'stale-refused-output-absent', evidence: 'synthetic-controlled-consumer', nativeAcceptance: false }));
