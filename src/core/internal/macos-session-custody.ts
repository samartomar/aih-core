import { existsSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { canonicalJson } from './canonical.js';
import { parseStrictJsonObjectV1 } from './strict-json.js';
import { pathPins, pinsMatch, sha256, userHomeRoot, type PathPin } from './host-files.js';
import { stateFiles, stateRoot, protectState, readOwnership } from './state.js';
import { memberBytes } from './recipe-lifecycle.js';
import { readRegularFile } from './fsxn.js';
import { validateMacosSessionCustody, type MacosSessionCustody,
  type MacosSessionCustodyEntry, type MacosSessionEffect } from '../macos-session-contracts.js';
import type { TrustEngineParticipant, TrustEngineStep } from './trust-participant.js';
import { readTrustCustody } from './trust-custody.js';
import type { OperationResult } from '../host-types.js';
import type { MacosSessionRun } from '../macos-session-contracts.js';

const FILE = 'macos-session-custody.json';
const PENDING = 'macos-session-pending.json';
const LIMIT = 1_048_576;
export interface MacosCustodyImage { value: MacosSessionCustody; digest: string | null }
interface SessionIntent { schema: string; runId: string; managementId: string; before: string; after: string;
  beforeSha256: string; afterSha256: string; recovery: string | null;
  previousIntent?: { reference: string; sha256: string } }
export interface MacosPendingImage { intent: SessionIntent; digest: string; before: MacosSessionCustody;
  after: MacosSessionCustody; pins: PathPin[] }
const empty = (): MacosSessionCustody => ({ schema: 'urn:aihq:core:macos-session-custody:1.0.0', entries: [] });

function encode(value: MacosSessionCustody): Buffer {
  const bytes = Buffer.from(canonicalJson(value));
  if (bytes.length > LIMIT || !validateMacosSessionCustody(value).valid) throw new Error('session-custody-unavailable');
  return bytes;
}

/** Reads protected metadata only; an unfinished transaction requires deliberate reconciliation. */
export function readMacosCustody(allowPending = false): MacosCustodyImage {
  if (!existsSync(stateRoot())) return { value: empty(), digest: null };
  try {
    pathPins(join(stateRoot(), FILE)); pathPins(join(stateRoot(), PENDING));
    if (!allowPending && existsSync(join(stateRoot(), PENDING))) { protectState([PENDING]); throw new Error('session-recovery-required'); }
    if (!existsSync(join(stateRoot(), FILE))) return { value: empty(), digest: null };
    protectState([FILE]);
    const bytes = stateFiles().read(FILE);
    if (!bytes || bytes.length > LIMIT) throw new Error();
    const value = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'macOS custody') as unknown as MacosSessionCustody;
    encode(value);
    const ids = new Set<string>();
    for (const entry of value.entries) {
      if (ids.has(entry.managementId)) throw new Error();
      ids.add(entry.managementId);
      for (const file of entry.files) sessionFileLocation(file.pathKey);
    }
    return { value, digest: sha256(bytes) };
  } catch (error) {
    if (error instanceof Error && error.message === 'session-recovery-required') throw error;
    throw new Error('session-custody-unavailable');
  }
}

