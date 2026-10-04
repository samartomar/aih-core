# Data contract (experimental)

`@aihq/core/report` is the data-only entry point of this library: runtime
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
| `importSnapshot(json)` | `string -> ReportSnapshot` | Parse, validate, re-redact. |
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

`ReportSnapshot` is exactly the shape declared in `src/data.d.mts` and
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
They never echo the offending values, so sensitive bytes cannot leak through an
error.

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

No legacy digest object, score, history, token-usage rollup, chart layout or
rendered HTML. No producer internals are imported at runtime: the published
diagnostic schema is copied into `src/harness/report/diagnostic-schema.json` as an attributed
data artifact.

## Attribution

- The diagnostic schema copy in `src/harness/report/diagnostic-schema.json` is reproduced
  unchanged (apart from a `$comment` attribution) from the `@aihq/core` Harness
  package, schema `urn:aihq:harness:diagnostic:1.0.0`.
- Credential-shaped redaction patterns are ported from the legacy `ai-harness`
  redaction set (Apache-2.0), re-authored without host or environment access.
- This library is licensed Apache-2.0.
Producer revision is string | null: null means unavailable. Fresh installed-package reports never invent a Git revision. Original evidence SHA-256 may be null when raw evidence was not retained.
