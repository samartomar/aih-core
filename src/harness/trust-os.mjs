// Fixed, read-only OS trust observations. An observation is complete, incomplete or unavailable;
// anything not established from the declared projection fails closed. Nothing here mutates a store.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { arch as hostArch, platform as hostPlatform, release as hostRelease } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { parsePemBundle, sha256Hex } from './trust-encoding.mjs';
import { trustPlatformMatrix } from './trust-definitions.mjs';

const ADAPTER_VERSION = '1';
let moduleSha256;
const adapterIdentity = id => {
  moduleSha256 ??= createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  return { id, version: ADAPTER_VERSION, sha256: moduleSha256 };
};
const MAX_FILE = 16 * 1024 * 1024;

function hostEnvironment(overrides = {}) {
  return {
    platform: hostPlatform(), arch: hostArch(), release: hostRelease(),
    readFile: path => { try { return readFileSync(path); } catch { return undefined; } },
    readDir: path => { try { return readdirSync(path, { withFileTypes: true }).map(item => ({ name: item.name, directory: item.isDirectory() })); } catch { return undefined; } },
    isFile: path => { try { return statSync(path).isFile(); } catch { return false; } },
    run: spec => new Promise(resolveRun => {
      const child = spawn(spec.executable, spec.args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = []; let size = 0; let settled = false;
      const done = result => { if (!settled) { settled = true; clearTimeout(timer); resolveRun(result); } };
      const timer = setTimeout(() => { child.kill(); done({ status: 'timeout' }); }, spec.timeoutMs);
      child.stdout.on('data', chunk => { size += chunk.length; if (size > spec.maxOutputBytes) { child.kill(); done({ status: 'output-limit' }); } else chunks.push(chunk); });
      child.on('error', () => done({ status: 'error' }));
      child.on('close', code => done(code === 0 ? { status: 'ok', stdout: Buffer.concat(chunks).toString('utf8') } : { status: 'error' }));
    }),
    root: '',
    ...overrides
  };
}

/** Map the host to a tested matrix release label; null means no admitted projection exists. */
export function detectTrustPlatform(overrides = {}) {
  const env = hostEnvironment(overrides);
  const base = { os: env.platform, architecture: env.arch, release: null };
  if (env.platform === 'win32') {
    const build = /^10\.0\.(\d+)/.exec(env.release);
    if (build && Number(build[1]) === 26200) base.release = 'Windows 11 25H2';
  } else if (env.platform === 'darwin') {
    if (/^25\./.test(env.release)) base.release = 'macOS 26';
  } else if (env.platform === 'linux') {
    const text = env.readFile(`${env.root}/etc/os-release`)?.toString('utf8') ?? '';
    const field = name => new RegExp(`^${name}=("?)([^\\n"]*)\\1$`, 'm').exec(text)?.[2];
    if (field('ID') === 'ubuntu' && field('VERSION_ID') === '24.04') base.release = 'Ubuntu 24.04 LTS';
  }
  const matrix = trustPlatformMatrix.find(item => item.os === base.os && item.release === base.release && item.architecture === base.architecture);
  return { ...base, projection: matrix?.projection ?? null };
}

const unavailable = (projection, reason, policy = null) => ({ status: 'unavailable', projection, reason, adapter: adapterIdentity(projection ?? 'unsupported'),
  policy, candidates: [] });
const incomplete = (projection, reason, reasons, policy) => ({ status: 'incomplete', projection, reason, reasons, adapter: adapterIdentity(projection),
  policy, candidates: [] });

// ---- Ubuntu 24.04 generated system-OpenSSL projection ------------------------------------------

function walkCrt(env, directory, depth, found) {
  if (depth > 8 || found.length > 1024) return;
  const entries = env.readDir(directory);
  if (!entries) return;
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = `${directory}/${entry.name}`;
    if (entry.directory) walkCrt(env, path, depth + 1, found);
    else if (entry.name.endsWith('.crt')) found.push(path);
  }
}

