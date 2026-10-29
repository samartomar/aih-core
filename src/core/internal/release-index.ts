// The consumer's release index, as the inventory and the prepared-work 1.7.0 Apply re-check read it. Core never reads a
// Catalog or index itself; a missing index or identity reads `unknown`.
import type { CatalogItemRef, SelectionMetadata } from '../types.js';

/** Consumer-supplied index and supersession data; Core never reads a Catalog itself. */
export interface ManagedInventoryIndex {
  /** Every item version the index currently offers. */
  offered: SelectionMetadata['item'][];
  /** Revoked items; identities, when given, narrow the revocation to that exact version. */
  revoked?: (CatalogItemRef & { contentSha256?: string; behaviourSha256?: string })[];
  superseded?: { item: CatalogItemRef; by: CatalogItemRef }[];
}
export type ReleaseIndexStatus = 'current' | 'update-available' | 'no-longer-offered' | 'superseded' | 'revoked' | 'unknown';
const isHex = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isId = (value: unknown): boolean => typeof value === 'string' && value.length > 0 && value.length <= 128;
const isRef = (value: unknown, identities: 'required' | 'optional' | 'none'): boolean => {
  const keys = ['framework', 'itemId', ...(identities === 'required' ? ['contentSha256', 'behaviourSha256'] : [])];
  const optional = identities === 'optional' ? ['contentSha256', 'behaviourSha256'] : [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return keys.every(key => Object.hasOwn(record, key)) && Object.keys(record).every(key => keys.includes(key) || optional.includes(key)) &&
    isId(record.framework) && isId(record.itemId) && [...keys, ...optional].slice(2).every(key => record[key] === undefined || isHex(record[key]));
};
export function validIndex(value: unknown): value is ManagedInventoryIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const index = value as Record<string, unknown>;
  const list = (entry: unknown, check: (item: unknown) => boolean) => Array.isArray(entry) && entry.length <= 65536 && entry.every(check);
  return Object.keys(index).every(key => ['offered', 'revoked', 'superseded'].includes(key)) && list(index.offered, item => isRef(item, 'required')) &&
    (index.revoked === undefined || list(index.revoked, item => isRef(item, 'optional'))) &&
    (index.superseded === undefined || list(index.superseded, item => !!item && typeof item === 'object' && !Array.isArray(item) &&
      Object.keys(item).length === 2 && isRef((item as { item: unknown }).item, 'none') && isRef((item as { by: unknown }).by, 'none')));
}

const same = (a: CatalogItemRef, b: CatalogItemRef) => a.framework === b.framework && a.itemId === b.itemId;
/** Derived only from the consumer's index; without an index or a recorded identity the state is unknown. */
export function releaseIndexStatus(item: SelectionMetadata['item'] | null, index: ManagedInventoryIndex | undefined): ReleaseIndexStatus {
  if (!item || !index) return 'unknown';
  if (index.revoked?.some(entry => same(entry, item) && (entry.contentSha256 === undefined || entry.contentSha256 === item.contentSha256) &&
    (entry.behaviourSha256 === undefined || entry.behaviourSha256 === item.behaviourSha256))) return 'revoked';
  if (index.superseded?.some(entry => same(entry.item, item))) return 'superseded';
  const offered = index.offered.filter(entry => same(entry, item));
  if (!offered.length) return 'no-longer-offered';
  return offered.some(entry => entry.contentSha256 === item.contentSha256 && entry.behaviourSha256 === item.behaviourSha256) ? 'current' : 'update-available';
}
