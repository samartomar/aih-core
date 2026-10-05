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
    tree('.claude/telemetry')
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

// The client's own set of global counter/cache keys whose churn it treats as bookkeeping.
const CLIENT_CHURN = ['numStartups', 'skillUsage', 'pluginUsage', 'memoryUsageCount', 'promptQueueUseCount', 'btwUseCount',
  'queuedCommandUpHintCount', 'lspRecommendationIgnoredCount', 'promptSuggestionUnusedStreak', 'tipsHistory',
  'tipLifetimeShownCounts', 'tipsHistoryByCommand', 'seenNotifications', 'announcementImpressions', 'lastShownEmergencyTip',
  'subscriptionNoticeCount', 'subscriptionUpsellShownCount', 'passesUpsellSeenCount', 'promoStartupSeenCount',
  'fullscreenUpsellSeenCount', 'fullscreenDownsellSeenCount', 'voiceLangHintShownCount', 'voiceFooterHintSeenCount',
  'experimentNoticesSeenCount', 'cachedGrowthBookFeatures', 'cachedGrowthBookFeaturesAt', 'cachedArtifactRoster',
  'artifactRosterDenied', 'promoStartupStatusCache', 'cachedDynamicConfigs', 'cachedExperimentFeatures', 'cachedExperimentData',
  'firstStartTime', 'claudeCodeFirstTokenDate', 'startupPrefetchedAt'];
// Startup and response bookkeeping the client writes itself: install/update markers, onboarding and release-note
// markers, profile metadata after authentication, and account-keyed caches of provider responses.
const CLIENT_BOOKKEEPING = ['firstStartVersion', 'installMethod', 'autoUpdates', 'autoUpdatesProtectedForNative',
  'hasCompletedOnboarding', 'lastOnboardingVersion', 'lastReleaseNotesSeen', 'changelogLastFetched', 'oauthAccount',
  'cachedExtraUsageDisabledReason', 'cachedUsageUtilization', 'groveConfigCache', 'passesEligibilityCache'];
const GLOBAL_STATE = new Set([...CLIENT_CHURN, ...CLIENT_BOOKKEEPING]);
// Locally generated random identifiers.
const IDENTIFIERS = new Set(['userID', 'machineID', 'summonSidKey']);
// The client's own set of per-project keys whose churn it treats as bookkeeping (session metrics and markers).
const PROJECT_STATE = new Set(['lastCost', 'lastAPIDuration', 'lastAPIDurationWithoutRetries', 'lastToolDuration', 'lastDuration',
  'lastStartTime', 'lastLinesAdded', 'lastLinesRemoved', 'lastTotalInputTokens', 'lastTotalOutputTokens',
  'lastTotalCacheCreationInputTokens', 'lastTotalCacheReadInputTokens', 'lastTotalWebSearchRequests', 'lastFpsAverage',
  'lastFpsLow1Pct', 'lastSessionId', 'lastGracefulShutdown', 'lastVersionBase', 'lastModelUsage', 'lastSessionMetrics',
  'exampleFiles', 'exampleFilesGeneratedAt', 'seenTeamArtifactPaths', 'hasUnseenTeamArtifacts',
  'hasClaudeMdExternalIncludesWarningShown', 'history', 'projectOnboardingSeenCount', 'hasCompletedProjectOnboarding',
  'devIntentsDetected']);
// One-shot startup migration markers: they only record that a migration ran. A migration that changes settings writes
// those settings files, which stay selected or refused separately.
const MIGRATION_DONE = /^[a-z][A-Za-z0-9]*MigrationComplete$|^hasResetAutoModeOptInForDefaultOffer$/;
const MIGRATION_TIME = /^[a-z][A-Za-z0-9]*MigrationTimestamp$/;

function acceptedGlobal(key, value) {
  if (GRANTS.has(key)) return empty(value);
  if (GLOBAL_STATE.has(key)) return true;
  if (IDENTIFIERS.has(key)) return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (MIGRATION_DONE.test(key)) return typeof value === 'boolean';
  if (MIGRATION_TIME.test(key)) return Number.isSafeInteger(value) && value >= 0;
  return false;
}
const acceptedProject = (key, value) => GRANTS.has(key) ? empty(value) : PROJECT_STATE.has(key);

// Separate precedence check (not selected-byte persistence). Fail closed: malformed, oversized or too-deep JSON,
// any grant-capable key with content, and any key not recognised as client bookkeeping are refused, because an
// unrecognised key could be a loading, permission, preference or behaviour input the inspector cannot classify.
export function inspectClaudeGlobalState(bytes) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length > claudeGlobalStateBytes) return false;
    const value = parseStrictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), DEPTH);
    if (!isRecord(value)) return false;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'projects') {
        if (!isRecord(entry)) return false;
        for (const project of Object.values(entry)) {
          if (!isRecord(project) || !Object.entries(project).every(([name, field]) => acceptedProject(name, field))) return false;
        }
      } else if (!acceptedGlobal(key, entry)) return false;
    }
    return true;
  } catch { return false; }
}
