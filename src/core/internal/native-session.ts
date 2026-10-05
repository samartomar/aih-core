import type { NativeVerificationResult, NativeVerificationBundle } from '../native-contracts.js';
import type { NativeTreeFile, NativeMaterial } from './native-material.js';
import type { NativeCell } from './native-cell.js';
import type { NativeVerificationControls } from '../native-verification.js';
import { addNativeDiagnostic, type NativeStage } from './native-result.js';
import { sha256 } from './host-files.js';
import { nativeReasons } from './native-input.js';

/** This interface is implemented only by the fixed installed Harness runtime. */
export interface NativeDefinition {
  id: string; client: string; state: 'candidate' | 'admitted';
  platform: { os: 'win32' | 'linux' | 'darwin'; arch: 'x64' | 'arm64'; execution: 'native' | 'wsl2'; osRelease: string };
  clientVersions: string[]; executableNames: string[]; runtimeMembers: NativeTreeFile['member'][];
  versionArgv: string[]; sessionArgv: string[]; parserId: string; identityAdapterId: string;
  credentialDestination: { root: 'home'; path: string }; guardrails: NativeTreeFile[]; guardrailsSha256: string;
  lifecycleId: string; isolation: { mechanism: 'none' | 'client-native'; observerId: string | null; documentation: string[] };
  evidenceSha256: string | null;
}
export interface NativeClientPin {
  executable: string; observedVersion: string; argv: string[]; sha256: string;
  runtime: { path: string; sha256: string }[];
  probeCreated?: boolean;
  probeBytes?: number;
}
export interface NativeIdentityCapture { credential: Buffer; expected: { accountUuid: string; organizationId: string }; sourceIdentity: unknown }
export interface NativeSessionObservations {
  sessionId: string | null; resumed: boolean;
  loading: 'observed' | 'bare' | 'unobservable' | 'not-loaded';
  restrictions: 'observed' | 'managed' | 'unobservable';
  authentication: 'matched' | 'missing' | 'wrong-session' | 'conflict';
  discovery: { complete: boolean; clientTools: string[]; serverList: boolean };
  instructions: { nativeSha256: string[]; attestations: { markerSha256: string; challengeMatched: boolean; clientReceipt: boolean }[];
    rejected: boolean; alternateRead: boolean };
  query: { correlated: boolean; challengeMatched: boolean; resultSha256: string | null; answerSha256: string | null; rejectedCalls?: boolean };
  isolation: 'observed' | 'unobservable' | 'violated';
  serverPeerBound: boolean;
  /** Completed proof rows in a partial snapshot; omitted for a finalized full observation. */
  completed?: readonly NativeSessionProofRow[];
  failure?: { reason: string; outcome: NativeStage['outcome'] };
  counts: { observedBytes: number; telemetryEvents: number; rpcMessages: number };
}
export interface NativeSessionCleanup {
  confirmed: boolean; survivors: NativeVerificationResult['survivingProcesses'];
  reason?: 'termination-unresolved' | 'cleanup-unresolved';
}
export interface NativeSessionHandle {
  pid: number; argv: string[];
  challenge?: string;
  cleanupStartedAt?: number;
  observations: Promise<NativeSessionObservations>;
  /** Bounded already-received evidence only; never resumes collection or finalizes authentication. */
  snapshot?(): NativeSessionObservations;
  cleanup(input: { deadline: number; graceMs: number }): Promise<NativeSessionCleanup>;
}
export type NativeHelperFailure = { outcome: 'unsupported' | 'unavailable' | 'failed' | 'restricted'; reason: string;
  cleanup?: NativeSessionCleanup; cleanupStartedAt?: number; probeBytes?: number };