function observeUbuntu(env) {
  const projection = 'ubuntu-24.04-system-openssl-v1';
  const here = detectTrustPlatform(env);
  if (here.projection !== projection) return unavailable(projection, 'trust-platform-unsupported');
  const root = env.root;
  const conf = env.readFile(`${root}/etc/ca-certificates.conf`);
  const bundleBytes = env.readFile(`${root}/etc/ssl/certs/ca-certificates.crt`);
  const policy = { projection, osVersionId: '24.04', confSha256: conf ? sha256Hex(conf) : null, bundleSha256: bundleBytes ? sha256Hex(bundleBytes) : null };
  const reasons = [];
  if (!conf) reasons.push('ubuntu-conf-missing');
  if (!bundleBytes) reasons.push('ubuntu-bundle-absent');
  if (bundleBytes && bundleBytes.byteLength > MAX_FILE) reasons.push('ubuntu-bundle-unbounded');
  // A blocklist (distrust) source is applicable policy this adapter cannot evaluate, so it fails closed.
  for (const dir of ['/etc/ca-certificates/trust-source/blocklist', '/usr/share/ca-certificates/trust-source/blocklist',
    '/usr/local/share/ca-certificates/blocklist'])
    if ((env.readDir(`${root}${dir}`) ?? []).length) reasons.push('ubuntu-blocklist-present');
  if (reasons.length) return incomplete(projection, 'trust-discovery-incomplete', [...new Set(reasons)], policy);
  const bundle = parsePemBundle(bundleBytes, MAX_FILE);
  if (bundle.status !== 'parsed') return incomplete(projection, 'trust-discovery-incomplete', ['ubuntu-bundle-unparseable'], policy);
  // Regenerate the expected content: selected /usr/share entries plus local *.crt additions.
  const expected = new Set(); const files = [];
  for (const rawLine of conf.toString('utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    if (line.includes('..') || line.startsWith('/')) { reasons.push('ubuntu-conf-entry-invalid'); continue; }
    files.push(`/usr/share/ca-certificates/${line}`);
  }
  const local = []; walkCrt(env, `${root}/usr/local/share/ca-certificates`, 0, local);
  for (const path of local) files.push(path.slice(root.length));
  for (const path of files) {
    const bytes = env.readFile(`${root}${path}`);
    const parsed = bytes ? parsePemBundle(bytes, 65_536) : undefined;
    if (parsed?.status !== 'parsed') { reasons.push('ubuntu-source-unreadable'); continue; }
    for (const item of parsed.certificates) expected.add(item.fingerprint);
  }
  const have = new Set(bundle.certificates.map(item => item.fingerprint));
  if (reasons.length || [...expected].some(fp => !have.has(fp)) || [...have].some(fp => !expected.has(fp)))
    return incomplete(projection, 'trust-discovery-incomplete', reasons.length ? [...new Set(reasons)] : ['ubuntu-bundle-stale'], policy);
  return { status: 'complete', projection, reason: null, adapter: adapterIdentity(projection),
    policy: { ...policy, expectedSetSha256: sha256Hex(Buffer.from([...expected].sort().join('\n'))), localCertificates: local.length },
    candidates: bundle.certificates.map(item => ({ der: item.der, provenance: ['system-openssl-bundle'] })) };
}

// ---- Windows: policy facts are read; effective chain-engine policy is not enumerable --------------

const WINDOWS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$p='HKLM:\\SOFTWARE\\Policies\\Microsoft\\SystemCertificates\\AuthRoot'",
  "$d=$null; try{$d=(Get-ItemProperty -Path $p -Name DisableRootAutoUpdate).DisableRootAutoUpdate}catch{}",
  "$g=0; try{$g=@(Get-ChildItem 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\SystemCertificates\\Root\\Certificates').Count}catch{}",
  "[Console]::Out.Write((@{disableRootAutoUpdate=$d;groupPolicyRoots=$g}|ConvertTo-Json -Compress))"
].join(';');

async function observeWindows(env) {
  const projection = 'windows-effective-server-auth-v1';
  const here = detectTrustPlatform(env);
  if (here.projection !== projection) return unavailable(projection, 'trust-platform-unsupported');
  const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await env.run({ executable: shell, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT],
    timeoutMs: 10000, maxOutputBytes: 4096 });
  let facts;
  try { facts = result.status === 'ok' ? JSON.parse(result.stdout) : undefined; } catch { facts = undefined; }
  if (!facts || typeof facts !== 'object') return unavailable(projection, 'trust-configuration-unavailable');
  const policy = { projection, disableRootAutoUpdate: Number.isSafeInteger(facts.disableRootAutoUpdate) ? facts.disableRootAutoUpdate : null,
    groupPolicyRoots: Number.isSafeInteger(facts.groupPolicyRoots) ? facts.groupPolicyRoots : null };
  // Root-store membership alone is not the effective set: the configured CTL, on-demand roots and
  // per-root distrust dates live in the chain engine. Until a verified oracle exists this is incomplete.
  return incomplete(projection, 'trust-discovery-incomplete',
    [policy.disableRootAutoUpdate === 1 ? 'windows-ctl-restrictions-unestablished' : 'windows-ctl-on-demand-unestablished'], policy);
}

/** Observe the declared OS projection. `overrides` exist for fixture roots; production uses the host. */
export async function observeOsTrust({ network = 'declared', signal, environment } = {}) {
  void network; // observations are local reads: no retrieval from any OS update channel is requested
  if (signal?.aborted) return unavailable(null, 'cancelled');
  const env = hostEnvironment(environment);
  if (env.platform === 'linux') return observeUbuntu(env);
  if (env.platform === 'win32') return observeWindows(env);
  if (env.platform === 'darwin') return unavailable('macos-effective-server-auth-v1', 'trust-platform-unsupported');
  return unavailable(null, 'trust-platform-unsupported');
}
