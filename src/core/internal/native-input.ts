import { types } from 'node:util';
import { isAbsolute } from 'node:path';
import { canonicalJson } from './canonical.js';
import { assertStrictJsonValueV1, jsonOwnEntriesV1 } from './strict-json.js';
import type { Diagnostic } from '../types.js';
import type { NativeVerificationControls } from '../native-verification.js';

const id = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const nativeClients = ['claude', 'codex', 'cursor', 'gemini', 'copilot', 'windsurf', 'opencode', 'kimi', 'kiro', 'antigravity', 'zed'] as const;
export const nativeReasons = new Set(['schema-id', 'request-field', 'controls-field', 'client-id', 'budget-invalid', 'path-invalid', 'binding-invalid', 'strict-json',
  'fixture-bytes-mismatch', 'material-path-unsafe', 'configuration-unavailable', 'sandbox-root-unavailable', 'staging-unavailable', 'client-absent', 'version-unreadable',
  'client-unsupported', 'version-unsupported', 'platform-unsupported', 'cell-not-admitted', 'transport-unsupported', 'configuration-channel-unsupported', 'authentication-channel-unsupported',
  'authentication-unavailable', 'identity-binding-invalid', 'session-launch-failed', 'executable-changed', 'session-identity-unobservable', 'session-not-fresh', 'loading-mode-unobservable',
  'configuration-not-loaded', 'managed-restriction', 'guardrail-path-conflict', 'restriction-unobservable', 'identity-session-mismatch', 'identity-conflict', 'tools-not-discovered',
  'server-evidence-unavailable', 'instructions-not-loaded', 'instruction-attestation-unobservable', 'instruction-attestation-mismatch', 'instruction-source-ambiguous',
  'query-challenge-mismatch', 'query-answer-mismatch', 'configuration-changed', 'isolation-unobserved', 'isolation-violated', 'observed', 'before-session-2', 'after-session-2',
  'cancelled', 'budget-exhausted', 'limit-exceeded', 'native-internal', 'not-run-after-failure', 'not-run-after-restriction', 'not-run-after-unavailable', 'termination-unresolved', 'cleanup-unresolved']);
export class NativeStop extends Error {
  constructor(readonly reason: string, readonly outcome: 'failed' | 'unsupported' | 'unavailable' | 'restricted' = 'unavailable') {
    super('Native verification stopped.');
    if (!nativeReasons.has(reason)) { this.reason = 'native-internal'; this.outcome = 'unavailable'; }
  }
}
export function nativeDiagnostic(reason: string, code = 'INPUT_INVALID', path?: string): Diagnostic {
  if (!nativeReasons.has(reason)) reason = 'native-internal';
  const message = code === 'INPUT_INVALID' ? 'Expected bounded, plain native verification input.' :
    code === 'SCHEMA_UNSUPPORTED' ? 'This native verification format or cell is not supported.' :
    code === 'CANCELLED' ? 'Native verification was cancelled.' :
    code === 'EXECUTION_FAILED' ? 'Native verification observed a contradiction.' :
    code === 'INTERNAL_ERROR' ? 'Native verification could not finish.' : 'A native verification prerequisite is unavailable.';
  return { code, reason, message, ...(path ? { path } : {}),
    ...(reason === 'managed-restriction' ? { guidance: 'Contact your IT administrator about the managed restriction.' } : {}) };
}

