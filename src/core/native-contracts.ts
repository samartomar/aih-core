// Portable native-verification contracts. Types, closed JSON Schema validation and pure digest
// helpers only: importing this module performs no host work and needs no Node built-in.
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import bundleSchema from './schemas/native-verification-bundle/1.0.0.json' with { type: 'json' };
import requestSchema from './schemas/native-verification-request/1.0.0.json' with { type: 'json' };
import resultSchema from './schemas/native-verification-result/1.0.0.json' with { type: 'json' };
import { canonicalJson, codeUnitCompare } from './internal/canonical.js';
import { assertStrictJsonValueV1, cloneJsonValueStructureV1 } from './internal/strict-json.js';
import type { Diagnostic, ValidationResult } from './types.js';

export type NativeClientId = 'claude' | 'codex' | 'cursor' | 'gemini' | 'copilot' | 'windsurf'
  | 'opencode' | 'kimi' | 'kiro' | 'antigravity' | 'zed';
export type Sha256 = string;
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }
export interface NativeMember { path: string; sha256: Sha256; byteLength: number }
export interface NativeTreeFile { root: 'home' | 'project'; path: string; member: NativeMember }
export interface NativeVerificationRequest {
  schema: 'urn:aihq:core:native-verification-request:1.0.0';
  client: NativeClientId;
  configuration?:
    | { kind: 'bundled'; id: 'aihq.native-fixture.v1' }
    | { kind: 'supplied'; input: string; bundleId: string; manifestSha256: Sha256 };
}
export interface NativeVerificationBundle {
  schema: 'urn:aihq:core:native-verification-bundle:1.0.0';
  id: string; client: NativeClientId; adapterId: string;
  scope: 'test-configuration' | 'production-configuration';
  package: { name: string; version: string };
  release: NativeMember;
  selection: { itemId: string; itemSha256: Sha256; recipe: NativeMember;
    inputs: Record<string, string | number | boolean> };
  startingTree: NativeTreeFile[]; startingTreeSha256: Sha256;
  outputTree: NativeTreeFile[]; outputTreeSha256: Sha256;
  instructions: { root: 'home' | 'project'; path: string; sha256: Sha256;
    evidence: 'native' | 'marker'; markerSha256?: Sha256 }[];
  server: { name: string; transport: 'stdio'; runtime: NativeMember[]; evidenceAdapterId: string;
    observation: 'native' | 'recorder'; recorder?: NativeMember;
    toolNames: string[]; queryTool: string; queryArguments: JsonObject;
    challenge: { mode: 'argument'; field: string } | { mode: 'rpc-id' };
    expectedResultSha256: Sha256; expectedAnswer: string };
}
export type NativeStageOutcome = 'passed' | 'failed' | 'unsupported' | 'restricted' | 'unavailable';
export type NativeStageEvidence =
  | { kind: 'none' }
  | { kind: 'digest'; sha256: Sha256 }
  | { kind: 'counts'; count: number }
  | { kind: 'match'; matched: boolean };
export interface NativeStage { id: string; session: 1 | 2 | null; outcome: NativeStageOutcome;
  reason: string; evidence: NativeStageEvidence }
export interface NativeVerificationResult {
  schema: 'urn:aihq:core:native-verification-result:1.0.0';
  package: { name: '@aihq/core'; version: string };
  status: 'complete' | 'incomplete' | 'invalid' | 'cancelled';
  verdict: 'verified' | 'failed' | 'unverified';
  proofScope: 'bundled-mechanism' | 'test-configuration' | 'production-configuration' | 'none';
  admission: 'admitted' | 'candidate-smoke';
  client: { id: NativeClientId | null; observedVersion: string | null };
  adapter: { id: string; sha256: Sha256 } | null;
  platform: { os: 'win32' | 'linux' | 'darwin' | 'unsupported'; arch: string; osRelease: string;
    execution: 'native' | 'wsl2' };
  content: { bundleId: string; manifestSha256: Sha256; archiveSha256: Sha256 | null;
    outputTreeSha256: Sha256; guardrailsSha256: Sha256; stagedConfigurationDigest: Sha256 } | null;
  sessions: { index: 1 | 2; process: { pid: number; clientSessionId: string | null };
    launchArgvDigest: Sha256; stagedConfigurationDigest: Sha256;
    challengeSha256: Sha256; stages: NativeStage[] }[];
  stages: NativeStage[];
  security: { sandbox: { level: 'observed-os-boundary' | 'hygiene-only' | 'not-started';
    mechanism: string | null; reason: string };
    hostSecretIsolation: { outcome: 'passed' | 'unavailable'; reason: string } };
  authority: 'not-evaluated';
  survivingProcesses: { pid: number; role: 'client' | 'server' | 'recorder' | 'helper' }[];
  cleanup: { processes: 'confirmed' | 'unresolved' | 'not-created';
    files: 'removed' | 'retained' | 'not-created'; retainedCell: string | null };
  diagnostics: Diagnostic[];
  limits: { budgetMs: number; elapsedMs: number; sessionsStarted: number;
    stagesCompleted: number; observedBytes: number; telemetryEvents: number;
    rpcMessages: number; evidenceTruncated: boolean };
}

