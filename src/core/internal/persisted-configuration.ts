import { X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { persistedConfigurationMembers } from '../../harness/runtime.mjs';
import { fileTransaction, sha256, userHomeRoot } from './host-files.js';
import { memberBytes, memberKey, type MemberDescriptor } from './recipe-lifecycle.js';
import { renderTextBlock } from './recipe-editors.js';
import { readOwnershipBatch, stateRoot, type Owner, type Ownership } from './state.js';
import { transaction } from '../recipe-engine.js';

export interface PersistedConfigurationValue {
  id: string;
  repair: string;
  managementId: string;
  member: { path: string; blockId: string };
  state: 'applied' | 'removed' | 'modified' | 'unowned';
  value?: string;
  certificates?: number;
  materialSha256?: string;
}
/** Applied material as the Harness descriptor names its effect; Core attaches no meaning to it. */
export interface PersistedMaterial { effect: string; certificates: string[] }
export interface PersistedConfiguration { values: PersistedConfigurationValue[]; material: PersistedMaterial[] }

type BlockMember = Extract<MemberDescriptor, { kind: 'block' }>;
type Material = { state: 'removed' | 'modified' | 'unowned' } | { state: 'applied'; sha256: string; certificates: string[] };
const MAX_CERTIFICATES = 1024;
const MATERIAL_BYTES = 16 * 1024 * 1024;

/** True when the owner is Core's own record of this managed selection (a legacy owner has no claims). */
function claimed(owner: Owner | undefined, managementId: string): owner is Owner {
  return !!owner && owner.managementId === managementId &&
    (!owner.claims || owner.claims.some(claim => claim.managementId === managementId && claim.scope === 'user'));
}
const own = <T>(record: Record<string, T>, key: string): T | undefined => Object.hasOwn(record, key) ? record[key] : undefined;

function certificates(bytes: Buffer): string[] | undefined {
  const found: string[] = [];
  for (const match of bytes.toString('utf8').matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)) {
    if (found.length >= MAX_CERTIFICATES) return undefined;
    try { found.push(new X509Certificate(match[0]).toString()); } catch { return undefined; }
  }
  return found.length ? found : undefined;
}

/** The managed material as custody records it: present, claimed, byte-identical and made of certificates. */
function readMaterial(root: string, name: string, managementId: string, ownership: Ownership): Material {
  const live = transaction(root).inspect(name);
  if (live.state === 'absent') return { state: 'removed' };
  if (live.state !== 'present') return { state: 'modified' };
  const owner = own(ownership.members, memberKey({ path: name, kind: 'file' }));
  if (!claimed(owner, managementId)) return { state: 'unowned' };
  const list = live.bytes.byteLength <= MATERIAL_BYTES && sha256(live.bytes) === owner.sha256 ? certificates(live.bytes) : undefined;
  return list ? { state: 'applied', sha256: owner.sha256, certificates: list } : { state: 'modified' };
}

/**
 * Evaluate only the blocks the shipped Harness repair persists, against Core custody. Read-only: it writes no
 * state, lock or history, and nothing else in the profile or npm configuration is read as configuration.
 */
export function readPersistedConfiguration(): PersistedConfiguration {
  const home = userHomeRoot();
  const state = stateRoot();
  const members = persistedConfigurationMembers();
  const contentRoot = (managementId: string) => join(state, 'content', sha256(`${home}\0user\0${managementId}`));
  // One protected-store check covers the home and every managed content root.
  const receipts = readOwnershipBatch([home, ...new Set(members.map(item => contentRoot(item.managementId)))]);
  const ownership = receipts.get(home)!.value;
  const files = fileTransaction(home, state);
  const materials = new Map<string, Material>();
  const values: PersistedConfigurationValue[] = [];
  const material: PersistedMaterial[] = [];
  for (const item of members) {
    const descriptor: BlockMember = { ...item.member };
    const owner = own(ownership.members, memberKey(descriptor));
    const live = files.inspect(descriptor.path);
    // null: no managed markers; undefined: the markers cannot be read unambiguously.
    let block: Buffer | null | undefined = null;
    if (live.state === 'present') { try { block = memberBytes(descriptor, live.bytes); } catch { block = undefined; } }
    else if (live.state === 'unreadable') block = undefined;
    const summary = { id: item.id, repair: item.repair, managementId: item.managementId,
      member: { path: descriptor.path, blockId: descriptor.blockId } };
    const report = (outcome: PersistedConfigurationValue['state']) => { values.push({ ...summary, state: outcome }); };
    if (!claimed(owner, item.managementId)) {
      if (block !== null && live.state === 'present') report('unowned');
      continue;
    }
    if (block === null) { report('removed'); continue; }
    const root = contentRoot(item.managementId);
    const materialKey = `${item.managementId}\0${item.materialName}`;
    if (!materials.has(materialKey)) materials.set(materialKey, readMaterial(root, item.materialName, item.managementId, receipts.get(root)!.value));
    const read = materials.get(materialKey)!;
    const materialPath = join(root, item.materialName);
    const expected = item.content(materialPath);
    // The block is judged by its own bytes and line endings, independent of the rest of the file.
    if (block === undefined || block === null || sha256(block) !== owner.sha256 || expected === undefined ||
        !renderTextBlock(block, { ...descriptor, action: 'set', content: expected })?.equals(block)) {
      report('modified'); continue;
    }
    if (read.state !== 'applied') { report(read.state); continue; }
    values.push({ ...summary, state: 'applied', value: materialPath,
      certificates: read.certificates.length, materialSha256: read.sha256 });
    material.push({ effect: item.effect, certificates: read.certificates });
  }
  return { values, material };
}
