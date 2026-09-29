import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isProxy } from 'node:util/types';
import tls from 'node:tls';
import { contractSupport, helperMetadata, repairIndex, targets } from './contracts.mjs';
import { validateSuppliedCa, composeExistingTrust } from './ca.mjs';
export { validateSuppliedCa, composeExistingTrust } from './ca.mjs';

const literal = value => ({ literal: value });
const userTarget = (...segments) => ({ root: 'userHome', segments: segments.map(literal) });
const stateTarget = name => ({ root: 'userState', segments: [literal(name)] });
const cwdTarget = userTarget('.aih');
const nodeCheckScript = "const tls=require('node:tls'),c=require('node:crypto');" +
  "const wanted=new Set(process.argv[1].split(','));" +
  "const got=new Set(tls.getCACertificates('extra').map(p=>new c.X509Certificate(p).fingerprint256.replaceAll(':','').toLowerCase()));" +
  "process.exit([...wanted].every(f=>got.has(f))?0:1)";
const nodeTlsScript =
  "const tls=require('node:tls');" +
  "const s=tls.connect({host:'registry.npmjs.org',port:443,servername:'registry.npmjs.org',timeout:15000,rejectUnauthorized:true}," +
  "()=>{const ok=s.authorized;s.end();process.exit(ok?0:1)});" +
  "s.on('error',()=>process.exit(1));s.on('timeout',()=>{s.destroy();process.exit(1)})";
const npmCheckScript = "const fs=require('node:fs'),cp=require('node:child_process');" +
  "const expected=process.argv[1],config=process.argv[2],offline=process.argv[3]==='1';" +
  "const text=fs.readFileSync(config,'utf8');const lines=text.split(/\\r?\\n/).filter(x=>/^\\s*cafile\\s*=/.test(x));" +
  "if(!lines.length||lines.at(-1).split('=').slice(1).join('=').trim()!==expected)process.exit(1);" +
  "if(offline)process.exit(3);" +
  "const file=process.platform==='win32'?'npm.cmd':'npm';" +
  "const env={...process.env,NPM_CONFIG_USERCONFIG:config};" +
  "const configured=cp.spawnSync(file,['config','get','cafile']," +
  "{shell:process.platform==='win32',env,timeout:10000,maxBuffer:4096,windowsHide:true});" +
  "if(configured.status!==0||configured.stdout.toString().trim()!==expected)process.exit(1);" +
  "const run=cp.spawnSync(file,['ping','--fetch-retries=0','--fetch-timeout=15000']," +
  "{shell:process.platform==='win32',env,timeout:20000,maxBuffer:4096,windowsHide:true});" +
  "process.exit(run.status===0?0:1)";
const windowsEnvCheckScript = "const cp=require('node:child_process'),p=require('node:path');" +
  "const script=\"$v=[Environment]::GetEnvironmentVariable('NODE_EXTRA_CA_CERTS','User');" +
  "if($null -eq $v){[Console]::Out.Write('ABSENT')}else{[Console]::Out.Write('VALUE:'+" +
  "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)))}\";" +
  "const file=p.join(process.env.SystemRoot||'C:\\\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');" +
  "const r=cp.spawnSync(file,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:10000,maxBuffer:4096,windowsHide:true});" +
  "process.exit(r.status===0&&r.stdout==='VALUE:'+Buffer.from(process.argv[1]).toString('base64')?0:1)";
const windowsSetxScript = "const cp=require('node:child_process'),p=require('node:path');" +
  "const file=p.join(process.env.SystemRoot||'C:\\\\Windows','System32','setx.exe');" +
  "const r=cp.spawnSync(file,['NODE_EXTRA_CA_CERTS',process.argv[1]]," +
  "{shell:false,timeout:10000,maxBuffer:4096,windowsHide:true});" +
  "process.exit(r.status===0?0:1)";

