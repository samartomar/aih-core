import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as runtime from '@aihq/core/harness/runtime';
import { prepare, apply } from '@aihq/core';

const fixture = (root, output, file = join(root, 'tool')) => {
  writeFileSync(file, `#!${process.execPath}\nconst a=process.argv.slice(2);\n${output}\n`, { mode: 0o755 });
  return file;
};

// A test-only CA certificate ("Example Test Root A"), inline so this file also runs alone in a packed consumer.
const TEST_CA = `-----BEGIN CERTIFICATE-----
MIIDLTCCAhWgAwIBAgIUSLszyRL43fyeabaLP6VAy06VR48wDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTRXhhbXBsZSBUZXN0IFJvb3QgQTAeFw0yNjA3MjQwNzI3
NTZaFw0zNjA3MjEwNzI3NTZaMB4xHDAaBgNVBAMME0V4YW1wbGUgVGVzdCBSb290
IEEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC/wPWNUS+SOH2HBiQU
3JKdd5M14GjWIMOKOKQv19A5IUML8agsN/5bcPnWZvuKkNCVaBCJAjTmY8iXPUBj
CuBeCpl8ZjvtOO8tQkz8xassK+fn1Mb0OUNWERDD4qkAFT1sywWzbsbV8zig2EUT
AbgwTCVIuH4rswW01G5cbW0d4ETqdxr0rPOsLGfZ16tvitwXE3OxO3tngkJ6oUuQ
eDKhFHfla2iycBexSu2AB5aKxDcSxmJqFzRB8I4jgSburRMAH9V2Y5QvDZxNNf7a
KyxDyyQH0x9XlbCLA2PlNI8rd+a7SL7hjEX8gbAcG2cgS3or9HqgfJtZRljDAeVj
ucxLAgMBAAGjYzBhMB8GA1UdIwQYMBaAFC/rc3E250jLWLhSUlu2ruAx/PguMA8G
A1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBQv63NxNudI
y1i4UlJbtq7gMfz4LjANBgkqhkiG9w0BAQsFAAOCAQEAASSAwHi7hjnp6brAO4W/
yRyhO3kHbSY1LWP0lsjf8SGLg8QqBgj+35k3Xi3dZ08pNfgauMn3Go8kzkqVczqI
RBvWaHIBtehf5Z3Ce/0kufl2tOrlKRSEBA5viTDK4VVFydl5Lz6XLEbz7i4R+IaS
2sv7WunW7ioEXP9ux09rl9/MKejC39EIB9Zo9w5M6WV1fTMANAHwO2Fu9cqhuB/d
86SoCyRcPvCSmBzqKfINeuat4LJMoWkgitVvwZjLDgljKTIH+I/6v+yqNj4ml85r
y0j8uZhGRJm7JaSybFKMJoNOLBfdou+eTFGmWQgSZpYw8PExq4alOAyb98TBHOWh
tQ==
-----END CERTIFICATE-----
`;
// The public repair route selects tools from PATH and writes under the user's home: each case gets a disposable home,
// a fixture-only PATH and no inherited tool redirections or trust overrides.
const ROUTE_ENV = ['HOME', 'USERPROFILE', 'PATH', 'XDG_CONFIG_HOME', 'PIP_CONFIG_FILE', 'PIP_CERT', 'PIP_TRUSTED_HOST',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'CONDARC', 'CONDA_SSL_VERIFY', 'CARGO_HOME', 'GIT_CONFIG_GLOBAL'];
async function publicRoute(root, body) {
  const saved = Object.fromEntries(ROUTE_ENV.map(key => [key, process.env[key]]));
  const home = join(root, 'home'), bin = join(root, 'bin'), ca = join(root, 'team.pem');
  mkdirSync(home); mkdirSync(bin); writeFileSync(ca, TEST_CA);
  try {
    for (const key of ROUTE_ENV) delete process.env[key];
    process.env.HOME = home; process.env.USERPROFILE = home; process.env.PATH = bin;
    return await body({ home, bin, ca });
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
const repairRequest = (targets, network, ca) => ({ schema: 'urn:aihq:core:repair-request:0.1.0', repair: 'user-tools-ca', targets,
  route: 'file', network, sources: { os: false, supplied: [{ id: 'team', file: ca }] } });
const unavailableOf = preparation => preparation.review.environment.unavailable.map(row => [row.code, row.reason]);

// Protocol fixtures exercise public decisions, never qualify an installed tool or platform.
test('effective trust refuses a missing selected Python and tries an untested installed one without substituting PATH', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-effective-'));
  try {
    const absent = await runtime.inspectUserToolTrust({ target: 'python', executable: join(root, 'missing'), project: root, network: 'off' });
    assert.equal(absent.decision, 'blocked');
    if(process.platform==='win32'){assert.equal(absent.reason,'windows-process-protocol-unqualified');return;}
    assert.equal(absent.reason, 'executable-unavailable');
    const script = join(root, 'python.cjs');
    writeFileSync(script, `#!/usr/bin/env node\nconsole.log(JSON.stringify({version:'3.12.3',executable:${JSON.stringify(script)},prefix:'/fixture',basePrefix:'/fixture',openssl:'OpenSSL fixture',defaultPaths:{},pip:null}));\n`, { mode: 0o755 });
    if (process.platform === 'win32') return; // POSIX protocol launcher only.
    // A version other than the tested one is tried, never refused (C20); the tested version is only a hint.
    const old = await runtime.inspectUserToolTrust({ target: 'python', executable: script, project: root, network: 'off' });
    assert.equal(old.decision, 'unconfirmed');
    assert.equal(old.reason, 'network-off');
    assert.equal(old.observation.version, '3.12.3');
    assert.deepEqual(old.observation.testedWith, { python: '3.15.2' });
    assert.equal(old.hint, undefined);
    const removed = await runtime.inspectUserToolTrust({ target: 'python', executable: script, project: root, network: 'off', pythonRecipe: 'serena' });
    assert.equal(removed.reason, 'input-invalid');
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
    fixture(root, `if(a[0]==='--version')console.log('git version 2.56.0');else if(a[0]==='config'){const pattern=new RegExp(a.at(-1));for(const [key,value] of [['http.sslbackend','openssl'],['url.file:///tmp/fixture.insteadof','https://']])if(pattern.test(key))console.log('global\\tfile:/fixture/.gitconfig\\t'+key+' '+value);}`);
    assert.equal((await runtime.inspectUserToolTrust(request)).reason, 'config-ambiguous');
  } finally {
    for (const [key,value] of Object.entries(saved)) { if(value===undefined)delete process.env[key];else process.env[key]=value; }
    rmSync(root, { recursive:true, force:true });
  }
});

test('a timed-out selected process that ignores TERM is killed before inspection returns', {skip:process.platform==='win32',timeout:10000}, async()=>{
  const root=mkdtempSync(join(tmpdir(),'aih-effective-timeout-'));
  try {
    const pidFile=join(root,'pid');
    const executable=fixture(root,`require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},100);`);
    const result=await runtime.inspectUserToolTrust({target:'python',executable,project:root,network:'off'},{budgetMs:500});
    assert.equal(result.reason,'deadline');
    const pid=Number(readFileSync(pidFile,'utf8'));
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('pip trust and repair checks use the same selected Python environment', {skip:process.platform==='win32'}, async()=>{
  const root=mkdtempSync(join(tmpdir(),'aih-effective-pip-'));
  const keys=['PIP_TRUSTED_HOST','PIP_CERT','REQUESTS_CA_BUNDLE','CURL_CA_BUNDLE'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try {
    for(const key of keys)delete process.env[key];
    const source=`if(a[0]==='-c')console.log(JSON.stringify({version:'3.15.2',executable:${JSON.stringify(join(root,'tool'))},prefix:'/fixture/venv',basePrefix:'/fixture/system',openssl:'OpenSSL fixture',defaultPaths:{},pip:'26.2.2'}));else if(a.includes('index')){console.error('CERTIFICATE_VERIFY_FAILED');process.exit(1);}`;
    const executable=fixture(root,source);
    const request={target:'pip',executable,project:root,network:'declared'};
    const fallback=await runtime.inspectUserToolTrust(request);
    assert.equal(fallback.decision,'bundle-fallback');
    // Through the public repair route the same fallback is offered, and every pip check runs pip through the selected
    // Python: only `python3` is on PATH (no separate pip executable), and it records each invocation.
    await publicRoute(root,async({home,bin,ca})=>{
      const log=join(root,'python-calls.log'),pipConfig=join(home,'.config','pip','pip.conf');
      fixture(root,`require('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
        const fs=require('node:fs'),conf=fs.existsSync(${JSON.stringify(pipConfig)})?fs.readFileSync(${JSON.stringify(pipConfig)},'utf8'):'';
        const cert=conf.match(/^\\s*cert\\s*=\\s*(.+?)\\s*$/m)?.[1];
        if(a[0]==='-c')console.log(JSON.stringify({version:'3.15.2',executable:__filename,prefix:'/fixture/venv',basePrefix:'/fixture/system',openssl:'OpenSSL fixture',defaultPaths:{},pip:'26.2.2'}));
        else if(a.includes('config')&&a.includes('list')){if(cert)console.log("global.cert='"+cert+"'");}
        else if(a.includes('index')&&!cert){console.error('CERTIFICATE_VERIFY_FAILED');process.exit(1);}`,join(bin,'python3'));
      const preparation=await prepare(repairRequest(['pip'],'declared',ca),{logging:'off'});
      assert.equal(preparation.status,'ready',JSON.stringify(preparation));
      const run=await apply(preparation.handle,{approved:true,origin:'automation',reviewDigest:preparation.review.reviewDigest},{logging:'off'});
      assert.equal(run.completion,'complete',JSON.stringify(run));
      const calls=readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line).join(' '));
      assert.ok(calls.includes('-m pip --version'),JSON.stringify(calls));
      assert.ok(calls.includes('-m pip config list'),JSON.stringify(calls));
      assert.ok(calls.some(args=>args.startsWith('-m pip ')&&args.includes(' index versions pip')),JSON.stringify(calls));
    });
    // pip 26.1 `index versions` reports the certificate failure on stdout; stderr only says no distribution was found.
    fixture(root,source.replace("console.error('CERTIFICATE_VERIFY_FAILED');",
      "console.log(\"Could not fetch URL https://pypi.org/simple/pip/: There was a problem confirming the ssl certificate: (Caused by SSLError(SSLCertVerificationError(1, '[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: self-signed certificate in certificate chain (_ssl.c:1032)'))) - skipping\");console.error('ERROR: No matching distribution found for pip');"));
    const stdout=await runtime.inspectUserToolTrust(request);
    assert.deepEqual([stdout.decision,stdout.reason],['bundle-fallback','certificate-chain']);
    fixture(root,source.replace("console.error('CERTIFICATE_VERIFY_FAILED');","console.error('ERROR: No matching distribution found for pip');"));
    assert.equal((await runtime.inspectUserToolTrust(request)).reason,'connection-unconfirmed');
    fixture(root,source.replace("console.error('CERTIFICATE_VERIFY_FAILED');process.exit(1);",'process.exit(0);'));
    assert.equal((await runtime.inspectUserToolTrust(request)).decision,'no-repair');
    process.env.PIP_CERT=join(root,'override.pem');
    assert.equal((await runtime.inspectUserToolTrust(request)).reason,'explicit-trust-override');
  } finally {
    for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    rmSync(root,{recursive:true,force:true});
  }
});

test('Conda native mode remains distinct from a CA file in inspection and offline repair', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-effective-'));
  try {
    const executable = fixture(root, `console.log(JSON.stringify(a.includes('-c')&&a.at(-1).includes('conda.__version__')?{version:'26.9.4',python:'3.15.2',executable:'/fixture/conda/python',prefix:'/fixture/conda',rootPrefix:'/fixture/conda',sslVerify:'truststore',configSources:['/fixture/.condarc'],openssl:'OpenSSL fixture'}:{tls:'passed'}));`);
    const observed = await runtime.inspectUserToolTrust({target:'conda',executable,project:root,network:'declared'});
    assert.equal(observed.decision,'no-repair');
    assert.equal(observed.observation.backend,'conda-truststore');
    // Offline, the public repair route reads the person's .condarc: a native truststore selection is not rewritten to a CA file.
    await publicRoute(root,async({home,bin,ca})=>{
      copyFileSync(executable,join(bin,'conda'));
      writeFileSync(join(home,'.condarc'),'ssl_verify: truststore\n');
      const preparation=await prepare(repairRequest(['conda'],'off',ca),{logging:'off'});
      assert.equal(preparation.status,'blocked',JSON.stringify(preparation));
      assert.equal(preparation.handle,undefined);
      assert.deepEqual(unavailableOf(preparation),[['PREREQUISITE_UNAVAILABLE','native-trust-selected']]);
      assert.equal(readFileSync(join(home,'.condarc'),'utf8'),'ssl_verify: truststore\n');
    });
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
    copyFileSync(executable,join(root,'cargo'));
    const priorPath=process.env.PATH;
    try {
      process.env.PATH=root;
      const diagnostic=await runtime.diagnose({requestId:'cargo-environment',targets:['cargo'],project:root,network:'off'});
      const observed=diagnostic.observations.find(item=>item.id==='cargo/effective-trust');
      assert.equal(JSON.parse(observed.detail).rustVersion,'1.99.1');
      assert.equal(diagnostic.checks.find(item=>item.id==='cargo/tls/effective').outcome,'skipped');
    } finally {process.env.PATH=priorPath;}
    mkdirSync(join(root,'.cargo'));mkdirSync(process.env.CARGO_HOME);
    writeFileSync(join(root,'.cargo','config.toml'),'[net]\ngit-fetch-with-cli = true\n');
    writeFileSync(join(process.env.CARGO_HOME,'config.toml'),'[net]\ngit-fetch-with-cli = false\n');
    assert.equal((await runtime.inspectUserToolTrust(request)).reason,'config-ambiguous');
  } finally {
    if(previous===undefined)delete process.env.CARGO_HOME;else process.env.CARGO_HOME=previous;
    rmSync(root,{recursive:true,force:true});
  }
});

test('Conda prefers an effective process-local native alternative over a bundle workaround', {skip:process.platform==='win32'},async()=>{
  const root=mkdtempSync(join(tmpdir(),'aih-effective-conda-'));
  try {
    const executable=fixture(root,`const script=a[a.indexOf('-c')+1];console.log(JSON.stringify(script.includes('conda.__version__')?{version:'26.9.4',python:'3.15.2',prefix:'/fixture/conda',sslVerify:true,configSources:[]}:script.includes('CONDA_SSL_VERIFY')?{tls:'passed'}:{tls:'certificate-chain'}));`);
    const result=await runtime.inspectUserToolTrust({target:'conda',executable,project:root,network:'declared'});
    assert.equal(result.decision,'native-truststore');
    assert.deepEqual(result.recommendation,{scope:'observed-conda-environment',key:'ssl_verify',value:'truststore'});
  } finally {rmSync(root,{recursive:true,force:true});}
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
    // The public repair route applies the same guard to the Python it selects: no persistent repair is offered.
    await publicRoute(root, async ({ bin, ca }) => {
      copyFileSync(executable, join(bin, 'python3'));
      const preparation = await prepare(repairRequest(['python'], 'declared', ca), { logging: 'off' });
      assert.equal(preparation.status, 'blocked', JSON.stringify(preparation));
      assert.equal(preparation.handle, undefined);
      assert.deepEqual(unavailableOf(preparation), [['REPAIR_NOT_NEEDED', 'effective-trust']]);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Ubuntu's stock Git and Cargo link only libcurl-gnutls. GnuTLS honours the CA file the repair writes (`http.sslCAInfo`,
// Cargo `http.cainfo`), so a confirmed GnuTLS backend admits the file repair; GnuTLS words its certificate failure as
// "server certificate verification failed".
const GNUTLS_FAILURE = "fatal: unable to access 'https://github.com/git/git.git/': server certificate verification failed. CAfile: none CRLfile: none";
test('Git on a confirmed GnuTLS backend is offered the CA file repair', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-effective-'));
  const saved = Object.fromEntries(['GIT_CONFIG_COUNT','GIT_CONFIG_PARAMETERS','GIT_SSL_NO_VERIFY','GIT_SSL_CAINFO','GIT_SSL_CAPATH','GIT_CONFIG_GLOBAL','GIT_CONFIG_SYSTEM'].map(key => [key, process.env[key]]));
  try {
    for (const key of Object.keys(saved)) delete process.env[key];
    const request = { target: 'git', executable: join(root, 'tool'), project: root, network: 'declared' };
    const remote = `else if(a[0]==='ls-remote'){console.error(${JSON.stringify(GNUTLS_FAILURE)});process.exit(128);}`;
    // An explicit http.sslBackend of gnutls.
    fixture(root, `if(a[0]==='--version')console.log('git version 2.43.0');else if(a[0]==='config')console.log('global\\tfile:/fixture/.gitconfig\\thttp.sslbackend gnutls');${remote}else process.exit(0);`);
    const configured = await runtime.inspectUserToolTrust(request);
    assert.equal(configured.decision, 'bundle-fallback', JSON.stringify(configured));
    assert.equal(configured.reason, 'certificate-chain');
    assert.equal(configured.observation.backend, 'gnutls');
    // No sslBackend setting, but the build options name libcurl with GnuTLS.
    fixture(root, `if(a[0]==='--version')console.log('git version 2.50.0');else if(a[0]==='config')process.exit(1);else if(a[0]==='version'&&a[1]==='--build-options')console.log('git version 2.50.0\\ncpu: x86_64\\nlibcurl: 8.5.0 (GnuTLS/3.8.3)\\nzlib: 1.3');${remote}else process.exit(0);`);
    const built = await runtime.inspectUserToolTrust(request);
    assert.equal(built.decision, 'bundle-fallback', JSON.stringify(built));
    assert.equal(built.observation.backend, 'gnutls');
    // Build options that name no TLS backend still leave it unconfirmed.
    fixture(root, `if(a[0]==='--version')console.log('git version 2.43.0');else if(a[0]==='config')process.exit(1);else if(a[0]==='version')console.log('git version 2.43.0\\ncpu: x86_64');${remote}else process.exit(0);`);
    assert.equal((await runtime.inspectUserToolTrust(request)).reason, 'backend-unconfirmed');
  } finally {
    for (const [key,value] of Object.entries(saved)) { if(value===undefined)delete process.env[key];else process.env[key]=value; }
    rmSync(root, { recursive:true, force:true });
  }
});

test('Cargo on libcurl with GnuTLS is offered the CA file repair', {skip:process.platform==='win32'}, async()=>{
  const root=mkdtempSync(join(tmpdir(),'aih-effective-'));
  const previous=process.env.CARGO_HOME;
  try {
    process.env.CARGO_HOME=join(root,'cargo-home');
    // Ubuntu 24.04's cargo 1.75: no separate `ssl:` line; libcurl names its TLS library.
    const executable=fixture(root, `if(a[0]==='-Vv')console.log('cargo 1.75.0\\nrelease: 1.75.0\\nhost: x86_64-unknown-linux-gnu\\nlibgit2: 1.7.2 (sys:0.18.1 system)\\nlibcurl: 8.5.0 (sys:0.4.68+curl-8.4.0 system ssl:GnuTLS/3.8.3)\\nos: Ubuntu 24.04 (noble) [64-bit]');else if(a[0]==='search'){console.error('error: failed to retrieve search results\\n\\nCaused by:\\n  [60] SSL peer certificate or SSH remote key was not OK (server certificate verification failed. CAfile: none CRLfile: none)');process.exit(101);}else process.exit(0);`);
    const rustc=join(root,'rustc');
    writeFileSync(rustc,`#!${process.execPath}\nconsole.log('rustc 1.75.0\\nrelease: 1.75.0\\nhost: x86_64-unknown-linux-gnu');`,{mode:0o755});
    const result=await runtime.inspectUserToolTrust({target:'cargo',executable,rustcExecutable:rustc,project:root,network:'declared'});
    assert.equal(result.decision,'bundle-fallback',JSON.stringify(result));
    assert.equal(result.observation.backend,'gnutls');
    // A libcurl line naming no TLS library stays unconfirmed.
    fixture(root, `if(a[0]==='-Vv')console.log('cargo 1.75.0\\nrelease: 1.75.0\\nhost: x86_64-unknown-linux-gnu\\nlibcurl: 8.5.0 (sys:0.4.68+curl-8.4.0 system)');else process.exit(0);`);
    assert.equal((await runtime.inspectUserToolTrust({target:'cargo',executable,rustcExecutable:rustc,project:root,network:'off'})).reason,'cargo-effective-backend-unconfirmed');
  } finally {
    if(previous===undefined)delete process.env.CARGO_HOME;else process.env.CARGO_HOME=previous;
    rmSync(root,{recursive:true,force:true});
  }
});

// conda 26.9 with any .condarc keys its configuration sources by path objects. The fake conda runs the probe in a real
// Python against a stand-in `conda` package whose `collect_all` keys are `pathlib` paths, as conda's are.
const python3 = (() => { try { return execFileSync('python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim(); } catch { return undefined; } })();
test('the conda identity probe reads configuration sources keyed by path objects', { skip: process.platform === 'win32' || !python3 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aih-effective-conda-'));
  try {
    const lib = join(root, 'lib'); mkdirSync(join(lib, 'conda', 'base'), { recursive: true });
    writeFileSync(join(lib, 'conda', '__init__.py'), "__version__ = '26.9.4'\n");
    writeFileSync(join(lib, 'conda', 'base', '__init__.py'), '');
    writeFileSync(join(lib, 'conda', 'base', 'context.py'), [
      'from pathlib import Path',
      'class _Context:',
      "    target_prefix = '/fixture/conda'",
      "    root_prefix = '/fixture/conda'",
      '    ssl_verify = True',
      "    def collect_all(self): return {Path('/fixture/conda/.condarc'): {}, 'envvars': {}}",
      'context = _Context()',
      'def reset_context(): pass', ''].join('\n'));
    // `conda run --no-capture-output -n base python -c <script> [args]` runs the script in that Python.
    const executable = join(root, 'conda');
    writeFileSync(executable, `#!/bin/sh\nshift 5\nPYTHONPATH=${JSON.stringify(lib)} exec ${JSON.stringify(python3)} "$@"\n`, { mode: 0o755 });
    const result = await runtime.inspectUserToolTrust({ target: 'conda', executable, project: root, network: 'off' });
    assert.equal(result.reason, 'network-off', JSON.stringify(result));
    assert.deepEqual(result.observation.configSources, ['/fixture/conda/.condarc', 'envvars']);
    assert.equal(result.observation.backend, 'conda-certifi');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
