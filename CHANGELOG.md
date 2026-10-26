# Changelog

## Unreleased

Add Project basics per repository. `@aihq/core/harness/runtime` gains
`detectProjectFacts({ project }, controls?)`, a bounded read-only diagnostic that runs
nothing: it reads only a fixed candidate list (`package.json`, the common lockfiles,
`.nvmrc`, `.node-version`), capped per file, per read count and by `budgetMs`, and returns
`facts: { field, value, confidence: 'detected' | 'inferred' }[]` for the stack, package
manager, Node version and test, build and lint commands. `detected` names file evidence;
`inferred` names the npm default for a manifest with no stronger package-manager signal.
Absent evidence is omitted, never fabricated. The reviewed facts ride descriptive selection
metadata into both public surfaces: prepared work 1.6.0 `selections[].projectFacts` and
managed-inventory-result 1.1.0 `selections[].projectFacts` ("Detected: …", "Inferred: …"),
retained in custody across restarts. The schemas stay at their versions within this
unreleased batch; the metadata remains descriptive and never adds operations or authority.
A rule item with `placement: 'entry-block'` now renders the shared guidance block into each
of the binding's `entryFiles` between `<!-- BEGIN aih:shared -->` and
`<!-- END aih:shared -->`, and a binding `entryPointer` renders one
`aih:shared:pointer` block from its template with `{projectFolder}` replaced (folder
default `ai-coding`, a required recipe input). Text outside the blocks is kept byte for
byte. Custody records typed `entry-block { file, marker, sha256 }` and
`entry-pointer { file, marker, sha256 }` members (run result 1.4.0, removal preparation
1.2.0, update preparation 1.0.0 and inventory 1.1.0 member kinds), reports
`block-changed`/`block-missing` for them, and keeps the exact shared-block text so an
update can rescue a person's own lines: lines added inside the block move to the
user-owned `<projectFolder>/PROJECT.md` in the same reviewed update (shown in the
preview), the file is written but never claimed, and edits that change Core's own lines
stay ordinary conflicts. Removal takes only the blocks and restores any `preExisting`
value as before. Unpublished candidate for the sole 0.1.0 release effort.

Add organization policy 1.2.0 with content selectors, a local organization source and
supplied set membership. 1.2.0 keeps every 1.1.0 rule (exact recipe admission, input and
lifecycle permissions, client, repository and scope selectors, contradiction rejection
and runtime prohibition enforcement) and adds an optional `content: { kind?, item?,
framework?, set? }` selector. A content-only entry requires, recommends or prohibits
content and never admits a selection; a content-only `permitted` entry is invalid
(`content-permitted-without-recipe`), and a recipe entry with `content` admits only
matching content. Prepared work 1.6.0 `organizationObligations` also reviews content-only
entries (with `content`, and `recipeIdentity` optional) and reports `unavailable` sets. Set membership is Catalog-resolved data supplied to
`validateOrganizationPolicy(document, { setMembers })`, the previews, Prepare
(`organizationSetMembers`) and inventory; without it a set selector is reported
`unavailable`, never matched, and admission fails closed. A document that requires and
prohibits overlapping content on overlapping targets is invalid, including a set and one
of its members. `previewOrganizationContent` names, per Catalog item, the entries that
may govern it, and its `required` flag feeds Harness `checkCompatibility`, where a
required item bound `none` is `required-but-unsupported`. Enterprise Prepare, grouped
removal and `aih policy --org-file` accept `{ provider: 'local', path }`, read offline;
the review names the file (`{ provider: 'local', fileName }`) and Apply re-reads it.
Prepared work 1.6.0 and run result 1.4.0 accept that local source. No new precedence
rule; Vibe and Harness repair never receive organization policy, and a content-source
description never selects authority. Unpublished candidate for the sole 0.1.0 release
effort.

Add an optional, caller-selected TUF trust-update client through
`@aihq/core/harness/runtime`. Static shipped trust remains the default with no
automatic refresh. Explicit updates retain historical keys/publisher policies,
expose current revocation separately, carry Scan policies, and provide the named
Catalog `sources[].trust` handoff. Local generated-key packed consumer tests
cover metadata/target refusal and unchanged historical authentication. No live
root ceremony, signing, publication or end-to-end Catalog TUF acceptance is claimed.

Install from an exact git commit. Execution policy 1.4.0 accepts a referenced recipe
whose source is Catalog's exact git identity (`repository`
`https://github.com/<owner>/<repo>`, 40-hex `commit`, `reachable: true`) plus the pinned
archive of that commit at `https://codeload.github.com/<owner>/<repo>/tar.gz/<commit>`.
Branches, tags, short or symbolic names, unchecked or unreachable commits and any other
archive URL are refused with named reasons (`git-commit-not-exact`,
`git-commit-not-reachable`, `git-repository-unsupported`, `git-archive-not-exact`)
before anything is fetched; Core resolves no reference. The archive must match its
pinned length and SHA-256 and name the same commit in its `git archive` global header
(`git-archive-commit-mismatch`); the recipe and complete named material closure keep
their path, byte length and SHA-256 pins and existing bounds, and nothing acquired is
extracted or executed. Prepared work 1.6.0 review selections and inventory 1.1.0
selections carry `materialSource: { kind: "git", repository, commit, identity }` with
`identity` `owner/repo@<commit>`, recorded in protected custody and replaced by a later
Apply from another source. `checkFileState` reports a git source
`remote-material-not-admitted` without fetching, and `deriveRecipeIdentity` accepts git
references. Execution policy 1.4.0 publishes `git-source-accept.json` and
`git-source-refuse.json` fixtures. The changed schemas stay at their versions within this
unreleased format batch. Unpublished candidate for the sole 0.1.0 release effort.

