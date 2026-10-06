import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { canonicalJson } from './internal/canonical.js';
import { sha256, userHomeRoot } from './internal/host-files.js';
import { cloneJsonValueStructureV1, deepFreezeStrictJsonV1 } from './internal/strict-json.js';
import { dataObject, validateControls } from './recipe-engine.js';
import { selectMacosRepairDefinition } from '../harness/macos-session-definitions.mjs';
import { observeMacosSessionPlatform } from '../harness/macos-session-platform.mjs';
import { prepareTrust, applyTrust, disposeTrustHandle } from './trust.js';
import { readMacosCustody, readPendingMacos, macosCustodyParticipant, sessionFileLocation, sessionFilesMatch,
  sessionTrustMatches, sessionConfiguration, sessionRecoveryFiles } from './internal/macos-session-custody.js';
import { distributionManifest, installedDistribution } from './internal/installed-distribution.js';
import { readRegularFile } from './internal/fsxn.js';
import { writeHistory } from './internal/state.js';
import { apply as applyPolicy } from './recipe-engine.js';
import { validateMacosRepairRequest, validateMacosSessionVerificationRequest,
  type MacosRepairRequest, type MacosSessionReview, type MacosSessionRun,
  type MacosSessionCustodyEntry,
  type MacosSessionVerificationRequest, type MacosSessionVerificationResult } from './macos-session-contracts.js';
import type { Authorization, HostControls, PreparationResult, PreparedHandle, PreparedReview,
  MacosPreparedInputs, RunResult } from './host-types.js';
import type { Diagnostic } from './types.js';
import type { TrustRepairRequest, TrustInputs } from './trust-contracts.js';

const PREPARED = 'urn:aihq:core:prepared-work:1.3.0' as const;
const RESULT = 'urn:aihq:core:run-result:1.3.0' as const;
const VERIFICATION = 'urn:aihq:core:macos-session-verification-result:1.0.0' as const;
const disabled = { status: 'disabled', reason: 'logging-off' } as const;
const hash = (value: unknown) => sha256(canonicalJson(value));
const diagnostic = (code: string, reason: string): Diagnostic => ({ code, reason,
  message: 'Review the macOS session prerequisite and the required relaunch guidance.' });
const loggingOption = (controls: HostControls) => ({ value: controls.logging ?? 'on',
  origin: controls.logging === undefined ? 'default' as const : 'explicit' as const });
const reasonCodes: Readonly<Record<string, string>> = {
  'invalid-session-selection': 'INPUT_INVALID', 'review-stale': 'REVIEW_STALE',
  'session-custody-unavailable': 'STATE_CONFLICT', 'session-ownership-conflict': 'STATE_CONFLICT',
  'session-recovery-required': 'STATE_CONFLICT', 'trust-custody-pending': 'STATE_CONFLICT', 'trust-custody-conflict': 'STATE_CONFLICT'
};
interface SessionState { inner: PreparedHandle; innerDigest: string; review: PreparedReview; entry: MacosSessionCustodyEntry;
  helperSha256: string; removal?: true; recheck(): void }
const handles = new WeakMap<PreparedHandle, SessionState>();
const knownHandles = new WeakSet<PreparedHandle>();
const helperNames = ['package.json', 'dist/distribution.mjs', 'dist/core/macos-session.js',
  'dist/core/internal/macos-session-custody.js', 'dist/core/macos-session-contracts.js',
  'dist/harness/macos-session.mjs', 'dist/harness/macos-session-public.mjs',
  'dist/harness/macos-session-platform.mjs',
  'dist/harness/native/canonical.mjs',
  'dist/harness/macos-session-profiles.mjs', 'dist/harness/macos-session-definitions.mjs',
  'dist/core/schemas/repair-request/1.1.0.json', 'dist/core/schemas/repair-inputs/1.1.0.json',
  'dist/core/schemas/prepared-work/1.3.0.json', 'dist/core/schemas/run-result/1.3.0.json',
  'dist/core/schemas/macos-session-custody/1.0.0.json',
  'dist/core/schemas/macos-session-verification-request/1.0.0.json',
  'dist/core/schemas/macos-session-verification-result/1.0.0.json',
  'dist/harness/schemas/repair/1.2.0.json', 'dist/harness/schemas/macos-session-profiles/1.0.0.json'];
