# @aihq/core

Core exposes one headless execution path to CLIs and application hosts. An author supplies data, the host prepares a review, and the caller explicitly authorizes those effects before application.

**Unreleased development slice:** this candidate implements policy-free inspection, user-scope Node/npm and selected Python/pip, Git, Cargo, conda, Gradle and Maven CA repair, and Vibe execution of declared file, narrow configuration, text-block, managed removal and approved process recipes. Recipes may be inline or reference bounded, pinned local/HTTPS archive material. Supplied checks run after application and before dependents; explicit `allowPartial` permits independent work. Enterprise policies are admitted against an independently selected github.com organization document, read freshly before Prepare and again before Apply effects. The included schemas describe this development format and are not yet a published compatibility promise.

The Node host requires **Node >=24.15.0 <25**. The contracts and Harness metadata entries have no Node filesystem, process, network or installation effects. They can be bundled for a browser; host operations require a Node host with the relevant filesystem permissions.

## Public imports

| Import | Exports |
| --- | --- |
| `@aihq/core` | `inspect`, `prepare`, `apply`, `writeSupportReport`, public request/review/result types |
| `@aihq/core/contracts` | `parsePolicy`, `validatePolicy`, `parseOrganizationPolicy`, `validateOrganizationPolicy`, `validateRecipe`, `contractSupport`, document/diagnostic types |
| `@aihq/core/support` | Portable `getGuidance`, `renderSupportMarkdown` and the guidance/support types |
| `@aihq/core/harness` | Portable `contractSupport`, `targets`, `repairIndex`, `helperMetadata`, `verificationKeys`, `verificationPublishers`, and purpose selection/validation |
| `@aihq/core/harness/runtime` | Node-only bounded diagnostics, CA validation, candidate assessment, fixed repair helpers and the bounded `readGitHubPolicy` organization-document reader |
| `@aihq/core/schemas/execution-policy/1.0.0.json` | Execution-policy JSON Schema |
| `@aihq/core/schemas/recipe/1.0.0.json` | Recipe JSON Schema |
| `@aihq/core/schemas/organization-policy/1.0.0.json` | Organization-policy JSON Schema |
| `@aihq/core/schemas/prepared-work/1.0.0.json` | Serializable review JSON Schema |
| `@aihq/core/schemas/run-result/1.0.0.json` | Run-result JSON Schema |
| `@aihq/core/schemas/package-support/1.0.0.json` | Package support declaration JSON Schema |
| `@aihq/core/harness/schemas/repair/1.0.0.json` | One portable repair definition JSON Schema |
| `@aihq/core/harness/schemas/diagnostic/1.0.0.json` | Node Harness diagnostic result JSON Schema |

Read `contractSupport` for the actual package version, accepted/produced format IDs and runtime requirements. Schema versions and npm versions are independent. An unsupported ID yields `SCHEMA_UNSUPPORTED` with the encountered and supported IDs. Read the owning release's changelog before upgrading. Do not infer compatibility from a tuple of package version numbers.

Both modules use `urn:aihq:package-support:1.0.0`: each contract record names its
`id`, `role` (`accepts`, `produces` or `both`) and resolvable `schemaExport`.
Harness's former string-only contract list has been replaced by these records.
`repairIndex` remains an array of repair definitions. A caller selects the
diagnostic schema explicitly when validating a Harness `diagnose` result; the
result retains its existing shape without a `schema` property.

JSON Schema establishes structure. The portable validators also check strict JSON data, unique IDs, dependency cycles, check/material references, input definitions and bindings. These checks do not grant organization authority or permission to execute.

## Discover the CLI

`aih --version` (or `-V`) prints `@aihq/core <version>` from the installed package; with `--json` it emits `{"name","version"}`. `aih --help`, `-h` or `aih help` lists every command; `aih help <command>` or `aih <command> --help` adds concise examples. `aih validate <execution-policy|organization-policy|recipe> <file> [--json]` checks a file with the portable validators and returns `{status, kind, schema, diagnostics}` (exit 0 valid, 2 invalid) with their diagnostics unchanged. Version, help and validate read only the named file: no target inspection, network access, history or state. Unknown commands, kinds or option combinations exit 2 with the usual `INPUT_INVALID` refusal. Nothing checks for updates.

```sh
aih --version --json
aih help validate
aih validate recipe recipe.json --json
```

## Inspect existing tools

Inspection reads the locally bundled Harness definitions and reports the actual installed `@aihq/core` distribution version. It requires no policy, Catalog or Scan. It observes detected tools by default, runs only their declared bounded diagnostics, and makes no repair or history changes.

```sh
aih inspect --json
aih inspect --target node --target npm --offline --json
aih inspect --target claude --probe-configured-mcp --project /absolute/project --json
```

