// Fixed in-namespace probe and client entry. The trusted forwarder uses only built-ins.
// Credentials and channel capabilities arrive only through the clean environment, never argv.
// Each probe is true when a denial is proven, false when access is proven and null otherwise.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, lstatSync, openSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { proxyAuthorization, startCollectorForwarder } from './linux-forwarder.mjs';

const HEX = /^[a-f0-9]{64}$/;
const CONTROL = ['AIHQ_NATIVE_SANDBOX_PLAN_SHA256', 'AIHQ_NATIVE_ISOLATION_TOKEN', 'AIHQ_NATIVE_COLLECTOR_PROBE'];
const SENSITIVE = /^(?:SSH_AUTH_SOCK|SSH_AGENT_PID|GPG_AGENT_INFO|DBUS_SESSION_BUS_ADDRESS|WSL_INTEROP|WSLENV|WSL_DISTRO_NAME|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)$|^(?:AWS_|AZURE_|GOOGLE_|CODEX_)/;
const REFUSED = ['ENOENT', 'EACCES', 'EPERM', 'EROFS'];
const UNREACHABLE = ['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPERM', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL'];
const stop = () => process.exit(125);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// Success proves access. Only a recognised refusal proves denial; anything else proves nothing.
const attempt = (action, refusals = REFUSED) => { try { action(); return false; } catch (error) { return refusals.includes(error?.code) ? true : null; } };
const all = values => values.includes(false) ? false : values.length && values.every(value => value === true) ? true : null;
const libraryEnv = () => process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {};

const connectDenied = target => new Promise(resolve => {
  const socket = net.connect(target); let done = false;
  const finish = value => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve(value); };
  const timer = setTimeout(() => finish(null), 700);
  socket.once('connect', () => finish(false));
  socket.once('error', error => finish(UNREACHABLE.includes(error?.code) ? true : null));
});

// SRT advertises its in-namespace listener as localhost:3128 with a URL-embedded credential.
const proxyRequest = (target, probeToken, authorization = null) => new Promise(resolve => {
  const proxyAuth = proxyAuthorization(process.env.HTTP_PROXY ?? '');
  if (proxyAuth === null) { resolve(null); return; }
  const request = http.request({ host: '127.0.0.1', port: 3128, method: 'GET', path: target, agent: false,
    headers: { 'proxy-authorization': proxyAuth, connection: 'close', ...(authorization ? { authorization } : {}) } }, response => {
    const result = { code: response.statusCode, proxyError: typeof response.headers['x-proxy-error'] === 'string',
      matched: response.headers['x-aih-native-probe'] === probeToken };
    response.resume(); response.once('end', () => { clearTimeout(timer); resolve(result); });
  });
  const timer = setTimeout(() => { request.destroy(); resolve(null); }, 1500);
  request.once('error', () => { clearTimeout(timer); resolve(null); });
  request.end();
});
// The vendor allowlist refusal is a tagged 403. Forwarding (2xx/3xx) or an upstream failure (502/504)
// proves the request was allowed; any other answer proves nothing.
const proxyDenied = result => result === null ? null : result.code === 403 && result.proxyError ? true
  : result.code === 502 || result.code === 504 || (result.code >= 200 && result.code < 400) ? false : null;

const windowsExecDenied = plan => {
  if (plan.execution !== 'wsl2') return Promise.resolve(true);
  try {
    if (!readFileSync(plan.windowsCanary).subarray(0, 2).equals(Buffer.from('MZ'))) return Promise.resolve(null);
    accessSync(plan.windowsCanary, constants.X_OK);
  } catch { return Promise.resolve(null); }
  return new Promise(resolve => {
    const child = spawn(plan.interopHelper, ['--interop-probe', plan.windowsCanary],
      { shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: { LANG: 'C', LC_ALL: 'C', ...libraryEnv() } });
    let output = '', finished = false;
    const done = value => { if (finished) return; finished = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(null); }, 1500);
    child.stdout.on('data', bytes => { output += bytes.toString('latin1'); if (output.length > 128) { child.kill('SIGKILL'); done(null); } });
    child.once('error', () => done(null));
    // The synthetic canary exits 42 only when the kernel actually ran it through interop.
    child.once('close', code => done(code === 0 && output === 'exec-denied' ? true : code === 42 ? false : null));
  });
};

