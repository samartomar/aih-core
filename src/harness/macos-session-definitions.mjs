// Portable finite definitions. Desktop profiles remain empty until native admission.
import { trustRepairIndex, validateRepairDefinition11 } from './trust-definitions.mjs';
import { macosSessionProfiles } from './macos-session-profiles.mjs';

export const repairDefinitionSchema12 = 'urn:aihq:harness:repair:1.2.0';
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
export const macosRepairIndex = freeze(trustRepairIndex.filter(row => row.id !== 'certificate-export').map(row => ({
  ...JSON.parse(JSON.stringify(row)), schema: repairDefinitionSchema12,
  variants: row.variants.map(variant => ({ ...JSON.parse(JSON.stringify(variant)), sessionProfileIds: variant.os === 'darwin'
    ? macosSessionProfiles.profiles.filter(profile => variant.capabilityIds.includes(profile.trustCellId)).map(profile => profile.id) : [] }))
})));

export function selectMacosRepairDefinition(query) {
  return query.requestSchema === 'urn:aihq:core:repair-request:1.1.0' && query.definitionSchema === repairDefinitionSchema12
    ? macosRepairIndex.find(row => row.id === query.repairId) : undefined;
}

// Descriptor reads avoid executing accessors while cloning public portable data.
function plainClone(value, depth = 0) {
  if (depth > 32) throw new Error();
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') throw new Error();
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string') || array && keys.filter(key => key !== 'length').length !== value.length) throw new Error();
  const result = array ? [] : {};
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error();
    Object.defineProperty(result, key, { value: plainClone(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return result;
}
export function validateRepairDefinition12(value, options = {}) {
  const bad = reason => ({ valid: false, diagnostics: [{ code: 'INPUT_INVALID', reason, message: 'Expected a bounded published macOS repair definition.', path: '' }] });
  try {
    const safe = plainClone(value);
    if (new TextEncoder().encode(JSON.stringify(safe)).length > 1_000_000 || safe.schema !== repairDefinitionSchema12 ||
        safe.id === 'certificate-export' || !Array.isArray(safe.variants)) return bad('schema-unsupported');
    for (const variant of safe.variants) {
      const ids = variant.sessionProfileIds;
      if (!Array.isArray(ids) || ids.length > 64 || new Set(ids).size !== ids.length ||
          ids.some(id => typeof id !== 'string' || variant.os !== 'darwin' || !macosSessionProfiles.profiles.some(profile =>
            profile.id === id && variant.capabilityIds.includes(profile.trustCellId)))) return bad('session-profile-unavailable');
      delete variant.sessionProfileIds;
    }
    safe.schema = 'urn:aihq:harness:repair:1.1.0';
    return validateRepairDefinition11(safe, options);
  } catch { return bad('strict-json'); }
}
