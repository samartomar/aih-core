// Optional, process-local admission evidence. Subscribers receive no credentials, paths or raw argv.
// This is an observation channel, never an input to verification or a public request control.
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { canonicalJson, isRecord } from './canonical.mjs';
import { sha256 } from './digest.mjs';
import { isolationProbeNames } from './linux-isolation.mjs';
import { linuxProxyBuckets } from './linux-proxy.mjs';

const stream = channel('aih.native.admission.v1');
const diagnosticsStream = channel('aih.native.diagnostics.v1');
const diagnosticsDefinitions = ['claude-win32-x64-2.1.285', 'claude-linux-x64-wsl2-srt-2.1.285'];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : 0;
const argvDigest = value => Array.isArray(value) && value.length <= 512 && value.every(v => typeof v === 'string') &&
  Buffer.byteLength(canonicalJson(value)) <= 65536 ? sha256(canonicalJson(value)) : null;
const proofFlags = ['compared', 'authenticated', 'clientBound', 'serverBound', 'namespaceSeparated', 'argumentsClean', 'ended'];
const restrictionCounts = ['listedBuiltins', 'listedUnselected', 'permittedUnselected', 'unrequestedCalls', 'rejectedQueryCalls'];

export function publishNativeAdmission(input) {
  if (!stream.hasSubscribers) return;
  const source = input.isolation ?? {};
  const probes = Object.freeze(Object.fromEntries(isolationProbeNames.map(name => [name,
    typeof source.probes?.[name] === 'boolean' ? source.probes[name] : null])));
  const isolation = Object.freeze({ baseSha256: digest(source.baseSha256), profileSha256: digest(source.profileSha256),
    ...Object.fromEntries(proofFlags.map(name => [name, source[name] === true])), probes,
    argumentsInspected: count(source.argumentsInspected),
    proxyArguments: Object.freeze(Object.fromEntries(['bwrapArguments', 'shellArguments', 'unexpectedArguments'].map(name => [name, count(source.proxyArguments?.[name])]))),
    outcome: ['observed', 'violated', 'unobservable'].includes(source.outcome) ? source.outcome : 'unobservable' });
  stream.publish(Object.freeze({ schema: 'aih.native.admission.v1', event: 'native-admission', recordId: randomUUID(),
    runSha256: digest(input.runSha256), phase: input.phase === 'version' ? 'version' : 'session', index: input.index === 2 ? 2 : 1,
    definition: input.definition === 'claude-linux-x64-wsl2-srt-2.1.285' ? input.definition : null,
    mechanism: 'anthropic-srt-linux.v1', vendorTreeSha256: digest(input.vendorTreeSha256),
    innerArgvSha256: argvDigest(input.innerArgv), outerArgvSha256: argvDigest(input.outerArgv), isolation,
    restrictions: Object.freeze(Object.fromEntries(restrictionCounts.map(name => [name, count(input.restrictions?.[name])]))),
    cleanupConfirmed: input.cleanupConfirmed === true,
    acceptedLimitation: 'vendor-local-proxy-capability-in-argv' }));
}

// Session diagnostics are an optional observation: explicit fields discard all client strings.
export function publishNativeDiagnostics(input) {
  if (!diagnosticsStream.hasSubscribers) return;
  const source = input.collector ?? {};
  const boundedCount = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1000000) : 0;
  const counts = (value, keys) => Object.freeze(Object.fromEntries(keys.map(key => [key, boundedCount(value?.[key])])));
  const result = input.result ?? {};
  const seen = result.resultSeen === true;
  const subtype = !seen ? 'none' : ['success', 'error_max_turns', 'error_during_execution'].includes(result.resultSubtype) ? result.resultSubtype : 'other';
  const errorClass = ['none', 'authentication', 'forbidden', 'rate-limit', 'overloaded', 'network', 'other'].includes(result.errorClass) ? result.errorClass : 'none';
  const proxy = isRecord(input.proxy) ? Object.freeze(Object.fromEntries(linuxProxyBuckets.map(key =>
    [key, counts(input.proxy[key], ['allowed', 'denied'])]))) : null;
  diagnosticsStream.publish(Object.freeze({ schema: 'aih.native.diagnostics.v1', event: 'native-session-diagnostics', recordId: randomUUID(),
    runSha256: digest(input.runSha256), phase: 'session', index: input.index === 2 ? 2 : 1,
    definition: diagnosticsDefinitions.includes(input.definition) ? input.definition : null,
    collector: Object.freeze({ requests: boundedCount(source.requests), accepted: boundedCount(source.accepted),
      rejected: counts(source.rejected, ['auth', 'method', 'path', 'contentType', 'contentEncoding', 'size', 'parse', 'other']),
      contentTypes: counts(source.contentTypes, ['json', 'protobuf', 'other', 'none']),
      contentEncodings: counts(source.contentEncodings, ['none', 'gzip', 'other']),
      events: boundedCount(source.events), eventNames: counts(source.eventNames, ['apiRequest', 'apiError', 'other']),
      ignored: boundedCount(source.ignored), matched: boundedCount(source.matched), duplicates: boundedCount(source.duplicates),
      wrongSession: boundedCount(source.wrongSession), conflict: source.conflict === true }),
    proxy, result: Object.freeze({ seen, isError: seen && typeof result.resultIsError === 'boolean' ? result.resultIsError : null, subtype, errorClass }) }));
}
