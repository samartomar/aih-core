# Report data fields

`createReport` projects one schema-valid `@aihq/core` Harness diagnostic result
(schema `urn:aihq:harness:diagnostic:1.0.0`) into an experimental
`ReportSnapshot`. This page names every supported field's producer, meaning,
units, provenance, availability and privacy treatment. It describes the data
interface only; HTML presentation belongs to `@aihq/core/report/render`.

"Producer" means the field originates in the Harness diagnostic result, unless
the row says the caller supplies it.

## Envelope

| Field | Producer | Meaning / units | Provenance | Availability | Privacy treatment |
|---|---|---|---|---|---|
| `schema` | this reporting module | Version identity of the snapshot shape. No unit. | Constant `urn:aihq:report:snapshot:1.0.0`. | Always present. | Non-sensitive constant. |
| `compatibility` | this reporting module | `experimental`: shape may change without a stable-format promise. | Constant. | Always present. | Non-sensitive constant. |
| `producer.name` | caller | Package that produced `diagnostic`. | Supplied provenance, not attestation. | Always present; must be `@aihq/core`. | Non-sensitive constant. |
| `producer.version` | caller | Producer package version string. No unit. | Supplied provenance. | Always present. | Redacted as free text. |
| `producer.revision` | caller | Producer source revision string or null. No unit. | Supplied provenance. | Null when unavailable. | Strings redacted as free text. |
| `producer.contract` | this reporting module | Diagnostic schema identity the snapshot was built against. | Constant `urn:aihq:harness:diagnostic:1.0.0`. | Always present. | Non-sensitive constant. |
| `capture.observedAt` | caller | Instant the diagnostic observation is attributed to. ISO 8601 UTC. | Supplied; not proof of acquisition. | Always present. | Not free text. |
| `capture.acquisition` | caller | `supplied` (already-obtained bytes) or `newly-acquired`. | Supplied. | Always present. | Enum copied verbatim. |
| `evidence.originalSha256` | caller | SHA-256 of the **raw** evidence bytes, 64 lowercase hex, or `null`. Never the hash of this snapshot. | Supplied. | `null` when not supplied. | Identity of raw bytes; the bytes themselves are never embedded, copied or overwritten. |
| `evidence.authentication` | this reporting module | Always `not-authenticated`. No signature, key or trust check is performed. | Constant. | Always present. | Non-sensitive constant. |
| `evidence.structuralValidation` | this reporting module | Always `passed`; the input matched the shape and bounds below. It says nothing about whether the assertions are true. | Derived. | Always present. | Non-sensitive constant. |
| `evidence.projection` | this reporting module | Always `redacted`; the privacy projection was applied. | Derived. | Always present. | Non-sensitive constant. |

## Diagnostic projection

| Field | Producer | Meaning / units | Provenance | Availability | Privacy treatment |
|---|---|---|---|---|---|
| `status` | `diagnostic.status` | `completed` \| `cancelled` \| `invalid` \| `unavailable`. | Observed result state. | Always present. | Enum copied verbatim. |
| `tools[].id` | `diagnostic.tools[].id` | Stable tool target id. No unit. | Declared target. | One entry per produced tool. | Redacted as free text, so cross-references stay consistent. |
| `tools[].label` | `diagnostic.tools[].label` | Human label for the tool. | Declared target. | Always present per tool. | Redacted as free text. |
| `tools[].state` | `diagnostic.tools[].state` | `binary` \| `runnable` \| `broken` \| `config-only` \| `absent`. Existence/run state, not a health score. | Probe observation. | Always present per tool. | Enum copied verbatim. |
| `tools[].selection` | `diagnostic.tools[].selection` | `requested` \| `detected` \| `unselected`. | Diagnostic request. | Always present per tool. | Enum copied verbatim. |
| `tools[].config` | `diagnostic.tools[].config` | Config-path trace when a config file was seen. Not proof of a runnable tool. | Probe observation. | Optional; omitted when absent. | Redacted as free text; home paths scrubbed. |
| `observations[].id` | `diagnostic.observations[].id` | Observation id. No unit. | Observed. | One entry per produced observation. | Redacted as free text. |
| `observations[].target` | `diagnostic.observations[].target` | Target the observation belongs to. | Observed. | Always present. | Redacted as free text. |
| `observations[].detail` | `diagnostic.observations[].detail` | Bounded human description of what was observed. No unit. | Observed. | Always present; may be empty. | Redacted as free text. |
| `checks[].id` | `diagnostic.checks[].id` | Check id. No unit. | Performed check. | One entry per produced check. | Redacted as free text. |
| `checks[].target` | `diagnostic.checks[].target` | Target the check ran against. | Performed check. | Always present. | Redacted as free text. |
| `checks[].outcome` | `diagnostic.checks[].outcome` | `passed` \| `failed` \| `unavailable` \| `skipped`. | Performed check. | Always present. | Enum copied verbatim. |
| `checks[].reason` | `diagnostic.checks[].reason` | Machine reason (for example `version-ok`, `deadline`, `network-off`). No unit. | Performed check. | Always present; may be empty. | Redacted as free text. |
| `checks[].detail` | `diagnostic.checks[].detail` | Bounded supporting detail. No unit. | Performed check. | Always present; may be empty. | Redacted as free text. |
| `diagnostics[].code` | `diagnostic.diagnostics[].code` | Diagnostic code (for example `VERIFICATION_FAILED`). | Producer diagnostic. | One entry per produced diagnostic. | Redacted as free text. |
| `diagnostics[].reason` | `diagnostic.diagnostics[].reason` | Machine reason for the diagnostic. | Producer diagnostic. | Always present. | Redacted as free text. |
| `diagnostics[].message` | `diagnostic.diagnostics[].message` | Bounded human message. | Producer diagnostic. | Always present. | Redacted as free text. |
| `metrics.budgetMs` | `diagnostic.limits.budgetMs` | Diagnostic time budget, integer milliseconds, 1–180000. | Producer limit. | Always present. | Non-text numeric. |
| `metrics.elapsedMs` | `diagnostic.limits.elapsedMs` | Observed elapsed time, integer milliseconds, ≥ 0. | Producer measurement. | Always present. | Non-text numeric. |
| `metrics.maxActiveProbes` | `diagnostic.limits.maxActiveProbes` | Maximum concurrent probes, integer 1–2. | Producer limit. | Always present. | Non-text numeric. |
| `metrics.counts` | derived from `diagnostic.checks` | Number of checks per outcome: `passed`, `failed`, `unavailable`, `skipped`. Unit: checks. | Derived by this reporting module. | Always present; `0` is a measured zero. | Non-text numeric. |

