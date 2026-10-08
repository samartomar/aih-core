// One managed-settings document classification shared by every Claude managed-policy observer.
// Pure: no host effects, and no key or value content leaves this function.
//
// Top-level keys are JSON property names that the client matches exactly, so matching here is exact-case on
// every OS, Windows included: a case variant is an unrecognised setting and is unreadable, never clear. Keys
// inside `env` are environment names and keep the case-insensitive matching of the shared env classification.
import { isRecord, parseStrictJson } from './canonical.mjs';
import { nativeBounds } from './contracts.mjs';
import { classifyManagedEnv } from './managed-env.mjs';

// Presence of any of these is a managed restriction. The set is deliberately conservative: a
// restricting host policy cannot be evaded by moving the workload into WSL2, so a managed
// permission, sandbox, hook or plugin rule must not be missed.
export const managedRestrictingKeys = Object.freeze([
  // Managed auto-memory preferences govern the fixed session's instruction loading.
  'autoMemoryEnabled',
  'model',
  'effortLevel',
  'otelHeadersHelper',
  'allowManagedMcpServersOnly',
  'allowedMcpServers',
  'deniedMcpServers',
  'managedMcpServers',
  'permissions',
  'sandbox',
  'disableBypassPermissionsMode',
  'allowManagedHooksOnly',
  'hooks',
  'plugins',
  'enabledPlugins',
  'allowedPlugins',
  'deniedPlugins'
]);

// Deliberately small reviewed allowlist of managed settings whose policy effect is known benign.
// Anything not listed is an observation whose effect cannot be established, so it is unreadable:
// an unrecognised managed key may route credentials/providers or run helpers. A listed key is
// only benign when its value is a recognised, bounded scalar; any other shape is unreadable.
//
// Entry justification:
// - `theme`: documented non-executing display preference (bounded lowercase token).
// No other key is allowlisted. Unverified settings or UI keys stay unreadable rather than clear.
// Model and effort choices govern the actual invocation. Masking their host source would discard
// that policy, so their presence is a restriction regardless of the selected value.
const BOUNDED_LOWER_TOKEN = /^[a-z][a-z0-9-]{0,31}$/;
const BENIGN_SCALAR_KEYS = Object.freeze(new Map([
  ['theme', value => typeof value === 'string' && BOUNDED_LOWER_TOKEN.test(value)]
]));

// One managed-settings document. A present restriction wins; a malformed document, an unrecognised
// key or an unrecognised environment key is an observation that could not be established, so it is
// unreadable rather than clear.
export function classifyManagedSettings(text) {
  let value;
  try { value = parseStrictJson(text, nativeBounds.jsonDepth); } catch { return 'unreadable'; }
  if (!isRecord(value)) return 'unreadable';
  // A known restriction is decisive even when a sibling key is unrecognised or malformed.
  if (managedRestrictingKeys.some(key => Object.hasOwn(value, key))) return 'restricted';
  if (Object.hasOwn(value, 'env')) {
    // An empty env map is a benign no-op; the shared classification decides every other block.
    const env = classifyManagedEnv(value.env);
    if (env !== 'clear') return env;
  }
  for (const key of Object.keys(value)) {
    if (key === 'env') continue;
    const validate = BENIGN_SCALAR_KEYS.get(key);
    // An unknown managed key is an observation whose policy effect cannot be established.
    if (!validate || !validate(value[key])) return 'unreadable';
  }
  return 'clear';
}