function helperDigest(): string {
  return hash(helperNames.map(name => { const bytes = readRegularFile(join(dirname(distributionManifest), name), { maxBytes: 4_000_000 });
    if (!bytes) throw new Error('session-custody-unavailable'); return { name, sha256: sha256(bytes) }; }));
}
// Imported implementations cannot be authorized by bytes changed after this module was loaded.
const loadedHelperDigest = (() => { try { return helperDigest(); } catch { return null; } })();
function installedSessionHelper(): string {
  const current = helperDigest();
  if (current !== loadedHelperDigest) throw new Error('review-stale');
  return current;
}
function record<T extends PreparationResult | RunResult | MacosSessionVerificationResult>(result: T, controls: HostControls): T {
  if (controls.logging === 'off') return result;
  const safe = { ...result, ...('prepared' in result ? { prepared: undefined } : {}) };
  const home = userHomeRoot();
  let text = JSON.stringify(safe);
  for (const path of [home, home.replaceAll('\\', '/')]) text = text.split(JSON.stringify(path).slice(1, -1)).join('<home>');
  const runId = 'runId' in result ? result.runId : randomUUID();
  result.record = writeHistory(runId, JSON.parse(text), controls.logging ?? 'on');
  if (result.record.status === 'failed') result.diagnostics.push(diagnostic('PREREQUISITE_UNAVAILABLE', result.record.reason));
  return result;
}

function sessionControls(controls: HostControls): HostControls {
  dataObject(controls, ['signal', 'logging']);
  validateControls(controls);
  return { ...(controls.signal === undefined ? {} : { signal: controls.signal }),
    ...(controls.logging === undefined ? {} : { logging: controls.logging }) };
}

function sessionReview(request: MacosRepairRequest, reason: string): MacosSessionReview {
  return {
    context: request.macosSession.context, bindingSha256: hash(request), session: null,
    applications: request.macosSession.applications.map(app => ({
      clientId: app.clientId, appPath: app.appPath, bundleId: null, version: null, build: null,
      targets: [...app.targets], launch: app.launch, profileIds: [], status: 'unavailable',
      reason, relaunch: 'unavailable'
    })), effects: []
  };
}

function blockedReview(request: MacosRepairRequest, reason: string, controls: HostControls): PreparedReview {
  const inputs: MacosPreparedInputs = {
    trust: { route: request.route,
      definition: { id: request.repairs[0].id, schema: 'urn:aihq:harness:repair:1.2.0' },
      helperSha256: installedSessionHelper(), package: { name: '@aihq/core', version: installedDistribution().version },
      bindingSha256: hash(request), sourceSetSha256: request.route === 'native' ? null : sha256('aih.trust.sources.v1\0[]'),
      targets: request.repairs[0].targets.map(id => ({ id, route: request.route, admission: 'unavailable', reason,
        cellId: null, client: null, policy: null, configurationSha256: null, secondarySources: [],
        verification: { status: 'unavailable', reason, checkIds: [] } })), sources: [], certificates: [], outputs: [] },
    macosSession: sessionReview(request, reason)
  };
  const content = { schema: PREPARED, useCase: 'repair' as const, mode: 'standalone' as const,
    target: { scope: 'user' as const, project: userHomeRoot() }, inputs, operations: [],
    observations: [], conflicts: [], omissions: [diagnostic('PREREQUISITE_UNAVAILABLE', reason)],
    effectiveOptions: { logging: loggingOption(controls), inputs: {} } };
  return deepFreezeStrictJsonV1({ ...content, reviewDigest: hash(content) });
}

