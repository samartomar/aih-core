// Cell selection: the descriptor, platform, admission and lifecycle gates. Every refusal is explicit
// and happens before any native launch.
import { arch as osArch, release as osRelease } from 'node:os';
import { nativeVerificationDefinitions } from './contracts.mjs';
import { definitionIdentity } from './digest.mjs';
import { lifecycleAvailability } from './lifecycle.mjs';

export function observeNativePlatform({ platform = process.platform, arch = osArch(), release = osRelease() } = {}) {
  const os = ['win32', 'linux', 'darwin'].includes(platform) ? platform : 'unsupported';
  const execution = os === 'linux' && /microsoft/i.test(release) ? 'wsl2' : 'native';
  return { os, arch, osRelease: release, execution };
}

export function selectNativeCell({ client, admission, platform, definitions = nativeVerificationDefinitions }) {
  const forClient = definitions.filter(definition => definition.client === client);
  if (!forClient.length) return { outcome: 'unsupported', reason: 'client-unsupported' };
  const onPlatform = forClient.filter(definition => definition.platform.os === platform.os &&
    definition.platform.arch === platform.arch && definition.platform.execution === platform.execution &&
    definition.platform.osRelease === platform.osRelease);
  if (!onPlatform.length) return { outcome: 'unsupported', reason: 'platform-unsupported' };
  const eligible = admission === 'candidate-smoke' ? onPlatform : onPlatform.filter(definition => definition.state === 'admitted');
  if (!eligible.length) return { outcome: 'unsupported', reason: 'cell-not-admitted' };
  const definition = eligible[0];
  const lifecycle = lifecycleAvailability(definition.lifecycleId, platform.os);
  if (lifecycle.status !== 'available') {
    return { outcome: 'unsupported', reason: lifecycle.reason, ...(lifecycle.missing ? { missing: lifecycle.missing } : {}) };
  }
  return { outcome: 'selected', definition, adapter: definitionIdentity(definition) };
}

export function matchClientVersion(definition, observed) {
  if (typeof observed !== 'string') return { outcome: 'unavailable', reason: 'version-unreadable' };
  return definition.clientVersions.includes(observed) ? { outcome: 'matched' } : { outcome: 'unsupported', reason: 'version-unsupported' };
}

export function parseClaudeVersionOutput(text) {
  if (typeof text !== 'string' || text.length > 256) return null;
  const match = /^(\d+\.\d+\.\d+)(?: \(Claude Code\))?\r?\n?$/.exec(text);
  return match ? match[1] : null;
}