Find, finish and remove interrupted installs. Apply records a pending receipt in
protected custody immediately before its first effect, and writes ahead the members
each file effect is about to change, bound to the identity of the file it publishes. Inventory 1.1.0 then reports an install that did
not complete, also after its process was killed, as `installState: 'interrupted'` with
only the members actually written; a crash between an effect and its custody is settled
from the target, never from what was intended. Preparing the same selection again
finishes it (`finish-interrupted-install`), keeping local edits as conflicts;
`prepareManagedRemoval` removes it, also when it wrote nothing
(`remove-interrupted-install`), with the existing removal safeguards. An interrupted
run is never confirmed on disk. A target lock left by a process that no longer runs on
this host is reclaimed; any other lock is kept. No published format changes; ownership
1.6.0 gains internal pending records. Unpublished candidate for the sole 0.1.0 release
effort.

Add managed update preparation 1.0.0. `prepareUpdate({ target, scope, updates:
{ managementId, replacement }[] })` previews updating installed selections to the exact
replacement selections the consumer supplies; Core never chooses or applies an update by
itself. Each replacement keeps its selection's `managementId` and scope, and all prepared
updates share one policy preparation applied with the ordinary `apply`, its nonce-bound
review digest and re-check, so a change between preview and Apply is `REVIEW_STALE`. Every
update has its own disposition (`prepared`, `absent`, `reconcile-required`, `unavailable`,
`invalid`) with the recorded and replacement facts, and lists each member's action (`add`,
`replace`, `unchanged`, `remove`, `restore`, `unregister`, `keep-shared`, `conflict`). A
member the person edited is a `conflict` that is never overwritten and offers no
resolution. An updated claim keeps the dependency edges recorded at install, and a
replacement for a described item must name the same item and tool. The schema and its fixture are published. Unpublished candidate for the sole
0.1.0 release effort.

Add removal preparation 1.2.0. `prepareManagedRemoval` also accepts
`{ target, scope, removals: { managementId, origin? }[] }` and returns one review for
several removals under one review digest, listing every member with its action
(`remove`, `restore`, `unregister`, `keep-shared`, `keep-changed`, `keep-required`)
before Apply. An `origin` (a full set identity or `chosen`, as inventory 1.1.0 reports
it) removes only that inclusion while another origin keeps the selection and its
members. A member the person changed is kept as `keep-changed` and its item's licence
and notice files as `keep-required`. Each removal keeps the single-id dispositions and
safeguards; the single-id call is unchanged. `removalClaims` in
`@aihq/core/contracts` reports `removed` only from the run result 1.4.0 member checks of
the run that applied that review, which run result 1.4.0 now names in
`authorization.reviewDigest`. The
schema and its fixture are published. Unpublished candidate for the sole 0.1.0 release
effort.

Add the MCP permission step and one-server approval. A tool binding's MCP server
layout names, in `register.approvalLocation`, where the tool records a person's OK
for one server and its shape (`object-keyed`, `array` or `other`); the Claude Code
binding names its project approvals list. Compatibility and the review say the
server "still needs your OK" in the tool, and inventory 1.1.0 says
`approval: 'needed'`. `renderDelivery` takes `grantApproval: { framework, itemId }`
for the server being rendered and adds exactly one approval: one `config.entries`
entry at the server's key, or one member through the new recipe 1.4.0 operation
`config.member`, which adds or removes one array member and keeps every other one;
any other shape is refused with `approval-shape-unsupported`. Core never replaces or
adopts an existing choice: an approval already there stays unowned, a denial is a
`STATE_CONFLICT` (`approval-denied`), and removal takes only the approval Core wrote
(`granted-by-aih` in inventory), keeping a later edit by the person; a recipe holds
at most one approval, for a server it registers. An MCP input is written into the
tool's configuration only as the reference `${<input name>}`; its value travels
only in the live request. Recipe 1.4.0, its
schema and fixtures are published, and execution policy 1.4.0 admits it. Core never
writes an approve-all switch. Unpublished candidate for the sole 0.1.0 release effort.

Add the custody migration, managed inventory 1.1.0 and run result 1.4.0 member
checks. Ownership 1.6.0 records, per claim, the item's name, kind, framework, both
identities, tool and every qualified origin, typed members re-derived from the
authoritative target-keyed custody, and protected `preExisting` restoration data;
claims, dependency edges, sets, hook selectors, markers, modes, created tables and
directory records are unchanged, and older roots read through the migration with
`name: null`. A reviewed `replace` of a person's JSON or JSONC value keeps that value
in protected custody and writes it back when the last claim on the entry is removed.
`listManagedSelections` with `format: 'urn:aihq:core:managed-inventory-result:1.1.0'`
returns a redacted projection from receipts alone: names, origins, members with
their `fileState`, `updateState` from a consumer-supplied index, Enterprise-only
`policyState`, `approval` and `installState`. After Apply, run result 1.4.0 lists every
touched member with its planned `intent`, `outcome` and a direct on-disk `check`,
and `runMemberClaims` in `@aihq/core/contracts` applies the published "confirmed on
disk" and "removed" rules. No digest, earlier value, input value or private-input
hash is published. Unpublished candidate for the sole 0.1.0 release effort.