/** Versioned macOS selection never falls back to another platform or an unselected app. */
export async function prepareMacosSession(input: MacosRepairRequest, controls: HostControls = {}): Promise<PreparationResult> {
  const runId = randomUUID();
  let inner: PreparedHandle | undefined;
  let safeControls: HostControls = { logging: 'off' };
  const result = (status: PreparationResult['status'], diagnostics: Diagnostic[], review?: PreparedReview): PreparationResult =>
    record({ status, runId, diagnostics, record: disabled, resolutionInputs: [], ...(review ? { review } : {}) }, safeControls);
  try {
    controls = sessionControls(controls);
    safeControls = controls;
    const validation = validateMacosRepairRequest(input);
    if (!validation.valid) return result('invalid', validation.diagnostics);
    const request = cloneJsonValueStructureV1(input, 'macOS request', 32) as MacosRepairRequest;
    if (controls.signal?.aborted) return result('cancelled', [diagnostic('CANCELLED', 'cancelled')]);
    const host = await observeMacosSessionPlatform(controls.signal);
    if (host.status === 'cancelled') return result('cancelled', [diagnostic('CANCELLED', 'cancelled')]);
    const reason = host.status !== 'observed' ? host.reason :
      request.macosSession.context !== 'terminal' ? 'app-session-unsupported' : null;
    if (reason) return result('blocked', [diagnostic('PREREQUISITE_UNAVAILABLE', reason)], blockedReview(request, reason, controls));
    const definition = selectMacosRepairDefinition({ requestSchema: request.schema, repairId: request.repairs[0].id,
      definitionSchema: 'urn:aihq:harness:repair:1.2.0' });
    if (!definition) return result('invalid', [diagnostic('SCHEMA_UNSUPPORTED', 'schema-unsupported')]);
    const helperSha256 = installedSessionHelper();
    installedDistribution();
    const image = readMacosCustody(true), pending = readPendingMacos(image);
    const active = image.value.entries.find(row => row.managementId === definition.managementId);
    // This development candidate keeps one exact target footprint per managed
    // session. A reviewed removal precedes target-set or installed-binding changes.
    if (!pending && active && hash([...active.request.repairs[0]!.targets].sort()) !== hash([...request.repairs[0].targets].sort()))
      return result('blocked', [diagnostic('PREREQUISITE_UNAVAILABLE', 'session-selection-change-unsupported')]);
    if (!pending && active && active.appBindingSha256 !== helperSha256)
      return result('blocked', [diagnostic('REVIEW_STALE', 'session-binding-changed')]);
    const originalSha256 = hash(request);
    const innerRequest: TrustRepairRequest = { ...request, schema: 'urn:aihq:core:repair-request:1.0.0' };
    delete (innerRequest as TrustRepairRequest & { macosSession?: unknown }).macosSession;
    let entry: MacosSessionCustodyEntry | undefined;
    const recheck = () => {
      const current = cloneJsonValueStructureV1(input, 'macOS request', 32);
      if (hash(current) !== originalSha256 || installedSessionHelper() !== helperSha256) throw new Error('review-stale');
    };
    const prepared = await prepareTrust(innerRequest, { ...controls, logging: 'off' }, trustEntry => {
      const prior = image.value.entries.find(row => row.managementId === trustEntry.managementId);
      if (pending && pending.intent.managementId !== trustEntry.managementId) throw new Error('session-recovery-required');
      if (!pending && prior && !sessionFilesMatch(prior)) throw new Error('session-ownership-conflict');
      entry = { managementId: trustEntry.managementId, selectionId: trustEntry.selectionId, recipeIdentity: trustEntry.recipeIdentity,
        bindingSha256: hash({ request, helperSha256, custody: image.digest }), context: 'terminal', request,
        files: sessionRecoveryFiles(image, trustEntry.managementId, pending), keys: [], profileIds: [], appBindingSha256: helperSha256, appliedAt: new Date().toISOString() };
      return macosCustodyParticipant(image, entry, null, recheck, [], pending);
    });
    inner = prepared.prepared;
    if (!prepared.review || !('trust' in prepared.review.inputs)) return result(prepared.status, prepared.diagnostics);
    const trust = (prepared.review.inputs as TrustInputs).trust;
    const session = sessionReview(request, 'terminal-configuration');
    session.bindingSha256 = hash({ request, helperSha256, trust: trust.bindingSha256, custody: image.digest, pending: pending?.digest ?? null, files: entry?.files ?? [] });
    if (entry) entry.bindingSha256 = session.bindingSha256;
    if (entry) session.effects = entry.files.filter(file => file.operationId !== 'material').map(file => {
      const location = sessionFileLocation(file.pathKey), before = readRegularFile(location.absolute, { maxBytes: 12 * 1024 * 1024 });
      const operation = prepared.review!.operations.find(row => row.id === `${entry!.selectionId}/${file.operationId}`);
      return { operationId: `${entry!.selectionId}/${file.operationId}`, kind: 'terminal-config' as const, target: location.absolute,
        scope: 'current-user-config' as const, beforeSha256: before ? sha256(before) : null, afterSha256: file.sha256,
        effect: operation?.effects === 'already-satisfied' ? 'unchanged' as const : before ? 'replace' as const : 'create' as const,
        persistent: true, key: null };
    });
    const content = { ...prepared.review, schema: PREPARED,
      observations: [...prepared.review.observations, ...(pending ? [{ id: 'pending-session-reconciliation', reason: `pending-intent:${pending.digest}` }] : [])],
      effectiveOptions: { ...prepared.review.effectiveOptions,
      logging: loggingOption(controls) }, inputs: { trust: { ...trust,
      definition: { id: request.repairs[0].id, schema: 'urn:aihq:harness:repair:1.2.0' as const } }, macosSession: session }, reviewDigest: '' };
    const review = deepFreezeStrictJsonV1({ ...content, reviewDigest: hash({ review: content, innerDigest: prepared.review.reviewDigest }) });
    if (!inner || !entry || prepared.status !== 'ready') return result(prepared.status, prepared.diagnostics, review);
    const handle = Object.freeze({}) as PreparedHandle;
    knownHandles.add(handle); handles.set(handle, { inner, innerDigest: prepared.review.reviewDigest, review, entry, helperSha256, recheck });
    inner = undefined;
    return record({ ...prepared, runId, review, prepared: handle, record: disabled }, controls);
  } catch (error) {
    if (inner) disposeTrustHandle(inner);
    const reason = error instanceof Error && /^[a-z-]{1,64}$/.test(error.message) ? error.message : 'invalid-session-selection';
    return result(reason === 'invalid-session-selection' ? 'invalid' : 'blocked',
      [diagnostic(reasonCodes[reason] ?? 'PREREQUISITE_UNAVAILABLE', reason)]);
  }
}

