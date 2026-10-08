# Native persistence diagnostics

Core checks selected configuration and client-owned state before session 2 and
after session 2. An optional subscriber to Node's `diagnostics_channel` channel
`aih.native.diagnostics.v1` receives one record for each failed persistence check:

```ts
{
  schema: 'aih.native.diagnostics.v1',
  event: 'native-persistence-diagnostics',
  recordId: string, // fresh UUID
  runSha256: string | null, // same cell binding as native session diagnostics
  phase: 'persistence',
  stage: 'before-session-2' | 'after-session-2',
  class: 'pins' | 'configuration-facts' | 'selected-member' |
    'unexpected-entry' | 'state-tree-entry' | 'inspected-state' |
    'read-failure' | 'limit',
  items: Array<{
    root: 'home' | 'project', depth: number,
    kind: 'file' | 'dir' | 'other', token: string, parent: string | null
  }>,
  truncated: boolean,
  inspectedDiagnosis: null | {
    reason: 'unknown-global-key' | 'unknown-project-key' | 'grant-content' |
      'value-shape' | 'malformed-json' | 'oversized' | 'not-record' | 'read-failure',
    token: string | null
  }
}
```

These are the exact record keys. Records, items and diagnoses are frozen. Items
are capped at 16, exported depth at 64, and the publisher enforces a serialized record bound of less than 4096 bytes.
Items removed to meet that bound set `truncated: true`. Unknown tokens are opaque per-run ordinals
`unknown-<n>`; they are neither names nor hashes. Ordinals restart with each run
and identify observations, without promising name equality across observations.
The `parent` token classifies the parent at its own exact structural location
using the same classifier. Items at depth 0 or 1 have `parent: null`. Unknown
parents receive a fresh observation ordinal, even when two items have the same
parent; they do not establish name equality. No values, file contents, exception
text, reconstructed paths, raw names or
dynamic project-map keys are exported. Item array length counts only the reported
offenders; it is not a total count of the state tree or project map.

## Failure classes

Core decides the first failure class in the existing check order:

| Class | Failed check |
| --- | --- |
| `pins` | Cell or selected path identity no longer matches its pinned identity. |
| `configuration-facts` | A selected file's captured identity, timestamps or size changed. |
| `selected-member` | Selected regular-file shape, single-link identity, byte length or digest does not match. |
| `unexpected-entry` | An entry outside declared configuration/state, or an invalid entry on the configuration walk. |
| `state-tree-entry` | Client state has a link, non-regular entry, hard link, loading exclusion, wrong declared shape or nonempty empty-directory entry. |
| `inspected-state` | An inspected state file has invalid shape, exceeds its byte bound or fails its inspector. |
| `read-failure` | Metadata, directory enumeration or regular-file capture is unavailable. A failed inspected read additionally reports `read-failure`. |
| `limit` | The existing 4096-entry or 32-relative-level state walk limit was exceeded. |

Root/ancestor pin failures may have no item because they are outside the two
exportable roots. Depth counts relative segments under `home` or `project`; root
read failures have depth 0. `other` includes links and unavailable entry kinds.
Admission still stops at the first failure. With diagnostics enabled, a separate
bounded metadata walk can collect offenders across both roots and multiple
branches, including ordinary rejected directories. It uses only `lstat` and
directory names, never follows links or reads rejected contents, and verifies
directory identities before enumeration and metadata access. Failed pin checks
are not traversed; changed directory identities, containment failures, links,
selected members, explicit single-file/empty-directory state roots and rejected inspected containers are not crossed.

The diagnostic walk spends only the admission walk's remaining 4096-entry
budget, stops at 16 reported items, and retains the 32-relative-level state-tree
boundary (32 levels under a root for undeclared branches). It does not add
cancellation/budget gates after a decision. A later read or traversal failure
never replaces the original class, verdict or stop. Records retain
`truncated: true`: coverage is incomplete when a boundary or cap stops metadata
collection, and later inspected contents are never checked. A limit as the
original failure retains its `limit-exceeded` stop and does not start this walk.

Core supplies structural facts internally to the installed Harness classifier.
The installed adapter publishes the resulting record using the existing runtime
seam. Core contains no client-specific dictionary. No subscriber is needed for
verification. Public result schemas, verdicts and reasons are unchanged:
ordinary rejection remains `configuration-changed`, limits still throw
`limit-exceeded`, and cancellation/budget stops do not publish failure records.

## Claude client-state boundary

