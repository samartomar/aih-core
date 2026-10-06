import { existsSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { canonicalJson } from './canonical.js';
import { parseStrictJsonObjectV1 } from './strict-json.js';
import { pathPins, sha256, userHomeRoot } from './host-files.js';
import { stateFiles, stateRoot, protectState, readOwnership } from './state.js';
import { memberBytes } from './recipe-lifecycle.js';
import { readRegularFile } from './fsxn.js';
import { validateMacosSessionCustody, type MacosSessionCustody,
  type MacosSessionCustodyEntry, type MacosSessionEffect } from '../macos-session-contracts.js';
import type { TrustEngineParticipant, TrustEngineStep } from './trust-participant.js';

const FILE = 'macos-session-custody.json';
const PENDING = 'macos-session-pending.json';
const LIMIT = 1_048_576;
export interface MacosCustodyImage { value: MacosSessionCustody; digest: string | null }
const empty = (): MacosSessionCustody => ({ schema: 'urn:aihq:core:macos-session-custody:1.0.0', entries: [] });

function encode(value: MacosSessionCustody): Buffer {
  const bytes = Buffer.from(canonicalJson(value));
  if (bytes.length > LIMIT || !validateMacosSessionCustody(value).valid) throw new Error('session-custody-unavailable');
  return bytes;
}

/** Reads protected metadata only; an unfinished transaction requires deliberate reconciliation. */
export function readMacosCustody(): MacosCustodyImage {
  if (!existsSync(stateRoot())) return { value: empty(), digest: null };
  try {
    pathPins(join(stateRoot(), FILE)); pathPins(join(stateRoot(), PENDING));
    if (existsSync(join(stateRoot(), PENDING))) { protectState([PENDING]); throw new Error('session-recovery-required'); }
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
  const image = readMacosCustody();
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
  removal: MacosSessionCustodyEntry | null, recheck: () => void, effects: MacosSessionEffect[] = []): TrustEngineParticipant {
  const managementId = (update ?? removal)!.managementId;
  let expected = image.digest;
  let prefix = '';
  let intentDigest: string | null = null;
  let begun = false;
  const removalDigests = new Map<string, string | null>();
  const affected = (root: string, path: string) => (update?.files ?? removal?.files ?? []).some(file =>
    sessionFileLocation(file.pathKey).absolute === join(root, ...path.split('/')));
  const next = (): MacosSessionCustody => ({ ...image.value, entries: image.value.entries.filter(entry => entry.managementId !== managementId)
    .concat(update ? [update] : []).sort((a, b) => a.managementId < b.managementId ? -1 : a.managementId > b.managementId ? 1 : 0) });
  const currentDigest = () => { const bytes = stateFiles().read(FILE); return bytes ? sha256(bytes) : null; };
  return {
    macosSession: true, exactReplacement: true, lockRoot: join(stateRoot(), 'trust-custody'),
    reviewBinding: sha256(canonicalJson({ custody: image.digest, managementId, update: update?.bindingSha256 ?? null, removal })),
    allows: affected,
    recheck() { if (readMacosCustody().digest !== image.digest) throw new Error('review-stale'); recheck(); },
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
      encode(next());
    },
    stage(runId, recovery) {
      if (currentDigest() !== expected) throw new Error('review-stale');
      prefix = `recovery/${runId}/macos-session`;
      protectState([FILE, PENDING, `recovery/${runId}`]);
      const files = stateFiles();
      const before = encode(image.value), after = encode(next());
      files.writeAtomic(`${prefix}-before.json`, before, 0o600, true);
      files.writeAtomic(`${prefix}-after.json`, after, 0o600, true);
      const intent = Buffer.from(canonicalJson({ schema: 'urn:aihq:core:macos-session-intent:1.0.0', runId, managementId,
        before: `${prefix}-before.json`, after: `${prefix}-after.json`, beforeSha256: sha256(before), afterSha256: sha256(after), recovery: recovery ?? null }));
      files.writeAtomic(PENDING, intent, 0o600, true); intentDigest = sha256(intent);
    },
    committed(step: TrustEngineStep) { if (step.root && step.path && affected(step.root, step.path)) begun = true; },
    finish(result) {
      if (!intentDigest) return;
      const files = stateFiles();
      const intent = files.read(PENDING);
      if (!intent || sha256(intent) !== intentDigest || currentDigest() !== expected) throw new Error('session-recovery-required');
      if (result.completion !== 'complete') {
        if (begun || result.operations.some(operation => operation.application !== 'not-attempted')) return;
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
        const bytes = encode(next()); files.writeAtomic(FILE, bytes, 0o600); expected = sha256(bytes);
      }
      files.remove(PENDING); files.remove(`${prefix}-before.json`); files.remove(`${prefix}-after.json`);
    }
  };
}
