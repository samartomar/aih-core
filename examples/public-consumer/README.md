# AIH public consumer example

A small standalone consumer of the public package interfaces of
`@aihq/core`, `@aihq/catalog` and `@aihq/scan`. It is example content, not a
production application: no universal form engine, no version negotiation, no
service framework.

The example:

1. **Authors a policy portably.** It reads verified Catalog release bytes with
   `readRelease`, browses items with `listItems`/`getItem`, configures ordinary
   scalar inputs with `configureItem`, checks the explicit item set with
   `validateSelectionSet`, and assembles a Core execution policy. Supplied
   values are kept exactly; declared defaults are never inserted; required
   items are chosen explicitly and the returned dependency mapping is copied
   into the policy. Exported JSON reopens through Core's `parsePolicy`.
2. **Prepares and applies through a UI-owned Node host.** The host module keeps
   live prepared handles in the running process. The UI receives only a
   serializable review plus an opaque session id, and approval is an explicit
   decision naming the exact review digest. A lost or consumed session must be
   prepared and approved again. Review JSON is never deserialized back into
   executable work. Target and material roots are host-configured, never
   supplied by the browser.
3. **Presents complete Scan reports.** `readArtifact`/`readReport` readings are
   shown with every supported field: source/capture, intended selection and
   exclusions, all requested detectors and outcomes (succeeded, failed,
   refused, cancelled), every observation with its fresh/reused origin,
   coverage and uncovered paths, findings including unavailable-field reasons,
   gaps, annex descriptors and diagnostics. Unsupported report generations show
   encountered and supported contract ids; malformed bytes show invalid
   diagnostics. Report authenticity from reading (`unchecked`) is shown
   separately from Core's producer authentication, and authentic-but-partial or
   unverifiable evidence never appears as a clean result or a setup gate.
4. **Authors Enterprise administrator material portably.** `src/admin.js`
   reviews a report (`reviewReport`, authenticity always `unchecked`), authors an
   organization policy (`authorOrganizationPolicy`) and derives an Enterprise
   execution policy (`deriveExecutionPolicy`); see Enterprise administrator flow.

## Layout

- `src/authoring.js` — portable policy authoring (browser-safe imports only:
  `@aihq/core/contracts`, `@aihq/catalog/reader`).
- `src/report-view.js` — portable Scan reading and complete presentation model
  (`@aihq/scan/read`, `@aihq/scan/contracts`). Output is plain data; render
  with `textContent`, never `innerHTML`.
- `src/admin.js` — portable Enterprise administrator authoring (browser-safe
  imports only: `@aihq/core/contracts`, `@aihq/catalog/reader`,
  `@aihq/scan/read`; digests use WebCrypto).
- `src/host.js` — UI-owned Node host (`@aihq/core`, optional
  `@aihq/catalog/node` acquisition by the caller, optional host-configured
  `organizationSource`).
- `src/server.js` — bounded loopback demo server (static page, catalog bytes,
  prepare/apply endpoints).
- `browser/` — one-page UI (`page.html`, `app.js`).
- `test/` — focused `node:test` suites for the seams above.

## Prerequisites

- Node.js `>=24.15.0 <25`.
- The three packages installed in the consumer root, from explicitly reviewed
  artifacts (not a registry `latest`). The example adds no dependencies of its
  own and never imports source checkouts, private dist paths or sibling
  packages.

## Run the focused tests

The root repository's `npm run verify:public-consumer` command copies this
example into two isolated installations from explicitly supplied artifacts and
builds each browser bundle. See the root README for its artifact arguments.
From the generated `current` consumer directory:

```sh
node --test test/*.test.mjs
```

`test/report-view.test.mjs` and `test/evidence.test.mjs` additionally accept a
real retained signed Scan artifact for the authenticity and complete-reading
checks:

```sh
SCAN_ARTIFACT_FIXTURE=/absolute/path/to/current/production.scan.json node --test test/*.test.mjs
```

Without it, the fixture-dependent tests skip; the synthetic presentation and
unsupported/malformed cases still run. Tests use disposable temporary homes and
target directories only.

## Run the browser demo

Use the generated `current` consumer directory, which contains
`browser/app.bundle.js`. Set `AIH_CONSUMER_PROJECT` to an existing disposable
target directory, and both `HOME` and `USERPROFILE` to an existing disposable
home directory for Core's private custody/history. Keep both outside source
checkouts; on Windows prefer normal system temp directories with user-owned
permissions. Environment settings apply only to the demo process.

```sh
AIH_CONSUMER_PROJECT=/absolute/disposable/target HOME=/absolute/disposable/home USERPROFILE=/absolute/disposable/home node src/server.js
# AIH_CONSUMER_PORT selects the port (default 4817); loopback only.
```