/** Return only a fixed installed recipe; Core supplies and pins the reviewed material. */
export function renderRepair(request) {
  if (!request || Object.getPrototypeOf(request) !== Object.prototype ||
      Reflect.ownKeys(request).some(key => !['id', 'targets', 'bundlePath', 'bundleSha256', 'fingerprints', 'offline'].includes(key)) ||
      request.id !== 'node-npm-ca' || !Array.isArray(request.targets) ||
      !request.targets.length || request.targets.some(id => !['node', 'npm'].includes(id)) ||
      new Set(request.targets).size !== request.targets.length ||
      typeof request.bundlePath !== 'string' || !request.bundlePath || /[\r\n\0]/.test(request.bundlePath) ||
      typeof request.bundleSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(request.bundleSha256) ||
      !Array.isArray(request.fingerprints) || !request.fingerprints.length ||
      request.fingerprints.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) ||
      typeof request.offline !== 'boolean') throw new Error('repair-request');
  const operations = [{ id: 'material', purpose: 'Write validated CA certificates into managed user material',
    kind: 'file.write', scope: 'user', target: stateTarget('trust.pem'), content: { input: 'bundle' },
    mode: 0o600, requires: [], checks: ['material-digest'] }];
  const checks = [{ id: 'material-digest', purpose: 'Check persisted material bytes', kind: 'file.sha256',
    target: stateTarget('trust.pem'), sha256: request.bundleSha256 }];
  if (request.targets.includes('node')) {
    const path = process.platform === 'win32' ? ['Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'] :
      process.platform === 'darwin' ? ['.zprofile'] : ['.profile'];
    const assignment = process.platform === 'win32' ? `$env:NODE_EXTRA_CA_CERTS = '${request.bundlePath.replaceAll("'", "''")}'` :
      `export NODE_EXTRA_CA_CERTS=${"'" + request.bundlePath.replaceAll("'", "'\\''") + "'"}`;
    if (process.platform === 'win32') {
      if (request.bundlePath.includes('%') || request.bundlePath.length > 1024) throw new Error('setx-value-unsupported');
      operations.push({ id: 'node-persist', purpose: 'Persist NODE_EXTRA_CA_CERTS for future Windows user processes',
        kind: 'process.run', scope: 'user', executable: { name: process.execPath },
        args: [literal('-e'), literal(windowsSetxScript), literal(request.bundlePath)], cwd: cwdTarget, env: {},
        timeoutMs: 15000, maxOutputBytes: 4096, acceptedExitCodes: [0],
        effects: ['HKCU\\Environment\\NODE_EXTRA_CA_CERTS'], requires: ['material'], checks: ['node-user-env'] });
      checks.push({ id: 'node-user-env', purpose: 'Check Windows user environment stores the selected Node CA path',
        kind: 'process.exit', executable: { name: process.execPath },
        args: [literal('-e'), literal(windowsEnvCheckScript), literal(request.bundlePath)], cwd: cwdTarget,
        env: {}, timeoutMs: 15000, maxOutputBytes: 4096, acceptedExitCodes: [0] });
    }
    operations.push({ id: 'node-config', purpose: 'Persist Node extra CA path for future user shell sessions',
      kind: 'text.block', scope: 'user', target: userTarget(...path), blockId: 'node-ca',
      startMarker: process.platform === 'win32' ? '# BEGIN AIHQ NODE CA' : '# BEGIN AIHQ NODE CA',
      endMarker: '# END AIHQ NODE CA', action: 'set', content: literal(assignment),
      requires: [process.platform === 'win32' ? 'node-persist' : 'material'],
      checks: request.offline ? ['node-behavior'] : ['node-behavior', 'node-tls'] });
    checks.push({ id: 'node-behavior', purpose: 'Check Node loaded the selected extra CAs', kind: 'process.exit',
      executable: { name: process.execPath }, args: [literal('-e'), literal(nodeCheckScript),
        literal(request.fingerprints.join(','))],
      cwd: cwdTarget, env: { NODE_EXTRA_CA_CERTS: literal(request.bundlePath), NODE_TLS_REJECT_UNAUTHORIZED: literal('1') },
      timeoutMs: 15000, maxOutputBytes: 4096, acceptedExitCodes: [0] });
    if (!request.offline) checks.push({ id: 'node-tls', purpose: 'Check Node TLS reaches the declared registry', kind: 'process.exit',
      executable: { name: process.execPath }, args: [literal('-e'), literal(nodeTlsScript)], cwd: cwdTarget,
      env: { NODE_EXTRA_CA_CERTS: literal(request.bundlePath), NODE_TLS_REJECT_UNAUTHORIZED: literal('1') },
      timeoutMs: 15000, maxOutputBytes: 4096, acceptedExitCodes: [0] });
  }
  if (request.targets.includes('npm')) {
    operations.push({ id: 'npm-config', purpose: 'Set user npm cafile without changing other npm settings',
      kind: 'text.block', scope: 'user', target: userTarget('.npmrc'), blockId: 'npm-ca',
      startMarker: '# BEGIN AIHQ NPM CA', endMarker: '# END AIHQ NPM CA', action: 'set',
      content: literal(`cafile=${request.bundlePath}`), requires: ['material'], checks: request.offline ? [] : ['npm-behavior'] });
    if (!request.offline) checks.push({ id: 'npm-behavior', purpose: 'Check npm uses the selected cafile and reaches its registry',
      kind: 'process.exit', executable: { name: process.execPath },
      args: [literal('-e'), literal(npmCheckScript), literal(request.bundlePath), literal(join(homedir(), '.npmrc')),
        literal(request.offline ? '1' : '0')], cwd: cwdTarget, env: { NODE_TLS_REJECT_UNAUTHORIZED: literal('1') },
      timeoutMs: 25000, maxOutputBytes: 4096, acceptedExitCodes: [0] });
  }
  return { schema: 'urn:aihq:core:recipe:1.0.0', id: 'node-npm-ca',
    description: 'User-scope Node/npm CA repair from complete validated supplied input',
    inputs: { bundle: { type: 'string', required: true, sensitive: true, maxLength: 16 * 1024 * 1024 } },
    materials: [], targets: ['user'], prerequisites: [], operations, checks };
}