const REQUEST_SCHEMA_ID = 'urn:aihq:core:native-verification-request:1.0.0';
const RESULT_SCHEMA_ID = 'urn:aihq:core:native-verification-result:1.0.0';
const BUNDLE_SCHEMA_ID = 'urn:aihq:core:native-verification-bundle:1.0.0';

// Pure SHA-256 so portable validation can digest canonical JSON without a Node crypto import.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
function sha256Hex(input: string): Sha256 {
  const data = new TextEncoder().encode(input);
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(data.length / 0x20000000));
  view.setUint32(padded.length - 4, (data.length << 3) >>> 0);
  const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const schedule = new Uint32Array(64);
  const rotate = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) schedule[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const first = schedule[index - 15]!; const second = schedule[index - 2]!;
      schedule[index] = (schedule[index - 16]! + (rotate(first, 7) ^ rotate(first, 18) ^ (first >>> 3)) +
        schedule[index - 7]! + (rotate(second, 17) ^ rotate(second, 19) ^ (second >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state as unknown as [number, number, number, number, number, number, number, number];
    for (let index = 0; index < 64; index += 1) {
      const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) +
        SHA256_K[index]! + schedule[index]!) >>> 0;
      const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0; d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    state[0] = (state[0]! + a) >>> 0; state[1] = (state[1]! + b) >>> 0; state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0; state[4] = (state[4]! + e) >>> 0; state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0; state[7] = (state[7]! + h) >>> 0;
  }
  return [...state].map(value => value.toString(16).padStart(8, '0')).join('');
}
/** Tree digest: SHA-256 of Core canonical JSON over root/path/digest/length, root then path. */
export function nativeTreeDigestSha256(tree: NativeTreeFile[]): Sha256 {
  const entries = tree.map(file => ({ root: file.root, path: file.path,
    sha256: file.member.sha256, byteLength: file.member.byteLength }))
    .sort((left, right) => codeUnitCompare(left.root, right.root) || codeUnitCompare(left.path, right.path));
  return sha256Hex(canonicalJson(entries));
}

const unsafePathCharacter = /[\\:\u0000-\u001f\u007f\p{Cf}<>"|?*]/u;
const deviceName = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
function safeNativeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 ||
    value.startsWith('/') || unsafePathCharacter.test(value)) return false;
  return value.split('/').every(part => part !== '' && part !== '.' && part !== '..' &&
    !/[. ]$/.test(part) && !deviceName.test(part));
}
function safeNativeMemberPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('package/') &&
    safeNativeRelativePath(value.slice('package/'.length));
}
function treePathsSafe(tree: NativeTreeFile[]): boolean {
  const aliases = new Set<string>();
  for (const file of tree) {
    if (!safeNativeRelativePath(file.path) || !safeNativeMemberPath(file.member.path)) return false;
    const alias = `${file.root}/${file.path.normalize('NFC').toLowerCase()}`;
    if (aliases.has(alias)) return false;
    for (const other of aliases) if (other.startsWith(`${alias}/`) || alias.startsWith(`${other}/`)) return false;
    aliases.add(alias);
  }
  return true;
}

type NativeDocumentKind = 'request' | 'result' | 'bundle';
const documentLimits: Record<NativeDocumentKind, { bytes: number; depth: number }> = {
  request: { bytes: 65536, depth: 16 },
  result: { bytes: 65536, depth: 16 },
  bundle: { bytes: 262144, depth: 16 },
};
const safeDiagnosticPath = /^(?:\/[A-Za-z0-9._-]+)*$/;
function diagnostic(code: string, reason: string, path?: string, encountered?: string): Diagnostic {
  return {
    code, reason,
    message: code === 'SCHEMA_UNSUPPORTED' ? 'This native verification format is not supported.'
      : code === 'INPUT_INVALID' && reason === 'strict-json' ? 'Expected bounded, plain strict JSON data.'
      : 'The native verification document does not satisfy its published contract.',
    ...(path ? { path } : {}), ...(encountered ? { encountered } : {}),
  };
}
function fieldReason(kind: NativeDocumentKind, error: ErrorObject): string {
  if (kind === 'request') return error.instancePath === '/client' && (error.keyword === 'enum' || error.keyword === 'type')
    ? 'client-id' : 'request-field';
  return kind === 'bundle' ? 'bundle-field' : 'result-field';
}
function schemaErrorPath(error: ErrorObject): string | undefined {
  let path = error.instancePath;
  const key = error.keyword === 'additionalProperties'
    ? (error.params as { additionalProperty?: unknown }).additionalProperty
    : error.keyword === 'required' ? (error.params as { missingProperty?: unknown }).missingProperty : undefined;
  if (typeof key === 'string') path = `${path}/${key}`;
  return path.length > 0 && path.length <= 512 && safeDiagnosticPath.test(path) ? path : undefined;
}

