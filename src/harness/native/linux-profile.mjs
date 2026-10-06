// Fixed Anthropic SRT Linux profile. This is internal Harness composition, never a request policy.
import { posix } from 'node:path';
import { canonicalJson, hasExactKeys, parseStrictJson } from './canonical.mjs';

const bases = new WeakMap();
const PROVIDERS = Object.freeze(['api.anthropic.com:443', 'claude.ai:443', 'platform.claude.com:443']);
const PATH = /^\/[A-Za-z0-9._/+:-]+$/;
const ARG = /^[A-Za-z0-9._/@:+-]*$/;
const fail = () => { throw new Error('isolation-unobserved'); };
const freeze = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
export const linuxSafePath = value => typeof value === 'string' && value.length <= 4096 && PATH.test(value) &&
  value !== '/' && posix.normalize(value) === value && !value.endsWith('/') && !value.split('/').includes('..');
const path = value => linuxSafePath(value) ? value : fail();
const below = (root, value) => value.startsWith(`${root}/`);
const paths = (values, max = 256) => {
  if (!Array.isArray(values) || values.length > max) return fail();
  return values.map(path);
};

export function createLinuxBaseProfile(input) {
  if (!hasExactKeys(input, ['cell', 'runtime', 'workload', 'plan', 'selectedPaths'])) return fail();
  const { cell, runtime } = input;
  if (!hasExactKeys(cell, ['path', 'home', 'project', 'scratch', 'observations']) ||
      !hasExactKeys(runtime, ['node', 'client', 'bash', 'env', 'bwrap', 'socat', 'rg', 'libraries', 'readFiles'])) return fail();
  path(cell.path);
  for (const name of ['home', 'project', 'scratch', 'observations']) {
    path(cell[name]); if (cell[name] !== `${cell.path}/${name}`) return fail();
  }
  const executables = ['node', 'client', 'bash', 'env', 'bwrap', 'socat', 'rg'].map(key => path(runtime[key]));
  const selected = paths(input.selectedPaths);
  if (!selected.length || selected.some(value => !below(cell.home, value) && !below(cell.project, value))) return fail();
  const workload = path(input.workload), plan = path(input.plan);
  if (!below(cell.observations, plan)) return fail();
  const profile = freeze({
    network: { allowedDomains: [...PROVIDERS], deniedDomains: [], strictAllowlist: true,
      allowAllUnixSockets: true, allowLocalBinding: false },
    filesystem: { denyRead: ['/'],
      allowRead: [...new Set([...executables, ...paths(runtime.libraries, 64), ...paths(runtime.readFiles),
        workload, plan, cell.home, cell.project, cell.scratch])],
      allowWrite: [cell.home, cell.project, cell.scratch], denyWrite: selected },
    enableWeakerNestedSandbox: false, enableWeakerNetworkIsolation: false,
    bwrapPath: runtime.bwrap, socatPath: runtime.socat, ripgrep: { command: runtime.rg }
  });
  bases.set(profile, { observations: cell.observations });
  return profile;
}

export function initializeLinuxProfile(base, endpoint) {
  if (!bases.has(base) || typeof endpoint !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1\/logs$/.test(endpoint)) return fail();
  const collector = new URL(endpoint);
  if (!collector.port || Number(collector.port) > 65535 || collector.href !== endpoint) return fail();
  return freeze({ ...base, network: { ...base.network, allowedDomains: [...base.network.allowedDomains, collector.host] } });
}

export function deriveLinuxSessionProfile(base, slots) {
  const owned = bases.get(base);
  if (!owned || !hasExactKeys(slots, ['collector', 'evidence', 'probe', 'http', 'socks'])) return fail();
  const initial = initializeLinuxProfile(base, slots.collector);
  for (const key of ['evidence', 'probe', 'http', 'socks']) {
    const value = path(slots[key]);
    if (!below(owned.observations, value) || Buffer.byteLength(value) > 100) return fail();
    const relative = posix.relative(owned.observations, value);
    if (key === 'evidence' || key === 'probe') {
      if (!/^[a-zA-Z0-9._-]+$/.test(relative)) return fail();
    } else if (!/^s[12]\/claude-(http|socks)-[0-9a-f]{16}\.sock$/.test(relative)) return fail();
  }
  if (slots.evidence === slots.probe || [slots.http, slots.socks].some(value => value === slots.evidence || value === slots.probe)) return fail();
  return freeze({ ...initial,
    filesystem: { ...base.filesystem, allowRead: [...new Set([...base.filesystem.allowRead,
      slots.evidence, slots.probe, slots.http, slots.socks])] }
  });
}

export function verifyLinuxSessionProfile(base, slots, bytes) {
  try {
    if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > 65536) return false;
    return canonicalJson(parseStrictJson(bytes)) === canonicalJson(deriveLinuxSessionProfile(base, slots));
  } catch { return false; }
}

// Values must fit this small grammar before shell quoting. No shell expansion is accepted.
// Empty argv is preserved for the approved --tools value; its position is checked by the definition.
export function fixedLinuxCommand(env, executable, argv) {
  path(env); path(executable);
  if (!Array.isArray(argv) || argv.length > 32 || argv.some(value => typeof value !== 'string' ||
      value.length > 4096 || !ARG.test(value))) return fail();
  return [env, '-u', 'NO_PROXY', '-u', 'no_proxy', executable, ...argv].map(value => `'${value}'`).join(' ');
}