export const isMacosSessionHandle = (handle: PreparedHandle): boolean => !!handle && knownHandles.has(handle);
export function disposeMacosSessionHandle(handle: PreparedHandle): void {
  const state = handles.get(handle); if (state) { handles.delete(handle); disposeTrustHandle(state.inner); }
}
/** Wrap the existing cleanup handle; the caller still approves the exact 1.3 review. */
export function wrapMacosRemoval(prepared: PreparationResult, entry: MacosSessionCustodyEntry, controls: HostControls,
  effects: MacosSessionReview['effects']): PreparationResult {
  if (!prepared.review || !prepared.prepared) return prepared;
  const helperSha256 = installedSessionHelper();
  const base = cloneJsonValueStructureV1(blockedReview(entry.request, 'managed-removal', controls), 'session removal', 32) as unknown as PreparedReview;
  const session = (base.inputs as MacosPreparedInputs).macosSession;
  (base.inputs as MacosPreparedInputs).trust.helperSha256 = helperSha256;
  (base.inputs as MacosPreparedInputs).trust.bindingSha256 = entry.bindingSha256;
  session.bindingSha256 = entry.bindingSha256;
  session.effects = effects;
  const content = { ...prepared.review, schema: PREPARED, useCase: 'repair' as const, mode: 'standalone' as const,
    target: base.target, inputs: base.inputs, reviewDigest: '' };
  const review = deepFreezeStrictJsonV1({ ...content, reviewDigest: hash({ review: content, innerDigest: prepared.review.reviewDigest }) });
  const handle = Object.freeze({}) as PreparedHandle;
  knownHandles.add(handle); handles.set(handle, { inner: prepared.prepared, innerDigest: prepared.review.reviewDigest, review, entry,
    helperSha256, removal: true, recheck() { if (installedSessionHelper() !== helperSha256) throw new Error('review-stale'); } });
  return { ...prepared, review, prepared: handle };
}
export async function applyMacosSession(handle: PreparedHandle, authorization: Authorization, controls: HostControls = {}): Promise<RunResult> {
  const state = handles.get(handle);
  let safeControls: HostControls = { logging: 'off' };
  const baseSession: MacosSessionRun = { context: state?.entry.context ?? 'terminal', managementId: state?.entry.managementId ?? null,
    selectionId: state?.entry.selectionId ?? null, configuration: 'not-applied', persistence: 'not-required',
    verification: 'unavailable', reason: 'session-custody-unavailable', applications: [] };
  const rejected = (reason: string, code: string): RunResult => ({ schema: RESULT, runId: randomUUID(), useCase: 'repair', completion: 'rejected',
    ...(state ? { inputs: state.review.inputs } : {}), effectiveOptions: { logging: loggingOption(safeControls) },
    operations: [], checks: [], diagnostics: [diagnostic(code, reason)], record: disabled, followUp: [], trust: { outputs: [], targets: [] }, macosSession: baseSession });
  try { controls = sessionControls(controls); safeControls = controls; dataObject(authorization, ['approved', 'origin', 'reviewDigest', 'allowPartial']); }
  catch { return rejected('invalid-session-selection', 'INPUT_INVALID'); }
  if (!state) return rejected('handle-unavailable', 'REVIEW_STALE');
  if (authorization.approved !== true || !['interactive', 'automation'].includes(authorization.origin) || authorization.reviewDigest !== state.review.reviewDigest ||
      authorization.allowPartial !== undefined && typeof authorization.allowPartial !== 'boolean') return rejected('approval-required', 'APPROVAL_REQUIRED');
  try { state.recheck(); } catch { disposeMacosSessionHandle(handle); return record(rejected('review-stale', 'REVIEW_STALE'), controls); }
  const result = state.removal ? await applyPolicy(state.inner, { ...authorization, reviewDigest: state.innerDigest }, { ...controls, logging: 'off' }) :
    await applyTrust(state.inner, { ...authorization, reviewDigest: state.innerDigest }, { ...controls, logging: 'off' });
  handles.delete(handle);
  const effectIds = (state.review.inputs as MacosPreparedInputs).macosSession.effects.map(effect => effect.operationId);
  let configuration = sessionConfiguration(result.operations, effectIds);
  const wroteConfiguration = result.operations.some(row => effectIds.includes(row.id) && row.application === 'applied');
  if (configuration === 'applied' || configuration === 'already-satisfied') {
    try {
      const entry = readMacosCustody().value.entries.find(row => row.managementId === state.entry.managementId);
      if (state.removal ? !!entry : !entry || entry.bindingSha256 !== state.entry.bindingSha256 || !sessionFilesMatch(entry!) || !sessionTrustMatches(entry!)) throw new Error();
    } catch { configuration = 'uncertain'; if (result.completion === 'complete') result.completion = 'incomplete';
      result.diagnostics.push(diagnostic('STATE_CONFLICT', 'session-recovery-required')); }
  }
  const verification = state.removal || state.entry.request.network === 'off' ? 'skipped' : result.trust?.targets.some(row => row.verification === 'failed') ? 'failed' :
    result.completion === 'complete' && result.trust?.targets.length && result.trust.targets.every(row => row.verification === 'passed') ? 'passed' : 'unavailable';
  const reason = configuration === 'uncertain' ? 'session-recovery-required' : state.removal ? 'managed-removal' :
    verification === 'skipped' ? 'network-off' : verification === 'passed' ? 'terminal-checks-passed' : verification === 'failed' ? 'terminal-trust-failed' : 'terminal-trust-unobservable';
  return record({ ...result, schema: RESULT, useCase: 'repair', inputs: state.review.inputs, trust: result.trust ?? { outputs: [], targets: [] },
    effectiveOptions: { logging: loggingOption(controls) },
    macosSession: { ...baseSession, configuration, verification, reason }, followUp: wroteConfiguration || configuration === 'already-satisfied'
      ? [...result.followUp, 'Start a new login shell so it reads the managed terminal configuration.'] : result.followUp }, controls);
}