/** Installed vendor logic consumes bounded snapshots; it never reads or mutates the host. */
export function prepareRepairDefinition(request) {
  const definition = repairIndex.find(item => item.id === request?.id);
  if (!request || !definition || request.id !== 'node-npm-ca' ||
      !definition.variants.some(item => item.recipeRef === request.variantRef &&
        item.os === process.platform && item.architectures.includes(process.arch)) || !request.files ||
      !Object.hasOwn(request.files, 'caFile') || !(request.files.caFile instanceof Uint8Array))
    return { status: 'invalid', diagnostics: [{ code: 'INPUT_INVALID', reason: 'repair-input', message: 'Unsupported repair input.' }] };
  const accepted = validateSuppliedCa(request.files.caFile);
  if (!accepted.valid) return { status: 'invalid', diagnostics: accepted.diagnostics };
  if (request.validateOnly) return { status: 'completed', fingerprints: accepted.certificates.map(item => item.fingerprint),
    evaluatedAt: accepted.evaluatedAt, count: accepted.certificates.length, duplicates: accepted.duplicates };
  const bundle = composeExistingTrust(request.existing, accepted.material,
    { includeNodeDefaults: request.targets.includes('npm') });
  if (bundle === undefined) return { status: 'blocked', diagnostics: [{ code: 'STATE_CONFLICT',
    reason: 'existing-trust-uncomposable', message: 'Existing managed trust cannot be safely composed.' }] };
  if (Buffer.byteLength(bundle) > 16 * 1024 * 1024) return { status: 'blocked', diagnostics: [{ code: 'STATE_CONFLICT',
    reason: 'managed-material-limit', message: 'Managed trust would exceed its bound.' }] };
  const sha256 = createHash('sha256').update(bundle).digest('hex');
  const recipe = renderRepair({ id: request.id, targets: request.targets, bundlePath: request.managedPath,
    bundleSha256: sha256, fingerprints: accepted.certificates.map(item => item.fingerprint), offline: request.offline });
  return { status: 'completed', recipe, bundle, fingerprints: accepted.certificates.map(item => item.fingerprint),
    evaluatedAt: accepted.evaluatedAt, count: accepted.certificates.length, duplicates: accepted.duplicates };
}

/** Fixed, read-only host observations selected by the installed repair definition. */
export function repairObservationRequests(request) {
  if (request.id !== 'node-npm-ca') throw new Error('repair-unsupported');
  if (process.platform !== 'win32' || !request.targets.includes('node')) return [];
  return [{ id: 'node-user-env', operationId: 'node-persist', executable: join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$v=[Environment]::GetEnvironmentVariable('NODE_EXTRA_CA_CERTS','User');" +
      "if($null -eq $v){[Console]::Out.Write('ABSENT')}else{[Console]::Out.Write('VALUE:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)))}"],
    timeoutMs: 10000, maxOutputBytes: 4096 }];
}

