import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { release, tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { trustCapabilities } from '../../dist/harness/contracts.mjs';
import { detectCertificateExportPlatform, exactExportRelease } from '../../src/harness/trust-export-platform.mjs';
const source = fileURLToPath(new URL('../../', import.meta.url));
const scratch = join(source, '.scratch');
for (const scenario of ['identity-change', 'identity-failure', 'policy-change', 'helper-change'])
  test(`controlled public consumer refuses ${scenario} at Apply without writing export output`, { skip: process.platform !== 'win32' || process.arch !== 'x64' }, () => {
    mkdirSync(scratch, { recursive: true }); const root = mkdtempSync(join(scratch, 'migration-public-'));
    const home = mkdtempSync(join(tmpdir(), 'aih-core81-controlled-home-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'core81-controlled-consumer', private: true, type: 'module' }));
      const installed = join(root, 'node_modules/@aihq/core'); mkdirSync(installed, { recursive: true });
      cpSync(join(source, 'dist'), join(installed, 'dist'), { recursive: true });
      cpSync(join(source, 'package.json'), join(installed, 'package.json'));
      assert.ok(trustCapabilities.cells.some(cell => cell.platform.release === exactExportRelease &&
        cell.network === 'off' && cell.configurationProfile === 'pem-server-ca-v1'), 'use the shipped genuine admission data');
      cpSync(join(source, 'test/fixtures/trust-migration-consumer.mjs'), join(root, 'consumer.mjs'));
      const env = { ...process.env, USERPROFILE: home, HOME: home };
      for (const key of Object.keys(env)) if (/^(NODE_OPTIONS|NODE_PATH|NODE_TEST_CONTEXT)$/i.test(key)) delete env[key];
      const output = execFileSync(process.execPath, [join(root, 'consumer.mjs'), scenario, installed, join(source, 'test/harness/fixtures/root-a.pem')],
        { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 1048576 });
      assert.equal(JSON.parse(output).outcome, 'stale-refused-output-absent');
    } finally {
      assert.ok(resolve(root).startsWith(resolve(scratch) + sep)); rmSync(root, { recursive: true, force: true });
      assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep)); rmSync(home, { recursive: true, force: true });
    }
  });
test('actual read-only collector cannot be redirected by SystemRoot or PSModulePath', { skip: process.platform !== 'win32' || release() !== '10.0.26340' }, () => {
  const expected = detectCertificateExportPlatform();
  const module = fileURLToPath(new URL('../../src/harness/trust-export-platform.mjs', import.meta.url));
  // Change the caller environment after Node's own Windows crypto/runtime initialization.
  const code = `process.env.SystemRoot='C:/untrusted-observer-root'; process.env.PSModulePath='C:/untrusted-modules'; process.env.COR_ENABLE_PROFILING='1'; process.env.COR_PROFILER_PATH='C:/untrusted-profiler.dll'; const {detectCertificateExportPlatform}=await import(${JSON.stringify(new URL('file:///' + module.replaceAll('\\','/')).href)}); console.log(JSON.stringify(detectCertificateExportPlatform()));`;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env }, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  assert.deepEqual(JSON.parse(result), expected);
});