export interface NativeRuntime {
  nativeDefinitions: readonly NativeDefinition[];
  nativeBundledFixture(definition: NativeDefinition, input: { check: () => void }): Promise<NativeMaterial> | NativeMaterial;
  nativeCapabilities(definition: NativeDefinition): { lifecycle: boolean; peerIdentity: boolean; credentialChannel: boolean; reason?: string };
  nativeServerEvidenceAvailable(material: NativeMaterial): boolean;
  nativeManagedRestriction?(definition: NativeDefinition): boolean;
  resolveNativeClient(definition: NativeDefinition, input: { deadline: number; signal?: AbortSignal; acquireCell?: () => Promise<NativeCell> }): Promise<NativeClientPin | NativeHelperFailure>;
  revalidateNativeClient(pin: NativeClientPin, input: { check: () => void }): boolean | Promise<boolean>;
  captureNativeIdentity(binding: NonNullable<NativeVerificationControls['testIdentity']>, definition: NativeDefinition, input: { deadline: number; signal?: AbortSignal }): Promise<NativeIdentityCapture | NativeHelperFailure>;
  revalidateNativeIdentity(identity: NativeIdentityCapture, input: { check: () => void }): boolean | Promise<boolean>;
  protectNativeCell(cell: NativeCell, input: { deadline: number; signal?: AbortSignal }): Promise<boolean>;
  startNativeSession(input: { definition: NativeDefinition; pin: NativeClientPin; identity: NativeIdentityCapture; cell: NativeCell; material: NativeMaterial;
    index: 1 | 2; challenge: string; deadline: number; signal?: AbortSignal; environment: Record<string, string>; prompt: string }): Promise<NativeSessionHandle | (NativeHelperFailure & { partial?: NativeSessionHandle })>;
  nativeStatePaths(definition: NativeDefinition): { home: string[]; project: string[] };
}