Add execution policy 1.4.0, prepared work 1.6.0 and run result 1.4.0. Policy 1.4.0
keeps every 1.3.0 field and adds descriptive selection metadata (`item`, `tool`,
`name`, `kind` and Catalog's qualified `origins`, all together or not at all) and
policy-level `excludedItems`; a selection naming an excluded framework and item id,
or two selections sharing a `managementId` in any scope, make the policy invalid.
Metadata adds no operations or authority, and older policies are unchanged. Its
review, prepared work 1.6.0, adds `selectionId` to every operation and one
`selections[]` entry per selection with the metadata, verbatim hook commands, the
binding's permission step, input names only and the delivered and always-loaded
size. The review digest stays nonce-bound. Its run result, 1.4.0, reports a
`REVIEW_STALE` binding change as reason `binding-changed` with `changed` (`policy`,
`recipe`, `target-file`, `ownership`, `input`, `host` or `trust`), or reason
`handle-unavailable` or `digest-mismatch`; every existing Apply guard is kept, and
scan evidence and index status never make a held review stale. Unpublished
candidate for the sole 0.1.0 release effort.

Add `renderDelivery` and `checkCompatibility` to `@aihq/core/harness`, portable
data functions that never import the Core engine. `renderDelivery({ tool, item,
binding, scope, projectFolder?, grantApproval?, contents? })` renders a checked
Catalog release 1.6 item as an ordinary Core recipe (`file.write`,
`config.entries`, `text.block`, `hook.group`) for one tool's binding: only content
materials are delivered, never the behaviour file; skills use `payload.dirName`;
rule and skill names follow the layout `namespace`; hook commands use the named
interpreter or program, Catalog's four placeholders and the layout
`commandTemplate`, and never rely on a shebang. The recipe identity from
`deriveRecipeIdentity` binds both item identities and the binding digest.
Rendered recipes are ordinary execution-policy content that Enterprise
organization policy governs in full. `checkCompatibility({ tool, platform, items,
binding })` answers from the binding alone, counting only observations from that
OS and architecture, with per-item support, reason, observation, `boundAs`
fallback, permission step, delivered and always-loaded sizes in bytes and
characters, and the static blockers `protocol-not-spoken`,
`required-but-unsupported`, `native-only-kind` and `same-folder`; set fit is
computed over the supplied Catalog-resolved members. Granting MCP approval and
`config.member` are not rendered yet. No format or package version changes.
Unpublished candidate for the sole 0.1.0 release effort.

Publish where Core keeps its state. `@aihq/core/contracts` exports `stateLocation`,
portable relative descriptors only: `{ root: { base: "userHome", segments: [".aih",
"core"] }, projectMarkers: { path, meaning }[] }`, with markers `ownership`,
`recovery` and `runs` relative to the root. `@aihq/core` exports Node
`resolveStateLocation()`, which returns those paths as absolute paths for the
running host and creates nothing. The location is information only, not
permission to write there; Core's state ownership and protection are unchanged.
No format or package version changes. Unpublished candidate for the sole 0.1.0
release effort.

Add `inspectToolHost({ tool, project, items }, controls?)` to
`@aihq/core/harness/runtime`: a Node host inspection for one observed tool and a
set of items that uses bounded reads and runs nothing. It reports the installed
tool version read from files (or `unknown`), each required executable as
`present`, `absent` or `unknown`, same-key copies at user level, in parent folders
and in tool plugins as `found`, `none` or `unavailable`, and the inputs still
required. It returns `hostBlockers` (`executable-missing`, `input-required`,
`dependency-missing`), `warnings` (`same-key-elsewhere` with where, `also-reads`)
and `stale` when the installed version is newer than the binding's observations.
Unknown and unavailable facts are listed in `unchecked` and never become a works
or duplicate claim. It never edits or removes what it finds. No format or package
version changes. Unpublished candidate for the sole 0.1.0 release effort.

Add the observed binding table (`urn:aihq:harness:tool-binding:1.0.0`), exported
from `@aihq/core/harness` as `toolBindings` with its schema and fixtures. Each
binding is `{ schema, tool, digest, layouts, entryFiles, entryPointer?, alsoReads }`
with one layout per content kind (`toolBindingKinds`). A layout's `support`
(`native`, `none` or `unconfirmed`) is derived only from its observations, each
recording tool version, OS, architecture, isolation and run-record digest.
`listed-only` never counts, documents need only delivery, and inside-profile
redirection never counts. `deriveCellSupport` scopes support to a platform and
marks a cell `stale` when the installed tool is newer, claiming no more than
`registered`. `selectBindingCell` refuses a cell that is not native on that
platform with the cell's reason. `validateToolBinding` refuses support its
observations do not give. The table is seeded with the 23 October 2026 Windows
x64 observations for Claude Code, Codex CLI, Kiro CLI, Copilot CLI and
Antigravity CLI, and every observation names the SHA-256 of the published run
record `@aihq/core/harness/run-records/canary-2026-10-23-windows-x64.json`.
`listTools()` now reads observed tools from this table, with the same result. These are scoped claims that do not satisfy native verification
acceptance; any binding change needs a new Core version.
Unpublished candidate for the sole 0.1.0 release effort.

Fix `checkContracts` inventing missing-fixture checks for accepts-only entries
that publish no fixtures. Every actual published fixture remains required,
including fixtures listed by accepts-only entries. Genuine missing producer
fixtures, readers and bytes remain unavailable, and required-check and exact
refusal-code rules are unchanged. No format or package version changes.

Add the Harness tool registry (`urn:aihq:harness:tool-registry:1.0.0`), exported
from `@aihq/core/harness` as `toolRegistry` with its schema. Each entry is
`{ id, label, surface, binaries, aliases }`. Command-line tools and IDEs are
separate entries, `claude-code` is an alias of `claude`, and `antigravity`
(binary `agy`) is distinct from Gemini CLI. Every existing native client ID stays
valid. Registry IDs and labels are a stable vocabulary. `listTools()` returns tools
with at least one observed binding cell, read from the seeded 23 October 2026
observations: Claude Code, Codex CLI, Kiro CLI, Copilot CLI and Antigravity CLI,
and no IDE. `includeUnobserved` also lists the rest. `selectTool` resolves an ID or
alias and refuses an unobserved tool with `tool-not-observed`. Organization target
1.1.0 accepts registry tool IDs with their surface; target 1.0.0 keeps its closed
client list. Enterprise Prepare blocks a 1.1.0 target naming an unobserved tool; 1.0.0 targets
are unchanged. TypeScript: `OrganizationTargetDeclaration` is now the union of
`OrganizationTargetDeclaration10` and `OrganizationTargetDeclaration11`, so code
reading `.client` must first narrow on `schema`.
Unpublished candidate for the sole 0.1.0 release effort.

Document what each result status lets a consumer claim. The README now has a
table for operation `application`, `verification.status`, managed-removal
`disposition` and run `completion`, and explains how to confirm an applied but
unverified removal before calling it removed. Documentation only; no behavior,
format or package version changes.

Add portable `checkContracts` and `validatePackageSupport`, package-support 1.1.0
with explicit versions and fixture export references, and packaged contract
fixtures. Package-support 1.0.0 remains readable. Required missing checks cannot
pass, and reader mismatches identify the accepting package to update. Unknown
schema fields now retain their JSON-pointer path; native unsupported-format
refusals also list supported identifiers. Harness metadata and reporting readers
retain encountered/supported format identifiers and escaped unknown-field paths
in their existing diagnostic, rejected-result or thrown-error channels. This is an unpublished candidate for
the sole 0.1.0 release effort.


Remove empty parent directories Core created for delivered files, after reviewed
file removal. Setup previously created directories without recording their origin,
so removal could delete files but had no authority to clean up their parents.
Protected ownership 1.5.0 now records only successful directory creations and their
identities. Removal reviews describe conditional cleanup in `details.declaredEffects`;
Apply uses bounded, nonrecursive removal after file effects, keeping pre-existing,
replaced, linked, nonempty and still-managed directories. Old receipts gain no
inferred directory ownership. Older Core versions refuse roots with the new evidence;
public operation/result formats and package version are unchanged. This candidate
is unpublished.

Support guidance now recognises Core's own Prepare and Apply conflict diagnostics. A `STATE_CONFLICT`
diagnostic, review conflict or omission whose reason is `existing-content`, `existing-target-observation`
or `trust-output-conflict` yields a `content-conflict` developer item (the existing content was preserved;
narrow the selection, reconcile it, or request an offered replace with its exact observed digest in a fresh
Prepare), plus a `managed-content-decision` administrator item for an Enterprise policy review.
`managed-content-changed` yields `managed-content-changed`; `existing-trust-uncomposable` and the target
editors' syntax, duplicate-key and unsupported-value or location reasons (for example `invalid-utf8`,
`duplicate-json-key`, `unsupported-toml-syntax`) yield `target-content-unsupported`; and
`trust-custody-conflict` and `trust-custody-pending` yield `custody-reconcile`. `unsupported-json-edit`
also yields `target-content-unsupported`. These reasons are
recognised only with the `STATE_CONFLICT` code; other reasons still fall back to the generic
`unrecognized-diagnostic` review item. Hook-group conflicts keep their specific hook item without a generic
duplicate; an Enterprise hook-group conflict gets that hook recovery guidance instead of the
`managed-content-decision` administrator item. No result format changed. This candidate is unpublished.

