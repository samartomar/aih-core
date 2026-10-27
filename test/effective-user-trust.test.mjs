import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as runtime from '@aihq/core/harness/runtime';

const fixture = (root, output) => {
  const file = join(root, 'tool');
  writeFileSync(file, `#!${process.execPath}\nconst a=process.argv.slice(2);\n${output}\n`, { mode: 0o755 });
  return file;
};

// Protocol fixtures exercise public decisions, never qualify an installed tool or platform.
test('effective trust refuses missing and incompatible selected Python without substituting PATH', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-effective-'));
  try {
    const absent = await runtime.inspectUserToolTrust({ target: 'python', executable: join(root, 'missing'), project: root, network: 'off' });
    assert.equal(absent.decision, 'blocked');
    assert.equal(absent.reason, 'executable-unavailable');
    const script = join(root, 'python.cjs');
    writeFileSync(script, `#!/usr/bin/env node\nconsole.log(JSON.stringify({version:'3.12.3',executable:${JSON.stringify(script)},prefix:'/fixture',basePrefix:'/fixture',openssl:'OpenSSL fixture',defaultPaths:{},pip:null}));\n`, { mode: 0o755 });
    if (process.platform === 'win32') return; // POSIX protocol launcher only.
    const old = await runtime.inspectUserToolTrust({ target: 'python', executable: script, project: root, network: 'off' });
    assert.equal(old.decision, 'blocked');
    assert.equal(old.reason, 'runtime-incompatible');
    assert.equal(old.observation.version, '3.12.3');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Git observes backend/config sources and refuses scoped or duplicate overrides', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-effective-'));
  const saved = Object.fromEntries(['GIT_CONFIG_COUNT','GIT_CONFIG_PARAMETERS','GIT_SSL_NO_VERIFY','GIT_SSL_CAINFO','GIT_SSL_CAPATH','GIT_CONFIG_GLOBAL','GIT_CONFIG_SYSTEM'].map(key => [key, process.env[key]]));
  try {
    for (const key of Object.keys(saved)) delete process.env[key];
    const executable = fixture(root, `if(a[0]==='--version')console.log('git version 2.56.0');else if(a[0]==='config')console.log('global\\tfile:/fixture/.gitconfig\\thttp.sslbackend openssl');else process.exit(0);`);
    const request = { target:'git', executable, project:root, network:'declared' };
    const working = await runtime.inspectUserToolTrust(request);
    assert.equal(working.decision, 'no-repair');
    assert.equal(working.observation.backend, 'openssl');
    assert.deepEqual(working.observation.configSources, ['global file:/fixture/.gitconfig']);
    fixture(root, `if(a[0]==='--version')console.log('git version 2.56.0');else console.log('local\\tfile:.git/config\\thttp.https://example.test.sslcainfo /other.pem');`);
    assert.equal((await runtime.inspectUserToolTrust(request)).reason, 'config-ambiguous');
    fixture(root, `if(a[0]==='--version')console.log('git version 2.56.0');else if(a[0]==='config')process.exit(1);`);
    assert.equal((await runtime.inspectUserToolTrust(request)).reason, 'backend-unconfirmed');
  } finally {
    for (const [key,value] of Object.entries(saved)) { if(value===undefined)delete process.env[key];else process.env[key]=value; }
    rmSync(root, { recursive:true, force:true });
  }
});

test('Conda native mode remains distinct from a CA file in inspection and offline repair', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-effective-'));
  try {
    const executable = fixture(root, `console.log(JSON.stringify(a.includes('-c')&&a.at(-1).includes('conda.__version__')?{version:'26.9.4',python:'3.15.2',executable:'/fixture/conda/python',prefix:'/fixture/conda',rootPrefix:'/fixture/conda',sslVerify:'truststore',configSources:['/fixture/.condarc'],openssl:'OpenSSL fixture'}:{tls:'passed'}));`);
    const observed = await runtime.inspectUserToolTrust({target:'conda',executable,project:root,network:'declared'});
    assert.equal(observed.decision,'no-repair');
    assert.equal(observed.observation.backend,'conda-truststore');
    const rendered = runtime.renderRepair({id:'user-tools-ca',variantRef:`user-tools-ca/${process.platform}/conda/off`,
      bundlePath:join(root,'trust.pem'),bundleSha256:'a'.repeat(64),configSnapshots:{'conda-config':Buffer.from('ssl_verify: truststore\n')} });
    assert.equal(rendered.status,'blocked');
    assert.equal(rendered.diagnostics[0].reason,'native-trust-selected');
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('Cargo observes Rust and its own backend separately before deciding trust', {skip:process.platform==='win32'}, async()=>{
  const root=mkdtempSync(join(tmpdir(),'aih-effective-'));
  const previous=process.env.CARGO_HOME;
  try {
    process.env.CARGO_HOME=join(root,'cargo-home');
    const executable=fixture(root, `if(a[0]==='-Vv')console.log('cargo 1.99.0 (fixture)\\nrelease: 1.99.0\\nhost: x86_64-unknown-linux-gnu\\nlibcurl: 8.0 (ssl:OpenSSL/3)\\nssl: OpenSSL 3.0');else process.exit(0);`);
    const rustc=join(root,'rustc');
    writeFileSync(rustc,`#!${process.execPath}\nconsole.log('rustc 1.99.1 (fixture)\\nrelease: 1.99.1\\nhost: x86_64-unknown-linux-gnu');`,{mode:0o755});
    const request={target:'cargo',executable,rustcExecutable:rustc,project:root,network:'off'};
    const result=await runtime.inspectUserToolTrust(request);
    assert.equal(result.decision,'unconfirmed');
    assert.equal(result.reason,'network-off');
    assert.equal(result.observation.version,'1.99.0');
    assert.equal(result.observation.rustVersion,'1.99.1');
    assert.equal(result.observation.backend,'openssl');
  } finally {
    if(previous===undefined)delete process.env.CARGO_HOME;else process.env.CARGO_HOME=previous;
    rmSync(root,{recursive:true,force:true});
  }
});

test('selected Python effective trust suppresses persistent repair in the public file route', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-effective-'));
  try {
    const executable = fixture(root, `console.log(JSON.stringify(a[0]==='-c'&&a[1].includes('def version')?{version:'3.15.2',executable:${JSON.stringify(join(root, 'tool'))},prefix:'/fixture/uv',basePrefix:'/fixture/uv',openssl:'OpenSSL fixture',defaultPaths:{},pip:'26.2.2'}:{tls:'passed'}));`);
    const request = { target:'python',executable,project:root,network:'declared',interpreterSource:'uv-managed' };
    const observed = await runtime.inspectUserToolTrust(request);
    assert.equal(observed.decision, 'no-repair');
    assert.equal(observed.observation.interpreterSource.declared, 'uv-managed');
    assert.equal(observed.observation.interpreterSource.verified, false);
    // The renderer is also public and must guard both legacy and shared-source callers.
    const rendered = runtime.renderRepair({ id:'user-tools-ca',variantRef:`user-tools-ca/${process.platform}/python/declared`,
      bundlePath:join(root,'trust.pem'),bundleSha256:'a'.repeat(64),fingerprints:['b'.repeat(64)],
      executablePaths:{pythonExecutable:executable} });
    assert.equal(rendered.status, 'blocked');
    assert.equal(rendered.diagnostics[0].code, 'REPAIR_NOT_NEEDED');
    assert.equal(rendered.bindings, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