### Producer fields intentionally not exposed

| Dropped producer field | Reason |
|---|---|
| `requestId` | Caller-supplied correlation id that can embed hostnames, account names or ticket text. The report carries no correlation id. |
| `helper` | Producer bookkeeping already covered by `producer.name`/`version`. |
| `repairChoices` | Free-text manual-guidance prose that can carry operator paths and secrets. The underlying check `outcome` and `reason` are preserved, so the report keeps the meaningful state without the unsafe prose. |

No legacy digest object, score, history, token-usage rollup, chart layout or
rendered HTML enters the data interface.

## Availability semantics

- **Measured zero** is a real number: `metrics.counts.* = 0` and
  `metrics.elapsedMs = 0` mean the producer measured nothing, not that the
  value is unknown.
- **Missing / unavailable** is represented by the producer's own vocabulary:
  `status`, `checks[].outcome = "unavailable"`, `tools[].state = "config-only" |
  "absent"`, or the absence of the optional `tools[].config`. Fields are never
  invented to fill a gap.
- **Supply vs acquisition**: `capture.acquisition` records how the caller
  obtained the diagnostic. Importing or rendering a saved snapshot never
  acquires new observations.
- **Structural validation vs authentication**: `evidence.structuralValidation`
  records only that the input matched the schema and bounds.
  `evidence.authentication` is always `not-authenticated`; the supplied
  observations and provenance are assertions, not verified facts.
- **Raw evidence identity vs projection**: `evidence.originalSha256` names the
  caller's raw bytes. It is not the hash of the exported snapshot, and the raw
  bytes are never embedded, copied or overwritten.

## Privacy treatments

Applied to every projected string, on `createReport`, `importSnapshot` and
`exportSnapshot`:

1. **Explicit home paths** (`redaction.homePaths`) → `<homePath>`, matched
   case-insensitively in both `/` and `\` separator styles.
2. **Explicit secret values** (`redaction.secretValues`) → `[REDACTED]`.
3. **Provider credential shapes** always masked: AWS access-key ids, private-key
   headers, GitHub/npm/Slack/Google/OpenAI-style tokens, Azure `AccountKey=`,
   and `Bearer <token>`.
4. **Secret-ish assignments** (`TOKEN=…`, `API_KEY: …`, and similar) and
   **sensitive flags** (`--token value`, `--password=value`) masked with
   `[REDACTED]`.
5. **Dropped unsafe prose** (`requestId`, `helper`, `repairChoices`) as above.
6. **No raw evidence embedding**: only the caller-supplied SHA string, never the
   bytes.
7. **JSON stays valid**: redaction runs on parsed string values, so a secret
   containing quotes, backslashes or newlines cannot corrupt export syntax.

Enum-typed fields (`status`, `tools[].state`, `tools[].selection`,
`checks[].outcome`, `capture.acquisition`) are copied verbatim, so redaction can
never turn a meaningful state into a secret-like token or the reverse.

Producer revision may be null when the installed package does not expose its source commit. The fresh command uses null for revision and original evidence identity; externally supplied snapshots may retain a caller-provided original-byte digest without authentication.

Import and export always mask conventional home prefixes (`/home/<user>`,
`/Users/<user>` and Windows user directories, including case variations and
spaces in Windows usernames) and credential assignments using either `=` or
`:` with plain or quoted keys. Imports also accept explicit privacy context for nonstandard
home paths or arbitrary secrets. Applied projection is not a completeness or
authentication claim; inspect the redacted report before sharing.

Assignment scanning recognizes credential keys without consuming ordinary
values first, so nested quoted credentials are still found. Unquoted credential
punctuation stays part of the masked value. Ambiguous container values and
unterminated quotes mask the remaining prose conservatively; enum states and
measured counts stay unchanged.
