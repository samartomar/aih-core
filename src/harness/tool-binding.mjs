// Portable Harness data: where each observed AI tool reads each content kind, and the observations that
// prove it. Support is derived only from observations, scoped to the platform they were made on. These are
// scoped claims; they do not satisfy native verification acceptance. Importing this performs no host observation.
import { Ajv2020 } from 'ajv/dist/2020.js';
import bindingSchema from './schemas/tool-binding/1.0.0.json' with { type: 'json' };
import bindingData from './tool-bindings.json' with { type: 'json' };
import { pointerMember, snapshotNativeData, unsupportedFormat } from './native/canonical.mjs';
import { findTool, selectTool } from './tool-registry.mjs';

const BINDING = 'urn:aihq:harness:tool-binding:1.0.0';
export const toolBindingKinds = Object.freeze(['skill', 'agent', 'command', 'rule', 'hook', 'mcp-server', 'document']);

const deepFreeze = value => {
  if (value && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};
// Seeded with the 23 October 2026 Windows canary observations. Every change here ships in a new Core version.
export const toolBindings = deepFreeze(bindingData);

// Isolation that keeps the user's own configuration out of the observation. Inside-profile redirection never counts.
const QUALIFYING = new Set(['os-account', 'sandbox', 'env-redirect-outside-profile']);
const REGISTERED = new Set(['registered', 'registered-pending-approval', 'visible-to-model']);
const LEVELS = ['none', 'delivered', 'listed-only', 'registered', 'recognised'];
const VERSION = /^[0-9]{1,9}(?:\.[0-9]{1,9}){0,3}$/;

const level = item => item.recognised === 'recognised' ? 'recognised' : REGISTERED.has(item.registered) ? 'registered'
  : item.recognised === 'listed-only' ? 'listed-only' : item.delivered === 'delivered' ? 'delivered' : 'none';
// Documents need only delivery; every other kind needs the tool to list it, show it to the model or use it.
const proves = (kind, item) => kind === 'document' ? item.delivered === 'delivered'
  : REGISTERED.has(item.registered) || item.recognised === 'recognised';
const refutes = (kind, item) => kind !== 'document' && item.delivered === 'delivered' &&
  (item.registered === 'not-registered' || item.recognised === 'not-recognised');
const compareVersions = (left, right) => {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
};
const isPlatform = value => value !== null && typeof value === 'object' && typeof value.os === 'string' && typeof value.arch === 'string';

/**
 * Derives a cell's support from its observations. With `platform`, only observations made on that OS and
 * architecture count. With `installedVersion`, a native cell whose observations are all older is `stale`
 * and claims no more than `registered`.
 */
export function deriveCellSupport({ kind, observations, platform, installedVersion } = {}) {
  if (!toolBindingKinds.includes(kind)) throw new TypeError(`Unknown content kind: ${kind}`);
  if (!Array.isArray(observations)) throw new TypeError('observations must be an array');
  if (platform !== undefined && !isPlatform(platform)) throw new TypeError('platform must be { os, arch }');
  if (installedVersion !== undefined && (typeof installedVersion !== 'string' || !VERSION.test(installedVersion)))
    throw new TypeError('installedVersion must be a dotted numeric version');
  const counted = observations.filter(item => QUALIFYING.has(item.isolation) &&
    (platform === undefined || item.os === platform.os && item.arch === platform.arch));
  const proving = counted.filter(item => proves(kind, item));
  const support = proving.length ? 'native' : counted.some(item => refutes(kind, item)) ? 'none' : 'unconfirmed';
  const newest = items => items.reduce((best, item) => !best || compareVersions(item.toolVersion, best.toolVersion) > 0 ? item : best, undefined);
  const stale = support === 'native' && installedVersion !== undefined &&
    compareVersions(installedVersion, newest(proving).toolVersion) > 0;
  const rank = item => LEVELS.indexOf(level(item));
  const best = newest(counted.filter(item => rank(item) === Math.max(...counted.map(rank))));
  if (!best) return { support, observed: 'none', stale: false };
  const observed = stale && level(best) === 'recognised' ? 'registered' : level(best);
  const { toolVersion, os, arch, observedAt } = best;
  return { support, observed, stale, observedOn: { toolVersion, os, arch, observedAt } };
}

/**
 * The shipped binding cell for a tool, kind and platform. Only a cell that is native on that platform is
 * selected; any other cell is refused with its reason.
 */
export function selectBindingCell({ tool, kind, platform, installedVersion } = {}) {
  if (!toolBindingKinds.includes(kind)) throw new TypeError(`Unknown content kind: ${kind}`);
  if (!isPlatform(platform)) throw new TypeError('platform must be { os, arch }');
  const selected = selectTool(tool);
  if (selected.status === 'refused') return selected;
  const binding = toolBindings.find(item => item.tool === selected.tool.id);
  if (!binding) return { status: 'refused', code: 'PREREQUISITE_UNAVAILABLE', reason: 'tool-not-observed', tool: selected.tool };
  const layout = binding.layouts[kind];
  const derived = deriveCellSupport({ kind, observations: layout.observations, platform, installedVersion });
  if (derived.support !== 'native') return { status: 'refused', code: 'PREREQUISITE_UNAVAILABLE', reason: 'kind-not-native',
    tool: binding.tool, kind, cell: { support: derived.support, reason: derived.support === layout.support ? layout.reason
      : `Not observed on ${platform.os} ${platform.arch}; observations from another platform do not count.` } };
  return { status: 'selected', tool: binding.tool, kind, ...derived, digest: binding.digest, layout };
}

const invalid = (reason, path, message) => ({ code: 'INPUT_INVALID', reason, path, message });
let check;
/**
 * Validates a tool-binding 1.0.0 document: its schema, a registry tool id, and every cell's support derived
 * from its own observations. A converter is named only on a native cell. The digest is the lowercase SHA-256
 * of the binding's canonical JSON without `digest`; consumers that need it bound recompute it.
 */
export function validateToolBinding(value) {
  const unsupported = unsupportedFormat(value, [BINDING]);
  if (unsupported) return { valid: false, diagnostics: [unsupported] };
  try { value = snapshotNativeData(value, 1048576); }
  catch { return { valid: false, diagnostics: [invalid('shape', '', 'The tool binding must be bounded plain JSON data.')] }; }
  check ??= new Ajv2020({ allErrors: true, strict: true }).compile(bindingSchema);
  if (!check(value)) return { valid: false, diagnostics: check.errors.map(error => invalid('schema',
    error.keyword === 'additionalProperties' ? `${error.instancePath}/${pointerMember(error.params.additionalProperty)}` : error.instancePath,
    'The tool binding does not match its schema.')) };
  const diagnostics = [];
  if (findTool(value.tool)?.via !== 'id') diagnostics.push(invalid('unknown-tool', '/tool', 'The binding must name a registry tool id.'));
  for (const kind of toolBindingKinds) {
    const layout = value.layouts[kind], path = `/layouts/${kind}`;
    if (deriveCellSupport({ kind, observations: layout.observations }).support !== layout.support)
      diagnostics.push(invalid('support-not-derived', `${path}/support`, "The cell's support is not the one its observations give."));
    if (layout.convert !== undefined && layout.support !== 'native')
      diagnostics.push(invalid('convert-not-observed', `${path}/convert`, 'A converter is named only where its output was observed.'));
  }
  return { valid: diagnostics.length === 0, diagnostics };
}