Then open `http://127.0.0.1:4817/`. The server binds loopback, serves only the
explicit page/bundle and three endpoints, pins the actual loopback Host,
requires the exact same Origin on POST, and bounds request bodies. The page
loads the generated `browser/app.bundle.js`; the artifact gate uses Core's
existing development bundler to build it from `browser/app.js`. Runtime imports are
only the installed public packages; the bundler is build tooling only.

This is an unauthenticated, single-user demo for a trusted local machine. The
Host/Origin checks protect the browser boundary; they do not authenticate local
clients or other OS users, who can forge those headers. The host accepts inline
recipes, including permitted process operations, and Apply runs with the demo
process's privileges. Do not run it on a shared or untrusted machine, expose the
port beyond loopback, or use it as a service. An application built from this
example must supply its own transport authentication and authorization.

The installed portable validators compile their shipped JSON Schemas with Ajv
at runtime, so the demo CSP permits `unsafe-eval` for that compilation. It still
loads scripts only from this origin and renders supplied content as text. This
example does not demonstrate deployment under a CSP that forbids dynamic code
generation.

Browser flow: pick a catalog item and explicitly check its required items,
enter ordinary scalar inputs (empty fields stay omitted, so
declared defaults keep their `default` origin), author the policy, inspect or
download the JSON, reopen it, then prepare on the host, review the serializable
review, and explicitly approve with the returned digest. The Scan section reads
a local report/artifact file and renders the complete presentation. Policy edits
invalidate the previous review and approval, including edits while Prepare is
in flight. Tampered artifacts keep their invalid diagnostics instead of being
reinterpreted as another document kind.

The report view performs portable reading. It labels authenticity as unchecked;
the browser demo does not configure evidence authentication. The artifact gate
separately calls Core's public `authenticateEvidence` with the retained production
artifact and independently selected bundled trust. The example's evidence tests
exercise optional policy evidence through explicit host controls. Neither result
authenticates the deliberately unsigned display fixtures.

## Enterprise administrator flow

`src/admin.js` is portable example code, not a supported administrator UI.

1. `reviewReport(bytes)` presents a Scan artifact or report with its `scanId`.
   Authenticity stays `unchecked`: a readable unsigned report is not
   authenticated by being displayed. Core authenticates the producer at Prepare
   and Apply, only for evidence the derived policy associates.
2. `authorOrganizationPolicy({ release, id, permitted })` builds the organization
   document from permitted selections (`selectionId`, `itemId`, `scopes`, per-input
   `fixed`, `choices` or `allowDeclared`, optional `lifecycle`). It is async
   because each `recipeIdentity` is computed with WebCrypto by Core's documented
   rule: sha256 of the canonical JSON of `{ schema:
   'urn:aihq:core:recipe-identity:1.0.0', recipeSha256, materials: [{id, sha256,
   byteLength}] sorted by id }`, using the release's pinned recipe and material
   identities. The document is validated with `validateOrganizationPolicy` and has
   no evidence field.
3. `deriveExecutionPolicy({ release, organization, choices, evidence,
   materialSource })` builds the `mode: 'enterprise'` policy (each selection
   carrying `organizationSelectionId`) and copies the administrator-selected
   `{ schema, scanId, location }` associations into the policy's `evidence`. A
   local pre-check rejects choices outside the organization permissions before
   export; `parsePolicy` rejects unsupported association schemas or malformed scan
   IDs. Evidence is not permission and never a setup gate.
4. The administrator publishes the organization document to the GitHub source they
   select; this example does not publish it. The Node host is created with that
   `organizationSource` (host configuration, never browser input), and Core
   re-reads and re-admits it at Prepare and again at Apply. The local pre-check
   only mirrors Core for early feedback: a value forced past it is still
   `AUTHORITY_DENIED`. A lost prepared handle needs a fresh Prepare and approval.

The artifact gate runs this end to end against an acceptance-only organization
source stub (`acceptance/org-source.mjs`, not part of the example), including the
rejected out-of-policy and unsupported-evidence examples.

## Boundaries

- No silent coercion, automatic default insertion, or dependency solving
  beyond the public readers' explicit validation.
- Unsupported required contracts surface encountered/supported ids and
  diagnostics; nothing falls back silently.
- Core evidence authentication is optional and separate: skipped or
  unverifiable evidence is reported honestly and does not gate setup.
- Sensitive inputs and credentials stay out of the browser and exported
  policies. The browser demo supplies none; a caller of `createHost` can supply
  them through Core host controls in its own trusted Node process.