/** Pending snapshots name affected members; they never authorize current bytes. */
export function readPendingMacos(image: MacosCustodyImage): MacosPendingImage | undefined {
  if (!existsSync(join(stateRoot(), PENDING))) return;
  try {
    protectState([PENDING]);
    const bytes = stateFiles().read(PENDING);
    if (!bytes || bytes.length > LIMIT) throw new Error();
    const intent = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'session intent') as unknown as SessionIntent;
    const keys = ['schema', 'runId', 'managementId', 'before', 'after', 'beforeSha256', 'afterSha256', 'recovery'];
    if (Object.keys(intent).length !== keys.length + (intent.previousIntent === undefined ? 0 : 1) || keys.some(key => !Object.hasOwn(intent, key)) ||
      intent.schema !== 'urn:aihq:core:macos-session-intent:1.0.0' ||
      !/^[a-f0-9-]{36}$/.test(intent.runId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(intent.managementId) ||
      intent.before !== `recovery/${intent.runId}/macos-session-before.json` ||
      intent.after !== `recovery/${intent.runId}/macos-session-after.json` ||
      !/^[a-f0-9]{64}$/.test(intent.beforeSha256) || !/^[a-f0-9]{64}$/.test(intent.afterSha256) ||
      intent.recovery !== null && (typeof intent.recovery !== 'string' || intent.recovery.length > 4096)) throw new Error();
    if (intent.previousIntent !== undefined) {
      const prior = intent.previousIntent;
      if (!prior || Object.keys(prior).length !== 2 || typeof prior.reference !== 'string' ||
        !/^recovery\/[a-f0-9-]{36}\/macos-session-original-intent\.json$/.test(prior.reference) ||
        typeof prior.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(prior.sha256)) throw new Error();
      protectState([prior.reference]);
      const old = stateFiles().read(prior.reference);
      if (!old || sha256(old) !== prior.sha256) throw new Error();
    }
    const snapshots = [intent.before, intent.after].map((reference, index) => {
      protectState([reference]);
      const snapshot = stateFiles().read(reference);
      if (!snapshot || sha256(snapshot) !== [intent.beforeSha256, intent.afterSha256][index]) throw new Error();
      const value = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(snapshot), 'session snapshot') as unknown as MacosSessionCustody;
      encode(value);
      for (const entry of value.entries) for (const file of entry.files) sessionFileLocation(file.pathKey);
      return value;
    });
    // Session metadata publishes only at finalization; unrelated metadata may not drift.
    if (image.digest !== null && image.digest !== intent.beforeSha256 && image.digest !== intent.afterSha256 ||
      image.digest === null && snapshots[0]!.entries.length !== 0) throw new Error();
    const withoutManaged = (value: MacosSessionCustody) => canonicalJson(value.entries.filter(entry => entry.managementId !== intent.managementId));
    if (withoutManaged(snapshots[0]!) !== withoutManaged(snapshots[1]!)) throw new Error();
    if (![...snapshots[0]!.entries, ...snapshots[1]!.entries].some(entry => entry.managementId === intent.managementId && entry.files.length > 0)) throw new Error();
    return { intent, digest: sha256(bytes), before: snapshots[0]!, after: snapshots[1]!,
      pins: [PENDING, intent.before, intent.after, ...(intent.previousIntent ? [intent.previousIntent.reference] : [])]
        .flatMap(reference => pathPins(join(stateRoot(), reference))) };
  } catch { throw new Error('session-custody-unavailable'); }
}

/** Provisional guard eligibility comes from protected metadata, before engine preflight. */
export function sessionRecoveryFiles(image: MacosCustodyImage, managementId: string, pending?: MacosPendingImage): MacosSessionCustodyEntry['files'] {
  if (!pending) return image.value.entries.find(entry => entry.managementId === managementId)?.files ?? [];
  if (pending.intent.managementId !== managementId) throw new Error('session-recovery-required');
  return [...new Map([...pending.before.entries, ...pending.after.entries].filter(entry => entry.managementId === managementId)
    .flatMap(entry => entry.files.map(file => [file.pathKey, { ...file }] as const))).values()]
    .sort((a, b) => a.pathKey < b.pathKey ? -1 : a.pathKey > b.pathKey ? 1 : 0);
}

function assertPendingMacos(image: MacosCustodyImage, pending: MacosPendingImage): void {
  const current = readPendingMacos(image);
  if (!current || current.digest !== pending.digest || !pinsMatch(pending.pins)) throw new Error('review-stale');
}

/** A session file list alone cannot establish the material's trust provenance. */
export function sessionTrustMatches(entry: MacosSessionCustodyEntry): boolean {
  const material = entry.files.find(file => file.operationId === 'material');
  const trust = readTrustCustody().value.entries.filter(row => row.managementId === entry.managementId);
  return !!material && trust.length === 1 && trust[0]!.selectionId === entry.selectionId &&
    trust[0]!.operationId === material.operationId && trust[0]!.pathKey === material.pathKey &&
    trust[0]!.outputSha256 === material.sha256 && trust[0]!.recipeIdentity === entry.recipeIdentity;
}

