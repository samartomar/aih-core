# Changelog

## Unreleased

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