Publish which recipe operation kinds Prepare can observe. `@aihq/core/contracts` exports
`recipeOperationKinds`: for each supported recipe schema ID (1.0.0 to 1.3.0), the frozen list of operation
kinds that format admits, each with `effects` `observable` (Prepare compares the target's bytes and can
review it as `already-satisfied`) or `opaque` (`process.run`, reviewed as `opaque-process`). Kinds come
from the recipe schemas Prepare validates against, and their classification is type-checked against the
engine's process operation. The `RecipeOperationKind`, `RecipeOperationKindRecord`,
`OperationEffectsVisibility` and `RecipeSchemaId` types are exported with it. No schema changed. This
candidate is unpublished.

Name the selection behind prepared operations and file-state targets, and declare the commands each
Harness target covers. Policy Prepare now returns `operationSelections` beside the review: one
`{id, selectionId, operationId}` per review operation in review order, with `null` selection and
operation for generated lifecycle cleanup. It sits outside the review and its digest, like
`resolutionInputs`, so no prepared-work format changed and `prepareManagedRemoval` keeps its embedded
preparation shape. The README now documents the review operation ID grammar
(`<selectionId>/<operationId>`, `lifecycle/remove-<n>` for generated cleanup) as a stable contract.
`checkFileState` now produces `urn:aihq:core:file-state-result:1.1.0`, which adds a required
`targets[].selectionIds` index-aligned with `operationIds`; Core contract support lists 1.1.0 as the
produced file-state format, and the 1.0.0 schema stays exported for earlier results. Each
`@aihq/core/harness` `targets` entry adds a frozen `executables` list: its detection `binaries` first,
then commands that run under the tool's configuration (`npx` for npm). Detection is unchanged. This
candidate is unpublished.

