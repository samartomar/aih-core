// Displaced claims (C61, C64, C75): after a reviewed replace of a value other claims share, those claims hold nothing
// on disk. The member keeps one record of the value they share, so removing the overriding install can write it back:
// one level of restore, never an undo stack. A secret written by value is never kept: its slot holds the binding's
// template and is filled again from the removal's private inputs.
import { renderConfigEntries, decode, configMemberBytes, blockMemberBytes, parsedObject } from './recipe-editors.js';
import { tomlMember, restoreTomlText, tomlTableCustody, type TomlTableCustody } from './toml-editor.js';
import { validClaim, type Claim, type MemberDescriptor } from './recipe-lifecycle.js';
import { findNodeAtLocation } from 'jsonc-parser';

/** One secret slot of a displaced value: where it is inside the member, which item input fills it, and its template. */
export interface DisplacedSecret { path: string[]; item: string; input: string; template: string }
/** The value the displaced claims share, with the owner facts it had while they held it. */
export interface DisplacedValue {
  managementId: string; recipeIdentity: string; sha256: string; claims: Claim[];
  /** The member's exact text, every secret slot holding its template instead of the secret. */
  text: string;
  secrets?: DisplacedSecret[];
  /** The holder's own owner facts, given back with its value: never the overriding install's. */
  facts?: DisplacedFacts;
}
/** Owner facts an entry or block member may hold of its own (what Core created for it). */
export interface DisplacedFacts { createdFile?: true; tomlTable?: TomlTableCustody; sharedContent?: string }
/** The facts of `owner` a displaced record keeps; `undefined` when it has none. */
export function displacedFacts(owner: DisplacedFacts): DisplacedFacts | undefined {
  const facts: DisplacedFacts = { ...(owner.createdFile ? { createdFile: true as const } : {}), ...(owner.tomlTable ? { tomlTable: owner.tomlTable } : {}),
    ...(owner.sharedContent !== undefined ? { sharedContent: owner.sharedContent } : {}) };
  return Object.keys(facts).length ? facts : undefined;
}
function validFacts(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const f = value as Record<string, unknown>;
  return Object.keys(f).length > 0 && Object.keys(f).every(key => ['createdFile', 'tomlTable', 'sharedContent'].includes(key)) &&
    (f.createdFile === undefined || f.createdFile === true) &&
    (f.tomlTable === undefined || (tomlTableCustody as readonly unknown[]).includes(f.tomlTable)) &&
    (f.sharedContent === undefined || typeof f.sharedContent === 'string' && f.sharedContent.length <= TEXT_BOUND);
}
/** A secret slot an install recorded (C59): the file, the full editor path, the item input and the slot's template. */
export interface SecretSlot { file: string; path: string[]; item: string; input: string; template: string }

const TEXT_BOUND = 65536;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const segment = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;

export function validDisplaced(value: unknown): value is DisplacedValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  if (Object.keys(d).some(key => !['managementId', 'recipeIdentity', 'sha256', 'claims', 'text', 'secrets', 'facts'].includes(key))) return false;
  if (d.facts !== undefined && !validFacts(d.facts)) return false;
  if (typeof d.managementId !== 'string' || typeof d.recipeIdentity !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(d.recipeIdentity) ||
      typeof d.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(d.sha256) || typeof d.text !== 'string' || d.text.length > TEXT_BOUND) return false;
  if (!Array.isArray(d.claims) || !d.claims.length || d.claims.length > 4096 || !d.claims.every(validClaim) ||
      new Set((d.claims as Claim[]).map(claim => `${claim.scope}:${claim.managementId}`)).size !== d.claims.length) return false;
  return d.secrets === undefined || Array.isArray(d.secrets) && d.secrets.length > 0 && d.secrets.length <= 64 && d.secrets.every(secret =>
    !!secret && typeof secret === 'object' && !Array.isArray(secret) && Object.keys(secret).length === 4 &&
    Array.isArray(secret.path) && secret.path.length <= 32 && secret.path.every(segment) && ID.test(secret.item) && ID.test(secret.input) &&
    typeof secret.template === 'string' && secret.template.length <= 4096 && secret.template.includes(`{${secret.input}}`));
}

