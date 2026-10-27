# @aihq/core

Core exposes one headless execution path to CLIs and application hosts. An author supplies data, the host prepares a review, and the caller explicitly authorizes those effects before application.

**Unreleased development slice:** this candidate implements policy-free inspection, user-scope Node/npm and selected Python/pip, Git, Cargo, conda, Gradle and Maven CA repair, and Vibe execution of declared file, narrow configuration, text-block, managed removal and approved process recipes. A bounded read-only check compares a policy's declared file intent with local files without preparation, effects or history. Recipes may be inline or reference bounded, pinned local/HTTPS archive material or one exact GitHub commit. Supplied checks run after application and before dependents; explicit `allowPartial` permits independent work. Enterprise policies are admitted against an independently selected github.com or local organization document, read freshly before Prepare and again before Apply effects. The included schemas describe this development format and are not yet a published compatibility promise.

The Node host requires **Node >=26.12.1 <27**. The contracts and Harness metadata entries have no Node filesystem, process, network or installation effects. They can be bundled for a browser; host operations require a Node host with the relevant filesystem permissions.

The selected qualification runtime is Node 26.12.1. Its bundled npm 11.20.0
and separately acquired npm 12.2.1 are different executable observations.
Neither Node's version nor a package pin establishes the selected npm version.
Historical native verification records keep their exact Node/runtime subjects;
this runtime range does not requalify their platforms or client closures.

`inspectUserToolTrust` from `@aihq/core/harness/runtime` observes one explicitly
selected Python interpreter (also for `python -m pip`), Conda, Git or Cargo process
in the caller's project. It returns `no-repair`, `bundle-fallback`, `unconfirmed`
or `blocked` plus the actual process/configuration observations. Conda can also
return `native-truststore` with a scoped configuration recommendation when a
process-local truststore probe works after default certifi fails; automatic CA
repair then refuses the bundle workaround. Preparing that native configuration
change remains an explicit authored-policy operation. `network: 'off'`
never establishes working TLS. HTTPS queries preserve verification and inherited
trust; package managers may update ordinary query caches. Use disposable homes
and projects for fixtures.

The qualification candidates are Python 3.15.2, pip 26.2.2, Conda 26.9.4,
Git 2.56.0 (Windows 2.56.0.windows.4), and Rust 1.99.1. Cargo's version and
reported TLS backend are observed separately from the required selected rustc
executable. Python's explicit `pythonRecipe` exceptions are `pyyaml-onnx` and
`code-review-graph` (3.14.10), and `serena` (3.13.18). The optional
`interpreterSource` is a caller declaration: process paths are observed, but a
uv-managed versus system distribution is never certified from its path alone.
Exact interpreter/distributor/dependency artifacts still need qualification.

Online user-tool CA repair runs the effective-process gate before rendering
persistent changes. A working endpoint reports `REPAIR_NOT_NEEDED`; ambiguous
configuration, explicit trust overrides or unknown backends block fallback.
Offline repair remains an explicitly unverified supplied-bundle path, and refuses
known Conda truststore/Git Schannel modes. Cargo HTTP repair preserves its Git
transport choice; Git CLI dependency fetches require a separate Git decision.
Python recipe exceptions can be inspected explicitly; automatic repair currently
uses the general candidate and refuses incompatible interpreters. Online pip
inspection and repair verification both use the selected Python's `-m pip`.
Conda inspection currently selects base and refuses a conflicting active environment.
The Windows observer process/cleanup protocol remains unqualified and refuses
before invocation; Conda additionally needs its Windows launcher argument proof. These are
bounded preparation limits, not native support claims. No new Windows, macOS,
Linux architecture or WSL2 tuple is admitted by these protocol fixtures.

## Public imports

Each code entry lists its exports explicitly. Trust definition assembly, helper file layout and
macOS session limits are internal to the package and not part of any entry.

| Import | Exports |
| --- | --- |
| `@aihq/core` | `inspect`, `prepare`, `apply`, `verifyMacosSession`, `checkFileState`, `listManagedSelections`, `prepareManagedRemoval`, `prepareUpdate`, `writeSupportReport`, `resolveStateLocation`, and the types named by those operations' requests, controls, reviews and results |
| `@aihq/core/contracts` | `checkContracts`, `validatePackageSupport`, `recipeOperationKinds`, `parsePolicy`, `validatePolicy`, `parseOrganizationPolicy`, `validateOrganizationPolicy`, `validateOrganizationTarget`, `validateRecipe`, `validateFileStateResult`, `deriveRecipeIdentity`, `previewOrganizationAdmission`, `previewOrganizationObligations`, `previewOrganizationContent`, `contractSupport`, `stateLocation`, `runMemberClaims`, `removalClaims`, trust, macOS and native validators, and the portable document types they parse, validate or derive |
| `@aihq/core/report` | Portable reporting validation, projection, JSON import/export and types |
| `@aihq/core/report/schema` | Experimental reporting snapshot JSON Schema |
| `@aihq/core/report/schemas/claims/1.0.0.json` | Normalized claim-set JSON Schema |
| `@aihq/core/report/schemas/claims/1.1.0.json` | Normalized claim-set 1.1.0 JSON Schema (adds recurrence) |
| `@aihq/core/support` | Portable `getGuidance`, `renderSupportMarkdown` and the guidance/support types |
| `@aihq/core/harness` | Portable `contractSupport`, `toolRegistry`, `listTools`, `selectTool`, `validateToolRegistry`, `toolBindings`, `toolBindingKinds`, `deriveCellSupport`, `selectBindingCell`, `validateToolBinding`, `renderDelivery`, `checkCompatibility`, `deliveryMaterialRoot`, `nativeClientIds`, `targets`, `repairIndex`, `macosRepairIndex`, `macosSessionProfiles`, `validateRepairDefinition12`, `validateMacosSessionProfiles`, `helperMetadata`, `verificationKeys`, `verificationPublishers`, purpose selection/validation, and trust metadata (`trustRepairIndex`, `trustCapabilities`, `trustLimits`, `trustPlatformMatrix`, `consumerProfiles`, `exportDefaultNames`, `selectTrustCell`, `validateRepairDefinition11`, `validateTrustCapabilities`) |
| `@aihq/core/harness/runtime` | Node-only bounded diagnostics, CA validation, candidate assessment, fixed repair helpers, `persistedConfigurationMembers`, the bounded `readGitHubPolicy` and offline `readLocalPolicy` organization-document readers, trust source discovery, parsing, encoding, review and admission-evidence verification, read-only macOS session/app/key observations and LaunchAgent rendering, `inspectToolHost` host inspection for an observed tool, and `detectProjectFacts` for Project basics |
| `@aihq/core/schemas/execution-policy/1.0.0.json` | Execution-policy JSON Schema |
| `@aihq/core/schemas/recipe/1.0.0.json` | Recipe JSON Schema |
| `@aihq/core/schemas/organization-policy/1.0.0.json` | Organization-policy JSON Schema |
| `@aihq/core/schemas/organization-policy/1.1.0.json` | Organization-policy 1.1.0 JSON Schema (obligations and target selectors) |
| `@aihq/core/schemas/organization-policy/1.2.0.json` | Organization-policy 1.2.0 JSON Schema (adds content selectors) |
| `@aihq/core/schemas/organization-target/1.0.0.json` | Caller-declared Enterprise client/repository target JSON Schema |
| `@aihq/core/schemas/organization-target/1.1.0.json` | Caller-declared Enterprise target naming a registry tool and its surface |
| `@aihq/core/schemas/prepared-work/1.0.0.json` | Serializable review JSON Schema |
| `@aihq/core/schemas/run-result/1.0.0.json` | Run-result JSON Schema |
| `@aihq/core/schemas/file-state-result/1.0.0.json` | File-state observation result JSON Schema (earlier candidates) |
| `@aihq/core/schemas/file-state-result/1.1.0.json` | File-state observation result 1.1.0 JSON Schema (adds `targets[].selectionIds`) |
| `@aihq/core/schemas/managed-inventory-result/1.0.0.json` | Managed inventory result JSON Schema |
| `@aihq/core/schemas/managed-removal-preparation/1.0.0.json` | Managed removal preparation JSON Schema |
| `@aihq/core/schemas/managed-removal-preparation/1.2.0.json` | Removal preparation 1.2.0 JSON Schema: several removals, by origin, with named member actions (`$defs/request` describes the request) |
| `@aihq/core/schemas/managed-update-preparation/1.0.0.json` | Managed update preparation 1.0.0 JSON Schema: explicit replacements with named member actions and local edits as conflicts (`$defs/request` describes the request) |
| `@aihq/core/schemas/execution-policy/1.1.0.json` | Execution-policy 1.1.0 JSON Schema (adds owned hook groups) |
| `@aihq/core/schemas/recipe/1.1.0.json` | Recipe 1.1.0 JSON Schema (adds `hook.group`) |
| `@aihq/core/schemas/prepared-work/1.1.0.json` | Serializable review 1.1.0 JSON Schema |
| `@aihq/core/schemas/run-result/1.1.0.json` | Run-result 1.1.0 JSON Schema |
| `@aihq/core/schemas/repair-request/1.0.0.json`, `repair-inputs/1.0.0.json` | Versioned trust repair request and CLI input schemas |
| `@aihq/core/schemas/certificate-export-request/1.0.0.json`, `certificate-export-inputs/1.0.0.json` | Standalone certificate export request and CLI input schemas |
| `@aihq/core/schemas/prepared-work/1.2.0.json`, `run-result/1.2.0.json` | Complete trust review and application result schemas |
| `@aihq/core/schemas/trust-custody/1.0.0.json` | Protected trust provenance schema |
| `@aihq/core/schemas/repair-request/1.1.0.json`, `repair-inputs/1.1.0.json`, `prepared-work/1.3.0.json`, `run-result/1.3.0.json` | macOS session selection, review and result schemas |
| `@aihq/core/schemas/macos-session-custody/1.0.0.json`, `macos-session-verification-request/1.0.0.json`, `macos-session-verification-result/1.0.0.json` | Protected session custody and observation schemas |
| `@aihq/core/schemas/prepared-work/1.5.0.json` | Serializable review with declared-target organization obligations JSON Schema |
| `@aihq/core/schemas/execution-policy/1.4.0.json` | Execution-policy 1.4.0 JSON Schema (descriptive Catalog selection metadata, `excludedItems`) |
| `@aihq/core/schemas/recipe/1.4.0.json` | Recipe 1.4.0 JSON Schema (adds `config.member` and one-server `approval`) |
| `@aihq/core/schemas/prepared-work/1.6.0.json`, `run-result/1.4.0.json` | Review naming each selection, and the policy run result naming a changed review binding and checking each touched member |
| `@aihq/core/schemas/managed-inventory-result/1.1.0.json` | Managed inventory naming each installed selection, its origins, members and their states |
| `@aihq/core/schemas/package-support/1.0.0.json`, `1.1.0.json` | Package support declaration JSON Schemas |
| `@aihq/core/harness/schemas/repair/1.0.0.json` | One portable repair definition JSON Schema |
| `@aihq/core/harness/schemas/repair/1.1.0.json`, `trust-capabilities/1.0.0.json` | Fixed trust definitions and admitted platform/profile metadata |
| `@aihq/core/harness/schemas/repair/1.2.0.json`, `macos-session-profiles/1.0.0.json` | macOS metadata; no desktop profile is admitted in this candidate |
| `@aihq/core/harness/schemas/diagnostic/1.0.0.json` | Node Harness diagnostic result JSON Schema |
| `@aihq/core/harness/schemas/tool-registry/1.0.0.json` | AI tool registry JSON Schema |
| `@aihq/core/harness/schemas/tool-binding/1.0.0.json` | Observed tool binding JSON Schema |
| `@aihq/core/harness/run-records/canary-2026-10-23-windows-x64.json` | Published canary run record behind the seeded bindings |
| `@aihq/core/harness/schemas/native-verification-definition/1.0.0.json`, `1.1.0.json` | Fixed native candidate/admitted definitions; 1.1 adds the Linux vendor-runtime mechanism |

Read `contractSupport` for the actual package version, accepted/produced format IDs and runtime requirements. Schema versions and npm versions are independent. An unsupported ID yields `SCHEMA_UNSUPPORTED` with the encountered and supported IDs. Read the owning release's changelog before upgrading. Do not infer compatibility from a tuple of package version numbers.

The [macOS session development guide](docs/macos-session-development.md) describes
the supplied-file terminal path, observation/removal commands and remaining
desktop admission requirements.

Both modules publish `urn:aihq:package-support:1.1.0`: each contract record names
its `id`, `role` (`accepts`, `produces` or `both`), `versions`, resolvable
`schemaExport`, and `fixtures`. `validatePackageSupport` continues to read 1.0.0
declarations with their original shape. Both versioned schemas remain exported.
A format's version is independent of the npm package version.
`repairIndex` remains an array of repair definitions. A caller selects the
diagnostic schema explicitly when validating a Harness `diagnose` result; the
result retains its existing shape without a `schema` property.

JSON Schema establishes structure. The portable validators also check strict JSON data, unique IDs, dependency cycles, check/material references, input definitions and bindings. These checks do not grant organization authority or permission to execute.

Trust/export contracts expose `validateTrustRepairRequest`, `validateTrustRepairInputs`,
`validateCertificateExportRequest`, `validateCertificateExportInputs`,
`validatePreparedWork12`, `validateRunResult12` and `validateTrustCustody` through
`@aihq/core/contracts`. These validators inspect bounded data without observing
the host. New trust Prepare controls accept only `signal` and `logging`.


## Check package contracts before reading data

`checkContracts({ declarations, readers, loadFixture })` from
`@aihq/core/contracts` runs supplied readers against another declaration's
fixtures for the same exact contract `id`. For each `accepts` or `both` entry,
every referenced fixture from every other declaration is required, including
fixtures on an `accepts` entry. An `accepts` entry with no fixtures contributes
no checks. Missing fixtures on a `produces` or `both` entry remain unavailable.
The current declaration's own fixtures are excluded.
Package versions and `versions` describe support; they never substitute
for exercising bytes or imply compatibility.

A fixture reference is `{ export, expect: 'accept' | 'refuse', code? }`.
Core ships JSON fixture resources at the explicit `@aihq/core/fixtures/…`
exports listed by its declarations. The corpus includes representative accepted
inputs/outputs, malformed documents for every listed contract, and a future
policy major that current readers must refuse. These are contract examples,
not native acceptance or evidence that a real tool loaded delivered content.

Readers are caller-supplied `{ [contractId]: bytes => ({ accepted, code? }) }`
adapters, optionally asynchronous. They must call the public reader belonging
to the accepting package. The same adapter is used for every declaration that
accepts that id; when packages need different reader implementations, run the
check separately with each host's adapters and retain each receipt. Schema-only
adapters establish structural validity only; use the public semantic reader
where one exists.

`loadFixture(packageName, exportSpecifier)` returns a `Uint8Array` or the literal
`'unavailable'`, synchronously or asynchronously. Portable callers can supply
bytes already held in memory. A Node host can resolve the selected installed
package's exports (the function itself performs no Node work):

```js
import { readFile } from 'node:fs/promises';
import { checkContracts, contractSupport, validatePolicy } from '@aihq/core/contracts';

const result = await checkContracts({
  declarations: [contractSupport, otherPackageSupport],
  readers: {
    'urn:aihq:core:execution-policy:1.3.0': bytes => {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const checked = validatePolicy(value);
      return { accepted: checked.valid, code: checked.diagnostics[0]?.code };
    }
    // Supply every other required reader from its owning public package entry.
  },
  loadFixture: async (packageName, exportSpecifier) => {
    if (!exportSpecifier.startsWith(packageName + '/')) return 'unavailable';
    try {
      return new Uint8Array(await readFile(new URL(import.meta.resolve(exportSpecifier))));
    } catch { return 'unavailable'; }
  }
});
```

The host resolves only independently selected installed packages and bounds its
own resource acquisition. No fixture is executable code and the loader must not
import it as a program. Declarations themselves are validated before checks;
invalid ones return `ok: false` with diagnostics and no checks.

Each check names `contractId`, `readerPackage`, `fixturePackage`, and (when
available) `fixtureExport`, expected outcome/code and actual outcome/code.
`passed` requires both the outcome and any declared code to match. A mismatch,
reader exception or malformed reader response is `failed` and names the accepting
`updatePackage`; for example a reader refusing a fixture a newer producer expects
accepted identifies that reader's package. A missing adapter, empty fixture list,
missing bytes, or loader exception is `unavailable`. Older 1.0.0 declarations
without fixtures remain readable but cannot establish a required fixture check.
`ok` is true only when every required check passed; an empty check set makes no
cross-package claim. Refusals preserve encountered/supported schema identifiers,
and unknown schema fields identify their escaped JSON-pointer path. Harness
metadata validators use the same `code`, `path`, `encountered` and `supported`
fields. Reporting preserves its existing channels: `importSnapshot` throws a
`ReportInputError` with those optional fields; `readClaimSet` adds them to its
rejected result while keeping `errors`, `schema` and the unchanged `original`.
`validateSnapshot` and `validateClaimSet` retain `valid`/`errors` and expose the
same optional diagnostic detail on invalid input.

## Readable templates

[Read a Core template](docs/templates.md) explains a complete recipe and its deployment inputs. Recipe and execution-policy 1.3.0 add bounded hook input bindings; existing formats remain supported.

## Author exact organization selections

Authors can derive an identity and compare proposed selections with a supplied
organization document through `@aihq/core/contracts`. These portable helpers
perform no filesystem, network, process or installation effects. Identity hashing
is asynchronous and requires standard Web Crypto (`globalThis.crypto.subtle`).
Previews are synchronous. These helpers accept bounded plain JSON; referenced
recipe bytes are explicitly a `Uint8Array`. They never mutate their inputs.

```js
import { deriveRecipeIdentity, previewOrganizationAdmission } from '@aihq/core/contracts';

const recipe = {
  schema: 'urn:aihq:core:recipe:1.0.0', id: 'team-note', description: 'Team note',
  inputs: { text: { type: 'string', required: true, maxLength: 4096 } },
  materials: [], targets: ['project'], prerequisites: [], checks: [],
  operations: [{ id: 'write', purpose: 'Write team note', kind: 'file.write',
    scope: 'project', target: { root: 'project', segments: [{ literal: 'TEAM.md' }] },
    content: { input: 'text' }, requires: [], checks: [] }]
};
const identity = await deriveRecipeIdentity({ recipe });
if (identity.status === 'refused') throw new Error(JSON.stringify(identity.diagnostics));
const organization = {
  schema: 'urn:aihq:core:organization-policy:1.0.0', id: 'team',
  selections: [{ selectionId: 'team-note', recipeIdentity: identity.value.recipeIdentity,
    scopes: ['project'], inputs: { text: { allowDeclared: true } } }]
};
const selection = { id: 'note', organizationSelectionId: 'team-note', scope: 'project',
  recipeIdentity: identity.value.recipeIdentity, inputs: recipe.inputs,
  configuration: { text: 'Read CONTRIBUTING.md' }, privateInputs: [] };
const comparison = previewOrganizationAdmission({ organization, selections: [selection], lifecycle: [] });
// comparison.status === 'ok'; comparison.value.admitted === true
const denied = previewOrganizationAdmission({ organization: { ...organization, selections: [] },
  selections: [selection], lifecycle: [] });
// denied.status === 'ok'; denied.value.admitted === false
// denied.value.diagnostics[0]: AUTHORITY_DENIED / selection-not-admitted at /selections/0
```

`deriveRecipeIdentity` accepts exactly one variant: `{recipe}` or
`{recipeBytes,reference}` where `reference` is a `MaterialRecipeReference`.
Inline mode hashes the existing canonical recipe representation. Its materials
must have inline source declarations. Referenced mode hashes the **exact bytes**,
checks the declared SHA-256 and byte length, parses strict UTF-8 JSON, and requires
exact identity-only recipe materials matching the reference's closure. Both return
`{recipeIdentity,recipeSha256,materials}` with materials sorted by ID in UTF-16
code-unit order. This freezes `recipe-identity:1.0.0`; it describes supplied
declarations, never captured material authenticity. Prepare still acquires and
verifies real material, binds inputs, checks targets and evaluates prerequisites.

Supported recipe IDs are `urn:aihq:core:recipe:1.0.0`, `1.1.0`, `1.2.0` and
`1.3.0` (each version uses the same full prefix); organization preview accepts
`urn:aihq:core:organization-policy:1.0.0`, `1.1.0` and `1.2.0` (same full prefix).
Every 1.0.0 entry means `permitted`, with no client or repository selector.
Unsupported versions refuse without rewriting the original artifact. Package versions are separate from schema IDs.
Existing strict JSON, one-million-byte document, 4,096-selection/lifecycle and
material declaration bounds remain; no helper truncates an oversized input.

