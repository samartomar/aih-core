// Public identities over the retained Harness definitions (contract 5, 6; samartomar/aih-core#181).
// The repair definitions, trust admission cells and macOS session profiles keep their internal records unchanged:
// their bytes are bound by admitted evidence. What a caller reads is a view with the 0.1.0 format ids, and every
// repair is named by its repair id, which is also the management id a caller sees in reviews, runs and `list`.
import { repairIndex as definitions, trustCapabilities as capabilities } from './contracts.mjs';
import { macosSessionProfiles as profiles } from './macos-session-profiles.mjs';

export const REPAIR_FORMAT = 'urn:aihq:core:repair:0.1.0';
export const TRUST_CAPABILITIES_FORMAT = 'urn:aihq:core:trust-capabilities:0.1.0';
export const MACOS_SESSION_PROFILES_FORMAT = 'urn:aihq:core:macos-session-profiles:0.1.0';

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};
const copy = value => JSON.parse(JSON.stringify(value));

/** Internal management id → the repair id a caller sees (contract 5: "a repair uses its repair id"). */
const PUBLIC_IDS = Object.freeze(Object.fromEntries(definitions.map(definition => [definition.managementId, definition.id])));
const INTERNAL_IDS = Object.freeze(Object.fromEntries(definitions.map(definition => [definition.id, definition.managementId])));
/** The public management id of a retained repair custody id; any other id is returned unchanged. */
export const publicManagementId = id => Object.hasOwn(PUBLIC_IDS, id) ? PUBLIC_IDS[id] : id;
/** The retained custody id a public repair id names; any other id is returned unchanged. */
export const internalManagementId = id => Object.hasOwn(INTERNAL_IDS, id) ? INTERNAL_IDS[id] : id;

export const repairIndex = deepFreeze(definitions.map(definition =>
  ({ ...copy(definition), schema: REPAIR_FORMAT, managementId: definition.id })));
export const trustCapabilities = deepFreeze({ ...copy(capabilities), schema: TRUST_CAPABILITIES_FORMAT });
export const macosSessionProfiles = deepFreeze({ ...copy(profiles), schema: MACOS_SESSION_PROFILES_FORMAT });