/** Interpret the fixed probe's output and its reviewed target transition. */
export function assessRepairObservations(request) {
  if (request.id !== 'node-npm-ca') throw new Error('repair-unsupported');
  return request.observations.map(item => {
    if (item.id !== 'node-user-env') throw new Error('observation-unsupported');
    let current = null;
    if (item.output !== 'ABSENT') {
      const encoded = item.output.startsWith('VALUE:') ? item.output.slice(6) : '';
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('user-environment-invalid');
      current = Buffer.from(encoded, 'base64').toString('utf8');
      if ('VALUE:' + Buffer.from(current).toString('base64') !== item.output) throw new Error('user-environment-invalid');
    }
    return { id: item.id, operationId: 'node-persist', raw: item.output,
      expectedRaw: 'VALUE:' + Buffer.from(request.managedPath).toString('base64'),
      conflict: current !== null && current !== request.managedPath,
      observedValue: current, reason: current === null ? 'absent' :
        current === request.managedPath ? 'already-selected' : 'replace-reviewed' };
  });
}

const profile = helperMetadata.diagnostics[0].profile;
const diagnostic = (code, reason, message) => ({ code, reason, message });
const clean = value => {
  const safe = String(value).replace(/[\p{Cc}\p{Cf}]/gu, '?');
  let detail = ''; let bytes = 0;
  for (const character of safe) {
    const size = Buffer.byteLength(character);
    if (bytes + size > profile.checkDetailBytes) break;
    detail += character;
    bytes += size;
  }
  return detail;
};
const remaining = deadline => Math.max(0, Math.ceil(deadline - performance.now()));
const isCancelled = signal => signal?.aborted === true;
const isMissing = error => ['ENOENT', 'ENOTDIR'].includes(error?.code);
function plain(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !isProxy(value) &&
    [null, Object.prototype].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return typeof key === 'string' && keys.includes(key) && descriptor?.enumerable && 'value' in descriptor;
    });
}
export function validDiagnosticTargets(value) {
  if (value === undefined) return true;
  if (!Array.isArray(value) || isProxy(value) || value.length < 1 || value.length > targets.length) return false;
  if (Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).some(key => key !== 'length' &&
        (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) return false;
  const ids = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string' ||
        !targets.some(target => target.id === descriptor.value)) return false;
    ids.push(descriptor.value);
  }
  return new Set(ids).size === ids.length;
}

function executable(name) {
  if (name === 'node') return process.execPath;
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const path of (process.env.PATH || '').split(delimiter)) {
    if (!path) continue;
    for (const extension of extensions) {
      const candidate = join(path, process.platform === 'win32' && !name.toLowerCase().endsWith(extension.toLowerCase()) ? name + extension : name);
      try {
        const stat = lstatSync(candidate);
        if (stat.isFile() || stat.isSymbolicLink()) return candidate;
      } catch { /* A PATH entry may be inaccessible. */ }
    }
  }
}

function configTrace(target, home) {
  for (const relative of target.configDirs) {
    const path = resolve(home, relative);
    try {
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) return relative;
    } catch { /* Absence is inventory, not failure. */ }
  }
}

// Fixed executable and argv come from installed metadata. No caller command runs.
function curlEnvironment() {
  const env = { ...process.env };
  // Keep ordinary proxy routing for corporate hosts, but suppress environment
  // settings that alter TLS trust or write key material. -q disables curlrc.
  for (const key of Object.keys(env)) if ([
    'SSLKEYLOGFILE', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'CURL_SSL_BACKEND', 'NODE_TLS_REJECT_UNAUTHORIZED'
  ].includes(key.toUpperCase())) delete env[key];
  return env;
}

async function runProcess(file, args, deadline, ceiling, signal, maxBytes = profile.outputBytes, env = process.env) {
  const stopAt = Math.min(deadline, performance.now() + ceiling);
  if (!remaining(stopAt)) return { kind: 'limit', reason: 'deadline' };
  if (isCancelled(signal)) return { kind: 'cancelled' };
  return new Promise(resolveResult => {
    let child;
    try {
      if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file)) {
        // cmd must receive the exact discovered file, never a basename that a
        // same-named script in cwd could shadow. Reject metacharacters that cmd
        // expands even inside quotes.
        if (/["%*!^&|<>\r\n]/.test(file)) return resolveResult({ kind: 'unavailable', reason: 'probe-invocation' });
        const command = `""${file}" ${args.join(' ')}"`;
        child = spawn(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
          ['/d', '/v:off', '/s', '/c', command], { windowsHide: true, windowsVerbatimArguments: true,
            stdio: ['ignore', 'pipe', 'pipe'], env });
      } else child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (error) { resolveResult({ kind: isMissing(error) ? 'missing' : 'unavailable', reason: 'probe-invocation' }); return; }
    let done = false; let bytes = 0; let overflow = false; let timedOut = false; let cancelled = false;
    let cleanupTimer;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); clearTimeout(cleanupTimer); signal?.removeEventListener('abort', abort);
      resolveResult(value); };
    const stop = reason => {
      child.kill();
      cleanupTimer ??= setTimeout(() => {
        const aborted = cancelled || isCancelled(signal);
        finish({ kind: aborted ? 'cancelled' : 'limit',
          reason: aborted ? 'cancelled' : reason, initialReason: reason, terminationUnresolved: true });
      }, 2000);
    };
    const abort = () => { cancelled = true; stop('cancelled'); };
    const timer = setTimeout(() => { timedOut = true; stop('deadline'); }, remaining(stopAt));
    signal?.addEventListener('abort', abort, { once: true });
    if (isCancelled(signal)) abort();
    const capture = chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { overflow = true; stop('output-bytes'); return; }
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.on('error', error => finish(performance.now() >= stopAt ? { kind: 'limit', reason: 'deadline' } :
      { kind: isMissing(error) ? 'missing' : 'unavailable', reason: 'probe-invocation' }));
    child.on('close', code => finish(cancelled ? { kind: 'cancelled' } :
      timedOut || performance.now() >= stopAt ? { kind: 'limit', reason: 'deadline' } :
      overflow ? { kind: 'limit', reason: 'output-bytes' } :
      { kind: 'complete', code }));
  });
}

