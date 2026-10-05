// Portable native-verification metadata. Data and pure validation only: no host effects.
import { ID_RE, SHA256_RE, canonicalJson, hasExactKeys, isRecord, isSafeInteger, isSafeRelativePath,
  isMemberPath, sha256Hex, treeEntries, snapshotNativeData } from './canonical.mjs';
import { fixtureAnswer, fixtureAttestTool, fixtureFiles, fixtureId, fixtureMarkerSha256, fixturePins,
  fixtureQueryTool, fixtureResultText, fixtureServerName } from './fixture-metadata.mjs';

const deepFreeze = value => {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
};

export const nativeClientIds = Object.freeze(['claude', 'codex', 'cursor', 'gemini', 'copilot',
  'windsurf', 'opencode', 'kimi', 'kiro', 'antigravity', 'zed']);

export const nativeBounds = Object.freeze({
  defaultBudgetMs: 180000, minBudgetMs: 1000, maxBudgetMs: 600000, cleanupAllowanceMs: 10000,
  killGraceMs: 1000, telemetryDrainMs: 2000, telemetrySkewMs: 2000,
  requestBytes: 65536, hostInputBytes: 65536, identityManifestBytes: 16384, credentialBytes: 65536,
  jsonDocumentBytes: 262144, jsonDepth: 16, sessions: 2, stageRows: 32,
  childOutputBytes: 2097152, childRecordBytes: 262144,
  collectorRequestBytes: 262144, collectorRequests: 64, collectorEvents: 512, collectorBytes: 2097152,
  collectorBodyTimeoutMs: 2000,
  recorderMessageBytes: 262144, recorderMessages: 512, recorderBytes: 4194304,
  frameBytes: 16384, frameDepth: 8, frames: 512, channelConcurrent: 4, channelTotal: 16,
  resultBytes: 65536, diagnostics: 16, survivors: 32, materialFileBytes: 8388608
});

export const nativeRunStageIds = Object.freeze(['fixture-integrity', 'host-presence', 'identity-binding',
  'cell-staging', 'session-start', 'configuration-unchanged', 'stop', 'cleanup']);
export const nativeSessionStageIds = Object.freeze(['session-freshness', 'loading-mode', 'tool-restrictions',
  'provider-authentication', 'tool-discovery', 'instruction-loading', 'read-only-query', 'isolation', 'cleanup']);

export const nativeStageReasons = Object.freeze([
  'fixture-bytes-mismatch', 'material-path-unsafe', 'configuration-unavailable', 'sandbox-root-unavailable',
  'staging-unavailable', 'client-absent', 'version-unreadable', 'client-unsupported', 'version-unsupported',
  'platform-unsupported', 'cell-not-admitted', 'transport-unsupported', 'configuration-channel-unsupported',
  'authentication-channel-unsupported', 'authentication-unavailable', 'identity-binding-invalid',
  'session-launch-failed', 'executable-changed', 'session-identity-unobservable', 'session-not-fresh',
  'loading-mode-unobservable', 'configuration-not-loaded', 'managed-restriction', 'guardrail-path-conflict',
  'restriction-unobservable', 'identity-session-mismatch', 'identity-conflict', 'tools-not-discovered',
  'server-evidence-unavailable', 'instructions-not-loaded', 'instruction-attestation-unobservable',
  'instruction-attestation-mismatch', 'instruction-source-ambiguous', 'query-challenge-mismatch',
  'query-answer-mismatch', 'configuration-changed', 'isolation-unobserved', 'isolation-violated',
  'observed', 'before-session-2', 'after-session-2', 'cancelled', 'budget-exhausted', 'limit-exceeded',
  'native-internal', 'not-run-after-failure', 'not-run-after-restriction', 'not-run-after-unavailable',
  'termination-unresolved', 'cleanup-unresolved'
]);

// Fixed registry IDs. Definitions can only name these; there are no dynamic imports.
const CLAUDE_PARSER_ID = 'claude-stream-json.v1';
export const nativeParserIds = Object.freeze([CLAUDE_PARSER_ID]);
export const nativeIdentityAdapterIds = Object.freeze(['claude-oauth-otel.v1']);
export const nativeLifecycleIds = Object.freeze(['windows-job.v1', 'posix-group.v1', 'linux-srt.v1']);
export const nativeEvidenceAdapterIds = Object.freeze(['aihq.fixture.v1', 'aihq.stdio-recorder.v1']);

const member = (path, pin) => ({ path, sha256: pin.sha256, byteLength: pin.byteLength });
const treeFile = entry => ({ root: entry.file.root, path: entry.file.path, member: member(entry.file.memberPath, entry.pin) });
const fixtureTreeFile = key => treeFile({ file: fixtureFiles[key], pin: fixturePins[key] });

