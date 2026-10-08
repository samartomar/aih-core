// Claude's ordinary client-owned state in the owned cell, and the separate precedence check for its global
// state file. Pure functions over bytes: no host effects.
import { isRecord, parseStrictJson } from './canonical.mjs';

// The verifier redirects CLAUDE_CONFIG_DIR to <home>/.claude. The client then keeps its global state file at
// <config home>/.claude.json (locked through a sibling `.lock` directory while it is written), rotating copies under
// backups/ that it never loads, transcripts under projects/, prompt history in history.jsonl and unsent telemetry
// batches under telemetry/. Inside a project folder the client reserves fixed non-transcript names; per-project memory
// is a loaded instruction source and the others are not transcripts, so all of them stay refused.
export const claudeGlobalStatePath = '.claude/.claude.json';
const tree = (path, exclusions = []) => Object.freeze({ path, exclusions: Object.freeze(exclusions), inspected: false });
export const claudeStatePaths = Object.freeze({
  home: Object.freeze([
    tree('.claude/projects', ['*/memory', '*/tiny_memory', '*/bagel', '*/cloud-snapshots', '*/bridge-pointer.json', '*/.session-aliases']),
    Object.freeze({ path: claudeGlobalStatePath, exclusions: Object.freeze([]), inspected: true }),
    tree('.claude/.claude.json.lock'),
    tree('.claude/backups'),
    tree('.claude/history.jsonl'),
    tree('.claude/history.jsonl.lock'),
    tree('.claude/telemetry'),
    // Claude Code 2.1.285, SHA-256 33dad1ec615a2e08cc78b494f05c110e49916de2c79d78ec8799ebf46b233d29:
    // sessions is a PID/socket registry whose entries must be gone after descendant quiescence.
    Object.freeze({ path: '.claude/sessions', kind: 'empty-directory', exclusions: Object.freeze([]), inspected: false }),
    // .last-cleanup is housekeeping control metadata whose contents are not inspected; only its mtime is read back.
    Object.freeze({ path: '.claude/.last-cleanup', kind: 'file', exclusions: Object.freeze([]), inspected: false }),
    // For the pinned Claude Code 2.1.285 executable, the enumerated static trace identifies error/MCP JSONL
    // log writers and age-based cleanup here; no configuration or instruction reader was identified in it.
    // This rationale is version-specific. The ordinary uninspected-root file-or-directory rule applies.
    tree('.cache/claude-cli-nodejs')
  ]),
  project: Object.freeze([])
});

export const claudeGlobalStateBytes = 1024 * 1024;
const DEPTH = 32;

// Keys that could add an MCP server, tool or permission grant, trust/approval, credential or environment input.
// They are accepted only when absent or empty/false, which is how the client records "nothing granted".
const GRANTS = new Set(['mcpServers', 'allowedTools', 'mcpContextUris', 'enabledMcpjsonServers', 'disabledMcpjsonServers',
  'enableAllProjectMcpServers', 'hasTrustDialogAccepted', 'hasClaudeMdExternalIncludesApproved', 'ignorePatterns']);
const empty = value => value === false || (Array.isArray(value) && value.length === 0) || (isRecord(value) && Object.keys(value).length === 0);

// Value shapes. Every allowed key carries a bounded shape, so a grant cannot hide inside bookkeeping.
const STRING = 65536;
const scalar = value => value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ||
  (typeof value === 'string' && value.length <= STRING);
const count = value => Number.isSafeInteger(value) && value >= 0;
const number = value => typeof value === 'number' && Number.isFinite(value);
const text = value => typeof value === 'string' && value.length <= STRING;
const bool = value => typeof value === 'boolean';
const nullable = check => value => value === null || check(value);
const recordOf = check => value => isRecord(value) && Object.entries(value).every(([key, field]) =>
  !NESTED_GRANTS.has(key) && check(field));
const arrayOf = (check, max) => value => Array.isArray(value) && value.length <= max && value.every(check);
// Keys that, nested anywhere inside client bookkeeping, would name a server, tool, permission, hook, plugin,
// environment, credential helper or directory grant. Bookkeeping never needs them.
const NESTED_GRANTS = new Set([...GRANTS, 'permissions', 'allow', 'deny', 'ask', 'hooks', 'env', 'apiKeyHelper', 'mcp',
  'enabledPlugins', 'extraKnownMarketplaces', 'additionalDirectories', 'defaultMode', 'primaryApiKey', 'customApiKeyResponses']);
