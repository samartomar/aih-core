// Disclosure dictionary, independently reviewed from (and never used for) state admission.
// Entries match exact case and their structural location only. Dynamic descendants stay opaque.
export const persistenceDiagnosticDictionary = Object.freeze({
  home: Object.freeze(['.claude', '.config', '.cache', '.local', 'AppData', '.npm', '.bun']),
  claude: Object.freeze(['todos', 'session-env', 'shell-snapshots', 'statsig', 'file-history', 'plans', 'paste-cache',
    'debug', 'ide', '.oauth_refresh.lock', 'projects', 'backups', 'telemetry', 'history.jsonl', '.claude.json',
    '.credentials.json', 'settings.json', 'settings.local.json', 'CLAUDE.md', 'agents', 'commands', 'skills',
    'plugins', 'hooks', 'output-styles', 'local']),
  userData: Object.freeze(['claude', 'claude-cli-nodejs', 'state', 'share']),
  project: Object.freeze(['.claude', '.mcp.json', 'CLAUDE.md', 'CLAUDE.local.md']),
  // Global-state key names the pinned Claude Code client defines (its default global configuration and its
  // user-settable configuration keys), plus the state keys this package already classifies. Naming a key
  // here only makes it readable in diagnostics; admission is decided separately.
  globalKey: Object.freeze(['projects', 'numStartups', 'firstStartTime', 'userID', 'machineID', 'summonSidKey',
    'oauthAccount', 'hasCompletedOnboarding', 'lastOnboardingVersion', 'lastReleaseNotesSeen', 'changelogLastFetched',
    'installMethod', 'autoUpdates', 'autoUpdatesProtectedForNative', 'cachedGrowthBookFeatures',
    'cachedGrowthBookFeaturesAt', 'cachedDynamicConfigs', 'cachedExperimentFeatures', 'cachedExperimentData',
    'cachedArtifactRoster', 'artifactRosterDenied', 'promoStartupStatusCache', 'cachedExtraUsageDisabledReason',
    'cachedUsageUtilization', 'groveConfigCache', 'passesEligibilityCache', 'claudeCodeFirstTokenDate',
    'startupPrefetchedAt', 'firstStartVersion', 'theme', 'preferredNotifChannel', 'verbose', 'editorMode',
    'autoCompactEnabled', 'autoScrollEnabled', 'showTurnDuration', 'externalEditorContext', 'showMessageTimestamps',
    'hasSeenTasksHint', 'hasUsedStash', 'hasUsedBackgroundTask', 'queuedCommandUpHintCount', 'diffTool',
    'customApiKeyResponses', 'tipsHistory', 'tipLifetimeShownCounts', 'tipsHistoryByCommand', 'memoryUsageCount',
    'promptQueueUseCount', 'btwUseCount', 'todoFeatureEnabled', 'showExpandedTodos', 'briefTranscript',
    'messageIdleNotifThresholdMs', 'autoConnectIde', 'autoInstallIdeExtension', 'fileCheckpointingEnabled',
    'terminalProgressBarEnabled', 'respectGitignore', 'copyFullResponse', 'shiftEnterKeyBindingInstalled',
    'hasUsedBackslashReturn', 'diffSidebarOpen', 'showStatusInTerminalTab', 'taskCompleteNotifEnabled',
    'inputNeededNotifEnabled', 'agentPushNotifEnabled', 'claudeInChromeDefaultEnabled',
    'hasCompletedClaudeInChromeOnboarding', 'lspRecommendationDisabled', 'lspRecommendationNeverPlugins',
    'lspRecommendationIgnoredCount', 'copyOnSelect', 'leftArrowOpensAgents', 'defaultToAgentsView',
    'prStatusFooterEnabled', 'remoteControlAtStartup', 'autoUploadSessions', 'autoAddRemoteControlDaemonWorker',
    'remoteDialogSeen', 'workflowSizeGuideline', 'skillUsage', 'pluginUsage', 'seenNotifications',
    'announcementImpressions', 'lastShownEmergencyTip', 'promptSuggestionUnusedStreak', 'subscriptionNoticeCount',
    'subscriptionUpsellShownCount', 'passesUpsellSeenCount', 'promoStartupSeenCount', 'fullscreenUpsellSeenCount',
    'fullscreenDownsellSeenCount', 'voiceLangHintShownCount', 'voiceFooterHintSeenCount', 'experimentNoticesSeenCount',
    'opusProMigrationComplete', 'sonnet1m45MigrationComplete', 'hasResetAutoModeOptInForDefaultOffer',
    'opusProMigrationTimestamp', 'legacyOpusMigrationTimestamp', 'sonnet45To46MigrationTimestamp',
    'fable5ToFableAliasMigrationTimestamp', 'mcpServers', 'allowedTools', 'permissions', 'hooks', 'env',
    'apiKeyHelper', 'primaryApiKey']),
  projectKey: Object.freeze(['allowedTools', 'mcpServers', 'mcpContextUris', 'enabledMcpjsonServers',
    'disabledMcpjsonServers', 'enableAllProjectMcpServers', 'hasTrustDialogAccepted',
    'hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown', 'ignorePatterns',
    'projectOnboardingSeenCount', 'hasCompletedProjectOnboarding', 'lastSessionId', 'lastCost', 'lastAPIDuration',
    'lastAPIDurationWithoutRetries', 'lastToolDuration', 'lastDuration', 'lastStartTime', 'lastLinesAdded',
    'lastLinesRemoved', 'lastTotalInputTokens', 'lastTotalOutputTokens', 'lastTotalCacheCreationInputTokens',
    'lastTotalCacheReadInputTokens', 'lastTotalWebSearchRequests', 'lastFpsAverage', 'lastFpsLow1Pct',
    'lastModelUsage', 'lastSessionMetrics', 'lastGracefulShutdown', 'lastVersionBase', 'exampleFiles',
    'exampleFilesGeneratedAt', 'seenTeamArtifactPaths', 'hasUnseenTeamArtifacts', 'devIntentsDetected', 'history',
    'permissions', 'hooks', 'env'])
});

