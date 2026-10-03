import { canonicalJson } from './canonical.js';
import { sha256, validSegment, userHomeRoot } from './host-files.js';
import { configMemberBytes, blockMemberBytes, renderConfigEntries, renderTextBlock } from './recipe-editors.js';
export interface Claim { managementId: string; scope: 'project' | 'user'; sets: string[]; requires: string[] }
export interface HookSelector { path: (string | number)[]; valueSha256: string }
export type HookDescriptor = { path: string; kind: 'hook'; format: 'json' | 'jsonc'; container: string[]; groupId: string; selector: HookSelector };
export type MemberDescriptor = { path: string; kind: 'file' } | HookDescriptor |
  { path: string; kind: 'entry'; format: 'json' | 'jsonc' | 'toml'; entry: string[] } |
  { path: string; kind: 'block'; blockId: string; startMarker: string; endMarker: string };
export function memberKey(member: MemberDescriptor): string {
  if (member.kind === 'file') return process.platform === 'win32' ? member.path.toLowerCase() : member.path;
  // The selector is deliberately outside identity: a changed selector under one group ID is detected, not re-keyed.
  if (member.kind === 'hook') return 'member:' + sha256(canonicalJson({ path: process.platform === 'win32' ? member.path.toLowerCase() : member.path,
    kind: member.kind, format: member.format, container: member.container, groupId: member.groupId }));
  return 'member:' + sha256(canonicalJson({ ...member, path: process.platform === 'win32' ? member.path.toLowerCase() : member.path }));
}
/** Whole-file, entry and block members only: a hook member is decided by `decideHookStep` / `decideHookCleanup`, never by raw member bytes. */
export type ByteMember = Exclude<MemberDescriptor, HookDescriptor>;
export function memberBytes(member: ByteMember, bytes: Buffer | null): Buffer | null {
  if (member.kind === 'file') return bytes;
  if (member.kind === 'entry') return configMemberBytes(member.format, bytes, member.entry);
  return blockMemberBytes(bytes, { ...member, action: 'remove' });
}
export function subtractMember(member: ByteMember, bytes: Buffer | null): Buffer | null {
  if (member.kind === 'file') return null;
  if (member.kind === 'entry') return bytes === null ? null : renderConfigEntries(member.format, bytes, [{ path: member.entry, action: 'remove' }]);
  return renderTextBlock(bytes, { ...member, action: 'remove' });
}

export function validDescriptor(value: unknown): value is MemberDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const member = value as MemberDescriptor;
  if (typeof member.path !== 'string' || member.path.length > 4096 || member.path.split('/').some(part => !validSegment(part))) return false;
  const keys = member.kind === 'file' ? ['path', 'kind'] : member.kind === 'entry' ? ['path', 'kind', 'format', 'entry'] :
    member.kind === 'hook' ? ['path', 'kind', 'format', 'container', 'groupId', 'selector'] : ['path', 'kind', 'blockId', 'startMarker', 'endMarker'];
  if (Object.keys(member).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(member, key))) return false;
  if (member.kind === 'hook') return validHook(member);
  try {
    if (member.kind === 'entry') { renderConfigEntries(member.format, null, [{ path: member.entry, action: 'set', value: true }]); return true; }
    if (member.kind === 'block') { renderTextBlock(null, { ...member, action: 'remove' }); return true; }
    return member.kind === 'file';
  } catch { return false; }
}


const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function validHook(member: HookDescriptor): boolean {
  const selector = member.selector as unknown;
  // The recipe schema bounds strings in code points (Ajv), so custody must too or an admitted recipe could never be written.
  const sound = (value: unknown, bound: number): value is string => typeof value === 'string' && value.length > 0 && [...value].length <= bound && !/[\p{Cc}\p{Cf}]/u.test(value);
  return ['json', 'jsonc'].includes(member.format) && Array.isArray(member.container) && member.container.length >= 1 && member.container.length <= 32 &&
    member.container.every(part => sound(part, 256)) && typeof member.groupId === 'string' && idPattern.test(member.groupId) &&
    !!selector && typeof selector === 'object' && !Array.isArray(selector) &&
    Object.keys(selector).length === 2 && Object.hasOwn(selector, 'path') && Object.hasOwn(selector, 'valueSha256') &&
    Array.isArray(member.selector.path) && member.selector.path.length >= 1 && member.selector.path.length <= 16 &&
    member.selector.path.every(part => typeof part === 'number' ? Number.isSafeInteger(part) && part >= 0 && part <= 1023 : sound(part, 256)) &&
    typeof member.selector.valueSha256 === 'string' && /^[a-f0-9]{64}$/.test(member.selector.valueSha256);
}
export function claimIdentity(scope: 'project' | 'user', managementId: string, project: string): string {
  const anchor = scope === 'project' ? project : userHomeRoot();
  return `${scope}:${sha256(process.platform === 'win32' ? anchor.toLowerCase() : anchor)}:${managementId}`;
}
export function overlappingMembers(a: MemberDescriptor, b: MemberDescriptor, bytes?: Buffer | null): boolean {
  const samePath = process.platform === 'win32' ? a.path.toLowerCase() === b.path.toLowerCase() : a.path === b.path;
  if (!samePath) return false;
  if (a.kind === 'file' || b.kind === 'file') return true;
  const prefix = (outer: string[], inner: string[]) => outer.length <= inner.length && outer.every((part, index) => part === inner[index]);
  if (a.kind === 'hook' && b.kind === 'hook') return a.format !== b.format || prefix(a.container, b.container) && a.container.length !== b.container.length || prefix(b.container, a.container) && a.container.length !== b.container.length;
  if (a.kind === 'hook' && b.kind === 'entry') return prefix(b.entry, a.container) || prefix(a.container, b.entry);
  if (a.kind === 'entry' && b.kind === 'hook') return prefix(a.entry, b.container) || prefix(b.container, a.entry);
  if (a.kind === 'entry' && b.kind === 'entry') return a.entry.slice(0, b.entry.length).join('\0') === b.entry.join('\0') || b.entry.slice(0, a.entry.length).join('\0') === a.entry.join('\0');
  if (a.kind === 'block' && b.kind === 'block') {
    if (a.blockId === b.blockId || [a.startMarker, a.endMarker].some(marker => [b.startMarker, b.endMarker].includes(marker))) return true;
    if (!bytes) return false;
    // The editor first validates exact, unambiguous marker lines. Measure the
    // complete removed byte range, including the closing line separator.
    const range = (member: Extract<MemberDescriptor, { kind: 'block' }>): [number, number] | null => {
      const owned = memberBytes(member, bytes); if (!owned) return null;
      const start = bytes.indexOf(Buffer.from(member.startMarker));
      return [start, start + owned.byteLength];
    };
    const left = range(a), right = range(b);
    return !!left && !!right && left[0] < right[1] && right[0] < left[1];
  }
  return true;
}

export function validClaim(value: unknown): value is Claim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claim = value as Claim;
  const id = (value: unknown) => typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
  return Object.keys(claim).length === 4 && Object.keys(claim).every(key => ['managementId', 'scope', 'sets', 'requires'].includes(key)) &&
    id(claim.managementId) && ['project', 'user'].includes(claim.scope) && Array.isArray(claim.sets) && claim.sets.length <= 4096 &&
    new Set(claim.sets).size === claim.sets.length && claim.sets.every(id) && Array.isArray(claim.requires) && claim.requires.length <= 4096 &&
    new Set(claim.requires).size === claim.requires.length && claim.requires.every(id => typeof id === 'string' && id.length <= 206 && /^(project|user):[a-f0-9]{64}:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id));
}
