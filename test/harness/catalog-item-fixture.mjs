// Catalog release 1.7 item identities, as Catalog computes them, for tests that change a real item's declarations.
import { createHash } from 'node:crypto';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
/** Canonical JSON: sorted keys, no whitespace. */
export const canonicalJson = value => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}` : JSON.stringify(value);
/** The contentSha256 lines: one `<relPath>\t<sha256>\n` per content material, sorted. */
export const contentLines = members => members.map(member => `${member.relPath}\t${member.sha256}\n`).sort().join('');

/**
 * A real release 1.7 item with some declarations changed (`payload`, `dependencies`, `materials`), its behaviour file and
 * both identities recomputed so it is still a valid item.
 */
export function reidentified(item, changes) {
  const next = { ...item, ...changes };
  const content = next.materials.filter(member => member.role !== 'behaviour');
  const dependencies = { requires: next.dependencies?.requires ?? [], optional: next.dependencies?.optional ?? [],
    conflicts: next.dependencies?.conflicts ?? [] };
  const behaviour = { kind: next.kind, payload: next.payload ?? null, requirements: { inputs: next.requirements?.inputs ?? {} }, dependencies,
    executable: Object.fromEntries(content.map(member => [member.relPath, member.executable])) };
  const text = `${canonicalJson(behaviour)}\n`;
  const materials = next.materials.map(member => member.role === 'behaviour' ? { ...member, sha256: sha256(text), byteLength: Buffer.byteLength(text) } : member);
  const lines = contentLines(content);
  return { ...next, dependencies, materials, contentSha256: sha256(lines), behaviourSha256: sha256(canonicalJson({ ...behaviour, materials: lines })) };
}
