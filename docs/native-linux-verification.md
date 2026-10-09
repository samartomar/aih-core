# Linux native verification admission

The bundled `claude-linux-x64-wsl2-srt-2.1.285` definition is admitted for
Claude Code 2.1.285 on Linux x64 WSL2, osRelease
`6.18.33.2-microsoft-standard-WSL2`, with `clientVersions: ["2.1.285"]`.
Its retained reviewed batch evidence is identified by `evidenceSha256`
`a8c226d1c56764a6c773268186a79a3643e5a5d0afc2acd9f9708faa9de50947`.
It selects without `candidate-smoke`; the Windows definition remains a candidate
with null evidence and still requires that mode. Passing a smoke never promotes
a definition.

Admission is a registry fact. Both the portable validator and the published
`native-verification-definition` 1.1.0 JSON Schema accept `state: "admitted"`
only for a descriptor exactly equal to a registered admitted definition; the
schema enumerates those descriptors, and a test keeps that list identical to the
registry. The 1.0.0 schema has no registered admission and refuses the admitted
state.

The tested packed artifact was Core `1.0.0-dev.27`; Core `1.0.0-dev.28` promotes
only this descriptor. Promotion is not publication: no npm publish has occurred.
Coverage is the bundled mechanism only, not Catalog's cross-client matrix.
Acceptance covers the fixed verifier environment: auto-memory disabled,
marketplace auto-install disabled, fast mode disabled, and MCP connections
awaited before init within the client's bounded timeout. Authentication uses
`provisioning-bound-session` identity, with the owner's recorded acceptance:
it loses the runtime wrong-account/refresh cross-check and is not provider-signed
attestation. The proxy and policy limitations below remain part of that acceptance.

It selects kernel `6.18.33.2-microsoft-standard-WSL2`, Node 24.19.0 and the exact
runtime bytes in `dist/harness/native/linux/runtime-platform.json`. Other Linux,
Windows and macOS environments need their own definitions and evidence. An
ordinary `verify-client` call cannot promote a candidate or select a custom policy.

## Fixed workload boundary

Platform-runtime pinned re-reads allow a multi-link regular file only on POSIX
when it is root-owned (uid 0) with no group or other write bits, every ancestor
is a real root-owned directory with no group or other write bits, and device,
inode, size, mtime, ctime and link count stay stable across the read. The pinned
SHA-256 still has to match. This supports stock Ubuntu's rust-coreutils multicall
`env` without a host single-link copy. Client executable, material, cell and
other reads remain single-link, and Windows behavior is unchanged.

