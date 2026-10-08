// One managed-settings `env` block classification shared by every Claude managed-policy observer.
// Pure: no host effects, and no key or value content leaves this function.
import { isRecord } from './canonical.mjs';

// Fixed invocation and telemetry environment keys can change startup behavior or the collector channel, which the
// native cell depends on. A managed env block can replace the verifier's fixed values, so presence of any of these
// keys, with any value, is a positive restriction rather than a benign preference.
//
// Matching is case-insensitive on every source. Windows applies environment names case-insensitively, so a case
// variant there is the same switch; on Linux a case variant is not a known benign key either, so it never reads as
// clear and is classified with its Windows meaning to keep one observer-independent classification.
export const managedRestrictingEnvKeys = Object.freeze([
  /^CLAUDE_CODE_DISABLE_AUTO_MEMORY$/i,
  /^CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL$/i,
  /^CLAUDE_CODE_DISABLE_FAST_MODE$/i,
  /^MCP_CONNECTION_NONBLOCKING$/i,
  /^OTEL_/i,
  /^CLAUDE_CODE_ENABLE_TELEMETRY/i,
  /^CLAUDE_CODE_ENHANCED/i,
  /^DISABLE_TELEMETRY$/i,
  /^CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC$/i
]);

// Classify one document's `env` value: 'restricted' when any key is a fixed or telemetry switch; 'unreadable' for a
// non-object block or any other key, since an unrecognised key may route credentials or providers or execute helpers
// and its effect cannot be established; 'clear' only for an empty block. A known restriction wins over unknown siblings.
export function classifyManagedEnv(env) {
  if (!isRecord(env)) return 'unreadable';
  const keys = Object.keys(env);
  if (keys.some(key => managedRestrictingEnvKeys.some(pattern => pattern.test(key)))) return 'restricted';
  return keys.length > 0 ? 'unreadable' : 'clear';
}