`@aihq/core/report` claim-set validation (`validateClaimSet`, `readClaimSet` and `projectClaims`)
now refuses a claim set whose shared string fields carry a machine-local path: an absolute POSIX
path under a well-known root or with a file-name shape, a Windows drive path, a UNC or device path,
a home-relative `~/` path or a `file:/` URL. The refusal is `INPUT_INVALID` with a message such as
`claimSet.claims[0].subject.id: local-path: posix-absolute path is not portable`, which names the
field and the form but never the value. Repository-relative paths, package names and non-file URLs without a home segment,
JSON Pointers and plain-name routes such as `/claims/0/subject`, and `file:` in prose are still accepted.
Detection shares one internal implementation with the snapshot projection's home-path masking and
also refuses any string that masking would change, so every home path a snapshot masks is refused in
a claim set; the snapshot projection itself is unchanged. Claims 1.0.0 and 1.1.0 keep their wire format and JSON
Schemas; a claim set that was previously valid and carries such a path is now `INPUT_INVALID`. This
candidate is unpublished.
Remove the experimental V9 report renderer. Core now produces and validates report data only;
presentation is done by the consuming application from the snapshot. This candidate is unpublished.
Removed:

- The `@aihq/core/report/render` entry and its `renderReport` function and `RenderOptions` type, plus
  its `contractSupport` entry in `@aihq/core/contracts` and `@aihq/core/harness`.
- `aih report` HTML output and the `--demo` option. The command still acquires or imports one snapshot
  and writes only `report.json`; its summary no longer has `mode` or `output.html`, and `--demo` is now
  rejected as an unknown option (`cli-input`).
- The packaged renderer files (`dist/harness/report/render.mjs`, `render.d.mts`, `template.mjs`),
  `docs/reporting/RENDERING.md` and the packaged `examples/reporting/workflow/report.html` example.
- Source-only renderer assets: the authored HTML template and its demonstration sample, the template
  generator and visual verification scripts, the saved visual evidence, the renderer tests, the NOTICE attribution for the extracted design
  and the now-unused `happy-dom` and `playwright` development dependencies.

`@aihq/core/report`, its schemas, `report.json` and the other reporting examples are unchanged.

Narrow every code entry to explicit, intentional exports. `@aihq/core` and `@aihq/core/contracts`
no longer use `export type *` barrels, and package tests now check that each entry's declared and
runtime value names agree in both directions. No operation, schema or result changed. This candidate
is unpublished. Removed public names:

- `@aihq/core` no longer publishes type-only views of values it cannot call:
  `MACOS_REPAIR_REQUEST_SCHEMA`, `MACOS_REPAIR_INPUTS_SCHEMA`, `MACOS_PREPARED_WORK_SCHEMA`,
  `MACOS_RUN_RESULT_SCHEMA`, `MACOS_SESSION_CUSTODY_SCHEMA`, `MACOS_SESSION_VERIFICATION_REQUEST_SCHEMA`,
  `MACOS_SESSION_VERIFICATION_RESULT_SCHEMA`, `MACOS_SESSION_PROFILES_SCHEMA`, `HARNESS_REPAIR_1_2_0`,
  `validateMacosRepairRequest`, `validateMacosRepairInputs`, `validateMacosSessionCustody`,
  `validateMacosSessionProfiles`, `validatePreparedWork13`, `validateRunResult13`, `validateMacosSessionReview`,
  `validateMacosSessionRun`, `validateMacosSessionVerificationRequest`, `validateMacosSessionVerificationResult`,
  `TRUST_REPAIR_REQUEST_1_0_0`, `TRUST_REPAIR_INPUTS_1_0_0`, `CERTIFICATE_EXPORT_REQUEST_1_0_0`,
  `CERTIFICATE_EXPORT_INPUTS_1_0_0`, `PREPARED_WORK_1_2_0`, `RUN_RESULT_1_2_0`, `TRUST_CUSTODY_1_0_0`,
  `HARNESS_REPAIR_1_1_0`, `trustContractSchemas`, `validateTrustRepairRequest`, `validateTrustRepairInputs`,
  `validateCertificateExportRequest`, `validateCertificateExportInputs`, `validatePreparedWork12`,
  `validatePreparedWork14`, `validateRunResult12` and `validateTrustCustody`. The validators and
  `MACOS_*_SCHEMA` request/input/review/run/custody/verification identities remain callable from
  `@aihq/core/contracts`.
- `@aihq/core` no longer exports types that no root operation accepts or returns: `ValidationResult`,
  `ParseResult`, `OrganizationInputPermission`, `OrganizationSelection`, `OrganizationSelection11`,
  `OrganizationObligation`, `OrganizationTargetFacts`, `OrganizationTarget`, `OrganizationPolicy10`,
  `OrganizationPolicy11`, `OrganizationPolicy`, `OrganizationParseResult`, `MacosSession`, `MacosRepairInputs`,
  `MacosSessionPresence`, `MacosSessionCustodyFile`, `MacosSessionCustodyKey`, `MacosSessionCustodyEntry`,
  `MacosSessionCustody`, `TrustRepairInputs`, `CertificateExportInputs`, `TrustCustodySource`,
  `TrustCustodyEntry` and `TrustCustody`. Import them from `@aihq/core/contracts`.
- `@aihq/core/contracts` no longer publishes type-only views of `HARNESS_REPAIR_1_2_0`,
  `MACOS_SESSION_PROFILES_SCHEMA`, `TRUST_REPAIR_REQUEST_1_0_0`, `TRUST_REPAIR_INPUTS_1_0_0`,
  `CERTIFICATE_EXPORT_REQUEST_1_0_0`, `CERTIFICATE_EXPORT_INPUTS_1_0_0`, `PREPARED_WORK_1_2_0`,
  `RUN_RESULT_1_2_0`, `TRUST_CUSTODY_1_0_0`, `HARNESS_REPAIR_1_1_0` or `trustContractSchemas`, and no
  longer exports the file-state types `FileStateRequest`, `FileStateControls`, `FileStateStatus`,
  `FileStateOutcome`, `FileStateTargetPath`, `FileStateTarget`, `FileStateCheck`, `FileStateOmission` and
  `FileStateResult`; they remain exported from `@aihq/core` with `checkFileState`.
