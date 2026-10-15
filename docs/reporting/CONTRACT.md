# Data contract (experimental)

`@aihq/core/report` is the data-only entry point of this reporting module: runtime
validation, privacy projection and evidence limitations. It performs no
rendering, filesystem access or host observation. Rendering lives at
`@aihq/core/report/render`; importing `@aihq/core/report` stays data-only.

## Status and compatibility

The interface is **experimental**. `schema` is a version identity, not a stable
general-purpose contract: the shape may change in a later version without a
deprecation period. Only this exact version is accepted, and only against
producer contract `urn:aihq:harness:diagnostic:1.0.0`. A package version alone
establishes nothing; treat the data interface as internal to the local
development loop.

## Public exports

| Export | Signature | Behavior |
|---|---|---|
| `SNAPSHOT_SCHEMA` | `'urn:aihq:report:snapshot:1.0.0'` | Snapshot shape identity. |
| `DIAGNOSTIC_CONTRACT` | `'urn:aihq:harness:diagnostic:1.0.0'` | The one supported producer contract. |
| `createReport(input)` | `CreateReportInput -> ReportSnapshot` | Validate and project a supplied diagnostic. |
| `validateSnapshot(value)` | `unknown -> { valid: boolean, errors: string[] }` | Structural check; never throws for malformed input. |
| `importSnapshot(json, redaction?)` | `string, privacy context? -> ReportSnapshot` | Parse, validate, re-redact; reject duplicate keys. |
| `exportSnapshot(report)` | `ReportSnapshot -> string` | Validate, re-redact, serialize deterministically. |
| `ReportInputError` | `Error` with `code` | Thrown for invalid/unsupported input. |

`createReport` input:

```js
{
  diagnostic: unknown,                       // schema-valid @aihq/core Harness result
  producer: { name: '@aihq/core', version: string, revision: string | null },
  observedAt: string,                        // ISO 8601 UTC, e.g. 2026-10-03T12:00:00.000Z
  acquisition: 'supplied' | 'newly-acquired',
  originalSha256?: string,                   // 64 lowercase hex, hash of the raw bytes
  redaction?: { homePaths?: string[], secretValues?: string[] },
}
```

`ReportSnapshot` is exactly the shape declared in `src/harness/report/data.d.mts` and
`src/harness/report/schema.json`; every field is documented in [FIELDS.md](FIELDS.md).

## Errors

`ReportInputError.code` is one of:

- `INPUT_INVALID` — malformed, unsafe or out-of-bounds input (shape, enum,
  accessor, symbol key, cycle/shared reference, non-finite or negative-zero
  number, oversized or over-deep value, invalid JSON, unknown field, tampered
  counts).
- `SCHEMA_UNSUPPORTED` — a recognized snapshot `schema` or `producer.contract`
  string that this version does not support.

Messages name structural paths only (for example `snapshot.metrics.counts`).
During plain-data admission, arbitrary object members use indexed locations
such as `snapshot.field[0]`; neither caller-controlled keys nor offending values
are echoed in errors.

## Validation rules

`createReport` enforces the entire `urn:aihq:harness:diagnostic:1.0.0` shape:
required and optional keys, closed objects (`additionalProperties: false`),
enums for `status`, tool `state`/`selection`, and check `outcome`, and the
producer's numeric limits (`budgetMs` 1–180000, `maxActiveProbes` 1–2,
`elapsedMs` ≥ 0). `limits` is the source of `metrics`.

Both entry points first require **bounded plain JSON**:

- plain objects/arrays only (no class instances, functions or symbols);
- enumerable data properties only (accessors and hidden keys rejected);
- no cycles or shared references;
- finite numbers only; negative zero rejected as non-deterministic JSON;
- strings ≤ 65536 UTF-8 bytes each and ≤ 1 MiB in total;
- depth ≤ 16, nodes ≤ 20000, array ≤ 4096 items, object ≤ 256 keys.

`validateSnapshot`, `importSnapshot` and `exportSnapshot` enforce the closed
snapshot shape, the exact version and contract, and that
`metrics.counts` matches the actual `checks` outcomes.
Own `__proto__` fields remain visible to closed-object validation and are
rejected as unknown fields rather than silently disappearing during cloning.

## JSON import / export

- `exportSnapshot` rebuilds the snapshot in a fixed key order, so the same
  snapshot always serializes to the same string.
- `importSnapshot` rebuilds in that same canonical order, so a document with
  permuted keys round-trips to identical bytes.
- Both re-apply the privacy projection. A secret injected into a free-text field
  is removed on export and on import, so redaction cannot be bypassed by editing
  the JSON between calls.
- Redaction replaces parsed string values, never raw JSON text, so escaping in
  the secret cannot corrupt the document.
