import test from 'node:test';
import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { inspectClaudeGlobalState } from '../../src/harness/native/claude-state.mjs';
import { createPersistenceDiagnosticClassifier, safePersistenceDiagnosticToken } from '../../src/harness/native/persistence-diagnostics.mjs';
import { publishNativePersistenceDiagnostics } from '../../src/harness/native/admission.mjs';

// Values reconstructed from the pinned 2.1.285 readers/writers. These six keys affect notices,
// issue-response cache freshness or dismissal history. No client execution is needed.
const slot = { data: { status: 'available', items: ['sample'] }, at: 1000, entrypoint: null, model: 'sample-model', org: null };
const eligibility = { info: { available: true, eligible: true, granted: false, amount_minor_units: 100, currency: 'USD' }, timestamp: 1000 };
const bookkeeping = {
  closedIssuesAcknowledged: [1, 2], closedIssuesLastChecked: 1000,
  hasSeenAutoModeEntryWarning: true, hasVisitedPasses: false,
  passesLastSeenRemaining: 1, teamOnboardingLastUsedAt: 1000
};
// Writer samples alone do not close these keys' reader/caller influence or response shapes.
const dropped = {
  claudeAiMcpEverConnected: ['sample-server'], clientDataCacheSlots: { request: slot },
  fotwClaimedFeatures: { account: ['sample-feature'] }, fotwEligibilityCache: { account: { campaign: eligibility } },
  githubWebConnectionStatusCache: { accountUuid: 'sample-account', orgUuid: 'sample-org', status: 'connected' },
  hasRunUltrareview: true, mcpNeedsAuthNoticed: ['sample-server']
};
const disabledMarketplace = {
  officialMarketplaceAutoInstallAttempted: true, officialMarketplaceAutoInstalled: false,
  officialMarketplaceAutoInstallFailReason: 'policy_blocked'
};
const providerState = { modelAccessCache: [{ apiName: 'sample-model', entitled: true }], penguinModeOrgEnabled: false };
const behavioral = [
  'autoConnectIde', 'autoUpdatesChannel', 'bridgeOauthDeadExpiresAt', 'bridgeOauthDeadFailCount', 'briefTranscript',
  'chromeExtension', 'claudeCodeHints', 'claudeInChromeDefaultEnabled', 'codeReviewLastEffort', 'diffTool',
  'fableOverageConsentV2', 'githubRepoPaths', 'gzipRequestBodiesLatchedOff', 'hasRemoteEnvironment',
  'hasSeenUltraplanTerms', 'lastSeenOrgDefaultUpdatedAt', 'lspRecommendationDisabled', 'lspRecommendationNeverPlugins',
  'minimumVersion',
  'officialMarketplaceAutoInstallLastAttemptTime', 'officialMarketplaceAutoInstallNextRetryTime',
  'officialMarketplaceAutoInstallRetryCount',
  'remoteControlAtStartup', 'replBridgePlaceholders'
];
const interactive = [
  'agentLastUsed', 'appleTerminalBackupPath', 'appleTerminalSetupInProgress', 'autoModeClassifierBillingNoticeAcknowledgedAt',
  'cachedChromeExtensionInstalled', 'chromeInstallUpsellDismissed', 'daemonInstallPromptDismissed', 'defaultToAgentsView',
  'diffSidebarBaseMode', 'diffSidebarOpen', 'favoritePlugins', 'feedbackDraftsTurnOffPromptDeclines', 'feedbackSurveyState',
  'fleetViewGroupMode', 'fullscreenAutoDisabled', 'fullscreenBootPending', 'fullscreenBootStrikes', 'githubActionSetupCount',
  'hasAcknowledgedCostThreshold', 'hasCompletedClaudeInChromeOnboarding', 'hasIdeAutoConnectDialogBeenShown',
  'hasIdeOnboardingBeenShown', 'hasOpenedAgentsView', 'hasSeenAutoDefaultNotice', 'hasSeenAutoDefaultNudge',
  'hasSeenAutoModeOutsideReadPrompt', 'hasUsedBackslashReturn', 'iterm2It2SetupComplete', 'iterm2SetupInProgress',
  'leftArrowOpensAgents', 'optionAsMetaKeyInstalled', 'pluginSuggestionDiscoverShownCounts', 'pluginSurveyState',
  'powerupsUnlocked', 'rcLongTurnNudgeSeenCount', 'rcLongTurnNudgeSeenKey', 'remoteControlReadyPushCount',
  'remoteControlReadyPushKey', 'remoteControlSurfacesSeen', 'resumeReturnDismissed', 'shiftEnterKeyBindingInstalled',
  'showExpandedTodos', 'slackAppInstallCount', 'transcriptShareDismissed', 'voiceLangHintLastLanguage',
  'webSetupPushOffer', 'webSetupPushOfferShown'
];
const bytes = value => Buffer.from(JSON.stringify(value));
const verdicts = value => {
  const diagnoses = [], classifier = createPersistenceDiagnosticClassifier();
  const input = bytes(value), plain = inspectClaudeGlobalState(input);
  const observed = inspectClaudeGlobalState(input, { classifyKey: classifier.key, diagnose: value => diagnoses.push(value) });
  assert.equal(observed, plain, 'diagnostics must preserve the verdict');
  assert.equal(inspectClaudeGlobalState(input, { classifyKey() { throw Error('observer'); }, diagnose() { throw Error('observer'); } }), plain);
  return { accepted: plain, diagnoses };
};