The API exposes the same result:

```js
import { inspect } from '@aihq/core';

const result = await inspect({ targets: ['node', 'npm'], network: 'off' });
```

`network` defaults to `declared`; `off` retains local observations and marks network checks as skipped. Configured MCP endpoint probes require a separate opt-in, and offline mode suppresses them too. Results distinguish a requested missing executable, an unselected absent tool, a failed performed check and an unavailable or skipped check. `effectiveOptions` records each default or explicit choice. A result does not authorize installation or repair.

Inspection also covers the helpers `rg`, `fd` (or Debian's `fdfind`), `jq`, `curl`, `keytool` and `bash`, and the clients Antigravity (`agy`, legacy `antigravity`) and Zed (`zed`, or `zeditor`/`zedit` where a distribution renames it). Each is a presence and version probe, not a general tool inventory; `keytool`'s own `-version` exists only in newer JDKs, so its probe passes `-version` to the Java launcher through the documented `-J` option. When several distinct PATH candidates (after resolving symlinks, and counting one install directory once) resolve for one of these tools, the `<id>/resolution` observation names the file and 1-based PATH entry used and how many others exist. On Windows a `bash` in System32 or WindowsApps is reported as an ambiguous WSL launcher rather than assumed to be Git Bash, and its version command is skipped (`bash/version` reason `wsl-launcher`) so inspection never starts WSL. For Antigravity and Zed, a detected installation or configuration adds an `<id>/loading` observation and manual guidance: presence and configuration are shown, but native loading is not verified. Gemini CLI configuration is recognised only from its own `~/.gemini/tmp`, `extensions`, `commands` or `history` directories, so an Antigravity-only `~/.gemini` (`antigravity`, `antigravity-cli`, `config`) does not report `gemini` as configured. A Gemini `settings.json` or `GEMINI.md` alone is not treated as a trace, because Antigravity shares the `~/.gemini` namespace; an installed `gemini` executable is still detected.

## Repair Node/npm trust

The bundled Harness module supplies `node-npm-ca`. Save `{"node-npm-ca":{"caFile":"/absolute/path/company-ca.pem"}}` as `repair-inputs.json`, then preview and authorize selected user-scope targets:

```sh
aih repair node-npm-ca --target node --target npm --inputs-file repair-inputs.json --json
aih repair node-npm-ca --target node --target npm --inputs-file repair-inputs.json --apply
# For explicitly authorized automation:
aih repair node-npm-ca --target node --target npm --inputs-file repair-inputs.json --apply --yes --json
```

The API uses the same path:

```js
const preparation = await prepare({ useCase: 'repair', repairs: [{
  id: 'node-npm-ca', targets: ['node', 'npm'], inputs: { caFile: absolutePemPath }
}] });
// Show preparation.review, then obtain explicit authorization.
const result = await apply(preparation.prepared, {
  approved: true, origin: 'interactive', reviewDigest: preparation.review.reviewDigest
});
```

Input must be a complete certificate-only PEM: at most 1 MiB total, 256 blocks and 64 KiB per block. Every certificate must parse as one CA certificate valid at preparation and application time. One bad block rejects the entire import without touching existing trust or configuration. Accepted certificates are copied to Core-managed user material; later source changes do not rotate that copy. Existing managed certificates are retained byte-for-byte, including expired certificates. Unowned or changed destinations need an exact reviewed resolution through `--resolutions`; a generic `--allow-partial` does not grant replacement authority. No system trust store or installer is changed.

Node's user shell profile receives `NODE_EXTRA_CA_CERTS`. On Windows, a reviewed user-environment update also persists the value for future user processes, and its check must pass before the profile reference is written. The Node check starts a new Node process, confirms the selected CA identities loaded, and attempts a TLS connection to the public npm registry unless `--offline` was selected. Existing processes may need restarting to inherit the user environment. npm receives a user `.npmrc` `cafile`; the managed bundle includes Node's default roots because npm replaces its default trust when `cafile` is set. Its online check queries npm configuration and pings the registry selected by npm's configuration. `--offline` suppresses live TLS verification for either target and reports its repair as incomplete. A successful public-registry check does not prove the supplied CA resolved a different endpoint's trust failure.

## Repair Python/pip, Git, Cargo and conda trust

The bundled `user-tools-ca` repair accepts a complete supplied CA file and any selected combination of `python`, `pip`, `git`, `cargo` and `conda`. Save `{"user-tools-ca":{"caFile":"/absolute/path/company-ca.pem"}}` as `repair-inputs.json`:

```sh
aih repair user-tools-ca --target pip --target git --inputs-file repair-inputs.json --json
aih repair user-tools-ca --target pip --target git --inputs-file repair-inputs.json --apply
# Explicit permission to perform independent work when a selected tool is unavailable:
aih repair user-tools-ca --target pip --target conda --inputs-file repair-inputs.json --apply --allow-partial
```

The API uses `prepare({ useCase: 'repair', repairs: [{ id: 'user-tools-ca', targets: ['pip', 'git'], inputs: { caFile: absolutePemPath } }] })`, followed by the same explicit `apply` authorization as Node/npm. Tool readiness checks run before configuration changes. Cargo also requires Git because its retained configuration enables `git-fetch-with-cli`. Nothing installs missing tools.

Cargo repair requires the legacy `~/.cargo/config` file to be absent because Cargo prefers it over the selected `config.toml`. Preparation reports this prerequisite and Apply rechecks it before effects. Resolve any legacy configuration explicitly before preparing again. Inherited `CARGO_HTTP_SSL_VERIFY` must be unset, empty or exactly `true`; the behavior probe preserves that environment.

Python sets `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` for future user shell sessions; Windows also persists both user environment values. The Python behavior check confirms the supplied CA identities loaded into its default TLS context and reaches PyPI. pip sets its user `cert`, Git sets user `http.sslCAInfo`, Cargo sets user `http.cainfo` and `net.git-fetch-with-cli`, and conda sets user `ssl_verify`. The selected recipe declares its exact paths, commands and checks in the review. Canonical user config locations are supported; redirected locations and inherited trust overrides or verification bypasses require correction before preparation.

Vendor transforms retain neighboring settings. Preserved configuration bodies are private inputs and appear redacted in reviews and routine history. Existing unowned or changed files require an exact reviewed replacement resolution, even when their other content will be preserved. Managed trust retains existing certificates and includes baseline roots alongside the supplied CA. Relevant config files, helper bytes and input bytes are bound to the prepared work; changes require another review. Online verification exercises the selected tool and its effective trust configuration. `--offline` reports skipped behavioral verification and incomplete repair. A failed or unavailable prerequisite prevents its dependent configuration changes. `--allow-partial` permits only reviewed independent work and does not authorize a conflict replacement.

Python must be `python` on Windows or `python3` on macOS/Linux. pip, Git and conda require direct executables; Windows batch wrappers are unavailable. conda also needs its base Python connection module. Git verification refuses an explicit `schannel` backend that does not consume this CA setting. Public endpoint checks do not prove the supplied CA was necessary for, or repaired, a different endpoint's trust failure.

## Repair Gradle and Maven trust

The bundled `jvm-ca` repair selects `gradle`, `maven`, or both at user scope. Supply a complete CA-only PEM and explicitly select a trust-only **JKS** baseline containing the default roots from the JDK used by those managers. The baseline uses the conventional public-container password `changeit` and must contain only CA certificate entries. Some JDKs ship PKCS12 `cacerts`; those files are unsupported directly. Export or convert the selected baseline with an approved local tool, preserve its default CA identities, and review that JKS file explicitly. Core binds both source files to the review; selecting a CA does not authorize discovery or installation of another JDK.

Save `{"jvm-ca":{"caFile":"/absolute/company-ca.pem","baselineStore":"/absolute/reviewed-jdk-baseline.jks"}}` as `repair-inputs.json`, then preview and authorize the selected targets:

```sh
aih repair jvm-ca --target gradle --target maven --inputs-file repair-inputs.json --json
aih repair jvm-ca --target gradle --target maven --inputs-file repair-inputs.json --apply
```

The API uses the same preparation and authorization path:

```js
const preparation = await prepare({ useCase: 'repair', repairs: [{
  id: 'jvm-ca', targets: ['gradle', 'maven'], inputs: {
    caFile: absolutePemPath,
    baselineStore: absoluteBaselineJksPath
  }
}] });
// Show preparation.review and obtain explicit authorization.
const result = await apply(preparation.prepared, {
  approved: true, origin: 'interactive', reviewDigest: preparation.review.reviewDigest
});
```

CA admission uses the same complete-input limits as Node/npm. Existing user configuration is preserved, and an unowned or changed configuration file requires an exact reviewed replacement resolution. A missing keytool is an unavailable prerequisite. A failed truststore materialization or required store check prevents dependent Gradle/Maven configuration writes. Earlier authorized effects and recovery information remain available; a process failure can leave opaque effects.

The repair writes Gradle's canonical `~/.gradle/gradle.properties` and Maven's `~/.mavenrc` on macOS/Linux or `%USERPROFILE%/mavenrc_pre.cmd` on Windows. It retains neighboring settings and previously managed CA certificates. The derived JKS retains the reviewed baseline roots and uses an exclusive destination containing both input hashes; unknown bytes at that destination are preserved and block materialization. Redirected Gradle homes, Maven rc bypasses, ambiguous configuration and inherited JVM trust overrides require correction before preparation.

Declared verification requires the existing `java`, `keytool`, `gradle` and/or `mvn` on `PATH`. Windows Gradle and Maven batch launchers are captured and checked through fixed wrappers. The checks run a temporary Gradle task or Maven project with the repaired user settings, verify the selected store and supplied CA identities in the manager's default trust context, and connect to `services.gradle.org` or `repo.maven.apache.org`. Temporary check projects are removed after the check. Review their declared process effects and network access before authorization.

The review shows selected executables, arguments, destinations and required checks. Source, configuration, helper or executable changes require a fresh review. Offline mode skips live manager verification and reports incomplete repair. No organization policy, system trust change or tool installation is involved. Public endpoint checks establish the performed connection only; they do not prove a supplied CA repaired a different endpoint.

The configuration upsert supports ordinary LF/CRLF properties and line-based Maven rc settings. Bare-CR separators, Gradle continuations or escaped property keys, and Maven continuations, multiline quotes/grouping, shell control blocks, backtick substitutions or here-documents require correction before preparation so the repair cannot change neighboring values or mistake shell text for a managed block.

## One complete authoring example

Save this as `policy.json`:

```json
{
  "schema": "urn:aihq:core:execution-policy:1.0.0",
  "mode": "vibe",
  "selections": [{
    "id": "guidance", "managementId": "team-guidance", "scope": "project",
    "configuration": {"text": "Read the project's contribution guide.\n"},
    "requires": [],
    "recipe": {"inline": {
      "schema": "urn:aihq:core:recipe:1.0.0", "id": "guidance-file",
      "description": "Deliver project guidance",
      "inputs": {"text": {"type": "string", "required": true, "maxLength": 65536}},
      "materials": [], "targets": ["project"], "prerequisites": [],
      "operations": [{
        "id": "write", "purpose": "Write shared project guidance", "kind": "file.write",
        "scope": "project", "target": {"root": "project", "segments": [{"literal": "TEAM.md"}]},
        "content": {"input": "text"}, "requires": [], "checks": []
      }],
      "checks": []
    }}
  }]
}
```

Preview and then deliberately apply through the CLI:

```sh
aih policy policy.json --project /absolute/project --json
aih policy policy.json --project /absolute/project --apply
# Explicit automation authorization for this invocation:
aih policy policy.json --project /absolute/project --apply --yes --json
# Same, with routine history off:
aih policy policy.json --project /absolute/project --apply --yes --no-log --json
```

Each invocation prepares again. `--yes` requires `--apply`. Interactive review goes to stderr; `--json` emits one structured result on stdout. Noninteractive application without `--yes` rejects. `--no-log` (accepted by `policy` and `repair` only) turns routine history off for both Prepare and Apply, so the result record is `{"status":"disabled","reason":"logging-off"}`; ownership, recovery and approval are unchanged. Exit codes are 0 for successful preview/complete application, 1 for blocked or incomplete work, 2 for invalid/rejected requests, and 130 for cancellation. No write without a supplied check is reported as verified.

An author may use `config.entries` for selected JSON/JSONC or unambiguous scalar TOML keys, `text.block` for exact marked regions, `file.remove` for a managed member, and `process.run` for an explicitly approved executable with separate arguments, a scoped working directory, declared environment inputs, accepted exit codes and effects. The prepared review shows resolved edits and checks, including executable byte hashes, argv, environment, accepted exit codes and bounds; private values are redacted. A recipe's `checks` definitions can include a bounded `file.sha256` observation or an approved `process.exit` invocation; operation `checks` names those definitions. A failed or unavailable required check blocks dependents. A command may leave opaque effects after failure or cancellation; the result reports uncertainty rather than promising rollback.

Referenced recipes bind a strict recipe JSON member and its complete named material closure by byte length and SHA-256. A caller supplies selected local source handles with `controls.materialRoots` or `--material-root id=/absolute/path`; archive sources require an explicit HTTPS URL and pinned compressed bytes. The preparation-wide captured-material declaration limit is 512 MiB across selections and is checked before acquisition. Acquisition never runs package scripts or helpers. The CLI also accepts `--resolutions file.json` for exact observed replacement/adoption choices, for example:

```json
{"resolutions":[{"selectionId":"guidance","operationId":"write","choice":"replace","observedSha256":"<64 lowercase hex characters>"}]}
```

The host rechecks those observations at Apply. `allowPartial` cannot override a conflict or a failed dependency; it permits only already reviewed independent work.

A UI-owned backend can use the same policy and engine:

```js
import { parsePolicy } from '@aihq/core/contracts';
import { prepare, apply } from '@aihq/core';

const parsed = parsePolicy(policyText);
if (!parsed.valid) throw new Error(JSON.stringify(parsed.diagnostics));
const preparation = await prepare({
  useCase: 'policy', policy: parsed.document,
  target: { project: absoluteProjectPath }
});
// Show preparation.review and obtain the user's explicit approval in your UI.
// Retain preparation.prepared on this host; do not send it as executable JSON.
if (preparation.status === 'ready' && userExplicitlyApproved) {
  const result = await apply(preparation.prepared, {
    approved: true, origin: 'interactive',
    reviewDigest: preparation.review.reviewDigest
  });
  display(result);
}
```

The handle belongs to the running module instance and is consumed on application. Restarting the host or losing the handle requires preparation and approval again. Saved policies/reviews/results remain readable JSON. A digest alone does not establish custody or consent. Editing a caller-owned policy or private input after preparation invalidates the work. Editing review JSON cannot alter the engine's frozen review or executable state.

## Inputs and outcomes

Inputs are scalar strings, booleans, finite numbers or safe integers with optional bounds/defaults/enums. There is no coercion or recursive interpolation. Unknown configuration names reject. A string slot is exactly `{ "literal": "text" }` or `{ "input": "declaredName" }`.

Sensitive inputs declare `sensitive: true`, omit the portable value/default, and arrive through `prepare` controls: `{ privateInputs: { selectionId: { inputName: value } } }`. The CLI maps an existing environment value with `--private-input selection.input=ENV_NAME`. They are redacted in reviews and omitted from routine history. Keep returned handles private to your host; authenticating your UI's requests is your application's responsibility.

Reported operation and input IDs use `selectionId/localId`; `/` cannot occur in an authored ID. For CLI private-input mappings, percent-encode a dot inside either component as `%2E`, preserving the one literal separator dot: `team%2Eguidance.text%2Econtent=ENV_NAME`.

`apply` requires `approved: true`, `origin` and the review's `reviewDigest`. `allowPartial` defaults to false and its default/explicit origin is recorded. Cancellation is supplied as `controls.signal` or SIGINT. Results distinguish `applied`, `already-satisfied`, `failed`, and `not-attempted`; verification independently records passed, failed, unavailable or unverified checks.

Target paths are explicitly scoped and reject traversal, links, unsafe host filenames and Core's reserved state paths. Existing matching unowned bytes remain unowned. This is guarded local file handling, not a sandbox against arbitrary concurrently privileged software.

## Managed lifecycle

`managementId` remains stable when run-local selection/operation IDs or recipe bytes change. Core records custody separately for files, exact JSON/JSONC/TOML entries and marked blocks. Unrelated settings, comments and text outside those members survive updates and cleanup. Changed managed bytes require an exact reviewed replacement; matching unowned bytes remain satisfied and unowned until explicit reviewed adoption. A shared member cannot change while another owner retains it.

A policy can name complete desired sets:

```json
"managedSelections": [{"id":"team-tools","scope":"project","members":["team-guidance"]}]
```

Members are stable management IDs of the policy's selections. Omitting a set requests no cleanup. Explicitly supplying `"members": []` proposes subtraction of that set's prior managed members. `"selections": []` supports cleanup-only policies and deliberate no-op application. Unmentioned sets and members needed by retained dependencies remain. Selection intent records dependencies and set membership separately from byte custody, including selections with only matching unowned content or approved processes. User custody follows the actual home, including Core-assigned `userState` children; roots in other projects can retain shared user dependencies.

For selected removal use `"removals": [{"managementId":"team-guidance","scope":"project"}]`. References select existing custody; they cannot authorize deletion of unowned content. Updating a selected recipe also reviews subtraction of its obsolete owned members. Review conflicts, removals and recovery information before Apply. Directory descendants are never recursively removed.

Byte custody is published after the corresponding successful mutation. Set/dependency metadata advances only after the selection's reviewed operations and checks succeed. Failed or interrupted work preserves completed effects and conservative custody; prepare and authorize a fresh review before further changes. Recovery manifests are inspection material and cannot replay work.

## Enterprise policies

An Enterprise execution policy (`"mode": "enterprise"`, every selection carrying `organizationSelectionId`) is admitted only against an organization policy document that **you select separately** from the policy. Preparation reads that document from GitHub through the Harness reader, validates it, and compares every derived selection (recipe identity, scope, inputs, lifecycle requests) with it. Any finding blocks the whole request: no handle is returned and no subset runs.

**Recipe identity rule.** A selection's recipe identity is `"sha256:"` plus the lowercase hex SHA-256 of the UTF-8 bytes of the canonical JSON (object keys in UTF-16 code-unit order, no whitespace) of `{ "schema": "urn:aihq:core:recipe-identity:1.0.0", "recipeSha256": <hex>, "materials": [{ "id", "sha256", "byteLength" }, ...] }`. `materials` is ordered by ascending UTF-16 code-unit order of `id` (so `A1`, `B`, `a`, `a-b`), never by locale collation, so the identity is the same under every locale. Identities computed with the previous locale-collation order differ for recipes whose material ids order differently (mixed-case ids, `-`, `.`, `_` punctuation, `aa` under some locales); the Catalog content validated with this change (`q1/rel-license` `f2b51599`, 21 items) orders identically under both rules, so its identities are unchanged. An organization document carrying an old identity for an affected recipe is denied with `AUTHORITY_DENIED` (`recipe-identity`) until you recompute the identity with this rule and republish the document. `recipeSha256` is a Catalog item's pinned recipe digest (`item.recipe.sha256` from `@aihq/catalog/reader`) or, for an inline recipe, the SHA-256 of the recipe's canonical JSON.

```js
const prepared = await prepare({
  useCase: 'policy', policy, target: { project },
  organizationSource: { provider: 'github', repository: { owner: 'example-org', name: 'org-policy' },
    path: 'policy/org.json', revision: { kind: 'branch', value: 'main' } }   // or 'tag' / full 'commit'
}, { authentication: { kind: 'bearer', token } });                          // omit for unauthenticated access
```

- `organizationSource` is required for Enterprise and rejected for Vibe. `controls.authentication` is `{ kind: 'none' }` or `{ kind: 'bearer', token }`; omission is unauthenticated, and no environment or `gh` credential is ever discovered.
- The review reports `mode: "enterprise"` and `inputs.organization` (normalized source, `resolvedCommit`, `blobId`, `contentDigest`, `policyId`, reader identity). The credential is never serialized into reviews, results, history or diagnostics.
- `apply` reads the organization again with **that call's** `controls.authentication`; a missing credential is not replaced by Prepare's success. A failed read rejects with `AUTHORITY_UNAVAILABLE`, `INPUT_INVALID` or `CANCELLED`; any change of source, resolved commit, blob or content digest (including a moved branch or tag) rejects with `REVIEW_STALE`. Nothing is cached and no history is used as fallback.
- Unreachable or unauthorized sources prepare as `blocked` with `AUTHORITY_UNAVAILABLE` and the reader's reason (`authentication-required-or-denied`, `source-missing-or-inaccessible`, `rate-limited`, `network-failed`, …); permission refusals are `AUTHORITY_DENIED`. A private repository can answer 404 for a missing credential.
- Harness repair (`useCase: 'repair'`, `aih repair`) never consults an organization source and rejects an `organizationSource` field. A recipe that merely calls itself Harness receives no exemption.

```sh
export ORG_TOKEN=...   # only the named variable is read
aih policy policy.json --project /absolute/project \
  --org-repository example-org/org-policy --org-path policy/org.json --org-ref branch:main \
  --org-token-env ORG_TOKEN --apply --yes --json
```

`--org-repository <owner/repo>`, `--org-path <path>` and `--org-ref <branch:name|tag:name|commit:sha>` are all required for an Enterprise policy and rejected for Vibe (malformed values exit 2). `--org-token-env <NAME>` names an environment variable holding the bearer token (missing or empty exits 2 without printing it); the token stays in memory and is used for both Prepare and Apply. Authority failures and denials exit 2, including previews.

## Optional Scan evidence

Core authenticates an explicitly supplied assessment's bytes and producer. It does
not read findings, decide coverage of this setup, or use evidence as permission to
execute. Policies may carry up to 32 `evidence` associations:

```json
"evidence": [{
  "schema": "urn:aihq:scan:evidence-association:1.0.0",
  "scanId": "scan:sha256:<64 lowercase hex characters>",
  "location": {"kind":"file","path":"/absolute/assessment.scan.json"}
}]
```

Use an absolute regular file or `{kind:'https',url:'https://...'}` without userinfo
or fragment. Acquisition defaults off. `aih policy policy.json --evidence` opts in
and selects the installed Harness `scan-report` trust; `--apply --yes` still
controls setup. Evidence results appear in the preparation, review and run output.
Skipped or unverifiable evidence leaves setup completion and CLI exit status alone.
The policy itself must still satisfy its closed schema: unknown association
fields, an invalid `scanId`, or more than 32 associations make the policy invalid.
For a valid declaration, an unusable locator or malformed artifact is a
nonblocking `unverifiable` result when acquisition is requested.

```js
import { authenticateEvidence, associateEvidence, prepare, apply } from '@aihq/core';
import { selectVerificationKeys, selectVerificationPublishers } from '@aihq/core/harness';

const keys = await selectVerificationKeys('scan-report');
const publishers = selectVerificationPublishers('scan-report');
if (keys.status !== 'selected' || publishers.status !== 'selected') throw new Error('Invalid trust selection');
const trust = { keys: keys.keys, publishers: publishers.publishers };
const evidence = await authenticateEvidence({ bytes, expectedScanId, trust });
const acquired = await associateEvidence({ association, acquire: true, trust });
const controls = { evidence: { acquire: true, trust } };
const preview = await prepare({ useCase: 'policy', policy, target: { project } }, controls);
// Review preview.review, then explicitly authorize Apply with the same controls.
```

`authenticateEvidence` verifies bytes without IO. `associateEvidence` performs
only the explicit acquisition; omitted association returns `skipped/not-supplied`,
and omitted/false `acquire` returns `skipped/not-requested`. Each HTTPS association has
a 60-second acquisition budget and five redirects, never forwards a bearer credential
to another origin, and accepts credentials only through its explicit
`{authentication:{kind:'bearer',token}}` controls. Policy hosts use
`controls.evidence.authentication`. File acquisition rejects links and changed
file identity. Apply uses that call's trust and acquisition controls again;
explicit distrust can change evidence status without rejecting the reviewed setup.
Associations run sequentially in each phase, so 32 slow associations can take
up to 32 minutes in Prepare and again in Apply. A host can use `controls.signal`
to bound the whole call; the signal also cancels setup work where applicable.
The Core artifact bundles the reviewed Sigstore verifier dependency tree,
including its transitive cryptography implementation. Installing the artifact
does not resolve newer Sigstore code from the registry.

Successful results have `status:'authenticated'`, the matched `scanId`, an
independently selected `producerIdentity`, and `keyId` for Ed25519 only. Core
returns `reportRead:'not-requested'`, including for partial and unknown report
generations; detailed reading belongs to Scan. Refusals have `status:'unverifiable'`
and a finite reason: `unavailable`, `unsupported-artifact`, `malformed`,
`id-mismatch`, `byte-mismatch`, `unsigned`, `unknown-producer`, `untrusted-key`,
`invalid-signature`, or `resource-limit`.

The narrow consumer accepts the artifact v1 and Sigstore v0.3 DSSE profiles:
AIHQ's maintained exact certificate issuer/SAN/OID policy with independent roots,
or separately selected organization Ed25519 keys. Neither path falls back to the
other. Original signed payload bytes, report length/digest/Scan ID and all annex
bytes/descriptors must agree. There is no report TTL, online trust refresh or
artifact-derived trust. Retained historical keys, roots and publisher policies
continue to verify historical reports, including after leaf-certificate expiry
when the bundled signing-time witnesses verify.

Harness exports inert frozen `verificationPublishers`, an empty default
`verificationKeys` organization-key inventory, `verificationKeyPurposes`,
`validateVerificationKeyRecords`, `validateVerificationPublisherRecords`,
`selectVerificationKeys`, and `selectVerificationPublishers`. Importing metadata
performs no crypto, IO or helper import. Publisher validation is structural;
authentication remains a Core host operation. Callers may supply their own
independently maintained records and explicitly remove distrusted records.
Changing shipped trust requires a new Core release; associating another report
does not require a Core or Catalog update.

Bounds include 96 MiB artifact JSON, 16 MiB report/individual annex, 64 MiB total
decoded report+annex bytes, 1 MiB attestation, 128 KiB signed statement, and 1 MiB
selected trust with at most 128 keys and 32 publishers. Inputs exceeding bounds
are refused rather than truncated. The verifier dependencies are pinned; Core
imports neither the Scan engine nor Catalog.

## Guidance and support reports

The portable `@aihq/core/support` entry derives actionable guidance from an
existing public result without any host access, process execution, network,
writes or state lookup. Wrap the result you already have as
`{kind: 'inspect'|'prepare'|'run', result, repair?}` (`repair` carries only the
published repair `id` and selected `targets`) and pass an explicit
`{platform}` (`win32`/`darwin`/`linux`/`unknown`):

```js
import { getGuidance, renderSupportMarkdown } from '@aihq/core/support';

const guidance = getGuidance({ kind: 'inspect', result: inspection }, { platform: 'win32' });
const rendered = renderSupportMarkdown({ kind: 'inspect', result: inspection }, { platform: 'win32' });
```

`getGuidance` returns ordered items naming the audience, summary, steps and any
applicable published repair with its required inputs; `renderSupportMarkdown`
returns a sanitized Markdown summary of the same content. Guidance never
executes a command, reruns an observation, or authorizes anything; a suggested
repair still needs its own explicit Prepare/Apply review.

The Node host adds `writeSupportReport(input, {platform, path, signal?})` on
`@aihq/core`, and the CLI adds `--support-markdown <path>` to `inspect`,
`policy` and `repair` (preview and `--apply` forms export the one final result
of that invocation):

```sh
aih inspect --target node --offline --json --support-markdown inspection-report.md
```

The report is written only on this explicit request, to the exact absolute path
(a relative path is resolved against the current directory by the CLI). The
path must end in `.md` (any letter case) with a plain file name, its directory must already exist, and creation is
exclusive: an existing file is left byte-for-byte untouched, links and
nonregular destinations are refused, nothing creates directories, chooses
suffixes, overwrites, shares or uploads. JSON stdout is unchanged with or
without the flag; stderr carries one receipt (`Support report written: <path>`)
or one failure line (`Support report not written: <reason>`). A successful
operation whose export fails exits 1; existing nonzero exits are preserved.
Non-JSON `inspect` and `repair` invocations also append the same human next
actions to stderr; JSON mode never prints that prose.

Report content follows a strict allowlist rather than secret-pattern search:
freeform diagnostic messages, check details, paths, URLs, configuration and
credential material are omitted, so a report is safe to review. Review the
report yourself before sharing it — nothing shares it for you.

## State and recovery

Core uses the current account's `~/.aih/core` for protected ownership records, recovery manifests, private original-file snapshots and redacted run history. Required state protection or persistence failure prevents/marks incomplete the affected mutation. A history-write failure is returned as `record.status: failed` separately from target outcomes. Set `controls.logging: 'off'` to suppress routine history; required ownership and recovery records remain.

New files use reviewed mode 0600 by default and newly needed parent directories use 0700 on POSIX; Windows files inherit the selected directory's ACL. Core's private state has restricted ownership/ACLs. A recovery manifest points to private original-file snapshots for manual inspection; it is never a resumable plan. There is no automatic history expiry or cleanup.

Strict document admission limits each document to 1,000,000 UTF-8 bytes and depth 32. Duplicate decoded keys, non-NFC/malformed strings, nonfinite/negative-zero/unsafe integer values, number tokens that lose their value, accessors, cycles and non-data objects reject. Canonical JSON uses UTF-16 key ordering, authored array order, UTF-8 and no whitespace. This restricted profile is not unrestricted RFC 8785.

## Development checks

Source lives in [`samartomar/aih-core`](https://github.com/samartomar/aih-core).
Use Node 24 within the declared engine range. Clone this repository and run the
following commands inside it. Generic engine source lives in `src/core/`; supplied
repair definitions and bounded helpers live in `src/harness/`. Harness does not
import the engine. There is one root manifest and one published distribution;
no sibling checkout is needed.

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test
```

Tests exercise public boundaries with temporary homes and target directories.
`npm test` includes the migrated Harness CA/candidate tests. The package test
installs one Core tarball into an isolated consumer, imports public schemas and
APIs, runs the installed CLI and repair, and bundles/runs both portable entries
without Node globals. It also rejects prepared repair after bundled helper bytes
change, builds and installs a new Core version with changed Harness content, and
restores the original artifact. Never target a source checkout with the product
CLI during development. Build/pack needs no donor checkout, Catalog, Scan, vendor
engine or private engineering files.

The separate [public consumer example](https://github.com/samartomar/aih-core/tree/main/examples/public-consumer)
authors and reopens Catalog-backed policies, presents complete Scan reports,
and owns its live Node Prepare/Apply sessions. Its artifact gate takes selected
tarballs explicitly; Catalog and Scan remain independent outputs and are not
Core dependencies. Run after building and packing Core:

```sh
npm run verify:public-consumer -- --core /artifacts/core.tgz --catalog /artifacts/catalog.tgz --catalog-baseline /artifacts/catalog-before.tgz --scan /artifacts/scan.tgz --output /new/consumer-evidence
```

The output directory must not exist. The gate retains both isolated installs,
artifact SHA-256 identities, logs, browser bundles and `acceptance.json`. It
compares the same example against two compatible Catalog artifacts, validates
the installed declarations and schema exports, and generates unsigned synthetic
partial reports for display checks. The retained signed production artifact is
checked separately using independently selected bundled trust. Neither a report
view nor successful authentication authorizes installation. The example is
source-only and excluded from the Core npm artifact.

The build removes obsolete generated output and copies only shipped Harness
files. Portable package identity is generated from the root manifest, shared by
both modules, and checked against the installed manifest by host operations.
Repair review/result `inputs.package` names that Core distribution;
`helperSha256` binds the manifest, generated identity and shipped Harness helper
bytes, while `sourceSha256` binds selected repair inputs. Schema IDs retain their
independent versions. Every shipped Harness change requires a new Core package
version and a deliberate Core update through ordinary package management.

CI runs these gates on Linux, Windows and macOS. The separate manually invoked
native macOS trust acceptance uses a disposable runner, installs a temporary CA
in its OS keychain and exercises packed system-CA and supplied npm repair. It
requires a macOS 26 arm64 runner and establishes native evidence only when run.