Harness wraps the version probe and each complete client session in a fresh
instance of Anthropic Sandbox Runtime 0.0.78. The unmodified dependency and its
transitive JavaScript closure are bundled and checked against `runtime-lock.json`.
The wrapper imports the SDK entry, never the vendor CLI. The implementation uses
the [released vendor source](https://github.com/anthropic-experimental/sandbox-runtime/tree/6f0ce155ccb136bda33a8a72201fe7f54fe47d9b).

The fixed profile denies filesystem reads outside enumerated runtime files,
selected cell roots and authenticated IPC paths. Only cell home, project and
scratch are writable; selected configuration and guardrails stay read-only.
Library aliases are materialized from independently pinned bytes. The sole loader
directory grant requires an exact root-owned, single-symlink inventory. Missing,
changed or unexpected files refuse the definition; verification never installs,
downloads, compiles or repairs prerequisites.

The vendor also supplies its pinned seccomp support and Java proxy agent. Its
implicit mounts and environment changes are part of the reviewed vendor closure.
Pre-existing vendor convenience write roots are refused. The fixed configuration
has no TLS interception, credential injection, ask callback or live policy update.
Only the exact local telemetry collector and fixed provider destinations can pass
the proxy allowlist. `NO_PROXY` and `no_proxy` are removed after vendor setup so
the collector must traverse that proxy.

Both acceptance sessions share one immutable base and once-staged supporting
files. Reuse checks their exact bytes and file identities; concurrent use or a
changed input refuses the session. The earlier version preflight has its own
fixed profile and receives no dedicated identity or selected configuration.
Per-launch derivation adds only the exact collector IP/port and enumerated IPC
socket paths. Both the host and runner compare the full derived profile and its
serialized bytes with the fixed base. Public requests accept no wrapper,
environment, proxy endpoint, hostname list or sandbox configuration.

## Evidence and cleanup

The bundled static PIE helper pins executable/runtime bytes, holds kernel process
identities, observes Unix-socket credentials and adopts descendants as a Linux
subreaper. The workload, client and selected MCP peer must have matching PID,
mount, user and network namespaces, each distinct from the host. A namespace PID
claimed in a protocol message is only a cross-check after kernel authentication.
The observer launches the real client itself and holds it behind a private
launch gate. Before releasing that gate it attaches with unprivileged
`PTRACE_SEIZE` to this one root only, so kernel fork, vfork, clone, exec and exit
stops apply before the client's first instruction and to every traced descendant.
Each new process is held at its kernel stop while its executable, namespaces and
actual argv are read twice with matching results; each captured generation is
classified and then explicitly acknowledged. A failed capture may be resumed for
lifecycle progress and bounded cleanup, but its argument coverage is then
unavailable or a permanent gap and can never become clean. If tracing is denied,
for example by Yama ptrace scope, another security module or seccomp, the launch
is unavailable. There is no untraced fallback or exemption.

Before the client continues, synthetic probes check host-home, sibling,
provisioner and outside temporary files; pathname and abstract agent sockets;
inherited environment and descriptors; host process access; wrong loopback ports;
unapproved egress; the allowed collector; writable roots; and selected read-only
files. They never probe real host secrets. Missing proof stays unavailable, and
proven access fails isolation. Uncorrelated traffic to a host canary prevents
admission but cannot itself prove that the workload escaped.

WSL2 additionally checks mounted Windows volumes, interop entry points and a
known executable synthetic Windows canary. A native helper calls `execve`
directly, avoiding shell fallback. It recognizes a missing interpreter, or an
access refusal with the executable canary intact and `/init` independently
observed as the vendor's non-executable `/dev/null` mask. The admitted definition
requires independently observed NAT networking. Mirrored networking remains
unavailable pending a separate Windows-side loopback denial proof.

One ten-second cleanup allowance covers the owned tree, including outer proxy
helpers and detached descendants. An empty process group alone is insufficient.
The helper must reap all owned children, close authenticated transports and
confirm cleanup. Synthetic files and exact vendor leftovers are removed only
after process cleanup; unexpected material is preserved and cleanup stays unresolved.

## Identity and acknowledged limits

Dedicated OAuth provisioning remains an operator step separate from verification;
the normal login profile is never a credential source. A protected credential
file alone is not authentication proof. Both fresh sessions require successful
same-session API telemetry bound to the independently selected account and
organization. File-based Linux managed policy and verified Windows host managed
policy are checked outside the sandbox. Restricting policy wins; unreadable or
unknown policy gives unavailable. Registry, MDM and server-managed policy retain
their explicitly unobserved limitations.
Managed `env` blocks use one classification on every observer, with
case-insensitive key matching. Any key matching the fixed or telemetry switches
(`CLAUDE_CODE_DISABLE_AUTO_MEMORY`,
`CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL`,
`CLAUDE_CODE_DISABLE_FAST_MODE`, `MCP_CONNECTION_NONBLOCKING`, `OTEL_*`,
`CLAUDE_CODE_ENABLE_TELEMETRY*`, `CLAUDE_CODE_ENHANCED*`, `DISABLE_TELEMETRY`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) is `restricted`. A non-object block or
any other key is unreadable, so it gives unavailable rather than clear; a
restriction still wins. An absent or empty block is clear.
Top-level keys also use one classification on every observer, for
`managed-settings.json` and each `managed-settings.d/*.json` fragment: a known
restricting key is `restricted` even beside an unknown sibling, the allowlisted
`theme` scalar is clear only with a bounded lowercase token, and any other key is
unreadable. Top-level matching is exact-case on every OS because the keys are
JSON property names; a case variant is unreadable, never clear.

Process observation requires the host to let an unprivileged process trace a
child it launched: the observer uses only `PTRACE_SEIZE` on its own held client,
with no added capability, setuid helper or host policy change. Where Yama ptrace
scope, another security module or seccomp denies that, the session is unavailable
rather than exempted. Every captured argument generation is retained until it is
classified and acknowledged; a pending generation, or a lifetime that ended without
an acknowledged capture, keeps argument proof unavailable. A confirmed executable
replacement needs its own captured and acknowledged generation; a different image
appearing before that capture, or the lifetime ending first, is a permanent gap.
Matching argument reads that span a namespace change are kept as a generation to
classify, any earlier acknowledgement stops counting, and coverage returns only
after a consistent capture in the new namespaces is itself acknowledged; ending
before that capture is a permanent gap. A complete argument observation that
differs from the last retained one, or spans a namespace change, is never
discarded because the process then exits: it is kept for classification and the
lifetime is a permanent gap. Capture is sampled at
kernel stops and audits, so arguments rewritten in place between samples, clones
created explicitly with `CLONE_UNTRACED` and exec from a non-leader thread are
outside the claim; the last fails closed.

The client's ordinary state persists in the cell between the two sessions,
including provider feature-gate and experiment caches in its global state file
(for example `cachedGrowthBookFeatures`, `cachedDynamicConfigs` and the
`cachedExperiment*` keys). Those caches can change how the second session starts.
This is an accepted limitation: the second session's loading, restriction,
tool-discovery and authentication evidence is still observed independently, and
new instruction, settings, MCP, memory or managed-policy files outside uninspected
state remain configuration changes.

The verifier sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the environment built
from scratch for both sessions on every platform. This disables auto-memory
creation, background extraction and next-session instruction loading. A managed
`autoMemoryEnabled` key or managed `env.CLAUDE_CODE_DISABLE_AUTO_MEMORY` key,
with any value, is a `restricted` / `managed-restriction` outcome. A known
restriction takes precedence over unreadable sibling keys or sources; malformed
or unreadable policy alone remains unreadable. Verification never overrides
managed policy, and unobserved managed sources remain an evidence limitation.

Both session environments also set literal `MCP_CONNECTION_NONBLOCKING=false`,
regardless of host values. With it, the pinned Claude Code 2.1.285 client awaits
each configured MCP connection before emitting init and starting the first turn,
bounded by its MCP connect timeout (`MCP_CONNECT_TIMEOUT_MS`, 5000 ms when unset;
the verifier does not set it). A server still unsettled at that bound keeps a
non-connected init status and does not pass loading. Acceptance covers this
verifier's fixed environment, not default client startup timing.
Presence of this key in managed env, regardless of value (including Windows case
variants), yields `restricted` / `managed-restriction`; verification does not
override managed policy. Pending, failed, authentication-required and disabled
servers remain nonpassing, and an observed list lacking the selected server
remains `configuration-not-loaded`. Deadlines, cancellation and cleanup are
unchanged.

Optional `aih.native.diagnostics.v1` session records include `init.serverStatus`
for the selected server, restricted to `connected`, `pending`, `failed`,
`needs-auth`, `disabled`, `absent`, `other` or `unobserved`. Unknown or malformed
statuses become `other`; no usable init/server-list observation becomes
`unobserved`. `absent` requires an observed server list lacking the selected
server. Diagnostics publish no raw status text or server identities and do not
change verdicts or first-failure precedence.

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
The retained reviewed evidence covers the tested Core `1.0.0-dev.27` packed
distribution in the fixed verifier environment; controlled checks alone do not
establish native acceptance.

The fixed home state paths additionally admit exactly `.cache/claude-cli-nodejs`;
`XDG_CACHE_HOME` stays `<home>/.cache`. Static tracing of the pinned Claude Code
2.1.285 executable identifies output-only JSONL logs at
`<cache>/<sanitized cwd>/errors/<timestamp>.jsonl` and
`<cache>/<sanitized cwd>/mcp-logs-<sanitized server>/<timestamp>.jsonl`. For that
executable and the admitted invocation, the enumerated static trace identifies the
log writers and age-based cleanup beneath this tree; no configuration or instruction
reader was identified in that trace. No configuration or instruction discovery into this subtree was established for the traced local inputs; unobserved server-managed policy may alter loader roots. This is a version-specific rationale,
not a loading guarantee for another client version.

The walker permits an ordinary single-link file or a directory at this exact
uninspected state root. `.cache` itself must be a directory parent, and its other
children, near-match names and project-root equivalents remain unexpected entries.
Names such as `settings.json` and `CLAUDE.md` within the tree are accepted as inert
state. This proves allowance only; the no-loader conclusion comes from the static
trace. Links, hard links, special files and the existing depth/entry limits still
fail closed. Selected configuration bytes remain immutable.

Logs may retain MCP server stderr. Verification never reads, ingests or exports
their contents. Successful whole-cell cleanup deletes the logs; failed cleanup
retains the cell under the existing opaque recovery-name reporting. Deletion is
conditional on cleanup success and does not rely on the client's own pruning.

The vendor places a fresh local proxy capability in its bubblewrap environment
arguments and shell command. This is an acknowledged argv exposure: local readers
permitted by host process visibility may reuse the capability for the same
allowlisted egress or denial of service while the proxy lives. It is not an OAuth,
identity, telemetry or evidence credential. The latter values must never appear
in argv. The observer audits the held client before it continues and each traced
process generation while the session runs; detected leaks remain failures after a
process exits. An owned lifetime without an acknowledged capture, a missing kernel
receipt or an unreadable live identity leaves argument proof unavailable. Accepted
limits: argv rewritten in place between captures is outside this observation,
clones created explicitly with `CLONE_UNTRACED` are not held by the kernel, and
exec from a non-leader thread is unsupported and fails closed. No raw capability
or argv is retained in admission records. The fixed
integration does not claim protection from a hostile host account or kernel.

Optional process-local subscribers to `aih.native.admission.v1` through Node's
`diagnostics_channel` receive profile/argv digests, closed proof booleans, fixed
restriction counts and cleanup status. There is no default file or network sink.
These records accompany acceptance evidence; they do not authorize or admit a cell.
Subscribers to `aih.native.diagnostics.v1` receive one counts-only record per session:
collector request, reply-reason, content-type/encoding and event-name counts, plus the
client result's error flag, closed subtype and provider error class (`none`,
`authentication`, `forbidden`, `rate-limit`, `overloaded`, `network`, `other`).
Collector `eventNames` contains only `apiRequest`, `apiError`, `userPrompt`,
`assistantResponse`, `toolResult`, `toolDecision` and `other`. The first six
classify the log attribute `event.name` values `api_request`, `api_error`,
`user_prompt`, `assistant_response`, `tool_result` and `tool_decision`, accepting
each with or without the `claude_code.` prefix. Log bodies and other attributes
never select an event type. As described in the
[Claude monitoring documentation](https://code.claude.com/docs/en/monitoring-usage#api-request-event),
an API request event need not carry a `success` attribute; absence or `true`
is accepted, while every other present value is ignored. Session, nonempty request
ID, time-window and duplicate checks still apply. Each present account or
organization attribute must equal its independently provisioned expectation;
either may be absent. This requires this verification run's successful identity
binding, pre-staging identity recheck and exact credential/configuration staging
from an owner-verified dedicated login. Empty strings, non-string OTLP identity
values, malformed value objects and repeated identity keys within a record are
invalid, even when repeated values match. Invalid or contradictory identity on
any authenticated bound-session event is a sticky `identity-conflict`; subsequent
matches cannot clear it. Wrong-session events never count or create a conflict.
Matching identities on non-API events alone cannot authenticate a session.

Collector `apiRequestRejected` contains only `missingRequestId`, `notSuccess`,
`missingSession`, `wrongSession` and `outsideWindow`. Request ID rejection
precedes the success check. Remaining candidates are classified by session:
absent/empty IDs count as `missingSession`, other IDs (including a candidate
awaiting binding) as `wrongSession`. The top-level `wrongSession` count includes
both. `outsideWindow` counts nonduplicate bound-session candidates with
missing/invalid event time or event/receipt time outside the window.

Collector `apiRequestIdentity` contains only `accountAbsent`, `organizationAbsent`,
`accountDifferent`, `organizationDifferent` and `invalidAttribute`. Absence is a
non-rejection count. Differences count valid present attributes unequal to their
expectation; `invalidAttribute` counts candidates with one or more invalid identity
attributes, never treating them as absent. These counts cover bound-session API
candidates after request ID/success checks, including duplicates and events
outside the window. Repeated snapshots recompute counts without accumulating them.

Collector `qualifyingSuccesses` contains only `telemetryIdentity` and
`provisioningBound`, counting deduplicated qualifying API successes with both
matching identities or with at least one absent identity respectively.
`authenticationProofKind` is null until final drain passes, then
`telemetry-identity` if at least one qualifying success carries both matching IDs,
otherwise `provisioning-bound-session`. Any conflict makes the kind null even if
qualifying-success counts are nonzero. A matching non-API event cannot upgrade
the proof kind. `boundSessionEvents` counts all bounded authenticated events
attributed to the session, including non-API and rejected events. Every count is
clamped to 1,000,000; no event strings or identity values are retained.

Proof kind is bound to the same cell run digest and session index in both the
optional diagnostics record (`collector.authenticationProofKind`) and Linux
admission record (`authenticationProofKind`). These observation channels do not
change the closed public request/result schemas and have no default sink.
Neither kind is provider-signed attestation. `provisioning-bound-session` relies
on owner verification of the actual login and its independently trusted identity
expectations, with pinned manifest and credential bytes. It loses the runtime
wrong-account/refresh cross-check; promotion evidence must record this limitation
and the owner's acceptance. These observations alone do not admit a cell.

Collector `identityByEvent` contains only `accountPresent`, `accountMatches`,
`organizationPresent` and `organizationMatches` counts. It considers every
bounded received event attributed to the bound session, in any event-name bucket,
including API events rejected for request ID or success and events outside the
authentication time window. Presence means the identity key occurs, including an invalid value; matches
use the same expected account and organization equality as authentication.
`firstMatchingEventIndex` is null until one such event matches both identities,
then holds its 1-based position among that session's received events, clamped to
1,000,000. Other-session and missing-session events do not count or occupy a
position. These fields are recomputed after session binding and on each snapshot
or drain. They diagnose identity timing only: a matching non-API event cannot
authenticate the session or clear an identity conflict. Contradictory or invalid
identity on these events invalidates authentication independently of API eligibility. The publisher freezes
the fixed keys and defaults malformed counts to zero and malformed indexes to
null. No account or organization ID string is retained in diagnostics.

The trusted Linux runner also counts SRT allow/deny decisions in fixed host buckets
(`apiAnthropic`, `claudeAi`, `platformClaude`, `consoleAnthropic`, `otherAnthropic`,
`collector`, `other`), each with `allowed` and `denied`; `proxy` is null when
unobservable or on Windows. Counts include isolation probes and indicate policy
decisions, not successful requests: an allowed hostname may subsequently be denied
by SRT's resolved-address guard. `collector` requires its exact loopback host/port;
`otherAnthropic` covers other names under anthropic.com, claude.com and claude.ai.
`runnerWarnings` is a top-level count of console warnings and errors the trusted runner
saw that were not SRT's `[SandboxDebug] `-prefixed debug lines (the genuine SRT warnings
and errors). The runner only counts them, saturating at 1,000,000; it never formats,
retains or re-emits their text and writes nothing to stdout or stderr, so the count
cannot change any client output byte budget. It is null on non-Linux platforms and
whenever `proxy` is null, and never affects admission or verdicts.
The `forwarder` block is null when absent or on non-Linux platforms; otherwise it
contains only `accepted`, `connected`, `refused` and `capped` counts (clamped to
1,000,000). After isolation probes finish, the trusted workload listens only on
the collector's literal 127.0.0.1 authority and tunnels through authenticated SRT
CONNECT, preserving the proxy allowlist. It admits at most 32 concurrent and 256
total tunnels, caps each direction at 4 MiB, expires idle sockets after 3 seconds,
and destroys all sockets before sending the end frame. `accepted` counts admitted
connections, `connected` counts 200 CONNECT replies, `refused` counts failures
before establishment, and `capped` counts limit rejections or byte/idle closures.
Payload bytes are streamed without parsing or retention. The direct-loopback
denial probe continues to target a separate host canary port.
SRT's supported debug logger and violation store are observed only in the outer
runner; client stderr cannot inject decisions. Numeric API status takes precedence
over regex classification within a message; the first specific class survives later
generic failures. They carry no client strings or hostnames, never change a verdict
and have no default sink.

