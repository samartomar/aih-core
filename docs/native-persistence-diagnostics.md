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
    kind: 'file' | 'dir' | 'other', token: string
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
are capped at 16, exported depth at 64, and the fixed token set bounds serialized
records to less than 4096 bytes. Unknown tokens are opaque per-run ordinals
`unknown-<n>`; they are neither names nor hashes. Ordinals restart with each run
and identify observations, without promising name equality across observations.
No values, file contents, exception text, reconstructed paths, raw names or
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
| `state-tree-entry` | A client-state tree contains a link, non-regular entry, hard link, or loading exclusion. |
| `inspected-state` | An inspected state file has invalid shape, exceeds its byte bound or fails its inspector. |
| `read-failure` | Metadata, directory enumeration or regular-file capture is unavailable. A failed inspected read additionally reports `read-failure`. |
| `limit` | The existing 4096-entry or 32-relative-level state walk limit was exceeded. |

Root/ancestor pin failures may have no item because they are outside the two
exportable roots. Depth counts relative segments under `home` or `project`; root
read failures have depth 0. `other` includes links and unavailable entry kinds.
The check still stops at the first failure. On unexpected entries or state-tree
exclusions/invalid entries, diagnostics may inspect up to 15 immediate siblings
from the same directory listing, without following links, recursing or reading
contents. Other failures report only the first item. These early stops always
set `truncated: true`, meaning evidence is partial even when fewer than 16 items
are present. Diagnostic reads cannot replace the first failure or add a new
cancellation/budget gate.

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
`.claude/telemetry`, and exactly `.cache/claude-cli-nodejs`. It admits no project
state paths. `XDG_CACHE_HOME` remains `<home>/.cache`; `.cache` is permitted only
as the directory parent of the exact cache state root, so other children and near
matches still fail as `unexpected-entry`.

Static tracing of the pinned Claude Code 2.1.285 executable identifies JSONL error
and MCP logs under sanitized cwd names, in `errors/` and `mcp-logs-<sanitized server>/`.
Only the output writer and age-based cleanup consume this subtree; no configuration
or instruction loader uses it in that version. This rationale is version-specific.
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
| Immediate children of `home/.claude` (depth 2) | `todos`, `session-env`, `shell-snapshots`, `statsig`, `file-history`, `plans`, `paste-cache`, `debug`, `ide`, `.oauth_refresh.lock`, `projects`, `backups`, `telemetry`, `history.jsonl`, `.claude.json`, `.credentials.json`, `settings.json`, `settings.local.json`, `CLAUDE.md`, `agents`, `commands`, `skills`, `plugins`, `hooks`, `output-styles`, `local` |
| Immediate children of `home/.config`, `home/.cache`, `home/.local` (depth 2) | `claude`, `claude-cli-nodejs`, `state`, `share` |
| `project` top level (depth 1) | `.claude`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md` |
| Top-level keys of inspected `home/.claude/.claude.json` (representative; see the exported dictionary) | `projects`, `numStartups`, `firstStartTime`, `userID`, `machineID`, `oauthAccount`, `hasCompletedOnboarding`, `lastOnboardingVersion`, `lastReleaseNotesSeen`, `installMethod`, `autoUpdates`, `cachedGrowthBookFeatures`, `cachedDynamicConfigs`, `theme`, `preferredNotifChannel`, `hasSeenTasksHint`, `mcpServers`, `allowedTools`, `permissions`, `hooks`, `env`, `apiKeyHelper` |
| Keys immediately inside each record in that JSON file's `projects` map (representative; see the exported dictionary) | `allowedTools`, `mcpServers`, `mcpContextUris`, `enabledMcpjsonServers`, `disabledMcpjsonServers`, `enableAllProjectMcpServers`, `hasTrustDialogAccepted`, `hasClaudeMdExternalIncludesApproved`, `ignorePatterns`, `projectOnboardingSeenCount`, `lastSessionId`, `lastCost`, `lastDuration`, `lastModelUsage`, `history`, `permissions`, `hooks`, `env` |

For example, a file named `todos` beneath `projects/` receives an ordinal. Project
map path keys are never classified. A malformed project map or project record is
`not-record`, optionally identifying the fixed `projects` container token. Unknown
global/project keys report a dictionary token only at the relevant key location.
The inspector retains its boolean admission result and additionally supplies a
closed diagnosis through an optional observer. Rejected bookkeeping with nested
grant content is diagnosed with a separate bounded scan (at most 1024 nodes),
identifying only the containing top-level bookkeeping key. If the bounded scan
does not establish a grant, the diagnosis stays `value-shape`.
