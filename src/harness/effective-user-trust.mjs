// Process observations are separate from native admission. No store, account or configuration writes.
// Package-manager queries can update their ordinary network caches; callers select disposable homes for fixtures.
import { spawn } from 'node:child_process';
import { isAbsolute, dirname, join } from 'node:path';
import { homedir } from 'node:os';
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
const pythonTls = `import json,sys,urllib.request,urllib.error,ssl
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
const condaTls = `import json,sys
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
    const child = spawn(executable, args, { cwd, env: process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let size = 0, stdout = '', stderr = '', reason, done = false, cleanup;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); clearTimeout(cleanup);
      signal?.removeEventListener('abort', abort); resolve(result); };
    const stop = value => { reason ??= value; child.kill(); cleanup ??= setTimeout(() =>
      finish({ reason: 'termination-unresolved' }), 2000); };
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
    child.once('close', code => finish(reason ? { reason } : { code, stdout, stderr }));
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
  const configSources = []; let gitFetchWithCli = false;
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
      if (entries.some(line => /(?:cert|trusted-host|proxy|index-url|use-deprecated|use-feature|client-cert)=/i.test(line)))
        return fail('explicit-trust-or-endpoint-override');
      if (env.PIP_TRUSTED_HOST) return fail('tls-verification-disabled');
      if (env.PIP_CERT || env.REQUESTS_CA_BUNDLE || env.CURL_CA_BUNDLE) return fail('explicit-trust-override');
      observation.backend = 'pip-system-truststore-and-certifi';
    } else {
      observation.backend = 'python-ssl-default-context';
      if (env.SSL_CERT_FILE || env.SSL_CERT_DIR || env.REQUESTS_CA_BUNDLE) return fail('explicit-trust-override');
    }
  } else if (target === 'conda') {
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
    result = await run(['config', '--show-origin', '--show-scope', '--get-regexp', '^(http\..*|include.*|remote\..*\.proxy)$']);
    if (result.reason) return fail(result.reason);
    if (![0, 1].includes(result.code)) return fail('config-unavailable');
    const lines = result.stdout.split(/\r?\n/).filter(Boolean);
    observation.configSources = lines.map(line => line.split(/\s+/).slice(0, 2).join(' '));
    // Includes, URL-specific HTTP entries, duplicate keys and injected configuration cannot
    // be reduced to a global CA file. Refuse rather than rewrite a different scope.
    if (env.GIT_CONFIG_COUNT || env.GIT_CONFIG_PARAMETERS || env.GIT_SSL_NO_VERIFY) return fail('config-ambiguous');
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
  if (target === 'python') result = await run(['-c', pythonTls, endpoint]);
  if (target === 'pip') result = await run(['-m', 'pip', '--disable-pip-version-check', '--no-cache-dir', 'index', 'versions', 'pip',
    '--index-url', endpoint, '--retries', '0', '--timeout', '10']);
  if (target === 'conda') result = await run(['run', '--no-capture-output', '-n', 'base', 'python', '-c', condaTls, endpoint]);
  if (target === 'git') result = await run(['ls-remote', endpoint, 'HEAD']);
  if (target === 'cargo') result = await run(['search', 'serde', '--limit', '1']);
  if (result.reason) return fail(result.reason);
  const certificateFailure = target === 'git' || target === 'cargo' ?
    /SSL certificate problem: (?:unable to get local issuer certificate|self-signed certificate|certificate verify failed)/i.test(result.stderr ?? '') :
    target === 'pip' && /CERTIFICATE_VERIFY_FAILED/.test(result.stderr ?? '');
  const tls = ['python', 'conda'].includes(target) ? json(result)?.tls : result.code === 0 ? 'passed' : certificateFailure ? 'certificate-chain' : 'unconfirmed';
  if (tls === 'passed') return { decision: 'no-repair', reason: 'effective-trust', observation };
  if (tls === 'certificate-chain') return { decision: 'bundle-fallback', reason: 'certificate-chain', observation };
  return fail('connection-unconfirmed');
}