`recipeOperationKinds` from `@aihq/core/contracts` lists, for each supported recipe schema ID, the operation kinds
that format admits (in its schema's order) and whether a fresh Prepare can establish their effects. An
`observable` kind (`file.write`, `config.entries`, `text.block`, `file.remove` and, from recipe 1.1.0,
`hook.group`) names a target whose bytes Prepare reads and compares, so it can be reviewed as
`already-satisfied`; an `opaque` kind (`process.run`) is reviewed as `opaque-process`, and Prepare cannot
show its effects. The list is derived from the recipe schemas Prepare validates against. It is portable,
frozen data; treat a recipe ID or kind it does not list as unsupported or `opaque`.

```js
import { recipeOperationKinds } from '@aihq/core/contracts';

const kinds = recipeOperationKinds['urn:aihq:core:recipe:1.3.0'];
// [{ kind: 'file.write', effects: 'observable' }, ..., { kind: 'process.run', effects: 'opaque' }, { kind: 'hook.group', effects: 'observable' }]
const opaque = kind => kinds.find(item => item.kind === kind)?.effects !== 'observable';
```

Preview selection fields are exactly those in the example. `inputs` is the
recipe's `InputSpec` map; `privateInputs` contains **names only**, with actual
secret values supplied separately to the host. Lifecycle records are
`{action:'replace'|'adopt'|'remove',scope,recipeIdentity,organizationSelectionId?}`.
The caller describes proposed lifecycle actions; preview does not observe installed
state or infer actions. Malformed records refuse before comparison. Well-formed
requests return an advisory `{admitted,diagnostics}`, including denied comparisons.

Organization-policy 1.1.0 requires an `obligation` on every entry: `permitted`,
`recommended`, `required` or `prohibited`. The first three admit matching choices;
`prohibited` denies them, including choices naming another entry for the same
recipe when the prohibition applies. Optional nonempty `clients` and
`repositories` arrays restrict applicability. Clients must be native client IDs.
Repository identities are caller-declared lowercase `<host>/<owner>/<name>` strings,
for example `github.com/example-org/app`. The host is a DNS name with at least one
dot; each label has 1–63 letters, digits or hyphens and starts and ends with a
letter or digit. Owner and name each have 1–100 letters, digits, `.`, `_` or `-`
and cannot be `.` or `..`. Matching is exact; Core never infers an identity from
a checkout or remote. Omitted selectors impose no restriction. A declared mismatch
is `not-applicable`; an undeclared fact needed by a selector is `unknown`.

`previewOrganizationObligations` accepts `{organization,selections,lifecycle,target}`.
`target` requires `scope` (`project` or `user`) and optionally declares `client`
and `repository`. Its value separates three meanings:

- **Enforced:** `enforced:{admitted,diagnostics}` compares proposed choices with
  organization authority. Denials block admission; missing required choices do not.
- **Advisory:** `advisory` reports each recommended entry as `taken` or `not-taken`,
  with its applicability and matching developer selection IDs.
- **Fulfillment:** `fulfillment` reports each required entry as `fulfilled`,
  `not-fulfilled`, `not-applicable` or `unknown`. `unknown` never means fulfilled.

Advisory and fulfillment records carry `selectionId`, `recipeIdentity`,
`applicability` (`applies`, `not-applicable` or `unknown`), `unknown` (missing
`client`/`repository` facts), `status` and `selections` (developer IDs). They stay
in organization document order. A choice counts as taken only when its entry,
recipe and target scope match and admission has no finding for that choice.
Both lists are empty for a 1.0.0 organization. This evaluation describes supplied
choices; it observes no installed state and grants no effects.

```js
import { previewOrganizationObligations } from '@aihq/core/contracts';

// Reuse the recipe identity and selection derived above.
const organization11 = {
  schema: 'urn:aihq:core:organization-policy:1.1.0', id: 'team',
  selections: [{ selectionId: 'team-note', recipeIdentity: identity.value.recipeIdentity,
    obligation: 'required', scopes: ['project'], clients: ['codex'],
    repositories: ['github.com/example-org/app'],
    inputs: { text: { allowDeclared: true } } }]
};
const obligations = previewOrganizationObligations({ organization: organization11,
  selections: [selection], lifecycle: [],
  target: { scope: 'project', client: 'codex', repository: 'github.com/example-org/app' } });
// obligations.status === 'ok'; obligations.value.enforced.admitted === true
// obligations.value.fulfillment[0].status === 'fulfilled'
// With selections: [], admission still succeeds; fulfillment is 'not-fulfilled'.
// Without target.repository, fulfillment is 'unknown', never 'fulfilled'.
```

### Organization policy 1.2.0: content selectors

Organization-policy 1.2.0 keeps every 1.1.0 rule: exact recipe admission, input
and lifecycle permissions, the `scopes`, `clients` and `repositories` selectors,
contradiction rejection across overlapping targets, and runtime enforcement of
prohibitions. It adds an optional content selector on an entry:

```ts
content: { kind?, item?: { framework, itemId }, framework?, set?: { framework, setId, setSha256 } }
```

`kind` is one of `skill`, `agent`, `command`, `rule`, `hook`, `mcp-server` or
`document`. Every named field must match. An entry names a recipe
(`recipeIdentity` with `inputs`), content, or both:

- **Recipe entries** admit selections exactly as in 1.1.0. With `content`, they
  admit only a selection whose declared content matches (`AUTHORITY_DENIED /
  content` otherwise).
- **Content-only entries** carry `required`, `recommended` or `prohibited` but no
  recipe, inputs or lifecycle. They never admit a selection (naming one is
  `recipe-identity`). Permitting content is a recipe entry narrowed by
  `content`; a content-only `permitted` entry is invalid
  (`content-permitted-without-recipe`).
  `prohibited` denies any selection whose declared content matches; `required`
  and `recommended` are taken by admitted selections whose content matches.

A selection's content facts are its declared execution-policy 1.4.0 metadata
(`kind` and `item`), or `kind` and `item` on a preview selection. They are
declared, never inferred. As with an undeclared target fact, a selector needing
an undeclared content fact does not match: a prohibition that might apply fails
closed with `target-unknown`. No new precedence rule is added; prohibitions are
enforced as in 1.1.0.

**Set membership is supplied data.** Core never expands a set. Pass the
Catalog-resolved members as `setMembers: { set, members: { framework, itemId,
kind? }[] }[]` to `validateOrganizationPolicy(document, { setMembers })`,
`parseOrganizationPolicy(text, { setMembers })`, the previews, Prepare
(`organizationSetMembers`) and inventory (`organization.setMembers`). Without a
set's members, its selector is `unavailable` and never matched:

- validation stays valid and lists it in `unavailable: [{ reason:
  'set-membership-unavailable', path, set }]`;
- admission fails closed with `AUTHORITY_DENIED / set-membership-unavailable`
  when the selector could deny or narrow the choice;
- obligation results report `status: 'unavailable'`, never fulfilled or taken.

Malformed or repeated membership is `INPUT_INVALID / set-members`.

**Contradictions.** A document that both requires and prohibits overlapping
content on overlapping targets is invalid (`obligation-contradiction`), including
a set and one of its members. Overlap is reported only when the document and the
supplied membership prove it. A kind against a specific item counts only when a
supplied member gives that item's kind. A recipe-only entry is not compared with
a content-only entry, because a recipe identity names no content; runtime
prohibition enforcement still applies to the selections they meet.

`previewOrganizationContent({ organization, target, items, setMembers? })`
answers, per Catalog item `{ framework, itemId, kind }`, which content-only
entries may govern it for a declared target. Each item reports `required`,
`prohibited` and its `entries` (`selectionId`, `obligation`, `applicability`,
`match`, `unknown`). `required` and `prohibited` are true only when an entry
applies and matches. Pass `required` to Harness `checkCompatibility`: a required
item whose binding cell is `none` on that platform is the named
`required-but-unsupported` blocker.

```js
import { previewOrganizationContent } from '@aihq/core/contracts';
import { checkCompatibility } from '@aihq/core/harness';

// `github` is a checked Catalog item, `binding` its tool binding and `platform` the host OS and architecture.
const organization = { schema: 'urn:aihq:core:organization-policy:1.2.0', id: 'team', selections: [
  { selectionId: 'need-github', scopes: ['project'], obligation: 'required', content: { item: { framework: 'acme', itemId: 'github' } } },
  { selectionId: 'no-hooks', scopes: ['project'], obligation: 'prohibited', content: { kind: 'hook' } }] };
const { value } = previewOrganizationContent({ organization, target: { scope: 'project', client: 'claude' },
  items: [{ framework: 'acme', itemId: 'github', kind: 'mcp-server' }] });
const compatibility = checkCompatibility({ tool: 'claude', platform, binding, items: [{ item: github, required: value.items[0].required }] });
// A 'none' cell for MCP servers reports staticBlockers: [{ code: 'required-but-unsupported', ... }]
```

**Content-source lists.** An organization's list of content sources is not part
of its policy document; 1.2.0 has no field for one, so a document carrying a list
is invalid. A host or consumer supplies the list through its own configuration,
using Catalog's `urn:aihq:catalog:source-description:1.0.0` (read with
`@aihq/catalog/source`). A source description is discovery data only. It never
selects organization authority: Core accepts only a GitHub or local organization
source (see [Enterprise policies](#enterprise-policies)) and refuses a source
description in its place as `source-invalid`.

All helpers return `{status:'ok',value,diagnostics:[]}` or
`{status:'refused',diagnostics}`. `AuthoringDiagnostic` has `code`, JSON-pointer
`path`, explanatory `message`, optional `reason`, `related` and `details`.
Core validation failures retain the original public `Diagnostic[]` in
`details:{owner:'core',diagnostics}`; unsupported schema details retain encountered
and supported IDs. Messages may change; codes, reason identifiers and path meanings
are the machine interface. Refusals contain no executable partial policy.

| Code / stable reason | Meaning |
| --- | --- |
| `INPUT_INVALID` / `recipe-invalid` | Invalid request, recipe, reference or declaration bounds; inspect Core details when present |
| `INPUT_INVALID` / `recipe-bytes-mismatch` | Exact supplied bytes differ in hash or length, at `/recipeBytes` |
| `INPUT_INVALID` / `material-closure` | Recipe/reference material identities disagree, or inline sources are incomplete |
| `INPUT_INVALID` / `unsupported-schema` | Recipe schema ID is unsupported; retain the original artifact |
| `AUTHORITY_DENIED` / `selection-not-admitted`, `recipe-identity`, `scope` | No organization entry, wrong recipe identity or forbidden scope |
| `AUTHORITY_DENIED` / `input-not-permitted`, `input-value`, `organization-permission-incomplete` | Unpermitted input/value or missing required permission/default |
| `AUTHORITY_DENIED` / `prohibited` | Referenced entry prohibits the choice, or another applicable entry prohibits the same recipe |
| `AUTHORITY_DENIED` / `client` | Declared client is outside the entry's selector |
| `AUTHORITY_DENIED` / `repository` | Declared repository is outside the entry's selector |
| `AUTHORITY_DENIED` / `target-unknown` | Admission needs an undeclared client, repository or content fact; fails closed |
| `AUTHORITY_DENIED` / `content` | Declared content is outside the referenced entry's content selector |
| `AUTHORITY_DENIED` / `set-membership-unavailable` | A set selector that could deny or narrow the choice has no supplied members; fails closed |
| `INPUT_INVALID` / `obligation-contradiction` | Required and prohibited entries for the same recipe, or for overlapping content, have overlapping scopes and selectors |
| `INPUT_INVALID` / `set-members` | Supplied set membership is malformed or names a set twice |
| `INPUT_INVALID` / `content-permitted-without-recipe` | A content-only entry says `permitted`; only a recipe entry can permit |
| `INPUT_INVALID` / `unknown-client` | Organization selector names an unknown native client |
| `INPUT_INVALID` / `repository-identity` | Organization selector contains a malformed repository identity |
| `INPUT_INVALID` / `organization-input-spec` | Organization validation failed, or a permission value contradicts the recipe input spec |
| `INPUT_INVALID` / `input-value` | Malformed preview request, input definition or configured value; comparison refused |
| `AUTHORITY_DENIED` / `lifecycle-replace`, `lifecycle-adopt`, `lifecycle-remove` | Supplied action lacks the corresponding organization permission |

An incompatible organization permission is a valid **denied comparison** with
`INPUT_INVALID / organization-input-spec` in `value.diagnostics`; an invalid
organization document instead refuses with owning validator details. Semantic
reasons such as `obligation-contradiction`, `unknown-client` and
`repository-identity` are retained in those Core details. Invalid obligation-preview
target declarations refuse with `INPUT_INVALID / input-value` at `/target/client`
or `/target/repository`.
An admitted preview may differ from later authority. The Node host must independently
select current authority at Prepare and reread it at Apply. Neither preview,
serialized review nor consumer metadata grants effects or acts as a live handle.

After committing and building, `npm run verify:authoring-consumer -- --output
<new directory>` creates a qualified archive and installs its exact bytes outside
the source tree. It proves inline/referenced authoring, different material/configuration
data, admitted/denied Prepare agreement, changed-authority Apply refusal and rejection
of a serialized review as a handle. It also checks 1.1.0 obligation results,
selector uncertainty, schema/support exports and admitted/prohibited Prepare
outcomes with no writes on denial. Targeted Enterprise Prepare also proves the
1.5.0 review, declared target labelling, fulfilled and unknown required entries,
exclusion of other-client entries, unchanged no-target review format and
`REVIEW_STALE` without writes after target mutation. The GitHub REST transport
is a deterministic fixture; this is package-boundary evidence, not real
organization/native acceptance.
The receipt records source commit, archive digest and installed package identity.

## Discover the CLI

`aih --version` (or `-V`) prints `@aihq/core <version>` from the installed package; with `--json` it emits `{"name","version"}`. `aih --help`, `-h` or `aih help` lists every command; `aih help <command>` or `aih <command> --help` adds concise examples. `aih validate <execution-policy|organization-policy|recipe> <file> [--json]` checks a file with the portable validators and returns `{status, kind, schema, diagnostics}` (exit 0 valid, 2 invalid) with their diagnostics unchanged. Version, help and validate read only the named file: no target inspection, network access, history or state. Unknown commands, kinds or option combinations exit 2 with the usual `INPUT_INVALID` refusal. Nothing checks for updates.

```sh
aih --version --json
aih help validate
aih validate recipe recipe.json --json
```

## Ask AIH Guide: setup and recovery

The canonical [Ask AIH Guide (`aih-guide`)](https://github.com/samartomar/aih-extensions/blob/0a0ff98a0ab9846d6183b193cf6e4447b325ff9c/guide/MANUAL.md)
is a self-contained manual for missing/broken AI CLIs, ignored instructions,
settings and MCP/graph loading failures. [Save the raw Markdown](https://raw.githubusercontent.com/samartomar/aih-extensions/0a0ff98a0ab9846d6183b193cf6e4447b325ff9c/guide/MANUAL.md)
before trouble; read it by hand or paste the entire saved manual into any working
agent when Core, native guide loading, MCP or network access is unavailable.
Opening a link alone does not create an offline copy.

Extensions owns the guide source and native entries. This pointer selects source
artifact **0.5.0**, integrated at `0a0ff98`; its [manifest](https://github.com/samartomar/aih-extensions/blob/0a0ff98a0ab9846d6183b193cf6e4447b325ff9c/guide/manifest.json)
records source-input commit `5a233343ec63a436dd9a94fcf45613b3fe280c7d`, source-set
SHA-256 and exact file hashes. Those hashes identify bytes, not publisher
authenticity. Source integration is not registry/marketplace publication;
optional Catalog-managed distribution is a separate channel, not a completed
rollout or a prerequisite for reading the manual.

After direct Extensions installation, the manual describes native selection
where the installed client supports it: `kimi --agent aih-guide` in a new session,
`claude --agent aih-guide` (or the supported plugin route), and
`opencode --agent aih-guide`. Codex and Cursor use the saved-manual fallback.
Check installed client help and actual loading; selection syntax alone proves
neither a working conversation nor recovery. The dated [delivery evidence](https://github.com/samartomar/aih-extensions/blob/0a0ff98a0ab9846d6183b193cf6e4447b325ff9c/docs/guide-evidence.md)
covers bounded Windows Kimi 2.1.1 conversations and a saved-manual controlled
fixture. Claude conversation remains unverified; OpenCode has primary-agent
parsing evidence only, with full installed-plugin startup timing out. No native
guide sessions on macOS/Linux/WSL or real-user MCP recovery are established.

Before choosing a Core/Harness operation, identify the trusted installed package
and consult its version, help and public contracts; source availability does not
establish installed capability. Preserve the existing Prepare/review/Apply flow
and the actual user's authority. When no applicable installed operation exists,
the guide describes the smallest authorized manual edit to developer-owned
configuration, preserving unrelated content and a recoverable copy. Managed
policy, enterprise credential provisioning and system trust controls belong to
IT/admin; the guide grants no authority to bypass them.

Retry the original failure and relevant client-native checks. Use an existing
installed verifier only when its target, identity, prerequisites, launch authority,
time budget and cleanup contract match. A successful write, Apply result or
fixture does not establish native loading or admission; unavailable checks remain
unverified. For session-sensitive MCP/graph recovery, verify discovery and a known
read-only query in fresh intended sessions without reapplying setup.

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

`configuration` defaults to `process`, which evaluates Node TLS with the trust this process started with. A long-running host that re-checks after a repair can pass `configuration: 'persisted'` to evaluate Node TLS (`<target>/tls/node/<host>` and configured MCP endpoints) with the trust that Core's own managed `node-npm-ca` configuration gives a new process, because `NODE_EXTRA_CA_CERTS` is read only at process start. Only that configuration is read: the managed Node block in the user shell profile (`~/.profile`, `~/.zprofile`, or the PowerShell profile on Windows, which applies the managed profile block rather than the user environment registry value) and the managed `.npmrc` block, each applied only while Core's custody for it matches the bytes of that block (judged by the block's own bytes and line endings, not the rest of the file) and the managed material file it names is unchanged and holds certificates. Other lines in those files and the host's own environment are ignored. The result adds `persisted: { values }`, one entry per value found (`node-extra-ca-certs`, `npm-cafile`) with `id`, `repair`, `managementId`, `member` (`path`, `blockId`), a `state` of `applied`, `removed`, `modified` or `unowned`, and, when applied, the material path as `value`, its `certificates` count and `materialSha256`. A value that is not `applied` is never used, adds a `STATE_CONFLICT` diagnostic (`persisted-removed`, `persisted-modified` or `persisted-unowned`) and makes the status `incomplete`. If Core's custody cannot be read at all, the result carries a `PREREQUISITE_UNAVAILABLE` diagnostic with reason `persisted-configuration-unavailable`, every Node TLS and configured MCP check reports `unavailable` with that reason (no probe runs with any trust), and the status is `incomplete`. Persisted Node TLS probes never use this process's own start-time trust (`NODE_EXTRA_CA_CERTS`) or the default root set: their trust is the bundled roots, plus the operating system's roots only when a new process would enable them (`NODE_USE_SYSTEM_CA=1`, or a `NODE_OPTIONS` in this process's environment whose last `--use-system-ca` or `--no-use-system-ca` option is `--use-system-ca`), plus the applied Node extras. For the `npm` target an applied `npm-cafile` replaces that trust: its certificates alone are used, as npm's `cafile` replaces its default roots. With nothing applied the base trust alone is used, so a CA that only this process happens to trust does not verify a repair. Persisted evaluation reads Core's custody without writing state, locks or history; the `tls/os` checks still use the operating system's own trust, and `effectiveOptions.configuration` records the choice.

`@aihq/core` exports the `PersistedConfigurationValue` type alongside `InspectRequest` and `InspectResult`. The Node-only `@aihq/core/harness/runtime` `diagnose` accepts the same opt-in as `persistedTrust`: an array of at most 16 `{ effect, certificates }` entries, where `effect` is `node` or `npm` and `certificates` are PEM texts (at most 1024 distinct certificates in total, 64 KiB each and 16 MiB together; a certificate repeated across entries counts once, every one a parseable X.509 certificate), or the literal `'unavailable'`. It composes the trust described above from those entries; Core only reports the applied material of each value and attaches no meaning to the `effect`. Any other shape, an unknown `effect`, an unknown key or a value over a limit is refused as `invalid` with reason `persisted-trust`. `persistedConfigurationMembers()` returns the managed blocks the shipped repair persists on this platform (`id`, `repair`, `managementId`, `materialName`, `effect`, the `member` block descriptor and a `content(materialPath)` renderer) without reading host state.

Each `targets` entry from `@aihq/core/harness` declares `binaries` (the names inspection resolves to detect the target, in preference order) and `executables`: every command name the target covers, its `binaries` first, then commands that ship with the tool and run under its configuration without being detection signals. The npm target covers `npm` and `npx`; Node.js covers `node`; Python `python3` and `python`; pip `pip` and `pip3`; Git `git`. Names carry no platform extension (`npm.cmd` is `npm`), and each name belongs to one target, so a consumer can map a command to its target with `targets.find(target => target.executables.includes(name))`.

Inspection also covers the helpers `rg`, `fd` (or Debian's `fdfind`), `jq`, `curl`, `keytool` and `bash`, and the clients Antigravity (`agy`, legacy `antigravity`) and Zed (`zed`, or `zeditor`/`zedit` where a distribution renames it). Each is a presence and version probe, not a general tool inventory; `keytool`'s own `-version` exists only in newer JDKs, so its probe passes `-version` to the Java launcher through the documented `-J` option. When several distinct PATH candidates (after resolving symlinks, and counting one install directory once) resolve for one of these tools, the `<id>/resolution` observation names the file and 1-based PATH entry used and how many others exist. On Windows a `bash` in System32 or WindowsApps is reported as an ambiguous WSL launcher rather than assumed to be Git Bash, and its version command is skipped (`bash/version` reason `wsl-launcher`) so inspection never starts WSL. For Antigravity and Zed, a detected installation or configuration adds an `<id>/loading` observation and manual guidance: presence and configuration are shown, but native loading is not verified. Gemini CLI configuration is recognised only from its own `~/.gemini/tmp`, `extensions`, `commands` or `history` directories, so an Antigravity-only `~/.gemini` (`antigravity`, `antigravity-cli`, `config`) does not report `gemini` as configured. A Gemini `settings.json` or `GEMINI.md` alone is not treated as a trace, because Antigravity shares the `~/.gemini` namespace; an installed `gemini` executable is still detected.

## AI tool registry

`toolRegistry` from `@aihq/core/harness` (`urn:aihq:harness:tool-registry:1.0.0`)
lists the AI tools Harness knows. It is portable, frozen data with no host effects.
Each entry is `{ id, label, surface, binaries, aliases }`, where `surface` is
`"cli"` or `"ide"`.

- Command-line tools and IDEs are separate entries. For example `kiro` is Kiro CLI
  and `kiro-ide` is Kiro IDE; an IDE layout is never used for a CLI.
- `claude-code` is an alias of `claude`. Antigravity's CLI is `antigravity`
  (binary `agy`), distinct from Gemini CLI (`gemini`).
- Every existing native client ID is a registry ID.

**Registry IDs and labels are a stable vocabulary.** Other packages may cite them.
Aliases are other IDs for the same tool.

```js
import { listTools, selectTool } from '@aihq/core/harness';

listTools();                            // tools with at least one observed binding cell
listTools({ includeUnobserved: true }); // every registry tool, in registry order
selectTool('claude-code');              // { status: 'selected', tool: { id: 'claude', ... } }
selectTool('kiro-ide');                 // { status: 'refused', code: 'PREREQUISITE_UNAVAILABLE',
                                        //   reason: 'tool-not-observed', tool: { id: 'kiro-ide', ... } }
selectTool('unknown');                  // { status: 'refused', code: 'INPUT_INVALID', reason: 'unknown-tool' }
```

`listTools()` offers only tools with an observed binding cell: today Claude Code,
Codex CLI, Kiro CLI, Copilot CLI and Antigravity CLI. No IDE has been observed, so
no IDE is offered. Use `listTools({ includeUnobserved: true })` to display the
others. Observation presence comes from the [observed tool bindings](#observed-tool-bindings)
shipped with this package. A request naming an unobserved tool is refused with
`tool-not-observed`. IDE support claims in Catalog 1.x content are display data
only; Core never binds content from them. Being listed does not mean a tool is
installed, configured or verified.

## Observed tool bindings

`toolBindings` from `@aihq/core/harness` is the observed binding table: one
`urn:aihq:harness:tool-binding:1.0.0` binding per observed tool, validated by
`validateToolBinding` and described by its schema export. It is portable, frozen
Harness data with no host effects.

```ts
{ schema, tool, digest, layouts: Record<Kind, Layout>, entryFiles[], entryPointer?, alsoReads[] }
// Kind: skill | agent | command | rule | hook | mcp-server | document (toolBindingKinds)
// Layout: { support, reason, observations[], roots, skillKey?, convert?, namespace?,
//           register?: { file, container[], format, approval, permissionStep?, approvalLocation? },
//           formats?, hookEvents?, hookProtocols?, commandTemplate? }
// Observation: { toolVersion, observedAt, coreVersion, os, arch, isolation, runRecordDigest,
//                delivered, registered, recognised }
```

A layout says where the tool reads that kind and how far that has been proven.
`roots.project` is relative to the project; `roots.user.path` is relative to the
user home, and `roots.user.resolvedBy` names what the tool uses to find it.
`reason` is shown for every cell. `digest` is the lowercase SHA-256 of the
binding's canonical JSON (sorted keys, no whitespace) without `digest`; any change
to a binding changes it. `validateToolBinding` does not check the digest, so a
consumer that binds it recomputes it.

**Permission steps.** An MCP server layout names the tool's `permissionStep` and,
in `register.approvalLocation`, where the tool records a person's OK for one server
and its shape: `{ shape: 'array', file, format, container, denied? }` (the server
key is a member of a list, with an optional separate list of denied servers),
`{ shape: 'object-keyed', file, format, container, approved }` (the value
`approved` at the server's key) or `{ shape: 'other' }`, which Core never writes.
`file` is relative to the same root as the registration, and `format` is `json` or
`jsonc`. The shipped Claude Code binding names its project approvals list,
`enabledMcpjsonServers` in `.claude/settings.local.json`, with
`disabledMcpjsonServers` as its denied list; Codex CLI, Copilot CLI and
Antigravity CLI record approval in policies or folder trust, so their shape is
`other`. These locations are binding data from the tools' settings formats, not
observed grants: no canary has yet observed a tool reading an approval Core wrote.
`validateToolBinding` refuses an approval location outside an MCP server layout
with a permission step, or one whose denied list overlaps its approved list
(`approval-location-invalid`).

**Support is derived only from observations.** `support` is `native`, `none` or
`unconfirmed`:

- An observation counts only under qualifying isolation: `os-account`, `sandbox`
  or `env-redirect-outside-profile`. `env-redirect-inside-profile` never counts.
  An outside-profile observation keeps the project outside the user profile;
  what such a tool still reads from the profile is listed in `alsoReads`.
- `native` needs a counted observation on a named tool version where the tool
  `registered` the item (including `registered-pending-approval`), showed it to
  the model (`visible-to-model`) or the model used it (`recognised`). `listed-only`
  alone never counts, and neither does `contaminated`. A `document` (licence,
  notice) needs only `delivered`.
- `none` means a counted observation shows the tool did not take a delivered item
  (`not-registered` or `not-recognised`) and nothing proves it.
- `unconfirmed` means no qualifying observation yet. It is never shown as working
  and never as "doesn't work".
- Agents and commands are `native` only where the tool reads that kind, and a
  `convert` is named only on a native cell, where the converter's output was
  observed. There are no reference files. Copilot `.agent.md` and Kiro agent JSON
  cells stay `none` until a converter is observed.

`validateToolBinding` refuses a cell whose `support` differs from what its
observations give (`support-not-derived`), an observation that shows listing or
use without delivery (`observation-inconsistent`), and a converter on a cell that
is not native (`convert-not-observed`).

**Support is scoped to the platform it was observed on.** `deriveCellSupport({ kind,
observations, platform?, installedVersion? })` counts only observations made on
`platform`'s OS and architecture, so a cell observed only on Windows is
`unconfirmed` on Linux. When `installedVersion` is newer than every proving
observation, the cell is `stale` and claims no more than `registered`; an older
installed version keeps the observed claim. `platform` takes `os` `windows`,
`macos` or `linux` and `arch` `x64` or `arm64`. The result
is `{ support, observed, stale, observedOn? }`, where `observed` is the strongest
counted level (`recognised`, `registered`, `listed-only`, `delivered` or `none`).

```js
import { selectBindingCell } from '@aihq/core/harness';

selectBindingCell({ tool: 'claude-code', kind: 'hook', platform: { os: 'windows', arch: 'x64' } });
// { status: 'selected', tool: 'claude', kind: 'hook', support: 'native', observed: 'recognised',
//   stale: false, observedOn, digest, layout }
selectBindingCell({ tool: 'kiro', kind: 'hook', platform: { os: 'windows', arch: 'x64' } });
// { status: 'refused', code: 'PREREQUISITE_UNAVAILABLE', reason: 'kind-not-native', tool: 'kiro',
//   kind: 'hook', cell: { support: 'unconfirmed', reason: 'Not observed: no Kiro CLI hook layout was delivered.' } }
```

`selectBindingCell` selects only a cell that is native on that platform and
refuses any other with the cell's reason; on a platform with no observation of
that cell the reason says so. Unknown and unobserved tools are refused as by
`selectTool`.

**Seeded observations.** The table is seeded with Windows x64 canary runs from
23 October 2026 for the five observed tools, with Core 1.0.0-dev.37. Each model
session is one observation per delivered cell: Claude Code 2.1.308, Codex CLI
0.163.0 and Copilot CLI 1.0.103 with the projects outside the user profile
(`env-redirect-outside-profile`), and Kiro CLI 2.33.1 and Antigravity CLI 1.4.6 in
Windows Sandbox (`sandbox`). A session shows registration only for an MCP server
the tool started. The tools' model-free list commands ran on the host in a
disposable home inside the user profile; their results are kept as
`env-redirect-inside-profile` observations that never count. So the Codex skill,
visible to the model in a list but only listed in the session, is `unconfirmed`,
and the Antigravity skill is `listed-only`: its body reached the model through a
file read, not as a skill.

**The run record is published.** Every seeded observation names the SHA-256 of
`@aihq/core/harness/run-records/canary-2026-10-23-windows-x64.json`
(`runRecordDigest`). That record lists each session (tool version, isolation,
times, command, tool calls and MCP server events), each list command result and
each delivered cell (files with their SHA-256, recognised level and evidence),
without local machine paths.

**These are scoped claims.** Observations come from the existing
`verifyNativeClient` route or a canary run with a published run record. They hold
only for their tool version, OS, architecture and isolation, and they do not
satisfy native verification acceptance, which keeps its stronger bar.

**Every binding change needs a new Core version.** The table is Harness data
shipped in `@aihq/core`. Refreshing observations by a canary run is a separate
operation with its own maintainer approval; package tests never run one. The
fixture `@aihq/core/fixtures/harness/tool-binding/1.0.0/support-cases.json` lists
derived support for the shipped table, including a `stale` and an `unconfirmed`
cell.

## Render Catalog items and check compatibility

`renderDelivery` and `checkCompatibility` from `@aihq/core/harness` are portable
data functions. They read a checked Catalog release 1.6 item and a
[tool binding](#observed-tool-bindings), never import the Core engine and have
no host effects. Pass a binding from `toolBindings` (or one validated by
`validateToolBinding`) for the tool you name; an unknown or unobserved tool is
refused as by `selectTool`, and a binding for another tool or an invalid one is
refused (`binding-tool-mismatch`, `binding-invalid`). Both functions recompute
the binding digest (`binding-digest-mismatch`).

### Render one item as an ordinary recipe

```js
import { renderDelivery } from '@aihq/core/harness';
import { deriveRecipeIdentity } from '@aihq/core/contracts';

const rendered = renderDelivery({ tool: 'claude', item, binding, scope: 'project' });
// { status: 'rendered', tool, item: { framework, itemId }, bindingDigest, materialRoot: 'catalog', recipe }
const identity = await deriveRecipeIdentity({ recipe: rendered.recipe });
```

The recipe uses Core's existing operations: `file.write` for content materials,
`config.entries` for object-keyed registrations (MCP servers), `text.block` for
marker blocks and `hook.group` for hooks. It is `urn:aihq:core:recipe:1.1.0` when
it registers a hook group and `1.0.0` otherwise. Each written file has a
`file.sha256` check. Materials are inline declarations with source
`{ kind: 'local', input: 'catalog' }` and the item's `packagePath`, so Prepare
reads them through `controls.materialRoots` (`--material-root catalog=<folder>`)
mapped to the installed Catalog package folder and verifies each SHA-256 and
length.

- **Only content is delivered.** The behaviour file (`aih-behaviour.json`) is
  Catalog metadata and is never written into a project. The item's
  `contentSha256` and `behaviourSha256` must match its materials, and its kind,
  payload, requirements, dependencies and executable states must reproduce the
  behaviour file, as Catalog's reader checks (`item-identity-mismatch`).
- **Where items land.** `scope` selects the layout's `roots.project` or
  `roots.user` (`scope-not-bound` when the binding names none). A skill folder is
  `payload.dirName`. Rule and skill names follow the layout's `namespace` with the
  item's `payload.namespace`: `folder` nests `<namespace>/<name>`, `prefix` names
  `<namespace>-<name>`, and no layout namespace keeps the plain name. A rule
  delivers its Markdown materials; where the tool reads rules from an entry file
  (`AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`), or for
  `placement: 'entry-block'`, the rule is one marker block
  (`<!-- BEGIN aih:<framework>.<itemId> -->` … `END`) whose text you pass as
  `contents: { [materialId]: text }`; the text must match that material's
  SHA-256 and length (`content-required`, `content-mismatch`). A
  `placement: 'project-folder'` rule goes into `projectFolder` (default
  `ai-coding`). Agents and commands deliver their `payload.files`; they are
  refused with `native-only-kind` where the binding records the tool not reading
  that kind or names no location for it. An MCP server delivers its registration
  under `register.container` and `payload.key`. An input-backed `env` or `headers`
  value stays a declared recipe input, so the review names it, but the
  configuration holds only the reference `${<input name>}`, never a value, for
  sensitive and ordinary inputs alike. Set that environment variable where the
  tool runs. The input name must be a valid environment variable name
  (`input-reference-invalid` otherwise). A sensitive value travels only in the
  live request (`controls.privateInputs`), an ordinary one only in the policy's
  `configuration`, and neither is reviewed or written anywhere;
  where a tool reads only literal values in its configuration, the reference is
  still what Core writes, with no literal fallback.
- **Hooks.** The binding must speak the hook's `protocol` (`hookProtocols`) and
  map its `event` (`hookEvents`), else `protocol-not-spoken`. Scripts are written
  to `<hooks root>/<itemId>/`, and one group is registered in `register.file` at
  `register.container` with its last segment replaced by the mapped event. The
  command comes from `payload.command`: the named interpreter (`node`, `bash`,
  `python`, `pwsh`) and script, or the named program given the script as a
  material argument, then the arguments, each double-quoted with literal text
  and material paths escaped. Naming both, or a program not given the script, is
  `hook-command-ambiguous`. A hook that names neither is refused with
  `interpreter-required`: a shebang never works on Windows, so it is never
  relied on. Only Catalog's four placeholders are accepted
  (`unknown-placeholder` otherwise). For `claude-code-hooks`, `{projectDir}` is
  `${CLAUDE_PROJECT_DIR}`, `{homeDir}` is `${HOME}`, and `{itemDir}` and
  `{pluginRoot}` are the item's delivered folder under the project or home (Core
  delivers outside any tool plugin). A layout `commandTemplate` wraps the command:
  it holds `{command}` once and otherwise only those placeholders
  (`command-template-invalid`). The interpreter, or a plain program name, is a
  recipe `executable` prerequisite. A hook needs a JSON or JSONC registration and
  an MCP server a JSON, JSONC or TOML one (`registration-not-bound`).
- **Identity.** The recipe's description names both item identities and the
  binding digest, so the identity from `deriveRecipeIdentity` changes when either
  item identity or the binding changes.
- **Allowing one MCP server.** `grantApproval: { framework, itemId }` names the
  MCP server item being rendered when the person ticked it; anything else (a
  list, another item, a non-server) is `INPUT_INVALID` `grant-approval`. It adds
  exactly one operation, `approve-server`, after the registration, for the
  binding's [approval location](#observed-tool-bindings): one `config.entries`
  set of `approved` at the server's key for `object-keyed`, or one
  `config.member` add of the server key for `array` (with the `denied` list as
  `exclusiveWith`). Either carries `approval: { tool }`, and the recipe is
  `urn:aihq:core:recipe:1.4.0`. Any other shape, or none, is refused with
  `PREREQUISITE_UNAVAILABLE` `approval-shape-unsupported` and `guidance` saying
  the server still needs your OK in the tool, with its permission step. Core
  never writes an approve-all switch (such as Claude Code's
  `enableAllProjectMcpServers`). See [one-server approval](#allow-one-mcp-server)
  for how Core applies and removes it.

**Authority fence.** A rendered recipe is ordinary execution-policy content. Put
it in a policy selection like any recipe: Vibe applies it after review, and in
Enterprise the organization policy governs it in full, by recipe identity, scope,
inputs, obligations and lifecycle permissions. Rendering through Harness grants
nothing: only Harness's own published repair definitions keep the developer-only
repair status, and a rendered recipe id is not a repair (`repair-unsupported`).

### Check compatibility from the binding alone

```js
import { checkCompatibility } from '@aihq/core/harness';

const result = checkCompatibility({ tool: 'codex', platform: { os: 'windows', arch: 'x64' }, binding, items: [
  { item: bootstrapHook, fallback: bootstrapRule, sets: [setRef] },
  { item: reviewSkill, required: true, sets: [setRef] }
] });
// { status: 'checked', tool, platform, bindingDigest, items: [...], sets: [...] }
```

`items` are the members Catalog resolved, after its set expansion and
exclusions; Core does not expand sets. Each entry is `{ item, fallback?,
excluded?, required?, sets? }`, with set references `{ framework, setId,
setSha256 }`. An entry repeated across overlapping sets is merged, results are
ordered by framework and item id, and sets by reference, so the answer does not
depend on order. Per item the result is:

```ts
{ item: { framework, itemId }, support, reason, observed,
  observedOn: { toolVersion, os, arch, observedAt } | null,
  boundAs?: { kind, item, viaFallback: true }, excluded?: true, permissionStep?,
  notRendered?: { reason, detail },
  deliveredSize: { bytes, chars, alwaysLoaded: { bytes, chars } },
  staticBlockers: { code, detail }[] }
```

- **Platform.** Only observations made on that OS and architecture count, so a
  cell observed only on Windows is `unconfirmed` on Linux, with a reason saying
  so and `observedOn: null`.
- **Permission step.** `permissionStep` says the item still needs your OK in the
  tool: `Still needs your OK in <tool label>. <the binding's permission step>`.
- **Static blockers.** `protocol-not-spoken` (hook protocol or event the binding
  does not map), `required-but-unsupported` (a `required` item whose cell is
  `none` on this platform), `native-only-kind` (an agent or command the tool does
  not read on this platform or has no location for) and `same-folder` (two
  different items writing one skill or hook folder, or one file; a fallback that
  is also a member writes the same place).
- **Agreement with rendering.** Where `renderDelivery` would refuse the bound
  item for another reason (for example `scope-not-bound` for a document or an
  entry block the binding has no place for, `interpreter-required`,
  `rule-text-ambiguous`), `notRendered` names it and the item delivers nothing.
  `support` stays the cell's observed support; `notRendered` and any static
  blocker override it, so read all three before showing an item as working. A
  malformed item still refuses the whole check.
- **Fallbacks.** Where the item's own cell is not native and its fallback's cell
  is, the item binds as the fallback and `boundAs` reports it, with the
  fallback's support, size and blockers. A fallback is never used for an
  excluded item, never when the fallback is itself excluded, and never for or as
  an agent or command. An excluded item is reported with `excluded: true`, its own
  cell and no delivery.
- **Sizes.** `bytes` are the delivered materials' byte lengths and `chars`
  Catalog's measured characters (the byte length when unmeasured).
  `alwaysLoaded` is what the tool reads every session: Catalog's measured `name`
  and `description` parts for skills, agents and commands, the whole text of an
  always-included or entry-file rule, and nothing for hooks, MCP servers and
  documents.
- **Sets.** Each referenced set reports `fit` (`full`, `partial` or `none`),
  member counts `{ native, unconfirmed, none }` (a blocked or not-rendered
  member counts as `none`) and the summed `deliveredSize`, over the supplied non-excluded members.

These are static answers from Harness data. Host facts (installed version,
executables, copies elsewhere) come from [`inspectToolHost`](#inspect-a-tool-host).

## Inspect a tool host

`inspectToolHost({ tool, project, items }, controls?)` from
`@aihq/core/harness/runtime` extends [inspection](#inspect-existing-tools) to one
observed tool and a set of items on this computer. It observes with bounded
reads and **runs nothing**: no tool, hook, MCP server or item content is started,
not even for `--version`. It never writes, removes or edits anything it finds.

```js
import { inspectToolHost } from '@aihq/core/harness/runtime';

const result = await inspectToolHost({
  tool: 'claude',                      // a registry id or alias with an observed binding
  project: '/absolute/project/folder', // an existing folder
  items: [
    { framework: 'example', itemId: 'review', kind: 'skill', key: 'review' },
    { framework: 'example', itemId: 'github', kind: 'mcp-server', key: 'github',
      executables: ['npx'], inputs: ['GITHUB_TOKEN'], requires: [{ framework: 'example', itemId: 'base' }] }
  ]
}, { budgetMs: 10000 });
```

Each item names its Catalog `framework` and `itemId`, a binding `kind`, and
optionally the `key` the tool sees (a skill folder, an agent, command, rule or
document file name, or an MCP server key), the `executables` it needs on `PATH`
(for example a hook's interpreter), its input names (never values) and the
items it `requires`, as resolved by Catalog. The consumer derives these from the
items it already holds. A complete result reports:

- `installedVersion`: `{ state: 'known', version, source }`, read only from files
  beside the tool's executable on `PATH` (the npm package whose `bin` names it,
  through a link or as the one such package beside an npm command shim, or a
  `versions/<version>` file), or `{ state: 'unknown', reason }`.
- per item, each executable as `present`, `absent` or `unknown`. `absent` means
  every `PATH` folder was read and none holds a regular executable file of that
  name; an unset `PATH`, a relative `PATH` entry or an unreadable folder gives
  `unknown`. `absent` is about `PATH` only: on Windows, a shell or
  `CreateProcess` may also search the current or system folders.
- per item, same-key `copies` at `user` level, in `parentFolders` and in
  `plugins`, each `found` (with `paths`), `none` or `unavailable` (with a
  reason). Copies are read only where the [binding](#observed-tool-bindings)
  says the tool reads that kind: `roots.user` for the user level (following
  `CODEX_HOME` for Codex; another redirect named in `resolvedBy` that is set
  makes it `unavailable`), and, only where the binding's `alsoReads` records
  reading every folder above the project (today Copilot CLI skills), the project
  root repeated in each of those folders, up to but not including the user home.
  A registration file is read for the item's key in its container (JSON and
  JSONC; other formats and malformed files are `unavailable`). A hook has no key,
  and no binding observes a plugin location yet, so those are `unavailable`.
- per item, the `inputs` still required: input values never reach inspection, so
  every declared input is still required.
- `stale` per item and overall: `true` when the installed version is newer than
  every observation proving the cell (`observedVersion` is the newest of them),
  `false` only when a proving observation on this OS and architecture is not
  older, and otherwise `'unchecked'`: the installed version is unknown, nothing
  proves the cell, or no proving observation was made on this platform.
- `hostBlockers[]`: `executable-missing` (an `absent` executable),
  `input-required` (each declared input) and `dependency-missing` (a required
  item not among the inspected items).
- `warnings[]`: `same-key-elsewhere` with `where` (`user`, `parent-folder` or
  `plugin`) and the found `path`, and `also-reads` for each of the binding's
  `alsoReads` entries.
- `unchecked[]`: an explicit note, with its reason, for every fact that is
  `unknown` or `unavailable`.

**Unknown never becomes a claim.** An `unknown` executable is never
`executable-missing`, an `unavailable` copy is never `same-key-elsewhere`, and an
unknown version or an unproven cell is never `stale: false`. These are host observations of this
computer only: they do not verify that the tool loads or uses an item, and they
do not satisfy native verification. Platform-scoped support stays the binding's
static answer.

A request outside this shape is `invalid` (`INPUT_INVALID` with the field), an
unknown tool is `refused` with `unknown-tool` and an unobserved tool with
`tool-not-observed`. `controls` take `signal` and `budgetMs` (1 to 60000, default
10000). Reads run synchronously and are bounded by that budget and a fixed read
count in `limits`; past either, the result is `incomplete` and the remaining
facts are unchecked. A signal already aborted gives `cancelled` with no facts.

## Project basics per repository

`detectProjectFacts({ project }, controls?)` from `@aihq/core/harness/runtime` reads a project with
bounded reads and **runs nothing** — no tool, script or package manager is executed, not even for a
version. It reads only a fixed candidate list (`package.json`, the common lockfiles, `.nvmrc`,
`.node-version`), capped per file and per read count, and reports
`facts: { field, value, confidence: 'detected' | 'inferred' }[]` for the stack, the package manager,
the Node version and the test, build and lint commands. A fact is `detected` only from a file the
diagnostic read (a manifest, a lockfile, a script, a version file); the only inferred fact is the
npm default for a manifest with no stronger package-manager signal, and the confidence says so.
A fact it cannot establish is omitted, never fabricated. The result envelope mirrors the other
bounded diagnostics: `complete`, `incomplete`, `invalid` or `cancelled`, with `limits` accounting
and one diagnostic per read failure. The consumer reviews the facts; rendering carries them into
the Project basics selections.

The consumer records the reviewed facts as descriptive selection metadata, and they flow into both
public surfaces: the prepared review (prepared work 1.6.0 `selections[].projectFacts`) and the
inventory (managed-inventory-result 1.1.0 `selections[].projectFacts`), shown as
"Detected: {value}" or "Inferred: {value}". Custody retains them with the selection's other facts,
so a restart reads them back without the Catalog. `projectFacts` is optional metadata: it never
adds operations, inputs or authority, and a malformed entry refuses the policy.

A rule item with `placement: 'entry-block'` renders one shared guidance block into **each** of the
binding's `entryFiles`, between `<!-- BEGIN aih:shared -->` and `<!-- END aih:shared -->`; a
binding that declares `entryPointer { file, template }` also gets one pointer block in that file,
`<!-- BEGIN aih:shared:pointer -->` … `<!-- END aih:shared:pointer -->`, whose text is the
template with `{projectFolder}` replaced by the reviewed folder name (default `ai-coding`, carried
as a required recipe input). Text outside the blocks is kept byte for byte. Custody records these
as typed `entry-block { file, marker, sha256 }` and `entry-pointer { file, marker, sha256 }`
members (inventory member kinds of the same names), reporting `block-changed` and `block-missing`
like any marker block.

On update, a person's own lines found **added inside** the shared block move to the user-owned
`<projectFolder>/PROJECT.md` — the write is part of the reviewed update, so the preview shows the
move, and the block itself updates instead of conflicting. The notes file is written but never
claimed: removal never touches it and later edits are never conflicts. Edits that delete or change
Core's own lines stay ordinary conflicts, never rescued.

Removal takes only the blocks: the entry files and everything the person wrote outside the blocks
stay byte for byte, and any `preExisting` value a replaced configuration entry had is restored as
before. Project-folder items go into the folder the consumer named (default `ai-coding`).

## Supported AI clients

`nativeClientIds` from `@aihq/core/harness` is Core's supported AI client list. It is a portable, frozen array with no host effects.

```ts
import { nativeClientIds } from '@aihq/core/harness';
import type { NativeClientId } from '@aihq/core/contracts';
```

The same ids are the accepted `client` values for organization target 1.0.0 and selectors (`NativeClientId`, exported from `@aihq/core` and `@aihq/core/contracts`). Membership does not mean a client is installed, configured, connected or admitted for native verification, and the order is not a ranking.

## Explicit native client verification

`verifyNativeClient(request, controls?)` and `aih verify-client` are separate
from ordinary inspection. Inspection retains its presence/version and optional
TLS checks without launching configured MCP commands, servers or client sessions.
Native verification uses explicit input, a disposable cell and bounded evidence.

```js
import { verifyNativeClient } from '@aihq/core';
const result = await verifyNativeClient({
  schema: 'urn:aihq:core:native-verification-request:1.0.0',
  client: 'claude',
  maxTurns: selectedTotalTurns,
  maxEstimatedCostUsd: selectedTotalEstimatedUsd
});
```

```sh
aih verify-client claude --json
aih verify-client claude --candidate-smoke --host-bindings dedicated-test.json --json
```

The bundled `claude-linux-x64-wsl2-srt-2.1.285` definition is admitted for
Claude Code 2.1.285 on Linux x64 WSL2, osRelease
`6.18.33.2-microsoft-standard-WSL2`, and selects without `--candidate-smoke`.
Its retained reviewed batch evidence is identified by `evidenceSha256`
`a8c226d1c56764a6c773268186a79a3643e5a5d0afc2acd9f9708faa9de50947`.
The tested packed artifact was Core `1.0.0-dev.27`; Core `1.0.0-dev.28` promotes
the descriptor. Promotion is not publication: no npm publish has occurred.
Coverage is the bundled mechanism only, not Catalog's cross-client matrix.
Acceptance covers the fixed verifier environment: auto-memory disabled,
marketplace auto-install disabled, fast mode disabled, and MCP connections
awaited before init within the client's bounded timeout. Authentication uses
`provisioning-bound-session` identity, with the owner's recorded acceptance:
it loses the runtime wrong-account/refresh cross-check and is not provider-signed
attestation. The documented proxy and policy limitations still apply.
The Windows definition remains a candidate with null evidence and requires
`--candidate-smoke`; passing a smoke never changes admission. The portable
validator and the 1.1.0 definition schema both accept an admitted state only as
an exact registered admitted descriptor. All eleven selected client
IDs remain available for explicit, honest outcomes: Claude, Codex, Cursor,
Gemini, Copilot, Windsurf, OpenCode, Kimi, Kiro, Antigravity and Zed.

The default whole-check budget is 180000 ms; `--budget-ms` accepts integers
1000–600000. Cancellation uses `controls.signal` or CLI SIGINT. Cleanup has one
additional 10000 ms allowance, with unresolved resources reported explicitly.
JSON output contains one result and no raw process output. Exit codes are 0 for
`complete/verified`, 2 for invalid input, 130 for cancellation and 1 otherwise.
No verification result grants Apply approval or organization authority.

Launching sessions also requires explicit `maxTurns` and `maxEstimatedCostUsd`
totals, in the request or controls (never both). CLI equivalents are
`--max-turns` and `--max-estimated-cost-usd`; flags must not duplicate limits in
the request file. Both limits must be supplied together. Turns are safe integers
at least 2; estimated USD is finite and positive, at most `Number.MAX_SAFE_INTEGER`,
and its half must remain positive. There are no default turn or spend numbers.
These controls select one attempt, at most two fresh sessions and no automatic retry.

Before session one, Core reserves half the estimated USD for each session and
splits turns into `floor(maxTurns/2)` and `ceil(maxTurns/2)`. Session two receives
the lesser of its reserved share and the remaining total after session one's
reported usage. Unused first-session share is not added to session two's share.
Only one final, session-bound Claude result with numeric `num_turns` and
`total_cost_usd` establishes usage. Missing, malformed, duplicate or interrupted
results stop the attempt with `usage-unavailable`; absence of usage never means
zero cost. Results record each session's allowance and usage and the total in
`limits.finite`. Unknown totals are null.

The fixed adapter passes `--max-turns` and `--max-budget-usd`. Turn counts measure
agentic tool-use round trips, not individual tools. Estimated USD uses Claude's
local pricing/accounting: the response crossing a threshold finishes, so it can
overshoot and differ from actual charges. A first-session overshoot can reduce
or exhaust session two's remaining allowance. Neither the threshold nor the
deadline is an actual-charge hard cap. Limit termination produces incomplete
acceptance, even if some proof already passed, and follows the same owned-process
cleanup. Dedicated identity, exact artifacts, numeric limits and execution
authorization still require independent operator selection.

The [Claude finite-limit assessment](https://github.com/samartomar/aih-core/blob/main/docs/native-claude-finite-limits.md)
documents the implemented estimated stopping semantics, their limitations and
the remaining native qualification gates. No real provider requests were needed
to test these controls.

The complete request may come from `--configuration <request-json-file>`; its
client must match the positional client. `--host-bindings <host-json-file>`
accepts only `testIdentity` and `configurationSources`, independently selected
by a trusted Node host. Embedded paths are absolute. These files are bounded
strict UTF-8 JSON, reject duplicate keys and links, and are never echoed.
No ambient credentials, arbitrary commands, callbacks, environment maps or
collector endpoints are accepted. Dedicated OAuth provisioning is an operator
step outside verification; the normal user profile is never its credential source.

For supplied Claude bundles, the fixed installed adapter derives verifier-owned
user settings from the independently verified server and query identities. It
approves only that project server and allows only its fixed instruction-attestation
tool and selected query; the built-in deny list and
`enableAllProjectMcpServers=false` remain unchanged. Ambiguous or pattern-like
identities, extra selected tools and additional project MCP servers are refused.
The effective settings bytes, member lengths/hashes and guardrail tree digest are
bound to staging, persistence and Linux launch protection. Selected bundle bytes
and installed definition/admission metadata are unchanged; the bundled fixture
retains its original settings bytes. Approvals live in the disposable user's
`.claude/settings.json`, so a fresh home needs no remembered project approval.
Actual discovery and restrictions still require native observations, and managed
restrictions retain precedence. Controlled permission tests establish neither
native two-session acceptance nor admission.

Supplied configuration uses independent archive/member pins and exact starting
and output trees. The bundled fixture proves only its mechanism; test content
cannot establish production configuration. Both fresh sessions must separately
observe initial instruction loading, MCP discovery and the fixed read-only query.
Before and after the second session, selected configuration and guardrail bytes
must be unchanged, and every other path in the cell must be fixed client-owned
state named by the installed adapter. Such a state tree may change except beneath
its fixed loading exclusions; for Claude, per-project memory and the client's other
reserved non-transcript names stay excluded. The client's global state file is
accepted only when a separate inspection finds bounded bookkeeping, without MCP
servers, tool or permission grants, trust or approval entries, credentials,
environment values or unrecognized keys. Outside uninspected client state, any
new instruction, settings, hook,
plugin, MCP, memory, shell-snapshot, session-environment or managed-policy file
is `configuration-changed`, as are links and other non-regular files in state.

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
`CLAUDE_CODE_DISABLE_FAST_MODE=1`, regardless of host values. Either key's presence
in a managed `env` block, including empty, `0` or `false` values, yields
`restricted` / `managed-restriction` with the same precedence. The pinned client
still writes disabled marketplace state: the global state inspector admits only
the complete tuple `officialMarketplaceAutoInstallAttempted=true`,
`officialMarketplaceAutoInstalled=false`, and
`officialMarketplaceAutoInstallFailReason="policy_blocked"`, or all three absent.
Partial tuples, other values, retry counters and timestamps remain refused.
This admits no plugin files, configuration or installation paths.

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

Claude's home state also includes exactly `.cache/claude-cli-nodejs`, with
`XDG_CACHE_HOME` remaining `<home>/.cache`. For the pinned Claude Code 2.1.285
executable and admitted invocation, the enumerated static trace identifies JSONL
error/MCP log writers and age-based cleanup beneath this tree, under sanitized
working-directory names; no configuration or instruction reader was identified in
that trace. No configuration or instruction discovery into this subtree was established for the traced local inputs; unobserved server-managed policy may alter loader roots. That conclusion is version-specific. `.cache` is accepted only as the directory parent of this
tree; other children, near matches and project-root equivalents are refused.
The uninspected root may be an ordinary single-link file or a directory. Files
named `settings.json` or `CLAUDE.md` within it are accepted as inert state; the
walker checks structure, not log content or loading behavior.

Logs may contain MCP server stderr. Verification never reads, ingests or exports
their contents. Successful whole-cell cleanup deletes them; failed cleanup
retains the cell and reports its opaque recovery name. Retention does not rely
on the client's own pruning. See [persistence diagnostics](docs/native-persistence-diagnostics.md)
for the state boundary and privacy-safe failure records.

Accepted limitation: provider feature-gate and experiment caches recorded by the
client, such as `cachedGrowthBookFeatures`, `cachedDynamicConfigs` and the
`cachedExperiment*` keys, persist from the first session into the second. The
second session's loading, restriction, tool-discovery and authentication evidence
is still observed independently. For Claude Code 2.1.285 this limitation also
includes behavior-relevant `modelAccessCache` (at most 256 closed records with
only `apiName`, a string of at most 65536 characters, and `entitled`, a boolean)
and boolean `penguinModeOrgEnabled`. Selected settings mutations still fail
persistence validation; `lastSeenOrgDefaultUpdatedAt` and
`gzipRequestBodiesLatchedOff` remain refused. Identity, loading, isolation and cleanup remain
distinct; hygiene evidence cannot become full native proof.
Unavailable process/peer-identity facilities fail closed. Native platform acceptance
requires actual observations and separate maintained evidence.

The Windows candidate names Claude Code 2.1.285 on Windows x64
(`10.0.26200`). The package includes a bounded Windows Job launcher, OS-bound
named-pipe peer observation and an explicit protected cell-local OAuth file path.
Facility availability requires actual probes; missing or changed helper/runtime
bytes fail closed. Dedicated identity still requires operator provisioning and
same-session authentication evidence. The candidate has no whole-client isolation
mechanism, so useful hygiene evidence remains incomplete/unverified. See
[Windows facilities and dedicated identity preparation](docs/native-windows-verification.md).
The separate admitted Linux x64 WSL2 definition wraps the entire workload in pinned
Anthropic Sandbox Runtime 0.0.78 and uses a bundled Linux kernel observer for
process ownership, authenticated IPC and cleanup. It requires the exact client,
kernel and runtime byte closure recorded by its definition metadata. Admission
is limited to the exact tested version and environment described above.
See [Linux isolation, prerequisites and limitations](docs/native-linux-verification.md).
Controlled facility and synthetic session checks do not establish native acceptance.

Optional [persistence diagnostics](docs/native-persistence-diagnostics.md) report
closed failure classes and bounded reviewed tokens on `aih.native.diagnostics.v1`
without exporting state values, raw names or project paths.

Portable validators `validateNativeVerificationRequest`,
`validateNativeVerificationResult` and `validateNativeVerificationBundle` are
exported from `@aihq/core/contracts`. The five version 1.0.0 schema exports cover
Core request/result/bundle and Harness definition/test identity. Portable import
and validation perform no host work. Host controls belong only in `@aihq/core`.

## Repair Node/npm trust

The versioned trust request reviews each source separately, retains previously
supplied sources until explicit removal or replacement, and reports complete
certificate and provenance changes. Native OS repair requires an admitted actual
client/backend/configuration combination. An unavailable combination returns a
blocked review; it is never reported as repaired. The portable Harness exports
`trustRepairIndex`, `trustCapabilities` and `selectRepairDefinition` for discovering
the installed definitions and admission cells.

For a reviewed supplied-file Node/npm repair, save this as `trust-inputs.json`:

```json
{
  "schema": "urn:aihq:core:repair-inputs:1.0.0",
  "route": "file",
  "repairs": { "node-npm-ca": {} },
  "sources": {
    "os": false,
    "supplied": [{ "id": "company", "file": "company-ca.pem" }]
  }
}
```

```sh
aih repair node-npm-ca --target npm --inputs-file trust-inputs.json --offline --json
aih repair node-npm-ca --target npm --inputs-file trust-inputs.json --offline --apply
```

Supplied paths in versioned CLI documents resolve relative to that document.
Public API supplied paths must be absolute. Versioned requests reject `caFile`;
source selection belongs in `sources`. `sources.os:true` requests the complete
effective OS projection and blocks if discovery or restriction preservation is
incomplete. Explicitly prepare with `os:false` for supplied-only trust. Offline
client checks are reported as skipped. Native requests use `route:"native"`,
omit `sources`, and require admitted native behavior.

The schema-less request below preserves its earlier supplied-file behavior.

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

## Export certificates

Export admission distinguishes fresh execution records from historical evidence carried by
`aih.trust.acceptance-migration.v1`. A migration preserves the original record bytes,
cell and limitations, verifies a fixed finite transition, and binds the current installed
helpers, serializer libraries and Core export glue. It does not establish a new execution
on the historical platform or a stronger OS-discovery/native-client claim.
`verifyTrustAdmissionEvidence` reports whether that provenance verifies; `valid` is not
a claim that every cell was freshly executed. Original controlled-selection limitations
remain applicable. The additional export classifier recognizes only Windows 11 Pro
Insider Preview 26H2 build 26340.9767 x64. Its four distinct PEM/P7B declared/off
cells carry fresh standard-user native acceptance, including separate P7B imports
and disposable-store cleanup. Other 26H2 builds are not admitted by these cells. Existing OS discovery and other repair classification
retain their earlier behavior.

`export-ca` reviews a standalone certificate export without a service URL or
prior repair. It writes deterministic PEM or certificates-only DER P7B at the
reviewed path inside the user home. Relative output paths resolve from the home;
the defaults are `.aih/exports/os-ca.pem` and `.aih/exports/os-ca.p7b`.

```sh
aih export-ca --format pem --output certificates/os-ca.pem --json
aih export-ca --format pkcs7-der --output certificates/os-ca.p7b --apply
```

OS discovery must establish the full suitable set and preserve every applicable
restriction. Incomplete discovery, policy loss or an unadmitted format/platform
blocks the complete export. Adding supplied certificates does not bypass that
requirement. For supplied-only export, use a document containing
`{"schema":"urn:aihq:core:certificate-export-inputs:1.0.0","sources":{"os":false,"supplied":[{"id":"company","file":"company-ca.pem"}]}}`
with `--inputs-file`. A matching installed format admission cell is still required.

The equivalent API request is:

```js
const preparation = await prepare({
  schema: 'urn:aihq:core:certificate-export-request:1.0.0',
  useCase: 'certificate-export',
  format: 'pem',
  output: 'certificates/company.pem',
  sources: { os: false, supplied: [{ id: 'company', file: absolutePemPath }] }
});
```

Authorize its exact `reviewDigest` through `apply` as for other prepared work.
An existing output requires a reviewed replacement unless genuine matching
custody already exists. Refresh re-reads each retained original source; missing,
changed or expired sources block until explicitly replaced or removed through
`sources.removeSupplied`. Removing the final certificate blocks; use managed
removal to retire the output. Different paths and formats have separate managed
identities. `--no-log` disables optional history, while protected ownership and
provenance remain required. Review public paths and certificate metadata before
sharing JSON output.

After an interrupted trust update, prepare the same output again with each
recorded supplied ID explicitly supplied or removed. Apply revalidates the current
sources and the reviewed recovery state. If ownership or provenance is missing,
use the exact replacement offered in `resolutionInputs`, then prepare and approve
again. Managed removal can retire a genuine owned output or clear interrupted
metadata when both output and ownership are absent. Changed replacement bytes or
unverifiable recovery evidence block reconciliation. Ordinary policy and trust
Prepare both check aggregate ownership capacity before returning a ready review.

## Repair Python/pip, Git, Cargo and conda trust

The versioned request uses the shared source review and protected custody contract
for any selected combination of `python`, `pip`, `git`, `cargo` and `conda`.
For an explicit supplied-file repair, save this as `trust-inputs.json`:

```json
{
  "schema": "urn:aihq:core:repair-inputs:1.0.0",
  "route": "file",
  "repairs": { "user-tools-ca": {} },
  "sources": {
    "os": false,
    "supplied": [{ "id": "company", "file": "company-ca.pem" }]
  }
}
```

```sh
aih repair user-tools-ca --target pip --target git --inputs-file trust-inputs.json --json
aih repair user-tools-ca --target pip --target git --inputs-file trust-inputs.json --apply
```

The API uses `schema: 'urn:aihq:core:repair-request:1.0.0'`, `route: 'file'`,
the same `sources`, and `repairs: [{ id: 'user-tools-ca', targets: ['pip', 'git'], inputs: {} }]`.
API source paths are absolute; CLI document paths are relative to that document.
Omitted supplied IDs retain their original source partitions and are revalidated.
Use `sources.removeSupplied` to review their removal, or supply the same ID with a
new file to review replacement. The complete managed PEM is rebuilt from those
sources; previous output bytes do not become a source. A lost or edited custody
record can require explicit replacement offered in the review. Conflicting halves
of known output custody block until the reported custody conflict is reconciled.

Native routes and OS-sourced file routes require proven client and policy cells.
They currently report unavailable for these clients. `sources.os: false` selects
the explicit supplied-file fallback. Full prepared-work and run-result 1.2.0
contracts report source changes, client verification and output custody.
Declared Python verification accepts at most 400 reviewed fingerprints, including
bundled roots, to keep its process argument within portable OS limits. A larger
complete set blocks Prepare with `SOURCE_LIMIT`; offline Python checks are skipped.

The bundled `user-tools-ca` repair accepts a complete supplied CA file and any selected combination of `python`, `pip`, `git`, `cargo` and `conda`. Save `{"user-tools-ca":{"caFile":"/absolute/path/company-ca.pem"}}` as `repair-inputs.json`:

```sh
aih repair user-tools-ca --target pip --target git --inputs-file repair-inputs.json --json
aih repair user-tools-ca --target pip --target git --inputs-file repair-inputs.json --apply
# Explicit permission to perform independent work when a selected tool is unavailable:
aih repair user-tools-ca --target pip --target conda --inputs-file repair-inputs.json --apply --allow-partial
```

The API uses `prepare({ useCase: 'repair', repairs: [{ id: 'user-tools-ca', targets: ['pip', 'git'], inputs: { caFile: absolutePemPath } }] })`, followed by the same explicit `apply` authorization as Node/npm. Tool readiness checks run before configuration changes. Cargo HTTP repair preserves the existing Git transport selection and does not require Git CLI. Nothing installs missing tools.

Cargo repair requires the legacy `~/.cargo/config` file to be absent because Cargo prefers it over the selected `config.toml`. Preparation reports this prerequisite and Apply rechecks it before effects. Resolve any legacy configuration explicitly before preparing again. Inherited `CARGO_HTTP_SSL_VERIFY` must be unset, empty or exactly `true`; the behavior probe preserves that environment.

Python sets `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` for future user shell sessions; Windows also persists both user environment values. The Python behavior check confirms the supplied CA identities loaded into its default TLS context and reaches PyPI. pip sets its user `cert`, Git sets user `http.sslCAInfo`, Cargo sets only user `http.cainfo`, and conda sets user `ssl_verify`. The selected recipe declares its exact paths, commands and checks in the review. Canonical user config locations are supported; redirected locations and inherited trust overrides or verification bypasses require correction before preparation.

Vendor transforms retain neighboring settings. Preserved configuration bodies are private inputs and appear redacted in reviews and routine history. Existing unowned or changed files require an exact reviewed replacement resolution, even when their other content will be preserved. Managed trust retains existing certificates and includes baseline roots alongside the supplied CA. Relevant config files, helper bytes and input bytes are bound to the prepared work; changes require another review. Online verification exercises the selected tool and its effective trust configuration. `--offline` reports skipped behavioral verification and incomplete repair. A failed or unavailable prerequisite prevents its dependent configuration changes. `--allow-partial` permits only reviewed independent work and does not authorize a conflict replacement.

Python must be `python` on Windows or `python3` on macOS/Linux. Online pip uses that Python interpreter through `-m pip`; Git and conda require direct executables. Windows online observation remains explicitly unqualified; offline pip retains its direct-executable readiness check. conda also needs its base Python connection module. Git verification refuses an explicit `schannel` backend that does not consume this CA setting. Public endpoint checks do not prove the supplied CA was necessary for, or repaired, a different endpoint's trust failure.

## Repair Gradle and Maven trust

The versioned shared request selects `gradle`, `maven`, or both, with an explicit
reviewed JKS baseline kept separate from supplied CA sources:

```json
{
  "schema": "urn:aihq:core:repair-inputs:1.0.0",
  "route": "file",
  "repairs": { "jvm-ca": { "baselineStore": "reviewed-jdk-baseline.jks" } },
  "sources": {
    "os": false,
    "supplied": [{ "id": "company", "file": "company-ca.pem" }]
  }
}
```

```sh
aih repair jvm-ca --target gradle --target maven --inputs-file trust-inputs.json --json
aih repair jvm-ca --target gradle --target maven --inputs-file trust-inputs.json --apply
```

The API uses the versioned repair request with `inputs: { baselineStore: absoluteBaselineJksPath }`.
Prepare computes the complete PEM and derived JKS before effects and binds their
exact bytes, the selected baseline, configuration snapshots and executables to
the review. Both outputs receive ordinary ownership and protected source custody;
dependent manager configuration waits for its store's committed custody. Refresh
revalidates retained original sources and rebuilds the store, so removed supplied
certificates are removed unless another reviewed source still owns them. Native
and OS-sourced routes currently report unavailable. No JDK or baseline discovery
is implied. The schema-less form below retains its existing behavior.
JVM verification accepts at most 400 distinct reviewed store fingerprints across
the baseline and supplied sources. A larger complete set blocks Prepare with
`SOURCE_LIMIT` before output or configuration effects. Bound path lengths also
count toward the portable verification command limit.

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

Each invocation prepares again. `--yes` requires `--apply`. Interactive review goes to stderr; `--json` emits one structured result on stdout. Noninteractive application without `--yes` rejects. `--no-log` (accepted by `policy`, `repair` and `export-ca`) turns routine history off for both Prepare and Apply, so the result record is `{"status":"disabled","reason":"logging-off"}`; ownership, recovery and approval are unchanged. Exit codes are 0 for successful preview/complete application, 1 for blocked or incomplete work, 2 for invalid/rejected requests, and 130 for cancellation. No write without a supplied check is reported as verified.

An author may use `config.entries` for selected JSON/JSONC or unambiguous TOML keys (scalars and arrays of scalars), `text.block` for exact marked regions, `file.remove` for a managed member, and `process.run` for an explicitly approved executable with separate arguments, a scoped working directory, declared environment inputs, accepted exit codes and effects. The prepared review shows resolved edits and checks, including executable byte hashes, argv, environment, accepted exit codes and bounds; private values are redacted. A recipe's `checks` definitions can include a bounded `file.sha256` observation or an approved `process.exit` invocation; operation `checks` names those definitions. A failed or unavailable required check blocks dependents. A command may leave opaque effects after failure or cancellation; the result reports uncertainty rather than promising rollback.

Recipe and execution-policy **1.2.0** additionally admit `config.entries` with
`format: "ini"`. Each path is exactly `[section, option]`; section names are case
sensitive and option names are case insensitive. Names use ASCII letters, digits,
underscore, dot or hyphen. Set values are nonempty, single-line strings without
surrounding whitespace. The bounded editor preserves bytes outside the selected
option line, including other sections, comments, line endings and unrelated
multiline values. It refuses duplicate sections/options, ambiguous indented
assignments, selected multiline values, BOMs and invalid UTF-8. Removal deletes
only the option line and leaves section headers intact. Fresh review can preserve
unrelated edits; any file change after Prepare still makes Apply stale.

`format: "toml"` selects one key per path; each path segment is a table name or
key, bare or quoted, so `["mcp_servers", "name.with.dots", "command"]` and
`["projects", "/home/u/p", "trust_level"]` address `[mcp_servers."name.with.dots"]`
and `[projects."/home/u/p"]`. Headers and keys may use basic or literal quotes and
whitespace around dots; a segment is compared as its decoded text, so
`["a.b", "c"]` and `["a", "b", "c"]` are different paths. Set values are strings,
finite numbers, booleans, or arrays of those (nested arrays included); a new
string is written as a basic string, arrays on one line as `["a", "b"]`, and new keys
go at the end of their table (a missing table is appended as `[header]`). Existing
values are replaced in place, keeping indentation, spacing and trailing comments;
removal deletes the whole statement, including every line of a multi-line array, but
a comment after the value stays as a line of its own. Removing the last managed key
of a table that Core created also removes that header, and the line break Core added
before it at the end of a file that did not end with one, so setup followed by
removal restores the original bytes. A table that existed before setup, or that holds
a key or comment someone else added (a kept trailing comment included), keeps its
header; tables created before this record existed keep theirs. When that line break
is left in front of another table Core created, the record moves to that table.
Lines a client inserts before a final created header can cost one line break on
removal.
Custody and drift cover the exact value bytes, including whitespace and comments
inside an array. Other content is only scanned, never rewritten: multi-line arrays
and strings, inline tables, dates and other values may appear anywhere in the file.
An existing selected value that is an inline table, a multi-line string, a date or
time, a hexadecimal/octal/binary integer or `inf`/`nan`, and any `null` or object set value,
is refused with `unsupported-toml-value`. Set an `env` table by targeting its keys
(`["mcp_servers", "x", "env", "KEY"]`), which creates or edits `[mcp_servers.x.env]`;
a key inside an inline table, or under an assigned key, is `unsupported-toml-path`.
Array tables (`[[x]]`), dotted keys, duplicate tables or keys (after unquoting) and
malformed syntax are refused. This is a bounded editor, not a full TOML implementation.
TOML entries are available from recipe 1.0.0; arrays and quoted names need no new
schema, because entry values were already any JSON literal. Unrelated values are now
scanned as TOML values, so a value the scanner cannot delimit, which the earlier line
editor tolerated, is `unsupported-toml-syntax`; the scanner delimits values rather
than validating every TOML rule. Inline tables follow TOML 1.0 (one line, no
trailing comma); a multi-line inline table or one with a trailing comma is refused.
Earlier Core versions refuse rather than misread this content: a file with a quoted
header is `unsupported-toml-table` and an owned array is `unsupported-toml-value`.
Unless directory evidence requires 1.5.0 (see Managed lifecycle), the ownership
root is written as 1.4.0 only while it records a table that Core
created for a TOML entry, and as 1.3.0 only while it owns a TOML entry whose path has
a non-bare segment; each returns to its previous version after the last such entry is
removed. An earlier Core fails closed on a 1.3.0 or 1.4.0 root, as it does on a
hook-group 1.1 root: it refuses that root's project and withholds user-scope cleanup
requested from any other project until Core is upgraded or the entry is removed.

`format: "yaml"` and `format: "properties"` select one top-level key per path.
YAML set values are JSON-quoted strings; block/flow values, uncertain quoted
strings, aliases, merge keys, duplicate keys and document markers are refused.
Selected continuations are refused; unrelated simple indented YAML collections
are retained. This is a bounded subset, rather than a complete YAML parser. Properties admit
unescaped equals-separated scalar keys and refuse continued lines or escaped
selected values. Both preserve unrelated lines and comments byte for byte.

These operations produce prepared-work **1.4.0**, whose explicit branches cover
policy, supplied-file repair and shared-source trust review. Use
`validatePreparedWork14` from `@aihq/core/contracts`; validators for older review
versions remain strict. Run results retain their existing policy 1.1.0,
supplied-file repair 1.0.0 or shared-source trust 1.2.0 identities because their
result shapes are unchanged. Unless directory evidence requires 1.5.0, ownership roots use 1.2.0 while they contain INI, YAML or properties
entries, so older Core versions refuse custody they cannot interpret. Removing
the last entry requiring 1.2.0 returns the receipt to its remaining supported format.

Both supplied-file and shared-source repairs own only their selected trust settings:
pip/Git INI options, Cargo TOML entries, conda top-level YAML scalar and Gradle
properties entries. Maven owns its marked trust block; Python retains its marked
profile block. Settings and comments outside those members survive reviewed
removal. Pip no longer appends advisory comments. Convenience removal of a
previous whole-file user-tools or JVM configuration repair receipt returns `reconcile-required`; reapplication does not silently
convert that receipt to entry ownership. Reconcile the earlier receipt and its
configuration manually before using the new recipe. Explicit authored whole-file
operations retain their original whole-file behavior.

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

### Install from an exact git commit

Execution policy 1.4.0 also accepts a referenced recipe from one exact GitHub commit.
Its `source` is Catalog's exact git source identity plus the pinned archive of that
commit:

```json
{ "kind": "git", "repository": "https://github.com/<owner>/<repo>", "commit": "<40 lowercase hex>",
  "reachable": true,
  "archive": { "url": "https://codeload.github.com/<owner>/<repo>/tar.gz/<commit>",
    "sha256": "<64 lowercase hex>", "byteLength": 4096 } }
```

- **Exact identity only.** `commit` is a full 40-character lowercase commit and
  `reachable` is `true`; the archive URL is that commit's own archive at the same
  repository. These GitHub URL rules belong to Core's generic material acquisition:
  they describe the source host's exact commit archive, not a tool vendor. Core resolves nothing: a branch, tag, short or symbolic name and an
  unchecked or unreachable commit are refused. Catalog owns resolving a moving
  reference to an exact commit.
- **Named refusals.** `validatePolicy` and `prepare` report `INPUT_INVALID` at
  `/selections/<n>/recipe/reference/source` with `git-commit-not-exact`,
  `git-commit-not-reachable`, `git-repository-unsupported` (anything but
  `https://github.com/<owner>/<repo>`, including `.git`, tree links, other hosts or
  credentials) or `git-archive-not-exact`. The schema documents the shape; the
  validator is authoritative for these rules. Nothing is fetched for a refused source.
- **Acquisition.** The archive is downloaded once over HTTPS without redirects, within
  the existing bounds (64 MiB compressed, 256 MiB expanded, 4,096 regular members,
  16 MiB per member, 60 s), and must match its pinned length and SHA-256. It must open
  with the pax global header `git archive` writes naming the same commit
  (`git-archive-commit-mismatch` otherwise). The recipe and its complete named material
  closure are then pinned by path, byte length and SHA-256 exactly as for any archive
  (`member-identity-mismatch`, `material-closure-mismatch`, `archive-incomplete`). Bytes are read
  in memory; nothing is extracted or executed, and an executable member the recipe does
  not name is refused (`unreferenced-executable`).
- **Provenance.** The review's `selections[]` (prepared work 1.6.0) and inventory 1.1.0
  selections carry `materialSource: { kind: "git", repository, commit, identity }`,
  where `identity` is `owner/repo@<commit>`. Protected custody records it with the
  selection; a later Apply from another commit or another source replaces it. It is
  absent for inline, local and plain archive sources.
- **Saved intent stays with the caller.** Core returns the identity in the review and
  inventory; it never stores or edits a consumer's saved intent.
- **Other entries.** `aih check-files`/`checkFileState` never fetches a git source and
  reports it `remote-material-not-admitted`. `deriveRecipeIdentity` accepts a git
  reference; the identity depends only on the recipe bytes and material closure.
  Inline recipe materials keep their archive and local sources.

The published fixtures `@aihq/core/fixtures/core/execution-policy/1.4.0/git-source-accept.json`
and `git-source-refuse.json` (a branch name, `INPUT_INVALID`) are declared for execution
policy 1.4.0 in `contractSupport`.

```js
import { apply, listManagedSelections, prepare } from '@aihq/core';

// policy: an execution policy 1.4.0 whose selection references a recipe from an exact commit.
const prepared = await prepare({ useCase: 'policy', policy, target: { project } });
if (prepared.status !== 'ready') throw new Error(JSON.stringify(prepared.diagnostics));
// Show prepared.review, including selections[].materialSource, before Apply.
await apply(prepared.prepared, { approved: true, origin: 'interactive', reviewDigest: prepared.review.reviewDigest });
const { selections } = await listManagedSelections({ target: { project }, scope: 'project',
  format: 'urn:aihq:core:managed-inventory-result:1.1.0' });
// Hand the exact identity back to the caller, which owns any saved intent.
return selections.map(({ managementId, materialSource }) => ({ managementId, source: materialSource?.identity }));
```

## Check file state

`aih check-files` compares a policy's declared file intent with local files without preparing, writing or recording anything: no history, no state or custody records, no network access and no process execution. Inline recipes are used directly; a local recipe or material source is admitted only through its exact `--material-root id=/absolute/path` mapping with the declared byte lengths and SHA-256 pins. Archive sources are never fetched and are reported as unavailable.

```sh
aih check-files policy.json --project /absolute/project --json
aih check-files policy.json --material-root team=/absolute/materials --private-input guidance.text=ENV_NAME --budget-ms 30000 --json
```

The API exposes the same serializable result:

```js
import { checkFileState } from '@aihq/core';

const result = await checkFileState({ policy, target: { project: absoluteProjectPath } });
```

Stored results can be checked without observing the filesystem:

```js
import { validateFileStateResult } from '@aihq/core/contracts';

const checked = validateFileStateResult(storedResult);
// { valid, schema?, diagnostics }
```

`validateFileStateResult(value: unknown): ValidationResult` accepts strict JSON
data satisfying the existing file-state-result **1.1.0** schema. It performs no
filesystem, process, network or state effects and leaves the input unchanged.
Other schema IDs (including 1.0.0) return `SCHEMA_UNSUPPORTED` with reason
`schema-unsupported`, `/schema`, and the encountered/supported IDs. Undeclared
fields return `INPUT_INVALID`, reason `unknown-field`, and the escaped JSON-pointer
path. Invalid observations and incomplete/cancelled results are valid documents
when they satisfy that schema; validation never establishes a current file match,
custody, execution permission or native loading.

The existing `@aihq/core/fixtures/core/file-state-result/1.1.0/accept.json` and
`refuse.json` exports exercise both reader outcomes. Native result fixtures at
`@aihq/core/fixtures/core/native-verification-result/1.0.0/accept.json` and
`refuse.json` exercise `validateNativeVerificationResult`; the accept fixture is
synthetic verified-result data, not evidence of real client sessions. Both pairs
are referenced by `contractSupport` for public-reader conformance checks.

Each distinct target is captured once and compared with the final content folded in memory from all its contributing operations, across selections in dependency order; `operationIds` lists every contributing operation and `selectionIds` names the selection of each, index-aligned with `operationIds`; a target shared by several selections lists each selection once per contributing operation. A result is `urn:aihq:core:file-state-result:1.1.0`; it differs from 1.0.0 only by the required `selectionIds`. `file.sha256` checks compare the live file itself. `fileState` aggregates the comparison: `changed` wins whenever any target differs, is absent where content is desired or present where absence is desired, or a digest check fails; `match` requires at least one compared target or check, no unavailable target or check and no unread recipe; `unverified` covers everything else, including a policy with no file operations. `status` reports completion of the observation, never application: `complete` only when at least one item was compared and nothing was unavailable or not checked, otherwise `incomplete` (or `invalid`/`cancelled`), so matching files beside an opaque process are `incomplete` with `fileState: match`.

Unavailable rows carry a stable `reason`. A file operation that depends on a process operation, directly or through other operations, an earlier operation on the same target or a required selection, is unavailable (`process-dependency-not-checked`); because custody is not read, an earlier operation on the same target always counts, even where Prepare would report it as a conflict. One that depends on a recipe that could not be read inherits that recipe's reason. A target path needing an omitted private input is reported as its own row with `target: null`. `notChecked` lists process operations, recipes that could not be read (for example `remote-material-not-admitted`), executable prerequisites, managed sets, removals and evidence; process checks appear in `checks` as `not-checked`; `coverage` counts each class. The default budget is 60,000 ms (`--budget-ms`/`budgetMs`, 1–60,000) and also bounds local material reads. A live target or folded result over 16 MiB, or a single material declaration larger than 512 MiB, is unavailable (`limit-exceeded`); targets beyond 4,096 distinct paths are unavailable without being read; once captured material plus target bytes would pass 512 MiB, all remaining work is unavailable. Cancellation keeps completed rows and takes precedence over budget exhaustion: items stopped by the budget keep `budget-exhausted`, and every item still unfinished when cancellation is seen is `cancelled`. Validation of the request, its inline recipes (inputs, authored paths, process working directories and slots) and every material descriptor precedes cancellation; a referenced recipe can only be validated after its pinned local capture. An unsafe target path in any operation or `file.sha256` check is invalid, even when no operation references the check; as in Prepare, process working directories and slots are validated for operations and for process checks that an operation references. A `file.sha256` check that no operation references and whose path needs an unset optional input is unavailable (`input-unavailable`), whereas a referenced one, like an operation, is invalid as in Prepare. Diagnostic `path` pointers are relative to the request (`/policy/...`), except those from validating a referenced recipe, which are relative to that recipe document. Exit codes are 0 only for a complete match, 1 for any other non-invalid/non-cancelled result, 2 for an invalid request and 130 for cancellation. `--json` emits exactly the result object (`urn:aihq:core:file-state-result:1.1.0`).

A `match` is a local content comparison only. It is not custody or adoption (matching unowned files stay unowned), not proof that any command ran, and not enterprise authorization — `authority` is always `not-evaluated`. The result cannot be passed to `apply` and is not run evidence. Results never contain file contents, digests, absolute paths or private input values; reported paths are root-relative with private values redacted.

## Inputs and outcomes

Inputs are scalar strings, booleans, finite numbers or safe integers with optional bounds/defaults/enums. There is no coercion or recursive interpolation. Unknown configuration names reject. A string slot is exactly `{ "literal": "text" }` or `{ "input": "declaredName" }`.

Sensitive inputs declare `sensitive: true`, omit the portable value/default, and arrive through `prepare` controls: `{ privateInputs: { selectionId: { inputName: value } } }`. The CLI maps an existing environment value with `--private-input selection.input=ENV_NAME`. They are redacted in reviews and omitted from routine history. Keep returned handles private to your host; authenticating your UI's requests is your application's responsibility.

Reported operation and input IDs use `selectionId/localId`; `/` cannot occur in an authored ID. For CLI private-input mappings, percent-encode a dot inside either component as `%2E`, preserving the one literal separator dot: `team%2Eguidance.text%2Econtent=ENV_NAME`.

`apply` requires `approved: true`, `origin` and the review's `reviewDigest`. `allowPartial` defaults to false and its default/explicit origin is recorded. Cancellation is supplied as `controls.signal` or SIGINT. Results distinguish `applied`, `already-satisfied`, `failed`, and `not-attempted`; verification independently records passed, failed, unavailable or unverified checks.

Target paths are explicitly scoped and reject traversal, links, unsafe host filenames and Core's reserved state paths. Existing matching unowned bytes remain unowned. This is guarded local file handling, not a sandbox against arbitrary concurrently privileged software.

## Name Catalog items in a policy and its review

Execution policy `urn:aihq:core:execution-policy:1.4.0` keeps every 1.3.0 field:
`selections[].recipe` (inline, or a reference to a recipe such as one rendered by
[`renderDelivery`](#render-catalog-items-and-check-compatibility)), `managementId`,
selection-id `requires`, `managedSelections` (omitted keeps earlier members; a set
with `members: []` reconciles them), scoped `removals` and `evidence`, and admits
the same recipe formats plus [recipe 1.4.0](#allow-one-mcp-server). It adds:

- **Descriptive selection metadata,** given all together or not at all:

  ```ts
  { item: { framework, itemId, contentSha256, behaviourSha256 }, tool, name, kind,
    origins: ( { reasonIncluded: 'chosen' }
             | { reasonIncluded: 'in-set', set: { framework, setId, setSha256 }, options? }
             | { reasonIncluded: 'required-by', requiredBy: { framework?, itemId } } )[] }
  ```

  `origins` is Catalog's qualified inclusion identity, carried unchanged: one entry
  per simultaneous inclusion, so overlapping sets keep every origin (`duplicate-origin`
  for a repeated entry). `tool` is a [registry](#ai-tool-registry) id (`unknown-tool`)
  and `kind` a binding kind. Metadata never adds operations, inputs or authority:
  Enterprise admission still governs the recipe by identity, scope, inputs and lifecycle.
- **`excludedItems: { framework, itemId }[]`** at the policy level. A selection whose
  `item` has an excluded framework and item id is invalid (`excluded-item-selected`),
  whatever its content identities and origin, so a set, dependency or fallback never
  adds it again.
- **One selection per management id.** Two selections with the same `managementId`
  are invalid (`duplicate-management-id`) even in different scopes. Older policies
  keep their per-scope rule and remain valid, with their earlier review formats.

`grantApproval` is a `renderDelivery` input, not metadata: an approval is reviewed
only through the operations it adds to the rendered recipe.

A 1.4.0 policy prepares `urn:aihq:core:prepared-work:1.6.0`. Every operation carries
its `selectionId` (`null` for generated lifecycle cleanup), and `selections[]` holds
one entry per policy selection, in policy order:

```ts
{ selectionId, managementId, scope,
  item?, tool?, name?, kind?, origins?,          // the selection's metadata, unchanged
  hookCommands?: string[],                       // each hook group's hooks[].command, verbatim
  permissionStep?: string,                       // "Still needs your OK in <tool>. <step>" from the shipped binding;
                                                 // omitted when the recipe writes that tool's approval itself
  inputs: string[],                              // bound input names; never values
  deliveredSize?: { bytes, chars, alwaysLoaded?: { bytes, chars } } }
```

Sizes are measured from the bytes this preparation delivers (written files and
marker-block text) in UTF-8 bytes and UTF-16 characters, as Catalog counts them.
`alwaysLoaded` applies `checkCompatibility`'s kind rules to the delivered bytes: the
frontmatter `name` and `description` of skills, agents and commands (read from the
delivered Markdown, so it can differ from Catalog's measured parts), the whole text
of a rule delivered as an entry-file block, and nothing for hooks, MCP servers and
documents. It is omitted without a `kind` and for a rule written as a file, whose
inclusion the rendered recipe does not carry; `deliveredSize` is omitted when the
selection's material was unavailable. Input values travel only in `controls.privateInputs` under the
existing private-input binding; reviews, run results and history name inputs only.

The review digest stays nonce-bound and opaque: preparing the same policy twice
gives identical reviews with different `reviewDigest` values. Do not recompute it.

`apply` for a 1.6.0 review returns `urn:aihq:core:run-result:1.4.0`. Every existing
Apply guard still runs. A refusal because a reviewed binding changed is
`REVIEW_STALE` with reason `binding-changed` and `changed`:

| `changed` | The existing Apply checks it covers |
| --- | --- |
| `policy` | The request or policy digest; for Enterprise, the organization revision, blob, content and declared target |
| `recipe` | Recipe identity, binding digest and material captures |
| `target-file` | Per-step live bytes against their `before` state, and path pins |
| `ownership` | Ownership inventory and per-root receipt digests |
| `input` | The private-input digest |
| `host` | Home directory and path identity |
| `trust` | Trust participants, and trust or session custody now claiming a reviewed path |

A lost or consumed handle is `REVIEW_STALE` with reason `handle-unavailable`, and
an authorization naming another digest has reason `digest-mismatch`; neither is a
binding change. Prepare again and approve the new review. New or changed scan
evidence and Catalog index status are never part of a held review, so they never
make it stale; Core does not read index status, and the consumer surfaces an index
revocation when it next prepares.

### Post-apply member checks

After Apply, run result 1.4.0 lists in `members[]` every member a reviewed file
operation touched, checked directly on disk: a file by digest or absence, a text
block by its markers, a configuration entry by pointer and value digest, and an owned
hook group by its selector. Each entry names the `operationId`, `selectionId` (`null`
for generated cleanup), `managementId`, `scope`, member `kind`, its file `path` and,
where it applies, the entry `pointer` (RFC 6901), `blockId` or hook `groupId`:

| Field | Values |
| --- | --- |
| `intent` | What the reviewed plan meant: `write` the member, `remove` it (or restore the value it replaced), or `keep` it for another claim |
| `outcome` | What the run did: `written`, `claim-removed`, `restored` (the person's earlier value written back) or `kept` (not changed by this run, including work it never attempted) |
| `check` | What Core then found: `present-matching`, `present-different`, `absent` or `unchecked` (not attempted, or unreadable) |

A member is compared with its state after the step when the step succeeded, or before
it otherwise. No digest, earlier value or input value is reported; a private input value
inside a path is shown as `[REDACTED]`, also in later cleanup runs, which use the
redaction recorded at install. A run touching more members than the schema's
65,536 omits `members` and reports `SOURCE_LIMIT` reason `member-check-limit`, so it
supports no member claim. The portable
`runMemberClaims(result)` from `@aihq/core/contracts` applies the
[claim rules](#what-each-result-status-lets-you-claim): `confirmedOnDisk` and `removed`.

## Allow one MCP server

Recipe `urn:aihq:core:recipe:1.4.0` keeps every 1.3.0 operation and adds two things,
admitted by execution policy 1.4.0. Each recipe 1.4.0 operation kind is in
`recipeOperationKinds`.

- **`config.member`** adds or removes one scalar member of a JSON or JSONC array:

  ```ts
  { id, purpose, kind: 'config.member', scope, target, format: 'json' | 'jsonc',
    container: string[], action: 'add' | 'remove', value: { literal: string | boolean | number },
    exclusiveWith?: string[][], approval?: { tool }, requires, checks }
  ```

  The member is identified by its value. Every other member, comment and line keeps
  its text, so adding a member and removing it again gives back the earlier bytes;
  an array Core created is removed with the last member Core added to it. Adding a
  value already present changes nothing. A container that is not an array
  (`member-container-invalid`), two equal members (`member-ambiguous`) or the value
  found in an `exclusiveWith` array (`member-excluded`) is a `STATE_CONFLICT`. Custody
  is per member: two operations owning different members of one array never
  conflict, and removal takes only the owned member. Inputs and object values are
  refused by the schema, and so is anything other than one member.
- **`approval: { tool }`** on a one-entry JSON or JSONC `config.entries` set, or on a
  `config.member` add, marks the edit as the person's OK for one MCP server in that
  tool (`approval-entry`, `approval-member` otherwise). A recipe holds at most one
  approval (`approval-one-server`), and it must require a `config.entries`
  operation of the same recipe that registers that server, the entry's last key or
  the member's value naming it (`approval-server-unregistered`). So a recipe can
  never mark a global switch, such as an approve-all setting, as an approval.

Core applies an approval only where no choice was made yet:

- **Already approved.** The same value already there is `already-satisfied` and
  `unowned`; it is never adopted, so removal leaves the person's approval alone.
- **Denied.** A different value at the server's key, or the server in an
  `exclusiveWith` list, is a `STATE_CONFLICT` with reason `approval-denied`. It is
  never overwritten: a reviewed `replace` or `adopt` resolution on an approval is
  `resolution-invalid`. Change the choice in the tool itself.
- **Granted.** Otherwise the one value is written. The review operation's details
  carry `approval: { tool }` and, for a member, `member: { container, action, value }`.
  Custody records a `config-entry` or `config-member` member and an
  `approval-change { tool, file, pointer }`, and inventory 1.1.0 reports
  `approval: 'granted-by-aih'`. The selection's review entry no longer says the
  server still needs your OK; neither does it for an already approved server,
  while a denied one still does. Without an approval operation Prepare does not
  read the approval location, so an unticked server keeps the notice even when
  inventory later reads `not-needed` for it.
- **Removed.** Removing the server removes only the approval Core wrote, which
  restores the location's earlier state (Core never replaces an earlier value, so
  there is none to write back). When the person has since changed that approval,
  removal keeps their edit: the review reports the member as a `STATE_CONFLICT`
  (`managed-content-changed`) and the run result as `kept`; removal preparation
  1.2.0 lists it as `keep-changed` instead. A file Core created only to hold the
  location stays behind as an empty object.

Only the approval file Core writes is read: an approval or denial the tool records
elsewhere (for example in the user's own state) is not seen.

## Managed lifecycle

`managementId` remains stable when run-local selection/operation IDs or recipe bytes change. Core records custody separately for files, exact JSON/JSONC/TOML/INI/YAML/properties entries and marked blocks. Unrelated settings, comments and text outside those members survive updates and cleanup. Changed managed bytes require an exact reviewed replacement; matching unowned bytes remain satisfied and unowned until explicit reviewed adoption. A shared member cannot change while another owner retains it.

A policy can name complete desired sets:

```json
"managedSelections": [{"id":"team-tools","scope":"project","members":["team-guidance"]}]
```

Members are stable management IDs of the policy's selections. Omitting a set requests no cleanup. Explicitly supplying `"members": []` proposes subtraction of that set's prior managed members. `"selections": []` supports cleanup-only policies and deliberate no-op application. Unmentioned sets and members needed by retained dependencies remain. Selection intent records dependencies and set membership separately from byte custody, including selections with only matching unowned content or approved processes. User custody follows the actual home, including Core-assigned `userState` children; roots in other projects can retain shared user dependencies.

For selected removal use `"removals": [{"managementId":"team-guidance","scope":"project"}]`. References select existing custody; they cannot authorize deletion of unowned content. Updating a selected recipe also reviews subtraction of its obsolete owned members. Review conflicts, removals and recovery information before Apply. Directory descendants are never recursively removed. When setup actually creates a
missing parent directory, protected custody records that directory's identity.
A file-removal review lists those parents in `details.declaredEffects` as
conditional empty-directory cleanup. After successful reviewed file removal, Apply
removes matching, empty created parents from deepest to shallowest, within the same
scope. Pre-existing directories, replacement directories, links, directories with
foreign content or retained managed members, and directories without creation
evidence are preserved. Older file custody never implies directory ownership.
Interrupted work keeps conservative custody; prepare again before further changes.

### Interrupted installs

Apply writes a pending receipt into protected custody immediately before its first
effect (a file or a process): every selection the run writes custody for is recorded
as an interrupted install, with no member yet. Each member is added to custody only once
it is written. Before each file effect changes its destination, Apply also writes ahead,
in protected custody, the members that effect changes and the identity (device and
inode) of the staged file that will replace the destination; the custody published
after the effect replaces that record. An Apply refused before any effect writes no
receipt.

If the run stops, fails or its process is killed, the install stays interrupted, also
after a restart. Inventory 1.1.0 lists it with `installState: 'interrupted'` and the
members written so far, even when that is none; members the run only intended to write
are never listed. When a process was killed between a file effect and its custody,
reads settle that one effect from the target itself: a member counts as written only
when it is still the very file the effect published, with exactly the bytes it wrote (or
gone, for a removal). Anything else, including a later copy of the same bytes, was not
written by Core and is never claimed. The next Apply on that target records the result. An interrupted install is never "confirmed on disk": its run is not
`complete`, so `runMemberClaims` reports `confirmedOnDisk: false` even when every written
member matches.

Finish or remove it through the ordinary reviewed path, with a fresh review:

- **Finish.** Prepare the same selection again (same management ID and scope). Members
  already written are owned and `already-satisfied`, the rest are reviewed as usual, and
  the review notes `finish-interrupted-install:<managementId>`. A member the person
  changed since is an `existing-content` conflict and is never overwritten. When the run
  completes, inventory reports `installState: 'complete'`.
- **Remove.** `prepareManagedRemoval` (either form) treats an interrupted install as a
  claim, also one that wrote nothing, and its review notes
  `remove-interrupted-install:<managementId>`. Written members are removed as usual;
  changed ones are kept (`keep-changed`, with licence and notice files `keep-required` in
  removal preparation 1.2.0), and the install then stays listed as interrupted with what
  is kept. Every existing safeguard, including Enterprise's refusal of a custody-only
  removal, still applies.

An earlier review is never reused: a consumed or lost handle is `REVIEW_STALE`
(`handle-unavailable`). A selection described without item facts records its pending
receipt in ownership 1.6.0 while interrupted and returns to its earlier receipt format
once complete.

A killed process also leaves its target lock behind. Each lock names its holder's
process and host; the next Apply reclaims a lock only when that holder is on this host
and no longer running, re-checking it while it alone holds an exclusive reclaim guard. A
lock without a readable holder, from another host, held by a running process, or met
while another process is reclaiming it is kept, and that Apply does not run. Reclaiming
assumes one process namespace per host name.

Ownership roots that record what a person chose use **1.6.0**. This versioned
migration adds, per claim, the item's name, kind, framework, both identities, tool and
every qualified origin; typed members (`file { path, sha256, executable }`,
`text-block { file, blockId, sha256 }`, `entry-block { file, marker, sha256 }` and
`entry-pointer { file, marker, sha256 }` for the shared Project basics blocks,
`config-entry { file, pointer, sha256 }`,
`config-member { file, pointer, value-sha256 }`, `hook-group-member { file, selector, sha256 }`
and `approval-change { tool, file, pointer }`); and protected `preExisting` restoration
data. Shared blocks also record the exact guidance text they wrote, so an update can tell a
person's own lines inside the block from Core's text. Target-keyed claims, dependency edges, sets, hook-group selectors, markers, modes,
created tables and directory records stay exactly as they were and remain
authoritative: typed members are re-derived from them on every write, and a root
whose typed members disagree with them is refused. Older roots are read through the
migration (an undescribed claim has `name: null`) and are rewritten as 1.6.0 only when
an Apply records item facts, for example by preparing the same selections under
execution policy 1.4.0 with their metadata. When a reviewed `replace` overwrites a
person's JSON or JSONC value, that value is kept in protected custody and written back
when the last claim on the entry is removed, provided Core's value is still there
unchanged; a value the person has since deleted stays deleted. Other replaced content
(whole files, marker blocks, TOML, INI, YAML and properties entries) records no earlier
value and is removed as before. Earlier Core versions refuse 1.6.0 roots.

Ownership roots carrying directory evidence use **1.5.0**. Earlier Core versions
refuse these roots rather than ignore the evidence, including user-scope cleanup
when another project's receipt cannot be read. After the last directory record is
removed, the root returns to the format required by its remaining members. Existing
Prepare/Apply, managed-removal and authored recipe formats are unchanged.

`listManagedSelections({ target: { project }, scope: 'project' | 'user' | 'both' }, { signal?, budgetMs? })` reads the current user's protected custody without creating state or inspecting target bytes. Its `complete` result lists stable management IDs, scope, claim versus legacy reconciliation, and member and shared-member counts. Project scope uses the exact resolved project; user scope also covers Core-managed content roots. A corrupt or unverifiable relevant receipt makes the result `incomplete`, so a partial list must not be treated as all custody. The default budget is 30 seconds (1–120,000 ms); receipt count, bytes and output are bounded. `aih managed list [--project <path>] [--scope project|user|both] [--budget-ms <1..120000>] [--json]` defaults to the current directory and both scopes. The public result schema is `@aihq/core/schemas/managed-inventory-result/1.0.0.json`.

Pass `format: 'urn:aihq:core:managed-inventory-result:1.1.0'` for inventory 1.1.0, a
redacted projection of the same custody with the same scope, bounds and `incomplete`
outcomes. It works from receipts alone, without the Catalog, including for an item
whose framework is no longer offered. Each selection adds:

- `name`, `kind`, `framework`, `item` (both identities) and `tool`, or `null` for a claim recorded without them;
- `origins[]`, every qualified inclusion (`chosen`; `in-set` with framework, set id and set digest; `required-by`), so a restart can rebuild the exact selection;
- `members[]`, each member's `kind`, `path` (with `pointer` — for a `config-member`, the array's pointer —, `blockId` or `groupId`) and `fileState`: `matches`, `changed`, `missing` or `unchecked`, and for marker blocks `block-changed` or `block-missing`;
- `updateState` from the consumer's optional `index: { offered, revoked?, superseded? }`: `revoked`, `superseded`, then `current` or `update-available` against the offered identities, `no-longer-offered` when the index does not offer the item, and `unknown` without an index or recorded identity;
- `policyState`, only when Enterprise passes `organization: { document, setMembers? }`: the obligation admitting the recorded recipe identity and scope, together with any organization 1.2.0 content entry matching the recorded item (`required`, `recommended`, `permitted` or `prohibited`), `not-admitted`, or `unknown` when an entry's client or repository selector cannot be evaluated here, the recorded item lacks a fact a content selector needs, or a set selector has no supplied members;
- `approval`: `granted-by-aih` while Core holds an approval it wrote ("Allowed by AIH in the tool; removed with the server"), `needed` when the tool's binding names a permission step the person has not yet taken, `not-needed` when it names none or the person already allowed the server there, or `null` without a recorded tool and kind. An approval the person made themselves is never Core's;
- `installState`: `interrupted` from just before an Apply's first effect for the selection until all its reviewed operations succeed, otherwise `complete`; `members` then lists only what was actually written. See [interrupted installs](#interrupted-installs).

Inventory 1.1.0 reads the target files of listed members (16 MiB per file, 64 MiB in
total, reported in `limits.checkedBytes`); members beyond that budget are `unchecked`
and the result is `incomplete`. It never exposes a member digest, a `preExisting` or
approval value, or a private-input hash. A server the person already allowed at the
binding's approval location reads `approval: 'not-needed'`; the location is read
within the same check budget, and an unreadable one leaves it `needed`. When a private input value formed part of a
member's path, Apply records the redacted path in protected custody and the inventory
publishes only that (`[REDACTED]` in place of the value); custody written before this
version carries no such record. The schema is
`@aihq/core/schemas/managed-inventory-result/1.1.0.json`.

`prepareManagedRemoval({ target: { project }, managementId, scope, mode, organizationSource? }, controls?)` checks live custody and, for an eligible claim, delegates a cleanup-only policy 1.1 Prepare to the existing engine. `mode: 'vibe'` is local maintenance; `mode: 'enterprise'` requires an independently selected organization source and its lifecycle removal grant. The wrapper distinguishes `prepared`, `absent`, `retained`, `reconcile-required`, `unavailable`, `invalid` and `cancelled`. Only `prepared` carries an inner policy result, which has an opaque handle for the existing `apply` when the inner Prepare supplies a reviewable handle. A claimless legacy member needs reapplication of its original recipe or manual reconciliation; an Enterprise zero-member claim is refused until its admission gate supports metadata-only removal. Preflight-only dispositions write no routine history.

When relevant custody contains INI, YAML or properties entries, the convenience helper uses policy
1.2.0 and returns managed-removal-preparation 1.1.0 with prepared-work 1.4.0.
Other removals retain the previous identities. All four new schema files are
exported under their versioned `@aihq/core/schemas/...` paths.

### Removal preparation 1.2.0

Pass `removals` instead of `managementId` to remove several selections, or one
recorded inclusion of a selection, in one reviewed step:

```ts
prepareManagedRemoval({ target: { project }, scope: 'project' | 'user', mode?: 'vibe' | 'enterprise', organizationSource?,
  removals: { managementId, origin?: { set: { framework, setId, setSha256 } } | { reasonIncluded: 'chosen' } }[] }, controls?)
```

`mode` defaults to `vibe`. The result is `urn:aihq:core:managed-removal-preparation:1.2.0`.
Every requested removal gets its own entry, in request order, with the dispositions of
the single-id call: `prepared`, `absent`, `retained`, `reconcile-required` or
`unavailable`, each with its diagnostics. Their safeguards are unchanged: claimless
legacy custody is `reconcile-required` (`legacy-reconcile`), unverifiable or
ambiguous custody `unavailable`, and in Enterprise a change only to custody is
`unavailable` (`AUTHORITY_DENIED`, `metadata-only-removal`), including removing an
origin. Trust and session custody keep the single-id call (`single-removal-required`).
Retention is computed over all whole removals together, so a dependant removed with its
dependency frees both. The whole request is `invalid` when it is malformed, or when it
names a selection twice in the same form or both whole and by origin (`removal-conflict`);
it is then refused without reading custody, as is a cancelled one.

- **By origin.** An `origin` names one recorded inclusion exactly as inventory 1.1.0
  reports it: the full set identity (framework, set id and set digest; a set id with
  another digest never matches) or `chosen`. A `required-by` origin is not removable
  on its own. While another origin remains, only that inclusion is removed
  (`change: 'remove-origin'`): the selection, its claims and every member stay, listed
  as `keep-shared` (`another-origin`), and the recorded origins lose that one. Removing
  the last origin removes the selection (`change: 'remove-selection'`). An inclusion
  that is not recorded is `absent` (`origin-absent`); a selection that recorded no
  origins is `reconcile-required` (`origin-unrecorded`) and can be removed whole.
- **One review.** All prepared removals share one cleanup-only preparation (execution
  policy 1.4.0, prepared work 1.6.0) and its `reviewDigest`, which the result repeats.
  Each entry lists every member it touches before Apply: `kind`, `path` (private
  path values stay redacted), `pointer`, `blockId` or `groupId`, `approval: { tool }` for
  an approval Core wrote, the review `operationId` (or `null`) and one `action`:

  | `action` | Meaning | `reason` |
  | --- | --- | --- |
  | `remove` | Core removes its bytes. | none |
  | `restore` | Core writes back the person's earlier value it replaced. | `pre-existing-value` |
  | `unregister` | The member is already gone; only Core's claim is released. | `already-absent` |
  | `keep-shared` | Another selection or origin still owns it; only this claim or inclusion goes. | `another-selection`, `another-origin` |
  | `keep-changed` | The person changed it; it stays, with Core's claim. | `managed-content-changed` or the hook-group reason |
  | `keep-required` | A licence or notice file of an item that keeps a changed member. | `licence-or-notice` |

  Kept members are reviewed actions, not conflicts, so a review that only keeps
  changed members is `ready`. When any member of a selection is kept as changed, that
  selection's licence and notice files are kept as required, so a partly removed item
  never stands without them. Catalog carries no material role for them, so the file
  name decides: `LICENSE`, `LICENCE`, `LICENSES`, `UNLICENSE`, `COPYING`, `COPYRIGHT`,
  `NOTICE`, `NOTICES` or `THIRD_PARTY_NOTICES` (any case, `-`/`_` separators), with an
  optional text extension (`.txt`, `.md`, ...) or SPDX-like suffix (`LICENSE-MIT`,
  `LICENSE.Apache-2.0`); a source file such as `license-check.js` never matches.
  Setup-created directories emptied by a file removal are not members: the review lists
  them in that operation's `details.declaredEffects`. Kept members stay in custody with the item, and inventory
  1.1.0 keeps listing it. The single-id call and policy `removals` still report a
  changed member as a `STATE_CONFLICT`.
- **Removed.** Apply the preparation with the ordinary `apply`; its run result 1.4.0
  carries the member checks. `removalClaims(preparation, runResult)` from
  `@aihq/core/contracts` gives each requested removal a claim. Only the run that applied
  this review counts: run result 1.4.0 names it in `authorization.reviewDigest`, which
  must equal the preparation's `reviewDigest` (cleanup operation ids repeat across
  reviews). Then the claim is `removed` only when the run is `complete` and every `remove` and `unregister` member is `claim-removed` and
  `absent` and every `restore` member `restored` and `present-matching`, with nothing
  kept as changed or required; `partly-removed` when those hold but members are kept as
  changed or required; `inclusion-removed` for a completed origin removal; otherwise
  `not-confirmed`. Intended operations alone never support a claim.

When the inner preparation stops before a review (for example an Enterprise authority
denial), entries are still `prepared` as in the single-id call, list no members and carry
the preparation's diagnostics; there is no `reviewDigest` and nothing to Apply. The JSON
projection omits the live Apply handle in `preparation.prepared`. The CLI keeps the
single-id form.

`aih managed remove <managementId> --scope project|user --mode vibe|enterprise [--project <path>] [--org-repository <owner/repo> --org-path <path> --org-ref <branch:name|tag:name|commit:sha> [--org-token-env <NAME>]] [--apply --yes] [--allow-partial] [--no-log] [--json]` previews by default and requires the same explicit review approval as `aih policy`. Its JSON projection omits the live handle and validates against `@aihq/core/schemas/managed-removal-preparation/1.0.0.json`.

**Review operation IDs.** An authored policy operation's review `id` is `<selectionId>/<operationId>`: the policy selection `id` and the recipe operation `id`, joined by one `/`. Neither part can contain `/`. Recipe checks use the same form with the check `id`, and prerequisite observations use `<selectionId>/prerequisite-<index>`. Observations of a generated management-root removal use `lifecycle/root-<n>`. Generated lifecycle cleanup uses `lifecycle/remove-<n>`, skipping any number an authored operation already uses; a selection may itself be called `lifecycle`, so do not recover the selection by splitting an ID. Policy Prepare also returns `operationSelections` beside the review: one `{id, selectionId, operationId}` per review operation, in review operation order, with `selectionId` and `operationId` `null` for generated cleanup (empty for an invalid or cancelled Prepare; absent for repair). It is not part of the review or its digest, so every prepared-work format is unchanged, and `prepareManagedRemoval` omits it from its embedded preparation.

Policy Prepare adds `resolutionInputs` outside the immutable prepared-work review: each actionable authored conflict names its selection and operation, exact observed SHA-256 (or `null`), and locally meaningful `replace`/`adopt` choices. Use a fresh Prepare after resolving an earlier conflict on the same target; the later digest may change. Generated lifecycle cleanup has no keyed replacement hint. The review digest and stale-resolution checks still control Apply.

Byte custody is published after the corresponding successful mutation. Set/dependency metadata advances only after the selection's reviewed operations and checks succeed. Failed or interrupted work preserves completed effects and conservative custody; prepare and authorize a fresh review before further changes. Recovery manifests are inspection material and cannot replay work.

### Update with an explicit replacement

`prepareUpdate` previews updating installed selections to replacements the consumer
chose. Core never looks for, chooses or applies an update by itself: the consumer
supplies each exact replacement, an execution policy 1.4.0 selection such as one
rendered by `renderDelivery` from a newer Catalog item, and applies the reviewed
result with the ordinary `apply`.

```ts
prepareUpdate({ target: { project }, scope: 'project' | 'user',
  updates: { managementId, replacement: <execution policy 1.4.0 selection> }[] }, controls?)
```

The result is `urn:aihq:core:managed-update-preparation:1.0.0`. Each replacement keeps
the `managementId` and `scope` of the selection it updates (`management-id-changed`,
`scope-changed`), and names each management id and selection id once (`update-conflict`);
otherwise the whole request is `invalid` without reading custody. `controls` take
`signal`, `logging`, `materialRoots` and `privateInputs` (keyed by the replacement's
selection id) for the replacement's material and inputs; the request accepts no
`resolutions`, organization source or evidence. Every requested update gets an entry, in
request order:

- `prepared`: Core holds a claim for that id in that scope. The entry names the
  replacement's `selectionId`, `from` (the facts recorded at install, as inventory 1.1.0
  reports them, or `null`) and `to` (the replacement's facts from the review, with its
  own qualified origins, or `null` without metadata).
- `absent` (`not-managed`): nothing to update; install it with an ordinary policy Prepare.
- `reconcile-required`: claimless legacy custody (`legacy-reconcile`) or a repair-owned
  configuration file (`repair-custody-reconcile`), as for removal.
- `unavailable`: ambiguous legacy scope, or trust and session custody (`special-custody`),
  which change only through their own repair and removal.
- `invalid`: the replacement names another item or tool than the one recorded
  (`replacement-item-changed`; a different item needs its own management id), or carries no
  item metadata although an item was recorded at install (`replacement-unnamed`).

All prepared updates share one policy preparation (execution policy 1.4.0, prepared
work 1.6.0) and its `reviewDigest`, which the result repeats; nothing else is selected,
so every other installed selection stays as it is. A replacement's `requires` can name only
other replacements in the request; each updated claim also keeps the dependency edges
recorded at install, so a dependency the replacement does not name is still retained. When
no update is prepared the result is `not-prepared` without a preparation. When the
replacements themselves are invalid (for example a `requires` naming a selection outside
the request), the result is still `prepared` and so is each entry, but the preparation is
`invalid` with no review, no `reviewDigest`, no members and nothing to Apply; each entry
carries the preparation's diagnostics. As for removal, only a preparation whose `status` is
`ready` or `partial` can be applied. Each prepared entry lists every member the review
touches: `kind`, `path` (private path values stay redacted), `pointer`, `blockId` or
`groupId`, `approval: { tool }` for an approval, the review `operationId` and one `action`:

| `action` | Meaning | `reason` |
| --- | --- | --- |
| `add` | The replacement delivers a new member. | none |
| `replace` | Core rewrites its own unchanged bytes with the replacement's. | none |
| `unchanged` | The member already has the replacement's bytes. | none |
| `remove` | The replacement no longer delivers a member Core owns; Core removes it. | none |
| `restore` | Core writes back the person's earlier value it had replaced. | `pre-existing-value` |
| `unregister` | A member the replacement drops is already gone; only Core's claim goes. | `already-absent` |
| `keep-shared` | Another selection still owns a member the replacement drops. | `another-selection` |
| `conflict` | Left exactly as it is. | `managed-content-changed` (the person edited a member Core installed), `existing-content`, `shared-member`, `overlapping-member`, `approval-denied`, a hook-group reason, an unavailable prerequisite, or `depends-on-conflict` |

A local edit is always a conflict: the review never overwrites it and offers no `replace`
resolution for it (the embedded preparation omits `resolutionInputs` and
`operationSelections`). A preparation with a conflict is `partial` and Apply needs explicit
`allowPartial`. Removal of members the replacement no longer delivers waits for every
operation of the selection, so while any member conflicts those removals are `conflict`
with `depends-on-conflict` and stay; such a run is `incomplete`. Its custody already
records the replacement's identities with the members it wrote: inventory 1.1.0 then
reports the edited member `changed` and still lists the held one. Resolve the edit, then
prepare the update again. An update with no conflict that completes supports "confirmed on
disk" from its run result 1.4.0 member checks, like any install.

Apply keeps every guard and the nonce-bound review digest: a target file, custody,
input or host binding that changes between preview and Apply refuses the whole run
with `REVIEW_STALE` and its `changed` value, writing nothing; prepare the update again.
One-server approval semantics are unchanged: an approval the person took back is a
`conflict`, never granted again. Input values travel only in `controls.privateInputs` and
never appear in the result, its review, run results, inventory or history. The JSON
projection omits the live Apply handle in `preparation.prepared`.

## What each result status lets you claim

Check install and removal wording against this table. Each status establishes only what its row says; the fields are independent, so read them together. Operation `application` and `verification` are per operation in a run result; `completion` is the whole run; `disposition` is the `prepareManagedRemoval` (`aih managed remove`) preflight before any Apply.

| Field | Value | Establishes | May claim | May not claim |
|---|---|---|---|---|
| `application` | `applied` | Core performed this operation's reviewed effect in this run. | "Applied", or for a removal operation "removal applied". | "Installed", "working" or "removed" from this value alone (see the install and removal wording below); that the effect was checked (see `verification`). |
| `application` | `already-satisfied` | The target already had the desired state, so Core wrote no target bytes for it; a reviewed adoption or custody-only step may still record Core's custody. | "Already in place" or "no change needed". | That Core wrote it, or that matching unowned bytes became managed without reviewed adoption. |
| `application` | `failed` | The operation was attempted and did not succeed; `reason` and `effectsUncertain` say more. | "Failed"; with `effectsUncertain`, "may be partly changed". | "Nothing changed" or "rolled back". Prepare again before further changes. |
| `application` | `not-attempted` | Core did not run this operation in this run, for example after an earlier stop, cancellation or rejection. | "Not attempted". | "Failed", "unchanged by anyone" or any outcome for the target. |
| `verification.status` | `passed` | Every check supplied for the operation passed in this run, at that time. | "Verified by its supplied checks". | More than those checks test, or that the state persists later. |
| `verification.status` | `failed` | At least one supplied check did not pass, including a check that was itself unavailable. | "Check failed". | That the effect is absent or reverted; `application` reports the effect separately. |
| `verification.status` | `unverified` | Nothing confirmed the operation's effect in this run. An operation that was not attempted also stays `unverified`. | "Not verified". | "Verified", "confirmed" or "removed". |
| `verification.status` | `unverified`, reason `no-supplied-check` | In a `complete` run, with `application` `applied` or `already-satisfied`: no check was supplied for the operation, so Core ran none. Convenience removals and generated lifecycle cleanup carry no supplied checks. Every operation starts with this value, so in any other run, or with any other `application`, it says nothing about supplied checks; read `checks` for that operation. | "Applied, not verified" when `application` is `applied`. | That the target was checked, or that an applied removal is gone from disk. |
| `verification.status` | `unavailable` | Verification stopped without a result: the run was cancelled during the operation's checks, or offline repair suppressed network verification. | "Verification unavailable". | "Passed" or "failed". |
| `verification.status` | `skipped` | Reserved by the schema for verification deliberately not performed; Core does not currently report it for an operation (check rows in `checks` can be `skipped`). | "Verification skipped". | "Passed" or "failed". |
| `disposition` | `prepared` | A live claim was found and the inner cleanup-only Prepare ran; read its `preparation.status`. Only `ready` or `partial` carries an Apply handle, and `partial` omits conflicting work that needs explicit partial approval. `blocked` (for example locally edited managed content or an Enterprise authority denial) offers nothing to Apply; its `diagnostics` say why. Nothing has been removed yet. | "Removal ready for review" only when `preparation.status` is `ready`; "Removal partly ready for review" when `partial`; otherwise "Removal blocked" with its diagnostics. | "Removed" or "removal applied"; "ready for review" from `prepared` alone. Approve and Apply a reviewable preparation first. |
| `disposition` | `absent` | No claim for this management ID is recorded in that scope. | "Not managed by Core in this scope". | That the target bytes are absent; unowned content is never inspected or deleted. |
| `disposition` | `retained` | Another managed selection still requires this one, so its claim is kept and no removal was prepared. | "Kept because another selection needs it". | "Removed" or "removal pending"; remove the dependent selection first. |
| `disposition` | `reconcile-required` | Recorded custody and the live state disagree, or a legacy member has no claim, so nothing was prepared. | "Needs reconciliation before removal". | "Removed" or "not managed". |
| `disposition` | `unavailable` | Custody or a prerequisite could not be verified, so nothing was prepared. | "Could not check". | "Absent", "not managed" or "removed". |
| `disposition` | `invalid` | The request was malformed or its organization source was wrong. | "Request invalid". | Anything about custody or the target. |
| `disposition` | `cancelled` | Preparation stopped on cancellation. | "Cancelled". | Anything about custody or the target. |
| `disposition` | `not-prepared` | Removal preparation 1.2.0: no requested removal could be prepared; each entry's own disposition says why. | "Nothing to remove was prepared", with each entry's reason. | "Removed" or "absent" for the request as a whole. |
| `removals[].members[].action` | `remove` | The reviewed plan removes Core's bytes of this member. | "Will be removed" before Apply. | "Removed" before `removalClaims` says so. |
| `removals[].members[].action` | `restore` | The reviewed plan writes back the person's earlier value. | "Will be restored" before Apply. | "Restored" before the run's member check. |
| `removals[].members[].action` | `unregister` | The member was already gone; the plan releases only Core's claim. | "Already gone; Core stops managing it". | That Core removed it. |
| `removals[].members[].action` | `keep-shared` | Another selection or origin still owns this member. | "Kept for another selection" or "kept for another set". | "Removed". |
| `removals[].members[].action` | `keep-changed` | The person changed this member; it stays, under Core's claim. | "Kept because you changed it". | "Removed" or "unchanged". |
| `removals[].members[].action` | `keep-required` | A licence or notice file kept with an item that keeps a changed member. | "Kept: the item's licence or notice". | "Removed". |
| `updates[].members[].action` | `add`, `replace`, `remove`, `restore`, `unregister` | The reviewed update plans this change to the member. | "Will be added", "will be updated", "will be removed" or "will be restored" before Apply. | "Updated" before a `complete` run's member checks confirm it. |
| `updates[].members[].action` | `conflict` | The review leaves the member exactly as it is, for the named `reason`; a local edit is never overwritten. | "Kept as you changed it" for `managed-content-changed`; otherwise "not updated", with the reason. | "Updated", or that the whole item now matches the replacement. |
| `disposition` (update) | `prepared` | Managed update preparation 1.0.0: at least one update had an eligible claim and the policy Prepare of its replacement ran; read `preparation.status`. | "Update ready for review" only when `ready`; "update partly ready for review" when `partial`; otherwise "update not prepared", with the preparation's diagnostics. | "Updated", or "ready" from `prepared` alone. |
| `updateState` after an incomplete update | `current` | Custody records the replacement's identities with the members an `incomplete` update run wrote. | "Recorded as the replacement", reading each member's `fileState`. | That the item matches the replacement while any member reads `changed`, or while a member the replacement dropped is still listed. |
| `completion` | `complete` | Every reviewed operation was `applied` or `already-satisfied` with verification `passed` or `unverified`, and nothing was omitted. | "Run complete". | "Verified" while any operation is `unverified`; read each operation. |
| `completion` | `incomplete` | Apply ran, but some operation did not end `applied` or `already-satisfied` with verification `passed` or `unverified`, or something was omitted, or a post-Apply custody or session check failed although every operation succeeded (see `diagnostics`). It may have changed nothing; completed effects are kept. | "Not complete", naming any operations that were applied. | "Complete", "rolled back" or that the applied subset is the whole result. |
| `completion` | `cancelled` | The run stopped on cancellation. Effects completed before it are kept. | "Cancelled", naming the operations that were applied. | "Nothing changed". |
| `completion` | `rejected` | Apply refused the request before starting work, for example a stale review or missing approval. | "Not run". | Any change to the target. |
| `members[].intent` | `write` | The reviewed plan writes this member. | Nothing on its own; read `outcome` and `check`. | That it was written. |
| `members[].intent` | `remove` | The reviewed plan removes this member, or restores the person's value it replaced. | Nothing on its own; read `outcome` and `check`. | That it was removed. |
| `members[].intent` | `keep` | The plan released this selection's claim, but another claim keeps the member. | "Kept for another selection". | "Removed". |
| `members[].outcome` | `written` | The run wrote this member, or found it already in place. | "Written", with `check`. | "Confirmed on disk" without the run-level rule below. |
| `members[].outcome` | `claim-removed` | The run removed Core's claim and the member's bytes Core owned. | "Removal applied" for this member. | "Removed" unless `check` is `absent`. |
| `members[].outcome` | `restored` | The run wrote back the value the person had before Core replaced it. | "Restored" when `check` is `present-matching`. | "Removed" while `check` is anything else. |
| `members[].outcome` | `kept` | The run left the member as it was: shared, preserved, failed or never attempted. | "Not changed by this run". | "Written", "removed" or "failed" from this value alone. |
| `members[].check` | `present-matching` | After Apply the member is on disk exactly as this run left it. | "Present as expected" at that time. | That it persists later, or works. |
| `members[].check` | `present-different` | The member is present but not as this run left it, or cannot be selected uniquely. | "Changed or ambiguous on disk". | "Written", "restored" or "absent". |
| `members[].check` | `absent` | The member is not on disk (file missing, block markers or entry gone, no matching hook group). | "Absent" at that time. | "Present". |
| `members[].check` | `unchecked` | Core did not check it: the run never attempted it, or the target was unreadable. | "Not checked". | Anything about the member. |

An applied removal is not by itself "removed". `application: applied` means Core performed the reviewed removal; with verification `unverified` (reason `no-supplied-check`), nothing confirmed the result. To confirm such a removal:

1. Require `completion: complete` with every removal operation `applied` or `already-satisfied`. Otherwise prepare again.
2. Call `listManagedSelections` (`aih managed list`) for the same project and scope. Only a `complete` result that no longer lists the management ID confirms the claim is gone; an `incomplete` list confirms nothing.
3. Call `prepareManagedRemoval` again for that management ID and scope. `absent` confirms Core holds no claim; any other disposition means the removal is not confirmed. `prepared`, `retained` or `reconcile-required` mean a claim remains.
4. These confirm Core's custody only. Shared members another owner keeps, preserved directories and unowned content stay in place. Inspect the target yourself before saying the content is gone.

Only then say "removed from Core management"; say "removed from disk" only for files you have inspected. Before confirmation, say "removal applied, not verified".

Install wording follows the same rule. Say "installed" only for an operation that is `applied` or `already-satisfied` in a `complete` run; in any other run name only the applied operations, as the `completion` rows say. Then:

- with verification `passed`, say "installed and verified by its supplied checks";
- with verification `unverified`, say "installed, not verified";
- say "confirmed on disk" only under the run result 1.4 rule below, and "working" only for what you have checked yourself, because no status establishes it.

Run result 1.4 member checks ([samartomar/aih-core#99](https://github.com/samartomar/aih-core/issues/99)) settle both claims directly, and `runMemberClaims(result)` applies them:

- **"Confirmed on disk"** requires run `completion: complete`, every `intent: write` member `outcome: written`, and each of those `check: present-matching`. An `incomplete`, failed, `cancelled` or `rejected` run never qualifies, even when its written subset matches.
- **"Removed"** means every `intent: remove` member is `claim-removed` and `absent`, or `restored` and `present-matching` (back to the person's pre-existing value). Members kept for another claim are not removed.

These claims cover the members the run touched; use them instead of the confirmation steps above when the result carries `members`.

## Owned hook groups

Recipe and execution-policy schema 1.1.0 add a `hook.group` operation for JSON and JSONC targets (TOML is unsupported). It manages one element of a shared array (for example a client's hook list) without owning the file: `container` is an object-key path to the array, `selector` (`path`, `value`) identifies the element, `groupId` names custody, and `group` is the literal element for `action: "set"` (`"remove"` deletes it). The selector value must appear in the group literal; neither `groupId` nor the selector is written to the target. Custody records the element's raw-span and canonical digests, so a neighbor edit, insertion or reorder never changes which element a fresh Prepare selects, while an edit to the owned element is a reviewed conflict (`owned-hook-edited`, `owned-hook-missing`, `hook-selector-ambiguous` and related reasons). A different managed group in the same array that has gone missing or ambiguous blocks the step as `hook-selector-overlap`, and the diagnostic names that group; no replace of the current group resolves it. Any edit to the target file between Prepare and Apply, a neighbor's included, makes Apply fail as `REVIEW_STALE` without writing. Reviewed `replace` resolutions use the operation's `details.hookGroup.targetBeforeSha256`. Several claims may share one group; it is deleted only when the last claim is removed, and its content cannot change while another claim retains it. A JSONC removal deletes only the targeted element and one separating comma; whitespace and comments outside that span stay as they were, and an edit that would move or delete an adjacent comment (or a container that is not an array) is reported as `hook-edit-unsafe` instead. An appended element is written as canonical JSON.

A 1.1 policy accepts recipes 1.0 and 1.1, and emits prepared-work and run-result 1.1.0; 1.0 documents keep their bytes and behavior, and a 1.0 policy never admits a 1.1 recipe or touches hook custody. Unless directory evidence requires 1.5.0, the ownership root is written as 1.1 only while a hook group is owned and returns to 1.0 after the last is removed; an earlier Core fails closed on a 1.1 root: it refuses the 1.1 root's own project and, because it cannot verify custody it cannot read, also withholds user-scope cleanup (`dependency-custody-unverifiable`) requested from any other project until Core is upgraded or the hook group is removed. `checkFileState` folds `hook.group` read-only, and guidance adds fixed recovery text without reading observed group content.

## Enterprise policies

Organization policy applies only in Enterprise. Vibe policies and standalone Harness repair never receive an organization document, its target or its set membership, and keep the same capabilities without an organization boundary.

An Enterprise execution policy (`"mode": "enterprise"`, every selection carrying `organizationSelectionId`) is admitted only against an organization policy document that **you select separately** from the policy. Preparation reads that document from GitHub through the Harness reader, validates it, and compares every derived selection (recipe identity, scope, inputs, lifecycle requests) with it. Any finding blocks the whole request: no handle is returned and no subset runs.

Organization documents may use 1.0.0, 1.1.0 or 1.2.0. An optional request field
`organizationTarget: { schema: 'urn:aihq:core:organization-target:1.0.0',
client: 'codex', repository: 'github.com/example-org/app' }` declares the target
for Enterprise selector evaluation. `client` is required and must be a known
native client ID; `repository` is optional and follows the lowercase identity
rules in the authoring section. `validateOrganizationTarget` from
`@aihq/core/contracts` validates this closed, versioned declaration without host
effects. Malformed declarations are invalid; Vibe requests reject the field.
These facts are caller-declared, never inferred from a checkout or verified.

Organization target 1.1.0 names a [registry tool](#ai-tool-registry) with its
surface instead of a client:
`{ schema: 'urn:aihq:core:organization-target:1.1.0', tool: { id: 'claude', surface: 'cli' },
repository?: ... }`. The ID must be a registry ID, not an alias (`tool-alias`),
and the surface must be that tool's surface (`tool-surface-mismatch`); an unknown
ID is `unknown-tool`. Target 1.0.0 keeps its closed client list, so an ID outside
it, such as `kiro-ide`, is still refused there. Prepare blocks a 1.1.0 target whose
tool has not been observed with `PREREQUISITE_UNAVAILABLE / tool-not-observed`,
before any organization read. A 1.0.0 target keeps its existing behavior and is not
subject to this observation check. Selectors and the review's
`organizationObligations.target.client` use the tool's ID.

With a target, Prepare emits `urn:aihq:core:prepared-work:1.5.0` and
`organizationObligations: { target: { basis: 'declared', client, repository? },
fulfillment, advisory }`. Per-scope fulfillment and advisory records exclude
not-applicable entries. Required choices report `fulfilled`, `not-fulfilled` or
`unknown`; unknown records list undeclared facts such as `['repository']` and
never count as fulfilled. Missing required choices are reported as
`not-fulfilled`, not enforced: neither that status nor an unselected entry's
`unknown` status blocks Prepare. Recommendations remain advisory. Selected
entries must still pass admission; unknown selector facts fail closed with
`AUTHORITY_DENIED / target-unknown`, and applicable prohibitions deny admission
with `prohibited`. Changing the request's declared target after Prepare makes
Apply reject with `REVIEW_STALE` before writes.

Without `organizationTarget`, Prepare retains its previous review schema and
omits `organizationObligations`. It declares no client or repository, so
selector-restricted choices fail closed with `AUTHORITY_DENIED / target-unknown`.
It does not evaluate fulfillment; required and recommended entries admit choices
like permitted entries. Use the portable obligation preview to evaluate supplied
target facts independently of Prepare.

**Recipe identity rule.** A selection's recipe identity is `"sha256:"` plus the lowercase hex SHA-256 of the UTF-8 bytes of the canonical JSON (object keys in UTF-16 code-unit order, no whitespace) of `{ "schema": "urn:aihq:core:recipe-identity:1.0.0", "recipeSha256": <hex>, "materials": [{ "id", "sha256", "byteLength" }, ...] }`. `materials` is ordered by ascending UTF-16 code-unit order of `id` (so `A1`, `B`, `a`, `a-b`), never by locale collation, so the identity is the same under every locale. Identities computed with the previous locale-collation order differ for recipes whose material ids order differently (mixed-case ids, `-`, `.`, `_` punctuation, `aa` under some locales); the Catalog content validated with this change (`q1/rel-license` `f2b51599`, 21 items) orders identically under both rules, so its identities are unchanged. An organization document carrying an old identity for an affected recipe is denied with `AUTHORITY_DENIED` (`recipe-identity`) until you recompute the identity with this rule and republish the document. `recipeSha256` is a Catalog item's pinned recipe digest (`item.recipe.sha256` from `@aihq/catalog/reader`) or, for an inline recipe, the SHA-256 of the recipe's canonical JSON.

```js
const prepared = await prepare({
  useCase: 'policy', policy, target: { project },
  organizationTarget: { schema: 'urn:aihq:core:organization-target:1.0.0', client: 'codex' },
  organizationSource: { provider: 'github', repository: { owner: 'example-org', name: 'org-policy' },
    path: 'policy/org.json', revision: { kind: 'branch', value: 'main' } }   // or 'tag' / full 'commit'
}, { authentication: { kind: 'bearer', token } });                          // omit for unauthenticated access
```

- `organizationSource` is required for Enterprise and rejected for Vibe. It is either the GitHub source above or a local file, `{ provider: 'local', path: '/absolute/org-policy.json' }`. `controls.authentication` is `{ kind: 'none' }` or `{ kind: 'bearer', token }`; omission is unauthenticated, and no environment or `gh` credential is ever discovered.
- The review reports `mode: "enterprise"` and `inputs.organization` (normalized source, `resolvedCommit`, `blobId`, `contentDigest`, `policyId`, reader identity). The credential is never serialized into reviews, results, history or diagnostics.
- `apply` reads the organization again with **that call's** `controls.authentication`; a missing credential is not replaced by Prepare's success. A failed read rejects with `AUTHORITY_UNAVAILABLE`, `INPUT_INVALID` or `CANCELLED`; any change of source, resolved commit, blob or content digest (including a moved branch or tag) rejects with `REVIEW_STALE`. Nothing is cached and no history is used as fallback.
- Unreachable or unauthorized sources prepare as `blocked` with `AUTHORITY_UNAVAILABLE` and the reader's reason (`authentication-required-or-denied`, `source-missing-or-inaccessible`, `rate-limited`, `network-failed`, …); permission refusals are `AUTHORITY_DENIED`. A private repository can answer 404 for a missing credential.
- Harness repair (`useCase: 'repair'`, `aih repair`) never consults an organization source and rejects an `organizationSource` or `organizationSetMembers` field. A recipe that merely calls itself Harness receives no exemption.

**Local organization source.** `{ provider: 'local', path }` names one regular
file by absolute path. It is read offline (no network), bounded to 1,000,000
bytes, and refused when it is a link or not a regular file
(`source-not-regular-file`) or cannot be read (`source-missing-or-inaccessible`).
The review names the file a person can read, never its folder:
`inputs.organization: { source: { provider: 'local', fileName }, contentDigest,
policyId, helper: { id: 'local-policy-reader', package } }`. Apply reads the file
again; changed bytes or a different file are `REVIEW_STALE` with `changed:
'policy'`, and nothing is written. Only execution policy 1.4.0 (prepared work
1.6.0, run result 1.4.0) can name a local source; an older policy with one is
`INPUT_INVALID / organization-source-local-review`. Grouped removal preparation
1.2.0 accepts a local source too; the single-id removal form and `aih managed
remove` name only GitHub. The source is caller-selected like the GitHub source;
nothing chooses one from data.

**Set membership in Prepare.** `organizationSetMembers` (Enterprise only;
rejected for Vibe) supplies the Catalog-resolved members for the organization
document's 1.2.0 set selectors. It takes part in validation, contradiction
checks and admission, and is bound by the request digest, so a change before
Apply is `REVIEW_STALE`. With a declared target, prepared work 1.6.0 (execution
policy 1.4.0) lists fulfillment and advice for recipe and content-only entries,
each with `recipeIdentity`, `content` or both, and reports a set without supplied
members as `unavailable`. Prepared work 1.5.0 names recipe entries only; there a
content-only entry is left out and an unavailable set reads `unknown` or
`not-taken`.

```sh
export ORG_TOKEN=...   # only the named variable is read
aih policy policy.json --project /absolute/project \
  --org-repository example-org/org-policy --org-path policy/org.json --org-ref branch:main \
  --org-token-env ORG_TOKEN --apply --yes --json
```

`--org-repository <owner/repo>`, `--org-path <path>` and `--org-ref <branch:name|tag:name|commit:sha>` are all required for an Enterprise policy and rejected for Vibe (malformed values exit 2). Alternatively, `--org-file <path>` selects a local organization document for an execution policy 1.4.0, read offline; it cannot be combined with the GitHub flags or `--org-token-env`. `--org-token-env <NAME>` names an environment variable holding the bearer token (missing or empty exits 2 without printing it); the token stays in memory and is used for both Prepare and Apply. Authority failures and denials exit 2, including previews.

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
Changing shipped trust requires a new Core release; the optional client below
can separately supply caller-selected trust updates. Associating another report
does not require a Core or Catalog update.

Bounds include 96 MiB artifact JSON, 16 MiB report/individual annex, 64 MiB total
decoded report+annex bytes, 1 MiB attestation, 128 KiB signed statement, and 1 MiB
selected trust with at most 128 keys and 32 publishers. Inputs exceeding bounds
are refused rather than truncated. The verifier dependencies are pinned; Core
imports neither the Scan engine nor Catalog.

## Optional TUF trust updates

Static shipped `verificationKeys` and `verificationPublishers` remain the default.
Nothing refreshes them automatically. The Node-only `@aihq/core/harness/runtime`
exports `getTrustSnapshot`, `createTufTrustClient`, `getVerificationTrust`,
`getCurrentTrustStatus` and `getCatalogIndexTrust`, and the types `TrustSnapshot`
and `TufTrustClientOptions`. Importing this entry schedules no update.

```js
import { createTufTrustClient, getTrustSnapshot, getVerificationTrust,
  getCurrentTrustStatus, getCatalogIndexTrust } from '@aihq/core/harness/runtime';

const staticTrust = await getVerificationTrust(); // shipped defaults, no IO
const client = createTufTrustClient({
  root: independentlySelectedRootBytes, // Uint8Array of bootstrap TUF root metadata
  metadataBaseUrl: 'https://trust.example/metadata/',
  targetBaseUrl: 'https://trust.example/targets/',
  targetPath: 'trust.json',
  cacheDir: '/absolute/dedicated/trust-cache'
});
const snapshot = await client.update(); // the only network operation
const historicalTrust = await getVerificationTrust(snapshot);
const current = getCurrentTrustStatus(snapshot, { keyId });
// authenticateEvidence({ bytes, expectedScanId, trust: historicalTrust })
```

Construction creates or reuses a caller-owned dedicated cache and pins its
bootstrap root digest, endpoints and target name. Use an initially empty directory;
reuse that same directory across calls and process restarts to retain rollback
protection. Do not erase or replace the cache to recover from a refused update.
Only one update may hold its exclusive cache lock. A crashed updater can leave a
lock: the host must establish that its process exited before removing that lock.
Local cache integrity and lifecycle belong to the host. Ordinary HTTPS is accepted;
literal loopback HTTP supports local fixture repositories. Credentials, query
strings and fragments in base URLs are refused. No production roots or test
signing keys ship in the trust inventories.

The pinned, bundled `tuf-js` client checks the root signature chain, metadata
signatures, expiry, versions, rollback and target hashes/length. Each fetch has
a ten-second timeout and no retries, metadata and target bytes are capped at
1 MiB, and root rotations/delegations are capped at 32 each. Update failures
reject the promise; they never produce an authenticated snapshot or silently
fall back to a new source. Keep the last returned snapshot when an update fails.
No timer, automatic refresh or changes to Core's Prepare/Apply path are added.

The selected TUF target is JSON with this envelope:

```js
{
  schema: 'urn:aihq:harness:trust-update:1.0.0',
  verificationKeys: [],          // existing Harness key records
  verificationPublishers: [],    // existing Harness publisher records
  scanEvidencePolicies: [],      // Scan evidence-policy 1.0.0 documents
  revocations: [{ kind: 'key', id: 'ed25519:<key fingerprint>' }],
  // optional: base64 of TUF root metadata for the explicitly selected Catalog source
  catalogTufRootBase64: '...'
}
```

Key/publisher inventories use their existing public validators and limits.
At most 32 bounded Scan evidence-policy documents are transported opaquely;
the host passes a selected document to Scan's public policy reader before use.
Core checks their schema identifier, never evaluates their findings or applies
them as execution authority. At most 160 revocations name `{kind:'key',id:keyId}`
or `{kind:'publisher',id:identity}`. Unknown downloaded envelope fields, including
root/source/organization/framework authority hints, are ignored.

Returned snapshots are frozen. Accepted key and publisher records accumulate,
starting with shipped trust; a previously recorded key ID cannot be rewritten. Distinct publisher policies
may share an identity; rotation retains both the previous and the updated record
for historical authentication, deduplicating equivalent records. `getVerificationTrust(snapshot)`
selects this historical inventory and deliberately ignores revocations.
`getCurrentTrustStatus(snapshot, {keyId?, publisherIdentity?})` reports `revoked`,
`current` or `unknown` separately. A new revocation never edits an earlier snapshot
or changes a historical authentication result. Revocations describe the latest
accepted target; removing a revocation requires another explicit trusted update.

**Catalog handoff:** `getCatalogIndexTrust(snapshot)` returns a fresh
`{tufRoot: Uint8Array}` from the TUF-verified target's optional root field, or
`'none'` when absent. The host explicitly assigns it to
`readReleaseIndex({sources:[{sourceId, trust: getCatalogIndexTrust(snapshot),
authorizedFrameworks, indexBytes}], state, evaluatedAt})` from
`@aihq/catalog/release`. This is Catalog's named `sources[].trust` seam.
The host independently selects `sourceId`, endpoints and `authorizedFrameworks`;
none is discovered from downloaded index data. This handoff does not authorize
frameworks, verify index bytes itself or turn `'none'` into verified trust.
Catalog versions where TUF index verification is unavailable treat a selected
root as offline and contribute no entries; keep that refusal visible. End-to-end
index verification requires a Catalog version implementing that path.

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

Prepare and run results are interpreted for every prepared-work and run-result
format Core produces: prepared-work `1.0.0`–`1.5.0` (policy, repair, trust and
certificate-export, macOS session and targeted organization reviews) and
run-result `1.0.0`–`1.3.0`. Each review or run result must satisfy the published
schema and contract rules of its exact `schema` ID, so undeclared fields or a
document relabelled with another known ID return `INPUT_INVALID`; an unknown or
future ID returns `SCHEMA_UNSUPPORTED`. Inspection results and the Prepare
wrapper (`status`, `runId`, `diagnostics`, `record`) have no published schema and
keep their bounded shape checks. Support reads each input once as strict JSON
limited to 1,000,000 canonical UTF-8 bytes and depth 32 for the whole
`{kind, result, repair?}` wrapper (a Prepare result's live `prepared` handle is
skipped, not read). A larger result returns `INPUT_INVALID` even when it is
otherwise valid; Core's produced-format validators themselves set no such cap.
Organization obligation fulfilment in
prepared-work `1.5.0` is review information and adds no guidance items.

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

### Published state location

Read where Core keeps its state instead of hard-coding it, for example to refuse a
project folder inside Core's state. The location is information only: it is not
permission to write there. Core alone creates, protects and changes its state, and
its operations refuse supplied targets inside it.

`stateLocation` from `@aihq/core/contracts` is portable and holds relative
descriptors only. It imports nothing from Node and does not discover host paths.
`root` is relative to the current account's home folder; each `projectMarkers`
path is relative to `root`, `/`-separated, and names a child holding Core's records
of the changes it makes to project folders (or home):

```js
import { stateLocation } from '@aihq/core/contracts';

stateLocation.root;           // { base: 'userHome', segments: ['.aih', 'core'] }
stateLocation.projectMarkers; // [{ path: 'ownership', meaning }, { path: 'recovery', meaning }, { path: 'runs', meaning }]
```

| Marker | Meaning |
| --- | --- |
| `ownership` | Ownership records: one per project folder (or home) whose files Core manages. |
| `recovery` | Recovery manifests and private original-file snapshots, one folder per run that changed files. |
| `runs` | Redacted run history, one record per run. |

A marker may be absent until Core first needs it. Core writes no marker file into
project folders. The values are frozen.

`resolveStateLocation()` from `@aihq/core` (Node) returns the same descriptors as
absolute paths for the running host: `{ root, projectMarkers: { path, meaning }[] }`.
It resolves the home folder as Core's operations do, creates and reads nothing,
and throws when the home folder is not an existing absolute directory.

```js
import { resolveStateLocation } from '@aihq/core';

const { root } = resolveStateLocation(); // for example /home/me/.aih/core
```

## Effective Node and npm trust

Inspection records the selected Node host's version separately from npm's
version command, and reports absent or conflicting PATH candidates. Node is the
host running Core, even when PATH points to another Node or contains none.
An unparseable version command is reported without an invented version.

`npm/tls/effective` runs the selected npm process against its configured HTTPS
registry, retaining its environment, project/user configuration, CA overrides
and proxy selection. It requires effective `strict-ssl=true` and refuses an
inherited TLS verification bypass. A pass describes that npm process and
endpoint. The existing `<target>/tls/node/<host>` checks describe Core's Node
TLS view, including the managed configuration projection when requested; they
do not establish npm's effective trust. Offline inspection skips the npm probe.

Prefer inspection before selecting a persistent supplied-CA repair. For
`node-os-trust`, an already trusted endpoint returns the existing `blocked`
preparation status with diagnostic `REPAIR_NOT_NEEDED`, reason
`node-already-trusted`, and no prepared handle or repair effects. No Apply is
needed for that result. A system-CA candidate refuses explicit conflicting
Node trust flags, environment selection or extra-CA override. Supplied bundles
remain an explicit fallback with the existing conflict, exclusion and rollback
review. Nothing disables TLS verification or changes an OS trust store.

The Linux process fixtures use an isolated `SSL_CERT_FILE` and loopback HTTPS
server to verify trusted/untrusted outcomes, npm CA precedence and refusal of
disabled verification. They do not qualify Windows/macOS stores, Linux native
admission, real user accounts or client sessions. Those exact native tuples
remain independently gated.

## Development checks

Source lives in [`samartomar/aih-core`](https://github.com/samartomar/aih-core).
Use Node 26 within the declared engine range. Clone this repository and run the
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

The historical Core compatibility fixture retains its original Node 24 guard.
Set `AIH_TEST_LEGACY_NODE` to an independently selected Node 24 executable when
running that fixture from Node 26. This selects only the historical control;
the current package and its tests continue to run on Node 26. Without that
compatible historical runtime the fixture reports its failure; it does not
rewrite historical source or infer a compatibility pass.
For example, with Node 26 selected as `node`, run
`AIH_TEST_LEGACY_NODE=/opt/node24/bin/node npm test` in a POSIX shell (set the
same environment variable before `npm test` in PowerShell). The full CI matrix
provisions historical Node 24.22.1, records its executable path, then selects
Node 26 for the current package checks.

Ordinary CI runs on pull requests and pushes to `main`, with superseded runs
cancelled. Feature pushes do not duplicate PR checks. Documentation-only edits
report an explicit no-applicable-tests result. Portable reporting changes run
their owning tests and affected package consumers on Linux; platform-facility
changes run the full suite on their affected OS. Shared contracts, dependencies,
build/workflow changes, unknown paths and deleted/renamed paths use the full
four-cell OS/Node matrix. The **Run workflow** action explicitly selects that
full matrix. `Core checks result` fails if any selected job fails or is cancelled.
Other native acceptance and publication workflows retain their own triggers.

Use `npm test -- --suite report` for reporting iteration, or
`npm test -- --files <test paths>` for a focused local check. `npm test` retains
the complete suite. After building, `npm run verify:recipe-input-consumer --
--output <new directory>` packs and installs an independent consumer, proves
false/empty/zero input values and exact material binding, and writes a receipt
with source commit, archive SHA-256 and installed package identity. Its targets
and home stay under the new output directory.

Create a qualified Core distribution with `npm run pack:distribution --
--pack-destination <existing directory>`. The command builds and packs the root
package, preserves every archive entry's bytes and metadata except the Linux
facility's executable mode, refuses to overwrite an existing artifact, and
reports the final archive's SHA-256 and integrity. Use this command on all
producer platforms; raw `npm pack` can preserve missing executable bits from a
Windows producer. See the [Linux packaging checks](docs/native-linux-verification.md#build-records-and-development-checks).

Linux native verification pins exact runtime bytes. After distro updates change a
pinned library, verification refuses with `isolation-unobserved`; see
[Re-capturing the platform record](docs/native-linux-verification.md#re-capturing-the-platform-record-after-distro-updates).
On the reference host the developer-only report command is read-only:

```sh
node scripts/recapture-linux-runtime-platform.mjs --client <path>
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
the installed declarations against Core's package-support schema and their
schema exports, and generates unsigned synthetic partial reports for display
checks. It also exercises policy `operationSelections`, `recipeOperationKinds`,
file-state 1.1 `selectionIds`, and support guidance on every review and run
family a policy Prepare produces. The trust and macOS families need native setup
and are listed as not exercised. It covers Harness target `executables`,
claim-set path refusal, Catalog `releaseInventory`/`compareReleases`/
`resolveSelections` detail and Scan `readContentCoverage`, and runs the portable
ones with browser globals only. The baseline Catalog must lack content the
current one adds. A declaration deviation passes only when it exactly matches an
expected entry with an owning issue. The retained signed production artifact is
checked separately using independently selected bundled trust. Neither a report
view nor successful authentication authorizes installation. The example is
source-only and excluded from the Core npm artifact.

The build removes obsolete generated output and copies only shipped Harness
files. Portable package identity is generated from the root manifest, shared by
both modules, and checked against the installed manifest by host operations.
Repair review/result `inputs.package` names that Core distribution;
`helperSha256` binds the manifest, generated identity and shipped Harness helper
bytes, while `sourceSha256` binds selected repair inputs. Schema IDs retain their
independent versions. Published Harness changes require a new Core package
version and a deliberate Core update through ordinary package management.
Unpublished local builds are distinguished by source commit and artifact digest.

CI runs these gates on Linux, Windows and macOS. The separate manually invoked
native macOS trust acceptance uses a disposable runner, installs a temporary CA
in its OS keychain and exercises packed system-CA and supplied npm repair. It
requires a macOS 26 arm64 runner and establishes native evidence only when run.

## Reporting

`aih report --output <new-directory> --json` acquires bounded offline Node/Git diagnostics and writes the projected snapshot as `report.json`. Use repeated `--target` for selected offline Harness diagnostics. `aih report --snapshot <report.json> --output <new-directory> --json` validates and re-exports supplied data without acquisition; the CLI accepts snapshot files up to 1,000,000 bytes, while the portable JSON import API has a 2 MiB raw-input limit and its own documented structural bounds. Core writes no HTML: presentation is done by the consuming application from the snapshot data. Report-only options are rejected by other commands. Outputs require a new directory and do not overwrite existing reports.

`@aihq/core/report` exports `createReport`, `validateSnapshot`, `importSnapshot`, `exportSnapshot`, schema identities, errors and reporting types. `@aihq/core/report/schema` exposes the JSON Schema. The data import has no host effects, and Core ships no report renderer. Both formats are **experimental**, with runtime validation and explicit unsupported-version rejection.

Read [reporting contracts](docs/reporting/CONTRACT.md), [field/source mapping](docs/reporting/FIELDS.md) and [reproduction](docs/reporting/REPRODUCE.md). Consumer-owned [data](examples/reporting/data-only.mjs) and [loopback HTTP](examples/reporting/http.mjs) examples use only public imports. Unsupported analytics stay EMPTY. Supplied assertions remain unauthenticated; presence/configuration is not verification, and importing or serving a snapshot does not collect observations.
