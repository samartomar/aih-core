// `@aihq/core/harness`: portable environment data (contract 3, 6). Importing it performs no host observation.
// Retained definitions are published through views with their 0.1.0 identities (see public-ids.mjs).
export { toolRegistry, listTools, selectTool, validateToolRegistry } from './tool-registry.mjs';
export { targets, trustLimits, trustPlatformMatrix, consumerProfiles, exportDefaultNames } from './contracts.mjs';
export { repairIndex, trustCapabilities, macosSessionProfiles } from './public-ids.mjs';
export { signerRecords } from './signer-records.mjs';
export { nativeClientDefinitions, validateNativeVerificationDefinition, validateNativeTestIdentity } from './native/tool-names.mjs';