function bundleSemantics(document: NativeVerificationBundle): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const invalid = (reason: string, path: string) => diagnostics.push(diagnostic('INPUT_INVALID', reason, path));
  if (nativeTreeDigestSha256(document.startingTree) !== document.startingTreeSha256)
    invalid('bundle-digest', '/startingTreeSha256');
  if (nativeTreeDigestSha256(document.outputTree) !== document.outputTreeSha256)
    invalid('bundle-digest', '/outputTreeSha256');
  if (!treePathsSafe(document.startingTree)) invalid('bundle-path', '/startingTree');
  if (!treePathsSafe(document.outputTree)) invalid('bundle-path', '/outputTree');
  for (const [index, instruction] of document.instructions.entries()) {
    const file = document.outputTree.find(candidate =>
      candidate.root === instruction.root && candidate.path === instruction.path);
    if (!file || file.member.sha256 !== instruction.sha256) invalid('bundle-reference', `/instructions/${index}`);
    if (instruction.evidence === 'marker' ? typeof instruction.markerSha256 !== 'string' : instruction.markerSha256 !== undefined)
      invalid('bundle-reference', `/instructions/${index}/evidence`);
  }
  const toolNames = document.server.toolNames;
  if (new Set(toolNames).size !== toolNames.length || !toolNames.includes(document.server.queryTool))
    invalid('bundle-reference', '/server/queryTool');
  if (document.server.observation === 'recorder' ? !document.server.recorder : document.server.recorder !== undefined)
    invalid('bundle-reference', '/server/observation');
  const runtimePaths = document.server.runtime.map(member => member.path);
  if (new Set(runtimePaths).size !== runtimePaths.length) invalid('bundle-reference', '/server/runtime');
  return diagnostics;
}

