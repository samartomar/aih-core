// Portable 0.1.0 names for native verification (contract 4, 6, C73). Data and pure validation only: no host effects.
// A 0.1.0 document names its tool by registry id; the retained verification engine, its reviewed definitions and the
// Linux observer closure keep their native client id. Only `schema` and `client` differ between the two forms, so
// admission, definition ids and evidence stay exactly the retained ones.
import { isRecord } from './canonical.mjs';
import { nativeVerificationDefinitions, validateNativeVerificationDefinition as validateRetainedDefinition,
  validateNativeTestIdentity as validateRetainedIdentity } from './contracts.mjs';

export const NATIVE_DEFINITION_010 = 'urn:aihq:core:native-verification-definition:0.1.0';
export const NATIVE_TEST_IDENTITY_010 = 'urn:aihq:core:native-test-identity:0.1.0';
const RETAINED_IDENTITY = 'urn:aihq:harness:native-test-identity:1.0.0';

/** Registry id → retained native client id, for the registry tools the retained native vocabulary names. */
export const nativeClientOfTool = Object.freeze({ 'claude-code': 'claude', codex: 'codex', 'cursor-ide': 'cursor',
  gemini: 'gemini', copilot: 'copilot', windsurf: 'windsurf', opencode: 'opencode', kimi: 'kimi', kiro: 'kiro',
  antigravity: 'antigravity', zed: 'zed' });
export const toolOfNativeClient = Object.freeze(Object.fromEntries(Object.entries(nativeClientOfTool).map(([tool, client]) => [client, tool])));

const deepFreeze = value => {
  if (typeof value === 'object' && value !== null) { for (const key of Object.keys(value)) deepFreeze(value[key]); Object.freeze(value); }
  return value;
};
/** The bundled definitions as `native-verification-definition:0.1.0` documents. */
export const nativeClientDefinitions = deepFreeze(nativeVerificationDefinitions.map(definition =>
  ({ ...JSON.parse(JSON.stringify(definition)), schema: NATIVE_DEFINITION_010, client: toolOfNativeClient[definition.client] })));

const nativeClient = tool => typeof tool === 'string' && Object.hasOwn(nativeClientOfTool, tool) ? nativeClientOfTool[tool] : null;
/**
 * Reads a definition. A 0.1.0 definition is read by the retained rules as the definition it names, so an admitted
 * one must equal a registered admitted definition exactly. Retained schema ids keep their own reading.
 */
export function validateNativeVerificationDefinition(value) {
  if (!isRecord(value) || value.schema !== NATIVE_DEFINITION_010) return validateRetainedDefinition(value);
  const retained = nativeVerificationDefinitions.find(definition => definition.id === value.id);
  let lowered;
  try { lowered = { ...value, schema: retained?.schema ?? 'urn:aihq:harness:native-verification-definition:1.1.0', client: nativeClient(value.client) }; }
  catch { return validateRetainedDefinition(undefined); }
  return validateRetainedDefinition(lowered);
}
/** Reads a dedicated test identity; a 0.1.0 identity names `claude-code`. */
export function validateNativeTestIdentity(value) {
  if (!isRecord(value) || value.schema !== NATIVE_TEST_IDENTITY_010) return validateRetainedIdentity(value);
  let lowered;
  try { lowered = { ...value, schema: RETAINED_IDENTITY, client: value.client === 'claude-code' ? 'claude' : null }; }
  catch { return validateRetainedIdentity(undefined); }
  return validateRetainedIdentity(lowered);
}