// Client-structured data of scalars, arrays and records (depth-bounded), without nested grant names.
const data = (depth = 4) => value => scalar(value) || (depth > 0 && (
  (Array.isArray(value) && value.length <= 1024 && value.every(data(depth - 1))) ||
  (isRecord(value) && Object.entries(value).every(([key, field]) => !NESTED_GRANTS.has(key) && data(depth - 1)(field)))));
// Provider-response caches (feature gates, dynamic configs, experiments, usage, eligibility). Their content is the
// provider's, kept between sessions by the client; it is accepted as an explicit limitation while every session's
// loading, restriction, tool and authentication evidence is still observed independently.
// Claude Code 2.1.285, SHA-256 33dad1ec615a2e08cc78b494f05c110e49916de2c79d78ec8799ebf46b233d29:
// modelAccessCache and penguinModeOrgEnabled are behavior-relevant provider state admitted under this same
// limitation, even with fast mode disabled. Selected-settings mutations still fail persistence validation.
const modelAccess = arrayOf(value => isRecord(value) && Object.keys(value).every(key =>
  ['apiName', 'entitled'].includes(key)) && text(value.apiName) && bool(value.entitled), 256);
const providerCache = value => value === null || isRecord(value) || Array.isArray(value) || scalar(value);
const counterMap = recordOf(value => count(value) || recordOf(count)(value));
// Profile metadata the client merges after authentication: known fields only.
const ACCOUNT = new Set(['accountUuid', 'emailAddress', 'organizationUuid', 'organizationRole', 'workspaceRole', 'organizationName',
  'displayName', 'fullName', 'hasExtraUsageEnabled', 'billingType', 'subscriptionCreatedAt', 'accountCreatedAt',
  'claudeCodeTrialEndsAt', 'claudeCodeTrialDurationDays', 'seatTier', 'planDisplayName', 'profileFetchedAt']);
const account = value => isRecord(value) && Object.entries(value).every(([key, field]) =>
  key === 'ccOnboardingFlags' ? recordOf(scalar)(field) && !Object.keys(field).some(name => NESTED_GRANTS.has(name))
    : ACCOUNT.has(key) && scalar(field));

// Claude Code 2.1.285, SHA-256 33dad1ec615a2e08cc78b494f05c110e49916de2c79d78ec8799ebf46b233d29:
// startup response slots are keyed by client request identity, with provider data and fetch metadata. The model
// field may be absent when the request has no model. These are response caches, not a source of model selection.
const responseSlot = value => isRecord(value) &&
  Object.keys(value).every(key => ['data', 'at', 'entrypoint', 'model', 'org'].includes(key)) &&
  Object.hasOwn(value, 'data') && data(4)(value.data) && count(value.at) &&
  nullable(text)(value.entrypoint) && (!Object.hasOwn(value, 'model') || text(value.model)) && nullable(text)(value.org);
// The same executable stores account/campaign eligibility responses with these known fields. A nested "granted"
// boolean is provider eligibility metadata; it is not a tool/permission grant name. Unknown response fields reject.
const featureEligibility = value => isRecord(value) && Object.keys(value).every(key =>
  ['available', 'eligible', 'granted', 'amount_minor_units', 'currency'].includes(key)) &&
  bool(value.available) && bool(value.eligible) && bool(value.granted) && count(value.amount_minor_units) && text(value.currency);
const eligibilityEntry = value => isRecord(value) && Object.keys(value).every(key => ['info', 'timestamp'].includes(key)) &&
  featureEligibility(value.info) && count(value.timestamp);

// Claude Code 2.1.285 under the verifier's fixed marketplace-disable switch still writes this tuple.
// Admit it atomically or allow complete absence; no install/retry/timestamp state is admitted.
const DISABLED_MARKETPLACE = new Map([
  ['officialMarketplaceAutoInstallAttempted', true], ['officialMarketplaceAutoInstalled', false],
  ['officialMarketplaceAutoInstallFailReason', 'policy_blocked']
]);

const COUNTERS = ['numStartups', 'memoryUsageCount', 'promptQueueUseCount', 'btwUseCount', 'queuedCommandUpHintCount',
  'lspRecommendationIgnoredCount', 'promptSuggestionUnusedStreak', 'subscriptionNoticeCount', 'subscriptionUpsellShownCount',
  'passesUpsellSeenCount', 'promoStartupSeenCount', 'fullscreenUpsellSeenCount', 'fullscreenDownsellSeenCount',
  'voiceLangHintShownCount', 'voiceFooterHintSeenCount', 'experimentNoticesSeenCount'];