function resultSemantics(document: NativeVerificationResult): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const invalid = (reason: string, path: string) => diagnostics.push(diagnostic('INPUT_INVALID', reason, path));
  const rows = [...document.stages, ...document.sessions.flatMap(session => session.stages)];
  if (rows.length > 32) invalid('result-limit', '/stages');
  if (document.limits.sessionsStarted !== document.sessions.length || document.limits.stagesCompleted !== rows.length)
    invalid('result-field', '/limits');
  const sessionRows = ['session-freshness', 'loading-mode', 'tool-restrictions', 'provider-authentication',
    'tool-discovery', 'instruction-loading', 'read-only-query', 'isolation', 'cleanup'];
  for (const [index, session] of document.sessions.entries()) {
    if (session.index !== index + 1 || session.stages.length !== sessionRows.length ||
        session.stages.some((stage, row) => stage.id !== sessionRows[row] || stage.session !== session.index))
      invalid('result-field', `/sessions/${index}`);
  }
  if (document.status === 'invalid') {
    if (document.stages.length || document.sessions.length) invalid('result-field', '/stages');
    if (document.adapter !== null || document.content !== null || document.proofScope !== 'none')
      invalid('result-field', '/adapter');
    if (document.security.sandbox.level !== 'not-started') invalid('result-field', '/security/sandbox/level');
    if (document.cleanup.processes !== 'not-created' || document.cleanup.files !== 'not-created')
      invalid('result-field', '/cleanup');
  }
  if (document.verdict === 'verified') {
    if (document.status !== 'complete' || document.sessions.length !== 2 || rows.length === 0)
      invalid('result-field', '/verdict');
    if (rows.some(stage => stage.outcome !== 'passed')) invalid('result-field', '/stages');
    if (document.cleanup.processes !== 'confirmed' || document.cleanup.files !== 'removed')
      invalid('result-field', '/cleanup');
    if (document.security.hostSecretIsolation.outcome !== 'passed')
      invalid('result-field', '/security/hostSecretIsolation');
    if (document.security.sandbox.level !== 'observed-os-boundary' || document.security.sandbox.mechanism === null ||
        document.security.sandbox.reason !== 'observed' || document.security.hostSecretIsolation.reason !== 'observed')
      invalid('result-field', '/security/sandbox');
    if (document.client.id === null || document.client.observedVersion === null || document.adapter === null ||
        document.content === null || document.proofScope === 'none' || document.platform.os === 'unsupported')
      invalid('result-field', '/content');
    if (document.survivingProcesses.length || document.cleanup.retainedCell !== null || document.diagnostics.length)
      invalid('result-field', '/cleanup');
    const requiredRunRows = [
      ['fixture-integrity', null, 'observed'], ['host-presence', null, 'observed'],
      ['identity-binding', null, 'observed'], ['cell-staging', null, 'observed'],
      ['session-start', 1, 'observed'], ['configuration-unchanged', 2, 'before-session-2'],
      ['session-start', 2, 'observed'], ['configuration-unchanged', 2, 'after-session-2'],
      ['cleanup', null, 'observed']
    ];
    if (document.stages.length !== requiredRunRows.length || document.stages.some((stage, index) =>
      stage.id !== requiredRunRows[index]![0] || stage.session !== requiredRunRows[index]![1] || stage.reason !== requiredRunRows[index]![2]))
      invalid('result-field', '/stages');
    const [first, second] = document.sessions;
    if (!first?.process.clientSessionId || !second?.process.clientSessionId ||
        first.process.clientSessionId === second.process.clientSessionId || first.challengeSha256 === second.challengeSha256)
      invalid('result-field', '/sessions');
    if (document.content && (document.sessions.some(session => session.stagedConfigurationDigest !== document.content!.stagedConfigurationDigest) ||
        document.stages.filter(stage => stage.id === 'cell-staging' || stage.id === 'configuration-unchanged')
          .some(stage => stage.evidence.kind !== 'digest' || stage.evidence.sha256 !== document.content!.stagedConfigurationDigest)))
      invalid('result-field', '/content/stagedConfigurationDigest');
    if (document.proofScope !== 'bundled-mechanism' && document.content?.archiveSha256 === null)
      invalid('result-field', '/content/archiveSha256');
  }
  return diagnostics;
}

function validateDocument(value: unknown, kind: NativeDocumentKind, schemaId: string,
  check: ValidateFunction, semantics: (document: never) => Diagnostic[]): ValidationResult {
  const limits = documentLimits[kind];
  try {
    const safe = cloneJsonValueStructureV1(value, 'native verification document', limits.depth);
    assertStrictJsonValueV1(safe, 'native verification document');
    if (new TextEncoder().encode(canonicalJson(safe)).length > limits.bytes) throw new TypeError('document byte limit');
    const found = safe && typeof safe === 'object' && !Array.isArray(safe)
      ? (safe as { schema?: unknown }).schema : undefined;
    if (typeof found === 'string' && found !== schemaId) return { valid: false, schema: found,
      diagnostics: [diagnostic('SCHEMA_UNSUPPORTED', 'schema-id', '/schema', found)] };
    if (!check(safe)) return { valid: false, ...(typeof found === 'string' ? { schema: found } : {}),
      diagnostics: (check.errors ?? []).slice(0, 32)
        .map(error => diagnostic('INPUT_INVALID', fieldReason(kind, error), schemaErrorPath(error))) };
    const diagnostics = semantics(safe as never);
    return { valid: diagnostics.length === 0, schema: typeof found === 'string' ? found : schemaId, diagnostics };
  } catch {
    return { valid: false, diagnostics: [diagnostic('INPUT_INVALID', 'strict-json')] };
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const checkRequestSchema = ajv.compile(requestSchema);
const checkResultSchema = ajv.compile(resultSchema);
const checkBundleSchema = ajv.compile(bundleSchema);

export function validateNativeVerificationRequest(value: unknown): ValidationResult {
  return validateDocument(value, 'request', REQUEST_SCHEMA_ID, checkRequestSchema, () => []);
}
export function validateNativeVerificationResult(value: unknown): ValidationResult {
  return validateDocument(value, 'result', RESULT_SCHEMA_ID, checkResultSchema,
    document => resultSemantics(document as unknown as NativeVerificationResult));
}
export function validateNativeVerificationBundle(value: unknown): ValidationResult {
  return validateDocument(value, 'bundle', BUNDLE_SCHEMA_ID, checkBundleSchema,
    document => bundleSemantics(document as unknown as NativeVerificationBundle));
}