/** Observational API; invalid requests and unsupported hosts do not mutate session state. */
export async function verifyMacosSession(input: MacosSessionVerificationRequest,
  controls: Pick<HostControls, 'signal' | 'logging'> = {}): Promise<MacosSessionVerificationResult> {
  const started = performance.now();
  let managementId: string | null = null;
  let platform: MacosSessionVerificationResult['platform'] = null;
  const finish = (status: 'complete' | 'incomplete' | 'invalid' | 'cancelled', code: string, reason: string): MacosSessionVerificationResult => ({
    schema: VERIFICATION, status, package: null, platform, managementId, selectionId: null,
    bindingSha256: null, observations: [], configuration: 'not-applied', verification: 'unavailable',
    reason, applications: [], checks: [], diagnostics: [diagnostic(code, reason)],
    elapsedMs: Math.max(0, Math.round(performance.now() - started)), record: disabled
  });
  try {
    controls = sessionControls(controls);
    const validation = validateMacosSessionVerificationRequest(input);
    if (!validation.valid) {
      const first = validation.diagnostics[0];
      return finish('invalid', first?.code ?? 'INPUT_INVALID', first?.reason ?? 'invalid-session-selection');
    }
    managementId = input.managementId;
    if (controls.signal?.aborted) return finish('cancelled', 'CANCELLED', 'cancelled');
    const host = await observeMacosSessionPlatform(controls.signal);
    if (host.status === 'cancelled') return record(finish('cancelled', 'CANCELLED', host.reason), controls);
    if (host.status !== 'observed') return record(finish('incomplete', 'PREREQUISITE_UNAVAILABLE', host.reason), controls);
    platform = host.platform;
    if (controls.signal?.aborted) return record(finish('cancelled', 'CANCELLED', 'cancelled'), controls);
    const installed = installedDistribution();
    const entry = readMacosCustody().value.entries.find(row => row.managementId === managementId);
    if (!entry) return record(finish('incomplete', 'STATE_CONFLICT', 'session-custody-unavailable'), controls);
    if (!sessionTrustMatches(entry)) return record(finish('incomplete', 'STATE_CONFLICT', 'session-custody-unavailable'), controls);
    const filesMatched = sessionFilesMatch(entry), helpersMatched = installedSessionHelper() === entry.appBindingSha256;
    const matched = filesMatched && helpersMatched;
    const result = finish('incomplete', matched ? 'PREREQUISITE_UNAVAILABLE' : 'STATE_CONFLICT',
      matched ? entry.request.network === 'off' ? 'network-off' : 'terminal-trust-unobservable' : !filesMatched ? 'session-config-drift' : 'session-binding-changed');
    result.package = installed as MacosSessionVerificationResult['package']; result.selectionId = entry.selectionId;
    result.bindingSha256 = matched ? entry.bindingSha256 : null;
    result.configuration = matched ? 'already-satisfied' : 'uncertain';
    result.verification = matched && entry.request.network === 'off' ? 'skipped' : 'unavailable';
    return record(result, controls);
  } catch (error) {
    if (!managementId) return finish('invalid', 'INPUT_INVALID', 'invalid-session-selection');
    const reason = error instanceof Error && ['session-recovery-required', 'trust-custody-pending'].includes(error.message)
      ? 'session-recovery-required' : 'session-custody-unavailable';
    return record(finish('incomplete', 'STATE_CONFLICT', reason), controls);
  }
}
