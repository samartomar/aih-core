import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from './canonical.js';
import { parseStrictJsonObjectV1 } from './strict-json.js';
import { pathPins, pinsMatch, sha256, userHomeRoot, type PathPin } from './host-files.js';
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
interface PendingIntent { schema: string; transactionId: string; outputs: {pathKey:string;oldSha256:string|null;newSha256:string|null}[];
  before:string;after:string;recovery:string|null;beforeSha256?:string;afterSha256?:string;contexts?:{reference:string;sha256:string}[] }
export interface TrustPendingImage { intent:PendingIntent;bytes:Buffer;digest:string;before:TrustCustody;after:TrustCustody;
  beforeSha256:string;afterSha256:string;pins:PathPin[];liveSha256:string;contextSha256:string;requiredContexts:{reference:string;sha256:string}[] }
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
/** Compatible ordinary member lookup; new path identity is kept in pathKey. */
export function trustMemberLocation(entry: TrustCustodyEntry) {
  const home=userHomeRoot(),absolute=join(home,...entry.relativePath.split('/'));
  const root=entry.relativePath.startsWith('.aih/core/content/')?dirname(absolute):home;
  return {absolute,root,path:root===home?entry.relativePath:entry.relativePath.split('/').at(-1)!};
}
export function readTrustOwner(entry: TrustCustodyEntry) {
  const location=trustMemberLocation(entry),image=readOwnership(location.root);
  return {...location,image,owner:image.value.members[memberKey({kind:'file',path:location.path})]};
}
function pendingFrame(bytes:Buffer) {
    const intent=parseStrictJsonObjectV1(bytes.toString('utf8'),'trust intent') as unknown as PendingIntent;
    const keys=['schema','transactionId','outputs','before','after','recovery'];
    const digests=Object.hasOwn(intent,'beforeSha256')||Object.hasOwn(intent,'afterSha256');
    const contexts=Object.hasOwn(intent,'contexts');
    if(!exact(intent,[...keys,...(digests?['beforeSha256','afterSha256']:[]),...(contexts?['contexts']:[])])||intent.schema!=='urn:aihq:core:trust-intent:1.0.0'||
      typeof intent.transactionId!=='string'||!/^[a-f0-9-]{36}$/.test(intent.transactionId)||!Array.isArray(intent.outputs)||!intent.outputs.length||intent.outputs.length>4096||
      intent.before!==`recovery/${intent.transactionId}/trust-before.json`||intent.after!==`recovery/${intent.transactionId}/trust-after.json`||
      intent.recovery!==null&&intent.recovery!==`recovery/${intent.transactionId}/manifest.json`||
      digests&&(!hex.test(intent.beforeSha256!)||!hex.test(intent.afterSha256!))||
      contexts&&(!Array.isArray(intent.contexts)||intent.contexts.length>2*intent.outputs.length||
        new Set(intent.contexts.map(c=>c?.reference)).size!==intent.contexts.length||intent.contexts.some(c=>!c||!exact(c,['reference','sha256'])||
        typeof c.reference!=='string'||!/^recovery\/[a-f0-9-]{36}\/trust-(?:before|after)\.json$/.test(c.reference)||!hex.test(c.sha256)))) throw new Error();
    protectState([intent.before,intent.after]);
    const beforeBytes=stateFiles().read(intent.before),afterBytes=stateFiles().read(intent.after);if(!beforeBytes||!afterBytes) throw new Error();
    const beforeSha256=sha256(beforeBytes),afterSha256=sha256(afterBytes);
    if(digests&&(beforeSha256!==intent.beforeSha256||afterSha256!==intent.afterSha256)) throw new Error();
    const before=parseStrictJsonObjectV1(beforeBytes.toString('utf8'),'trust before');validate(before);
    const after=parseStrictJsonObjectV1(afterBytes.toString('utf8'),'trust after');validate(after);
    const seen=new Set<string>(),pins=[...pathPins(join(stateRoot(),intent.before)),...pathPins(join(stateRoot(),intent.after))];
    for(const output of intent.outputs) {
      if(!output||!exact(output,['pathKey','oldSha256','newSha256'])||typeof output.pathKey!=='string'||seen.has(output.pathKey)) throw new Error();
      seen.add(output.pathKey);const old=before.entries.find(e=>e.pathKey===output.pathKey),next=after.entries.find(e=>e.pathKey===output.pathKey);
      if(!old&&!next||output.oldSha256!==(old?.outputSha256??null)||output.newSha256!==(next?.outputSha256??null)) throw new Error();
    }
    const outside=(value:TrustCustody)=>value.entries.filter(e=>!seen.has(e.pathKey));
    if(canonicalJson(outside(before))!==canonicalJson(outside(after))) throw new Error();
    return {intent,before,after,beforeSha256,afterSha256,pins,digest:sha256(bytes)};
}
/** A protected journal is consistency evidence, never source or replay authority. */
export function readPendingTrust(image:TrustCustodyImage):TrustPendingImage|undefined {
  if(!existsSync(join(stateRoot(),INTENT))) return undefined;
  try {
    protectState([INTENT]);const bytes=stateFiles().read(INTENT);if(!bytes) throw new Error();
    const frame=pendingFrame(bytes),pins=[...pathPins(join(stateRoot(),INTENT)),...frame.pins];
    const {intent,before,after,beforeSha256,afterSha256}=frame;
    const keys=intent.outputs.map(o=>o.pathKey).sort();
    const snapshots=[{reference:intent.before,sha256:beforeSha256,value:before},{reference:intent.after,sha256:afterSha256,value:after}];
    for(const context of intent.contexts??[]) {
      protectState([context.reference]);pins.push(...pathPins(join(stateRoot(),context.reference)));
      const saved=stateFiles().read(context.reference);if(!saved||sha256(saved)!==context.sha256)throw new Error();
      const value=parseStrictJsonObjectV1(saved.toString('utf8'),'trust context');validate(value);snapshots.push({...context,value});
    }
    const contextEntries=snapshots.flatMap(s=>s.value.entries).filter(e=>keys.includes(e.pathKey));
    const live=[],requiredContexts=new Map<string,{reference:string;sha256:string}>();
    for(const output of intent.outputs) {
      const candidates=contextEntries.filter(e=>e.pathKey===output.pathKey),entry=candidates[0]!;
      const current=image.value.entries.find(e=>e.pathKey===output.pathKey);
      if(current&&!candidates.some(e=>canonicalJson(e)===canonicalJson(current))) throw new Error();
      if(!current&&before.entries.some(e=>e.pathKey===output.pathKey)&&after.entries.some(e=>e.pathKey===output.pathKey))throw new Error();
      const stored=readTrustOwner(entry);pins.push(...pathPins(stored.absolute));
      if(entry.selectionId==='export'&&resolveTrustPath(entry.relativePath,entry.format,[entry]).pathKey!==entry.pathKey) throw new Error();
      const material=readRegularFile(stored.absolute,{maxBytes:16*1024*1024});
      if(!material&&existsSync(stored.absolute)) throw new Error();
      const digest=material?sha256(material):null;
      if(digest!==null&&!candidates.some(e=>e.outputSha256===digest)||digest===null&&![output.oldSha256,output.newSha256].includes(null))throw new Error();
      if(candidates.some(e=>e.managementId!==entry.managementId))throw new Error();
      if(stored.owner&&(!candidates.some(e=>stored.owner!.managementId===e.managementId&&stored.owner!.recipeIdentity===e.recipeIdentity&&stored.owner!.sha256===e.outputSha256)||
        stored.owner.claims?.some(c=>c.managementId!==entry.managementId||c.scope!=='user')||stored.owner.claims&&stored.owner.claims.length>1)) throw new Error();
      live.push({pathKey:output.pathKey,sha256:digest,ownership:stored.image.digest});
      // Keep only identity context needed for current bytes and ordinary authority.
      // Historical source IDs never become active obligations through these refs.
      for(const predicate of [(e:TrustCustodyEntry)=>digest!==null&&e.outputSha256===digest,
        (e:TrustCustodyEntry)=>!!stored.owner&&e.recipeIdentity===stored.owner.recipeIdentity&&e.outputSha256===stored.owner.sha256]) {
        const snapshot=snapshots.find(s=>s.value.entries.some(e=>e.pathKey===output.pathKey&&predicate(e)));
        if(snapshot)requiredContexts.set(snapshot.reference,{reference:snapshot.reference,sha256:snapshot.sha256});
      }
    }
    const outside=(value:TrustCustody)=>value.entries.filter(e=>!keys.includes(e.pathKey));
    if(canonicalJson(outside(before))!==canonicalJson(outside(image.value)))throw new Error();
    return {intent,bytes,digest:sha256(bytes),before,after,beforeSha256,afterSha256,pins,liveSha256:sha256(canonicalJson(live)),requiredContexts:[...requiredContexts.values()],
      contextSha256:sha256(canonicalJson(snapshots.map(s=>({reference:s.reference,sha256:s.sha256}))))};
  } catch {throw new Error('trust-custody-conflict');}
}
export function pendingEntries(pending:TrustPendingImage):TrustCustodyEntry[] {
  return pending.intent.outputs.map(output=>pending.after.entries.find(e=>e.pathKey===output.pathKey)??pending.before.entries.find(e=>e.pathKey===output.pathKey)!);
}
function assertPending(pending:TrustPendingImage,image:TrustCustodyImage) {
  const current=readPendingTrust(image);
  if(!current||!pinsMatch(pending.pins)||current.digest!==pending.digest||current.beforeSha256!==pending.beforeSha256||current.afterSha256!==pending.afterSha256||
    current.liveSha256!==pending.liveSha256||current.contextSha256!==pending.contextSha256) throw new Error('review-stale');
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
export function custodyParticipant(image: TrustCustodyImage, updates: TrustCustodyEntry[], recheck: () => void | Promise<void>, removals: TrustCustodyEntry[] = [], pending?:TrustPendingImage): TrustEngineParticipant {
  let next = image.value; let staged = false; let begun = false; let prefix = ''; let expected = image.digest;let expectedIntent:string|undefined;
  const affected = [...updates, ...removals]; const home = userHomeRoot();
  let retiring: TrustCustodyEntry[] = [];
  const ownerFor = (entry: TrustCustodyEntry) => {
    return readTrustOwner(entry).owner;
  };
  const participant: TrustEngineParticipant = {
    exactReplacement: true, lockRoot: join(stateRoot(), 'trust-custody'),
    reviewBinding:sha256(canonicalJson({custody:image.digest,pending:pending?{digest:pending.digest,context:pending.contextSha256,live:pending.liveSha256}:null})),
    allows(root, path) { return affected.some(e => join(home, ...e.relativePath.split('/')) === join(root, ...path.split('/'))); },
    async recheck() {
      try { const current=readTrustCustody(!!pending);if(current.digest!==image.digest)throw new Error('review-stale');if(pending)assertPending(pending,current); }
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
        before:`recovery/${'0'.repeat(36)}/trust-before.json`,after:`recovery/${'0'.repeat(36)}/trust-after.json`,beforeSha256:'0'.repeat(64),afterSha256:'0'.repeat(64),recovery:`recovery/${'0'.repeat(36)}/manifest.json`,
        ...(pending?{contexts:pending.requiredContexts}:{}) };
      if (Buffer.byteLength(JSON.stringify(intentBound)) > LIMIT) throw new Error('custody-record-limit');
    },
    stage(runId, recovery) {
      if(pending)assertPending(pending,image);
      prefix = `recovery/${runId}/trust`; protectState([FILE, INTENT, `recovery/${runId}`]);
      const files = stateFiles(); const priorBytes=files.read(FILE); const old = priorBytes ?? encoded(image.value); const newer = encoded(next);
      if ((priorBytes ? sha256(priorBytes):null) !== image.digest) throw new Error('review-stale');
      files.writeAtomic(`${prefix}-before.json`, old, 0o600, true);
      files.writeAtomic(`${prefix}-after.json`, newer, 0o600, true);
      // Preserve the original intent and its original snapshots as recovery evidence.
      // Reconciliation executes only the newly reviewed recipe and sources.
      if(pending)files.writeAtomic(`${prefix}-reconciled-intent.json`,pending.bytes,0o600,true);
      const intent = { schema: 'urn:aihq:core:trust-intent:1.0.0', transactionId: runId,
        outputs: affected.map(e => ({ pathKey: e.pathKey, oldSha256: image.value.entries.find(old => old.pathKey === e.pathKey)?.outputSha256 ?? null,
          newSha256: updates.find(u => u.pathKey === e.pathKey)?.outputSha256 ?? null })),
        before: `${prefix}-before.json`, after: `${prefix}-after.json`,beforeSha256:sha256(old),afterSha256:sha256(newer), recovery: recovery ?? null,
        ...(pending?{contexts:pending.requiredContexts}:{}) };
      const bytes = Buffer.from(JSON.stringify(intent)); if (bytes.length > LIMIT) throw new Error('custody-record-limit');
      if(!pending||affected.every(e=>image.value.entries.some(old=>old.pathKey===e.pathKey)||next.entries.some(newer=>newer.pathKey===e.pathKey))) {
        files.writeAtomic(INTENT, bytes, 0o600, !pending);expectedIntent=sha256(bytes);
      } else expectedIntent=pending.digest; // Metadata-only cleanup retains the original evidence until verification.
      staged = true;
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
          if(pending)stateFiles().writeAtomic(INTENT,pending.bytes,0o600);else stateFiles().remove(INTENT);
          stateFiles().remove(`${prefix}-before.json`); stateFiles().remove(`${prefix}-after.json`);
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
      const actualIntent=stateFiles().read(INTENT);if(!actualIntent||sha256(actualIntent)!==expectedIntent)throw new Error('trust-custody-conflict');
      if (!begun && retiring.length) { stateFiles().writeAtomic(FILE, encoded(next), 0o600); }
      stateFiles().remove(INTENT); stateFiles().remove(`${prefix}-before.json`); stateFiles().remove(`${prefix}-after.json`);
    }
  };
  return participant;
}
