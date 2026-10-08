# Changelog

## Unreleased

Core 1.0.0-dev.29 makes the published native verification definition schemas
refuse what the portable validator refuses for admission. The 1.1.0 schema
accepts `state: "admitted"` only for a descriptor exactly equal to a registered
admitted definition, which it enumerates; a test keeps that list identical to the
registry and checks schema/validator agreement for unregistered ids, changed
platform, runtime, argv, evidence and versions, and self-promoted candidates.
The 1.0.0 schema, which has no registered admission, now refuses the admitted
state. Registered definitions are unchanged: `claude-linux-x64-wsl2-srt-2.1.285`
stays admitted with the same evidence, and the Windows definition stays a
candidate.

Both Claude managed-policy observers now share one managed `env`
classification. The non-Linux file observer previously treated an unrecognised
managed env key as clear; it now fails closed as unreadable, consistent with the
Linux/WSL2 observer, and a non-object `env` block is unreadable on both. The
non-Linux observer also gains `DISABLE_TELEMETRY` and
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` as restrictions and parses managed
settings strictly like the Linux observer, so a duplicate key is unreadable rather
than letting a later `env` block erase an earlier restriction. Key matching is
case-insensitive on every observer, so a case variant of a fixed or telemetry
key read by the Linux/WSL2 observer is now `restricted` instead of unreadable.
Absent or empty env blocks remain clear. This candidate has not been published to
npm.

Core 1.0.0-dev.28 promotes only `claude-linux-x64-wsl2-srt-2.1.285` to admitted
for Claude Code 2.1.285 on Linux x64 WSL2, osRelease
`6.18.33.2-microsoft-standard-WSL2`. Retained reviewed batch evidence is identified
by `evidenceSha256`
`a8c226d1c56764a6c773268186a79a3643e5a5d0afc2acd9f9708faa9de50947`;
the tested packed artifact was Core 1.0.0-dev.27. Selection no longer requires
`candidate-smoke` for that definition; the Windows definition remains a candidate
with null evidence and requires that mode. A descriptor is valid as admitted only
when it exactly equals a registered admitted definition: altered evidence, extra or
unexact client versions, any other changed field, an unregistered id and a candidate
claiming admission are refused. Platform/runtime pins,
argv, lifecycle, isolation and guardrails are unchanged.

Acceptance covers the fixed verifier environment: auto-memory disabled,
marketplace auto-install disabled, fast mode disabled, and MCP connections awaited
before init within the client's bounded timeout. Authentication uses
`provisioning-bound-session` identity, with the owner's recorded acceptance:
it loses the runtime wrong-account/refresh cross-check and is not provider-signed
attestation. Existing proxy/policy limitations remain. Coverage is the bundled
mechanism only, not Catalog's cross-client matrix. Promotion is not publication;
no npm publish has occurred.

Core 1.0.0-dev.27 sets literal `MCP_CONNECTION_NONBLOCKING=false` in both Claude
verification sessions on every platform, so the pinned client awaits configured
MCP connections before init and the first turn. Acceptance covers the verifier's
fixed environment rather than default client startup timing. Any managed env
presence of the key is a restriction regardless of value, including Windows
case variants; managed policy is never overridden. Optional session diagnostics
report only a closed, normalized selected-server init status, with no server
identities or raw status text. Unsuccessful connections remain nonpassing;
verdicts, first-failure precedence, deadlines, cancellation and cleanup are
unchanged. Native acceptance remains pending. This candidate has not been
published to npm.

Core 1.0.0-dev.26 admits six bounded Claude Code 2.1.285 notice/history markers
and the pinned migration-batch constant 14.
Issue-check and onboarding timestamps accept only nonnegative safe integers;
the auto-mode warning marker accepts only `true`, and guest-pass remaining counts
reject `null`. Unsupported response slots, campaign caches, GitHub connection
status, MCP histories and review-use keys remain refused while
diagnostics disclose their reviewed names. Bookkeeping maps reject nested grant
names. Both session environments on every platform fix
`CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1` and
`CLAUDE_CODE_DISABLE_FAST_MODE=1`; either managed env key's presence is a managed
restriction regardless of value. Global marketplace state admits only the complete
disabled tuple (`Attempted=true`, `Installed=false`, `FailReason="policy_blocked"`)
or complete absence; retry counters and timestamps remain refused. Bounded closed
`modelAccessCache` records and boolean `penguinModeOrgEnabled` are admitted as
behavior-relevant provider state under the existing provider-cache limitation,
pinned to Claude Code 2.1.285. Selected settings mutations still fail persistence.
`lastSeenOrgDefaultUpdatedAt`, `gzipRequestBodiesLatchedOff`, other model choices,
marketplace installation, remote-control, transport and preference inputs remain
refused. Persistence diagnostics name
reviewed global updater keys while retaining ordinal tokens for unreviewed names;
values are never disclosed and admission decisions are unchanged by diagnostics.
The existing diagnostic contract continues to report the first inspected-state
failure. Native acceptance remains pending. This candidate has not been published
to npm.

Core 1.0.0-dev.25 applies backpressure in the Linux facility helper: child and
peer bytes are read only while its outbound queue can accept another data frame,
so a slow consumer no longer overflows the queue, silently drops output, loses an
output-limit failure or leaves cleanup unresolved. The rebuilt helper carries a
new build record. Windows mechanism tests now give preparation a deadline that
loaded runners cannot exhaust before the behaviour under test. This development
candidate has not been published to npm.

Core 1.0.0-dev.24 accepts Claude's first-start version as bounded text and its
artifact-roster denial metadata as a shallow record of bounded scalar values.
Record-valued first-start versions, nested grants and other unsupported shapes
remain refused. This development candidate has not been published to npm.

Core 1.0.0-dev.23 disables Claude auto-memory in both session environments on
all platforms and refuses managed auto-memory setting/environment keys with
any value as managed restrictions. Known restrictions retain precedence over
unreadable observations. Exact `.claude/sessions` state is accepted only as an
empty ordinary directory after descendant quiescence; any child or enumeration
failure is refused. Exact `.claude/.last-cleanup` state is accepted only as a
single-link regular file: housekeeping control metadata whose contents are not
inspected. Core adds optional generic `empty-directory` and `file` state kinds.
Memory exclusions, selected-byte binding, link checks and diagnostics verdicts
are preserved. The rationale is pinned to Claude Code 2.1.285 and executable
SHA-256 `33dad1ec615a2e08cc78b494f05c110e49916de2c79d78ec8799ebf46b233d29`.
Native acceptance of the changed packed distribution remains pending. This
candidate has not been published.

Core 1.0.0-dev.23 also keeps ordinary session-1 process cleanup within the run
budget, preserving the final cleanup allowance after a long second session.

Core 1.0.0-dev.22 adds parent observation tokens to persistence diagnostics and
collects metadata offenders across branches after the original failure. The
walk remains bounded, never follows links or reads rejected contents, and
preserves the original verdict, failure class and cancellation/budget behavior.
The disclosure dictionary names additional reviewed immediate children of
home `.claude`, `.config` and `.local` at exact case and location. Admission is
unchanged, including refusal of `sessions` and `.last-cleanup`. Published
records remain closed, frozen and below 4096 serialized bytes.

Core 1.0.0-dev.21 admits exactly the home `.cache/claude-cli-nodejs` client-state
root for the pinned Claude Code 2.1.285 candidate. A version-specific enumerated static
trace identifies error/MCP JSONL log writers and age-based cleanup there and identified no
configuration or instruction reader. Other cache children and project equivalents remain refused; existing
link, special-file, walk-limit and selected-configuration checks are unchanged.
The uninspected root permits an ordinary single-link file or directory. Log
contents, which may include MCP server stderr, are never read, ingested or
exported by verification. Successful whole-cell cleanup deletes them; failed
cleanup retains the cell. Retention does not rely on client pruning. This
development candidate has not been published to npm.
The WSL2 Linux platform record re-captures the `libssl.so.3` and
`libcrypto.so.3` pins for the host's OpenSSL 3.5.5-1ubuntu3.7 security update;
a pinned library that changes still makes the cell unavailable until re-captured.

Core 1.0.0-dev.20 adds optional native persistence diagnostics identifying the
first failed check before or after the second session. Records contain closed
failure classes, bounded structural counts and reviewed tokens, with opaque
per-run ordinals for unknown names and keys. Inspected client state reports a
closed diagnosis without exporting values or project paths. Evidence that stops
early is marked partial. Admission, public verdicts and reasons, cancellation,
budgets and limit handling are unchanged. This development candidate has not
been published to npm.

Core 1.0.0-dev.19 accepts absent account or organization attributes on successful
Claude API requests bound to a freshly provisioned native session. Present
identities must match; empty, malformed or repeated identity attributes and
contradictory identities on any bound-session event invalidate authentication.
Optional diagnostics and Linux admission evidence record the per-session proof
kind (`telemetry-identity` or `provisioning-bound-session`); diagnostics separate
accepted absence from rejection and count deduplicated qualifying successes.
Public verification result schemas are unchanged. Provisioning-bound proof loses
the runtime wrong-account/refresh cross-check and is not provider-signed evidence.
This development candidate has not been published to npm.

Core 1.0.0-dev.18 splits optional native API request identity rejection counts
into missing and different account and organization attributes. Counts across
all bound-session event types and the first matching event's position help
diagnose when identity metadata appears, without retaining identity values.
Authentication matching, verification verdicts and adapter conflict handling
remain unchanged. This development candidate has not been published to npm.

Core 1.0.0-dev.17 matches Claude API request telemetry using the documented
`event.name` attribute and accepts success events without an explicit success
flag, while preserving explicit failure rejection and session, identity, time
and duplicate checks. Optional counts-only diagnostics classify documented event
names and expose fixed API request rejection counts. This development candidate
has not been published to npm.

Core 1.0.0-dev.16 sets the generic OTLP protocol while retaining the authoritative
per-signal logs endpoint. Linux native workloads bridge direct collector
connections through authenticated, allowlisted sandbox proxy tunnels with fixed
connection, byte and idle bounds. Optional diagnostics include counts-only
forwarder observations; verification and admission verdicts remain unchanged.
This development candidate has not been published to npm.

Core 1.0.0-dev.15 extends the optional counts-only native diagnostics record with
closed provider error classes and trusted Linux sandbox proxy decision counts in
fixed host buckets. Unobservable proxy decisions remain null. Client error text
and destination hosts are never retained in the record; verification, admission
and sandbox policy remain unchanged. This development candidate has not been
published to npm.

Core 1.0.0-dev.14 makes native session diagnostics available to acceptance
tooling as counts only through an optional process-local diagnostics channel.
Collector request and event counters and fixed result classifications preserve
the existing verification and admission contracts. This development candidate
has not been published to npm.

Core 1.0.0-dev.13 fixes Linux sandbox preparation for npm-installed scoped
packages: profile paths admit a leading '@' in a path component. Linux API/CLI
runs that were refused as isolation-unobserved before the client started now
pass the platform executable pins to sandbox preparation in the required shape.
The Linux platform record refreshes the pinned glibc 2.43-2ubuntu2.4 library bytes.
This development candidate has not been published to npm.

Core 1.0.0-dev.12 integrates the versioned shared trust request with the existing
Python/pip, Git, Cargo, conda, Gradle and Maven repairs. Supplied-source retention,
reviewed replacement/removal, configuration and executable binding, and protected
output custody now cover these families. JVM repairs keep their explicit JKS
baseline separate and review the precomputed derived store before effects.
Schema-less repairs retain their behavior. Automatic OS/native repair remains
unavailable without actual client and policy admission. This development candidate
has not been published to npm.

Core 1.0.0-dev.11 adds versioned macOS session contracts, supplied-file Node/npm
terminal integration, protected session custody and observation/removal support.
Desktop requests remain unavailable until exact native application profiles are
admitted. CI and VM rehearsal are development evidence. Full desktop acceptance
and npm publication remain pending.

Core 1.0.0-dev.10 adds a Linux x64 WSL2 native-verification candidate using a
fixed Anthropic Sandbox Runtime 0.0.78 profile, a packaged Linux process/IPC
observer and independently pinned runtime bytes. Definition schema 1.1.0 adds
the vendor-runtime mechanism; legacy definitions and public verifier request and
result contracts remain supported. The client and selected MCP helpers require
kernel identity binding, synthetic isolation proof and bounded tree cleanup.
The candidate remains unadmitted; synthetic checks do not establish provider or
account acceptance. This local development artifact has not been published to npm.

Core 1.0.0-dev.9 adds bounded Windows Job lifecycle and OS-bound named-pipe
facilities with packaged helper byte binding, partial-launch cleanup and protected
dedicated OAuth staging. Runtime entry ownership is independent of a claimed PID
or token. Actual facility probes and native session evidence remain separate.
The bundled Claude Windows candidate remains unadmitted and has no whole-client
isolation mechanism; hygiene evidence remains incomplete/unverified. This local
development candidate has not been published to npm.

Core 1.0.0-dev.8 adds explicit bounded native-client verification API/CLI and
portable version 1.0.0 contracts. Admission, identity, loading, isolation,
persistence and cleanup evidence remain separate. Native acceptance requires
independently provisioned identity and observed platform capabilities. This local
development candidate has not been published to npm.

Core 1.0.0-dev.7 adds versioned Node/npm trust repair and standalone `aih export-ca`
with deterministic PEM and certificates-only DER P7B. New request/input schemas,
full prepared-work/run-result 1.2.0 schemas, Harness repair 1.1.0 definitions and
exact admission metadata are exported. Schema-less repairs and prior schemas
retain their meanings. Native OS repair and OS-sourced export block when actual
client admission, complete discovery or restriction preservation is unavailable;
consult the installed `trustCapabilities` for exact proven format/platform cells.
Supplied sources retain separate provenance until explicit removal or replacement.
Outputs use genuine recipe ownership plus a protected trust-custody sidecar,
home-confined per-path identities, exact reviewed replacement and bounded recovery.
Interrupted trust updates support fresh reviewed reconciliation through Prepare
and managed removal; admission and evidence bytes are rechecked before effects.
Ordinary policy Prepare also preflights aggregate ownership capacity.
Old Core remains usable for unrelated operations; returning to this version detects
older-binary changes to protected trust outputs. This local development candidate
has not been published to npm.

Core 1.0.0-dev.6 combines managed inventory/removal with the V9 reporting command and separate portable data/rendering APIs. Both modules advertise the portable reporting entries in `contractSupport`; Harness declares `urn:aihq:report:snapshot:1.0.0` as both accepted and produced. Reporting snapshots are experimental; unsupported analytics remain unavailable. This candidate has not been published.

Adds protected managed selection inventory and a reviewed removal convenience to the Core API and `aih managed` CLI. Inventory reports project and user claim identities, including Core-managed content roots, shared-member counts and claimless legacy custody; unreadable or changed relevant receipts cannot produce a complete or authorized result. Removal distinguishes absence, retained dependencies, legacy reconciliation and unavailable custody before invoking cleanup-only policy 1.1 Prepare. Eligible work uses the existing review, approval, Apply and recovery path; Enterprise mode requires the organization lifecycle removal grant and conservatively refuses metadata-only claims. Policy Prepare now exposes keyed `resolutionInputs` digest hints for actionable authored conflicts and identical unowned content outside its unchanged prepared-work schema. Core exports the `managed-inventory-result` and `managed-removal-preparation` 1.0.0 JSON Schemas as produced contracts. The bundled Harness source also shares the Enterprise source admission check. The separate pre-integration dev.5 inventory and reporting candidates are superseded by the combined dev.6 candidate; npm publication remains pending.

Adds owned hook groups: the `hook.group` recipe operation (JSON/JSONC; TOML unsupported) for adding, updating and removing one element of a shared array with selector-based custody, conflict reasons and exact reviewed resolutions. New schemas `urn:aihq:core:recipe:1.1.0`, `execution-policy:1.1.0`, `prepared-work:1.1.0` and `run-result:1.1.0` are exported and declared in `contractSupport`; the 1.0.0 schemas, bytes and behavior are unchanged and a 1.0 policy rejects 1.1 recipes. Ownership state is sealed as 1.1.0 only while a hook group is owned and downgrades to 1.0.0 afterward; earlier Core versions fail closed on 1.1 roots. `checkFileState` and guidance/support recognize the operation. These changes await the next uniquely versioned Core distribution.

Adds actionable guidance and explicit support Markdown reports. The portable `@aihq/core/support` entry derives ordered, platform-appropriate next actions (`getGuidance`) and a sanitized Markdown summary (`renderSupportMarkdown`) from existing public inspect/prepare/run results without host access, process execution, network, writes or state lookup. The Node host export `writeSupportReport` and `aih inspect|policy|repair --support-markdown <path>` write that summary only on explicit request, at the exact chosen `.md` path, with exclusive creation and no overwrite, directory creation, suffix selection, sharing or upload; an existing destination keeps its bytes and turns a successful exit into 1, JSON stdout is unchanged, and stderr carries a one-line receipt or failure reason. Non-JSON `inspect` and `repair` invocations append the same human next actions to stderr. Guidance now attributes a missing OS TLS probe prerequisite to curl instead of mislabeling Node/npm as absent, and distinguishes configured MCP certificate-chain failures from connectivity failures, offering the conditional published Node trust repair with its required `caFile` input plus an explicit runtime-confirmation step rather than implying the configured client or server runtime was proven. Inspection results keep their shape and check outcomes, but their manual `repairChoices` change: a missing curl for an OS TLS probe is now reported with target `curl`, a configured MCP `certificate-chain` check now adds a manual-guidance entry, identical manual choices (same target, reason and guidance, such as one missing curl shared by several probed tools or several configured MCP servers failing the same way) are listed once, and the guidance text for `executable-missing`, `version-exit`, `node-certificate-chain`, `connection-failed` and `loading-unverified` now comes from the shared guidance rules. Reports render from a strict allowlist — freeform messages, details, paths, URLs, configuration and credential material are omitted — and remind the reader to review before sharing; guidance never executes or authorizes anything. The bundled Harness guidance rules ship in Core 1.0.0-dev.4, which has not been published to npm.

Adds a bounded read-only policy file-state check: `checkFileState(request, controls?)` on `@aihq/core`, the `urn:aihq:core:file-state-result:1.0.0` schema export (declared as `produces` by Core contract support), and the `aih check-files` CLI command. Each distinct target is captured once and compared with the final in-memory fold of its contributing file operations; process operations and checks, executable prerequisites, managed sets, removals and evidence are listed as explicit omissions, and archive recipe/material sources are never fetched. The check creates no files, state, custody records or history, starts no processes and reads no ownership inventory. A match is a content comparison only: it is not custody, not proof that commands ran and not enterprise authorization (`authority` is always `not-evaluated`), and the result cannot be passed to Apply. Exit codes are 0 for a complete match, 1 for any other non-invalid/non-cancelled result, 2 for invalid input and 130 for cancellation. These changes await the next uniquely versioned Core distribution.

Fixes recipe identity ordering. The recipe identity digest sorted material ids with locale-dependent `localeCompare`, so the same recipe could receive different identities under different ICU/OS locales. Materials are now ordered by ascending UTF-16 code-unit order of `id` (Core's canonical key order), independent of locale; the identity rule, schema URN and canonical JSON are otherwise unchanged. Impact: only recipes whose material ids order differently under code-unit order than under the previous collation get a new identity, for example ids mixing case (`B`, `a`, `A1`), punctuation (`a-b`, `a.b`, `a_b`) or `aa` versus `a-b` in locales such as da. All 21 items of the Catalog content selected for validation (`q1/rel-license` `f2b51599`; material ids `adapter-note`, `behavior-core`, `license`, `pointer`, `rule-router`, `shared-block`, `skill`) order identically under both rules in en-US, da, tr and sv, so their identities are unchanged (the public consumer's Core-admitted known-answer vectors still hold). An organization policy document carrying a previously computed identity for an affected recipe is denied at admission with `AUTHORITY_DENIED` (`recipe-identity`) until the identity is regenerated by recomputing it with the documented rule (for example the public consumer example's `recipeIdentity` helper) and republishing the document (`recipeSha256` is the Catalog item's pinned recipe digest, or for an inline recipe the SHA-256 of its canonical JSON). There is no dual-acceptance window. No schema or export changes.

Inspection adds the helpers `rg`, `fd`, `jq`, `curl`, `keytool` and `bash` and the clients Antigravity and Zed, using the existing result schema. Multiple PATH candidates and a Windows WSL `bash` launcher surface as `<id>/resolution` observations (the WSL launcher's version command is skipped, never started); detected Antigravity or Zed adds an `<id>/loading` observation with manual guidance because native loading is not verified. Gemini CLI configuration detection now requires a Gemini-CLI-specific `~/.gemini` subdirectory (`tmp`, `extensions`, `commands`, `history`), so an Antigravity-only `~/.gemini` no longer reports `gemini` as `config-only`; the reported `config` trace for `gemini` now names the matching subdirectory (for example `.gemini/tmp`) instead of `.gemini`. No public schema, repair or JVM changes; these await the next uniquely versioned Core distribution.

The `aih` CLI adds `--version`/`-V`, command help with examples (`aih help [command]`, `-h`), pure `aih validate <execution-policy|organization-policy|recipe> <file>` and a `--no-log` option for `policy` and `repair` that disables routine history for Prepare and Apply. Version, help and validation perform no target inspection, network access or state writes. No public schema or API changes; these await the next uniquely versioned Core distribution.

Adds an isolated public consumer example and explicit packed-artifact acceptance
gate for policy authoring/reopening, complete Scan presentation and UI-owned
Prepare/Apply. Compatible Catalog content and new report bytes use the same
consumer code. Core continues to ship Harness as one distribution; the package
acceptance also proves a versioned Harness update, stale-review rejection and
reinstall of the original artifact.

The public consumer example adds a portable Enterprise administrator module
(`src/admin.js`) and acceptance walkthrough: review a Scan report without
authenticating it, author an organization policy with recipe identities computed
by the documented Core rule, derive an Enterprise execution policy that keeps
selected Scan evidence associations, reject out-of-policy and unsupported-evidence
examples, and prove Core admission, lost-handle fresh approval and Apply re-reads
through an acceptance-only organization-source stub. The example Node host accepts
a host-configured `organizationSource`. It is not a supported administrator UI or a
published organization source; no Core, Catalog or Scan schema, export or API changes.

Harness support metadata now uses package-support records with `id`, `role` and
`schemaExport`, replacing its string-only contract list. Public repair,
diagnostic and package-support JSON Schemas are exported with matching
TypeScript declarations. Repair definitions and diagnostic result shapes remain
unchanged; callers select the diagnostic schema externally. These changes
await the next uniquely versioned Core distribution and do not publish a package.

Consumers of Harness support metadata must inspect record IDs and roles instead
of matching strings, and can resolve the advertised schema export:

```js
// Before
support.contracts.includes('urn:aihq:harness:repair:1.0.0');
// After
support.contracts.some(contract => contract.id === 'urn:aihq:harness:repair:1.0.0' &&
  (contract.role === 'produces' || contract.role === 'both'));