test('reviewed headless bookkeeping accepts bounded client-shaped values with diagnostics on or off', () => {
  for (const [key, value] of Object.entries(bookkeeping)) {
    const result = verdicts({ [key]: value });
    assert.equal(result.accepted, true, key); assert.deepEqual(result.diagnoses, []);
  }
  assert.equal(verdicts(bookkeeping).accepted, true);
  assert.equal(verdicts({ hasVisitedPasses: true }).accepted, true);
  assert.equal(verdicts({ closedIssuesAcknowledged: [] }).accepted, true);
  for (const key of ['closedIssuesLastChecked', 'passesLastSeenRemaining', 'teamOnboardingLastUsedAt'])
    for (const value of [0, Number.MAX_SAFE_INTEGER]) assert.equal(verdicts({ [key]: value }).accepted, true, key);
});

test('each bookkeeping admission refuses incompatible shapes and nested grants', () => {
  const wrong = {
    closedIssuesAcknowledged: [-1], closedIssuesLastChecked: '1000',
    hasSeenAutoModeEntryWarning: false, hasVisitedPasses: 'false',
    passesLastSeenRemaining: -1, teamOnboardingLastUsedAt: -1
  };
  const grants = ['mcpServers', 'allowedTools', 'mcpContextUris', 'enabledMcpjsonServers', 'disabledMcpjsonServers',
    'enableAllProjectMcpServers', 'hasTrustDialogAccepted', 'hasClaudeMdExternalIncludesApproved', 'ignorePatterns',
    'permissions', 'allow', 'deny', 'ask', 'hooks', 'env', 'apiKeyHelper', 'mcp', 'enabledPlugins',
    'extraKnownMarketplaces', 'additionalDirectories', 'defaultMode', 'primaryApiKey', 'customApiKeyResponses'];
  for (const key of Object.keys(bookkeeping)) {
    assert.equal(verdicts({ [key]: wrong[key] }).accepted, false, key);
    for (const name of grants) for (const value of [{ [name]: {} }, { item: { [name]: false } }, [{ [name]: ['sample'] }]])
      assert.equal(verdicts({ [key]: value }).accepted, false, `${key}/${name}`);
  }
  for (const name of grants) {
    for (const value of [{ ...slot, data: { item: [{ [name]: {} }] } }, { ...slot, [name]: false }])
      assert.equal(verdicts({ clientDataCacheSlots: { request: value } }).accepted, false, `slot/${name}`);
    assert.equal(verdicts({ clientDataCacheSlots: { [name]: slot } }).accepted, false, `slot map/${name}`);
    assert.equal(verdicts({ fotwClaimedFeatures: { [name]: ['sample'] } }).accepted, false, `campaign map/${name}`);
    assert.equal(verdicts({ fotwEligibilityCache: { [name]: { campaign: eligibility } } }).accepted, false, `account map/${name}`);
    assert.equal(verdicts({ fotwEligibilityCache: { account: { [name]: eligibility } } }).accepted, false, `eligibility map/${name}`);
    assert.equal(verdicts({ fotwEligibilityCache: { account: { campaign: { ...eligibility, info: { ...eligibility.info, [name]: {} } } } } }).accepted,
      false, `eligibility info/${name}`);
    assert.equal(verdicts({ githubWebConnectionStatusCache: { status: 'connected', item: { [name]: false } } }).accepted, false, `status/${name}`);
  }
});

