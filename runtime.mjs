import { spawn } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isProxy } from 'node:util/types';
import tls from 'node:tls';
import { contractSupport, helperMetadata, repairIndex, targets } from './contracts.mjs';

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
      cleanupTimer ??= setTimeout(() => finish({ kind: reason === 'cancelled' ? 'cancelled' : 'limit',
        reason, terminationUnresolved: true }), 2000);
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
  let cancelled = false;
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
    if (version.terminationUnresolved) diagnostics.push(diagnostic('EXECUTION_FAILED', 'termination-unresolved', 'A diagnostic child did not confirm termination.'));
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
      if (os.terminationUnresolved) diagnostics.push(diagnostic('EXECUTION_FAILED', 'termination-unresolved', 'A diagnostic child did not confirm termination.'));
      if (os.kind === 'cancelled') { cancelled = true; push(osId, target.id, 'unavailable', 'cancelled'); break; }
      push(osId, target.id, os.kind === 'complete' ? os.code === 0 ? 'passed' : 'failed' : 'unavailable',
        os.kind === 'complete' ? os.code === 0 ? 'tls-ok' : 'connection-failed' : os.reason ?? 'probe-invocation', origin);
      const node = await tlsProbe(origin, deadline, controls.signal);
      if (node.kind === 'cancelled') { cancelled = true; push(nodeId, target.id, 'unavailable', 'cancelled'); break; }
      push(nodeId, target.id, node.kind === 'passed' ? 'passed' : ['limit', 'unavailable'].includes(node.kind) ? 'unavailable' : 'failed',
        node.reason === 'certificate-chain' && os.kind === 'complete' && os.code === 0 ? 'node-certificate-chain' : node.reason, origin);
    }
    if (cancelled) break;
  }
  if (mcp && !cancelled && remaining(deadline)) {
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
  if (cancelled) markUnstarted('cancelled');
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
