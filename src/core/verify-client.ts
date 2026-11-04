// verifyClient (contract 3, 4, 6, 14.1): native client verification in the 0.1.0 formats. A request names its tool by
// registry id; the retained verification runs under the tool's retained native client id, with its reviewed
// definitions, admission and evidence unchanged. The result says `ok` when the check ran (its `completion` and
// `verdict` tell how far), `refused` when this Core verifies no such tool, host cell or admitted cell, and `invalid`
// for the request or controls. A refusal happens before any client is looked for or launched.
import { toolRegistry } from '../harness/tool-registry.mjs';
import { nativeVerificationDefinitions } from '../harness/native/contracts.mjs';
import { nativeClientOfTool, toolOfNativeClient } from '../harness/native/tool-names.mjs';
import type { Diagnostic } from './types.js';
import type { NativeVerificationResult } from './native-contracts.js';
import { verifyNative, nativePlatform, type NativeVerificationControls } from './native-verification.js';
import { emptyNativeResult, invalidNativeResult } from './internal/native-result.js';
import { NativeStop, nativeDiagnostic, nativeSnapshot, validateNativeControls } from './internal/native-input.js';
import { schemaProblems } from './plan/formats.js';

export const NATIVE_VERIFICATION_REQUEST = 'urn:aihq:core:native-verification-request:0.1.0';
export const NATIVE_VERIFICATION_RESULT = 'urn:aihq:core:native-verification-result:0.1.0';
const RETAINED_REQUEST = 'urn:aihq:core:native-verification-request:1.0.0';

export interface NativeVerificationRequest010 {
  schema: typeof NATIVE_VERIFICATION_REQUEST;
  /** A tool registry id, such as `claude-code`. */
  client: string;
  maxTurns?: number;
  maxEstimatedCostUsd?: number;
  configuration?:
    | { kind: 'bundled'; id: 'aihq.native-fixture.v1' }
    | { kind: 'supplied'; input: string; bundleId: string; manifestSha256: string };
}
export type NativeVerificationRefusal = 'tool-unknown' | 'client-unsupported' | 'platform-unsupported' | 'cell-not-admitted';
export type NativeVerificationResult010 = Omit<NativeVerificationResult, 'schema' | 'status' | 'client'> & {
  schema: typeof NATIVE_VERIFICATION_RESULT;
  status: 'ok' | 'refused' | 'invalid';
  /** Only with `refused`. */
  code?: NativeVerificationRefusal;
  reason?: string;
  /** How far an `ok` check got; `null` when nothing was checked. */
  completion: 'complete' | 'incomplete' | 'cancelled' | null;
  client: { id: string | null; observedVersion: string | null };
};
export type NativeVerificationControls010 = NativeVerificationControls;

const refusalReasons: Record<NativeVerificationRefusal, string> = {
  'tool-unknown': 'The tool registry has no tool with that id; requests name tools by registry id.',
  'client-unsupported': 'Core has no native verification definition for this tool.',
  'platform-unsupported': 'No native verification definition matches this host cell.',
  'cell-not-admitted': 'This host cell has only a candidate definition. An explicit candidate smoke can run it, and never admits it.',
};
// Stops the retained check makes before it looks for a client: the combination itself is not verified by this Core.
const refusedStops = new Set<string>(['client-unsupported', 'platform-unsupported', 'cell-not-admitted']);

function relabel(result: NativeVerificationResult, tool: string | null, refusal?: NativeVerificationRefusal): NativeVerificationResult010 {
  const { schema: _schema, package: distribution, status, client, ...rest } = result;
  const stop = refusal ?? (status !== 'invalid' && !result.sessions.length ? [...result.stages].find(stage =>
    stage.outcome === 'unsupported' && refusedStops.has(stage.reason))?.reason as NativeVerificationRefusal | undefined : undefined);
  const id = tool ?? (client.id ? toolOfNativeClient[client.id] ?? null : null);
  const head = status === 'invalid' ? { status: 'invalid' as const, completion: null }
    : stop ? { status: 'refused' as const, code: stop, reason: refusalReasons[stop], completion: null }
    : { status: 'ok' as const, completion: status };
  return { schema: NATIVE_VERIFICATION_RESULT, package: distribution, ...head, ...rest, client: { ...client, id } } as NativeVerificationResult010;
}
const invalid = (diagnostics: Diagnostic[], request?: unknown, controls?: unknown): NativeVerificationResult010 =>
  relabel(invalidNativeResult(diagnostics, request, controls), null);

/** Explicit native verification of one tool, in the 0.1.0 formats. Input rejection and refusals perform no host work. */
export async function verifyClient(request: unknown, controls?: NativeVerificationControls010): Promise<NativeVerificationResult010> {
  let snapshot: Record<string, unknown>;
  try {
    const value = nativeSnapshot(request);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid([nativeDiagnostic('request-field')], undefined, controls);
    snapshot = value as Record<string, unknown>;
  } catch { return invalid([nativeDiagnostic('strict-json')], undefined, controls); }
  if (snapshot.schema !== NATIVE_VERIFICATION_REQUEST)
    return invalid([nativeDiagnostic('schema-id', typeof snapshot.schema === 'string' ? 'SCHEMA_UNSUPPORTED' : 'INPUT_INVALID', '/schema')], undefined, controls);
  const problems = schemaProblems(NATIVE_VERIFICATION_REQUEST, snapshot);
  if (problems) return invalid(problems.map(problem => nativeDiagnostic(problem.path === '/client' ? 'client-id' : 'request-field', 'INPUT_INVALID',
    problem.path.split('/').slice(0, 2).join('/'))), undefined, controls);
  const tool = snapshot.client as string;
  const native = Object.hasOwn(nativeClientOfTool, tool) ? nativeClientOfTool[tool]! : undefined;
  const lowered = { ...snapshot, schema: RETAINED_REQUEST, client: native ?? 'claude' };
  try { validateNativeControls(controls, lowered); }
  catch (error) { return invalid([nativeDiagnostic(error instanceof NativeStop ? error.reason : 'controls-field')], undefined, controls); }
  const refuse = (code: NativeVerificationRefusal) => {
    const result = emptyNativeResult(undefined, controls); result.status = 'incomplete'; result.platform = nativePlatform();
    return relabel(result, tool, code);
  };
  if (!toolRegistry.tools.some(entry => entry.id === tool)) return refuse('tool-unknown');
  if (!native || !nativeVerificationDefinitions.some(definition => definition.client === native)) return refuse('client-unsupported');
  return relabel(await verifyNative(lowered, controls, { bundleSchema: 'urn:aihq:core:native-verification-bundle:0.1.0' }), tool);
}
