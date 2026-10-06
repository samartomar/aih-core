// Optional, process-local admission evidence. Subscribers receive no credentials, paths or raw argv.
// This is an observation channel, never an input to verification or a public request control.
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { canonicalJson } from './canonical.mjs';
import { sha256 } from './digest.mjs';
import { isolationProbeNames } from './linux-isolation.mjs';

const stream = channel('aih.native.admission.v1');
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