- `@aihq/core/harness` no longer exports trust definition assembly: `buildTrustDefinitions`,
  `buildCertificateExportRecipe`, `exportAdmissionTemplate`, `resolveTrustRecipeRef`, `trustAdapters`,
  `trustProfiles`, `trustTransformIds` and the `TrustProfile` type. Trust metadata, selection and
  validation exports are unchanged.
- `@aihq/core/harness/runtime` no longer exports `buildCertificateExportRecipe`, `trustHelperFiles`
  (package-relative file names), `trustLibraryPackages`, `hashTrustLibraries`, `trustCellSubjectSha256`,
  `acceptanceRecordSchema`, `macosSessionBudgets`, `macosSessionTrustKeys` or the `MacosSessionBudgets`
  type. Trust discovery, parsing, encoding, review and `verifyTrustAdmissionEvidence` are unchanged.

`@aihq/core` now also exports `ReportFileResult` and `ReportFileStatus` (the shape of
`SupportReportResult`), `@aihq/core/harness` exports `NativeValidationResult` and
`NativeValidationDiagnostic` (returned by `validateNativeVerificationDefinition` and
`validateNativeTestIdentity`), and `NativeVerificationBundle` now uses the exported `JsonObject`.

Contributor note: the internal `exportAdmissionTemplate`, `trustTransformIds` and the
`buildCertificateExportRecipe` re-export in the trust helper are removed. Because the export-cell
admission records pin those helper files' bytes, the four certificate-export cells' acceptance records
are recaptured for the new bytes in the same change (samartomar/aih-core#81). The public interface and
the certificate-export recipe are unchanged.

Stop exporting the undeclared `assessNodeTrustCandidate` from `@aihq/core/harness/runtime`.
`assessRepairCandidate` is the one public repair-candidate operation, and its behavior is unchanged;
call it with `{ id: 'node-os-trust', inputs: { originId: 'npm-registry' } }` for the same assessment.
Package tests now fail when a code entry exports a runtime name its declaration does not declare.
This candidate is unpublished.

`@aihq/core/support` (`getGuidance`, `renderSupportMarkdown`) now interprets every prepared-work and
run-result format Core produces: trust repair and certificate export (prepared-work 1.2.0 and 1.4.0,
run-result 1.2.0), macOS sessions (prepared-work and run-result 1.3.0) and targeted organization
reviews (prepared-work 1.5.0), in addition to 1.0.0 and 1.1.0. Each review and run result is admitted
by the validator that owns its exact schema ID instead of a parallel shape check, so a document that
does not satisfy its published schema, including one carrying undeclared fields, now returns
`INPUT_INVALID` where it was previously interpreted. An unknown or future ID still returns
`SCHEMA_UNSUPPORTED`. Trust and macOS session reports name the package bound in `inputs.trust`.
Certificate-export and macOS session work is classified like other Core-defined repair work, never by
policy-authored identifiers. Support reads at most 1,000,000 canonical bytes per input, so a larger
valid result returns `INPUT_INVALID`. The portable support bundle now includes the schema validator.
Core's portable contract validators now share one schema registry and compile each schema on its
first use rather than when `@aihq/core/contracts` or `@aihq/core/support` is imported; their results
are unchanged. No schema changed. This candidate is unpublished.

Remove the table header Core created when its last TOML `config.entries` key is removed. Core now
records, for a key whose table it created, that it appended the header and, at the end of a file
that lacked a final line break, the break it added before it. Removing the last managed key of that
table then removes the header too, so setup followed by removal restores the original bytes (the
line endings of the file included). This holds whether the key goes with its selection or a later
recipe version removes it, and when separately created tables are removed in any order: the record
of the added line break moves to the created table that comes to follow it. A table that existed
before setup, or that holds a key or comment someone else added, keeps its header, and tables
created before this change carry no such record and keep theirs. Removing a TOML entry no longer
deletes a comment written after its value: the comment stays as a line of its own, so a table
holding one keeps its header. Custody of a created table writes ownership root 1.4.0, which earlier
Core versions refuse as they refuse hook-group 1.1 roots; the root returns to its previous version
when the last such entry is removed. No recipe or policy schema changed. This candidate is
unpublished.

Broaden the TOML `config.entries` editor. It now accepts array values (arrays of strings, numbers and
booleans, nested arrays included) for set, replace, remove and custody member bytes, and files with
quoted table headers (`[projects."/home/u/p"]`, `[mcp_servers."name.with.dots"]`, literal `'...'`
quoting, whitespace around dots), whose quoted names can be entry targets. Paths are compared by decoded
segment, so `["a.b", "c"]` and `["a", "b", "c"]` stay distinct. Unrelated multi-line arrays and strings,
inline tables, dates and other value kinds are scanned and retained byte for byte. Existing scalar member
bytes are unchanged, so current custody digests still match. Inline tables, multi-line strings, dates and
times, hexadecimal/octal/binary integers, `inf`/`nan`, `null` and objects remain refused as
`unsupported-toml-value`; `[[x]]`, dotted keys and duplicate tables or keys keep their refusals. An
unrelated value the scanner cannot delimit, which the earlier line editor tolerated (including a TOML 1.1
multi-line inline table), is now `unsupported-toml-syntax`. No recipe or policy schema changed: the
recipe schema already admits any JSON literal. Custody of a TOML entry with a non-bare path segment
writes ownership root 1.3.0, which earlier Core versions refuse as they refuse hook-group 1.1 roots; the
root returns to its previous version when the last such entry is removed. Choosing where a new text
block goes is not part of this change. This candidate is unpublished.

Add claims 1.1.0 with the versioned `recurrence` 1.0.0 calculation method.
Recurrence counts later same-condition failures after verified recovery, matched
by subject and condition and de-duplicated by observation identity. Only measured
outcomes from one scope and check method are compared. Missing or insufficient
history is unavailable rather than zero. This is additive: claims 1.0.0
documents, schema bytes and projections are unchanged. Export the new schema at
`@aihq/core/report/schemas/claims/1.1.0.json` and include a filled `recurrence`
example covering recurring, recovered, unrelated, duplicated and missing history,
and a condition that is still failing. The public `ClaimSet`, `ClaimsProjection`,
`CalculationRequest` and `CalculationResult` types now include the 1.1.0 forms;
narrow on `schema` (or check `method.id` and cast), or use the `ClaimSet10`,
`ClaimsProjection10`, `CalculationRequest10` and `CalculationResult10` 1.0.0
subsets. This candidate is unpublished.

Add opt-in `configuration: 'persisted'` to `inspect`, so a long-running host can re-check Node TLS
after a repair with the trust Core's managed `node-npm-ca` configuration gives a new process. Only
Core-managed blocks with matching custody (judged by the block's own bytes and line endings) are applied;
the result reports each value (`id`, `repair`, `managementId`, `member`, `state`, and when applied `value`,
`certificates`, `materialSha256`) as `applied`, `removed`, `modified` or `unowned`, and any other state is a
`STATE_CONFLICT` diagnostic and an `incomplete` status. Persisted Node TLS and configured MCP probes use an
explicit trust and never this process's own start-time trust: bundled roots (plus system roots only when a new
process would enable them) and the applied Node extras, or for npm the applied `cafile` alone. If custody
cannot be read, those checks are `unavailable` with reason `persisted-configuration-unavailable`.
`effectiveOptions.configuration` is added and `PersistedConfigurationValue` is exported; the default `process`
behavior is unchanged. Harness exports `persistedConfigurationMembers()` and `diagnose` accepts an optional,
strictly validated and bounded `persistedTrust` (`persisted-trust` when invalid).

Document `nativeClientIds` from `@aihq/core/harness` as the public supported AI client
list. It is frozen and portable, and its ids are exactly the accepted
organization-target `client` values. The packed consumer proves the export, its
`NativeClientId` typing and its agreement with the organization-target schema.
This candidate is unpublished.

Add optional versioned `organizationTarget` declarations to Enterprise Prepare,
with portable validation and organization-target 1.0.0 / prepared-work 1.5.0
schema exports. Targeted reviews label client/repository facts as declared,
report required-choice fulfillment and recommendations per scope, omit
not-applicable entries, and keep unknown facts distinct from fulfillment.
Unfulfilled requirements are reported without enforcement; admission still
applies. Requests without a target retain their previous review format and
behavior. Apply rejects a changed target with `REVIEW_STALE` before writes.
The packed consumer proves these contracts through the installed package.
This candidate is unpublished.

Add organization-policy 1.1.0 obligations and explicit client/repository selectors,
with portable `previewOrganizationObligations` results separating enforced
admission, recommendations and required-choice fulfillment. Enterprise Prepare
accepts the new format, denies prohibited choices and fails closed when selector
facts are undeclared; without a target it does not evaluate fulfillment. Existing
1.0.0 entries remain permitted and earlier schema bytes are unchanged. The public
`OrganizationPolicy` type is now a union of the 1.0.0 and 1.1.0 documents;
narrow on `schema` before reading 1.1.0-only fields. The independent consumer
proof covers the public helper, schema/support exports and Prepare outcomes.
This candidate is unpublished.

Add normalized claim sets to `@aihq/core/report`: `readClaimSet`, `validateClaimSet`
and `projectClaims` validate a versioned `urn:aihq:report:claims:1.0.0` input
and project it into a deterministic claims projection with explicit duplicate
and conflict handling, check-set scores, verified-repair counts and context
changes. Unknown values stay absent and authentication is copied as supplied.
The claims JSON Schema is exported at
`@aihq/core/report/schemas/claims/1.0.0.json`. Diagnostic snapshot 1.0.0 is
unchanged. This candidate is unpublished.

Add portable `deriveRecipeIdentity` and `previewOrganizationAdmission` helpers
to `@aihq/core/contracts`. Authors can validate exact recipe declarations and
explain organization denials through the same identity and admission semantics
as Prepare. Preview remains advisory; current authority, material capture and
live Prepare/Apply handles remain host-owned. Existing schema identifiers and
recipe-identity:1.0.0 semantics are unchanged. This candidate is unpublished.

Add recipe and execution-policy 1.3.0 for generic input-bound hook groups.
One immutable recipe can register commands containing machine-local paths,
update an owned command, and remove its group while preserving user settings.
Bindings are limited to existing scalar leaves and remain subject to declared
input constraints and Enterprise organization authority. Earlier schema bytes
are unchanged. This local candidate is unpublished.

Core 1.0.0-dev.37 gives user-tools and JVM repairs bounded entry/block custody,
preserving neighboring settings through reviewed removal. New recipe/policy
1.2.0 and prepared-work 1.4.0 contracts admit INI, top-level YAML scalar and
properties entries without changing older schemas. Earlier whole-file repair
configuration custody requires reconciliation through the convenience removal
API. The local candidate has not been published to npm.

Core 1.0.0-dev.36 adds `npm run pack:distribution`, the qualified cross-platform
producer command. It normalizes the Linux facility's executable archive mode,
checks its pinned bytes, and verifies that every other entry's bytes and metadata
are preserved. It refuses to overwrite an existing artifact and reports the
final archive identity. Raw `npm pack` remains unqualified for Windows producers.
The pinned Linux facility is also declared as an npm executable.
Clean installs with lifecycle scripts disabled work under restrictive umask
`077`. npm creates an `aih-linux-facility` helper link or shim; this internal
protocol is not a user CLI. Harness still launches the same fixed installed path
and verifies the same binary bytes. Archive and clean-install regressions cover
permissions and direct helper startup without starting a client. No admission
or native client acceptance changes. This candidate has not been published to
npm.

Core 1.0.0-dev.35 derives narrow verifier-owned Claude permissions and project
server approval from independently pinned supplied bundle identities. Only the
fixed instruction-attestation tool and selected query are granted; ambiguous
names, additional tools and additional project MCP servers are refused before
client resolution. Effective guardrail bytes and digests are carried through
staging, persistence and Linux launch protection without changing installed
definition/admission metadata or selected bundle bytes. Bundled fixture bytes,
managed restrictions and closed public schemas are unchanged. Controlled tests
cover written fresh-home settings and tampering, not native acceptance. This
candidate has not been published to npm.

Core 1.0.0-dev.34 adds a test of the connection between Linux platform-record
drift and its diagnostic. `resolveLinuxNativeClient` now delegates to an
internal `resolveLinuxNativeClientWith` export of the Linux client module, which
takes the managed-policy observer and platform resolver as dependencies and is
not re-exported from the runtime entry point. A new test drives it with a stubbed
resolver and observes the real publisher: a `platform-record-drift` result
publishes exactly one `native-platform-drift` record bound to the digest of the
cell path, an ordinary `runtime-changed` result publishes nothing, and both
return the unchanged `isolation-unobserved` refusal. The re-capture script now
refuses a `--role` name that was already given; distinct roles stay repeatable.
The maintainer workflow wording about repeated options is corrected. No public
API, schema or runtime behaviour changes. This candidate has not been published
to npm.

Core 1.0.0-dev.33 makes Linux native platform-record drift diagnosable and
re-capturable without widening trust. The exact byte pins in the platform record
are unchanged. When a stably read pinned distro file (a PATH role, library
or read-only file) differs in size or SHA-256 from its row, platform
resolution now refuses with the internal reason `platform-record-drift` instead
of `runtime-changed`, and a subscriber on the `aih.native.diagnostics.v1` channel
receives a closed `native-platform-drift` record naming only the table and row
(role name or index), with no paths, hashes or sizes. The public result stays
unavailable with `isolation-unobserved`; the schemas and reason enum are
unchanged. A developer-only script, `scripts/recapture-linux-runtime-platform.mjs`,
reports drift on the reference host and, with `--write`, rewrites only the changed
rows when each file is owned by one `dpkg` package whose `md5sums` entry matches
the hashed bytes and `dpkg --verify` is clean (roles must also remain at the
recorded package version). The script refuses node, client and package-version
changes, and any refusal writes nothing. It can update a supplied controlled
fixture in the same run. Node, client and `wslinfo` byte changes stay
`runtime-changed` at runtime. The script is never run by build, install, test or
verification. The documentation describes the maintainer workflow and holding
distro updates between verification batches. This candidate has not been
published to npm.

Core 1.0.0-dev.32 lets native platform-runtime pinned re-reads accept multi-link
regular files only on POSIX when the file is root-owned (uid 0), has no group or
other write bits, and every ancestor is a real root-owned directory (no symlinks)
with no group or other write bits. Device, inode, size, mtime, ctime and link
count must remain stable across the read, and the pinned SHA-256 must still
match. Core and Harness use this runtime-only reader, supporting stock Ubuntu
rust-coreutils `env` without a host single-link copy. Client executable,
material, cell and other reads remain single-link; Windows behavior is
unchanged. The platform record also re-captures the reference host's
`libz.so.1.3.1` row after the zlib1g 1:1.3.dfsg+really1.3.1-1ubuntu3.1 update;
no other row changed. This candidate has not been published to npm.

Core 1.0.0-dev.31 resolves three low review findings in the native diagnostics.
The trusted Linux runner no longer silently swallows genuine SRT warnings and
errors: SRT's forced debug lines are still only counted, and any other console
warning or error is now counted (saturating at 1,000,000) and published as
`runnerWarnings` on the session diagnostics record, without emitting, formatting or
retaining any SRT text and without writing to stdout or stderr. The Claude stream
parser and the native session diagnostics now share one closed `errorClass`
vocabulary (`nativeErrorClasses` / `NativeErrorClass`) instead of three copies;
classification and normalization are unchanged. The `ClaudeStreamObservation`
declaration now includes the `resultSeen` field the parser already returns. The
Linux observer lock is regenerated for the runner change. This candidate has not
been published to npm.

Core 1.0.0-dev.30 makes the non-Linux Claude managed-settings file observer
fail closed on unknown top-level keys, matching the Linux/WSL2 observer. Both
observers now share one per-document classification for `managed-settings.json`
and `managed-settings.d/*.json`: a known restricting key is `restricted` even
beside an unknown sibling, the `theme` scalar is clear only with a bounded
lowercase token value, the shared `env` classification is unchanged, and any
other top-level key is unreadable. Previously the Windows/macOS observer ignored
unrecognised top-level keys and checked only a subset of the restricting keys, so
a document such as `{"permissions": {...}}` or `{"unknownPolicy": true}` could
report `file-sources-clear`; such documents are now `restricted` and
`unreadable` respectively. Top-level keys are matched exactly on every OS,
including Windows, so a case variant is unreadable; `env` key matching stays
case-insensitive. Precedence across files and `managed-mcp.json` handling are
unchanged. This candidate has not been published to npm.

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
