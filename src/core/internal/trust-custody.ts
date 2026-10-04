import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from './canonical.js';
import { parseStrictJsonObjectV1 } from './strict-json.js';
import { pathPins, sha256, userHomeRoot } from './host-files.js';
import { resolveTrustPath, nativeTrustPathEquivalent } from './trust-path.js';
import { stateFiles, stateRoot, protectState, readOwnership, type Ownership } from './state.js';
import type { TrustEngineParticipant, TrustEngineStep } from './trust-participant.js';
import type { RunResult } from '../host-types.js';
import { validateTrustCustody } from '../trust-contracts.js';
import { readRegularFile } from './fsxn.js';
import { memberKey } from './recipe-lifecycle.js';

export interface TrustCustodySource { id: string; kind: 'os' | 'supplied' | 'node-bundled' | 'jvm-baseline'; fingerprints: string[];
  sourceSha256: string; policySha256: string | null; runtimeVersion: string | null; privateFile: string | null }
export interface TrustCustodyEntry { managementId: string; selectionId: string; operationId: string; pathKey: string; relativePath: string;
  format: 'pem' | 'pkcs7-der' | 'jks'; outputSha256: string; recipeIdentity: string; sourceSetSha256: string; sources: TrustCustodySource[] }
export interface TrustCustody { schema: 'urn:aihq:core:trust-custody:1.0.0'; entries: TrustCustodyEntry[] }
export interface TrustCustodyImage { value: TrustCustody; digest: string | null }
const FILE = 'trust-custody.json'; const INTENT = 'trust-custody-pending.json'; const LIMIT = 1_048_576;
const hex = /^[a-f0-9]{64}$/; const id = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const empty = (): TrustCustody => ({ schema: 'urn:aihq:core:trust-custody:1.0.0', entries: [] });
function exact(value: object, keys: string[]) { return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)); }
function validate(value: unknown): asserts value is TrustCustody {
  const fail = () => { throw new Error('trust-custody-conflict'); };
  if (!validateTrustCustody(value).valid) fail();
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const v = value as TrustCustody;
  if (!exact(v, ['schema', 'entries']) || v.schema !== empty().schema || !Array.isArray(v.entries)) fail();
  const keys = new Set<string>(); let previous = '';
  for (const e of v.entries) {
    if (!e || typeof e !== 'object' || !exact(e, ['managementId','selectionId','operationId','pathKey','relativePath','format','outputSha256','recipeIdentity','sourceSetSha256','sources']) ||
        ![e.managementId,e.selectionId,e.operationId].every(x => typeof x === 'string' && id.test(x)) ||
        typeof e.pathKey !== 'string' || !e.pathKey || typeof e.relativePath !== 'string' || !e.relativePath ||
        !['pem','pkcs7-der','jks'].includes(e.format) || !hex.test(e.outputSha256) || !hex.test(e.sourceSetSha256) ||
        !/^sha256:[a-f0-9]{64}$/.test(e.recipeIdentity) || !Array.isArray(e.sources) || e.sources.length > 35) fail();
    const key = `${e.pathKey}\0${e.managementId}`; if (key < previous || keys.has(e.pathKey)) fail(); previous = key; keys.add(e.pathKey);
    let parsed: { home: string; segments: string[] };
    try { parsed = JSON.parse(e.pathKey); } catch { fail(); }
    if (canonicalJson(parsed!) !== e.pathKey || parsed!.home !== userHomeRoot() || !Array.isArray(parsed!.segments) || parsed!.segments.join('/') !== e.relativePath ||
        e.relativePath.split('/').some(s => !s || s === '.' || s === '..' || /[\\:\p{Cc}\p{Cf}]/u.test(s)) ||
        e.relativePath.startsWith('.aih/core/') && !/^\.aih\/core\/content\/[a-f0-9]{64}\//.test(e.relativePath)) fail();
    const sourceIds = new Set<string>();
    for (const s of e.sources) {
      if (!s || typeof s !== 'object' || !exact(s, ['id','kind','fingerprints','sourceSha256','policySha256','runtimeVersion','privateFile']) ||
          !id.test(s.id.startsWith('supplied:') ? s.id.slice(9):s.id) || sourceIds.has(s.id) || !['os','supplied','node-bundled','jvm-baseline'].includes(s.kind) || !hex.test(s.sourceSha256) ||
          s.policySha256 !== null && !hex.test(s.policySha256) || s.runtimeVersion !== null && typeof s.runtimeVersion !== 'string' ||
          !Array.isArray(s.fingerprints) || !s.fingerprints.every(x => hex.test(x)) || canonicalJson([...new Set(s.fingerprints)].sort()) !== canonicalJson(s.fingerprints) ||
          (s.kind === 'supplied' || s.kind === 'jvm-baseline' ? typeof s.privateFile !== 'string' || s.privateFile.length > 4096 : s.privateFile !== null)) fail();
      sourceIds.add(s.id);
    }
  }
}
export function readTrustCustody(allowPending = false): TrustCustodyImage {
  if (!existsSync(stateRoot())) return { value: empty(), digest: null };
  try {
    pathPins(stateRoot());
    pathPins(join(stateRoot(),FILE)); pathPins(join(stateRoot(),INTENT));
    if (!allowPending && existsSync(join(stateRoot(), INTENT))) { protectState([INTENT]); throw new Error('trust-custody-pending'); }
    if (!existsSync(join(stateRoot(), FILE))) return { value: empty(), digest: null };
    protectState([FILE]); const bytes = stateFiles().read(FILE); if (!bytes) throw new Error('trust-custody-conflict');
    const value = parseStrictJsonObjectV1(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'trust custody'); validate(value);
    return { value, digest: sha256(bytes) };
  } catch (error) { if (error instanceof Error && error.message === 'trust-custody-pending') throw error; throw new Error('trust-custody-conflict'); }
}
export function guardTrustMember(root: string, path: string, allowed = false): void {
  const home = userHomeRoot(); const target = join(root,...path.split('/'));
  if (target !== home && !target.startsWith(home + (process.platform === 'win32' ? '\\':'/'))) return;
  const image = readTrustCustody(true);
  if (!allowed && image.value.entries.some(e => nativeTrustPathEquivalent(join(home, ...e.relativePath.split('/')),target))) throw new Error('new-custody-legacy-request');
  if (!allowed && existsSync(join(stateRoot(),INTENT))) {
    protectState([INTENT]); const bytes = stateFiles().read(INTENT); if (!bytes) throw new Error('trust-custody-conflict');
    const intent = parseStrictJsonObjectV1(bytes.toString('utf8'),'trust intent') as { outputs?: { pathKey?: string }[] };
    if (!Array.isArray(intent.outputs)) throw new Error('trust-custody-conflict');
    for (const output of intent.outputs) {
      const key = JSON.parse(output.pathKey!) as { home:string; segments:string[] };
      if (nativeTrustPathEquivalent(join(key.home,...key.segments),target)) throw new Error('trust-custody-pending');
    }
  }
}
function encoded(value: TrustCustody): Buffer {
  value.entries.sort((a, b) => a.pathKey < b.pathKey ? -1 : a.pathKey > b.pathKey ? 1 : a.managementId.localeCompare(b.managementId));
  const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > LIMIT) throw new Error('custody-record-limit'); validate(value); return bytes;
}
/** Stage bounded references before effects; commit each output only after genuine ownership. */
export function custodyParticipant(image: TrustCustodyImage, updates: TrustCustodyEntry[], recheck: () => void | Promise<void>, removals: TrustCustodyEntry[] = []): TrustEngineParticipant {
  let next = image.value; let staged = false; let begun = false; let prefix = ''; let expected = image.digest;
  const affected = [...updates, ...removals]; const home = userHomeRoot();
  let retiring: TrustCustodyEntry[] = [];
  const ownerFor = (entry: TrustCustodyEntry) => {
    const absolute = join(home,...entry.relativePath.split('/'));
    const root = entry.relativePath.startsWith('.aih/core/content/') ? dirname(absolute):home;
    return readOwnership(root).value.members[memberKey({kind:'file',path:root === home ? entry.relativePath:entry.relativePath.split('/').at(-1)!})];
  };
  const participant: TrustEngineParticipant = {
    exactReplacement: true, lockRoot: join(stateRoot(), 'trust-custody'),
    allows(root, path) { return affected.some(e => join(home, ...e.relativePath.split('/')) === join(root, ...path.split('/'))); },
    async recheck() {
      try { if (readTrustCustody().digest !== image.digest) throw new Error('review-stale'); }
      catch { throw new Error('review-stale'); }
      await recheck();
    },
    preflight(steps: readonly TrustEngineStep[], _ownership: ReadonlyMap<string, { value: Ownership; digest: string | null }>) {
      for (const update of updates) {
        const step = steps.find(s => s.root && s.path && join(s.root, ...s.path.split('/')) === join(home, ...update.relativePath.split('/')) && s.review.id === `${update.selectionId}/${update.operationId}`);
        if (!step || !step.after || sha256(step.after) !== update.outputSha256) throw new Error('trust-custody-conflict');
        update.recipeIdentity = step.recipeIdentity;
      }
      const union = { ...image.value, entries: image.value.entries.filter(e => !updates.some(u => u.pathKey === e.pathKey)).concat(updates) };
      // Shared members keep provenance. Only a final removal or a verified orphan retires it.
      retiring = removals.filter(entry => steps.some(step => step.root && step.path && step.after === null &&
        join(step.root,...step.path.split('/')) === join(home,...entry.relativePath.split('/'))) ||
        !ownerFor(entry) && !existsSync(join(home,...entry.relativePath.split('/'))));
      encoded(union); next = { ...union, entries: union.entries.filter(e => !retiring.some(r => r.pathKey === e.pathKey)) }; encoded(next);
      const intentBound = { schema:'urn:aihq:core:trust-intent:1.0.0',transactionId:'0'.repeat(36),
        outputs:affected.map(e => ({pathKey:e.pathKey,oldSha256:'0'.repeat(64),newSha256:'0'.repeat(64)})),
        before:`recovery/${'0'.repeat(36)}/trust-before.json`,after:`recovery/${'0'.repeat(36)}/trust-after.json`,recovery:`recovery/${'0'.repeat(36)}/manifest.json` };
      if (Buffer.byteLength(JSON.stringify(intentBound)) > LIMIT) throw new Error('custody-record-limit');
    },
    stage(runId, recovery) {
      prefix = `recovery/${runId}/trust`; protectState([FILE, INTENT, `recovery/${runId}`]);
      const files = stateFiles(); const priorBytes=files.read(FILE); const old = priorBytes ?? encoded(image.value); const newer = encoded(next);
      if ((priorBytes ? sha256(priorBytes):null) !== image.digest) throw new Error('review-stale');
      files.writeAtomic(`${prefix}-before.json`, old, 0o600, true);
      files.writeAtomic(`${prefix}-after.json`, newer, 0o600, true);
      const intent = { schema: 'urn:aihq:core:trust-intent:1.0.0', transactionId: runId,
        outputs: affected.map(e => ({ pathKey: e.pathKey, oldSha256: image.value.entries.find(old => old.pathKey === e.pathKey)?.outputSha256 ?? null,
          newSha256: updates.find(u => u.pathKey === e.pathKey)?.outputSha256 ?? null })),
        before: `${prefix}-before.json`, after: `${prefix}-after.json`, recovery: recovery ?? null };
      const bytes = Buffer.from(JSON.stringify(intent)); if (bytes.length > LIMIT) throw new Error('custody-record-limit');
      files.writeAtomic(INTENT, bytes, 0o600, true); staged = true;
    },
    committed(step) {
      if (!step.root || !step.path || !affected.some(e => join(home, ...e.relativePath.split('/')) === join(step.root!, ...step.path!.split('/')))) return;
      begun = true; const ownership = readOwnership(step.root).value;
      for (const entry of updates.filter(e => join(home, ...e.relativePath.split('/')) === join(step.root!, ...step.path!.split('/')))) {
        if (entry.selectionId === 'export' && resolveTrustPath(entry.relativePath,entry.format,[entry]).pathKey !== entry.pathKey) throw new Error('output-path-alias');
        const owner = ownership.members[memberKey({kind:'file',path:step.path})];
        if (!owner || owner.managementId !== entry.managementId || owner.recipeIdentity !== entry.recipeIdentity || owner.sha256 !== entry.outputSha256 ||
            owner.claims?.some(c => c.managementId !== entry.managementId)) throw new Error('trust-custody-conflict');
        const bytes = stateFiles().read(FILE); if ((bytes ? sha256(bytes) : null) !== expected) throw new Error('trust-custody-conflict');
        const published: TrustCustody = { ...image.value, entries: image.value.entries.filter(e => e.pathKey !== entry.pathKey).concat(entry) };
        const record = encoded(published); stateFiles().writeAtomic(FILE, record, 0o600); expected = sha256(record); image = { value: published, digest: image.digest };
      }
      for (const entry of retiring.filter(e => join(home, ...e.relativePath.split('/')) === join(step.root!, ...step.path!.split('/')))) {
        if (ownership.members[memberKey({kind:'file',path:step.path})] || existsSync(join(home, ...entry.relativePath.split('/')))) throw new Error('trust-custody-conflict');
        const before = stateFiles().read(FILE); if ((before ? sha256(before):null) !== expected) throw new Error('trust-custody-conflict');
        image.value.entries = image.value.entries.filter(e => e.pathKey !== entry.pathKey);
        const record = encoded(image.value); stateFiles().writeAtomic(FILE, record, 0o600); expected = sha256(record);
      }
    },
    finish(result: RunResult) {
      if (!staged) return;
      if (result.completion !== 'complete') {
        if (!begun && result.operations.every(o => o.application === 'not-attempted')) {
          stateFiles().remove(INTENT); stateFiles().remove(`${prefix}-before.json`); stateFiles().remove(`${prefix}-after.json`);
        }
        return;
      }
      // Metadata-only orphan cleanup has no output step and verifies absence again.
      for (const entry of retiring) if (ownerFor(entry) || existsSync(join(home, ...entry.relativePath.split('/')))) throw new Error('trust-custody-conflict');
      for (const entry of updates) {
        const owner = ownerFor(entry); const bytes = readRegularFile(join(home,...entry.relativePath.split('/')),{maxBytes:12*1024*1024});
        if (!owner || owner.managementId !== entry.managementId || owner.recipeIdentity !== entry.recipeIdentity || owner.sha256 !== entry.outputSha256 ||
          owner.claims?.some(c => c.managementId !== entry.managementId) || !bytes || sha256(bytes) !== entry.outputSha256) throw new Error('trust-custody-conflict');
      }
      const actual = stateFiles().read(FILE);
      if ((actual ? sha256(actual):null) !== expected) throw new Error('trust-custody-conflict');
      if (!begun && retiring.length) { stateFiles().writeAtomic(FILE, encoded(next), 0o600); }
      stateFiles().remove(INTENT); stateFiles().remove(`${prefix}-before.json`); stateFiles().remove(`${prefix}-after.json`);
    }
  };
  return participant;
}