function buildClaudeFixture() {
  const outputTree = ['instruction', 'mcpConfig', 'server'].map(fixtureTreeFile);
  const guardrails = [fixtureTreeFile('guardrails')];
  // One shared fixture binds the fixed Claude parser, so every platform definition using that parser selects it.
  const descriptor = {
    id: fixtureId, client: 'claude', adapterId: CLAUDE_PARSER_ID,
    outputTree, outputTreeSha256: sha256Hex(canonicalJson(treeEntries(outputTree))),
    instructions: [{ root: 'project', path: fixtureFiles.instruction.path, sha256: fixturePins.instruction.sha256,
      evidence: 'marker', markerSha256: fixtureMarkerSha256 }],
    server: {
      name: fixtureServerName, transport: 'stdio',
      runtime: [member(fixtureFiles.server.memberPath, fixturePins.server)],
      evidenceAdapterId: 'aihq.fixture.v1', observation: 'native',
      toolNames: [fixtureAttestTool, fixtureQueryTool], queryTool: fixtureQueryTool,
      queryArguments: { node: 'entry' }, challenge: { mode: 'argument', field: 'challenge' },
      expectedResultSha256: sha256Hex(canonicalJson(JSON.parse(fixtureResultText))), expectedAnswer: fixtureAnswer
    }
  };
  return { ...descriptor, proofScope: 'bundled-mechanism', archiveSha256: null,
    manifestSha256: sha256Hex(canonicalJson(descriptor)),
    guardrails, guardrailsSha256: sha256Hex(canonicalJson(treeEntries(guardrails))) };
}

export const bundledNativeFixtures = deepFreeze([buildClaudeFixture()]);

// Proposed exact version/platform candidate. Native loading, credential-channel and guardrail
// effects remain unobserved; the descriptor does not establish admission. Evidence stays null.
function buildClaudeCandidate() {
  const fixture = bundledNativeFixtures[0];
  return {
    schema: 'urn:aihq:harness:native-verification-definition:1.0.0',
    id: 'claude-win32-x64-2.1.285', client: 'claude', state: 'candidate',
    platform: { os: 'win32', arch: 'x64', execution: 'native', osRelease: '10.0.26200' },
    clientVersions: ['2.1.285'], executableNames: ['claude.exe'],
    runtimeMembers: fixture.server.runtime.map(m => ({ ...m })),
    versionArgv: ['--version'], sessionArgv: ['-p', '--verbose', '--output-format', 'stream-json'],
    parserId: CLAUDE_PARSER_ID, identityAdapterId: 'claude-oauth-otel.v1',
    credentialDestination: { root: 'home', path: '.claude/.credentials.json' },
    guardrails: fixture.guardrails.map(g => ({ root: g.root, path: g.path, member: { ...g.member } })),
    guardrailsSha256: fixture.guardrailsSha256, lifecycleId: 'windows-job.v1',
    isolation: { mechanism: 'none', observerId: null, documentation: [] }, evidenceSha256: null
  };
}

function buildLinuxClaudeCandidate() {
  return { ...buildClaudeCandidate(), schema: 'urn:aihq:harness:native-verification-definition:1.1.0',
    id: 'claude-linux-x64-wsl2-srt-2.1.285',
    platform: { os: 'linux', arch: 'x64', execution: 'wsl2', osRelease: '6.18.33.2-microsoft-standard-WSL2' },
    executableNames: ['claude'], sessionArgv: ['-p', '--verbose', '--output-format', 'stream-json', '--tools', ''],
    lifecycleId: 'linux-srt.v1', isolation: { mechanism: 'vendor-runtime', observerId: 'anthropic-srt-linux.v1',
      documentation: ['https://github.com/anthropic-experimental/sandbox-runtime/blob/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b/README.md'] } };
}

export const nativeVerificationDefinitions = deepFreeze([buildClaudeCandidate(), buildLinuxClaudeCandidate()]);