/** A TOML value's text as the editor writes it. */
function tomlValueText(value: string): string {
  return tomlMember(renderConfigEntries('toml', null, [{ path: ['v'], action: 'set', value }]), ['v'])!.toString('utf8');
}
const under = (path: string[], prefix: string[]) => prefix.length <= path.length && prefix.every((part, index) => part === path[index]);
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * The record of a member's current text for its displaced claims, with the recorded secret slots inside it set to their
 * templates. `undefined` when the value can't be kept without its secret (a secret inside a block, or inside a TOML
 * array), so the replace is not offered.
 */
export function displacedText(descriptor: MemberDescriptor, raw: Buffer, slots: readonly SecretSlot[]): { text: string; secrets?: DisplacedSecret[] } | undefined {
  if (descriptor.kind !== 'entry' && descriptor.kind !== 'block') return undefined;
  const inside = slots.filter(slot => samePath(slot.file, descriptor.path) && (descriptor.kind === 'block' || under(slot.path, descriptor.entry)));
  let text = decode(raw);
  if (text.length > TEXT_BOUND) return undefined;
  if (!inside.length) return { text };
  if (descriptor.kind !== 'entry') return undefined;
  const secrets: DisplacedSecret[] = [];
  for (const slot of inside) {
    const relative = slot.path.slice(descriptor.entry.length);
    if (descriptor.format === 'toml') { if (relative.length) return undefined; text = tomlValueText(slot.template); }
    else if (descriptor.format === 'json' || descriptor.format === 'jsonc')
      text = relative.length ? renderConfigEntries('jsonc', Buffer.from(text, 'utf8'), [{ path: relative, action: 'set', value: slot.template }]).toString('utf8') :
        JSON.stringify(slot.template);
    else return undefined;
    secrets.push({ path: relative, item: slot.item, input: slot.input, template: slot.template });
  }
  return { text, secrets };
}

/** The secrets a restore needs, in order: `undefined` value means the removal's private inputs lack it. */
export function displacedInputs(value: DisplacedValue): { item: string; input: string }[] {
  return (value.secrets ?? []).map(secret => ({ item: secret.item, input: secret.input }));
}

/** The displaced member's text with every secret filled again; `undefined` when a secret is missing. */
export function restoredText(descriptor: MemberDescriptor, value: DisplacedValue, secret: (item: string, input: string) => string | undefined): string | undefined {
  let text = value.text;
  for (const slot of value.secrets ?? []) {
    const found = secret(slot.item, slot.input);
    if (found === undefined) return undefined;
    const filled = slot.template.split(`{${slot.input}}`).join(found);
    if (descriptor.kind === 'entry' && descriptor.format === 'toml') text = tomlValueText(filled);
    else text = slot.path.length ? renderConfigEntries('jsonc', Buffer.from(text, 'utf8'), [{ path: slot.path, action: 'set', value: filled }]).toString('utf8') :
      JSON.stringify(filled);
  }
  return text;
}

/** `current` with the member's text replaced by `text`, every other byte kept; `null` when the member isn't there. */
export function spliceMember(descriptor: MemberDescriptor, current: Buffer, text: string): Buffer | null {
  if (descriptor.kind === 'block') {
    const edit = { blockId: descriptor.blockId, startMarker: descriptor.startMarker, endMarker: descriptor.endMarker, action: 'remove' as const };
    const now = blockMemberBytes(current, edit);
    if (now === null) return null;
    const whole = decode(current); const start = whole.indexOf(descriptor.startMarker);
    return Buffer.from(whole.slice(0, start) + text + whole.slice(start + now.toString('utf8').length), 'utf8');
  }
  if (descriptor.kind !== 'entry') return null;
  if (descriptor.format === 'toml') return restoreTomlText(current, descriptor.entry, text);
  if (descriptor.format !== 'json' && descriptor.format !== 'jsonc') return null;
  if (configMemberBytes(descriptor.format, current, descriptor.entry) === null) return null;
  const whole = decode(current);
  const node = findNodeAtLocation(parsedObject(whole, descriptor.format), descriptor.entry);
  if (!node) return null;
  const output = whole.slice(0, node.offset) + text + whole.slice(node.offset + node.length);
  parsedObject(output, descriptor.format);
  return Buffer.from(output, 'utf8');
}