// The client's own set of global counter/cache keys whose churn it treats as bookkeeping, plus the startup and
// response bookkeeping it writes itself: install markers, onboarding and release-note markers, profile metadata after
// authentication and account-keyed provider caches. Auto-update is disabled for verification; only the disabled value
// is accepted, because enabling the updater would be a behaviour input.
const GLOBAL_STATE = new Map([
  ...COUNTERS.map(key => [key, count]),
  ['skillUsage', data()], ['pluginUsage', data()], ['tipsHistory', counterMap], ['tipLifetimeShownCounts', counterMap],
  ['tipsHistoryByCommand', data(3)], ['seenNotifications', data()], ['announcementImpressions', data()],
  ['lastShownEmergencyTip', data(1)],
  ['cachedGrowthBookFeatures', providerCache], ['cachedGrowthBookFeaturesAt', number], ['cachedArtifactRoster', providerCache],
  ['artifactRosterDenied', value => scalar(value) || (isRecord(value) && data(1)(value))],
  ['promoStartupStatusCache', providerCache], ['cachedDynamicConfigs', providerCache],
  ['cachedExperimentFeatures', providerCache], ['cachedExperimentData', providerCache],
  ['firstStartTime', text], ['claudeCodeFirstTokenDate', nullable(text)], ['startupPrefetchedAt', number],
  ['firstStartVersion', text], ['installMethod', value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value)],
  ['autoUpdates', value => value === false], ['autoUpdatesProtectedForNative', bool], ['hasCompletedOnboarding', bool],
  ['lastOnboardingVersion', text], ['lastReleaseNotesSeen', text], ['changelogLastFetched', number], ['oauthAccount', account],
  ['cachedExtraUsageDisabledReason', nullable(text)], ['cachedUsageUtilization', providerCache],
  ['groveConfigCache', providerCache], ['passesEligibilityCache', providerCache],
  ['modelAccessCache', modelAccess], ['penguinModeOrgEnabled', bool],
  // Claude Code 2.1.285, SHA-256 33dad1ec615a2e08cc78b494f05c110e49916de2c79d78ec8799ebf46b233d29:
  // reviewed headless-capable response/history writers. Server-name histories do not configure MCP; campaign
  // histories do not enable features. Other model choices, fast-mode consent, marketplace install/retry controls,
  // compression latches, remote-control records and preferences remain unknown/refused even when client-written.
  ['clientDataCacheSlots', recordOf(responseSlot)], ['closedIssuesAcknowledged', arrayOf(count, 1024)],
  ['closedIssuesLastChecked', number], ['fotwClaimedFeatures', recordOf(arrayOf(text, 1024))],
  ['fotwEligibilityCache', recordOf(recordOf(eligibilityEntry))],
  ['githubWebConnectionStatusCache', value => isRecord(value) && data(2)(value)],
  ['claudeAiMcpEverConnected', arrayOf(text, 1024)], ['mcpNeedsAuthNoticed', arrayOf(text, 1024)],
  ['hasRunUltrareview', bool], ['hasSeenAutoModeEntryWarning', bool], ['hasVisitedPasses', bool],
  ['passesLastSeenRemaining', nullable(count)], ['teamOnboardingLastUsedAt', count]
]);
// Locally generated random identifiers.
const IDENTIFIERS = new Set(['userID', 'machineID', 'summonSidKey']);
// The client's own set of per-project keys whose churn it treats as bookkeeping (session metrics and markers).
// Legacy prompt history is a bounded list of plain entries without grant names.
const PROJECT_STATE = new Map([
  ...['lastCost', 'lastAPIDuration', 'lastAPIDurationWithoutRetries', 'lastToolDuration', 'lastDuration', 'lastStartTime',
    'lastLinesAdded', 'lastLinesRemoved', 'lastTotalInputTokens', 'lastTotalOutputTokens', 'lastTotalCacheCreationInputTokens',
    'lastTotalCacheReadInputTokens', 'lastTotalWebSearchRequests', 'lastFpsAverage', 'lastFpsLow1Pct',
    'exampleFilesGeneratedAt'].map(key => [key, number]),
  ['lastSessionId', text], ['lastGracefulShutdown', bool], ['lastVersionBase', text], ['lastModelUsage', data(3)],
  ['lastSessionMetrics', data(3)], ['exampleFiles', arrayOf(text, 64)], ['seenTeamArtifactPaths', arrayOf(text, 1024)],
  ['hasUnseenTeamArtifacts', bool], ['hasClaudeMdExternalIncludesWarningShown', bool], ['projectOnboardingSeenCount', count],
  ['hasCompletedProjectOnboarding', bool], ['devIntentsDetected', data(2)],
  ['history', arrayOf(entry => isRecord(entry) && data(3)(entry), 100)]
]);
// The exact one-shot startup migration markers this client version writes: they only record that a migration ran
// (boolean) or when (integer epoch milliseconds). A migration that changes settings writes those settings files, which
// stay selected or refused separately. Any other marker name is unknown and refused.
const MIGRATIONS = new Map([
  ['opusProMigrationComplete', bool], ['sonnet1m45MigrationComplete', bool], ['hasResetAutoModeOptInForDefaultOffer', bool],
  ['opusProMigrationTimestamp', count], ['legacyOpusMigrationTimestamp', count], ['sonnet45To46MigrationTimestamp', count],
  ['fable5ToFableAliasMigrationTimestamp', count],
  // The pinned 2.1.285 executable's migration batch constant is exactly 14. This records completion, while
  // settings written by those migrations remain independently selected/refused; no other batch is reviewed.
  ['migrationVersion', value => value === 14]
]);

