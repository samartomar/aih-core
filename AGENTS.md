# AIH-Core

Source repository: `samartomar/aih-core`. Package: `@aihq/core`.
Generic engine source lives in `src/core/`; bundled repair/support definitions
and helpers live in `src/harness/`. Portable Harness metadata is exposed through
`@aihq/core/harness`; Node helpers use `@aihq/core/harness/runtime`. Both modules
share this repository's single package version. Resolve the Git root, branch and push URL before
committing. Keep shared/private engineering plans outside this repository.

Read the [README](README.md) for implemented contracts, development setup and
checks. Preserve the generic engine boundary: vendor/tool-specific definitions
and helpers belong in Harness or supplied content. Portable contracts must work
without Node host effects. Treat schemas and public API behavior as contracts.

Published Harness changes require a new Core distribution version. Identify
unpublished local builds by source commit and artifact digest. Preserve the actual
installed package identity and selected helper/input byte binding.
Build only the root package; no nested package or sibling checkout is required.

Run focused checks for the change and the applicable package checks before
handoff. Use `npm test` so package tests receive npm's executable path. Exercise
product operations only against temporary homes and target directories; never
use this source checkout as the product's repair or policy target.

Start code discovery at this Git root. Pass its absolute path to
code-review-graph, refresh after source/ref changes, and verify findings in source
and tests. For codebase-memory-mcp, select the project returned for this root by
`list_projects`; for Serena, read its initial instructions and activate this root.
Generated indexes stay ignored. A parent graph does not establish this repo's
coverage or freshness.

## Issue and delivery routing

Use the fully qualified delivery issue supplied with the task. Verify the current
repository visibility and intake route before use. Existing pre-release work
retains its supplied delivery issue. After public intake activation, accepted Core
and Harness bugs/enhancements use the Core tracker, including internally
discovered work. Reuse existing reports.

At pickup identify the owning issue, actual source/worktree, affected module and
release unit. Link the PR and actual package/version evidence to the owning issue
under existing authorization. A merged change is not a published package; keep
required publication pending or name its follow-up owner. Confidential details and
private coordination links stay outside public text. Private maintainer handoffs
carry any additional internal instructions explicitly.