const interopDenied = path => {
  if (path !== '/init') return attempt(() => lstatSync(path));
  try {
    const stat = lstatSync(path);
    // Pinned SRT masks WSL's interpreter with a non-executable /dev/null character device.
    if (stat.isCharacterDevice() && stat.rdev === 259 && (stat.mode & 0o111) === 0) return true;
    return stat.isFile() && (stat.mode & 0o111) !== 0 ? false : null;
  } catch (error) { return REFUSED.includes(error?.code) ? true : null; }
};

const descriptorsClean = () => {
  let names;
  try { names = readdirSync('/proc/self/fd'); } catch { return null; }
  if (names.length > 64) return null;
  for (const name of names) {
    let target;
    try { target = readlinkSync(`/proc/self/fd/${name}`); } catch (error) { if (error?.code === 'ENOENT') continue; return null; }
    if (target.startsWith('/')) { if (target !== '/dev/null' && !target.startsWith('/proc/')) return false; }
    else if (!/^(?:pipe|socket|anon_inode):/.test(target)) return null;
  }
  return true;
};

export async function runProbes(plan, challenge, probeToken) {
  const { canaries } = plan;
  const [pathnameAgentDenied, abstractAgentDenied, directLoopbackDenied, directNetworkDenied,
    wrongPort, unapproved, collector, windowsDenied] = await Promise.all([
    connectDenied({ path: canaries.pathname }), connectDenied({ path: '\0' + canaries.abstract }),
    connectDenied({ host: '127.0.0.1', port: canaries.port }), connectDenied({ host: '203.0.113.1', port: 443 }),
    proxyRequest(`http://127.0.0.1:${canaries.port}/denied`, probeToken),
    proxyRequest('http://aih-native-denied.invalid/denied', probeToken),
    proxyRequest(plan.collector.replace(/\/v1\/logs$/, '/aih-native-probe'), probeToken, `Bearer ${probeToken}`),
    windowsExecDenied(plan)
  ]);
  const writable = [plan.cell.home, plan.cell.project, plan.cell.scratch].map(root => {
    const path = `${root}/.aih-native-write-probe`;
    try { writeFileSync(path, challenge, { flag: 'wx', mode: 0o600 }); unlinkSync(path); return true; } catch { return null; }
  });
  return {
    outsideReadDenied: attempt(() => readFileSync(canaries.files.provisioner)),
    hostHomeReadDenied: attempt(() => readFileSync(canaries.files.home)),
    cellSiblingReadDenied: attempt(() => readFileSync(canaries.files.sibling)),
    outsideTempReadDenied: attempt(() => readFileSync(canaries.files.temporary)),
    outsideWriteDenied: all(canaries.writes.map(path => attempt(() => writeFileSync(path, 'synthetic', { flag: 'wx', mode: 0o600 })))),
    pathnameAgentDenied, abstractAgentDenied, directLoopbackDenied, directNetworkDenied,
    proxyWrongPortDenied: proxyDenied(wrongPort), proxyUnapprovedDenied: proxyDenied(unapproved),
    collectorReachable: collector?.code === 200 && collector.matched ? true : null,
    noProxyCleared: process.env.NO_PROXY === undefined && process.env.no_proxy === undefined,
    environmentClean: !Object.keys(process.env).some(key => SENSITIVE.test(key)),
    descriptorsClean: descriptorsClean(),
    hostProcDenied: attempt(() => readFileSync(`/proc/${canaries.hostPid}/root${canaries.files.provisioner}`)),
    wslMountsDenied: plan.execution !== 'wsl2' ? true : all(canaries.mountFiles.map(path => attempt(() => closeSync(openSync(path, 'r'))))),
    wslInteropDenied: plan.execution !== 'wsl2' ? true : all(canaries.interopFiles.map(interopDenied)),
    windowsExecDenied: windowsDenied, writableRoots: all(writable),
    selectedReadOnly: all(plan.selectedPaths.map(path => attempt(() => closeSync(openSync(path, constants.O_WRONLY)), ['EROFS', 'EACCES', 'EPERM'])))
  };
}