## Build records and development checks

The package carries helper source, executable and build record. Linux CI compiles
the helper twice with fixed hardening flags, compares both outputs, and verifies
the committed binary. `scripts/build-linux-facility.mjs --check` is a developer/CI
operation; consumers use the supplied binary. The harmless Windows canary has a
separate source/compiler/binary record without a reproducible-build claim.

Explicit developer commands maintain the vendor and observer locks. Ordinary
builds check those locks and never regenerate them. Package acceptance validates
the installed resource bytes, schema 1.1, portable contracts and public API/CLI
failure behavior. Kernel facility tests and controlled synthetic sessions remain
distinct from real native account/configuration acceptance. Admission requires
the latter evidence for the exact packed distribution.

The host-only installed-package preparation gate in
`test/harness/native-linux-installed.test.mjs` needs a non-root Linux x64 WSL2 host
with the pinned runtime and an npm-installed `@aihq/core` package. Set
`AIHQ_TEST_LINUX_INSTALLED_CORE` to its absolute package directory under
`node_modules/@aihq/core` and `AIHQ_TEST_LINUX_CLIENT_PIN` to a JSON
`{path, sha256, byteLength}` pin for the client, then run
`node --test test/harness/native-linux-installed.test.mjs`. The gate prepares and
terminates the real sandbox without executing the client; CI skips it because
these variables are unset.
The same gate also re-reads every merged runtime pin except the client through
Core's runtime-pin reader and checks its SHA-256 without executing the client.
When a multi-link runtime pin exists, a separate assertion confirms that the
strict pinned-file reader still refuses it.