// One instance per verification run. No names, keyed hashes, or cross-run identifiers are retained.
export function createPersistenceDiagnosticClassifier() {
  let ordinal = 0;
  const unknown = () => `unknown-${++ordinal}`;
  return Object.freeze({
    entry({ root, segments, depth }) {
      const name = segments.at(-1);
      let dictionary = [];
      if (depth === 1 && segments.length === 1) dictionary = persistenceDiagnosticDictionary[root] ?? [];
      if (root === 'home' && depth === 2 && segments.length === 2) {
        if (segments[0] === '.claude') dictionary = persistenceDiagnosticDictionary.claude;
        else if (['.config', '.cache', '.local'].includes(segments[0])) dictionary = persistenceDiagnosticDictionary.userData;
      }
      return dictionary.includes(name) ? name : unknown();
    },
    key(scope, name) {
      const dictionary = scope === 'global' ? persistenceDiagnosticDictionary.globalKey :
        scope === 'project' ? persistenceDiagnosticDictionary.projectKey : [];
      return dictionary.includes(name) ? name : unknown();
    }
  });
}

const tokens = new Set(Object.values(persistenceDiagnosticDictionary).flat());
export const safePersistenceDiagnosticToken = value => typeof value === 'string' &&
  (tokens.has(value) || /^unknown-[1-9][0-9]{0,5}$/.test(value)) ? value : null;
export const persistenceFailureClasses = Object.freeze(['pins', 'configuration-facts', 'selected-member',
  'unexpected-entry', 'state-tree-entry', 'inspected-state', 'read-failure', 'limit']);
export const inspectedStateDiagnoses = Object.freeze(['unknown-global-key', 'unknown-project-key', 'grant-content',
  'value-shape', 'malformed-json', 'oversized', 'not-record', 'read-failure']);