test('notice bookkeeping rejects fractional, negative, unsafe and NaN-like numbers', () => {
  assert.equal(verdicts({ closedIssuesAcknowledged: Array(1024).fill(1) }).accepted, true);
  assert.equal(verdicts({ closedIssuesAcknowledged: Array(1025).fill(1) }).accepted, false);
  for (const key of ['closedIssuesLastChecked', 'passesLastSeenRemaining', 'teamOnboardingLastUsedAt']) {
    for (const value of [-0.5, 1.5, -1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null, 'NaN', '1000', false, [], {}]) {
      const result = verdicts({ [key]: value });
      assert.equal(result.accepted, false, `${key}/${String(value)}`);
      assert.deepEqual(result.diagnoses, [{ reason: 'value-shape', token: key }]);
    }
  }
  for (const value of [1.5, -0.5, null, '1', false, {}])
    assert.equal(verdicts({ closedIssuesAcknowledged: [value] }).accepted, false);
  for (const token of ['NaN', 'Infinity']) {
    const input = Buffer.from(`{"closedIssuesLastChecked":${token}}`), diagnoses = [];
    assert.equal(inspectClaudeGlobalState(input), false);
    assert.equal(inspectClaudeGlobalState(input, { diagnose: value => diagnoses.push(value) }), false);
    assert.deepEqual(diagnoses, [{ reason: 'malformed-json', token: null }]);
  }
});

test('the migration batch marker admits only the pinned batch constant', () => {
  assert.equal(verdicts({ migrationVersion: 14 }).accepted, true);
  for (const value of [13, 15, '14', 14.5, -14, null, true, [], {}]) {
    const result = verdicts({ migrationVersion: value });
    assert.equal(result.accepted, false, JSON.stringify(value));
    assert.deepEqual(result.diagnoses, [{ reason: 'value-shape', token: 'migrationVersion' }]);
  }
});

test('unsupported reader/caller keys are refused and disclosed even with writer-shaped or empty values', () => {
  assert.equal(Object.keys(dropped).length, 7);
  for (const [key, sample] of Object.entries(dropped)) for (const value of [sample, true, false, null, 0, 14, '', [], {}]) {
    const result = verdicts({ [key]: value });
    assert.equal(result.accepted, false, key);
    assert.deepEqual(result.diagnoses, [{ reason: 'unknown-global-key', token: key }]);
  }
  for (const value of [{ status: { arbitrary: true }, unreviewedField: 42 },
    { ...dropped.githubWebConnectionStatusCache, unreviewedField: 42 },
    { ...dropped.githubWebConnectionStatusCache, status: { arbitrary: true } }]) {
    const result = verdicts({ githubWebConnectionStatusCache: value });
    assert.equal(result.accepted, false);
    assert.deepEqual(result.diagnoses, [{ reason: 'unknown-global-key', token: 'githubWebConnectionStatusCache' }]);
  }
});

test('behavior inputs and interactive writers remain refused, including false or empty values', () => {
  assert.equal(behavioral.length, 24); assert.equal(interactive.length, 47);
  for (const key of [...behavioral, ...interactive]) for (const value of [true, false, null, 'sample', 1, [], {}]) {
    const result = verdicts({ [key]: value });
    assert.equal(result.accepted, false, key);
    assert.deepEqual(result.diagnoses, [{ reason: 'unknown-global-key', token: key }]);
  }
});

test('all 90 reviewed names disclose only as global keys; an unreviewed name retains an ordinal', () => {
  const names = [...Object.keys(bookkeeping), ...Object.keys(dropped), 'migrationVersion', ...Object.keys(disabledMarketplace), ...Object.keys(providerState), ...behavioral, ...interactive];
  assert.equal(new Set(names).size, 90);
  for (const name of names) {
    const classifier = createPersistenceDiagnosticClassifier();
    assert.equal(classifier.key('global', name), name); assert.equal(safePersistenceDiagnosticToken(name), name);
    assert.equal(classifier.key('project', name), 'unknown-1');
    assert.equal(classifier.key('global', name.toUpperCase()), 'unknown-2');
  }
  assert.deepEqual(verdicts({ modelAccessCache: ['privacy-canary-value'] }).diagnoses,
    [{ reason: 'value-shape', token: 'modelAccessCache' }]);
  assert.deepEqual(verdicts({ 'privacy-canary-name': 'privacy-canary-value', remoteControlAtStartup: true }).diagnoses,
    [{ reason: 'unknown-global-key', token: 'unknown-1' }]);
});

