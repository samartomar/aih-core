# Changelog

## Unreleased

Core 1.0.0-dev.6 combines managed inventory/removal with the V9 reporting command and separate portable data/rendering APIs. Reporting snapshots are experimental; unsupported analytics remain unavailable. This candidate has not been published.

Adds protected managed selection inventory and a reviewed removal convenience to the Core API and `aih managed` CLI. Inventory reports project and user claim identities, including Core-managed content roots, shared-member counts and claimless legacy custody; unreadable or changed relevant receipts cannot produce a complete or authorized result. Removal distinguishes absence, retained dependencies, legacy reconciliation and unavailable custody before invoking cleanup-only policy 1.1 Prepare. Eligible work uses the existing review, approval, Apply and recovery path; Enterprise mode requires the organization lifecycle removal grant and conservatively refuses metadata-only claims. Policy Prepare now exposes keyed `resolutionInputs` digest hints for actionable authored conflicts and identical unowned content outside its unchanged prepared-work schema. Core exports the `managed-inventory-result` and `managed-removal-preparation` 1.0.0 JSON Schemas as produced contracts. The bundled Harness source also shares the Enterprise source admission check. The local candidate advances to Core 1.0.0-dev.5; npm publication remains pending.

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
