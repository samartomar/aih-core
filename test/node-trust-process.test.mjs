import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import https from 'node:https';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRegistryCertificates } from './fixtures/tls-registry.mjs';

const exec = promisify(execFile);

test('selected npm uses effective system trust and respects an explicit CA override', {
  skip: process.platform !== 'linux' || !process.env.npm_execpath,
  timeout: 90000
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-node-trust-'));
  let server;
  try {
    const home = join(root, 'home'), bin = join(root, 'bin');
    mkdirSync(home); mkdirSync(bin);
    const certs = await createRegistryCertificates(['localhost']);
    const other = await createRegistryCertificates();
    const ca = join(root, 'system.pem'), override = join(root, 'override.pem');
    writeFileSync(ca, certs.caPem); writeFileSync(override, other.caPem);
    symlinkSync(process.execPath, join(bin, 'node'));
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\nexec '${process.execPath}' '${resolve(process.env.npm_execpath)}' "$@"\n`, { mode: 0o755 });
    // This fixture only exercises npm and Node processes, never curl/OS trust admission.
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    server = https.createServer({ cert: certs.leafPem, key: certs.keyPem }, (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const registry = `https://localhost:${server.address().port}`;
    const script = `import { diagnose } from '@aihq/core/harness/runtime';
      const result = await diagnose({requestId:'effective', targets:['npm'],network:'declared'});
      console.log(JSON.stringify(result.checks.find(check=>check.id==='npm/tls/effective')));`;
    const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: bin,
      SSL_CERT_FILE: ca, SSL_CERT_DIR: join(root, 'empty'), NODE_USE_SYSTEM_CA: '1',
      NPM_CONFIG_REGISTRY: registry, NPM_CONFIG_USERCONFIG: join(home, '.npmrc'),
      NPM_CONFIG_GLOBALCONFIG: join(home, 'global.npmrc'), npm_config_cache: join(root, 'cache') };
    for (const key of Object.keys(env)) if (/^(?:npm_config_(?:ca|cafile|strict_ssl)|node_options|node_extra_ca_certs|node_tls_reject_unauthorized|https?_proxy|all_proxy)$/i.test(key)) delete env[key];
    const observe = async extra => {
      const result = await exec(process.execPath, ['--input-type=module', '-e', script], {
        cwd: resolve('.'), env: { ...env, ...extra }, timeout: 25000, maxBuffer: 65536
      });
      return JSON.parse(result.stdout.trim());
    };
    assert.equal((await observe({})).outcome, 'passed');
    assert.equal((await observe({ NODE_USE_SYSTEM_CA: '0' })).outcome, 'failed');
    assert.equal((await observe({ NPM_CONFIG_CAFILE: override })).outcome, 'failed');
    assert.equal((await observe({ NPM_CONFIG_STRICT_SSL: 'false' })).reason, 'tls-verification-disabled');
    assert.equal((await observe({ NODE_OPTIONS: '--no-use-system-ca' })).outcome, 'failed');
    unlinkSync(join(bin, 'curl')); // Working Node trust needs no OS comparison helper or repair.
    const prepared = await exec(process.execPath, ['--input-type=module', '-e', `
      import { prepare } from '@aihq/core';
      const result = await prepare({useCase:'repair',repairs:[{id:'node-os-trust',targets:['node'],inputs:{originId:'npm-registry'}}]}, {logging:'off'});
      console.log(JSON.stringify(result));`], { cwd: resolve('.'), env, timeout: 25000, maxBuffer: 65536 });
    const noRepair = JSON.parse(prepared.stdout);
    assert.equal(noRepair.diagnostics[0].code, 'REPAIR_NOT_NEEDED');
    assert.equal(noRepair.diagnostics[0].reason, 'node-already-trusted');
    assert.equal(noRepair.prepared, undefined);
  } finally {
    await new Promise(resolve => server ? server.close(resolve) : resolve());
    rmSync(root, { recursive: true, force: true });
  }
});