const runClient = (plan, env, started) => new Promise(resolve => {
  let child;
  try { child = spawn(plan.runtime.client, plan.argv, { cwd: plan.cell.project, env, shell: false, stdio: 'inherit' }); }
  catch { resolve(127); return; }
  child.once('spawn', () => {
    // Hold the real executable while the outside kernel observer binds its image, argv and namespaces.
    // A process that exited before this stop supplies no proof and is never treated as verified.
    if (!child.kill('SIGSTOP')) { resolve(127); return; }
    Promise.resolve(started(child.pid)).then(() => child.kill('SIGCONT')).catch(() => { child.kill('SIGKILL'); resolve(127); });
  });
  child.once('error', () => resolve(127));
  child.once('exit', (code, signal) => resolve(signal ? 125 : code ?? 125));
});

async function main() {
  let plan;
  try {
    const bytes = readFileSync(process.argv[2]);
    if (process.argv.length !== 3 || bytes.length > 65536 || sha(bytes) !== process.env.AIHQ_NATIVE_SANDBOX_PLAN_SHA256) stop();
    plan = JSON.parse(bytes.toString('utf8'));
    if (plan?.version !== 1 || process.getuid() === 0) stop();
  } catch { stop(); }
  const token = process.env.AIHQ_NATIVE_ISOLATION_TOKEN, probeToken = process.env.AIHQ_NATIVE_COLLECTOR_PROBE;
  if (!HEX.test(token ?? '') || !HEX.test(probeToken ?? '')) stop();
  const link = net.connect(plan.probe);
  link.on('error', stop); link.on('close', stop);
  const lines = createInterface({ input: link, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const receive = async type => {
    const { value, done } = await lines.next();
    if (done || typeof value !== 'string' || Buffer.byteLength(value) > 1024) stop();
    let message; try { message = JSON.parse(value); } catch { stop(); }
    if (message?.type !== type) stop();
    return message;
  };
  await new Promise(resolve => link.once('connect', resolve));
  link.write(JSON.stringify({ version: 1, token, pid: process.pid }) + '\n');
  const { challenge } = await receive('challenge');
  if (!HEX.test(challenge ?? '')) stop();
  link.write(JSON.stringify({ type: 'probes', challenge, probes: await runProbes(plan, challenge, probeToken) }) + '\n');
  await receive('start');
  // Probes run before the listener exists. Only the exact collector port gains a proxy-backed bridge.
  const forwarder = await startCollectorForwarder({ collector: plan.collector, proxyUrl: process.env.HTTP_PROXY });
  // Observer controls are erased before the actual client starts. The evidence and OTLP channels remain.
  const childEnv = { ...process.env };
  for (const name of CONTROL) delete childEnv[name];
  const code = await runClient(plan, childEnv, async pid => {
    link.write(JSON.stringify({ type: 'client', pid }) + '\n');
    await receive('resume');
  });
  const forwarderStats = forwarder ? await forwarder.close() : null;
  link.write(JSON.stringify({ type: 'end', code, forwarder: forwarderStats }) + '\n');
  await receive('finish');
  link.removeListener('close', stop); link.end();
  process.exitCode = code;
}

// Imported only by tests; any launch path (including a symlinked one) that resolves to this file runs the entry.
const launched = () => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (launched()) await main();
