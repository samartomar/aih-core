import { X509Certificate } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const MAX_ORIGINS = 6;
const MAX_PROBES = 128;
const MAX_ROOTS = 1024;
const MAX_ROOT_BYTES = 64 * 1024;
const MAX_CHAIN = 8;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_SIGNERS = 8;
const MAX_UNIONS = 256;

export function candidateOrigins(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_ORIGINS) return undefined;
  const origins = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 2048) return undefined;
    let url;
    try { url = new URL(value); } catch { return undefined; }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        url.origin !== value) return undefined;
    if (!origins.includes(value)) origins.push(value);
  }
  return origins;
}

function parsedRoots(pems, now) {
  if (!Array.isArray(pems) || pems.length > MAX_ROOTS) return { reason: 'root-count' };
  if (pems.some(pem => typeof pem !== 'string' || Buffer.byteLength(pem) > MAX_ROOT_BYTES))
    return { reason: 'root-bytes' };
  const byFingerprint = new Map();
  for (const pem of pems) {
    try {
      const cert = new X509Certificate(pem);
      const from = Date.parse(cert.validFrom), to = Date.parse(cert.validTo);
      if (!cert.ca || !Number.isFinite(from) || !Number.isFinite(to) || now < from || now > to) continue;
      const fingerprint = cert.fingerprint256.replaceAll(':', '').toLowerCase();
      if (!byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, { cert, fingerprint, pem: cert.toString() });
    } catch { /* Existing OS inventory may contain an unusable entry. */ }
  }
  return { roots: [...byFingerprint.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)) };
}

function parseChain(raw) {
  if (!Array.isArray(raw) || raw.length < 1) return { reason: 'peer-output-invalid' };
  if (raw.length > MAX_CHAIN) return { reason: 'peer-count' };
  let outputBytes = 2;
  const chain = [];
  for (const value of raw) {
    if (!(value instanceof Uint8Array)) return { reason: 'peer-output-invalid' };
    outputBytes += Buffer.byteLength(Buffer.from(value).toString('base64')) + 3;
    if (outputBytes > MAX_CAPTURE_BYTES) return { reason: 'output-bytes' };
    try { chain.push(new X509Certificate(value)); } catch { return { reason: 'peer-output-invalid' }; }
  }
  return { chain };
}

function unions(groups) {
  if (!groups.length || groups.some(group => !group.length || group.length > MAX_SIGNERS))
    return { reason: groups.some(group => group.length > MAX_SIGNERS) ? 'candidate-count' : 'no-signing-root' };
  const distinct = new Map();
  const selected = new Map();
  let overflow = false;
  const visit = index => {
    if (overflow) return;
    if (index === groups.length) {
      const roots = [...selected.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
      const key = roots.map(root => root.fingerprint).join('|');
      if (!distinct.has(key)) {
        if (distinct.size >= MAX_UNIONS) { overflow = true; return; }
        distinct.set(key, roots);
      }
      return;
    }
    for (const root of groups[index]) {
      const prior = selected.get(root.fingerprint);
      selected.set(root.fingerprint, root);
      visit(index + 1);
      if (prior) selected.set(root.fingerprint, prior);
      else selected.delete(root.fingerprint);
    }
  };
  visit(0);
  if (overflow) return { reason: 'candidate-count' };
  return { values: [...distinct.values()].sort((a, b) =>
    a.length - b.length || a.map(root => root.fingerprint).join('|').localeCompare(b.map(root => root.fingerprint).join('|'))) };
}

/** Private diagnostic seam. Callers of the published helper cannot provide these functions. */
export async function selectTrustCandidateWith(originsInput, dependencies, controls = {}) {
  const origins = candidateOrigins(originsInput);
  if (!origins) return { kind: 'unresolved', reason: 'origin-invalid', probes: 0 };
  const started = performance.now();
  const deadline = started + Math.min(120000, controls.budgetMs ?? 120000);
  let probes = 0;
  const remaining = () => deadline - performance.now();
  const stop = () => controls.signal?.aborted ? 'cancelled' : remaining() <= 0 ? 'deadline' :
    probes >= MAX_PROBES ? 'candidate-count' : undefined;
  const late = () => controls.signal?.aborted ? 'cancelled' : remaining() <= 0 ? 'deadline' : undefined;
  const attempt = async (kind, origin, roots = []) => {
    const reason = stop();
    if (reason) return { kind: 'unavailable', reason };
    probes++;
    try {
      const result = await dependencies.probe(kind, origin, roots, Math.min(25000, remaining()), controls.signal);
      const reason = late();
      return reason ? { kind: 'unavailable', reason } : result;
    }
    catch { return { kind: 'unavailable', reason: late() ?? 'probe-invocation' }; }
  };
  const unresolved = reason => ({ kind: 'unresolved', reason, probes, elapsedMs: Math.ceil(performance.now() - started) });
  for (const origin of origins) {
    const os = await attempt('os', origin);
    if (os.kind !== 'passed') return unresolved(os.reason ?? 'os-tls-unavailable');
    const node = await attempt('node', origin);
    if (node.kind !== 'failed' || node.reason !== 'certificate-chain')
      return unresolved(node.kind === 'passed' ? 'node-already-trusted' : node.reason ?? 'node-tls-unavailable');
  }
  let systemPasses = true;
  for (const origin of origins) {
    const result = await attempt('system-ca', origin);
    if (result.kind === 'unavailable') return unresolved(result.reason);
    if (result.kind !== 'passed') systemPasses = false;
  }
  if (systemPasses && late()) return unresolved(late());
  if (systemPasses) return { kind: 'system-ca', origins, probes,
    elapsedMs: Math.ceil(performance.now() - started) };
  const chains = [];
  for (const origin of origins) {
    const result = await attempt('capture', origin);
    if (result.kind !== 'captured') return unresolved(result.reason ?? 'peer-capture');
    const parsed = parseChain(result.chain);
    if (parsed.reason) return unresolved(parsed.reason);
    chains.push(parsed.chain);
  }
  if (stop()) return unresolved(stop());
  let inventory;
  try { inventory = await dependencies.systemRoots(remaining(), controls.signal); }
  catch { return unresolved(late() ?? 'root-inventory'); }
  if (late()) return unresolved(late());
  if (!inventory || inventory.kind !== 'completed') return unresolved(inventory?.reason ?? 'root-inventory');
  const parsed = parsedRoots(inventory.roots, Date.now());
  if (parsed.reason) return unresolved(parsed.reason);
  const groups = chains.map(chain => {
    const tail = chain.at(-1);
    return parsed.roots.filter(root => {
      try { return tail.checkIssued(root.cert) && tail.verify(root.cert.publicKey); }
      catch { return false; }
    });
  });
  const choices = unions(groups);
  if (late()) return unresolved(late());
  if (choices.reason) return unresolved(choices.reason);
  for (const choice of choices.values) {
    let passes = true;
    for (const origin of origins) {
      const result = await attempt('extra-ca', origin, choice.map(root => root.pem));
      if (result.kind === 'unavailable') return unresolved(result.reason);
      if (result.kind !== 'passed') passes = false;
    }
    if (passes && late()) return unresolved(late());
    if (passes) return { kind: 'extra-ca', origins, certs: choice.map(root => ({
      fingerprint: root.fingerprint, pem: root.pem })), probes,
      elapsedMs: Math.ceil(performance.now() - started) };
  }
  return unresolved('no-verified-candidate');
}
