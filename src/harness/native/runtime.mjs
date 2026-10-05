// Node-only native-verification helpers for Core's generic orchestration. Importing this module has no
// host effects. Nothing here starts a client, a session or a configured server by itself; every refusal
// is an explicit outcome and every missing observation stays unavailable.
import { fixtureAttestTool, fixtureFiles, fixtureQueryTool, fixtureServerName } from './fixture-data.mjs';
import { startEvidenceChannel as internalEvidenceChannel } from './evidence.mjs';

export { nativeClientIds, nativeBounds, nativeStageReasons, nativeRunStageIds, nativeSessionStageIds,
  nativeVerificationDefinitions, bundledNativeFixtures, validateNativeVerificationDefinition,
  validateNativeTestIdentity } from './contracts.mjs';
export { parseStrictJson, canonicalJson } from './canonical.mjs';
export { sha256, configurationDigest, definitionIdentity, resolveBundledFixture, verifyFixtureMaterials } from './digest.mjs';
export { observeNativePlatform, selectNativeCell, matchClientVersion, parseClaudeVersionOutput } from './select.mjs';
export { createOwnedCell, stageCellFiles, observeCellConfiguration, removeOwnedCell } from './cell.mjs';
export { captureTestIdentity, stageCredential, validateClaudeOAuthFile } from './identity.mjs';
export { lifecycleAvailability, startLifecycle, pinExecutable, revalidateExecutable } from './lifecycle.mjs';
export { createClaudeCollector } from './collector.mjs';
export { createClaudeStreamParser, buildClaudeEnvironment, claudePrompt, claudeSessionsAreFresh,
  observeClaudeManagedSettings } from './claude.mjs';
export { evaluateServerEvidence } from './evidence.mjs';
export { evaluateClaudeSession } from './session.mjs';
export { recorderId, recorderMaterial, recorderPlan, recorderCommand } from './recorder.mjs';

// The public channel always uses the OS peer-identity facility. Node has none, so an authenticated
// stream is never accepted here and server evidence stays unavailable: no caller can substitute one.
export const startEvidenceChannel = ({ directory, isOwnedServer, plan = null }) => internalEvidenceChannel({ directory, isOwnedServer, plan });

export const claudeDeniedBuiltins = Object.freeze([...JSON.parse(fixtureFiles.guardrails.text).permissions.deny]);

// Parser/evaluator options derived from a resolved fixture and the current session challenge.
export const claudeStreamOptions = (resolved, challenge) => ({
  serverName: resolved.server.name, attestTool: fixtureAttestTool, queryTool: resolved.server.queryTool,
  expectedAnswer: resolved.server.expectedAnswer, markerSha256: resolved.instructions[0].markerSha256, challenge
});
export const serverEvidenceSpec = resolved => ({
  attestTool: fixtureAttestTool, queryTool: fixtureQueryTool, toolNames: [...resolved.server.toolNames],
  markerSha256: resolved.instructions[0].markerSha256, expectedResultSha256: resolved.server.expectedResultSha256
});
export { fixtureServerName };
