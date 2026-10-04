# V9 reporting evidence

This candidate implements [Core issue 15](https://github.com/samartomar/aih-core/issues/15) within the Core distribution. The report and data contract are experimental.

The [JSON snapshot](../../examples/reporting/workflow/report.json), [offline HTML](../../examples/reporting/workflow/report.html) and [data-only result](../../examples/reporting/workflow/data-only-result.json) come from an actual installed `@aihq/core@1.0.0-dev.5` reporting command. Its public Harness diagnostic contract is `urn:aihq:harness:diagnostic:1.0.0`; bounded offline Node/Git version checks completed with two passed checks. No demo values substitute for these observations. The installed package exposes no source revision, and raw evidence was not retained, so those identities remain null. Authentication remains explicitly not authenticated.

The data-only consumer used structured counts/tool states with renderer imports forbidden. Packed public reporting declarations compiled; public data/render imports worked and private source subpaths were refused. Snapshot replay produced byte-identical JSON and HTML without acquisition. An isolated browser bundle also ran both public reporting modules without Node globals or the producer runtime.

The HTTP consumer bound to loopback and served those exact snapshot bytes. GET/HEAD returned 200; unknown/query-selected paths returned 404; POST returned 405. It exposed no filesystem or reacquisition request interface.

A bounded test run over reporting and affected CLI compatibility checks passed 73 tests, failed zero and skipped one existing Windows SIGINT case. Checks cover validation/version rejection, deterministic JSON/HTML, privacy/escaping, unavailable revision/zero semantics, command option rejection, output preservation, static/hydrated presentation and bounded consumer behavior. New data and CLI cases were observed failing before their fixes; renderer evidence includes characterization checks for already-correct escaping/determinism rather than claiming every check began red.

The authored template reproduces with SHA-256 `75a41764a53af97fd1547c4ed7660b5b7c49b2979525b199b47144ad5a829832`. [Visual check results](evidence/visual-check.json) establish all fourteen sections, exact normal-report static/hydrated markup and no browser errors. Separate [report](evidence/report-hydrated-hero.png) and [demo](evidence/demo-hydrated-hero.png) screenshots retain the V9 presentation; demo values are design-only. Browser evidence establishes presentation, independently of the producer integration.

The final review-correction run passed all 61 reporting data, rendering, command and consumer tests. Test-first cases cover colon-form, quoted and hyphenated credentials, complete credential punctuation/arguments, supplied home paths including spaced Windows usernames and adjacent paths, duplicate JSON keys, producer metadata masking, bounded projection expansion and saved-display wording. Round-trip regressions check stable projection across home and credential marker interactions. The portable browser check also exercises snapshot import and duplicate-key refusal. The package allowlist now includes only the reporting runtime, contract documents and consumer examples; the focused complete package test passed. Screenshots stay in source evidence and are excluded from the package.

Build and type checks passed. Full package-suite and independent committed-diff review results are recorded with the final artifact/PR evidence rather than inferred here. Core's multi-package public-consumer gate requires explicitly selected Catalog/Scan artifacts; reporting acceptance is separately reproducible with `npm run verify:report-consumer`.

Run the complete test list with bounded concurrency through npm's environment:
`npm exec --call "node --test --test-concurrency=2 --test-timeout=300000 test/*.test.mjs test/harness/*.test.mjs"`.
This preserves npm executable metadata used by package tests and changes no saved workflow/model settings. An earlier unbounded run was interrupted after contention; it is not counted as passing.

Remaining limitations are in [field mapping](FIELDS.md) and [rendering](RENDERING.md): configured/present is not verified, supplied structural assertions are unauthenticated, unsupported analytics are EMPTY, and offline version checks do not establish trust, policy delivery or native loading. Local checks establish no CI, published package or deployment.