function acceptedGlobal(key, value) {
  if (GRANTS.has(key)) return empty(value);
  if (GLOBAL_STATE.has(key)) return GLOBAL_STATE.get(key)(value);
  if (IDENTIFIERS.has(key)) return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (MIGRATIONS.has(key)) return MIGRATIONS.get(key)(value);
  return false;
}
const acceptedProject = (key, value) => GRANTS.has(key) ? empty(value) : PROJECT_STATE.has(key) && PROJECT_STATE.get(key)(value);

// Diagnosis only, after admission already rejected. Bound work independently of JSON's byte/depth caps.
function rejectedShapeReason(value) {
  let remaining = 1024;
  const grant = value => {
    if (--remaining < 0 || !value || typeof value !== 'object') return false;
    for (const [key, field] of Object.entries(value)) {
      if (remaining <= 0) return false;
      if (!Array.isArray(value) && NESTED_GRANTS.has(key) && !empty(field) || grant(field)) return true;
    }
    return false;
  };
  return grant(value) ? 'grant-content' : 'value-shape';
}

// Separate precedence check (not selected-byte persistence). Fail closed: malformed, oversized or too-deep JSON,
// any grant-capable key with content, and any key not recognised as client bookkeeping are refused, because an
// unrecognised key could be a loading, permission, preference or behaviour input the inspector cannot classify.
export function inspectClaudeGlobalState(bytes, diagnostics = {}) {
  // The optional observer cannot affect the existing boolean admission result.
  let ordinal = 0;
  const fail = (reason, scope, key) => {
    try { diagnostics.diagnose?.({ reason, token: key === undefined ? null :
      diagnostics.classifyKey?.(scope, key) ?? `unknown-${++ordinal}` }); } catch { /* Observation only. */ }
    return false;
  };
  try {
    if (!(bytes instanceof Uint8Array)) return fail('read-failure');
    if (bytes.length > claudeGlobalStateBytes) return fail('oversized');
    const value = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), DEPTH);
    if (!isRecord(value)) return fail('not-record');
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'projects') {
        if (!isRecord(entry)) return fail('not-record', 'global', key);
        for (const project of Object.values(entry)) {
          // Project-map keys are paths: never classify or export them.
          if (!isRecord(project)) return fail('not-record', 'global', key);
          for (const [name, field] of Object.entries(project)) {
            if (!acceptedProject(name, field)) return fail(GRANTS.has(name) ? 'grant-content' :
              PROJECT_STATE.has(name) ? rejectedShapeReason(field) : 'unknown-project-key', 'project', name);
          }
        }
      } else if (DISABLED_MARKETPLACE.has(key)) {
        if (![...DISABLED_MARKETPLACE].every(([name, expected]) => Object.hasOwn(value, name) && value[name] === expected))
          return fail('value-shape', 'global', key);
      } else if (!acceptedGlobal(key, entry)) return fail(GRANTS.has(key) ? 'grant-content' :
        GLOBAL_STATE.has(key) || IDENTIFIERS.has(key) || MIGRATIONS.has(key) ? rejectedShapeReason(entry) : 'unknown-global-key', 'global', key);
    }
    return true;
  } catch { return fail('malformed-json'); }
}