- Importing or exporting never acquires new observations and never rewrites the
  raw evidence bytes; `evidence.originalSha256` continues to name the caller's
  original bytes.

## Normalized claims (claims 1.0.0)

`@aihq/core/report` also accepts a **normalized claim set** beside the unchanged
diagnostic snapshot 1.0.0. A claim set is a list of producer-neutral claims plus
explicit, inspectable calculation requests and action suggestions. Validation and
projection are pure: they read no clock, randomness, filesystem or network, resolve
nothing from a catalog, and compare strings by UTF-16 code unit. The same input
always yields a deep-equal and identically serialized result, and the caller's
value is never mutated. Like every reporting input, a claim set must be bounded
plain JSON with no shared object references (parsed JSON never has any).

### Exports

| Export | Signature | Behavior |
|---|---|---|
| `CLAIMS_SCHEMA` | `'urn:aihq:report:claims:1.0.0'` | Claim-set identity. |
| `CLAIMS_ACCEPTED_VERSIONS` | frozen `['urn:aihq:report:claims:1.0.0']` | Every claim-set version this release reads. |
| `CLAIMS_PROJECTION_SCHEMA` | `'urn:aihq:report:claims-projection:1.0.0'` | Projection identity. |
| `CALCULATION_METHODS` | frozen `{id, version}[]` | `configuration-check-score`, `verified-repair-count`, `context-change`, each `1.0.0`. |
| `validateClaimSet(value)` | `unknown -> { valid, errors }` | Never throws for malformed input. |
| `readClaimSet(json)` | `string -> { status: 'supported', claimSet } \| { status: 'rejected', code, schema, errors, original }` | Never throws. A rejection carries the exact unchanged input in `original`. |
| `projectClaims(claimSet)` | `ClaimSet -> ClaimsProjection` | Throws `ReportInputError`. |

The JSON Schema is `@aihq/core/report/schemas/claims/1.0.0.json`
(`$id` `urn:aihq:report:claims:1.0.0`); `contractSupport` lists it with role
`accepts`. JSON Schema checks structure only. The validator additionally checks
real calendar instants, claim identity, reference resolution and the
calculation-specific requirements below.

### Input

```js
{ schema: 'urn:aihq:report:claims:1.0.0',
  claims: Claim[],                    // 0..4096
  calculations?: CalculationRequest[],
  actions?: ActionSuggestion[] }
```

Every object is closed; an unknown field is `INPUT_INVALID`. A claim has:

| Field | Meaning |
|---|---|
| `id`, `revision` | Non-empty strings (≤ 256 characters). `(id, revision)` is the claim identity. |
| `producer`, `recordSchema` | Producer `{id, version}` and the schema identity of the record the claim was normalized from. |
| `subject` | Exact `{kind, id}`. |
| `scope` | `{kind: machine \| repository \| workspace \| user-content, targets}`; targets are non-empty and unique and never imply "all". |
| `sources` | Non-empty source-record references `{id, schema, sha256?}`. |
| `observation` | Stable source event identity, or `null` when none is reliable. |
| `capturedAt` | RFC 3339 UTC with an explicit `Z` or `+00:00` offset; must be a real calendar instant. |
| `measure`, `kind` | What is claimed, and `measured \| estimated \| declared \| unknown`. |
| `value` | `{amount: number \| string \| boolean, unit}`; required unless `kind` is `unknown`. |
| `unknownReason` | Required, non-empty, exactly when `kind` is `unknown`; `value` must then be absent. |
| `method` | `{id, version}`; required when `kind` is `estimated`. |
| `coverage` | `{state: complete \| partial \| unknown, reason}`. |
| `authentication` | `{status: 'not-authenticated'}`, or `authenticated`/`verification-failed` with a complete `verifier`, `method`, `verifiedAt` and non-empty `evidence`. |
| `applicability` | `{state: current \| recheck-needed \| unknown, reason, inputs}` where `inputs` are `{id, revision}` bindings. |

The same `(id, revision)` repeated with identical content is one claim; repeated
with different content the set is `INPUT_INVALID`. Coverage, applicability and
authentication are separate fields and nothing combines them. Validation and
projection copy `authentication` as supplied: they never verify, promote or
downgrade it, so a claim without verifier provenance can only be
`not-authenticated`.

### Reading and errors

`readClaimSet` rejects raw JSON over 2 MiB and duplicate object keys, as
`importSnapshot` does. A `schema` string outside `CLAIMS_ACCEPTED_VERSIONS` is
`SCHEMA_UNSUPPORTED`; a missing or non-string `schema`, a malformed value or an
unknown field is `INPUT_INVALID`. `projectClaims` throws `ReportInputError` with
the same two codes. Messages name structural paths only, such as
`claimSet.calculations[0].method`, never caller values. The claim-set node and
string budgets (300,000 nodes, 2 MiB of string data, 4096 items per array) are
larger than the snapshot's; values beyond them are rejected, not truncated.

