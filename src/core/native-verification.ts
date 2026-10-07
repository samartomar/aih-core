import { release } from 'node:os';
import { mkdirSync, lstatSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname } from 'node:path';
import type { Diagnostic } from './types.js';
import { validateNativeVerificationRequest } from './native-contracts.js';
import type { NativeVerificationRequest, NativeVerificationResult } from './native-contracts.js';
import { installedDistribution } from './internal/installed-distribution.js';
import { canonicalJson } from './internal/canonical.js';
import { sha256 } from './internal/host-files.js';
import { NativeStop, nativeSnapshot, nativeDiagnostic, validateNativeControls } from './internal/native-input.js';
import { emptyNativeResult, invalidNativeResult, appendNativeStage, finishNativeResult, addNativeDiagnostic, type NativeStage } from './internal/native-result.js';
import { acquireNativeSupplied, captureNativeInstalledMembers, captureNativeHelpers, revalidateNativeHelpers, nativeReadPinned, validateMaterialTrees, type NativeMaterial } from './internal/native-material.js';
import { createNativeCell, stageNativeCell, checkNativePersistence, nativeStatePlan, removeNativeCell, type NativeCell } from './internal/native-cell.js';
import { evaluateNativeSession, type NativeRuntime, type NativeSessionHandle, type NativeSessionObservations } from './internal/native-session.js';
import { nativeRuntime } from './internal/native-runtime.js';