async function tlsProbe(origin, deadline, signal) {
  const stopAt = Math.min(deadline, performance.now() + profile.networkSocketMs);
  const timeout = remaining(stopAt);
  if (!timeout) return { kind: 'limit', reason: 'deadline' };
  if (isCancelled(signal)) return { kind: 'cancelled' };
  return new Promise(resolveResult => {
    let finished = false; let socket; let timer;
    const url = new URL(origin);
    const finish = value => { if (finished) return; finished = true; clearTimeout(timer);
      signal?.removeEventListener('abort', abort); socket?.destroy(); resolveResult(value); };
    const abort = () => finish({ kind: 'cancelled' });
    try {
      socket = tls.connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname,
        rejectUnauthorized: true, timeout }, () => {
        if (performance.now() >= stopAt) finish({ kind: 'limit', reason: 'deadline' });
        else finish({ kind: socket.authorized ? 'passed' : 'failed', reason: socket.authorized ? 'tls-ok' : 'certificate-chain' });
      });
    } catch { finish({ kind: 'unavailable', reason: 'probe-invocation' }); return; }
    timer = setTimeout(() => finish({ kind: 'limit', reason: 'deadline' }), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('error', error => finish(performance.now() >= stopAt ? { kind: 'limit', reason: 'deadline' } :
      { kind: 'failed', reason: ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED'].includes(error.code) ? 'certificate-chain' : 'connection-failed' }));
    socket.on('timeout', () => finish({ kind: 'limit', reason: 'deadline' }));
    if (isCancelled(signal)) abort();
  });
}

function configuredOrigins(selected, home, project) {
  const found = []; const rejected = []; let overflow = false;
  const specs = [
    ['claude', join(project, '.mcp.json'), 'mcpServers'],
    ['cursor', join(project, '.cursor', 'mcp.json'), 'mcpServers'],
    ['copilot', join(project, '.github', 'mcp.json'), 'mcpServers'],
    ['kimi', join(project, '.kimi-code', 'mcp.json'), 'mcpServers'],
    ['gemini', join(home, '.gemini', 'settings.json'), 'mcpServers'],
    ['windsurf', join(home, '.codeium', 'windsurf', 'mcp_config.json'), 'mcpServers'],
    ['opencode', join(home, '.config', 'opencode', 'opencode.json'), 'mcp']
  ];
  for (const [id, path, key] of specs) {
    if (!selected.has(id)) continue;
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1_000_000) { rejected.push('config-unavailable'); continue; }
      let data;
      try { data = JSON.parse(readFileSync(path, 'utf8')); }
      catch (error) { rejected.push(error instanceof SyntaxError ? 'config-invalid' : 'config-unavailable'); continue; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) { rejected.push('config-invalid'); continue; }
      const servers = data?.[key];
      if (servers === undefined) continue;
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) { rejected.push('config-invalid'); continue; }
      for (const value of Object.values(servers)) {
        const candidate = value?.url ?? value?.httpUrl;
        if (typeof candidate !== 'string') continue;
        try {
          const url = new URL(candidate);
          if (url.protocol !== 'https:' || url.username || url.password) { rejected.push('endpoint-unsupported'); continue; }
          if (!found.includes(url.origin)) {
            if (found.length < profile.configuredMcpOrigins) found.push(url.origin);
            else overflow = true;
          }
        } catch { rejected.push('endpoint-invalid'); }
      }
    } catch (error) { if (!isMissing(error)) rejected.push('config-unavailable'); }
  }
  return { found, rejected: [...new Set(rejected)].slice(0, 8), overflow };
}