### Projection

```js
{ schema: 'urn:aihq:report:claims-projection:1.0.0',
  source: { schema: 'urn:aihq:report:claims:1.0.0' },
  claims: ProjectedClaim[],           // one per claim identity, sorted by id then revision
  observations: { duplicates, conflicts, unidentified },
  calculations: CalculationResult[],  // request order
  actions: OrderedAction[] }
```

Each projected claim repeats the supplied fields in a fixed key order (an unknown
claim has `unknownReason` and no `value`) and adds
`dedup: { status, canonical }`.

**De-duplication.** Claims with the same producer `id` and non-null `observation`
describe one event. When their content is identical apart from `id` and
`revision` (source references are part of the content), the smallest
`(id, revision)` is `canonical`, the others are `duplicate`, and
`observations.duplicates` records `{producer, observation, claim, merged,
imports}` where `imports` counts the canonical claim and everything collapsed
into it. When content differs the group is a `conflict`: every claim stays in
`claims` and `observations.conflicts` lists them with reason
`same-observation-different-content`. Claims with `observation: null` are
`unidentified`, shown and never de-duplicated.

### Calculations

Each request names its method, version and exact claim references (`{id,
revision}`, which must resolve). A result carries `{id, method, status:
'available' | 'unavailable', reason, inputs}` plus the fields below. No method
yields a global or combined risk score; an unsupported method or version is
`INPUT_INVALID` at `claimSet.calculations[i].method`.

**`configuration-check-score`.** Selected claims must have `measure:
'configuration-check'` and a `method` equal to the request's `checkSet`. Each is
`passed`, `failed` (a value `{amount, unit: 'outcome'}`) or `unknown`. Claims in
`inapplicable` are excluded with their reason and cannot also be selected. Score
= `passed / (passed + failed + unknown) × 100`, so unknown checks stay in the
denominator. With no applicable check the result is `unavailable`, `score: null`,
`reason: 'no-applicable-checks'`. Results report `counts`, `numerator`,
`denominator`, `score`, `checkSet`, `excluded`, `failed`, `conflicts` and
`deduplication`. Selected claims that are duplicates of one observation count
once; a conflicted observation counts once as unknown. `failed` lists every
selected claim whose own outcome is failed, even when the score is high and
including members of a conflicted observation (duplicates of one event appear
once, as the canonical claim), so `failed` can list a claim that `counts` holds
as unknown. `conflicts` lists the selected members of conflicting observations,
sorted, so that qualification is visible.

**`deduplication`.** Both `configuration-check-score` and
`verified-repair-count` report `deduplication: { status, unidentified }`. It is
`not-established` when any claim the request references (selected, excluded,
precheck, repair or postcheck) has `observation: null`, and `unidentified` lists
those claims sorted by `(id, revision)`. The numbers are still computed from the
supplied records, but a re-import of an unidentified event cannot be recognised,
so they are not a deduplicated aggregate. Otherwise the status is `established`.

**`verified-repair-count`.** Each attempt names `operation`, `subject`,
`condition` and optional `precheck`, `repair`, `postcheck` claims. An attempt
is the adapter's explicit assertion that binds one operation to one condition and
subject. The projection checks every referenced claim against that binding
(the repair by subject and operation; the checks by subject and condition; the
instants in strict order) and never infers a link between claims. The first
matching rule applies, each with a `counted` flag and a `reason`:

1. `uncorrelated` — a referenced claim has a different subject, condition or
   operation, is not a check/repair claim of the expected form, or the
   `capturedAt` instants are not strictly ordered precheck < repair < postcheck.
2. `conflicting-evidence` — the precheck, repair or postcheck claim belongs to a
   conflicting observation, so it cannot establish a verified repair.
3. `unknown-precondition` — precheck is missing or unknown.
4. `already-healthy` — precheck passed.
5. `external-repair` — the repair claim is `measure: 'external-repair'`.
6. `unknown-cause` — no repair, postcheck passed.
7. `applied-unverified` — repair present, postcheck missing or unknown.
8. `repair-not-verified` — repair present, postcheck failed.
9. `no-recovery` — no repair, postcheck missing, unknown or failed.
10. `verified` — precheck failed, repair present, postcheck passed (counted).

`count` is the number of distinct failed conditions among verified attempts,
keyed by the precheck's de-duplicated observation, so one duplicated imported
failure counts once. A later pass never erases the earlier failure, and nothing
infers a cause.