const diagnostic = (reason, path) => ({ code: 'INPUT_INVALID', reason, message: 'Invalid native verification field.', path });
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,64})?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FORBIDDEN_FLAGS = new Set(['--bare', '--resume', '-r', '--continue', '-c', '--session-id', '--fork-session',
  '--mcp-config', '--strict-mcp-config', '--settings', '--setting-sources', '--system-prompt', '--system-prompt-file',
  '--append-system-prompt', '--append-system-prompt-file', '--add-dir', '--plugin-dir', '--agents',
  '--permission-prompt-tool', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--debug-file']);
const OS_VALUES = ['win32', 'linux', 'darwin'];
const LEGACY_LIFECYCLE_IDS = ['windows-job.v1', 'posix-group.v1'];
const DEFINITION_V10 = 'urn:aihq:harness:native-verification-definition:1.0.0';
const DEFINITION_V11 = 'urn:aihq:harness:native-verification-definition:1.1.0';
const VENDOR_OBSERVER_ID = 'anthropic-srt-linux.v1';

const validMember = (value, prefix) => hasExactKeys(value, ['path', 'sha256', 'byteLength']) &&
  (prefix ? isMemberPath(value.path) : isSafeRelativePath(value.path)) && SHA256_RE.test(value.sha256) &&
  isSafeInteger(value.byteLength, 1, 8 * 1024 * 1024);
const validTreeFile = value => hasExactKeys(value, ['root', 'path', 'member']) &&
  (value.root === 'home' || value.root === 'project') && isSafeRelativePath(value.path) && validMember(value.member, true);
const boundedStrings = (value, min, max, length, minLength = 1) => Array.isArray(value) && value.length >= min && value.length <= max &&
  value.every(item => typeof item === 'string' && item.length >= minLength && item.length <= length && !item.includes('\0'));
const httpsDocumentation = list => boundedStrings(list, 1, 8, 2048) &&
  list.every(url => { try { return new URL(url).protocol === 'https:'; } catch { return false; } });
const httpsDocumentationV11 = list => boundedStrings(list, 1, 8, 2048) &&
  list.every(url => /^https:\/\/[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*(?:\/[^\u0000-\u0020\u007f]*)?$/.test(url));

export function validateNativeVerificationDefinition(value) {
  try { return validateDefinition(snapshotNativeData(value)); }
  catch { return { valid: false, diagnostics: [diagnostic('definition-shape', '')] }; }
}

function validateDefinition(value) {
  const diagnostics = [];
  const bad = (reason, path) => diagnostics.push(diagnostic(reason, path));
  const keys = ['schema', 'id', 'client', 'state', 'platform', 'clientVersions', 'executableNames', 'runtimeMembers',
    'versionArgv', 'sessionArgv', 'parserId', 'identityAdapterId', 'credentialDestination', 'guardrails',
    'guardrailsSha256', 'lifecycleId', 'isolation', 'evidenceSha256'];
  if (!hasExactKeys(value, keys)) return { valid: false, diagnostics: [diagnostic('definition-shape', '')] };
  const v11 = value.schema === DEFINITION_V11;
  const documentation = v11 ? httpsDocumentationV11 : httpsDocumentation;
  if (!v11 && value.schema !== DEFINITION_V10) bad('schema', '/schema');
  const vendor = v11 && isRecord(value.isolation) && value.isolation.mechanism === 'vendor-runtime';
  if (typeof value.id !== 'string' || !ID_RE.test(value.id)) bad('id', '/id');
  if (!nativeClientIds.includes(value.client)) bad('client', '/client');
  if (value.state !== 'candidate' && value.state !== 'admitted') bad('state', '/state');
  const platform = value.platform;
  if (!hasExactKeys(platform, ['os', 'arch', 'execution', 'osRelease']) || !OS_VALUES.includes(platform.os) ||
      !['x64', 'arm64'].includes(platform.arch) || !['native', 'wsl2'].includes(platform.execution) ||
      typeof platform.osRelease !== 'string' || platform.osRelease.length < 1 || platform.osRelease.length > 128 ||
      (platform.execution === 'wsl2' && platform.os !== 'linux')) bad('platform', '/platform');
  if (!boundedStrings(value.clientVersions, 1, 32, 128) || value.clientVersions.some(v => !SEMVER_RE.test(v)) ||
      new Set(value.clientVersions).size !== value.clientVersions.length) bad('client-versions', '/clientVersions');
  if (!boundedStrings(value.executableNames, 1, 8, 255) || value.executableNames.some(n => /[\\/]/.test(n)))
    bad('executable-names', '/executableNames');
  if (!Array.isArray(value.runtimeMembers) || value.runtimeMembers.length < 1 || value.runtimeMembers.length > 256 ||
      !value.runtimeMembers.every(m => validMember(m, true))) bad('runtime-members', '/runtimeMembers');
  const argv = (list, path, emptyAllowed = false) => {
    if (boundedStrings(list, 1, 32, 1024, emptyAllowed ? 0 : 1) && !list.some(item => /\$|\{\{/.test(item))) return true;
    bad('argv', path);
    return false;
  };
  argv(value.versionArgv, '/versionArgv');
  if (argv(value.sessionArgv, '/sessionArgv', vendor) && vendor) {
    const tools = value.sessionArgv.reduce((at, item, i) => item === '--tools' ? [...at, i] : at, []);
    const empties = value.sessionArgv.reduce((at, item, i) => item === '' ? [...at, i] : at, []);
    if (tools.length !== 1 || empties.length !== 1 || empties[0] !== tools[0] + 1 ||
        value.sessionArgv.some(item => item.startsWith('--tools='))) bad('argv-tools', '/sessionArgv');
  }
  if (Array.isArray(value.sessionArgv) && value.sessionArgv.some(item =>
    typeof item === 'string' && FORBIDDEN_FLAGS.has(item.split('=')[0]))) bad('argv-override', '/sessionArgv');
  if (!nativeParserIds.includes(value.parserId)) bad('parser', '/parserId');
  if (!nativeIdentityAdapterIds.includes(value.identityAdapterId)) bad('identity-adapter', '/identityAdapterId');
  const destination = value.credentialDestination;
  if (!hasExactKeys(destination, ['root', 'path']) || destination.root !== 'home' || !isSafeRelativePath(destination.path))
    bad('credential-destination', '/credentialDestination');
  if (!Array.isArray(value.guardrails) || value.guardrails.length < 1 || value.guardrails.length > 16 ||
      !value.guardrails.every(validTreeFile)) bad('guardrails', '/guardrails');
  else {
    let digest;
    try { digest = sha256Hex(canonicalJson(treeEntries(value.guardrails))); } catch { digest = ''; }
    if (value.guardrailsSha256 !== digest) bad('guardrails-digest', '/guardrailsSha256');
    if (destination && value.guardrails.some(g => g.root === destination.root && g.path === destination.path))
      bad('guardrail-credential-collision', '/guardrails');
  }
  const srt = value.lifecycleId === 'linux-srt.v1';
  const vendorPlatform = platform?.os === 'linux' && platform?.arch === 'x64';
  if (!(v11 ? nativeLifecycleIds : LEGACY_LIFECYCLE_IDS).includes(value.lifecycleId) ||
      (value.lifecycleId === 'windows-job.v1' && platform?.os !== 'win32') ||
      (value.lifecycleId === 'posix-group.v1' && platform?.os === 'win32') ||
      ((srt || vendor) && !(srt && vendor && vendorPlatform))) bad('lifecycle', '/lifecycleId');
  const isolation = value.isolation;
  if (!hasExactKeys(isolation, ['mechanism', 'observerId', 'documentation'])) bad('isolation', '/isolation');
  else if (isolation.mechanism === 'none') {
    if (isolation.observerId !== null || !Array.isArray(isolation.documentation) || isolation.documentation.length)
      bad('isolation', '/isolation');
  } else if (isolation.mechanism === 'client-native') {
    if (typeof isolation.observerId !== 'string' || !ID_RE.test(isolation.observerId) ||
        !documentation(isolation.documentation)) bad('isolation', '/isolation');
  } else if (vendor) {
    if (isolation.observerId !== VENDOR_OBSERVER_ID || !documentation(isolation.documentation))
      bad('isolation', '/isolation');
  } else bad('isolation', '/isolation');
  if (value.state === 'candidate' ? value.evidenceSha256 !== null
    : (typeof value.evidenceSha256 !== 'string' || !SHA256_RE.test(value.evidenceSha256))) bad('evidence', '/evidenceSha256');
  return { valid: diagnostics.length === 0, diagnostics };
}

export function validateNativeTestIdentity(value) {
  try { return validateIdentity(snapshotNativeData(value, nativeBounds.identityManifestBytes)); }
  catch { return { valid: false, diagnostics: [diagnostic('identity-shape', '')] }; }
}

function validateIdentity(value) {
  const diagnostics = [];
  const bad = (reason, path) => diagnostics.push(diagnostic(reason, path));
  if (!hasExactKeys(value, ['schema', 'id', 'client', 'adapterId', 'purpose', 'expected', 'credential']))
    return { valid: false, diagnostics: [diagnostic('identity-shape', '')] };
  if (value.schema !== 'urn:aihq:harness:native-test-identity:1.0.0') bad('schema', '/schema');
  if (typeof value.id !== 'string' || !ID_RE.test(value.id)) bad('id', '/id');
  if (value.client !== 'claude') bad('client', '/client');
  if (!nativeIdentityAdapterIds.includes(value.adapterId)) bad('adapter', '/adapterId');
  if (value.purpose !== 'dedicated-native-test') bad('purpose', '/purpose');
  const expected = value.expected;
  if (!hasExactKeys(expected, ['accountUuid', 'organizationId']) || !UUID_RE.test(expected.accountUuid) ||
      !UUID_RE.test(expected.organizationId)) bad('expected', '/expected');
  const credential = value.credential;
  if (!hasExactKeys(credential, ['path', 'sha256', 'byteLength']) || credential.path !== 'oauth.json' ||
      !SHA256_RE.test(credential.sha256) || !isSafeInteger(credential.byteLength, 1, 65536)) bad('credential', '/credential');
  return { valid: diagnostics.length === 0, diagnostics };
}

export { isRecord };