test('marketplace state admits only complete absence or the exact coherent disabled tuple', () => {
  assert.equal(verdicts({}).accepted, true);
  assert.equal(verdicts(disabledMarketplace).accepted, true);
  assert.equal(verdicts({ ...bookkeeping, ...disabledMarketplace }).accepted, true);
  const entries = Object.entries(disabledMarketplace);
  // Enumerate every nonempty partial tuple, including pairs in reversed key order.
  for (let mask = 1; mask < 7; mask++) {
    const partial = Object.fromEntries(entries.filter((_, index) => mask & (1 << index)).reverse());
    assert.equal(verdicts(partial).accepted, false, `partial tuple ${mask}`);
  }
  for (const [key, expected] of entries)
    for (const value of [true, false, null, 0, 1, 'true', 'false', 'policy_blocked', 'unknown', '', [], {}]) {
      if (value === expected) continue;
      assert.equal(verdicts({ ...disabledMarketplace, [key]: value }).accepted, false, `${key}/${JSON.stringify(value)}`);
    }
  for (const key of ['officialMarketplaceAutoInstallRetryCount', 'officialMarketplaceAutoInstallLastAttemptTime',
    'officialMarketplaceAutoInstallNextRetryTime']) for (const value of [false, null, 0, 1, '', {}, []]) {
    assert.equal(verdicts({ [key]: value }).accepted, false, key);
    assert.equal(verdicts({ ...disabledMarketplace, [key]: value }).accepted, false, key);
  }
  assert.equal(verdicts({ projects: { sample: disabledMarketplace } }).accepted, false);
});

test('published first-only diagnostics retain reviewed names and omit values', () => {
  const stream = channel('aih.native.diagnostics.v1'), records = [];
  const subscriber = record => records.push(record);
  stream.subscribe(subscriber);
  try {
    for (const value of [{ modelAccessCache: 'privacy-canary-value', remoteControlAtStartup: true },
      { 'privacy-canary-name': 'privacy-canary-value' }]) {
      const result = verdicts(value);
      assert.equal(result.diagnoses.length, 1);
      publishNativePersistenceDiagnostics({ stage: 'before-session-2', class: 'inspected-state', items: [],
        truncated: true, inspectedDiagnosis: result.diagnoses[0] });
    }
    assert.deepEqual(records.map(record => record.inspectedDiagnosis), [
      { reason: 'value-shape', token: 'modelAccessCache' }, { reason: 'unknown-global-key', token: 'unknown-1' }
    ]);
    assert.equal(JSON.stringify(records).includes('privacy-canary'), false);
    for (const record of records) assert.ok(Object.isFrozen(record.inspectedDiagnosis));
  } finally { stream.unsubscribe(subscriber); }
});

test('behavior-relevant provider state admits only bounded closed model access records and boolean org state', () => {
  assert.equal(verdicts(providerState).accepted, true);
  assert.equal(verdicts({ ...bookkeeping, ...disabledMarketplace, ...providerState }).accepted, true);
  for (const value of [[], [{ apiName: '', entitled: false }],
    Array(256).fill({ apiName: 'sample', entitled: true })]) {
    assert.equal(verdicts({ modelAccessCache: value }).accepted, true);
  }
  assert.equal(verdicts({ modelAccessCache: [{ apiName: 'x'.repeat(65536), entitled: true }] }).accepted, true);
  for (const value of [null, false, 0, '', {}, ['sample'], [null], [[]], [{}],
    [{ apiName: 'sample' }], [{ entitled: true }], [{ apiName: 1, entitled: true }],
    [{ apiName: null, entitled: true }], [{ apiName: {}, entitled: true }],
    [{ apiName: 'sample', entitled: 'true' }], [{ apiName: 'sample', entitled: 0 }],
    [{ apiName: 'sample', entitled: null }], [{ apiName: 'x'.repeat(65537), entitled: true }],
    [{ apiName: 'sample', entitled: true, extra: false }],
    [{ apiName: 'sample', entitled: true, env: {} }], Array(257).fill({ apiName: 'sample', entitled: true })])
    assert.equal(verdicts({ modelAccessCache: value }).accepted, false, JSON.stringify(value).slice(0, 100));
  for (const value of [true, false]) assert.equal(verdicts({ penguinModeOrgEnabled: value }).accepted, true);
  for (const value of [null, 0, 1, '', 'false', 'true', [], {}])
    assert.equal(verdicts({ penguinModeOrgEnabled: value }).accepted, false);
  assert.equal(verdicts({ projects: { sample: providerState } }).accepted, false);
});