**`context-change`.** Comparable when both claims share `measure` and `unit`,
hold non-negative numbers, and are either both `measured` with unit `bytes` or
both `estimated` with an identical `method`. Otherwise the result is
`unavailable` with `unknown-value`, `incomparable-measure`, `incomparable-kind`,
`incomparable-unit`, `incomparable-method`, `unsupported-kind`,
`unsupported-unit` or `invalid-amount`. Available results report `before`,
`after`, `unit`, `absoluteDifference`, `direction` (`decrease`, `increase`,
`unchanged`) and `percentage = (before − after) / before × 100`, positive for a
reduction. With a zero baseline `percentage` is `null` and `percentageReason` is
`'zero-baseline'`. Percentages are not rounded.

### Actions

An action suggestion is `{id, category, reason, subjects, evidence,
prerequisites, route: {kind: operation | guidance, id}}` with resolving
`evidence`. The projection orders actions `blocker`, `urgent-review`,
`important-unknown`, `optional-improvement`, breaking ties by `id` in code-unit
order, and adds `order: {rank, category, reason, tie: 'id'}` where `rank` is the
1-based position and `reason` states the category rule. The report projects
actions; it never executes them.

### Examples

The package ships filled examples in `examples/reporting/claims/`; each
`<case>.input.json` is a valid claim set and each `<case>.projection.json` is
exactly what `projectClaims` returns for it. `checks` shows a score that keeps an
unknown check in the denominator (50), an unavailable score with no applicable
check, a 95 score that still lists its failed check, a re-imported event counted
once, a conflicting observation kept as two claims, and the action ordering.
`repairs` shows one verified repair beside already-healthy, unknown-cause,
external-repair and applied-unverified attempts that are not counted. `context`
shows a measured byte reduction with its percentage, a zero baseline with no
percentage, a same-method estimate comparison and an estimate that cannot be
compared with an observed value. `unsupported.input.json` carries an unaccepted
`schema` and is rejected as `SCHEMA_UNSUPPORTED` with its bytes preserved.

`npm run verify:report-consumer` installs a packed artifact in a separate
consumer directory and projects these installed examples through the public
exports, in Node and in a browser bundle. By default it packs the working tree;
`npm run verify:report-consumer -- --tarball <file>` checks an artifact already
produced by `npm run pack:distribution`.

### Limitations

A claim set is supplied, not observed. Structural validity does not make a claim
true, and `authentication` records only what the producer supplied. The module
does not verify signatures, resolve claim sources or evidence, or decide whether
a producer was trusted. Calculations are explicit methods over the claims you
select; the projection does not choose which claims are in scope. Text fields are
copied as supplied: the snapshot redaction pipeline does not run on claims, so
producers must not place secrets or machine-local paths in a claim set they
intend to share.

## Evidence limitations

- `evidence.structuralValidation: 'passed'` means only that the input matched
  the schema and bounds. It does not authenticate the producer, the assertions
  or the caller's provenance.
- `evidence.authentication` is always `not-authenticated`. No signature, key or
  trust material is checked; no authenticity claim transfers to transformed
  bytes.
- `producer` and `capture` are supplied provenance, not attestation.
- The original raw bytes are never embedded, copied or overwritten. The SHA
  names those bytes, not the exported snapshot.

## Privacy

Redaction is explicit and always-on; see
[FIELDS.md](FIELDS.md#privacy-treatments) for every treatment. Unsafe arbitrary
producer prose (`requestId`, `helper`, `repairChoices`) is dropped rather than
projected, while meaningful states and outcomes are preserved. Privacy-sensitive
free text is masked in both the snapshot object and its JSON, and the renderer
shares the same projected data.

## What this interface does not contain

The diagnostic snapshot carries no legacy digest object, score, history,
token-usage rollup, chart layout or rendered HTML. The portable module does not import the producer runtime. The
maintained schema is available through the public
`@aihq/core/harness/schemas/diagnostic/1.0.0.json` export.

## Attribution

- Credential-shaped redaction patterns are ported from the legacy `ai-harness`
  redaction set (Apache-2.0), re-authored without host or environment access.
- Core reporting is licensed Apache-2.0.

Producer revision is string | null: null means unavailable. Fresh installed-package reports never invent a Git revision. Original evidence SHA-256 may be null when raw evidence was not retained.

Imports reject duplicate keys and raw JSON over 2 MiB, alongside the documented
plain-data limits. Conventional Unix/macOS/Windows home prefixes are masked by
default, as are known credential assignments and sensitive arguments. For
nonstandard homes or arbitrary secret values, pass the same `homePaths` and
`secretValues` privacy context accepted by `createReport`. Projection means these
rules ran; it does not prove every sensitive value was recognizable. Review the
result before sharing. Expansion beyond snapshot bounds is refused.