The installed Claude plan admits home state at `.claude/projects` (with its fixed
loading exclusions), inspected `.claude/.claude.json`, `.claude/.claude.json.lock`,
`.claude/backups`, `.claude/history.jsonl`, `.claude/history.jsonl.lock`,
`.claude/telemetry`, empty-directory-only `.claude/sessions`, single-link-file-only
`.claude/.last-cleanup`, and exactly `.cache/claude-cli-nodejs`. It admits no project
state paths. `XDG_CACHE_HOME` remains `<home>/.cache`; `.cache` is permitted only
as the directory parent of the exact cache state root, so other children and near
matches still fail as `unexpected-entry`.

The verifier sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the environment built
from scratch for both sessions on every platform. This disables auto-memory
creation, background extraction and next-session instruction loading. A managed
`autoMemoryEnabled` key or managed `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY` key,
with any value, is a `restricted` / `managed-restriction` outcome. A known
restriction takes precedence over unreadable sibling keys or sources; malformed
or unreadable policy alone remains unreadable. Verification never overrides
managed policy, and unobserved managed sources remain an evidence limitation.

Both session environments also fix
`CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1` and
`CLAUDE_CODE_DISABLE_FAST_MODE=1`, regardless of host values. Presence of either
managed env key, including empty, `0` or `false` values, is
`restricted` / `managed-restriction` with the same precedence. For the pinned
Claude Code 2.1.285 client, global state admits only the complete disabled tuple
`officialMarketplaceAutoInstallAttempted=true`, `officialMarketplaceAutoInstalled=false`,
and `officialMarketplaceAutoInstallFailReason="policy_blocked"`, or complete
absence. Partial tuples, other values and retry counters/timestamps remain refused.
No plugin files, configuration or installation paths are admitted by this rule.
The existing provider-cache limitation additionally admits behavior-relevant
`modelAccessCache` (at most 256 closed `{apiName: string, entitled: boolean}`
records; each string at most 65536 characters) and boolean `penguinModeOrgEnabled`.
Each session's authentication, loading, restriction and tool evidence remains
independent. Selected settings mutations still fail persistence validation;
`lastSeenOrgDefaultUpdatedAt` and `gzipRequestBodiesLatchedOff` remain refused.
These reviewed key names are disclosed only at their global-key location;
diagnostics disclose no values and never change admission.

The exact home `.claude/sessions` path is admitted only as an ordinary empty
directory at each persistence checkpoint, after descendant quiescence. Absence
is also accepted. Any child (including a PID record, socket-path record, nested
directory or link) or enumeration failure is refused; this is not a recursive
state tree. The exact home `.claude/.last-cleanup` path is admitted only as an
ordinary regular file with link count one. It is housekeeping control metadata
whose contents are not inspected; the client reads back only its mtime. Links,
reparse points, hard links, wrong shapes and case/path near-matches are refused.
Per-project `*/memory` remains excluded whether empty or populated, and selected
configuration bytes remain immutable.

This rationale is specific to Claude Code 2.1.285, executable SHA-256
`33dad1ec615a2e08cc78b494f05c110e49916de2c79d78ec8799ebf46b233d29`.
Native acceptance of the changed packed distribution is pending; controlled
checks do not establish native acceptance.

Static tracing of the pinned Claude Code 2.1.285 executable identifies JSONL error
and MCP logs under sanitized cwd names, in `errors/` and `mcp-logs-<sanitized server>/`.
For that executable and the admitted invocation, the enumerated static trace
identifies the log writers and age-based cleanup beneath this tree; no configuration
or instruction reader was identified in that trace. No configuration or instruction discovery into this subtree was established for the traced local inputs; unobserved server-managed policy may alter loader roots. This rationale is version-specific.
The walker accepts an ordinary single-link file or a directory at the uninspected
root and regular files/directories beneath it. Even `settings.json` and `CLAUDE.md`
are allowed there as inert state: a passing walk proves allowance, while the loading
conclusion rests on that static trace. Parent/root/descendant links, hard links,
special files, and depth/entry-limit violations remain refused; selected
configuration mutations still fail.

Logs may contain MCP server stderr. Verification never reads, ingests or exports
their contents or dynamic names. Successful whole-cell cleanup deletes them, but
failed cleanup retains the cell and reports its opaque recovery name. Deletion
is conditional and does not rely on client pruning. The disclosure dictionary
below does not admit additional state.

## Disclosure dictionary and structural locations