// Each record's schemaExport names its public JSON Schema export.
```

Adds optional Scan evidence through `authenticateEvidence`, `associateEvidence`, policy `evidence` associations and `aih policy --evidence`. Exact artifact/report/annex bytes and original DSSE payloads authenticate against independently selected certificate publisher policies or organization Ed25519 keys. Partial and opaque reports remain evidence only; skipped or unverifiable evidence never blocks setup or changes its completion/exit status.

Bundled Harness now supplies inert production publisher policies and retained Sigstore roots, bounded purpose selectors and historical trust support. Authentication performs no network trust lookup and needs no Scan or Catalog runtime. The Node floor is now `>=24.15.0 <25`. These changes await the next Core distribution release; no npm publication is implied.

## 1.0.0-dev.3 (unreleased)

Adds Enterprise policy execution against an independently selected github.com organization document. The bundled Harness reader resolves an exact branch, tag or commit, admits only a regular file through bounded Git ref, tree and blob reads, verifies the blob identity and never follows redirects or discovers credentials. Core validates the organization document and admits each derived selection by exact recipe identity, scope, permitted inputs and replace/adopt/remove lifecycle permissions; any finding blocks the whole request. Apply reads the source again with that call's credential before effects, and a moved ref or changed bytes require a new review. `aih policy` accepts `--org-repository`, `--org-path`, `--org-ref` and `--org-token-env`. Standalone Harness repair never consults organization policy.

Adds the portable verification-key record format and purpose selection. The shipped inventory is explicitly empty; production trust data and authenticated report integration remain later work. Changed Harness bytes ship in this new Core version. This development version has not been published to npm.

Adds explicit management sets and selected removals through the policy API/CLI. Stable selection custody tracks exact file, configuration entry and text block bytes, preserving unrelated edits, shared owners and dependencies retained by other project/user roots. Identical unowned content requires reviewed adoption before cleanup. Recipe updates propose recoverable subtraction of obsolete members; interrupted work requires fresh preparation and authorization.

## 1.0.0-dev.2 (unreleased)

Adds selected user-scope Gradle and Maven CA repair through bundled Harness content. The caller supplies both a certificate-only PEM file and a baseline JKS truststore for review. Missing keytool is an explicit prerequisite; failed truststore materialization blocks dependent configuration changes and verification. Derived truststores preserve baseline roots and existing managed certificates without replacing unknown output.

Declared checks exercise the actual selected managers with their repaired configuration. Offline or unavailable checks remain incomplete. Core captures launcher bytes for stale-review checks while retaining its direct-process execution restrictions. This development version has not been published to npm.

## 1.0.0-dev.1 (unreleased)

Adds selected user-scope CA repairs for existing Python, pip, Git, Cargo and conda through bundled Harness content and the public repair API/CLI. Retains vendor configuration transforms, complete supplied-CA validation, managed trust preservation and explicit review of configuration replacements. Missing tools and unavailable verification remain incomplete; independent work requires current-run partial authorization.

The Core artifact binds the new shipped Harness definitions/helpers and reviewed configuration inputs. This development version has not been published to npm.

## 1.0.0-dev.0 (unreleased)

Initial development slice of the greenfield Core contract. Adds portable strict policy/recipe validation and JSON Schema exports, a live-host Prepare/Apply API, and `aih policy` for inline project-file delivery.

Adds policy-free `inspect` through the bundled Harness module, with bounded declared diagnostics, explicit offline and configured MCP controls, and matching CLI output.

Adds declared generic recipe operations for pinned material-backed writes, narrow JSON/JSONC/TOML entries, marked text blocks, managed removal and approved commands. Supplies ordered runtime checks, explicit partial continuation, exact replacement/adoption resolutions, cancellation and private recovery snapshots. CLI and API accept referenced local or bounded HTTPS archive recipes through the same preparation path.

Bundles Harness definitions and Node helpers in this single distribution, with portable `@aihq/core/harness` metadata and explicit Node-only `@aihq/core/harness/runtime`. Source modules remain separate. Package/version declarations identify Core; prepared repair binds the installed distribution and selected helper/input bytes. Includes reviewed supplied-CA and bounded OS-trust candidate repair. A Harness edit ships in a new Core version.

There is no compatibility layer for the retired public Plan/callback API, legacy commands or former standalone Harness import paths. Consumers construct the documented data policy and explicitly authorize the current review. Enterprise authority and the remaining first-release capabilities are not available in this candidate. Nothing in this entry establishes that an npm release has been published.