/** Node can reject proxies before any reflective operation triggers caller code. */
export function nativeSnapshot(value: unknown, depth = 1, active = new WeakSet<object>(), bound = { bytes: 0 }): unknown {
  bound.bytes += typeof value === 'string' ? Buffer.byteLength(value) + 2 : 8;
  if (bound.bytes > 65536) throw new NativeStop('strict-json');
  if (typeof value !== 'object' || value === null) return value;
  if (types.isProxy(value) || depth > 16 || active.has(value)) throw new NativeStop('strict-json');
  active.add(value);
  const output: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  for (const [key, child] of jsonOwnEntriesV1(value, 'native input')) {
    bound.bytes += Buffer.byteLength(key) + 3;
    Object.defineProperty(output, key, { value: nativeSnapshot(child, depth + 1, active, bound), enumerable: true, writable: true, configurable: true });
  }
  active.delete(value);
  return output;
}
export function ownNativeValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && 'value' in descriptor ? descriptor.value : undefined; }
  catch { return undefined; }
}
function closed(value: unknown, keys: string[], reason: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NativeStop(reason);
  if (Object.keys(value).some(key => !keys.includes(key))) throw new NativeStop(reason);
  return value as Record<string, unknown>;
}
function path(value: unknown): boolean { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') && isAbsolute(value) && !value.startsWith('\\\\'); }
function digest(value: unknown): boolean { return typeof value === 'string' && hash.test(value); }
function length(value: unknown, maximum: number): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum; }
export function validateNativeControls(value: unknown, request: Record<string, unknown>): NativeVerificationControls {
  try {
    const original = value === undefined ? {} : value;
    if (!original || typeof original !== 'object' || Array.isArray(original) || types.isProxy(original)) throw new NativeStop('controls-field');
    const json: Record<string, unknown> = {};
    let signal: AbortSignal | undefined;
    for (const [key, child] of jsonOwnEntriesV1(original, 'native controls')) {
      if (key === 'signal') {
        if (!child || typeof child !== 'object' || types.isProxy(child)) throw new NativeStop('controls-field');
        // The built-in getter brand-checks the internal slot; instanceof alone is forgeable.
        try { Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(child); }
        catch { throw new NativeStop('controls-field'); }
        if (!(child instanceof AbortSignal) || Object.getPrototypeOf(child) !== AbortSignal.prototype || Object.getOwnPropertyNames(child).length !== 0) throw new NativeStop('controls-field');
        signal = child;
      } else json[key] = nativeSnapshot(child);
    }
    assertStrictJsonValueV1(json, 'native controls');
    if (Buffer.byteLength(canonicalJson(json)) > 65536) throw new NativeStop('strict-json');
    const controls = closed(json, ['budgetMs', 'sandboxRoot', 'admission', 'testIdentity', 'configurationSources'], 'controls-field');
    if (Object.hasOwn(controls, 'budgetMs') && !(length(controls.budgetMs, 600000) && Number(controls.budgetMs) >= 1000)) throw new NativeStop('budget-invalid');
    if (Object.hasOwn(controls, 'sandboxRoot') && !path(controls.sandboxRoot)) throw new NativeStop('path-invalid');
    if (Object.hasOwn(controls, 'admission') && !['admitted', 'candidate-smoke'].includes(controls.admission as string)) throw new NativeStop('controls-field');
    if (Object.hasOwn(controls, 'testIdentity')) {
      const binding = closed(controls.testIdentity, ['adapterId', 'provisionedRoot', 'manifestSha256', 'expected'], 'binding-invalid');
      const expected = closed(binding.expected, ['accountUuid', 'organizationId'], 'binding-invalid');
      if (binding.adapterId !== 'claude-oauth-otel.v1' || !digest(binding.manifestSha256) ||
        ![expected.accountUuid, expected.organizationId].every(v => typeof v === 'string' && uuid.test(v))) throw new NativeStop('binding-invalid');
      if (!path(binding.provisionedRoot)) throw new NativeStop('path-invalid');
    }
    const configuration = request.configuration as Record<string, unknown> | undefined;
    if (configuration?.kind === 'supplied') {
      const sources = closed(controls.configurationSources, [configuration.input as string], 'binding-invalid');
      if (Object.keys(sources).length !== 1 || !id.test(configuration.input as string)) throw new NativeStop('binding-invalid');
      const source = closed(sources[configuration.input as string], ['archivePath', 'archiveSha256', 'archiveBytes', 'manifestPath', 'manifestSha256', 'manifestBytes'], 'binding-invalid');
      if (!path(source.archivePath)) throw new NativeStop('path-invalid');
      if (![source.archiveSha256, source.manifestSha256].every(digest) || source.manifestSha256 !== configuration.manifestSha256 ||
        !length(source.archiveBytes, 256 * 1024 * 1024) || !length(source.manifestBytes, 256 * 1024)) throw new NativeStop('binding-invalid');
      if (typeof source.manifestPath !== 'string' || !safeNativePath(source.manifestPath, true)) throw new NativeStop('path-invalid');
    } else if (Object.hasOwn(controls, 'configurationSources')) throw new NativeStop('binding-invalid');
    return { ...controls, ...(signal ? { signal } : {}) } as NativeVerificationControls;
  } catch (error) { if (error instanceof NativeStop) throw error; throw new NativeStop('strict-json'); }
}
export function safeNativePath(value: string, member = false): boolean {
  if (!value || value.length > 512 || /[\\:\p{Cc}\p{Cf}]/u.test(value) || value.startsWith('/') || member && !value.startsWith('package/')) return false;
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' &&
    !/[. ]$/.test(segment) && !/[<>"|?*]/.test(segment) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment));
}
