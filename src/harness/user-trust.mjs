import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, dirname, join, resolve } from 'node:path';
import { userToolsRepair } from './user-trust-definitions.mjs';
import { composeExistingTrust, validateSuppliedCa } from './ca.mjs';
import { spawn, spawnSync } from 'node:child_process';

// The engine's renderer is synchronous. A single bounded read-only child runs the
// same effective-process observer used by diagnostics; it never edits a tool home.
// Re-render at Apply repeats this gate before effects. Unknown trust is not fallback permission.
function effectiveRepairGate(variant, executablePaths) {
  if (variant.network === 'off') return;
  const requests = variant.targets.map(target => ({ target,
    executable: executablePaths?.[target === 'pip' ? 'pythonExecutable' : `${target}Executable`],
    project: homedir(), network: 'declared',
    ...(target === 'cargo' ? {rustcExecutable:executablePaths?.rustcExecutable} : {}) }));
  if (requests.some(request => !request.executable)) return invalid('effective-executable-unavailable',
    'Select the exact environment executable before preparing trust repair.', 'PREREQUISITE_UNAVAILABLE');
  const script = `import { inspectUserToolTrust } from ${JSON.stringify(new URL('./user-trust.mjs', import.meta.url).href)};
    const deadline=Date.now()+20000,results=[];
    for(const request of JSON.parse(process.argv[1])) {
      if(Date.now()>=deadline){results.push({decision:'blocked',reason:'deadline'});break;}
      const r=await inspectUserToolTrust(request,{budgetMs:Math.max(1,deadline-Date.now())});
      results.push({decision:r.decision,reason:r.reason});
      if(r.reason==='termination-unresolved')break;
    }
    console.log(JSON.stringify(results));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(requests)],
    { timeout: 24000, maxBuffer: 16384, encoding: 'utf8', shell: false, windowsHide: true });
  let results;
  try { results = child.status === 0 && !child.error ? JSON.parse(child.stdout) : undefined; } catch {}
  if (!Array.isArray(results) || results.length !== requests.length) return invalid('effective-trust-unavailable',
    'Effective trust could not be established within its process bound.', 'PREREQUISITE_UNAVAILABLE');
  if (results.some(result => result.decision === 'no-repair')) return { status: 'blocked', diagnostics: [{
    code: 'REPAIR_NOT_NEEDED', reason: results.every(result => result.decision === 'no-repair') ? 'effective-trust' : 'select-only-needed-targets',
    message: 'A selected process already trusts its endpoint. Exclude it before preparing a scoped CA fallback.' }] };
  const unresolved = results.find(result => result.decision !== 'bundle-fallback');
  if (unresolved) return invalid(unresolved.reason, 'Resolve the selected process trust/backend before preparing a CA fallback.', 'PREREQUISITE_UNAVAILABLE');
}

// Process observations are separate from native admission. No store, account or configuration writes.
// Package-manager queries can update their ordinary network caches; callers select disposable homes for fixtures.
import { lstatSync, readFileSync } from 'node:fs';
import { isProxy } from 'node:util/types';
import { performance } from 'node:perf_hooks';


const targets = ['python', 'pip', 'conda', 'git', 'cargo'];
const recipes = { general: '3.15.2', 'pyyaml-onnx': '3.14.10', 'code-review-graph': '3.14.10', serena: '3.13.18' };
const plain = (value, keys) => value && typeof value === 'object' && !isProxy(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && keys.includes(key) && d.enumerable && 'value' in d;
  });
const path = value => typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && !/[\p{Cc}\p{Cf}]/u.test(value);
const origin = value => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.hash && u.href.length <= 4096; }
  catch { return false; }
};
const endpoints = { python: 'https://pypi.org/simple/pip/', pip: 'https://pypi.org/simple/',
  conda: 'https://repo.anaconda.com/pkgs/main/noarch/repodata.json', git: 'https://github.com/git/git.git' };

const pythonIdentity = `import json,sys,ssl,importlib.metadata as m
def version(name):
 try: return m.version(name)
 except m.PackageNotFoundError: return None
p=ssl.get_default_verify_paths()
print(json.dumps(dict(version='.'.join(map(str,sys.version_info[:3])),executable=sys.executable,baseExecutable=getattr(sys,'_base_executable',None),prefix=sys.prefix,basePrefix=sys.base_prefix,openssl=ssl.OPENSSL_VERSION,defaultPaths=p._asdict(),pip=version('pip'))))`;
const observedPythonTls = `import json,sys,urllib.request,urllib.error,ssl
try:
 with urllib.request.urlopen(sys.argv[1],timeout=10) as r: pass
 print(json.dumps(dict(tls='passed')))
except urllib.error.HTTPError:
 print(json.dumps(dict(tls='passed')))
except urllib.error.URLError as e:
 print(json.dumps(dict(tls='certificate-chain' if isinstance(e.reason,ssl.SSLCertVerificationError) else 'unconfirmed')))`;
const condaIdentity = `import json,sys,ssl,conda
from conda.base.context import context,reset_context
reset_context()
print(json.dumps(dict(version=conda.__version__,python='.'.join(map(str,sys.version_info[:3])),executable=sys.executable,prefix=context.target_prefix,rootPrefix=context.root_prefix,sslVerify=context.ssl_verify,configSources=list(context.collect_all().keys()),openssl=ssl.OPENSSL_VERSION)))`;
const observedCondaTls = `import json,sys
from conda.base.context import reset_context
reset_context()
from conda.gateways.connection.session import CondaSession
import requests
s=CondaSession()
try:
 r=s.get(sys.argv[1],timeout=10,stream=True);r.close()
 print(json.dumps(dict(tls='passed')))
except requests.exceptions.SSLError:
 print(json.dumps(dict(tls='certificate-chain')))
except requests.exceptions.RequestException:
 print(json.dumps(dict(tls='unconfirmed')))`;

// One child at a time, a common deadline, bounded output, no shell and no credentials in receipts.
function processOutput(executable, args, cwd, deadline, signal) {
  if (signal?.aborted) return Promise.resolve({ reason: 'cancelled' });
  if (performance.now() >= deadline) return Promise.resolve({ reason: 'deadline' });
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd, env: process.env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let size = 0, stdout = '', stderr = '', reason, done = false, cleanup, escalation;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); clearTimeout(cleanup); clearTimeout(escalation);
      signal?.removeEventListener('abort', abort); resolve(result); };
    const kill = signal => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else if (child.pid) {
          // The owned tree only; taskkill is an OS helper, never a shell command.
          const killer=spawn(join(process.env.SystemRoot || 'C:\\Windows','System32','taskkill.exe'),
            ['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',shell:false});
          killer.once('error',()=>{});
        }
      } catch (error) { if(error.code!=='ESRCH')reason='termination-unresolved'; }
    };
    const stop = value => { reason ??= value; kill('SIGTERM');
      escalation ??= setTimeout(()=>kill('SIGKILL'),250);
      cleanup ??= setTimeout(() => {kill('SIGKILL');finish({ reason: 'termination-unresolved' });},2000); };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('deadline'), Math.max(1, deadline - performance.now()));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    for (const [stream, error] of [[child.stdout, false], [child.stderr, true]]) stream.on('data', bytes => {
      size += bytes.length;
      if (size > 65536) { stop('output-bytes'); return; }
      if (error) stderr += bytes.toString('utf8'); else stdout += bytes.toString('utf8');
    });
    child.once('error', () => finish({ reason: 'executable-unavailable' }));
    child.once('close', code => {
      // A root process must not leave a query helper running in its owned group.
      if(process.platform!=='win32' && child.pid) {
        try {process.kill(-child.pid,0);kill('SIGKILL');return finish({reason:'descendant-cleanup'});}
        catch(error){if(error.code!=='ESRCH')return finish({reason:'termination-unresolved'});}
      }
      finish(reason ? { reason } : { code, stdout, stderr });
    });
  });
}
const json = result => { try { return result.code === 0 ? JSON.parse(result.stdout) : undefined; } catch { return undefined; } };

function cargoConfiguration(project) {
  const files = new Set(); let directory = project;
  for (let i = 0; i < 64; i++) {
    files.add(join(directory, '.cargo', 'config.toml'));
    if (dirname(directory) === directory) break;
    if (i === 63) return { reason:'config-depth' };
    directory = dirname(directory);
  }
  files.add(join(process.env.CARGO_HOME || join(homedir(), '.cargo'), 'config.toml'));
  const configSources = []; const trustKeys = new Set(); let gitFetchWithCli = false;
  for (const file of files) {
    try { lstatSync(file.slice(0, -5)); return {reason:'cargo-legacy-config'}; }
    catch (error) { if (error.code !== 'ENOENT') return {reason:'config-unavailable'}; }
    let text;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 1048576) return {reason:'config-unavailable'};
      const bytes = readFileSync(file);
      if (bytes.length > 1048576) return {reason:'config-unavailable'};
      text = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    } catch (error) { if (error.code === 'ENOENT') continue; return {reason:'config-unavailable'}; }
    configSources.push(file);
    let section=''; const seen=new Set();
    for(const line of text.split(/\r?\n/)) {
      if(/^\s*(?:#.*)?$/.test(line))continue;
      const header=line.match(/^\s*\[([A-Za-z0-9_-]+)\]\s*(?:#.*)?$/);
      if(header){section=header[1];continue;}
      const entry=line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
      if(!entry || !section) return {reason:'config-ambiguous'};
      const key=`${section}.${entry[1]}`;
      if(seen.has(key))return {reason:'config-ambiguous'};
      seen.add(key);
      if(section==='http' || key==='net.git-fetch-with-cli') {
        if(trustKeys.has(key))return {reason:'config-ambiguous'};
        trustKeys.add(key);
      }
      if(key==='http.ssl-verify' && entry[2]!=='true')return {reason:'tls-verification-disabled'};
      if(key==='net.git-fetch-with-cli') {
        if(!['true','false'].includes(entry[2]))return {reason:'config-ambiguous'};
        gitFetchWithCli=entry[2]==='true';
      } else if(section==='http' && key!=='http.ssl-verify' || ['source','registry','registries','include'].includes(section))
        return {reason:'explicit-trust-or-endpoint-override'};
    }
  }
  return {configSources,gitFetchWithCli};
}

/** Inspect exactly the caller-selected process; compatibility never upgrades or substitutes it. */
export async function inspectUserToolTrust(request, controls = {}) {
  const blocked = (reason, observation = {}) => ({ decision: 'blocked', reason, observation });
  if (!plain(request, ['target', 'executable', 'project', 'network', 'endpoint', 'pythonRecipe', 'interpreterSource', 'rustcExecutable']) ||
      !targets.includes(request.target) || !path(request.executable) || !path(request.project) ||
      !['declared', 'off'].includes(request.network) || request.endpoint !== undefined && !origin(request.endpoint) ||
      request.rustcExecutable !== undefined && !path(request.rustcExecutable) || request.target === 'cargo' && request.endpoint !== undefined ||
      request.pythonRecipe !== undefined && !Object.hasOwn(recipes, request.pythonRecipe) ||
      request.interpreterSource !== undefined && !['system', 'uv-managed', 'unknown'].includes(request.interpreterSource) ||
      !plain(controls, ['signal', 'budgetMs']) || controls.signal !== undefined && !(controls.signal instanceof AbortSignal) ||
      controls.budgetMs !== undefined && (!Number.isInteger(controls.budgetMs) || controls.budgetMs < 1 || controls.budgetMs > 60000))
    return blocked('input-invalid');
  // Script shell launchers on Windows require a separate qualified argument protocol.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(request.executable)) return blocked('launcher-unqualified');
  const deadline = performance.now() + (controls.budgetMs ?? 25000);
  const run = args => processOutput(request.executable, args, request.project, deadline, controls.signal);
  const observation = { target: request.target, executable: request.executable, platform: process.platform,
    architecture: process.arch, nativeAdmission: 'unconfirmed' };
  const fail = reason => blocked(reason, observation);
  const env = process.env, target = request.target;
  let result;
  if (target === 'python' || target === 'pip') {
    result = await run(['-c', pythonIdentity]);
    if (result.reason) return fail(result.reason);
    const identity = json(result);
    if (!identity || !/^\d+\.\d+\.\d+$/.test(identity.version ?? '') || typeof identity.executable !== 'string') return fail('identity-unavailable');
    Object.assign(observation, identity, { interpreterSource: { declared: request.interpreterSource ?? 'unknown', verified: false },
      pythonRecipe: request.pythonRecipe ?? 'general', selectedVersion: recipes[request.pythonRecipe ?? 'general'] });
    if (identity.version !== observation.selectedVersion) return fail('runtime-incompatible');
    if (target === 'pip') {
      if (identity.pip !== '26.2.2') return fail('pip-incompatible');
      result = await run(['-m', 'pip', 'config', 'list']);
      if (result.reason) return fail(result.reason);
      if (result.code !== 0) return fail('config-unavailable');
      const entries = result.stdout.split(/\r?\n/).filter(Boolean);
      // A nontrivial trust/URL/feature option can alter the selected install/index command.
      // Keep values private; do not execute Python repr or guess option precedence.
      observation.configSources = entries.map(line => line.split('=')[0]).filter(key => /^[\w:.-]+$/.test(key));
      if (entries.some(line => !/^[\w:.-]+=/.test(line))) return fail('config-ambiguous');
      if (entries.some(line => /(?:cert|trusted-host|proxy|index-url|no-index|find-links|use-deprecated|use-feature|client-cert)=/i.test(line)))
        return fail('explicit-trust-or-endpoint-override');
      if (env.PIP_TRUSTED_HOST) return fail('tls-verification-disabled');
      if (env.PIP_CERT || env.REQUESTS_CA_BUNDLE || env.CURL_CA_BUNDLE) return fail('explicit-trust-override');
      observation.backend = 'pip-system-truststore-and-certifi';
    } else {
      observation.backend = 'python-ssl-default-context';
      if (env.SSL_CERT_FILE || env.SSL_CERT_DIR || env.REQUESTS_CA_BUNDLE) return fail('explicit-trust-override');
    }
  } else if (target === 'conda') {
    // Conda's Windows wrapper has a distinct -c quoting/newline protocol. Do not
    // infer it from POSIX fixtures or substitute another Python process.
    if(process.platform==='win32')return fail('conda-windows-launcher-unqualified');
    result = await run(['run', '--no-capture-output', '-n', 'base', 'python', '-c', condaIdentity]);
    if (result.reason) return fail(result.reason);
    const identity = json(result);
    if (!identity || typeof identity.version !== 'string' || !Array.isArray(identity.configSources)) return fail('identity-unavailable');
    Object.assign(observation, identity);
    if (identity.version !== '26.9.4') return fail('runtime-incompatible');
    if (env.CONDA_PREFIX && env.CONDA_PREFIX !== identity.prefix) return fail('conda-environment-ambiguous');
    if (identity.sslVerify === false) return fail('tls-verification-disabled');
    if (![true, 'truststore'].includes(identity.sslVerify) || env.REQUESTS_CA_BUNDLE || env.CURL_CA_BUNDLE || env.CONDA_SSL_VERIFY)
      return fail('explicit-trust-override');
    observation.backend = identity.sslVerify === 'truststore' ? 'conda-truststore' : 'conda-certifi';
  } else if (target === 'git') {
    result = await run(['--version']);
    if (result.reason) return fail(result.reason);
    const version = result.stdout?.trim().match(/^git version (\d+\.\d+\.\d+(?:\.windows\.\d+)?)$/)?.[1];
    if (!version) return fail('identity-unavailable');
    observation.version = version;
    if (version !== (process.platform === 'win32' ? '2.56.0.windows.4' : '2.56.0')) return fail('runtime-incompatible');
    result = await run(['config', '--show-origin', '--show-scope', '--get-regexp', '^(http\..*|include.*|remote\..*\.proxy|url\..*|core\.gitproxy)$']);
    if (result.reason) return fail(result.reason);
    if (![0, 1].includes(result.code)) return fail('config-unavailable');
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    observation.configSources = lines.map(line => line.split(/\s+/).slice(0, 2).join(' '));
    // Includes, URL-specific HTTP entries, duplicate keys and injected configuration cannot
    // be reduced to a global CA file. Refuse rather than rewrite a different scope.
    if (Object.keys(env).some(key => key.startsWith('GIT_CONFIG')) || env.GIT_SSL_NO_VERIFY || env.GIT_PROXY_COMMAND) return fail('config-ambiguous');
    if (env.GIT_SSL_CAINFO || env.GIT_SSL_CAPATH || env.GIT_CONFIG_GLOBAL || env.GIT_CONFIG_SYSTEM) return fail('explicit-trust-override');
    const seen = new Set(); let backend;
    for (const line of lines) {
      const match = line.match(/^\S+\s+\S+\s+(http\.[A-Za-z]+)\s+(.*)$/);
      if (!match) return fail('config-ambiguous');
      const key = match[1].toLowerCase(), value = match[2].trim();
      if (seen.has(key)) return fail('config-ambiguous');
      seen.add(key);
      if (key === 'http.sslverify' && !/^(true|yes|on|1)$/i.test(value)) return fail('tls-verification-disabled');
      if (key === 'http.sslbackend') backend = value.toLowerCase();
      else if (key !== 'http.sslverify') return fail('explicit-trust-or-endpoint-override');
    }
    observation.backend = backend ?? 'unconfirmed';
    // A successful command without sslBackend does not identify libcurl's build-time backend.
    if (!['openssl', 'schannel'].includes(backend)) return fail('backend-unconfirmed');
    if (backend === 'schannel' && process.platform !== 'win32') return fail('backend-platform-unqualified');
  } else {
    result = await run(['-Vv']);
    if (result.reason) return fail(result.reason);
    const version = result.stdout?.match(/^cargo (\d+\.\d+\.\d+)\b/m)?.[1];
    if (!version) return fail('identity-unavailable');
    Object.assign(observation, { version, backend: 'unconfirmed', rustToolchainCandidate: '1.99.1',
      build: result.stdout.split(/\r?\n/).filter(line => /^(?:release|host|libgit2|libcurl|ssl):/.test(line)).slice(0, 8) });
    if(!request.rustcExecutable)return fail('rustc-observation-required');
    const rust = await processOutput(request.rustcExecutable,['-Vv'],request.project,deadline,controls.signal);
    if(rust.reason)return fail(rust.reason);
    observation.rustVersion=rust.stdout?.match(/^release: (\d+\.\d+\.\d+)$/m)?.[1];
    if(rust.code!==0 || observation.rustVersion!=='1.99.1')return fail('rust-toolchain-incompatible');
    const rustHost=rust.stdout.match(/^host: (\S+)$/m)?.[1],cargoHost=result.stdout.match(/^host: (\S+)$/m)?.[1];
    if(!rustHost || rustHost!==cargoHost)return fail('toolchain-host-ambiguous');
    observation.host=cargoHost;
    const ssl=result.stdout.match(/^ssl: (.+)$/m)?.[1] ?? '';
    observation.backend=/^OpenSSL\b/.test(ssl)?'openssl':/^Schannel\b/i.test(ssl)?'schannel':'unconfirmed';
    if(observation.backend==='unconfirmed')return fail('cargo-effective-backend-unconfirmed');
    if(observation.backend==='schannel' && process.platform!=='win32')return fail('backend-platform-unqualified');
    if(Object.keys(env).some(key=>/^(?:CARGO_HTTP_|CARGO_REGISTRIES_|CARGO_REGISTRY_|CARGO_SOURCE_|CARGO_NET_|RUSTUP_TOOLCHAIN|RUSTC$)/.test(key)))
      return fail('explicit-trust-or-toolchain-override');
    const configuration=cargoConfiguration(request.project);
    if(configuration.reason)return fail(configuration.reason);
    Object.assign(observation,configuration);
    // Cargo's libcurl HTTPS path and its Git dependency transport are distinct.
    // A CLI Git fetch needs its own selected Git decision and cannot inherit this result.
    if(configuration.gitFetchWithCli)return fail('cargo-git-backend-requires-separate-decision');
  }
  if (request.network === 'off') return { decision: 'unconfirmed', reason: 'network-off', observation };
  const endpoint = request.endpoint ?? endpoints[target];
  if (target === 'python') result = await run(['-c', observedPythonTls, endpoint]);
  if (target === 'pip') result = await run(['-m', 'pip', '--disable-pip-version-check', '--no-cache-dir', 'index', 'versions', 'pip',
    '--index-url', endpoint, '--retries', '0', '--timeout', '10']);
  if (target === 'conda') result = await run(['run', '--no-capture-output', '-n', 'base', 'python', '-c', observedCondaTls, endpoint]);
  if (target === 'git') result = await run(['ls-remote', endpoint, 'HEAD']);
  if (target === 'cargo') result = await run(['search', 'serde', '--limit', '1']);
  if (result.reason) return fail(result.reason);
  const certificateFailure = target === 'git' || target === 'cargo' ?
    /SSL certificate problem: (?:unable to get local issuer certificate|self-signed certificate|certificate verify failed)/i.test(result.stderr ?? '') :
    target === 'pip' && /CERTIFICATE_VERIFY_FAILED/.test(result.stderr ?? '');
  const tls = ['python', 'conda'].includes(target) ? json(result)?.tls : result.code === 0 ? 'passed' : certificateFailure ? 'certificate-chain' : 'unconfirmed';
  if (tls === 'passed') return { decision: 'no-repair', reason: 'effective-trust', observation };
  if(target==='conda' && tls==='certificate-chain' && observation.sslVerify===true) {
    // Test the documented alternative only in this process. No .condarc or store mutation.
    const nativeScript="import os\nos.environ['CONDA_SSL_VERIFY']='truststore'\n"+observedCondaTls;
    const native=await run(['run','--no-capture-output','-n','base','python','-c',nativeScript,endpoint]);
    if(native.reason)return fail(native.reason);
    const nativeTls=json(native)?.tls;
    if(nativeTls==='passed')return {decision:'native-truststore',reason:'native-truststore-available',observation,
      recommendation:{scope:'observed-conda-environment',key:'ssl_verify',value:'truststore'}};
    if(nativeTls!=='certificate-chain')return fail('native-truststore-unconfirmed');
  }
  if (tls === 'certificate-chain') return { decision: 'bundle-fallback', reason: 'certificate-chain', observation };
  return fail('connection-unconfirmed');
}


const literal = value => ({ literal: value });
const input = name => ({ input: name });
const cwd = { root: 'userHome', segments: [] };
const target = segments => ({ root: 'userHome', segments: segments.map(literal) });
const invalid = (reason, message, code = 'INPUT_INVALID') => ({ status: code === 'STATE_CONFLICT' || code === 'PREREQUISITE_UNAVAILABLE' ? 'blocked' : 'invalid', diagnostics: [{ code, reason, message }] });

function variantFor(request) {
  return userToolsRepair.variants.find(item => item.recipeRef === request?.variantRef &&
    item.os === process.platform && item.architectures.includes(process.arch));
}
export function renderUserToolsRepair(request) {
  const variant = variantFor(request);
  if (!variant || typeof request.bundlePath !== 'string' || !isAbsolute(request.bundlePath) ||
      /[\p{Cc}\p{Cf}]/u.test(request.bundlePath) || !/^[a-f0-9]{64}$/.test(request.bundleSha256 ?? ''))
    return invalid('repair-bindings', 'Invalid user-tool trust bindings.');
  if (variant.targets.includes('python') && variant.os === 'win32' &&
      (request.bundlePath.includes('%') || request.bundlePath.length > 1024))
    return invalid('setx-value-unsupported', 'Windows user environment cannot hold this path.');
  const bindings = { bundlePath: request.bundlePath, bundleSha256: request.bundleSha256 };
  const privateBindings = {};
  for (const { pathInput } of variant.executableBindings) {
    const path = request.executablePaths?.[pathInput] ?? '';
    if (typeof path !== 'string' || path && (!isAbsolute(path) || /[\p{Cc}\p{Cf}]/u.test(path)))
      return invalid('executable-binding', 'The selected executable path is invalid.');
    bindings[pathInput] = path;
  }
  if (variant.targets.includes('python')) {
    if (!Array.isArray(request.fingerprints) || !request.fingerprints.length ||
        request.fingerprints.some(item => typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item)))
      return invalid('repair-bindings', 'Invalid Python CA identities.');
    bindings.fingerprintCsv = request.fingerprints.join(',');
    bindings.pythonAssignment = variant.os === 'win32' ?
      ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE'].map(key => `$env:${key} = '${request.bundlePath.replaceAll("'", "''")}'`).join('\n') :
      ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE'].map(key => `export ${key}='${request.bundlePath.replaceAll("'", "'\\''")}'`).join('\n');
  }
  const snapshots = request.configSnapshots ?? {};
  for (const file of variant.configFiles) {
    const bytes = snapshots[file.operationId] ?? new Uint8Array();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > file.maxBytes)
      return invalid('config-snapshot-limit', 'A user configuration snapshot exceeds its bound.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { return invalid('config-encoding', 'User configuration must be complete UTF-8 text.'); }
    if (text.includes('\0')) return invalid('config-encoding', 'User configuration contains invalid text.');
    if (file.operationId === 'conda-config' && /^ssl_verify\s*:\s*['"]?truststore['"]?\s*(?:#.*)?$/m.test(text) ||
        file.operationId === 'git-config' && /^\s*sslbackend\s*=\s*['"]?schannel['"]?\s*(?:[#;].*)?$/im.test(text))
      return invalid('native-trust-selected', 'The selected native backend needs an effective-process decision; a generic CA-file rewrite is unavailable.', 'PREREQUISITE_UNAVAILABLE');
    if (file.operationId === 'pip-config' && /^[ \t]*trusted-host[ \t]*[:=](?:[ \t]*\S|[ \t]*\r?\n[ \t]+\S)/im.test(text) ||
        file.operationId === 'git-config' && /^\s*sslverify\s*=\s*(?:false|no|off|0)\s*(?:[#;].*)?$/im.test(text) ||
        file.operationId === 'cargo-config' && /^\s*ssl-verify\s*=\s*false\s*(?:#.*)?$/im.test(text))
      return invalid('trust-bypass-config', 'Existing configuration disables TLS verification. Resolve that setting before preparing this CA repair.', 'PREREQUISITE_UNAVAILABLE');
    if (file.operationId === 'pip-config' && /^[ \t]*cert[ \t]*:/im.test(text))
      return invalid('config-ambiguous', 'Use an unambiguous equals-separated pip cert entry before preparing this CA repair.');
    // Duplicate managed keys or ambiguous syntax must never become an apparently verified rewrite.
    if (ambiguousConfig(file.operationId, text)) return invalid('config-ambiguous', 'The selected user configuration has ambiguous trust entries.');
    if (file.operationId === 'git-config') bindings.gitCaValue = JSON.stringify(request.bundlePath.replaceAll('\\', '/'));
    if (file.operationId === 'cargo-config') bindings.cargoCaValue = request.bundlePath.replaceAll('\\', '/');
    bindings[file.operationId.replace('-config', 'ConfigPath')] = join(homedir(), ...file.target.segments.map(item => item.literal));
  }
  const effective = effectiveRepairGate(variant, request.executablePaths);
  if (effective) return effective;
  return { status: 'completed', bindings, privateBindings };
}
function ambiguousConfig(id, text) {
  if (id === 'conda-config') return text.split(/\r?\n/).filter(line => /^ssl_verify\s*:/.test(line)).length > 1 ||
    /^(?:---|\.\.\.)\s*$/m.test(text) || /^\s+ssl_verify\s*:/m.test(text);
  if (id === 'git-config') for (const row of text.split(/\r?\n/)) {
    if (!row.trim() || /^\s*[#;]/.test(row)) continue;
    // Git joins backslash continuations and treats section names without case.
    // The generic INI subset must not mistake either for a separate owned key.
    if ((row.match(/\\+$/)?.[0].length ?? 0) % 2 || /^\s*\[http\]/i.test(row) && !/^\s*\[http\]/.test(row)) return true;
    let quoted = false;
    for (let i = 0; i < row.length; i++) {
      if (row[i] === '\\') { i++; continue; }
      if (row[i] === '"') quoted = !quoted;
    }
    if (quoted) return true;
  }
  const wanted = id === 'pip-config' ? { global: ['cert'] } : id === 'git-config' ? { http: ['sslcainfo', 'sslverify', 'sslbackend'] } :
    { http: ['cainfo', 'ssl-verify'], net: ['git-fetch-with-cli'] };
  let section = ''; const seen = new Set();
  for (const row of text.split(/\r?\n/)) {
    const header = row.match(/^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/);
    if (header) { section = header[1].toLowerCase(); continue; }
    const key = row.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)?.[1]?.toLowerCase();
    if (wanted[section]?.includes(key)) {
      const identity = `${section}/${key}`;
      if (seen.has(identity)) return true;
      seen.add(identity);
    }
  }
  return false;
}
/** Actual-client environment guards shared by the legacy supplied-file and shared-source file routes. */
function userToolsEnvironmentBlock(variant, managedPath) {
  const home = homedir();
  const pipLocation = join(home, ...(variant.os === 'win32' ? ['AppData', 'Roaming', 'pip', 'pip.ini'] : ['.config', 'pip', 'pip.conf']));
  const sameLocation = (a, b) => variant.os === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
  const redirected = variant.targets.includes('pip') && variant.os === 'win32' && process.env.APPDATA &&
    resolve(process.env.APPDATA).toLowerCase() !== resolve(home, 'AppData', 'Roaming').toLowerCase() ||
    variant.targets.includes('pip') && variant.os !== 'win32' && process.env.XDG_CONFIG_HOME &&
      resolve(process.env.XDG_CONFIG_HOME) !== resolve(home, '.config') ||
    variant.targets.includes('pip') && process.env.PIP_CONFIG_FILE && !sameLocation(process.env.PIP_CONFIG_FILE, pipLocation) ||
    variant.targets.includes('pip') && variant.os === 'win32' && process.env.WIN_PD_OVERRIDE_APPDATA &&
      !sameLocation(process.env.WIN_PD_OVERRIDE_APPDATA, join(home, 'AppData', 'Roaming')) ||
    variant.targets.includes('cargo') && process.env.CARGO_HOME && resolve(process.env.CARGO_HOME) !== resolve(home, '.cargo') ||
    variant.targets.includes('conda') && process.env.CONDARC && resolve(process.env.CONDARC) !== resolve(home, '.condarc') ||
    variant.targets.includes('git') && process.env.GIT_CONFIG_GLOBAL && resolve(process.env.GIT_CONFIG_GLOBAL) !== resolve(home, '.gitconfig');
  if (redirected) return invalid('user-config-location-unsupported', 'A selected tool redirects its user configuration. Use its canonical user location before preparing this repair.', 'PREREQUISITE_UNAVAILABLE');
  if (variant.targets.includes('cargo') && process.env.CARGO_HTTP_SSL_VERIFY && process.env.CARGO_HTTP_SSL_VERIFY !== 'true')
    return invalid('trust-bypass-environment', 'Inherited Cargo TLS verification must be enabled before preparing this CA repair.', 'PREREQUISITE_UNAVAILABLE');
  if (variant.network !== 'off' && (
      variant.targets.includes('pip') && process.env.PIP_TRUSTED_HOST ||
      variant.targets.includes('git') && process.env.GIT_SSL_NO_VERIFY ||
      variant.targets.includes('conda') && process.env.CONDA_SSL_VERIFY &&
        process.env.CONDA_SSL_VERIFY !== managedPath))
    return invalid('trust-bypass-environment', 'An inherited tool environment bypasses or overrides the selected TLS verification. Remove that override before preparing.', 'PREREQUISITE_UNAVAILABLE');
  for (const [id, key] of [['pip', 'PIP_CERT'], ['git', 'GIT_SSL_CAINFO'], ['cargo', 'CARGO_HTTP_CAINFO'],
    ['conda', 'REQUESTS_CA_BUNDLE'], ['conda', 'CURL_CA_BUNDLE']])
    if (variant.targets.includes(id) && process.env[key] && process.env[key] !== managedPath)
      return invalid('trust-override-environment', 'An inherited CA environment value overrides the selected user configuration.', 'PREREQUISITE_UNAVAILABLE');
}
export function prepareUserToolsRepair(request) {
  const variant = variantFor(request);
  if (!variant || !Array.isArray(request.targets) || variant.targets.length !== request.targets.length ||
      !variant.targets.every(id => request.targets.includes(id)) ||
      (!request.validateOnly && variant.network !== (request.offline ? 'off' : 'declared')) ||
      !(request.files?.caFile instanceof Uint8Array)) return invalid('repair-input', 'Unsupported user-tool repair input.');
  const accepted = validateSuppliedCa(request.files.caFile);
  if (!accepted.valid) return { status: 'invalid', assessedBlocks: accepted.assessedBlocks,
    ...(accepted.assessmentLimit ? { assessmentLimit: accepted.assessmentLimit } : {}), diagnostics: accepted.diagnostics };
  const facts = { fingerprints: accepted.certificates.map(item => item.fingerprint), evaluatedAt: accepted.evaluatedAt,
    count: accepted.certificates.length, duplicates: accepted.duplicates };
  if (request.validateOnly) return { status: 'completed', ...facts };
  const environment = userToolsEnvironmentBlock(variant, request.managedPath);
  if (environment) return environment;
  // All selected managers can replace their normal CA bundle; preserve roots alongside supplied CAs.
  const bundle = composeExistingTrust(request.existing, accepted.material, { includeNodeDefaults: true });
  if (bundle === undefined) return invalid('existing-trust-uncomposable', 'Existing managed trust cannot be safely composed.', 'STATE_CONFLICT');
  if (Buffer.byteLength(bundle) > 16 * 1024 * 1024) return invalid('managed-material-limit', 'Managed trust would exceed its bound.', 'STATE_CONFLICT');
  const rendered = renderUserToolsRepair({ ...request, fingerprints: facts.fingerprints, bundlePath: request.managedPath,
    bundleSha256: createHash('sha256').update(bundle).digest('hex') });
  return rendered.status === 'completed' ? { ...rendered, ...facts, bundle } : rendered;
}

/**
 * Shared-source file route (repair definition 1.1): the caller passes the complete reviewed
 * source set by identity only — `bundleSha256` of the exact serialized PEM and the sorted
 * unique DER `fingerprints` of every admitted certificate. Prior managed output is never an
 * input and never read here; refresh rebuilds from revalidated sources in the caller.
 * Runs the same actual-client environment/config guards as the legacy supplied-file repair,
 * then renders the original user recipe bindings from the captured snapshots/executable paths.
 */
export function renderUserToolsTrustFileRepair(request) {
  const variant = variantFor(request);
  if (request?.id !== 'user-tools-ca' || !variant || !Array.isArray(request.targets) ||
      variant.targets.length !== request.targets.length || !variant.targets.every(id => request.targets.includes(id)) ||
      typeof request.offline !== 'boolean' || variant.network !== (request.offline ? 'off' : 'declared') ||
      typeof request.bundlePath !== 'string' || !isAbsolute(request.bundlePath) ||
      !/^[a-f0-9]{64}$/.test(request.bundleSha256 ?? '') ||
      !Array.isArray(request.fingerprints) || !request.fingerprints.length ||
      request.fingerprints.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)))
    return invalid('repair-input', 'Unsupported user-tool trust file input.');
  if (Object.hasOwn(request, 'caFile') || Object.hasOwn(request, 'files') ||
      Object.hasOwn(request, 'existing') || Object.hasOwn(request, 'validateOnly'))
    return invalid('repair-input', 'The shared file route binds the complete source set; supplied-file fields are not accepted.');
  const environment = userToolsEnvironmentBlock(variant, request.bundlePath);
  if (environment) return environment;
  // The complete CSV is a process argument only for declared Python verification.
  const pythonPath = typeof request.executablePaths?.pythonExecutable === 'string' ? request.executablePaths.pythonExecutable : '';
  const verificationCharacters = request.fingerprints.join(',').length + 2 * (pythonTls.length + pythonPath.length) + 64;
  if (variant.targets.includes('python') && !request.offline && (request.fingerprints.length > 400 || verificationCharacters > 32000))
    return { status: 'blocked', diagnostics: [{ code: 'SOURCE_LIMIT', reason: 'source-limit',
      message: 'The complete Python verification set exceeds the portable process-argument bound.' }] };
  const rendered = renderUserToolsRepair(request);
  if (rendered.status !== 'completed' || !variant.targets.includes('python')) return rendered;
  const recipe = userToolsRecipe(variant);
  // Shared discovery includes the complete aggregate, beyond the legacy single-file bound.
  recipe.inputs.fingerprintCsv.maxLength = (request.offline ? 4096 : 400) * 65 - 1;
  return { ...rendered, recipe };
}


const nodeInvocation = (script, args = []) => ({ executable: { name: process.execPath },
  args: [literal('-e'), literal(script), ...args], cwd, env: {}, timeoutMs: 15000, maxOutputBytes: 4096, acceptedExitCodes: [0] });
const check = (id, purpose, name, args, env = {}, timeoutMs = 25000) => ({ id, purpose, kind: 'process.exit',
  executable: { name }, args: args.map(value => typeof value === 'string' ? literal(value) : value), cwd, env,
  timeoutMs, maxOutputBytes: 16384, acceptedExitCodes: [0] });
const digestScript = "const f=require('node:fs'),c=require('node:crypto');process.exit(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex')===process.argv[2]?0:1)";
const envReadScript = key => `$v=[Environment]::GetEnvironmentVariable('${key}','User');` +
  "if($null -eq $v){[Console]::Out.Write('ABSENT')}else{[Console]::Out.Write('VALUE:'+ [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)))}";
const envCheckScript = key => "const c=require('node:child_process'),p=require('node:path');const r=c.spawnSync(p.join(process.env.SystemRoot||'C:\\\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')," +
  JSON.stringify(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', envReadScript(key)]) +
  ",{encoding:'utf8',timeout:10000,maxBuffer:4096,windowsHide:true});process.exit(r.status===0&&r.stdout==='VALUE:'+Buffer.from(process.argv[1]).toString('base64')?0:1)";
const envSetScript = key => "const c=require('node:child_process'),p=require('node:path');const r=c.spawnSync(p.join(process.env.SystemRoot||'C:\\\\Windows','System32','setx.exe')," +
  `[${JSON.stringify(key)},process.argv[1]],{shell:false,timeout:10000,maxBuffer:4096,windowsHide:true});process.exit(r.status===0?0:1)`;
const pythonTls = "import os,ssl,hashlib,sys,urllib.request\nassert os.environ['SSL_CERT_FILE']==os.environ['REQUESTS_CA_BUNDLE']\nctx=ssl.create_default_context()\nloaded={hashlib.sha256(c).hexdigest() for c in ctx.get_ca_certs(binary_form=True)}\nassert set(sys.argv[1].split(',')).issubset(loaded)\nwith urllib.request.urlopen('https://pypi.org/simple/pip/',context=ctx,timeout=15) as r: assert r.status==200";
// Invoke the actual tools after checking their effective trust, never replacing the CA with a verification-only override.
const toolCheckPrelude = "const c=require('node:child_process');const expected=process.argv[1],config=process.argv[2],file=process.argv[3];" +
  "if(!file||!require('node:path').isAbsolute(file))process.exit(1);" +
  "const deadline=Date.now()+24000;const env={...process.env};" +
  "const run=(file,args)=>{const left=deadline-Date.now();if(left<=0)process.exit(1);" +
  "return c.spawnSync(file,args,{env,shell:false,windowsHide:true,encoding:'utf8',timeout:Math.min(left,18000),maxBuffer:16384})};" +
  "const ok=r=>!r.error&&r.status===0;";
// pip prints string values using Python repr. Decode only that bounded string grammar;
// never execute text returned by a tool or assume precedence among repeated file entries.
function parsePipRepr(text) {
  const quote = text[0];
  if (!['"', "'"].includes(quote) || text.at(-1) !== quote) return undefined;
  let result = '';
  for (let i = 1; i < text.length - 1; i++) {
    const char = text[i];
    if (char === quote || char.charCodeAt(0) < 32) return undefined;
    if (char !== '\\') { result += char; continue; }
    if (++i >= text.length - 1) return undefined;
    const escape = text[i];
    const simple = { '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
    if (Object.hasOwn(simple, escape)) { result += simple[escape]; continue; }
    const digits = { x: 2, u: 4, U: 8 }[escape];
    if (!digits) return undefined;
    const hex = text.slice(i + 1, i + 1 + digits);
    if (hex.length !== digits || !/^[0-9a-f]+$/i.test(hex)) return undefined;
    const code = Number.parseInt(hex, 16);
    if (code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) return undefined;
    result += String.fromCodePoint(code); i += digits;
  }
  return result;
}
function assessPipList(text, expected, parseRepr) {
  let selected = false; const seen = new Map();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const entry = line.match(/^([A-Za-z0-9_:.-]+)=(.*)$/);
    if (!entry) return false;
    const key = entry[1].toLowerCase();
    if (!/\.(?:cert|trusted-host|index-url|extra-index-url)$/.test(key)) continue;
    const value = parseRepr(entry[2]);
    if (value === undefined || seen.has(key) && seen.get(key) !== value) return false;
    seen.set(key, value);
    if (key.endsWith('.cert')) {
      if (value !== expected) return false;
      if (key === 'global.cert') selected = true;
    }
    if (key.endsWith('.trusted-host') && value.trim()) return false;
    if (key.endsWith('.index-url') || key.endsWith('.extra-index-url')) {
      try { if (value.trim().split(/\s+/).filter(Boolean).some(origin => new URL(origin).protocol !== 'https:')) return false; }
      catch { return false; }
    }
  }
  return selected;
}
const pipTls = toolCheckPrelude +
  "if(env.PIP_TRUSTED_HOST||env.PIP_CERT&&env.PIP_CERT!==expected)process.exit(1);" +
  "if(['PIP_USER','PIP_SITE','PIP_GLOBAL'].some(key=>env[key]&&!/^(0|false|no|off)$/i.test(env[key])))process.exit(1);" +
  `const parseRepr=${parsePipRepr.toString()},assess=${assessPipList.toString()};` +
  "const cfg=run(file,['-m','pip','config','list']);if(!ok(cfg)||!assess(cfg.stdout,expected,parseRepr))process.exit(1);" +
  "const r=run(file,['-m','pip','--disable-pip-version-check','--no-cache-dir','index','versions','pip','--retries','0','--timeout','15']);process.exit(ok(r)?0:1)";
const gitTls = toolCheckPrelude +
  "if(env.GIT_SSL_NO_VERIFY||env.GIT_SSL_CAINFO&&env.GIT_SSL_CAINFO!==expected)process.exit(1);" +
  "env.GIT_CONFIG_GLOBAL=config;const origin='https://github.com/git/git.git';" +
  "const cfg=run(file,['config','--get-urlmatch','http.sslCAInfo',origin]);" +
  "if(!ok(cfg)||cfg.stdout.trim().replaceAll('\\\\','/')!==expected.replaceAll('\\\\','/'))process.exit(1);" +
  "const verify=run(file,['config','--get-urlmatch','http.sslVerify',origin]);" +
  "if(verify.status!==1&&(!ok(verify)||/^(false|no|off|0)$/i.test(verify.stdout.trim())))process.exit(1);" +
  "const backend=run(file,['config','--get','http.sslBackend']);if(ok(backend)&&backend.stdout.trim().toLowerCase()==='schannel')process.exit(1);" +
  "const r=run(file,['ls-remote',origin,'HEAD']);process.exit(ok(r)?0:1)";
const cargoTls = toolCheckPrelude +
  "if(env.CARGO_HTTP_SSL_VERIFY&&env.CARGO_HTTP_SSL_VERIFY!=='true'||env.CARGO_HTTP_CAINFO&&env.CARGO_HTTP_CAINFO!==expected)process.exit(1);" +
  "const p=require('node:path'),f=require('node:fs');" +
  "if(env.CARGO_HOME&&p.resolve(env.CARGO_HOME)!==p.dirname(config))process.exit(1);" +
  "try{f.lstatSync(p.join(p.dirname(config),'config'));process.exit(1)}catch(error){if(error.code!=='ENOENT')process.exit(1)};" +
  "const r=run(file,['search','serde','--limit','1']);process.exit(ok(r)?0:1)";
// conda run's Windows wrapper refuses arguments with newlines. A fresh Python
// import also starts with an empty config search path; initialize the same
// effective context used by conda's CLI before testing its connection session.
const condaTls = ["import os", "from conda.base.context import context,reset_context", "reset_context()",
  "from conda.gateways.connection.session import CondaSession", "assert context.ssl_verify == os.environ['AIHQ_EXPECTED_CA']",
  "s=CondaSession()", "url='https://repo.anaconda.com/pkgs/main/noarch/repodata.json'",
  "assert s.merge_environment_settings(url,{},True,None,None)['verify'] == os.environ['AIHQ_EXPECTED_CA']",
  "r=s.get(url,timeout=15,stream=True)",
  "assert r.status_code==200", "r.close()"].join(';');

export function userToolsRecipe(variant) {
  const inputs = { bundle: { type: 'string', required: true, sensitive: true, maxLength: 16 * 1024 * 1024 },
    bundlePath: { type: 'string', required: true, maxLength: 4096 }, bundleSha256: { type: 'string', required: true, maxLength: 64 } };
  for (const { pathInput } of variant.executableBindings) inputs[pathInput] = { type: 'string', required: true, maxLength: 4096 };
  const operations = [{ id: 'material', purpose: 'Write composed trust preserving all existing managed certificates', kind: 'file.write',
    scope: 'user', target: { root: 'userState', segments: [literal('trust.pem')] }, content: input('bundle'), mode: 0o600,
    requires: [], checks: ['material-digest'] }];
  const checks = [{ id: 'material-digest', purpose: 'Check managed CA material bytes', kind: 'process.exit',
    ...nodeInvocation(digestScript, [input('bundlePath'), input('bundleSha256')]) }];
  const python = variant.os === 'win32' ? 'python' : 'python3';
  if (variant.targets.includes('python')) {
    inputs.pythonAssignment = { type: 'string', required: true, maxLength: 16384 };
    inputs.fingerprintCsv = { type: 'string', required: true, maxLength: 16640 };
    checks.push(check('python-installed', 'Require the selected existing Python executable', python, ['--version']));
    operations.push({ id: 'python-ready', purpose: 'Verify existing Python is runnable before changing its trust references',
      kind: 'process.run', scope: 'user', executable: { name: python }, args: [literal('--version')], cwd, env: {},
      timeoutMs: 15000, maxOutputBytes: 4096, acceptedExitCodes: [0],
      effects: ['Read-only Python version process'], requires: [], checks: ['python-installed'] });
    const dependencies = ['material', 'python-ready'];
    if (variant.os === 'win32') for (const [suffix, key] of [['ssl', 'SSL_CERT_FILE'], ['requests', 'REQUESTS_CA_BUNDLE']]) {
      const id = `python-persist-${suffix}`;
      operations.push({ id, purpose: `Persist ${key} for future Windows user processes`, kind: 'process.run', scope: 'user',
        ...nodeInvocation(envSetScript(key), [input('bundlePath')]), effects: [`HKCU\\Environment\\${key}`],
        requires: ['material', 'python-ready'], checks: [`python-user-env-${suffix}`] });
      checks.push({ id: `python-user-env-${suffix}`, purpose: `Check fresh process reads persisted ${key}`, kind: 'process.exit',
        ...nodeInvocation(envCheckScript(key), [input('bundlePath')]) });
      dependencies.push(id);
    }
    operations.push({ id: 'python-config', purpose: 'Set Python SSL_CERT_FILE and Requests CA path for future user shell sessions',
      kind: 'text.block', scope: 'user', target: target(variant.os === 'win32' ?
        ['Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'] : [variant.os === 'darwin' ? '.zprofile' : '.profile']),
      blockId: 'python-ca', startMarker: '# BEGIN AIHQ PYTHON CA', endMarker: '# END AIHQ PYTHON CA', action: 'set',
      content: input('pythonAssignment'), requires: dependencies, checks: ['python-installed', ...(variant.network === 'off' ? [] : ['python-behavior'])] });
    if (variant.network !== 'off') checks.push(check('python-behavior', 'Check Python default TLS context reaches PyPI with selected trust',
      python, ['-c', pythonTls, input('fingerprintCsv')], { SSL_CERT_FILE: input('bundlePath'), REQUESTS_CA_BUNDLE: input('bundlePath') }));
  }
  for (const file of variant.configFiles) {
    const id = file.operationId.split('-')[0];
    if (id === 'git' || id === 'cargo') inputs[`${id}CaValue`] = { type: 'string', required: true, maxLength: 8192 };
    inputs[`${id}ConfigPath`] = { type: 'string', required: true, maxLength: 4096 };
    const command = id === 'pip' && variant.network !== 'off' ? python : id;
    const versionArguments = id === 'pip' && variant.network !== 'off' ? ['-m', 'pip', '--version'] : ['--version'];
    checks.push(check(`${id}-installed`, `Require the selected existing ${id} executable`, command, versionArguments));
    const selectedChecks = [`${id}-installed`];
    operations.push({ id: `${id}-ready`, purpose: `Verify existing ${id} prerequisites before changing its configuration`,
      kind: 'process.run', scope: 'user', executable: { name: command }, args: versionArguments.map(literal), cwd, env: {},
      timeoutMs: 15000, maxOutputBytes: 4096, acceptedExitCodes: [0], effects: [`Read-only ${id} version process`],
      requires: [], checks: [...selectedChecks] });
    if (variant.network !== 'off') selectedChecks.push(`${id}-behavior`);
    const keys = { pip: '[global] cert', git: '[http] sslCAInfo', cargo: '[http] cainfo (HTTP transport only)', conda: 'ssl_verify' };
    operations.push({ id: file.operationId, purpose: `Set ${id} ${keys[id]} using the reviewed CA path; preserve neighboring configuration`,
      ...({ pip: { kind: 'config.entries', format: 'ini', entries: [{ path: ['global', 'cert'], action: 'set', value: input('bundlePath') }] },
        git: { kind: 'config.entries', format: 'ini', entries: [{ path: ['http', 'sslCAInfo'], action: 'set', value: input('gitCaValue') }] },
        cargo: { kind: 'config.entries', format: 'toml', entries: [{ path: ['http', 'cainfo'], action: 'set', value: input('cargoCaValue') }] },
        conda: { kind: 'config.entries', format: 'yaml', entries: [{ path: ['ssl_verify'], action: 'set', value: input('bundlePath') }] }
      }[id]), scope: 'user', target: structuredClone(file.target),
      requires: ['material', `${id}-ready`], checks: selectedChecks });
    if (variant.network === 'off') continue;
    if (id === 'pip') checks.push({ id: 'pip-behavior', purpose: 'Check effective pip CA configuration and HTTPS package index query', kind: 'process.exit',
      ...nodeInvocation(pipTls, [input('bundlePath'), input('pipConfigPath'), input('pythonExecutable')]), timeoutMs: 30000, maxOutputBytes: 16384 });
    if (id === 'git') checks.push({ id: 'git-behavior', purpose: 'Check effective Git CA, verification and HTTPS remote read', kind: 'process.exit',
      ...nodeInvocation(gitTls, [input('bundlePath'), input('gitConfigPath'), input('gitExecutable')]), timeoutMs: 30000, maxOutputBytes: 16384 });
    if (id === 'cargo') checks.push({ id: 'cargo-behavior', purpose: 'Check Cargo searches with inherited verified trust and no shadowing extensionless config', kind: 'process.exit',
      ...nodeInvocation(cargoTls, [input('bundlePath'), input('cargoConfigPath'), input('cargoExecutable')]), timeoutMs: 30000, maxOutputBytes: 16384 });
    if (id === 'conda') checks.push(check('conda-behavior', 'Check conda base connection session uses selected ssl_verify and reaches its repository',
      'conda', ['run', '--no-capture-output', '-n', 'base', 'python', '-c', condaTls],
      { CONDARC: input('condaConfigPath'), AIHQ_EXPECTED_CA: input('bundlePath') }, 30000));
  }
  return { schema: variant.targets.some(id => ['pip', 'git', 'conda'].includes(id)) ? 'urn:aihq:core:recipe:1.2.0' : 'urn:aihq:core:recipe:1.0.0', id: 'user-tools-ca', description: userToolsRepair.description,
    inputs, materials: [], targets: ['user'], prerequisites: [], operations, checks };
}

export function userToolsObservationRequests(request) {
  if (process.platform !== 'win32' || !request.targets.includes('python')) return [];
  return [['ssl', 'SSL_CERT_FILE'], ['requests', 'REQUESTS_CA_BUNDLE']].map(([suffix, key]) => ({
    id: `python-user-env-${suffix}`, operationId: `python-persist-${suffix}`,
    executable: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', envReadScript(key)], timeoutMs: 10000, maxOutputBytes: 4096
  }));
}
export function assessUserToolsObservations(request) {
  return request.observations.map(item => {
    const suffix = item.id === 'python-user-env-ssl' ? 'ssl' : item.id === 'python-user-env-requests' ? 'requests' : undefined;
    if (!suffix) throw new Error('observation-unsupported');
    let current = null;
    if (item.output !== 'ABSENT') {
      const encoded = item.output.startsWith('VALUE:') ? item.output.slice(6) : '';
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('user-environment-invalid');
      current = Buffer.from(encoded, 'base64').toString('utf8');
      if ('VALUE:' + Buffer.from(current).toString('base64') !== item.output) throw new Error('user-environment-invalid');
    }
    return { id: item.id, operationId: `python-persist-${suffix}`, raw: item.output,
      expectedRaw: 'VALUE:' + Buffer.from(request.managedPath).toString('base64'),
      conflict: current !== null && current !== request.managedPath, observedValue: current,
      reason: current === null ? 'absent' : current === request.managedPath ? 'already-selected' : 'replace-reviewed' };
  });
}