export interface NativeVerificationControls {
  signal?: AbortSignal;
  budgetMs?: number;
  sandboxRoot?: string;
  admission?: 'admitted' | 'candidate-smoke';
  testIdentity?: { adapterId: 'claude-oauth-otel.v1'; provisionedRoot: string; manifestSha256: string;
    expected: { accountUuid: string; organizationId: string } };
  configurationSources?: Record<string, { archivePath: string; archiveSha256: string; archiveBytes: number;
    manifestPath: string; manifestSha256: string; manifestBytes: number }>;
}
export function invalidNativeVerificationResult(diagnostics: Diagnostic[], request?: unknown, controls?: unknown): NativeVerificationResult {
  return invalidNativeResult(diagnostics, request, controls);
}
const safeHostValue = (value: string): string => /^[a-zA-Z0-9 ._()+:#/-]{1,128}$/.test(value) ? value : 'unavailable';
const blankObservations = (): NativeSessionObservations => ({ sessionId: null, resumed: false, loading: 'unobservable', restrictions: 'unobservable', authentication: 'missing',
  discovery: { complete: false, clientTools: [], serverList: false }, instructions: { nativeSha256: [], attestations: [], rejected: false, alternateRead: false },
  query: { correlated: false, challengeMatched: false, resultSha256: null, answerSha256: null }, isolation: 'unobservable', serverPeerBound: false,
  counts: { observedBytes: 0, telemetryEvents: 0, rpcMessages: 0 }, completed: [] });
async function observeSession(handle: NativeSessionHandle, deadline: number, signal?: AbortSignal): Promise<NativeSessionObservations> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([handle.observations, new Promise<NativeSessionObservations>((_, reject) => {
      abort = () => reject(new NativeStop('cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(new NativeStop('budget-exhausted')), Math.max(1, deadline - performance.now()));
      if (signal?.aborted) abort();
    })]);
  } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}
function environment(cell: NativeCell, executable: string, runtimes: string[]): Record<string, string> {
  const env: Record<string, string> = { PATH: [...new Set([executable, ...runtimes].map(dirname))].join(process.platform === 'win32' ? ';' : ':'), HOME: cell.home, USERPROFILE: cell.home,
    APPDATA: `${cell.home}/appdata`, LOCALAPPDATA: `${cell.home}/localappdata`, XDG_CONFIG_HOME: `${cell.home}/xdg-config`, XDG_DATA_HOME: `${cell.home}/xdg-data`,
    XDG_CACHE_HOME: `${cell.home}/xdg-cache`, XDG_STATE_HOME: `${cell.home}/xdg-state`, TEMP: cell.scratch, TMP: cell.scratch, TMPDIR: cell.scratch, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

/** Explicit native verification. Imports and input rejection perform no filesystem/process work. */
export async function verifyNativeClient(request: unknown, controls?: NativeVerificationControls): Promise<NativeVerificationResult> {
  let selected: NativeVerificationRequest; let host: NativeVerificationControls;
  try {
    const snapshot = nativeSnapshot(request);
    const validation = validateNativeVerificationRequest(snapshot);
    if (!validation.valid) return invalidNativeResult(validation.diagnostics.map(d => nativeDiagnostic(d.code === 'SCHEMA_UNSUPPORTED' ? 'schema-id' : d.reason === 'strict-json' ? 'strict-json' :
      snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && !['claude', 'codex', 'cursor', 'gemini', 'copilot', 'windsurf', 'opencode', 'kimi', 'kiro', 'antigravity', 'zed'].includes((snapshot as Record<string, unknown>).client as string) ? 'client-id' : 'request-field', d.code)), request, controls);
    selected = snapshot as NativeVerificationRequest;
    host = validateNativeControls(controls, selected as unknown as Record<string, unknown>);
  } catch (error) { return invalidNativeResult([nativeDiagnostic(error instanceof NativeStop ? error.reason : 'strict-json')], request, controls); }
  const result = emptyNativeResult(selected, host); result.status = 'incomplete';
  const started = performance.now(); const deadline = started + result.limits.budgetMs;
  const check = () => { if (host.signal?.aborted) throw new NativeStop('cancelled'); if (performance.now() >= deadline) throw new NativeStop('budget-exhausted'); };
  const row = (id: string, outcome: NativeStage['outcome'], reason: string, session: 1 | 2 | null = null, evidence: NativeStage['evidence'] = { kind: 'none' }) => appendNativeStage(result, { id, outcome, reason, session, evidence });
  let activeStage = 'fixture-integrity'; let cell: NativeCell | undefined; let handle: NativeSessionHandle | undefined;
  let cleanupDeadline: number | undefined; let processesConfirmed = true; let helperProcessesCreated = false; let stopped: string | undefined;
  const cleanupEnd = () => cleanupDeadline ??= performance.now() + 10000;
  const cleanupCheck = () => { if (performance.now() >= cleanupEnd()) throw new NativeStop('cleanup-unresolved'); };
  const cleanupHandle = async (current: NativeSessionHandle, duringOrdinary = false): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cleanupStartedAt: number | undefined;
    const bindCleanupStart = () => {
      if (cleanupStartedAt !== undefined) cleanupDeadline = Math.min(cleanupDeadline ?? Infinity, cleanupStartedAt + 10000);
    };
    try {
      cleanupStartedAt = current.cleanupStartedAt;
      const ordinary = duringOrdinary && !host.signal?.aborted && performance.now() < deadline;
      if (!ordinary) bindCleanupStart();
      // Session-1 cleanup remains ordinary work; the one extra allowance starts at stop.
      const end = ordinary ? deadline : cleanupEnd();
      const cleanup = await Promise.race([current.cleanup({ deadline: end, graceMs: Math.min(1000, Math.max(0, end - performance.now())) }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new NativeStop('termination-unresolved')), Math.max(1, end - performance.now())); })]);
      if (!cleanup.confirmed || cleanup.survivors.length) {
        bindCleanupStart();
        processesConfirmed = false;
        result.survivingProcesses = [...result.survivingProcesses, ...cleanup.survivors].slice(0, 32);
        if (cleanup.survivors.length > 32) result.limits.evidenceTruncated = true;
        return false;
      }
      return true;
    } catch {
      bindCleanupStart();
      processesConfirmed = false;
      if (!result.survivingProcesses.some(value => value.pid === current.pid) && result.survivingProcesses.length < 32) result.survivingProcesses.push({ pid: current.pid, role: 'client' });
      return false;
    } finally { if (timer) clearTimeout(timer); }
  };
  try {
    check();
    try { const identity = installedDistribution(); result.package = { name: '@aihq/core', version: identity.version }; }
    catch { result.package.version = 'unavailable'; throw new NativeStop('configuration-unavailable'); }
    result.platform = { os: process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin' ? process.platform : 'unsupported',
      arch: safeHostValue(process.arch), osRelease: safeHostValue(release()), execution: process.platform === 'linux' && /microsoft/i.test(release()) ? 'wsl2' : 'native' };
    // This single path is fixed in the artifact. No caller module, callback or executable enters it.
    const helpers = captureNativeHelpers(check);
    const installedRuntime = await import('../harness/native/runtime.mjs');
    const runtime = nativeRuntime(installedRuntime, (receipt, startedAt) => {
      helperProcessesCreated = true;
      processesConfirmed = processesConfirmed && receipt.confirmed;
      const survivors = [...result.survivingProcesses, ...receipt.survivors];
      result.survivingProcesses = survivors.filter((value, index) => survivors.findIndex(other => other.pid === value.pid && other.role === value.role) === index).slice(0, 32);
      if (survivors.length > 32) result.limits.evidenceTruncated = true;
      if (startedAt !== undefined && !receipt.confirmed) cleanupDeadline = Math.min(cleanupDeadline ?? Infinity, startedAt + 10000);
    });
    check();
    const clientDefinitions = runtime.nativeDefinitions.filter(definition => definition.client === selected.client);
    if (!clientDefinitions.length) throw new NativeStop('client-unsupported', 'unsupported');
    const definition = clientDefinitions.find(definition => definition.platform.os === result.platform.os && definition.platform.arch === result.platform.arch &&
      definition.platform.execution === result.platform.execution && definition.platform.osRelease === result.platform.osRelease);
    if (!definition) throw new NativeStop('platform-unsupported', 'unsupported');
    if (host.admission !== 'candidate-smoke' && definition.state !== 'admitted') throw new NativeStop('cell-not-admitted', 'unsupported');
    if (definition.state === 'admitted' && !definition.evidenceSha256) throw new NativeStop('cell-not-admitted', 'unsupported');
    if (runtime.nativeManagedRestriction?.(definition)) throw new NativeStop('managed-restriction', 'restricted');
    const bundled = await runtime.nativeBundledFixture(definition, { check });
    let material: NativeMaterial;
    if (selected.configuration?.kind === 'supplied') material = acquireNativeSupplied(selected, host, check);
    else material = bundled;
    check(); validateMaterialTrees(material);
    if (material.adapterId !== definition.id && material.adapterId !== definition.parserId) throw new NativeStop('configuration-channel-unsupported', 'unsupported');
    const guardrailBytes = captureNativeInstalledMembers([...definition.runtimeMembers, ...definition.guardrails.map(file => file.member)], check, bundled.bytes);
    result.adapter = { id: definition.id, sha256: sha256(canonicalJson({ definition, helpersSha256: helpers.sha256 })) };
    result.proofScope = material.scope;
    row('fixture-integrity', 'passed', 'observed', null, { kind: 'digest', sha256: material.manifestSha256 });
    activeStage = 'host-presence';
    const pin = await runtime.resolveNativeClient(definition, { deadline, signal: host.signal, acquireCell: async () => {
      cell ??= createNativeCell(host.sandboxRoot, check, created => { cell = created; });
      if (!await runtime.protectNativeCell(cell, { deadline, signal: host.signal })) throw new NativeStop('staging-unavailable');
      for (const directory of [cell.home, cell.project, cell.scratch, cell.credentials, cell.observations]) {
        check(); try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new NativeStop('staging-unavailable');
      }
      return cell;
    } });
    result.limits.observedBytes += pin.probeBytes ?? 0;
    if ('outcome' in pin) {
      if (pin.cleanup) { helperProcessesCreated = true; processesConfirmed = processesConfirmed && pin.cleanup.confirmed; result.survivingProcesses = [...result.survivingProcesses, ...pin.cleanup.survivors].slice(0, 32); }
      if (pin.cleanupStartedAt !== undefined) cleanupDeadline = Math.min(cleanupDeadline ?? Infinity, pin.cleanupStartedAt + 10000);
      throw new NativeStop(pin.reason, pin.outcome);
    }
    helperProcessesCreated = pin.probeCreated === true;
    check();
    if (!runtime.nativeServerEvidenceAvailable(material)) throw new NativeStop('server-evidence-unavailable');
    if (material.scope === 'production-configuration' && material.server.evidenceAdapterId === 'aihq.fixture.v1') throw new NativeStop('server-evidence-unavailable');
    const executablePins = [{ path: pin.executable, sha256: pin.sha256 }, ...pin.runtime];
    for (const member of executablePins) if (sha256(nativeReadPinned(member.path, 256 * 1024 * 1024, check)) !== member.sha256) throw new NativeStop('executable-changed');
    result.adapter.sha256 = sha256(canonicalJson({ definition, helpersSha256: helpers.sha256, executableSha256: pin.sha256, runtimes: pin.runtime.map(value => value.sha256) }));
    result.client.observedVersion = safeHostValue(pin.observedVersion);
    if (!definition.clientVersions.includes(pin.observedVersion)) throw new NativeStop('version-unsupported', 'unsupported');
    const capabilities = await runtime.nativeCapabilities(definition, { deadline, signal: host.signal });
    check();
    if (!capabilities.credentialChannel) throw new NativeStop('authentication-channel-unsupported', 'unsupported');
    if (!capabilities.lifecycle) throw new NativeStop(capabilities.reason ?? 'termination-unresolved');
    if (!capabilities.peerIdentity) throw new NativeStop('server-evidence-unavailable');
    row('host-presence', 'passed', 'observed');
    activeStage = 'identity-binding';
    if (!host.testIdentity) throw new NativeStop('authentication-unavailable');
    const identity = await runtime.captureNativeIdentity(host.testIdentity, definition, { deadline, signal: host.signal }); check();
    if ('outcome' in identity) throw new NativeStop(identity.reason, identity.outcome);
    if (identity.expected.accountUuid !== host.testIdentity.expected.accountUuid || identity.expected.organizationId !== host.testIdentity.expected.organizationId ||
      !await runtime.revalidateNativeIdentity(identity, { check })) throw new NativeStop('identity-binding-invalid');
    row('identity-binding', 'passed', 'observed', null, { kind: 'match', matched: true });
    activeStage = 'cell-staging'; cell ??= createNativeCell(host.sandboxRoot, check, created => { cell = created; });
    if (!await runtime.protectNativeCell(cell, { deadline, signal: host.signal })) throw new NativeStop('staging-unavailable');
    check();
    if (!await runtime.revalidateNativeIdentity(identity, { check })) throw new NativeStop('identity-binding-invalid');
    // Fixed client-owned state, validated before any write; inspection stays in the installed adapter.
    const inspector = runtime.inspectNativeState?.bind(runtime);
    const statePlan = nativeStatePlan(runtime.nativeStatePaths(definition), [...material.outputTree, ...definition.guardrails],
      definition.credentialDestination.path, inspector ? (root, path, bytes, diagnose) => inspector(definition, { root, path, bytes, diagnose }) : undefined,
      runtime.classifyNativePersistence ? fact => runtime.classifyNativePersistence!(definition, fact) : undefined);
    const persistence = (stage: 'before-session-2' | 'after-session-2') => checkNativePersistence(cell!, statePlan, check,
      diagnostics => runtime.publishNativePersistence?.({ cell: cell!, stage, diagnostics }));
    const stagedConfigurationDigest = stageNativeCell(cell, material, definition.guardrails, guardrailBytes, definition.guardrailsSha256,
      { destination: definition.credentialDestination.path, bytes: identity.credential }, check);
    result.content = { bundleId: material.id, manifestSha256: material.manifestSha256, archiveSha256: material.archiveSha256,
      outputTreeSha256: material.outputTreeSha256, guardrailsSha256: definition.guardrailsSha256, stagedConfigurationDigest };
    row('cell-staging', 'passed', 'observed', null, { kind: 'digest', sha256: stagedConfigurationDigest });
    for (const index of [1, 2] as const) {
      check();
      if (index === 2) {
        activeStage = 'configuration-unchanged';
        if (!persistence('before-session-2')) throw new NativeStop('configuration-changed', 'failed');
        row('configuration-unchanged', 'passed', 'before-session-2', 2, { kind: 'digest', sha256: stagedConfigurationDigest });
      }
      activeStage = 'session-start';
      if (!revalidateNativeHelpers(helpers, check) || !await runtime.revalidateNativeClient(pin, { check }) ||
        executablePins.some(member => sha256(nativeReadPinned(member.path, 256 * 1024 * 1024, check)) !== member.sha256)) throw new NativeStop('executable-changed');
      const challenge = randomBytes(32).toString('hex');
      const queryArguments = material.server.challenge.mode === 'argument' ? { ...material.server.queryArguments, [material.server.challenge.field]: challenge } : material.server.queryArguments;
      const sessionDeadline = index === 1 ? performance.now() + Math.max(0, deadline - performance.now()) / 2 : deadline;
      const launched = await runtime.startNativeSession({ definition, pin, identity, cell, material, index, challenge, deadline: sessionDeadline,
        signal: host.signal, environment: environment(cell, pin.executable, pin.runtime.map(value => value.path)),
        prompt: `Perform explicit native verification. Attest the initially loaded instructions with the session challenge ${challenge}. Discover the configured server tools and call ${material.server.queryTool} with ${canonicalJson(queryArguments)}. Return the exact server answer.` });
      if ('outcome' in launched && !launched.partial) {
        // A platform context can own helper/IPC resources before any client PID
        // exists. Keep its cleanup receipt so an unresolved helper retains the cell.
        if (launched.cleanup) {
          helperProcessesCreated = true;
          processesConfirmed = processesConfirmed && launched.cleanup.confirmed;
          result.survivingProcesses = launched.cleanup.survivors.slice(0, 32);
        }
        if (launched.cleanupStartedAt !== undefined) cleanupDeadline ??= launched.cleanupStartedAt + 10000;
        throw new NativeStop(launched.reason, launched.outcome);
      }
      // A helper must return ownership of every actual spawn, including initialization failures.
      handle = 'outcome' in launched ? launched.partial! : launched;
      if (!Number.isSafeInteger(handle.pid) || handle.pid <= 0) throw new NativeStop('native-internal');
      const session: NativeVerificationResult['sessions'][number] = { index, process: { pid: handle.pid, clientSessionId: null }, launchArgvDigest: sha256(canonicalJson(handle.argv)),
        stagedConfigurationDigest, challengeSha256: sha256(handle.challenge && /^[a-f0-9]{64}$/.test(handle.challenge) ? handle.challenge : challenge), stages: [] };
      result.sessions.push(session); row('session-start', 'passed', 'observed', index);
      activeStage = 'stop';
      let observations = blankObservations(); let sessionStop: string | undefined = 'outcome' in launched ? launched.reason : undefined;
      let finalizedObservations = false;
      try { check(); observations = await observeSession(handle, sessionDeadline, host.signal); finalizedObservations = true; check(); }
      catch (error) {
        sessionStop = host.signal?.aborted ? 'cancelled' : performance.now() >= deadline ? 'budget-exhausted' : error instanceof NativeStop ? error.reason : 'native-internal';
        if (!finalizedObservations && handle.snapshot) {
          try { observations = handle.snapshot(); }
          catch { /* An unavailable snapshot cannot manufacture proof; retain the empty observation. */ }
        }
      }
      // Session-local failures stop another session; completed proof survives their interruption.
      sessionStop ??= observations.failure?.reason;
      if (!Object.values(observations.counts).every(value => Number.isSafeInteger(value) && value >= 0)) {
        sessionStop = 'native-internal'; observations.counts = { observedBytes: 0, telemetryEvents: 0, rpcMessages: 0 };
      } else if (observations.counts.observedBytes > 8 * 1024 * 1024 || observations.counts.telemetryEvents > 512 || observations.counts.rpcMessages > 512) sessionStop = 'limit-exceeded';
      result.limits.observedBytes += observations.counts.observedBytes;
      result.limits.telemetryEvents += observations.counts.telemetryEvents;
      result.limits.rpcMessages += observations.counts.rpcMessages;
      evaluateNativeSession(result, session, observations, material, index === 2 ? result.sessions[0]!.process.clientSessionId : null, sessionStop);
      const sessionDecisive = session.stages.some(stage => stage.outcome !== 'passed' && !(stage.id === 'isolation' && stage.outcome === 'unavailable'));
      const confirmed = await cleanupHandle(handle, index === 1 && !sessionStop && !sessionDecisive); handle = undefined;
      const cleanupStage: NativeStage = { id: 'cleanup', session: index, outcome: confirmed ? 'passed' : 'unavailable', reason: confirmed ? 'observed' : 'termination-unresolved', evidence: { kind: 'none' } };
      session.stages.push(cleanupStage); addNativeDiagnostic(result, cleanupStage);
      if (result.sessions.every(value => value.stages.some(stage => stage.id === 'isolation' && stage.outcome === 'passed'))) {
        result.security = { sandbox: { level: 'observed-os-boundary', mechanism: definition.isolation.observerId, reason: 'observed' }, hostSecretIsolation: { outcome: 'passed', reason: 'observed' } };
      } else {
        result.security = { sandbox: { level: 'hygiene-only', mechanism: definition.isolation.mechanism, reason: 'isolation-unobserved' }, hostSecretIsolation: { outcome: 'unavailable', reason: 'isolation-unobserved' } };
      }
      if (sessionStop) {
        stopped = sessionStop;
        // Cleanup has ended the active session. Record an otherwise unrepresented stop
        // without duplicating managed, identity, parser or collector canonical rows.
        if (!session.stages.some(stage => stage.reason === sessionStop)) row('stop', 'unavailable', sessionStop);
        break;
      }
      if (!confirmed) break;
      if (index === 2) {
        activeStage = 'configuration-unchanged';
        if (!persistence('after-session-2')) throw new NativeStop('configuration-changed', 'failed');
        row('configuration-unchanged', 'passed', 'after-session-2', 2, { kind: 'digest', sha256: stagedConfigurationDigest });
      }
      if (sessionDecisive) break;
    }
  } catch (error) {
    const failure = error instanceof NativeStop ? error : new NativeStop('native-internal'); stopped = failure.reason;
    if (failure.reason === 'cancelled' || failure.reason === 'budget-exhausted') row('stop', 'unavailable', failure.reason);
    else row(activeStage, failure.outcome, failure.reason, activeStage === 'session-start' || activeStage === 'configuration-unchanged' ? result.sessions.length >= 1 ? 2 : 1 : null);
  } finally {
    if (handle) await cleanupHandle(handle);
    const removed = cell ? processesConfirmed && removeNativeCell(cell, cleanupCheck) : false;
    result.cleanup = { processes: result.sessions.length || handle || helperProcessesCreated ? processesConfirmed ? 'confirmed' : 'unresolved' : 'not-created',
      files: cell ? removed ? 'removed' : 'retained' : 'not-created', retainedCell: cell && !removed ? basename(cell.path) : null };
    row('cleanup', !processesConfirmed || cell && !removed ? 'unavailable' : 'passed', !processesConfirmed ? 'termination-unresolved' : cell && !removed ? 'cleanup-unresolved' : 'observed');
  }
  if (host.signal?.aborted && stopped !== 'cancelled') row('stop', 'unavailable', 'cancelled');
  return finishNativeResult(result, started, host.signal?.aborted === true || stopped === 'cancelled');
}
