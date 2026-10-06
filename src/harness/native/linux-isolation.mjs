// Closed private proof vocabulary. No filesystem paths, arguments or credentials leave this evaluator.
// Probe values are tri-state: true proves the denial, false proves access, null proves nothing.
import { hasExactKeys } from './canonical.mjs';
import { createHash } from 'node:crypto';

export const isolationProbeNames = Object.freeze([
  'outsideReadDenied', 'hostHomeReadDenied', 'cellSiblingReadDenied', 'outsideTempReadDenied', 'outsideWriteDenied', 'pathnameAgentDenied', 'abstractAgentDenied',
  'directLoopbackDenied', 'directNetworkDenied', 'proxyWrongPortDenied', 'proxyUnapprovedDenied',
  'collectorReachable', 'noProxyCleared', 'environmentClean', 'descriptorsClean', 'hostProcDenied',
  'wslMountsDenied', 'wslInteropDenied', 'windowsExecDenied', 'writableRoots', 'selectedReadOnly'
]);

const tri = value => value === true || value === false || value === null;
export const validIsolationProbes = probes => hasExactKeys(probes, isolationProbeNames) &&
  isolationProbeNames.every(key => tri(probes[key]));

// Unauthenticated material never proves anything. Once the workload is kernel-authenticated, proven
// access, a workload sharing a host namespace or a protected value in argv is a violation; every
// other gap stays unobservable.
export function evaluateLinuxIsolation(proof) {
  if (!proof || proof.authenticated !== true || !validIsolationProbes(proof.probes) ||
      !tri(proof.namespaceSeparated) || !tri(proof.argumentsClean)) return 'unobservable';
  if (isolationProbeNames.some(key => proof.probes[key] === false) ||
      proof.namespaceSeparated === false || proof.argumentsClean === false) return 'violated';
  if (proof.interference === true) return 'unobservable';
  return isolationProbeNames.every(key => proof.probes[key] === true) &&
    ['clientBound', 'serverBound', 'namespaceSeparated', 'profileCompared', 'argumentsClean']
      .every(key => proof[key] === true) ? 'observed' : 'unobservable';
}

// clean: false only when a protected value is present; argv that cannot be inspected proves nothing.
export function inspectLinuxArguments(argv, protectedValues) {
  const unproven = { clean: null, inspected: 0 };
  if (!Array.isArray(argv) || argv.length > 4096 || !Array.isArray(protectedValues)) return unproven;
  let bytes = 0;
  for (const value of argv) if (typeof value !== 'string' || (bytes += Buffer.byteLength(value)) > 1024 * 1024) return unproven;
  const secrets = protectedValues.filter(secret => typeof secret === 'string' && secret.length > 0);
  return argv.some(value => secrets.some(secret => value.includes(secret))) ? { clean: false, inspected: 0 }
    : { clean: true, inspected: argv.length };
}

// The only accepted secret-like argv value is SRT's current local proxy capability, at its fixed
// bwrap/environment or shell-command sites. Values stay transient; only class counts are returned.
const PROXY_ENVIRONMENT = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy',
  'GRPC_PROXY', 'grpc_proxy', 'GIT_SSH_COMMAND', 'FTP_PROXY', 'ftp_proxy', 'DOCKER_HTTP_PROXY', 'DOCKER_HTTPS_PROXY', 'CLOUDSDK_PROXY_PASSWORD']);
export function inspectLinuxProxyCapability(observed, expected) {
  const counts = { bwrapArguments: 0, shellArguments: 0, unexpectedArguments: 0 };
  if (!/^[a-f0-9]{64}$/.test(expected?.sha256 ?? '') || inspectLinuxArguments(observed?.argv, []).clean !== true)
    return { clean: null, ...counts };
  const same = value => createHash('sha256').update(value).digest('hex') === expected.sha256;
  for (let index = 0; index < observed.argv.length; index++) {
    const value = observed.argv[index];
    const urlTokens = [...value.matchAll(/(?:http|socks5h):\/\/[^\s:@'"]+:([a-f0-9]{32})@localhost:(?:3128|1080)/g)].map(match => match[1]);
    const present = [...value.matchAll(/[a-f0-9]{32}/g)].some(match => same(match[0]));
    if (urlTokens.some(token => !same(token))) { counts.unexpectedArguments++; continue; }
    if (!present) continue;
    if (observed.executablePath === expected.bwrap && index >= 3 && observed.argv[index - 2] === '--setenv' &&
        PROXY_ENVIRONMENT.has(observed.argv[index - 1])) counts.bwrapArguments++;
    else if (observed.executablePath === expected.bash && observed.argv.length === 3 && observed.argv[1] === '-c' && index === 2)
      counts.shellArguments++;
    else counts.unexpectedArguments++;
  }
  return { clean: counts.unexpectedArguments === 0, ...counts };
}