This dictionary permits disclosure only. It is independent of the state admission
allowlist. Matching is exact and case-sensitive; entry kind does not widen a
token's location. The complete, authoritative dictionary is the exported
`persistenceDiagnosticDictionary` in `dist/harness/native/persistence-diagnostics.mjs`.
The table lists every entry location in full; for the two key locations it shows
representative tokens. The key lists also contain the configuration key names the
supported client version defines in its default global configuration and its
user-settable configuration keys, plus the state keys this package already
classifies. Every name absent from that dictionary, or found at a different
location, receives an ordinal.

| Location | Fixed tokens |
| --- | --- |
| `home` top level (depth 1) | `.claude`, `.config`, `.cache`, `.local`, `AppData`, `.npm`, `.bun` |
| Immediate children of `home/.claude` (depth 2) | `todos`, `session-env`, `shell-snapshots`, `statsig`, `file-history`, `plans`, `paste-cache`, `debug`, `ide`, `.oauth_refresh.lock`, `projects`, `backups`, `telemetry`, `history.jsonl`, `.claude.json`, `.credentials.json`, `settings.json`, `settings.local.json`, `CLAUDE.md`, `agents`, `commands`, `skills`, `plugins`, `hooks`, `output-styles`, `local`, `sessions`, `.last-cleanup`, `stats-cache.json`, `active-time.json`, `policy-limits.json`, `remote-settings.json`, `remote-settings-consent.json`, `remote-settings-helper-consent`, `mcp-needs-auth-cache.json`, `cache`, `image-cache`, `uploads`, `tasks`, `teams`, `jobs`, `state`, `startup-perf`, `traces`, `usage-data`, `.config.json`, `.update.lock`, `.last-update-result.json`, `.deep-link-register-failed`, `keybindings.json`, `themes`, `workflows`, `rules`, `cowork_plugins`, `loop.md`, `daemon.json`, `scheduled_tasks.json`, `launch.json`, `memory`, `agent-memory`, `mcp-skill-archives`, `mcp-discovery-cache`, `file-transfers`, `shares`, `feedback-bundles`, `feedback`, `dump-prompts`, `chrome`, `seed-admin`, `daemon`, `remote-control`, `gh-pr-status-cache.json`, `hfi-auth.json`, `ccr` |
| Immediate children of `home/.config`, `home/.cache`, `home/.local` (depth 2) | `claude`, `claude-cli-nodejs`, `state`, `share` |
| Additional immediate children of `home/.config` (depth 2) | `anthropic`, `git`, `gh`, `gcloud`, `glab-cli` |
| Additional immediate children of `home/.local` (depth 2) | `bin` |
| `project` top level (depth 1) | `.claude`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md` |
| Top-level keys of inspected `home/.claude/.claude.json` (representative; see the exported dictionary) | `projects`, `numStartups`, `firstStartTime`, `userID`, `machineID`, `oauthAccount`, `hasCompletedOnboarding`, `lastOnboardingVersion`, `lastReleaseNotesSeen`, `installMethod`, `autoUpdates`, `cachedGrowthBookFeatures`, `cachedDynamicConfigs`, `theme`, `preferredNotifChannel`, `hasSeenTasksHint`, `mcpServers`, `allowedTools`, `permissions`, `hooks`, `env`, `apiKeyHelper` |
| Keys immediately inside each record in that JSON file's `projects` map (representative; see the exported dictionary) | `allowedTools`, `mcpServers`, `mcpContextUris`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `enableAllProjectMcpServers`, `hasTrustDialogAccepted`, `hasClaudeMdExternalIncludesApproved`, `ignorePatterns`, `projectOnboardingSeenCount`, `lastSessionId`, `lastCost`, `lastDuration`, `lastModelUsage`, `history`, `permissions`, `hooks`, `env` |

Names such as `sessions`, `policy-limits.json` and `remote-settings.json` may be
input-capable; disclosure does not admit them. `.last-cleanup` is housekeeping
control metadata for the pinned client; it also remains refused. Nested static
names and dynamic PID/session names are not added to the dictionary.

For example, a file named `todos` beneath `projects/` receives an ordinal. Project
map path keys are never classified. A malformed project map or project record is
`not-record`, optionally identifying the fixed `projects` container token. Unknown
global/project keys report a dictionary token only at the relevant key location.
The inspector retains its boolean admission result and additionally supplies a
closed diagnosis through an optional observer. Rejected bookkeeping with nested
grant content is diagnosed with a separate bounded scan (at most 1024 nodes),
identifying only the containing top-level bookkeeping key. If the bounded scan
does not establish a grant, the diagnosis stays `value-shape`.