/** Verification/completion does not erase configuration operations that already ran. */
export function sessionConfiguration(operations: OperationResult[], effectIds: string[]): MacosSessionRun['configuration'] {
  const selected = operations.filter(operation => effectIds.includes(operation.id));
  if (selected.some(operation => operation.effectsUncertain)) return 'uncertain';
  if (selected.some(operation => operation.application === 'applied')) return 'applied';
  return selected.length === effectIds.length && selected.length > 0 && selected.every(operation => operation.application === 'already-satisfied')
    ? 'already-satisfied' : 'not-applied';
}

/** A custody path is a canonical current-home member identity, never an executable path. */
export function sessionFileLocation(pathKey: string): { absolute: string; root: string; path: string } {
  const parsed = parseStrictJsonObjectV1(pathKey, 'session member') as { home?: unknown; segments?: unknown };
  if (canonicalJson(parsed) !== pathKey || Object.keys(parsed).length !== 2 || parsed.home !== userHomeRoot() ||
      !Array.isArray(parsed.segments) || !parsed.segments.length || parsed.segments.some(segment => typeof segment !== 'string' ||
        !segment || segment === '.' || segment === '..' || /[\\:\p{Cc}\p{Cf}]/u.test(segment))) throw new Error('session-custody-unavailable');
  const path = (parsed.segments as string[]).join('/');
  if (path.startsWith('.aih/core/') && !/^\.aih\/core\/content\/[a-f0-9]{64}\//.test(path)) throw new Error('session-custody-unavailable');
  const absolute = join(userHomeRoot(), ...parsed.segments as string[]);
  const root = path.startsWith('.aih/core/content/') ? dirname(absolute) : userHomeRoot();
  return { absolute, root, path: root === userHomeRoot() ? path : (parsed.segments as string[]).at(-1)! };
}

export function sessionFilesMatch(entry: MacosSessionCustodyEntry): boolean {
  return entry.files.length > 0 && entry.files.every(file => {
    const location = sessionFileLocation(file.pathKey);
    pathPins(location.absolute);
    const owners = Object.entries(readOwnership(location.root).value.members).filter(([key, owner]) =>
      (owner.descriptor?.path ?? key) === location.path && owner.managementId === entry.managementId);
    const bytes = readRegularFile(location.absolute, { maxBytes: 12 * 1024 * 1024 });
    return owners.length > 0 && !!bytes && sha256(bytes) === file.sha256 && owners.every(([key, owner]) => {
      if (owner.descriptor?.kind === 'hook') return false;
      const fragment = memberBytes(owner.descriptor ?? { kind: 'file', path: key }, bytes);
      return !!fragment && owner.recipeIdentity === entry.recipeIdentity && owner.sha256 === sha256(fragment) &&
        !owner.claims?.some(claim => claim.managementId !== entry.managementId || claim.scope !== 'user');
    });
  });
}

/** Prevent a request without session semantics from replacing the same managed files. */
export function guardMacosSessionMember(root: string, path: string, allowed: boolean): void {
  // The internal participant rechecked the image under its lock before staging
  // this intent. Its own captured members must remain executable after staging;
  // finish still verifies the exact intent and ordinary custody before publish.
  if (allowed) return;
  const target = join(root, ...path.split('/'));
  const home = userHomeRoot();
  const local = relative(home, target);
  if (local.startsWith('..') || isAbsolute(local)) return;
  const image = readMacosCustody(true), pending = readPendingMacos(image);
  if (pending && [...pending.before.entries, ...pending.after.entries].some(entry => entry.managementId === pending.intent.managementId &&
    entry.files.some(file => sessionFileLocation(file.pathKey).absolute === target))) throw new Error('session-recovery-required');
  if (image.value.entries.some(entry => entry.files.some(file => sessionFileLocation(file.pathKey).absolute === target)))
    throw new Error('session-ownership-conflict');
}

/** Compose under the existing trust lock; neither participant is a public caller adapter. */
export function joinSessionParticipant(trust: TrustEngineParticipant, session: TrustEngineParticipant): TrustEngineParticipant {
  return {
    macosSession: true, exactReplacement: trust.exactReplacement, lockRoot: trust.lockRoot,
    reviewBinding: sha256(canonicalJson([trust.reviewBinding, session.reviewBinding])),
    allows(root, path) { return trust.allows(root, path) || session.allows(root, path); },
    async recheck() { await trust.recheck(); await session.recheck(); },
    preflight(steps, ownership) { trust.preflight(steps, ownership); session.preflight(steps, ownership); },
    stage(runId, recovery) { session.stage(runId, recovery); trust.stage(runId, recovery); },
    committed(step) { trust.committed(step); session.committed(step); },
    finish(result) {
      // Retain the session intent if ordinary/trust finalization failed.
      trust.finish(result); session.finish(result);
    }
  };
}

/** Only complete, read-back-matching ordinary custody can publish session metadata. */
export function macosCustodyParticipant(image: MacosCustodyImage, update: MacosSessionCustodyEntry | null,
  removal: MacosSessionCustodyEntry | null, recheck: () => void, effects: MacosSessionEffect[] = [], pending?: MacosPendingImage): TrustEngineParticipant {
  const managementId = (update ?? removal)!.managementId;
  if (pending && (removal || pending.intent.managementId !== managementId)) throw new Error('session-recovery-required');
  let expected = image.digest;
  let prefix = '';
  let intentDigest: string | null = null;
  let successorIntent: Buffer | undefined;
  let begun = false;
  const removalDigests = new Map<string, string | null>();
  const affected = (root: string, path: string) => (update?.files ?? removal?.files ?? []).some(file =>
    sessionFileLocation(file.pathKey).absolute === join(root, ...path.split('/')));
  const next = (): MacosSessionCustody => ({ ...image.value, entries: image.value.entries.filter(entry => entry.managementId !== managementId)
    .concat(update ? [update] : []).sort((a, b) => a.managementId < b.managementId ? -1 : a.managementId > b.managementId ? 1 : 0) });
  const currentDigest = () => { const bytes = stateFiles().read(FILE); return bytes ? sha256(bytes) : null; };
  return {
    macosSession: true, exactReplacement: true, lockRoot: join(stateRoot(), 'trust-custody'),
    reviewBinding: sha256(canonicalJson({ custody: image.digest, pending: pending?.digest ?? null, managementId, update: update?.bindingSha256 ?? null, removal })),
    allows: affected,
    recheck() { if (readMacosCustody(!!pending).digest !== image.digest) throw new Error('review-stale');
      if (pending) assertPendingMacos(image, pending); recheck(); },
    preflight(steps) {
      if (update) {
        const files = steps.filter(step => step.managementId === managementId && step.review.id.startsWith(`${update.selectionId}/`) && step.root && step.path && step.after);
        if (!files.length || new Set(files.map(step => step.recipeIdentity)).size !== 1) throw new Error('session-custody-unavailable');
        update.recipeIdentity = files[0]!.recipeIdentity;
        update.files = files.map(step => {
          const absolute = join(step.root!, ...step.path!.split('/'));
          const path = relative(userHomeRoot(), absolute);
          if (path.startsWith('..') || isAbsolute(path)) throw new Error('session-custody-unavailable');
          return { operationId: step.review.id.split('/').slice(1).join('/'),
            pathKey: canonicalJson({ home: userHomeRoot(), segments: path.split(process.platform === 'win32' ? '\\' : '/') }), sha256: sha256(step.after!) };
        }).sort((a, b) => a.pathKey < b.pathKey ? -1 : a.pathKey > b.pathKey ? 1 : 0);
      } else if (removal) for (const step of steps.filter(step => step.managementId === managementId && step.root && step.path && affected(step.root, step.path))) {
        const absolute = join(step.root!, ...step.path!.split('/'));
        removalDigests.set(absolute, step.after ? sha256(step.after) : null);
        effects.push({ operationId: step.review.id, kind: 'terminal-config', target: absolute, scope: 'current-user-config',
          beforeSha256: step.before ? sha256(step.before) : null, afterSha256: step.after ? sha256(step.after) : null,
          effect: step.review.effects === 'already-satisfied' ? 'unchanged' : 'remove', persistent: true, key: null });
      }
      if (pending && update) {
        const paths = (entries: MacosSessionCustodyEntry[]) => [...new Set(entries.filter(entry => entry.managementId === managementId)
          .flatMap(entry => entry.files.map(file => file.pathKey)))].sort();
        if (canonicalJson(paths([update])) !== canonicalJson(paths([...pending.before.entries, ...pending.after.entries])))
          throw new Error('session-recovery-required');
      }
      encode(next());
    },
    stage(runId, recovery) {
      if (currentDigest() !== expected) throw new Error('review-stale');
      if (pending) assertPendingMacos(image, pending);
      prefix = `recovery/${runId}/macos-session`;
      protectState([FILE, PENDING, `recovery/${runId}`]);
      const files = stateFiles();
      if (update) update.appliedAt = new Date().toISOString();
      const before = files.read(FILE) ?? encode(image.value), after = encode(next());
      files.writeAtomic(`${prefix}-before.json`, before, 0o600, true);
      files.writeAtomic(`${prefix}-after.json`, after, 0o600, true);
      const intent = Buffer.from(canonicalJson({ schema: 'urn:aihq:core:macos-session-intent:1.0.0', runId, managementId,
        before: `${prefix}-before.json`, after: `${prefix}-after.json`, beforeSha256: sha256(before), afterSha256: sha256(after), recovery: recovery ?? null }));
      successorIntent = intent;
      // Keep the original intent throughout a fresh reconciliation. A crash must
      // not forget its affected members or before/after evidence.
      if (pending) intentDigest = pending.digest;
      else { files.writeAtomic(PENDING, intent, 0o600, true); intentDigest = sha256(intent); }
    },
    committed(step: TrustEngineStep) { if (step.root && step.path && affected(step.root, step.path)) begun = true; },
    finish(result) {
      if (!intentDigest) return;
      const files = stateFiles();
      const intent = files.read(PENDING);
      if (!intent || sha256(intent) !== intentDigest || currentDigest() !== expected) throw new Error('session-recovery-required');
      if (result.completion !== 'complete') {
        if (begun || result.operations.some(operation => operation.application !== 'not-attempted')) {
          if (pending) { files.remove(`${prefix}-before.json`); files.remove(`${prefix}-after.json`); }
          return;
        }
      } else {
        if (update && !sessionFilesMatch(update)) throw new Error('session-ownership-conflict');
        if (removal && removal.files.some(file => {
          const location = sessionFileLocation(file.pathKey);
          const bytes = readRegularFile(location.absolute, { maxBytes: 12 * 1024 * 1024 });
          const actual = bytes ? sha256(bytes) : null;
          return !removalDigests.has(location.absolute) && actual !== null || removalDigests.has(location.absolute) && actual !== removalDigests.get(location.absolute) ||
            Object.entries(readOwnership(location.root).value.members).some(([key, owner]) =>
              (owner.descriptor?.path ?? key) === location.path && owner.managementId === managementId);
        })) throw new Error('session-ownership-conflict');
        if (pending) assertPendingMacos(image, pending);
        if (pending) {
          // Advance the journal before metadata publication so either side of a
          // crash has a matching before/after digest. Retain the original proof.
          const reference = `${prefix}-original-intent.json`;
          files.writeAtomic(reference, intent, 0o600, true);
          const successor = Buffer.from(canonicalJson({ ...JSON.parse(successorIntent!.toString('utf8')),
            previousIntent: { reference, sha256: pending.digest } }));
          files.writeAtomic(PENDING, successor, 0o600); intentDigest = sha256(successor);
        }
        const bytes = encode(next()); files.writeAtomic(FILE, bytes, 0o600); expected = sha256(bytes);
      }
      if (!pending || result.completion === 'complete') files.remove(PENDING);
      files.remove(`${prefix}-before.json`); files.remove(`${prefix}-after.json`);
      if (pending && result.completion === 'complete') { files.remove(pending.intent.before); files.remove(pending.intent.after); }
    }
  };
}