export const nativeSessionRows = ['session-freshness', 'loading-mode', 'tool-restrictions', 'provider-authentication', 'tool-discovery', 'instruction-loading', 'read-only-query', 'isolation', 'cleanup'] as const;
export type NativeSessionProofRow = Exclude<typeof nativeSessionRows[number], 'cleanup'>;
export function evaluateNativeSession(result: NativeVerificationResult, session: NativeVerificationResult['sessions'][number], observations: NativeSessionObservations,
  material: NativeMaterial, previousSessionId: string | null, stoppedReason?: string): void {
  let stop: NativeStage | undefined;
  const row = (id: string, outcome: NativeStage['outcome'], reason: string, evidence: NativeStage['evidence'] = { kind: 'none' }) => {
    if (!nativeReasons.has(reason)) { reason = 'native-internal'; outcome = 'unavailable'; }
    const stage: NativeStage = { id, session: session.index, outcome, reason, evidence };
    session.stages.push(stage); addNativeDiagnostic(result, stage);
    if (outcome !== 'passed' && id !== 'isolation' && stop?.outcome !== 'failed') stop = stage;
  };
  const skip = (id: string) => session.stages.push({ id, session: session.index, outcome: 'unavailable',
    reason: stop?.outcome === 'failed' ? 'not-run-after-failure' : stop?.outcome === 'restricted' ? 'not-run-after-restriction' : 'not-run-after-unavailable', evidence: { kind: 'none' } });
  const interruption = stoppedReason ?? observations.failure?.reason;
  // The canonical row order does not imply observations completed in that order. Preserve every
  // completed proof when interruption leaves another row unfinished, including known contradictions.
  const completed = new Set<string>(observations.completed ?? nativeSessionRows.slice(0, -1));
  for (const id of nativeSessionRows.slice(0, -1)) {
    if (interruption && !completed.has(id)) {
      if (stop) skip(id);
      else row(id, 'unavailable', interruption);
      continue;
    }
    if (stop && !interruption) { skip(id); continue; }
    // A positive native managed-policy observation precedes omitted loading/identity evidence.
    if (observations.restrictions === 'managed' && !interruption) {
      if (id === 'tool-restrictions') row(id, 'restricted', 'managed-restriction');
      else if (id === 'session-freshness' && observations.sessionId && !observations.resumed && observations.sessionId !== previousSessionId && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(observations.sessionId)) {
        session.process.clientSessionId = observations.sessionId; row(id, 'passed', 'observed', { kind: 'match', matched: true });
      } else session.stages.push({ id, session: session.index, outcome: 'unavailable', reason: 'not-run-after-restriction', evidence: { kind: 'none' } });
      continue;
    }
    switch (id) {
      case 'session-freshness':
        if (!observations.sessionId || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(observations.sessionId)) row(id, 'unavailable', 'session-identity-unobservable');
        else if (observations.resumed || observations.sessionId === previousSessionId) row(id, 'failed', 'session-not-fresh');
        else { session.process.clientSessionId = observations.sessionId; row(id, 'passed', 'observed', { kind: 'match', matched: true }); }
        break;
      case 'loading-mode':
        if (observations.loading === 'unobservable') row(id, 'unavailable', 'loading-mode-unobservable');
        else if (observations.loading !== 'observed') row(id, 'failed', 'configuration-not-loaded');
        else row(id, 'passed', 'observed', { kind: 'match', matched: true });
        break;
      case 'tool-restrictions':
        if (observations.restrictions === 'managed') row(id, 'restricted', 'managed-restriction');
        else if (observations.restrictions !== 'observed') row(id, 'unavailable', 'restriction-unobservable');
        else row(id, 'passed', 'observed', { kind: 'match', matched: true });
        break;
      case 'provider-authentication':
        row(id, observations.authentication === 'matched' ? 'passed' : 'unavailable', observations.authentication === 'matched' ? 'observed' :
          observations.authentication === 'conflict' ? 'identity-conflict' : observations.authentication === 'wrong-session' ? 'identity-session-mismatch' : 'authentication-unavailable',
          { kind: 'match', matched: observations.authentication === 'matched' });
        break;
      case 'tool-discovery':
        if (!observations.serverPeerBound || !observations.discovery.serverList) row(id, 'unavailable', 'server-evidence-unavailable');
        else if (!observations.discovery.complete) row(id, 'unavailable', 'server-evidence-unavailable');
        else if (material.server.toolNames.some(tool => !observations.discovery.clientTools.includes(tool))) row(id, 'failed', 'tools-not-discovered');
        else row(id, 'passed', 'observed', { kind: 'counts', count: material.server.toolNames.length });
        break;
      case 'instruction-loading': {
        if (observations.instructions.rejected) { row(id, 'failed', 'instructions-not-loaded'); break; }
        if (observations.instructions.alternateRead) { row(id, 'unavailable', 'instruction-source-ambiguous'); break; }
        let reason: string | undefined;
        if (observations.instructions.attestations.some(attestation => !material.instructions.some(instruction => instruction.evidence === 'marker' && instruction.markerSha256 === attestation.markerSha256)) ||
          observations.instructions.attestations.some(attestation => !attestation.challengeMatched || !attestation.clientReceipt) ||
          new Set(observations.instructions.attestations.map(attestation => attestation.markerSha256)).size !== observations.instructions.attestations.length) reason = 'instruction-attestation-mismatch';
        for (const instruction of material.instructions) {
          if (instruction.evidence === 'native') { if (!observations.instructions.nativeSha256.includes(instruction.sha256)) reason = 'instruction-attestation-unobservable'; }
          else {
            const attestation = observations.instructions.attestations.find(value => value.markerSha256 === instruction.markerSha256);
            if (!attestation) reason = observations.instructions.attestations.length ? 'instruction-attestation-mismatch' : 'instruction-attestation-unobservable';
            else if (!attestation.challengeMatched || !attestation.clientReceipt) reason = 'instruction-attestation-mismatch';
          }
        }
        row(id, reason ? 'unavailable' : 'passed', reason ?? 'observed', { kind: 'match', matched: !reason }); break;
      }
      case 'read-only-query':
        if (!observations.serverPeerBound) row(id, 'unavailable', 'server-evidence-unavailable');
        else if (observations.query.correlated && !observations.query.challengeMatched) row(id, 'unavailable', 'query-challenge-mismatch');
        else if (observations.query.correlated && (observations.query.resultSha256 !== material.server.expectedResultSha256 || observations.query.answerSha256 !== sha256(material.server.expectedAnswer))) row(id, 'failed', 'query-answer-mismatch');
        else if (observations.query.rejectedCalls) row(id, 'unavailable', 'restriction-unobservable');
        else if (!observations.query.correlated) row(id, 'unavailable', 'server-evidence-unavailable');
        else row(id, 'passed', 'observed', { kind: 'digest', sha256: observations.query.answerSha256! });
        break;
      case 'isolation':
        row(id, observations.isolation === 'observed' ? 'passed' : observations.isolation === 'violated' ? 'failed' : 'unavailable',
          observations.isolation === 'observed' ? 'observed' : observations.isolation === 'violated' ? 'isolation-violated' : 'isolation-unobserved', { kind: 'match', matched: observations.isolation === 'observed' });
        break;
    }
  }
}