export async function diagnose(request, controls = {}) {
  const invalid = reason => ({
    requestId: 'invalid',
    helper: contractSupport.package, status: 'invalid', tools: [], observations: [], checks: [],
    diagnostics: [diagnostic('INPUT_INVALID', reason, 'Use a published diagnostic and bounded controls.')],
    repairChoices: [], limits: { budgetMs: profile.phaseMs, elapsedMs: 0, maxActiveProbes: profile.maxActiveProbes }
  });
  if (!plain(request, ['requestId', 'targets', 'network', 'probeConfiguredMcp', 'project']) ||
      !plain(controls, ['signal', 'budgetMs'])) return invalid('request-field');
  if (typeof request.requestId !== 'string' || request.requestId.length < 1 || request.requestId.length > 128 ||
      !validDiagnosticTargets(request.targets) || request.network !== undefined && !['declared', 'off'].includes(request.network) ||
      request.probeConfiguredMcp !== undefined && typeof request.probeConfiguredMcp !== 'boolean' ||
      request.project !== undefined && (typeof request.project !== 'string' || !request.project || request.project.length > 4096) ||
      controls.signal !== undefined && !(controls.signal instanceof AbortSignal) ||
      controls.budgetMs !== undefined && (!Number.isInteger(controls.budgetMs) || controls.budgetMs < 1 || controls.budgetMs > profile.phaseMs))
    return invalid('diagnostic-input');
  const requestBytes = Buffer.byteLength(request.requestId) +
    Buffer.byteLength(request.project ?? '') + (request.targets ?? []).reduce((size, id) => size + Buffer.byteLength(id), 0) + 256;
  if (requestBytes > 65536) return invalid('request-bytes');
  const started = performance.now();
  const budgetMs = controls.budgetMs ?? profile.phaseMs;
  const deadline = started + budgetMs;
  const checks = []; const observations = []; const diagnostics = []; const tools = []; const repairChoices = [];
  const selected = new Set(request.targets ?? targets.map(target => target.id));
  const explicit = Array.isArray(request.targets);
  const network = request.network ?? 'declared';
  const mcp = request.probeConfiguredMcp ?? false;
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const project = request.project ?? process.cwd();
  const push = (id, target, outcome, reason, detail = '') => {
    checks.push({ id, target, outcome, reason, detail: clean(detail) });
    if (outcome === 'failed') diagnostics.push(diagnostic('VERIFICATION_FAILED', reason, 'A performed check did not pass.'));
    if (outcome === 'unavailable') diagnostics.push(diagnostic(
      reason === 'deadline' || reason === 'output-bytes' || reason === 'candidate-count' ? 'DIAGNOSTIC_LIMIT' :
        reason === 'executable-missing' || reason === 'config-unavailable' ? 'PREREQUISITE_UNAVAILABLE' :
        ['config-invalid', 'endpoint-invalid', 'endpoint-unsupported'].includes(reason) ? 'INPUT_INVALID' :
        reason === 'cancelled' ? 'CANCELLED' : 'EXECUTION_FAILED',
      reason, 'A declared check could not complete.'));
  };
  const markUnstarted = reason => {
    const seen = new Set(checks.map(check => check.id));
    for (const target of targets) {
      if (!selected.has(target.id)) continue;
      const ids = [`${target.id}/version`, ...target.origins.flatMap(origin => {
        const host = new URL(origin).host;
        return [`${target.id}/tls/os/${host}`, `${target.id}/tls/node/${host}`];
      })];
      for (const id of ids) if (!seen.has(id)) checks.push({ id, target: target.id, outcome: 'skipped', reason, detail: '' });
    }
    if (mcp && !checks.some(check => check.target === 'mcp'))
      checks.push({ id: 'mcp/configuration', target: 'mcp', outcome: 'skipped', reason, detail: '' });
  };
  if (isCancelled(controls.signal)) {
    markUnstarted('cancelled');
    return {
      requestId: request.requestId, helper: contractSupport.package, status: 'cancelled',
      tools, observations, checks,
      diagnostics: [diagnostic('CANCELLED', 'cancelled', 'Inspection was cancelled.')], repairChoices,
      limits: { budgetMs, elapsedMs: 0, maxActiveProbes: profile.maxActiveProbes }
    };
  }
  let cancelled = false; let halted = false;
  for (const target of targets) {
    if (isCancelled(controls.signal)) { cancelled = true; break; }
    if (!remaining(deadline)) { push('phase', target.id, 'unavailable', 'deadline'); break; }
    const binary = target.binaries.map(executable).find(Boolean);
    const config = configTrace(target, home);
    const detected = !!binary || !!config;
    const requested = explicit && selected.has(target.id);
    const selection = requested ? 'requested' : detected && selected.has(target.id) ? 'detected' : 'unselected';
    const state = binary ? 'binary' : config ? 'config-only' : 'absent';
    tools.push({ id: target.id, label: target.label, state, selection, ...(config ? { config } : {}) });
    if (!selected.has(target.id)) continue;
    if (!binary) {
      if (requested) push(`${target.id}/version`, target.id, 'unavailable', 'executable-missing',
        config ? 'Configuration exists, but no runnable executable was found.' : 'The requested executable was not found on PATH.');
      continue;
    }
    const version = await runProcess(binary, ['--version'], deadline, profile.localProcessMs, controls.signal);
    if (version.terminationUnresolved) {
      diagnostics.push(diagnostic('EXECUTION_FAILED', 'termination-unresolved', 'A diagnostic child did not confirm termination.'));
      if (version.initialReason === 'deadline') diagnostics.push(diagnostic('DIAGNOSTIC_LIMIT', 'deadline', 'The diagnostic child exceeded its deadline before cancellation.'));
      push(`${target.id}/version`, target.id, 'unavailable', version.reason);
      cancelled = version.kind === 'cancelled' || isCancelled(controls.signal);
      halted = true;
      break;
    }
    if (version.kind === 'cancelled') { cancelled = true; push(`${target.id}/version`, target.id, 'unavailable', 'cancelled'); break; }
    if (version.kind === 'limit') push(`${target.id}/version`, target.id, 'unavailable', version.reason);
    else if (version.kind === 'complete') {
      if (version.code === 0) {
        push(`${target.id}/version`, target.id, 'passed', 'version-ok', 'The version command exited successfully; its raw output was not retained.');
        tools.at(-1).state = 'runnable';
        observations.push({ id: `${target.id}/version`, target: target.id, detail: 'Runnable version command observed.' });
      } else { tools.at(-1).state = 'broken'; push(`${target.id}/version`, target.id, 'failed', 'version-exit', 'The version command exited unsuccessfully; its raw output was not retained.'); }
    } else push(`${target.id}/version`, target.id, 'unavailable', version.reason ?? 'probe-invocation');
    if (!selected.has(target.id)) continue;
    for (const origin of target.origins) {
      const host = new URL(origin).host;
      const osId = `${target.id}/tls/os/${host}`;
      const nodeId = `${target.id}/tls/node/${host}`;
      if (network === 'off') {
        push(osId, target.id, 'skipped', 'network-off');
        push(nodeId, target.id, 'skipped', 'network-off');
        continue;
      }
      if (tools.at(-1).state !== 'runnable') {
        push(osId, target.id, 'skipped', 'not-applicable');
        push(nodeId, target.id, 'skipped', 'not-applicable');
        continue;
      }
      const curl = executable('curl');
      const safeCurl = curl && (process.platform !== 'win32' || /\.exe$/i.test(curl));
      const os = safeCurl ? await runProcess(curl, ['--disable', '--head', '--silent', '--show-error',
        '--proto', '=https', '--max-redirs', '0', '--connect-timeout', '20',
        '--max-time', '20', origin], deadline, profile.networkProcessMs, controls.signal,
        profile.outputBytes, curlEnvironment()) :
        { kind: 'missing', reason: 'executable-missing' };
      if (os.terminationUnresolved) {
        diagnostics.push(diagnostic('EXECUTION_FAILED', 'termination-unresolved', 'A diagnostic child did not confirm termination.'));
        if (os.initialReason === 'deadline') diagnostics.push(diagnostic('DIAGNOSTIC_LIMIT', 'deadline', 'The diagnostic child exceeded its deadline before cancellation.'));
        push(osId, target.id, 'unavailable', os.reason);
        cancelled = os.kind === 'cancelled' || isCancelled(controls.signal);
        halted = true;
        break;
      }
      if (os.kind === 'cancelled') { cancelled = true; push(osId, target.id, 'unavailable', 'cancelled'); break; }
      push(osId, target.id, os.kind === 'complete' ? os.code === 0 ? 'passed' : 'failed' : 'unavailable',
        os.kind === 'complete' ? os.code === 0 ? 'tls-ok' : 'connection-failed' : os.reason ?? 'probe-invocation', origin);
      const node = await tlsProbe(origin, deadline, controls.signal);
      if (node.kind === 'cancelled') { cancelled = true; push(nodeId, target.id, 'unavailable', 'cancelled'); break; }
      push(nodeId, target.id, node.kind === 'passed' ? 'passed' : ['limit', 'unavailable'].includes(node.kind) ? 'unavailable' : 'failed',
        node.reason === 'certificate-chain' && os.kind === 'complete' && os.code === 0 ? 'node-certificate-chain' : node.reason, origin);
    }
    if (cancelled || halted) break;
  }
  if (mcp && !cancelled && !halted && remaining(deadline)) {
    const { found, rejected, overflow } = configuredOrigins(selected, home, project);
    for (const reason of rejected) push(`mcp/configuration/${reason}`, 'mcp', 'unavailable', reason);
    const mcpDeadline = Math.min(deadline, performance.now() + profile.configuredMcpMs);
    for (const [index, origin] of found.entries()) {
      const id = `mcp/tls/${index + 1}`;
      if (network === 'off') { push(id, 'mcp', 'skipped', 'network-off'); continue; }
      if (index >= profile.configuredMcpOrigins) { push(id, 'mcp', 'unavailable', 'candidate-count'); continue; }
      if (cancelled || isCancelled(controls.signal)) { cancelled = true; push(id, 'mcp', 'skipped', 'cancelled'); continue; }
      const probe = await tlsProbe(origin, mcpDeadline, controls.signal);
      if (probe.kind === 'cancelled') { cancelled = true; push(id, 'mcp', 'unavailable', 'cancelled'); continue; }
      push(id, 'mcp', probe.kind === 'passed' ? 'passed' : ['limit', 'unavailable'].includes(probe.kind) ? 'unavailable' : 'failed', probe.reason, origin);
    }
    if (overflow) push('mcp/tls/limit', 'mcp', network === 'off' ? 'skipped' : 'unavailable',
      network === 'off' ? 'network-off' : 'candidate-count');
  }
  cancelled ||= isCancelled(controls.signal);
  if (cancelled) markUnstarted('cancelled');
  else if (halted) markUnstarted('termination-unresolved');
  else if (checks.some(check => check.id === 'phase' && check.reason === 'deadline')) markUnstarted('deadline');
  const detailBytes = checks.reduce((sum, check) => sum + Buffer.byteLength(check.detail), 0);
  if (detailBytes > profile.phaseDetailBytes) {
    let left = profile.phaseDetailBytes;
    for (const check of checks) { const bytes = Buffer.from(check.detail); check.detail = bytes.subarray(0, left).toString('utf8'); left = Math.max(0, left - bytes.length); }
    diagnostics.push(diagnostic('DIAGNOSTIC_LIMIT', 'output-bytes', 'Displayed diagnostic detail was reduced to the phase limit.'));
  }
  for (const check of checks) {
    if (check.reason === 'node-certificate-chain') repairChoices.push({
      target: check.target, kind: 'manual-guidance', reason: check.reason,
      guidance: 'The OS TLS check passed while Node rejected the certificate chain. Review the current Node trust settings and approved CA material before choosing a reviewed trust repair.'
    });
    else if (check.reason === 'connection-failed') repairChoices.push({
      target: check.target, kind: 'manual-guidance', reason: check.reason,
      guidance: 'Check network reachability, proxy settings and authentication. This result alone does not identify a CA defect.'
    });
    else if (check.reason === 'version-exit') repairChoices.push({
      target: check.target, kind: 'manual-guidance', reason: check.reason,
      guidance: 'The tool was found but its version command failed. Inspect the existing installation using the tool vendor’s instructions.'
    });
    else if (check.reason === 'executable-missing') repairChoices.push({
      target: check.target, kind: 'manual-guidance', reason: check.reason,
      guidance: 'The requested tool is absent from PATH. Use an operator-approved installation or PATH change, then inspect again.'
    });
  }
  return { requestId: request.requestId, helper: contractSupport.package,
    status: cancelled ? 'cancelled' : 'completed', tools, observations, checks, diagnostics, repairChoices,
    limits: { budgetMs, elapsedMs: Math.ceil(performance.now() - started), maxActiveProbes: profile.maxActiveProbes } };
}
