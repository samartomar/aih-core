import { hasExactKeys, parseStrictJson } from './canonical.mjs';
// Counts from the trusted runner's SRT debug logger and violation store, never client stderr.
export const linuxProxyBuckets = Object.freeze(['apiAnthropic', 'claudeAi', 'platformClaude',
  'consoleAnthropic', 'otherAnthropic', 'collector', 'other']);
const increment = (counts, bucket, decision) => { counts[bucket][decision] = Math.min(1000000, counts[bucket][decision] + 1); };

export function createLinuxProxyDiagnostics(collectorEndpoint) {
  const collector = new URL(collectorEndpoint).host;
  const counts = Object.fromEntries(linuxProxyBuckets.map(key => [key, { allowed: 0, denied: 0 }]));
  const bucket = authority => {
    if (authority === collector) return 'collector';
    const match = /^([^\s:]+):[0-9]+$/.exec(authority ?? '');
    const host = match?.[1].toLowerCase().replace(/\.$/, '');
    const named = { 'api.anthropic.com': 'apiAnthropic', 'claude.ai': 'claudeAi',
      'platform.claude.com': 'platformClaude', 'console.anthropic.com': 'consoleAnthropic' };
    return (Object.hasOwn(named, host) ? named[host] : undefined) ??
      (host === 'anthropic.com' || host?.endsWith('.anthropic.com') || host === 'claude.com' ||
        host?.endsWith('.claude.com') || host?.endsWith('.claude.ai') ? 'otherAnthropic' : 'other');
  };
  return Object.freeze({
    log(message) {
      if (typeof message !== 'string') return;
      const match = /^\[SandboxDebug\] Allowed by config rule: ([^\s]+:[0-9]+)$/.exec(message);
      if (match) increment(counts, bucket(match[1]), 'allowed');
    },
    violation(line) {
      if (typeof line !== 'string' || !line.startsWith('deny network-outbound ')) return;
      const match = /^deny network-outbound ([^\s]+:[0-9]+) \(/.exec(line);
      increment(counts, bucket(match?.[1]), 'denied');
    },
    snapshot() {
      return Object.freeze(Object.fromEntries(linuxProxyBuckets.map(key => [key, Object.freeze({ ...counts[key] })])));
    }
  });
}

// Install only in the fresh outer runner. Child processes write their own fd 2 and cannot invoke
// this JS console hook. SRT_DEBUG is never copied into the workload's separately built environment.
export function observeLinuxProxyDiagnostics(store, collectorEndpoint) {
  const counter = createLinuxProxyDiagnostics(collectorEndpoint);
  const originalError = console.error, originalWarn = console.warn, originalDebug = process.env.SRT_DEBUG;
  let total = store.getTotalCount(), available = true;
  const unsubscribe = store.subscribe(violations => {
    try {
      const current = store.getTotalCount(), added = current - total;
      total = current;
      if (added > 0) for (const violation of violations.slice(-added)) counter.violation(violation.line);
    } catch { available = false; }
  });
  // Raw SRT text may name credentials, paths or hosts, so it is only counted, never formatted or re-emitted.
  // SRT's debug logger only writes '[SandboxDebug] '-prefixed lines (and only because SRT_DEBUG is forced on);
  // anything else reaching console.error/warn is a genuine SRT warning or error. The hook writes nothing.
  let warnings = 0;
  const hook = message => {
    try { counter.log(message); } catch { available = false; }
    if (typeof message === 'string' && message.startsWith('[SandboxDebug] ')) return;
    warnings = Math.min(1000000, warnings + 1);
  };
  console.error = console.warn = hook;
  process.env.SRT_DEBUG = '1';
  return Object.freeze({
    snapshot: () => available ? counter.snapshot() : null,
    warnings: () => warnings,
    stop() {
      console.error = originalError;
      console.warn = originalWarn;
      if (originalDebug === undefined) delete process.env.SRT_DEBUG; else process.env.SRT_DEBUG = originalDebug;
      unsubscribe();
    }
  });
}

// Parse the runner's internal receipt: exactly { proxy, runnerWarnings }. Anything else is unobservable (null).
export function parseLinuxProxyReceipt(text) {
  try {
    const receipt = parseStrictJson(text), record = receipt?.proxy;
    const bounded = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000;
    if (!hasExactKeys(receipt, ['proxy', 'runnerWarnings']) || !bounded(receipt.runnerWarnings) || !hasExactKeys(record, linuxProxyBuckets) ||
        linuxProxyBuckets.some(key => !hasExactKeys(record[key], ['allowed', 'denied']) ||
          !bounded(record[key].allowed) || !bounded(record[key].denied))) return null;
    for (const pair of Object.values(record)) Object.freeze(pair);
    return Object.freeze({ proxy: Object.freeze(record), runnerWarnings: receipt.runnerWarnings });
  } catch { return null; }
}
