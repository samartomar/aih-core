# Rendering

`@aihq/core/report/render` turns a validated report snapshot into one self-contained,
offline HTML page that keeps the V9 developer-console design. It is experimental, like the
data interface it reads (see [CONTRACT.md](CONTRACT.md) and [FIELDS.md](FIELDS.md)).

```js
import { createReport } from '@aihq/core/report';
import { renderReport } from '@aihq/core/report/render';

const snapshot = createReport({ /* see CONTRACT.md */ });
const html = renderReport(snapshot, { title: 'Workstation check' });
```

`renderReport(snapshot, options?) → string`

| Option | Meaning |
| --- | --- |
| `title` | Page and heading title, 1–200 characters. Default `AIH report`. |
| `mode` | `'report'` (default) or `'demo'`. Anything else throws `TypeError`. |

The snapshot is validated and re-projected through the public data interface before it is
drawn, so invalid input throws the data module's `ReportInputError` (`INPUT_INVALID` or
`SCHEMA_UNSUPPORTED`), in demo mode too. The renderer never reads the filesystem or
network, never collects observations, and never modifies its input.

## Properties

- **Offline.** One document with inline CSS and script. No external requests, fonts or
  images (system font stacks only).
- **Deterministic.** Identical snapshot and options give identical bytes. The only clock is
  the topbar UTC/local display, which the page script fills in at view time.
- **Escaped.** Every supplied string is HTML-escaped. The embedded `window.AIH_DATA` literal
  escapes `<`, `>`, `&`, U+2028 and U+2029, so supplied text cannot end the script or add markup.
- **Not a score.** The renderer computes no wiring or readiness score. Counts shown are the
  snapshot's own `metrics.counts`.

## States: LIVE, EMPTY, PREVIEW, DEMO

Each of the 14 sections carries `data-state` and a visible label.

| State | Where | Meaning |
| --- | --- | --- |
| `live` — "LIVE · supplied snapshot" or "LIVE · caller-labelled newly acquired" | report mode | Drawn from values present in the snapshot. `LIVE` means *supplied*; it never implies fresh. The label repeats `capture.acquisition`, which is the caller's provenance, not an attestation. |
| `empty` — "EMPTY" | report mode | The current producer supplies nothing for this panel. A short reason is shown and no number, bar or placeholder appears. A missing measurement is never drawn as zero. |
| PREVIEW ribbon | demo mode | A design-intent panel for a capability that is not wired. |
| DEMO chip + banner | demo mode | Every number, name and command is invented for illustration. Commands in the sample are old text, not supported Core commands. |

Demo mode renders the authored V9 sample as-is and **never** renders the snapshot's values
(the snapshot is still validated). Report mode contains none of the sample content.

## Section bindings (report mode)

| Section id | State | Bound from |
| --- | --- | --- |
| `sec-hero` | live | `status`, `metrics.counts` (`n/a` unless `status` is `completed`), tool/check/observation totals. |
| `sec-ready` | live | `checks` (failed and not-evaluated rows), `status`, `diagnostics`; plus the evidence and provenance card (`producer`, `capture`, `evidence`, `metrics`). |
| `sec-actions` | live | Mechanically ranked from failed checks and broken selected tools (high), diagnostics, unavailable checks and requested-but-absent tools (med), skipped checks and config-only tools (low). Each item shows its check/tool id and "no command supplied". |
| `sec-adoption` | live | `checks` as chips, `tools` grouped by state, `observations` listed as observed. |
| `sec-support` | live | A copy-ready plain-text draft built only from the findings above, with producer and capture identity. |
| `sec-wins`, `sec-context`, `sec-activity`, `sec-quality`, `sec-drift`, `sec-mcp`, `sec-period`, `sec-skills`, `sec-skillgov` | empty | Not supplied by the current diagnostic contract. |

Readiness wording is factual: `FAILED CHECKS`, `UNVERIFIED GAPS`, `NO FAILED CHECKS`,
`NO CHECKS REPORTED`, or `NOT EVALUATED` when `status` is not `completed`. It never says
"ready".

### Evidence limits preserved

- A tool in state `binary` is "found — not run"; `config-only` is "not verified"; only
  `runnable` is shown as runnable. Observations are labelled "observed, not verified".
- Structural validation, the original-evidence SHA-256 and authentication are three separate
  rows. The digest identifies the raw bytes given to the data module and is not recomputed;
  authentication is shown as the snapshot states it (`not authenticated`).
- A signature file or configuration being present is not authentication or verification.

## Static and hydrated rendering

The server-side output already contains every section's final markup, so the page is
complete with scripts disabled. The same section HTML and state are also embedded in
`window.AIH_DATA`; on load the page script writes them into the matching `<section id>`.
Hydration is therefore an idempotent re-apply: static and hydrated sections are identical,
and stale static markup is repaired from the embedded data. In demo mode there is nothing to
hydrate because the authored sample is the document.

Every normal offline document explicitly says **Saved snapshot display**. Its
acquisition label describes the original capture supplied by the caller; replay
does not relabel it as a new acquisition. The command separately reports whether
it acquired diagnostics or imported a snapshot. Rendering never acquires data.

Navigation keeps the V9 section ids (`sec-hero`, `sec-ready`, `sec-actions`, `sec-wins`,
`sec-context`, `sec-activity`, `sec-quality`, `sec-drift`, `sec-mcp`, `sec-adoption`,
`sec-support`, `sec-period`, `sec-skills`, `sec-skillgov`). The ⌘K / Ctrl+K command palette
that jumps between them needs JavaScript, as in V9; without it, every section is still
reachable through its `#sec-…` anchor.

## Template provenance and reproduction

`src/harness/report/templates/report.html` is the authored shell. `src/harness/report/template.mjs` is generated from it:

```
node scripts/generate-report-template.mjs          # write src/harness/report/template.mjs
node scripts/generate-report-template.mjs --check  # fail unless it reproduces byte-for-byte
```

Line endings are normalized, and the module records the SHA-256 of the authored source.
Origin and licence of the design are in `NOTICE` and `LICENSE`.

## Limits

- The renderer reads the snapshot shape in [CONTRACT.md](CONTRACT.md); only the single
  supported diagnostic contract is bound. Other panels stay EMPTY until a producer supplies them.
- Behavior is tested with a DOM implementation (static and script-executed documents) and
  checked visually in a Chromium-based browser; other browsers are not part of the checks.
- The interface is experimental: no stable ecosystem format or publication identity is promised.
