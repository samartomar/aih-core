import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const INSTALLED = process.env.AIHQ_TEST_LINUX_INSTALLED_CORE;
let client;
function enabled() {
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid() === 0 ||
      !INSTALLED || !isAbsolute(INSTALLED) || !INSTALLED.includes('/node_modules/@aihq/core')) return false;
  try {
    client = JSON.parse(process.env.AIHQ_TEST_LINUX_CLIENT_PIN ?? '');
    return lstatSync(INSTALLED).isDirectory() && JSON.parse(readFileSync(join(INSTALLED, 'package.json'), 'utf8')).name === '@aihq/core' &&
      client !== null && typeof client === 'object' && !Array.isArray(client) &&
      Object.keys(client).sort().join(',') === 'byteLength,path,sha256' &&
      typeof client.path === 'string' && isAbsolute(client.path) && lstatSync(client.path).isFile() &&
      typeof client.sha256 === 'string' && /^[0-9a-f]{64}$/.test(client.sha256) &&
      Number.isSafeInteger(client.byteLength) && client.byteLength > 0;
  } catch { return false; }
}

test('an installed scoped package prepares the real pinned sandbox without starting the client', {
  skip: enabled() ? false : 'Linux x64 host with the pinned runtime and an installed @aihq/core package only', timeout: 120_000
}, async () => {
  const installed = name => import(pathToFileURL(join(INSTALLED, 'dist/harness/native', name)).href);
  const { observeLinuxNativePolicy } = await installed('linux-client.mjs');
  const { resolveLinuxPlatform } = await installed('linux-platform.mjs');
  const { verifyLinuxVendorClosure } = await installed('linux-runtime.mjs');
  const { linuxObserverPins, prepareLinuxSandboxContext } = await installed('linux-sandbox.mjs');
  const { createClaudeCollector } = await installed('collector.mjs');
  const { nativeVerificationDefinitions } = await installed('contracts.mjs');
  const definition = nativeVerificationDefinitions.find(value => value.platform.os === 'linux' &&
    value.schema === 'urn:aihq:harness:native-verification-definition:1.1.0');
  assert.ok(definition);
  const deadline = performance.now() + 110_000;
  const check = () => assert.ok(performance.now() < deadline, 'preparation deadline');
  assert.equal(observeLinuxNativePolicy(definition.platform.execution).outcome, 'file-sources-clear');
  const platform = await resolveLinuxPlatform({ client, check }); check();
  assert.equal(platform.status, 'ready', platform.reason);
  const vendor = verifyLinuxVendorClosure({ check }); check();
  assert.equal(vendor.status, 'ready', vendor.reason);
  const pins = [...new Map([...platform.pins, ...vendor.pins, ...linuxObserverPins()].map(pin => [pin.path, pin])).values()];
  const runtime = { ...platform.runtime, libraryClosure: platform.libraryClosure, ldLibraryPath: platform.ldLibraryPath };
  const collector = createClaudeCollector({ expected: { accountUuid: '', organizationId: '' } });
  let cell, marker, context;
  try {
    const telemetry = await collector.start(); check();
    cell = { path: realpathSync.native(mkdtempSync(join(tmpdir(), 'aih-native-installed-'))) };
    chmodSync(cell.path, 0o700);
    assert.equal(cell.path.includes('@'), false);
    for (const name of ['home', 'project', 'scratch', 'credentials', 'observations']) {
      cell[name] = join(cell.path, name); mkdirSync(cell[name], { mode: 0o700 });
    }
    marker = join(cell.project, '.aih-native-version');
    writeFileSync(marker, 'fixed-version-probe', { flag: 'wx', mode: 0o600 });
    const prepared = await prepareLinuxSandboxContext({ cell, runtime, vendor, phase: 'preflight', collector: telemetry,
      execution: definition.platform.execution, deadline, signal: undefined, runtimePins: pins,
      selectedEntries: [], selectedPaths: [marker], expectedArgv: definition.versionArgv });
    context = prepared.context;
    assert.equal(prepared.status, 'ready', 'preparation must be ready from the installed scoped path');
    const receipt = await context.terminate({ graceMs: 0, deadlineMs: 10000 });
    await collector.cancel();
    assert.equal(receipt.processes, 'confirmed'); assert.deepEqual(receipt.survivors, []);
  } finally {
    try { await context?.terminate({ graceMs: 0, deadlineMs: 10000 }); }
    finally {
      try { await collector.cancel(); }
      finally {
        try { if (marker && existsSync(marker)) unlinkSync(marker); }
        finally {
          if (cell) { rmSync(cell.path, { recursive: true, force: true }); assert.equal(existsSync(cell.path), false); }
        }
      }
    }
  }
});
